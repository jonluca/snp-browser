import type { DNAParser, FormatDetectionResult } from "./types";

/**
 * Central registry for DNA file format parsers
 *
 * This registry manages all available parsers and provides
 * format detection capabilities.
 */
export class ParserRegistry {
  private parsers = new Map<string, DNAParser>();

  /**
   * Register a new parser
   *
   * @param parser - The parser to register
   * @throws Error if a parser with the same ID is already registered
   */
  register(parser: DNAParser): void {
    if (this.parsers.has(parser.metadata.id)) {
      throw new Error(`Parser with id "${parser.metadata.id}" is already registered`);
    }
    this.parsers.set(parser.metadata.id, parser);
  }

  /**
   * Get a parser by ID
   *
   * @param id - The parser ID
   * @returns The parser, or undefined if not found
   */
  get(id: string): DNAParser | undefined {
    return this.parsers.get(id);
  }

  /**
   * Get all registered parsers
   *
   * @returns Array of all parsers
   */
  getAll(): DNAParser[] {
    return Array.from(this.parsers.values());
  }

  /**
   * Get all supported file extensions
   *
   * @returns Array of unique file extensions
   */
  getSupportedExtensions(): string[] {
    const extensions = new Set<string>();
    for (const parser of this.parsers.values()) {
      parser.metadata.fileExtensions.forEach((ext) => extensions.add(ext));
    }
    return Array.from(extensions);
  }

  /**
   * Auto-detect format from file content
   *
   * Runs validation against all parsers and returns the best match
   * based on confidence scores.
   *
   * @param content - The file content to analyze
   * @returns Detection result with best parser and all candidates
   */
  detectFormat(content: string): FormatDetectionResult {
    const candidates: FormatDetectionResult["candidates"] = [];

    // Test all parsers
    for (const parser of this.parsers.values()) {
      try {
        const validation = parser.validate(content);
        if (validation.valid) {
          candidates.push({ parser, validation });
        }
      } catch (error) {
        // Parser validation threw error, skip it
        console.warn(`Parser ${parser.metadata.id} validation failed:`, error);
      }
    }

    // Sort by confidence (highest first)
    candidates.sort((a, b) => b.validation.confidence - a.validation.confidence);

    // Consider detection confident if:
    // 1. At least one parser matched, AND
    // 2. The top match has confidence >= 0.8, AND
    // 3. Either there's only one match OR the top match is significantly better (>0.2 difference)
    const topMatch = candidates[0];
    const secondMatch = candidates[1];
    const confident =
      !!topMatch &&
      topMatch.validation.confidence >= 0.8 &&
      (!secondMatch || topMatch.validation.confidence - secondMatch.validation.confidence > 0.2);

    return {
      parser: topMatch?.parser,
      candidates,
      confident,
    };
  }

  /**
   * Unregister a parser
   *
   * @param id - The parser ID to remove
   * @returns true if the parser was removed, false if not found
   */
  unregister(id: string): boolean {
    return this.parsers.delete(id);
  }

  /**
   * Clear all registered parsers
   */
  clear(): void {
    this.parsers.clear();
  }

  /**
   * Get count of registered parsers
   */
  get count(): number {
    return this.parsers.size;
  }
}

/**
 * Global parser registry instance
 */
export const parserRegistry = new ParserRegistry();
