import { expose } from "comlink";
import initSqlJs, { type Database } from "sql.js";
import type { UserGenotype, MatchedSNP, SNPRecord } from "../types/snp";

/**
 * Worker state - holds the loaded database
 */
let db: Database | null = null;

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
    const query = `SELECT rsid, content, scraped_at, attribution FROM snps WHERE rsid IN (${placeholders})`;

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
};

export type SNPMatcherWorkerApi = typeof workerApi;

// Expose the API to Comlink
expose(workerApi);
