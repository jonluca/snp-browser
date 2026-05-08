/**
 * DNA File Format Parsers
 *
 * This module provides a registry-based system for parsing different DNA file formats.
 * Each parser implements the DNAParser interface and can validate and parse files
 * from different DNA testing providers.
 *
 * ## Supported Formats
 *
 * - 23andMe: Tab/space-separated TXT files
 * - AncestryDNA: Tab-separated TXT files with separate allele columns
 * - MyHeritage: CSV files with RSID,CHROMOSOME,POSITION,RESULT format
 * - FamilyTreeDNA: CSV files with quoted values
 * - Vitagene: CSV/TXT files with RSID,CHROMOSOME,POSITION,RESULT format
 * - VCF: Variant Call Format files with GT sample fields
 *
 * ## Adding New Parsers
 *
 * 1. Create a new directory under `src/parsers/`
 * 2. Implement the `DNAParser` interface
 * 3. Export a default instance of your parser
 * 4. Import and register it in this file
 *
 * Example:
 * ```typescript
 * import myNewParser from './mynewformat';
 * parserRegistry.register(myNewParser);
 * ```
 */

// Core types and registry
export { parserRegistry, ParserRegistry } from "./registry";
export type { DNAParser, ValidationResult, ProgressCallback, ParserMetadata, FormatDetectionResult } from "./types";

// Individual parsers
import parser23andMe from "./23andme";
import parserAncestry from "./ancestry";
import parserMyHeritage from "./myheritage";
import parserFTDNA from "./ftdna";
import parserVitagene from "./vitagene";
import parserVCF from "./vcf";

// Re-export parsers
export { parser23andMe, parserAncestry, parserMyHeritage, parserFTDNA, parserVitagene, parserVCF };

// Auto-register all parsers
import { parserRegistry } from "./registry";

// Register all available parsers
parserRegistry.register(parser23andMe);
parserRegistry.register(parserAncestry);
parserRegistry.register(parserMyHeritage);
parserRegistry.register(parserFTDNA);
parserRegistry.register(parserVitagene);
parserRegistry.register(parserVCF);

/**
 * Get a list of all registered parsers
 */
export function getAllParsers() {
  return parserRegistry.getAll();
}

/**
 * Get supported file extensions
 */
export function getSupportedExtensions() {
  return parserRegistry.getSupportedExtensions();
}

/**
 * Detect format from file content
 */
export function detectFormat(content: string) {
  return parserRegistry.detectFormat(content);
}

/**
 * Get a parser by ID
 */
export function getParser(id: string) {
  return parserRegistry.get(id);
}
