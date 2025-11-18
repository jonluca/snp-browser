import type { DNAParser, ValidationResult, ProgressCallback, ParserMetadata } from "../types";
import type { ParseResult, UserGenotype } from "../../types/snp";

const METADATA: ParserMetadata = {
  id: "myheritage",
  name: "MyHeritage",
  description: "MyHeritage DNA raw data export (CSV format)",
  version: "1.0.0",
  fileExtensions: [".csv"],
  providerUrl: "https://www.myheritage.com",
};

/**
 * Parser for MyHeritage DNA data files
 *
 * MyHeritage files are CSV format with:
 * - Header row: RSID,CHROMOSOME,POSITION,RESULT
 * - Data rows: rs4477212,1,82154,AA
 * - May have comment lines with ##
 *
 * Key differences from other formats:
 * - Uses CSV (comma-separated) format
 * - Column headers are uppercase
 * - RESULT column contains combined genotype
 */
export class ParserMyHeritage implements DNAParser {
  readonly metadata = METADATA;

  validate(content: string): ValidationResult {
    const lines = content.split("\n").slice(0, 100); // Check first 100 lines

    let hasMyHeritageHeader = false;
    let hasCSVHeader = false;
    let hasRsidData = false;
    let validDataLines = 0;
    let isCSVFormat = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for MyHeritage-specific comments
      if (trimmed.startsWith("##")) {
        const lower = trimmed.toLowerCase();
        if (lower.includes("myheritage")) {
          hasMyHeritageHeader = true;
        }
        continue;
      }

      // Skip empty lines
      if (!trimmed) continue;

      // Check for CSV header row
      const upper = trimmed.toUpperCase();
      if (upper.includes("RSID") && upper.includes("CHROMOSOME") && upper.includes("RESULT")) {
        hasCSVHeader = true;
        isCSVFormat = trimmed.includes(",");
        continue;
      }

      // Check for valid rsid data in CSV format
      const parts = trimmed.split(",");
      if (parts.length >= 4 && /^(rs|i)\d+/i.test(parts[0])) {
        hasRsidData = true;
        validDataLines++;

        // Validate MyHeritage CSV format: RSID,CHROMOSOME,POSITION,RESULT
        const [rsid, chromosome, position, result] = parts;
        if (
          /^(rs|i)\d+/i.test(rsid) &&
          /^(1?\d|2[0-2]|X|Y|MT)$/i.test(chromosome) &&
          /^\d+$/.test(position) &&
          /^[ACGT-]{1,2}$/i.test(result)
        ) {
          // Valid MyHeritage format
        } else {
          validDataLines--;
        }
      }
    }

    // Calculate confidence
    let confidence = 0;
    if (hasCSVHeader) confidence += 0.4;
    if (hasMyHeritageHeader) confidence += 0.3;
    if (isCSVFormat) confidence += 0.2;
    if (hasRsidData && validDataLines >= 3) confidence += 0.1;

    const valid = hasCSVHeader && hasRsidData && isCSVFormat;

    return {
      valid,
      confidence: valid ? confidence : 0,
      reason: valid
        ? `Detected MyHeritage CSV format with ${validDataLines} valid data lines`
        : "File doesn't appear to be MyHeritage CSV format",
      detectedFormat: valid ? METADATA.id : undefined,
    };
  }

  async parse(content: string, onProgress: ProgressCallback): Promise<ParseResult> {
    const lines = content.split("\n");
    const genotypes: UserGenotype[] = [];
    const errors: string[] = [];
    let skippedLines = 0;
    const totalLines = lines.length;

    // Report initial progress
    onProgress(0, totalLines);

    const batchSize = 1000;
    let headerFound = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip empty lines
      if (!line) {
        skippedLines++;
        continue;
      }

      // Skip comment lines
      if (line.startsWith("##")) {
        skippedLines++;
        continue;
      }

      // Skip header row
      const upper = line.toUpperCase();
      if (!headerFound && upper.includes("RSID") && upper.includes("CHROMOSOME")) {
        headerFound = true;
        skippedLines++;
        continue;
      }

      // Parse CSV data line
      const parts = line.split(",");

      if (parts.length < 4) {
        errors.push(`Line ${i + 1}: Invalid format - expected 4 CSV columns, got ${parts.length}`);
        skippedLines++;
        continue;
      }

      const [rsid, chromosome, position, result] = parts;

      // MyHeritage uses RESULT for the genotype
      const genotype = result.toLowerCase();

      genotypes.push({
        rsid: rsid.toLowerCase(),
        chromosome,
        position,
        genotype,
      });

      // Report progress every batch
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
}

/**
 * Default export for convenience
 */
export default new ParserMyHeritage();
