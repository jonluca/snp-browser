import type { UserGenotype, ParseResult } from "../types/snp";

/**
 * Parses a 23andMe genomic data file
 * Format: Tab-delimited with comment lines starting with #
 * Columns: rsid, chromosome, position, genotype
 */
export function parse23andMeFile(fileContent: string): ParseResult {
  const lines = fileContent.split("\n");
  const genotypes: UserGenotype[] = [];
  const errors: string[] = [];
  let skippedLines = 0;

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

    // Validate rsid format (should start with 'rs' or 'i')
    if (!rsid.match(/^(rs|i)\d+/i)) {
      errors.push(`Line ${i + 1}: Invalid rsid format: ${rsid}`);
      skippedLines++;
      continue;
    }

    genotypes.push({
      rsid: rsid.toLowerCase(), // Normalize to lowercase for matching
      chromosome,
      position,
      genotype,
    });
  }

  return {
    genotypes,
    totalLines: lines.length,
    skippedLines,
    errors,
  };
}

/**
 * Validates if a file appears to be a 23andMe format file
 */
export function validate23andMeFile(fileContent: string): { valid: boolean; reason?: string } {
  const lines = fileContent.split("\n").slice(0, 100); // Check first 100 lines

  // Should have comment lines
  const hasComments = lines.some((line) => line.trim().startsWith("#"));
  if (!hasComments) {
    return { valid: false, reason: "File doesn't appear to have 23andMe format headers (no # comment lines)" };
  }

  // Should have data lines with rsid format
  const hasRsidData = lines.some((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("#") && trimmed.match(/^(rs|i)\d+/i);
  });

  if (!hasRsidData) {
    return { valid: false, reason: "File doesn't contain valid SNP data (no rsid entries found)" };
  }

  return { valid: true };
}
