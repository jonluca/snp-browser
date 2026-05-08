import type { DNAParser, ValidationResult, ProgressCallback, ParserMetadata } from "../types";
import type { ParseResult, UserGenotype } from "../../types/snp";

const METADATA: ParserMetadata = {
  id: "vcf",
  name: "VCF / gVCF",
  description: "Variant Call Format (VCF/gVCF) files with genotype sample columns",
  version: "1.0.0",
  fileExtensions: [".vcf", ".gvcf", ".g.vcf", ".vcf.gz", ".g.vcf.gz", ".gz"],
  providerUrl: "https://samtools.github.io/hts-specs/VCFv4.5.pdf",
};

const BASE_ORDER: Record<string, number> = {
  a: 0,
  c: 1,
  g: 2,
  t: 3,
};

type VcfGenotypeParseResult =
  | { status: "called"; genotype: string }
  | { status: "invalid" }
  | { status: "unsupported" };

interface VcfParseState {
  genotypes: UserGenotype[];
  errors: string[];
  skippedLines: number;
  totalLines: number;
  headerFound: boolean;
}

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
        if (genotype.status === "called") {
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
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    const state = this.createParseState(totalLines);

    onProgress(0, totalLines);

    const batchSize = 1000;

    for (let i = 0; i < lines.length; i++) {
      this.processLine(lines[i], i + 1, state);

      if (i % batchSize === 0 || i === lines.length - 1) {
        onProgress(i + 1, totalLines);
      }
    }

    return {
      genotypes: state.genotypes,
      totalLines,
      skippedLines: state.skippedLines,
      errors: state.errors,
    };
  }

  async parseBlob(file: Blob & { name?: string }, onProgress: ProgressCallback): Promise<ParseResult> {
    const state = this.createParseState(0);
    const totalBytes = file.size;
    const stream = this.openTextStream(file);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let bufferedText = "";
    let bytesRead = 0;

    onProgress(0, totalBytes);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      const text = decoder.decode(value, { stream: true });
      const lines = (bufferedText + text).split(/\r?\n/);
      bufferedText = lines.pop() ?? "";

      for (const line of lines) {
        state.totalLines++;
        this.processLine(line, state.totalLines, state);
      }

      onProgress(Math.min(bytesRead, totalBytes), totalBytes);
    }

    const finalText = bufferedText + decoder.decode();
    if (finalText) {
      state.totalLines++;
      this.processLine(finalText, state.totalLines, state);
    }

    onProgress(totalBytes, totalBytes);

    return {
      genotypes: state.genotypes,
      totalLines: state.totalLines,
      skippedLines: state.skippedLines,
      errors: state.errors,
    };
  }

  private createParseState(totalLines: number): VcfParseState {
    return {
      genotypes: [],
      errors: [],
      skippedLines: 0,
      totalLines,
      headerFound: false,
    };
  }

  private openTextStream(file: Blob & { name?: string }): ReadableStream<Uint8Array> {
    const stream = file.stream();
    if (!file.name?.toLowerCase().endsWith(".gz")) {
      return stream;
    }

    if (!("DecompressionStream" in globalThis)) {
      throw new Error(
        "Compressed VCF files are not supported in this browser. Please upload an uncompressed VCF/gVCF.",
      );
    }

    return stream.pipeThrough(new DecompressionStream("gzip"));
  }

  private processLine(rawLine: string, lineNumber: number, state: VcfParseState): void {
    const line = rawLine.trim();

    if (!line) {
      state.skippedLines++;
      return;
    }

    if (line.startsWith("##")) {
      state.skippedLines++;
      return;
    }

    if (line.startsWith("#CHROM")) {
      const parts = this.splitColumns(line);
      state.headerFound = true;
      state.skippedLines++;

      if (parts.length < 10) {
        state.errors.push(`Line ${lineNumber}: VCF header does not include FORMAT and sample columns`);
      }
      return;
    }

    if (line.startsWith("#")) {
      state.skippedLines++;
      return;
    }

    const parts = this.splitColumns(line);
    if (parts.length < 8) {
      state.errors.push(`Line ${lineNumber}: Invalid VCF record - expected at least 8 columns, got ${parts.length}`);
      state.skippedLines++;
      return;
    }

    if (!state.headerFound) {
      state.errors.push(`Line ${lineNumber}: VCF data record appeared before #CHROM header`);
      state.skippedLines++;
      return;
    }

    const [chromosome, position, id, ref, alt] = parts;
    const rsid = this.extractRsid(id);

    if (!rsid) {
      state.skippedLines++;
      return;
    }

    if (parts.length < 10 || parts[8] === undefined || parts[9] === undefined) {
      state.errors.push(`Line ${lineNumber}: VCF record for ${rsid} does not include FORMAT and sample columns`);
      state.skippedLines++;
      return;
    }

    const genotype = this.parseSampleGenotype(ref ?? "", alt ?? "", parts[8], parts[9]);
    if (genotype.status === "unsupported") {
      state.skippedLines++;
      return;
    }

    if (genotype.status === "invalid") {
      state.errors.push(`Line ${lineNumber}: Could not convert GT field to SNP bases for ${rsid}`);
      state.skippedLines++;
      return;
    }

    state.genotypes.push({
      rsid,
      chromosome: this.normalizeChromosome(chromosome ?? ""),
      position: position ?? "",
      genotype: genotype.genotype,
    });
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

  private parseSampleGenotype(ref: string, alt: string, format: string, sample: string): VcfGenotypeParseResult {
    const formatFields = format.split(":");
    const sampleFields = sample.split(":");
    const genotypeIndex = formatFields.indexOf("GT");
    const genotypeField = genotypeIndex >= 0 ? sampleFields[genotypeIndex] : sampleFields[0];

    if (!genotypeField) return { status: "invalid" };

    const alleleIndexes = genotypeField.split(/[/|]/);
    if (alleleIndexes.length === 0) return { status: "invalid" };

    if (alleleIndexes.some((alleleIndex) => alleleIndex === ".")) {
      return { status: "called", genotype: "--" };
    }

    const alleles = [ref, ...alt.split(",")];
    const genotypeBases: string[] = [];

    for (const alleleIndex of alleleIndexes) {
      if (!/^\d+$/.test(alleleIndex)) return { status: "invalid" };

      const allele = alleles[Number(alleleIndex)]?.toLowerCase();
      if (!allele || !/^[acgt]$/.test(allele)) {
        return { status: "unsupported" };
      }

      genotypeBases.push(allele);
    }

    return { status: "called", genotype: this.normalizeGenotypeOrder(genotypeBases) };
  }

  private normalizeGenotypeOrder(alleles: string[]): string {
    return alleles.sort((a, b) => BASE_ORDER[a] - BASE_ORDER[b]).join("");
  }
}

/**
 * Default export for convenience
 */
export default new ParserVCF();
