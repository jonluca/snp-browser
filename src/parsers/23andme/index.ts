import type { DNAParser, ValidationResult, ProgressCallback, ParserMetadata } from "../types";
import type { ParseResult, UserGenotype } from "../../types/snp";

const METADATA: ParserMetadata = {
  id: "23andme",
  name: "23andMe",
  description: "23andMe raw data export (TXT or CSV format)",
  version: "1.0.0",
  fileExtensions: [".txt", ".csv"],
  providerUrl: "https://www.23andme.com",
};

/**
 * Parser for 23andMe DNA data files
 *
 * 23andMe files are typically tab or space-separated text files with:
 * - Comment lines starting with #
 * - Data columns: rsid, chromosome, position, genotype
 * - Example: rs4477212    1    82154    AA
 */
export class Parser23andMe implements DNAParser {
  readonly metadata = METADATA;

  validate(content: string): ValidationResult {
    const lines = content.split("\n").slice(0, 100); // Check first 100 lines

    // Check for 23andMe-specific markers
    let hasCommentLines = false;
    let has23andMeHeader = false;
    let hasRsidData = false;
    let validDataLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for comment lines
      if (trimmed.startsWith("#")) {
        hasCommentLines = true;
        // Look for 23andMe-specific headers
        if (trimmed.toLowerCase().includes("23andme")) {
          has23andMeHeader = true;
        }
        continue;
      }

      // Skip empty lines
      if (!trimmed) continue;

      // Check for valid rsid data format
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 4 && /^(rs|i)\d+/i.test(parts[0])) {
        hasRsidData = true;
        validDataLines++;

        // Validate data format
        const [rsid, chromosome, position, genotype] = parts;
        // 23andMe uses standard chromosome notation (1-22, X, Y, MT)
        // Position should be numeric
        // Genotype should be 1-2 characters (bases or --)
        if (
          /^(rs|i)\d+/i.test(rsid) &&
          /^(1?\d|2[0-2]|X|Y|MT)$/i.test(chromosome) &&
          /^\d+$/.test(position) &&
          /^[ACGT-]{1,2}$/i.test(genotype)
        ) {
          // Valid 23andMe format
        } else {
          validDataLines--; // This line doesn't match 23andMe format well
        }
      }
    }

    // Calculate confidence
    let confidence = 0;
    if (hasCommentLines) confidence += 0.3;
    if (has23andMeHeader) confidence += 0.4;
    if (hasRsidData) confidence += 0.2;
    if (validDataLines >= 3) confidence += 0.1;

    const valid = hasCommentLines && hasRsidData;

    return {
      valid,
      confidence: valid ? confidence : 0,
      reason: valid
        ? `Detected 23andMe format with ${validDataLines} valid data lines`
        : "File doesn't appear to have 23andMe format headers or data",
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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip empty lines
      if (!line) {
        skippedLines++;
        continue;
      }

      // Skip comment lines
      if (line.startsWith("#")) {
        skippedLines++;
        continue;
      }

      // Parse data line
      const parts = line.split(/\s+/); // Split by whitespace (tabs or spaces)

      if (parts.length < 4) {
        errors.push(`Line ${i + 1}: Invalid format - expected 4 columns, got ${parts.length}`);
        skippedLines++;
        continue;
      }

      const [rsid, chromosome, position, genotype] = parts;

      // Normalize genotype to lowercase
      const genotypeValue = genotype.toLowerCase();

      genotypes.push({
        rsid: rsid.toLowerCase(), // Normalize to lowercase for matching
        chromosome,
        position,
        genotype: genotypeValue,
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
export default new Parser23andMe();
