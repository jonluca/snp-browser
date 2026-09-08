import { applyFileMetadata, detectFileMetadata } from "../metadata";
import type { DNAParser, ParserMetadata, ProgressCallback, ValidationResult } from "../types";
import type { ParseResult, UserGenotype } from "../../types/snp";
import { normalizeAssembly } from "../../utils/variantIdentity";

const METADATA: ParserMetadata = {
  id: "color",
  name: "Color",
  description: "Color discovery genotype CSV export",
  version: "1.0.0",
  fileExtensions: [".csv"],
  providerUrl: "https://www.color.com",
};

export class ParserColor implements DNAParser {
  readonly metadata = METADATA;

  validate(content: string): ValidationResult {
    const lines = content.split("\n").slice(0, 500);
    let hasHeader = false;
    let validDataLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = this.parseCSVLine(trimmed);
      if (this.isHeader(parts)) {
        hasHeader = true;
        continue;
      }

      if (parts.length >= 5 && this.isSupportedRsid(parts[3]) && this.isSupportedGenotype(parts[4])) {
        validDataLines++;
      }
    }

    const valid = hasHeader && validDataLines >= 1;
    const confidence = valid ? 0.9 : 0;

    return {
      valid,
      confidence,
      reason: valid
        ? `Detected Color discovery genotype CSV format with ${validDataLines} valid data lines`
        : "File doesn't appear to be Color discovery genotype CSV format",
      detectedFormat: valid ? METADATA.id : undefined,
    };
  }

  async parse(content: string, onProgress: ProgressCallback): Promise<ParseResult> {
    const fileMetadata = detectFileMetadata(content);
    const lines = content.split("\n");
    const genotypes: UserGenotype[] = [];
    const errors: string[] = [];
    let skippedLines = 0;
    const totalLines = lines.length;
    const batchSize = 1000;
    let referenceVersionColumn = -1;

    onProgress(0, totalLines);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) {
        skippedLines++;
        continue;
      }

      const parts = this.parseCSVLine(line).map((part) => part.trim());
      if (this.isHeader(parts)) {
        referenceVersionColumn = parts.findIndex((part) => part.toUpperCase() === "REFERENCEVERSION");
        skippedLines++;
        continue;
      }

      if (parts.length < 5) {
        errors.push(`Line ${i + 1}: Invalid format - expected at least 5 columns, got ${parts.length}`);
        skippedLines++;
        continue;
      }

      const [, chromosome, position, rsid, genotype] = parts;
      if (!this.isSupportedRsid(rsid) || !this.isSupportedGenotype(genotype)) {
        skippedLines++;
        continue;
      }

      const declaredVersion = referenceVersionColumn >= 0 ? parts[referenceVersionColumn]?.trim() : undefined;
      const rowAssembly = declaredVersion ? normalizeAssembly(declaredVersion) : fileMetadata.assembly;
      // An explicit row value is not replaced with an incompatible header
      // default, including when the row names an unsupported reference build.
      const assembly = fileMetadata.assembly && rowAssembly !== fileMetadata.assembly ? undefined : rowAssembly;

      genotypes.push({
        rsid: rsid.toLowerCase(),
        chromosome,
        position,
        genotype: genotype.toLowerCase(),
        ...(assembly ? { assembly } : {}),
      });

      if (i % batchSize === 0 || i === lines.length - 1) {
        onProgress(i + 1, totalLines);
      }
    }

    const result = applyFileMetadata(
      {
        genotypes,
        totalLines,
        skippedLines,
        errors,
      },
      { strand: fileMetadata.strand },
    );
    const assemblies = new Set<UserGenotype["assembly"]>();
    for (const genotype of genotypes) assemblies.add(genotype.assembly);
    if (assemblies.size === 1) {
      const [assembly] = assemblies;
      if (assembly) result.assembly = assembly;
    }
    return result;
  }

  private isHeader(parts: string[]): boolean {
    const normalized = parts.map((part) => part.trim().toUpperCase());
    return (
      normalized[0] === "SAMPLEID" &&
      normalized[1] === "CHROMOSOME" &&
      normalized[2] === "POSITION" &&
      normalized[3] === "RSID" &&
      normalized[4] === "GENOTYPE"
    );
  }

  private isSupportedRsid(value: string): boolean {
    return /^(rs|i)\d+$/i.test(value.trim());
  }

  private isSupportedGenotype(value: string): boolean {
    return /^[ACGT-]{1,2}$/i.test(value.trim());
  }

  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === "," && !inQuotes) {
        result.push(current);
        current = "";
        continue;
      }

      current += char;
    }

    result.push(current);
    return result;
  }
}

export default new ParserColor();
