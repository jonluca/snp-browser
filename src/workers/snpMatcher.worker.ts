import { expose } from "comlink";
import initSqlJs, { type Database } from "sql.js";
import type { UserGenotype, MatchedSNP, SNPRecord } from "../types/snp";

/**
 * Worker state - holds the loaded database
 */
let db: Database | null = null;

/**
 * All columns to select from the snps table
 */
const SNP_COLUMNS = `
  rsid, content, chromosome, position, gene, gene_s,
  orientation, assembly, genome_build, dbsnp_build, stabilized_orientation,
  geno1, geno2, geno3,
  clin_chromosome, clin_rsid, clin_sig, clin_disease, clin_dbn, clin_hgvs,
  clin_origin, clin_accession, clin_reversed, clin_fwd_ref, clin_fwd_alt,
  clin_ref, clin_alt, clin_rspos, clin_dbsnp_build_id, clin_ssr, clin_sao,
  clin_vp, clin_geneinfo, clin_gene_name, clin_gene_id, clin_wgt, clin_vc,
  clin_clnalle, clin_tags, clin_clndsdb, clin_clndsdbid, clin_clnrevstat,
  clin_clnsrc, clin_clnsrcid, pmid, pmid_title
`;

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

  for (let i = 0; i < genotypes.length; i += batchSize) {
    const batch = genotypes.slice(i, Math.min(i + batchSize, genotypes.length));
    const rsids = batch.map((g) => g.rsid);

    // Create parameterized query
    const placeholders = rsids.map(() => "?").join(",");
    const query = `SELECT ${SNP_COLUMNS} FROM snps WHERE rsid IN (${placeholders})`;

    try {
      const stmt = database.prepare(query);
      stmt.bind(rsids);

      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as SNPRecord;
        const userGenotype = batch.find((g) => g.rsid === row.rsid);

        if (userGenotype) {
          matches.push({
            ...userGenotype,
            snpData: row,
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
      const response = await fetch(dbPath);
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
