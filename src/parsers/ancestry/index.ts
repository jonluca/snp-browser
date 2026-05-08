import type { DNAParser, ValidationResult, ProgressCallback, ParserMetadata } from "../types";
import type { ParseResult, UserGenotype } from "../../types/snp";

const METADATA: ParserMetadata = {
  id: "ancestry",
  name: "Ancestry.com",
  description: "AncestryDNA raw data export (TXT or CSV format)",
  version: "1.0.0",
  fileExtensions: [".txt", ".csv"],
  providerUrl: "https://www.ancestry.com",
};

/**
 * Parser for AncestryDNA data files
 *
 * AncestryDNA files are tab-separated text files with:
 * - Comment lines starting with #
 * - Header line: #rsid  chromosome  position  allele1  allele2
 * - Data columns: rsid, chromosome, position, allele1, allele2
 * - Example: rs4477212    1    82154    A    A
 *
 * Key differences from 23andMe:
 * - Uses separate allele1/allele2 columns instead of combined genotype
 * - May have different comment structure
 * - File often named like "AncestryDNA.txt"
 */
export class ParserAncestry implements DNAParser {
  readonly metadata = METADATA;

  validate(content: string): ValidationResult {
    const lines = content.split("\n").slice(0, 100); // Check first 100 lines

    let hasCommentLines = false;
    let hasAncestryHeader = false;
    let hasAlleleColumns = false;
    let hasRsidData = false;
    let validDataLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for comment lines
      if (trimmed.startsWith("#")) {
        hasCommentLines = true;
        const lower = trimmed.toLowerCase();
        // Look for Ancestry-specific markers
        if (lower.includes("ancestry") || lower.includes("ancestrydna")) {
          hasAncestryHeader = true;
        }
        // Check for allele1/allele2 column headers
        if (lower.includes("allele1") && lower.includes("allele2")) {
          hasAlleleColumns = true;
        }
        continue;
      }

      if (!trimmed) continue;

      const lower = trimmed.toLowerCase();
      if (lower.includes("allele1") && lower.includes("allele2")) {
        hasAlleleColumns = true;
        continue;
      }

      // Check for valid rsid data format
      const parts = trimmed.split(/\t/); // Ancestry typically uses tabs
      if (parts.length >= 5 && /^(rs|i)\d+/i.test(parts[0])) {
        hasRsidData = true;
        validDataLines++;

        // Validate Ancestry format: rsid, chromosome, position, allele1, allele2
        const [rsid, chromosome, position, allele1, allele2] = parts;
        if (
          /^(rs|i)\d+/i.test(rsid) &&
          /^(1?\d|2[0-2]|X|Y|MT)$/i.test(chromosome) &&
          /^\d+$/.test(position) &&
          /^[ACGTDI0-]$/i.test(allele1) && // D=deletion, I=insertion, 0=no call
          /^[ACGTDI0-]$/i.test(allele2)
        ) {
          // Valid Ancestry format
        } else {
          validDataLines--;
        }
      }
    }

    // Calculate confidence
    let confidence = 0;
    if (hasCommentLines) confidence += 0.2;
    if (hasAncestryHeader) confidence += 0.4;
    if (hasAlleleColumns) confidence += 0.3;
    if (hasRsidData) confidence += 0.1;

    const valid = hasCommentLines && hasRsidData;

    return {
      valid,
      confidence: valid ? confidence : 0,
      reason: valid
        ? `Detected AncestryDNA format with ${validDataLines} valid data lines`
        : "File doesn't appear to have AncestryDNA format",
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

      // Parse data line - Ancestry uses tabs
      const parts = line.split(/\t/);

      if (parts.length < 5) {
        errors.push(`Line ${i + 1}: Invalid format - expected 5 columns, got ${parts.length}`);
        skippedLines++;
        continue;
      }

      const [rsid, chromosome, position, allele1, allele2] = parts;

      // Combine alleles into genotype (Ancestry separates them)
      // Handle special cases: 0 = no call, D = deletion, I = insertion
      let genotype: string;
      if (allele1 === "0" || allele2 === "0") {
        genotype = "--"; // No call
      } else if (allele1 === "D" || allele2 === "D" || allele1 === "I" || allele2 === "I") {
        // Deletion or insertion - keep as-is for now
        genotype = (allele1 + allele2).toLowerCase();
      } else {
        genotype = (allele1 + allele2).toLowerCase();
      }

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
export default new ParserAncestry();
