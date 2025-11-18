import { expose } from "comlink";
import initSqlJs, { type Database } from "sql.js";
import type {
  UserGenotype,
  MatchedSNP,
  SNPRecord,
  ParsedSNPData,
  ParseResult,
  GenosetRecord,
  MatchedGenoset,
} from "../types/snp";

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

/**
 * Parse content fields to extract structured data
 */
function parseContentData(rsid: string, snpContent: string, genotypeContent?: string): ParsedSNPData {
  // Extract magnitude from genotype-specific content first, fall back to SNP content
  const magnitude = genotypeContent
    ? (extractMagnitude(genotypeContent) ?? extractMagnitude(snpContent))
    : extractMagnitude(snpContent);

  return {
    rsid,
    rawContent: snpContent,
    genotypeContent,
    magnitude,
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
        const rowGenotype = row.genotype as string;
        // replace all non alphanumeric characters and convert to lowercase for matching
        const genotype = rowGenotype
          .replace(/[^a-z0-9-]/gi, "")
          .toLowerCase()
          .trim();

        // Find matching user genotype - match both rsid and genotype value if present
        const userGenotype = batch.find((g) => {
          const rsidMatch = g.rsid === snp_id;
          // If genotype column exists and is not empty, also match genotype value
          if (genotype && genotype) {
            return rsidMatch && g.genotype === genotype;
          }
          return rsidMatch;
        });

        if (userGenotype) {
          const rsid = row.rsid as string;
          const snpContent = (row.snp_content as string) || "";
          const genotypeContent = (row.genotype_content as string) || "";

          // Parse content to extract structured data
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
              genotype: genotype,
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
 * Parses a 23andMe genomic data file with progress reporting
 */
async function parse23andMeFileInWorker(
  fileContent: string,
  onProgress: (current: number, total: number) => void,
): Promise<ParseResult> {
  const is23andMe = fileContent.slice(0, 1000).toLowerCase().includes("23andme");
  const lines = fileContent.split("\n");
  const genotypes: UserGenotype[] = [];
  const errors: string[] = [];
  let skippedLines = 0;
  const totalLines = lines.length;

  // Report initial progress
  onProgress(0, totalLines);

  // Process lines in batches for better performance and progress reporting
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

    // if it's 23andme, we need to swap all C's to G's and G's to C's
    const genotypeValue = genotype.toLowerCase();
    // if (is23andMe) {
    //   genotypeValue = genotype
    //     .split("")
    //     .map((char) => {
    //       if (char === "c") return "g";
    //       if (char === "g") return "c";
    //       return char;
    //     })
    //     .join("");
    // }

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

/**
 * Validates if a file appears to be a 23andMe format file
 */
function validate23andMeFileInWorker(fileContent: string): { valid: boolean; reason?: string } {
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
   * Parses and validates a 23andMe genomic data file
   */
  async parseFile(fileContent: string, onProgress: (current: number, total: number) => void): Promise<ParseResult> {
    // Validate format first
    const validation = validate23andMeFileInWorker(fileContent);
    if (!validation.valid) {
      throw new Error(validation.reason || "Invalid file format");
    }

    // Parse file with progress reporting
    return parse23andMeFileInWorker(fileContent, onProgress);
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
        locateFile: (file) => `https://sql.js.org/dist/${file}`,
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
