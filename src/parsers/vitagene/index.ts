import type { DNAParser, ProgressCallback, ParserMetadata, ValidationResult } from "../types";
import type { ParseResult, UserGenotype } from "../../types/snp";

const METADATA: ParserMetadata = {
  id: "vitagene",
  name: "Vitagene",
  description: "Vitagene raw data export with RSID,CHROMOSOME,POSITION,RESULT columns",
  version: "1.0.0",
  fileExtensions: [".txt", ".csv"],
  providerUrl: "https://vitagene.com",
};

const SAMPLE_LINE_COUNT = 5000;

export class ParserVitagene implements DNAParser {
  readonly metadata = METADATA;

  validate(content: string): ValidationResult {
    const lines = content.split("\n").slice(0, SAMPLE_LINE_COUNT);

    let hasHeader = false;
    let hasVitageneComment = false;
    let validDataLines = 0;
    let hasCommaSeparatedRows = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("#")) {
        if (trimmed.toLowerCase().includes("vitagene")) {
          hasVitageneComment = true;
        }
        continue;
      }

      const parts = this.parseCSVLine(trimmed);
      const normalizedHeader = parts.map((part) => part.trim().toUpperCase());
      if (
        normalizedHeader[0] === "RSID" &&
        normalizedHeader[1] === "CHROMOSOME" &&
        normalizedHeader[2] === "POSITION" &&
        normalizedHeader[3] === "RESULT"
      ) {
        hasHeader = true;
        hasCommaSeparatedRows = trimmed.includes(",");
        continue;
      }

      if (parts.length >= 4 && this.isSupportedRsid(parts[0]) && this.isSupportedGenotype(parts[3])) {
        validDataLines++;
        hasCommaSeparatedRows = trimmed.includes(",");
      }
    }

    let confidence = 0;
    if (hasHeader) confidence += 0.5;
    if (hasCommaSeparatedRows) confidence += 0.2;
    if (validDataLines >= 3) confidence += 0.2;
    if (hasVitageneComment) confidence += 0.1;

    const valid = hasHeader && validDataLines >= 3;

    return {
      valid,
      confidence: valid ? confidence : 0,
      reason: valid
        ? `Detected Vitagene-style RSID CSV format with ${validDataLines} valid data lines in the sampled lines`
        : "File doesn't appear to be Vitagene RSID CSV format",
      detectedFormat: valid ? METADATA.id : undefined,
    };
  }

  async parse(content: string, onProgress: ProgressCallback): Promise<ParseResult> {
    const lines = content.split("\n");
    const genotypes: UserGenotype[] = [];
    const errors: string[] = [];
    let skippedLines = 0;
    const totalLines = lines.length;
    const batchSize = 1000;

    onProgress(0, totalLines);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (!line || line.startsWith("#")) {
        skippedLines++;
        continue;
      }

      const parts = this.parseCSVLine(line);
      if (this.isHeader(parts)) {
        skippedLines++;
        continue;
      }

      if (parts.length < 4) {
        errors.push(`Line ${i + 1}: Invalid format - expected 4 columns, got ${parts.length}`);
        skippedLines++;
        continue;
      }

      const [rsid, chromosome, position, result] = parts.map((part) => part.trim());

      if (!this.isSupportedRsid(rsid)) {
        skippedLines++;
        continue;
      }

      if (!this.isSupportedGenotype(result)) {
        skippedLines++;
        continue;
      }

      genotypes.push({
        rsid: rsid.toLowerCase(),
        chromosome,
        position,
        genotype: result.toLowerCase(),
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

  private isHeader(parts: string[]): boolean {
    const normalized = parts.map((part) => part.trim().toUpperCase());
    return (
      normalized[0] === "RSID" &&
      normalized[1] === "CHROMOSOME" &&
      normalized[2] === "POSITION" &&
      normalized[3] === "RESULT"
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

export default new ParserVitagene();
