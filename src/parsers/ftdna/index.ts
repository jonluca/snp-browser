import type { DNAParser, ValidationResult, ProgressCallback, ParserMetadata } from "../types";
import type { ParseResult, UserGenotype } from "../../types/snp";

const METADATA: ParserMetadata = {
  id: "ftdna",
  name: "FamilyTreeDNA",
  description: "FamilyTreeDNA (FTDNA) raw data export (CSV format)",
  version: "1.0.0",
  fileExtensions: [".csv"],
  providerUrl: "https://www.familytreedna.com",
};

/**
 * Parser for FamilyTreeDNA data files
 *
 * FTDNA files are CSV format with:
 * - Header row: RSID,"CHROMOSOME","POSITION","RESULT"
 * - Data rows: rs4477212,"1","82154","AA"
 * - Values may be quoted
 * - Uses "0" for no-calls
 *
 * Key differences:
 * - CSV format with quoted values
 * - "0" represents no-call instead of "--"
 * - May include additional metadata columns
 */
export class ParserFTDNA implements DNAParser {
  readonly metadata = METADATA;

  validate(content: string): ValidationResult {
    const lines = content.split("\n").slice(0, 100); // Check first 100 lines

    let hasFTDNAHeader = false;
    let hasCSVHeader = false;
    let hasRsidData = false;
    let validDataLines = 0;
    let hasQuotedValues = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines
      if (!trimmed) continue;

      // Check for FTDNA-specific comments or metadata
      if (trimmed.startsWith("#")) {
        const lower = trimmed.toLowerCase();
        if (lower.includes("familytreedna") || lower.includes("ftdna")) {
          hasFTDNAHeader = true;
        }
        continue;
      }

      // Check for CSV header row
      const upper = trimmed.toUpperCase();
      if (upper.includes("RSID") && upper.includes("CHROMOSOME") && upper.includes("RESULT")) {
        hasCSVHeader = true;
        // FTDNA often uses quoted column names
        if (trimmed.includes('"')) {
          hasQuotedValues = true;
        }
        continue;
      }

      // Check for valid rsid data in CSV format
      // Handle both quoted and unquoted values
      const parts = this.parseCSVLine(trimmed);
      if (parts.length >= 4 && /^(rs|i)\d+/i.test(parts[0])) {
        hasRsidData = true;
        validDataLines++;

        // Validate FTDNA CSV format
        const [rsid, chromosome, position, result] = parts;
        if (
          /^(rs|i)\d+/i.test(rsid) &&
          /^(1?\d|2[0-2]|X|Y|MT)$/i.test(chromosome) &&
          /^\d+$/.test(position) &&
          /^[ACGT0-]{1,2}$/i.test(result) // 0 = no call in FTDNA
        ) {
          // Valid FTDNA format
        } else {
          validDataLines--;
        }
      }
    }

    // Calculate confidence
    let confidence = 0;
    if (hasCSVHeader) confidence += 0.3;
    if (hasFTDNAHeader) confidence += 0.4;
    if (hasQuotedValues) confidence += 0.2;
    if (hasRsidData && validDataLines >= 3) confidence += 0.1;

    const valid = hasCSVHeader && hasRsidData;

    return {
      valid,
      confidence: valid ? confidence : 0,
      reason: valid
        ? `Detected FamilyTreeDNA CSV format with ${validDataLines} valid data lines`
        : "File doesn't appear to be FamilyTreeDNA CSV format",
      detectedFormat: valid ? METADATA.id : undefined,
    };
  }

  /**
   * Parse CSV line handling quoted values
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
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
      if (line.startsWith("#")) {
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
      const parts = this.parseCSVLine(line);

      if (parts.length < 4) {
        errors.push(`Line ${i + 1}: Invalid format - expected 4 CSV columns, got ${parts.length}`);
        skippedLines++;
        continue;
      }

      const [rsid, chromosome, position, result] = parts;

      // FTDNA uses "0" for no-calls, convert to standard "--"
      let genotype = result.toLowerCase();
      if (genotype === "0" || genotype === "00") {
        genotype = "--";
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
export default new ParserFTDNA();
