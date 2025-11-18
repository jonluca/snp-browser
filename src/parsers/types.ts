import type { ParseResult } from "../types/snp";

/**
 * Validation result from parser format detection
 */
export interface ValidationResult {
  /** Whether the format is valid for this parser */
  valid: boolean;
  /** Confidence level (0-1) in the format detection */
  confidence: number;
  /** Human-readable reason for validation result */
  reason?: string;
  /** Detected format ID if valid */
  detectedFormat?: string;
}

/**
 * Progress callback for parsing operations
 */
export type ProgressCallback = (current: number, total: number) => void;

/**
 * Metadata about a DNA file format parser
 */
export interface ParserMetadata {
  /** Unique identifier for this parser */
  id: string;
  /** Display name of the format */
  name: string;
  /** Description of the format and provider */
  description: string;
  /** Version of the parser implementation */
  version: string;
  /** Supported file extensions (e.g., ['.txt', '.csv']) */
  fileExtensions: string[];
  /** URL to provider's website or documentation */
  providerUrl?: string;
}

/**
 * Interface that all DNA file format parsers must implement
 *
 * This provides a consistent API for parsing different DNA file formats
 * while allowing each parser to handle format-specific details.
 */
export interface DNAParser {
  /** Metadata about this parser */
  readonly metadata: ParserMetadata;

  /**
   * Validate if the file content matches this parser's format
   *
   * Should be fast and only examine the beginning of the file.
   * Returns a confidence score (0-1) to help with format detection.
   *
   * @param content - The file content to validate
   * @returns Validation result with confidence score
   */
  validate(content: string): ValidationResult;

  /**
   * Parse the file content into standardized genotype data
   *
   * @param content - The complete file content
   * @param onProgress - Callback for reporting progress (current, total)
   * @returns Parsed genotype data and statistics
   * @throws Error if parsing fails
   */
  parse(content: string, onProgress: ProgressCallback): Promise<ParseResult>;
}

/**
 * Result from format detection
 */
export interface FormatDetectionResult {
  /** The detected parser, if any */
  parser?: DNAParser;
  /** All parsers that claimed the format was valid, sorted by confidence */
  candidates: Array<{
    parser: DNAParser;
    validation: ValidationResult;
  }>;
  /** Whether format was detected with high confidence */
  confident: boolean;
}
