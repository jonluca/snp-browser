import type { DNAParser, ValidationResult, ProgressCallback, ParserMetadata } from "../types";
import type { ParseResult, UserGenotype } from "../../types/snp";

const METADATA: ParserMetadata = {
  id: "vcf",
  name: "VCF",
  description: "Variant Call Format (VCF) files with genotype sample columns",
  version: "1.0.0",
  fileExtensions: [".vcf"],
  providerUrl: "https://samtools.github.io/hts-specs/VCFv4.5.pdf",
};

const BASE_ORDER: Record<string, number> = {
  a: 0,
  c: 1,
  g: 2,
  t: 3,
};

/**
 * Parser for VCF genotype files.
 *
 * VCF records contain allele indexes in the sample GT field. This parser maps
 * those indexes back to REF/ALT bases and emits rsid-based genotypes that match
 * the normalized shape used by the other raw DNA parsers.
 */
export class ParserVCF implements DNAParser {
  readonly metadata = METADATA;

  validate(content: string): ValidationResult {
    const lines = content.split("\n").slice(0, 500);

    let hasFileFormat = false;
    let hasColumnHeader = false;
    let hasSampleColumns = false;
    let hasRsidData = false;
    let validDataLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.toLowerCase().startsWith("##fileformat=vcf")) {
        hasFileFormat = true;
        continue;
      }

      if (trimmed.startsWith("#CHROM")) {
        const parts = this.splitColumns(trimmed);
        hasColumnHeader =
          parts.length >= 8 &&
          parts[0] === "#CHROM" &&
          parts[1] === "POS" &&
          parts[2] === "ID" &&
          parts[3] === "REF" &&
          parts[4] === "ALT";
        hasSampleColumns = parts.length >= 10 && parts[8] === "FORMAT";
        continue;
      }

      if (trimmed.startsWith("#")) continue;

      const parts = this.splitColumns(trimmed);
      if (parts.length >= 10 && this.extractRsid(parts[2])) {
        hasRsidData = true;

        const genotype = this.parseSampleGenotype(parts[3], parts[4], parts[8], parts[9]);
        if (genotype !== null) {
          validDataLines++;
        }
      }
    }

    let confidence = 0;
    if (hasFileFormat) confidence += 0.4;
    if (hasColumnHeader) confidence += 0.3;
    if (hasSampleColumns) confidence += 0.2;
    if (hasRsidData && validDataLines > 0) confidence += 0.1;

    const valid = (hasFileFormat && hasColumnHeader) || (hasColumnHeader && validDataLines > 0);

    return {
      valid,
      confidence: valid ? confidence : 0,
      reason: valid
        ? `Detected VCF format with ${validDataLines} genotype records in the sampled lines`
        : "File doesn't appear to be VCF format",
      detectedFormat: valid ? METADATA.id : undefined,
    };
  }

  async parse(content: string, onProgress: ProgressCallback): Promise<ParseResult> {
    const lines = content.split("\n");
    const genotypes: UserGenotype[] = [];
    const errors: string[] = [];
    let skippedLines = 0;
    const totalLines = lines.length;

    onProgress(0, totalLines);

    const batchSize = 1000;
    let headerFound = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (!line) {
        skippedLines++;
        continue;
      }

      if (line.startsWith("##")) {
        skippedLines++;
        continue;
      }

      if (line.startsWith("#CHROM")) {
        const parts = this.splitColumns(line);
        headerFound = true;
        skippedLines++;

        if (parts.length < 10) {
          errors.push(`Line ${i + 1}: VCF header does not include FORMAT and sample columns`);
        }
        continue;
      }

      if (line.startsWith("#")) {
        skippedLines++;
        continue;
      }

      const parts = this.splitColumns(line);
      if (parts.length < 8) {
        errors.push(`Line ${i + 1}: Invalid VCF record - expected at least 8 columns, got ${parts.length}`);
        skippedLines++;
        continue;
      }

      if (!headerFound) {
        errors.push(`Line ${i + 1}: VCF data record appeared before #CHROM header`);
        skippedLines++;
        continue;
      }

      const [chromosome, position, id, ref, alt] = parts;
      const rsid = this.extractRsid(id);

      if (!rsid) {
        skippedLines++;
        continue;
      }

      if (parts.length < 10) {
        errors.push(`Line ${i + 1}: VCF record for ${rsid} does not include FORMAT and sample columns`);
        skippedLines++;
        continue;
      }

      const genotype = this.parseSampleGenotype(ref, alt, parts[8], parts[9]);
      if (genotype === null) {
        errors.push(`Line ${i + 1}: Could not convert GT field to SNP bases for ${rsid}`);
        skippedLines++;
        continue;
      }

      genotypes.push({
        rsid,
        chromosome: this.normalizeChromosome(chromosome),
        position,
        genotype,
      });

      if (i % batchSize === 0 || i === lines.length - 1) {
        onProgress(i + 1, totalLines);
      }
    }

    return {
      genotypes,
      totalLines,
      skippedLines,
      errors,
    };
  }

  private splitColumns(line: string): string[] {
    const tabParts = line.split("\t");
    return tabParts.length > 1 ? tabParts : line.split(/\s+/);
  }

  private extractRsid(id: string): string | null {
    const match = id.match(/\b(?:rs|i)\d+\b/i);
    return match ? match[0].toLowerCase() : null;
  }

  private normalizeChromosome(chromosome: string): string {
    const normalized = chromosome.replace(/^chr/i, "");
    return normalized.toUpperCase() === "M" ? "MT" : normalized;
  }

  private parseSampleGenotype(ref: string, alt: string, format: string, sample: string): string | null {
    const formatFields = format.split(":");
    const sampleFields = sample.split(":");
    const genotypeIndex = formatFields.indexOf("GT");
    const genotypeField = genotypeIndex >= 0 ? sampleFields[genotypeIndex] : sampleFields[0];

    if (!genotypeField) return null;

    const alleleIndexes = genotypeField.split(/[/|]/);
    if (alleleIndexes.length === 0) return null;

    if (alleleIndexes.some((alleleIndex) => alleleIndex === ".")) {
      return "--";
    }

    const alleles = [ref, ...alt.split(",")];
    const genotypeBases: string[] = [];

    for (const alleleIndex of alleleIndexes) {
      if (!/^\d+$/.test(alleleIndex)) return null;

      const allele = alleles[Number(alleleIndex)]?.toLowerCase();
      if (!allele || !/^[acgt]$/.test(allele)) {
        return null;
      }

      genotypeBases.push(allele);
    }

    return this.normalizeGenotypeOrder(genotypeBases);
  }

  private normalizeGenotypeOrder(alleles: string[]): string {
    return alleles.sort((a, b) => BASE_ORDER[a] - BASE_ORDER[b]).join("");
  }
}

/**
 * Default export for convenience
 */
export default new ParserVCF();
