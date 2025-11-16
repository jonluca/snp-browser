import { expose } from "comlink";
import initSqlJs, { type Database } from "sql.js";
import type { UserGenotype, MatchedSNP, SNPRecord, ParsedSNPData } from "../types/snp";

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
        const genotype = row.genotype as string;

        // Find matching user genotype - match both rsid and genotype value if present
        const userGenotype = batch.find((g) => {
          const rsidMatch = g.rsid === snp_id;
          // If genotype column exists and is not empty, also match genotype value
          if (genotype && genotype.trim()) {
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

    onProgress(Math.min(i + batchSize, genotypes.length), genotypes.length);
  }

  return matches;
}

/**
 * Worker API exposed via Comlink
 */
const workerApi = {
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
