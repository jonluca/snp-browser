import { expose } from "comlink";
import initSqlJs, { type Database } from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";
import type {
  UserGenotype,
  MatchedSNP,
  SNPRecord,
  ParsedSNPData,
  ParseResult,
  GenosetRecord,
  MatchedGenoset,
} from "../types/snp";
import { parserRegistry } from "../parsers";

/**
 * Worker state - holds the loaded database
 */
let db: Database | null = null;

/**
 * All columns to select from the snps table (actual schema)
 */
const SNP_COLUMNS = `rsid, content, scraped_at`;

/**
 * Columns to select from genotypes table joined with snps (actual schema)
 */
const GENOTYPE_JOIN_COLUMNS = `
  g.id as genotype_id,
  g.content as genotype_content,
  g.scraped_at as genotype_scraped_at,
  g.snp_id,
  g.genotype,
  s.rsid,
  s.content as snp_content,
  s.scraped_at as snp_scraped_at
`;

/**
 * Extract magnitude from SNPedia content
 */
function extractMagnitude(content: string): number | undefined {
  // Look for magnitude patterns like "magnitude=3" or "Magnitude: 3"
  const magnitudeMatch = content.match(/magnitude[:\s=]+(\d+(?:\.\d+)?)/i);
  if (magnitudeMatch && magnitudeMatch[1]) {
    const mag = parseFloat(magnitudeMatch[1]);
    return isNaN(mag) ? undefined : mag;
  }
  return undefined;
}

type Orientation = "plus" | "minus" | "unknown";

function parseOrientationFromContent(content: string): {
  orientation: Orientation;
  stabilizedOrientation: Orientation;
} {
  const orientationRegex = /\|Orientation=([^|\n}]+)/i;
  const stabilizedOrientationRegex = /\|StabilizedOrientation=([^|\n}]+)/i;

  const orientationMatch = content.match(orientationRegex);
  const stabilizedMatch = content.match(stabilizedOrientationRegex);

  const normalize = (val: string | undefined | null): Orientation => {
    if (!val) return "unknown";
    const v = val.trim().toLowerCase();
    if (v.startsWith("plus") || v === "+") return "plus";
    if (v.startsWith("minus") || v === "-") return "minus";
    return "unknown";
  };

  return {
    orientation: normalize(orientationMatch?.[1]),
    stabilizedOrientation: normalize(stabilizedMatch?.[1]),
  };
}

/**
 * Complement a genotype string (A<->T, C<->G), leaving other characters as-is.
 * Input is assumed lowercased.
 */
function complementGenotype(genotype: string): string {
  const map: Record<string, string> = {
    a: "t",
    t: "a",
    c: "g",
    g: "c",
  };

  return genotype
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("");
}
/**
 * Parse content fields to extract structured data
 */
function parseContentData(rsid: string, snpContent: string, genotypeContent?: string): ParsedSNPData {
  const magnitude = genotypeContent
    ? (extractMagnitude(genotypeContent) ?? extractMagnitude(snpContent))
    : extractMagnitude(snpContent);

  const { orientation, stabilizedOrientation } = parseOrientationFromContent(snpContent);

  return {
    rsid,
    rawContent: snpContent,
    genotypeContent,
    magnitude,
    // add these fields to ParsedSNPData if they’re not there yet
    orientation,
    stabilizedOrientation,
  };
}

/**
 * Matches SNPs in batches to avoid SQLite parameter limits
 */
async function matchSNPsInBatches(
  database: Database,
  genotypes: UserGenotype[],
  onProgress: (current: number, total: number) => void,
): Promise<MatchedSNP[]> {
  const matches: MatchedSNP[] = [];
  const batchSize = 500; // Stay well under SQLite's 999 parameter limit

  // create index on lowercase snp_id for faster lookups
  database.run(`CREATE INDEX IF NOT EXISTS idx_genotypes_snp_id_lower ON genotypes(lower(snp_id));`);

  for (let i = 0; i < genotypes.length; i += batchSize) {
    const batch = genotypes.slice(i, Math.min(i + batchSize, genotypes.length));
    const rsids = batch.map((g) => g.rsid);

    // Create parameterized query - join genotypes with snps on snp_id
    const placeholders = rsids.map(() => "?").join(",");
    const query = `
      SELECT ${GENOTYPE_JOIN_COLUMNS}
      FROM genotypes g
      INNER JOIN snps s ON g.snp_id = s.rsid
      WHERE lower(g.snp_id) IN (${placeholders})
    `;

    try {
      const stmt = database.prepare(query);
      stmt.bind(rsids);

      while (stmt.step()) {
        const row = stmt.getAsObject();
        const snp_id = row.snp_id as string;

        const rowGenotypeRaw = row.genotype as string;
        // SNPedia genotype, normalized for comparison
        const snpediaGenotype = rowGenotypeRaw
          .replace(/[^a-z0-9-]/gi, "")
          .toLowerCase()
          .trim();

        const snpContent = (row.snp_content as string) || "";
        const genotypeContent = (row.genotype_content as string) || "";

        // Determine orientation for this SNP
        const { orientation, stabilizedOrientation } = parseOrientationFromContent(snpContent);
        // Per SNPedia docs, StabilizedOrientation is what the genotype definitions use;
        // fall back to Orientation if needed.
        const effectiveOrientation: Orientation =
          stabilizedOrientation !== "unknown" ? stabilizedOrientation : orientation;

        // Find matching user genotype for this SNP, taking orientation into account
        const userGenotype = batch.find((g) => {
          const rsidMatch = g.rsid === snp_id;
          if (!rsidMatch) return false;
          if (g.genotype == "--") return false;

          if (!snpediaGenotype) return rsidMatch;

          // 23andMe genotypes are plus-strand. If SNPedia’s effective orientation is minus,
          // flip the user genotype into minus to match SNPedia’s definitions.
          let normalizedUserGenotype = (g.genotype || "").toLowerCase().trim();
          if (effectiveOrientation === "minus") {
            normalizedUserGenotype = complementGenotype(normalizedUserGenotype);
          }

          return normalizedUserGenotype === snpediaGenotype;
        });

        if (userGenotype) {
          const rsid = row.rsid as string;

          // Parse content (this will also re-parse orientation and make it available downstream)
          const parsedData = parseContentData(rsid, snpContent, genotypeContent);

          matches.push({
            ...userGenotype,
            snpData: {
              rsid,
              content: snpContent,
              scraped_at: row.snp_scraped_at as string | undefined,
            },
            genotypeData: {
              id: row.genotype_id as string,
              content: genotypeContent,
              scraped_at: row.genotype_scraped_at as string | undefined,
              snp_id: snp_id,
              // keep this as the SNPedia genotype (its own orientation)
              genotype: snpediaGenotype,
            },
            parsedData,
          });
        }
      }
      stmt.free();
    } catch (error) {
      console.error("Error querying batch:", error);
    }

    if (i % 1000 === 0) {
      onProgress(Math.min(i + batchSize, genotypes.length), genotypes.length);
    }
  }

  return matches;
}

/**
 * Parse file using appropriate parser based on format detection or specified parser ID
 */
async function parseFileWithDetection(
  fileContent: string,
  onProgress: (current: number, total: number) => void,
  parserId?: string,
): Promise<ParseResult & { detectedFormat?: string }> {
  let parser;

  // If parser ID is specified, use that parser
  if (parserId) {
    parser = parserRegistry.get(parserId);
    if (!parser) {
      throw new Error(
        `Parser "${parserId}" not found. Available parsers: ${parserRegistry
          .getAll()
          .map((p) => p.metadata.id)
          .join(", ")}`,
      );
    }
  } else {
    // Auto-detect format
    const detection = parserRegistry.detectFormat(fileContent);

    if (!detection.parser) {
      const availableParsers = parserRegistry
        .getAll()
        .map((p) => p.metadata.name)
        .join(", ");
      throw new Error(
        `Could not detect file format. Supported formats: ${availableParsers}. ` +
          "Please ensure your file is from a supported DNA testing provider.",
      );
    }

    parser = detection.parser;

    // Warn if detection confidence is low
    if (!detection.confident && detection.candidates.length > 1) {
      console.warn(
        `Format detection confidence is low. Detected as ${parser.metadata.name} with ${Math.round(detection.candidates[0].validation.confidence * 100)}% confidence. ` +
          `Other candidates: ${detection.candidates
            .slice(1)
            .map((c) => `${c.parser.metadata.name} (${Math.round(c.validation.confidence * 100)}%)`)
            .join(", ")}`,
      );
    }
  }

  // Parse using detected or specified parser
  const result = await parser.parse(fileContent, onProgress);

  return {
    ...result,
    detectedFormat: parser.metadata.id,
  };
}

/**
 * Matches genosets based on matched SNPs
 * A genoset matches if its content references any of the matched genotype IDs
 */
async function matchGenosets(
  database: Database,
  matchedSNPs: MatchedSNP[],
  onProgress: (current: number, total: number) => void,
): Promise<MatchedGenoset[]> {
  const matchedGenosets: MatchedGenoset[] = [];

  // Build a map of genotype IDs to matched SNPs for quick lookup
  const genotypeIdToMatch = new Map<string, MatchedSNP>();
  matchedSNPs.forEach((match) => {
    if (match.genotypeData) {
      genotypeIdToMatch.set(match.genotypeData.id, match);
    }
  });

  // Get all genosets (IDs start with "gs")
  const query = `SELECT id, content, scraped_at FROM genosets`;

  try {
    const stmt = database.prepare(query);
    const allGenosets: GenosetRecord[] = [];

    while (stmt.step()) {
      const row = stmt.getAsObject();
      allGenosets.push({
        id: row.id as string,
        content: row.content as string,
        scraped_at: row.scraped_at as string | undefined,
      });
    }
    stmt.free();

    // Check each genoset for matching genotype IDs
    allGenosets.forEach((genoset, index) => {
      const matchingGenotypes: MatchedSNP[] = [];

      // Search genoset content for genotype IDs
      // Genotype IDs are in format like rsXXXXXX(Y;Y) or similar
      genotypeIdToMatch.forEach((matchedSNP, genotypeId) => {
        // Check if this genotype ID appears in the genoset content
        if (genoset.content.toLowerCase().includes(genotypeId.toLowerCase())) {
          matchingGenotypes.push(matchedSNP);
        }
      });

      // Only include genosets that have at least one matching genotype
      if (matchingGenotypes.length > 0) {
        const magnitude = extractMagnitude(genoset.content);

        matchedGenosets.push({
          genoset,
          matchedGenotypes: matchingGenotypes,
          parsedData: {
            id: genoset.id,
            rawContent: genoset.content,
            magnitude,
          },
        });
      }

      // Report progress
      if (index % 100 === 0 || index === allGenosets.length - 1) {
        onProgress(index + 1, allGenosets.length);
      }
    });
  } catch (error) {
    console.error("Error matching genosets:", error);
  }

  return matchedGenosets;
}

/**
 * Worker API exposed via Comlink
 */
const workerApi = {
  /**
   * Parses a DNA file with automatic format detection or specified parser
   *
   * @param fileContent - The raw file content
   * @param onProgress - Progress callback
   * @param parserId - Optional parser ID (e.g., '23andme', 'ancestry'). If not specified, format is auto-detected.
   */
  async parseFile(
    fileContent: string,
    onProgress: (current: number, total: number) => void,
    parserId?: string,
  ): Promise<ParseResult & { detectedFormat?: string }> {
    return parseFileWithDetection(fileContent, onProgress, parserId);
  },

  /**
   * Get list of all available parsers
   */
  getAvailableParsers() {
    return parserRegistry.getAll().map((p) => ({
      id: p.metadata.id,
      name: p.metadata.name,
      description: p.metadata.description,
      fileExtensions: p.metadata.fileExtensions,
      providerUrl: p.metadata.providerUrl,
    }));
  },

  /**
   * Detect file format without parsing
   */
  detectFileFormat(fileContent: string) {
    const detection = parserRegistry.detectFormat(fileContent);
    return {
      detectedParser: detection.parser
        ? {
            id: detection.parser.metadata.id,
            name: detection.parser.metadata.name,
            confidence: detection.candidates[0]?.validation.confidence || 0,
          }
        : null,
      confident: detection.confident,
      allCandidates: detection.candidates.map((c) => ({
        id: c.parser.metadata.id,
        name: c.parser.metadata.name,
        confidence: c.validation.confidence,
        reason: c.validation.reason,
      })),
    };
  },

  /**
   * Loads the database from a URL
   */
  async loadDatabase(dbPath: string, onProgress: (progress: number) => void): Promise<void> {
    try {
      onProgress(0);

      // Initialize SQL.js
      onProgress(10);
      const SQL = await initSqlJs({
        // Keep the browser JS entry and its matching WASM binary from the same package version.
        locateFile: (file) => (file.endsWith(".wasm") ? sqlWasmUrl : file),
      });

      onProgress(30);

      // Fetch the database file with progress tracking
      const response = await fetch(dbPath, {
        credentials: "omit",
      });
      if (!response.ok) {
        throw new Error(`Failed to load database: ${response.statusText}`);
      }

      const contentLength = response.headers.get("content-length");
      const total = contentLength ? parseInt(contentLength, 10) : 0;

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Response body is not readable");
      }

      const chunks: Uint8Array[] = [];
      let receivedLength = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        receivedLength += value.length;

        if (total > 0) {
          // Progress from 30% to 80% during download
          const downloadProgress = 30 + (receivedLength / total) * 50;
          onProgress(downloadProgress);
        }
      }

      onProgress(85);

      // Combine chunks into single Uint8Array
      const dbBuffer = new Uint8Array(receivedLength);
      let position = 0;
      for (const chunk of chunks) {
        dbBuffer.set(chunk, position);
        position += chunk.length;
      }

      onProgress(90);

      // Create database instance
      db = new SQL.Database(dbBuffer);

      onProgress(100);
    } catch (error) {
      db = null;
      throw error;
    }
  },

  /**
   * Gets database statistics
   */
  getDatabaseStats(): { totalSNPs: number } {
    if (!db) {
      throw new Error("Database not loaded");
    }

    try {
      const result = db.exec("SELECT COUNT(*) as count FROM snps");
      if (result.length > 0 && result[0].values.length > 0) {
        return { totalSNPs: result[0].values[0][0] as number };
      }
    } catch (error) {
      console.error("Error getting database stats:", error);
    }
    return { totalSNPs: 0 };
  },

  /**
   * Matches user genotypes against the loaded database
   */
  async matchSNPs(
    genotypes: UserGenotype[],
    onProgress: (current: number, total: number) => void,
  ): Promise<MatchedSNP[]> {
    if (!db) {
      throw new Error("Database not loaded. Call loadDatabase first.");
    }

    return matchSNPsInBatches(db, genotypes, onProgress);
  },

  /**
   * Matches genosets based on matched SNPs
   */
  async matchGenosets(
    matchedSNPs: MatchedSNP[],
    onProgress: (current: number, total: number) => void,
  ): Promise<MatchedGenoset[]> {
    if (!db) {
      throw new Error("Database not loaded. Call loadDatabase first.");
    }

    return matchGenosets(db, matchedSNPs, onProgress);
  },

  /**
   * Search/browse SNPs with filtering
   */
  async searchSNPs(filters: {
    searchTerm?: string;
    chromosome?: string;
    gene?: string;
    clinicalSignificance?: string;
    disease?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ results: SNPRecord[]; total: number }> {
    if (!db) {
      throw new Error("Database not loaded. Call loadDatabase first.");
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // General search term (searches rsid, gene, content, disease)
    if (filters.searchTerm && filters.searchTerm.trim()) {
      const term = `%${filters.searchTerm.trim()}%`;
      conditions.push(
        "(rsid LIKE ? OR gene LIKE ? OR gene_s LIKE ? OR content LIKE ? OR clin_disease LIKE ? OR clin_gene_name LIKE ?)",
      );
      params.push(term, term, term, term, term, term);
    }

    // Chromosome filter
    if (filters.chromosome) {
      conditions.push("chromosome = ?");
      params.push(filters.chromosome);
    }

    // Gene filter
    if (filters.gene && filters.gene.trim()) {
      const geneTerm = `%${filters.gene.trim()}%`;
      conditions.push("(gene LIKE ? OR gene_s LIKE ? OR clin_gene_name LIKE ?)");
      params.push(geneTerm, geneTerm, geneTerm);
    }

    // Clinical significance filter
    if (filters.clinicalSignificance) {
      conditions.push("clin_sig LIKE ?");
      params.push(`%${filters.clinicalSignificance}%`);
    }

    // Disease filter
    if (filters.disease && filters.disease.trim()) {
      conditions.push("clin_disease LIKE ?");
      params.push(`%${filters.disease.trim()}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM snps ${whereClause}`;
    const countStmt = db.prepare(countQuery);
    if (params.length > 0) {
      countStmt.bind(params);
    }
    countStmt.step();
    const total = (countStmt.getAsObject().count as number) || 0;
    countStmt.free();

    // Get results with pagination
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const query = `SELECT ${SNP_COLUMNS} FROM snps ${whereClause} LIMIT ? OFFSET ?`;

    const results: SNPRecord[] = [];
    const stmt = db.prepare(query);
    stmt.bind([...params, limit, offset]);

    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as SNPRecord;
      results.push(row);
    }

    stmt.free();

    return { results, total };
  },
};

export type SNPMatcherWorkerApi = typeof workerApi;

// Expose the API to Comlink
expose(workerApi);
