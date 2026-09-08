import { expose } from "comlink";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";
import type { UserGenotype, MatchedSNP, ParseResult, GenosetRecord, MatchedGenoset, SNPRecord } from "../types/snp";
import { parserRegistry } from "../parsers";
import { parseFileWithDetection, parseFileBlobWithDetection } from "./fileParsing";
import { extractSnpediaFields } from "../utils/snpediaFields";
import { matchSNPsInBatches } from "./snpMatching";
import { searchSNPs, type SNPSearchFilters } from "./snpSearch";
import { prepareReferenceColumns } from "./referenceColumns";
import { ReferenceStore } from "./referenceStore";
import { mergeReferenceMatches } from "./referenceMatching";
import type { ReferenceDownloadProgress } from "../types/annotations";
import type { ReferenceLocation } from "./referenceQueries";
import { analyzeTraits } from "../utils/traitAnalysis";
import { buildSnpediaGeneHints } from "./snpediaGeneHints";

let sqlModulePromise: Promise<SqlJsStatic> | null = null;
function getSqlModule(): Promise<SqlJsStatic> {
  sqlModulePromise ??= initSqlJs({ locateFile: (file) => (file.endsWith(".wasm") ? sqlWasmUrl : file) });
  return sqlModulePromise;
}
const referenceStore = new ReferenceStore(async (bytes) => new (await getSqlModule()).Database(bytes));
let referenceInitialization: Promise<unknown> | undefined;

/**
 * Worker state - holds the loaded database
 */
let db: Database | null = null;
let snpsTableColumns = new Set<string>();

const DB_CACHE_NAME = "snp-browser-db-v1";
function loadTableColumns(database: Database, tableName: "snps"): Set<string> {
  const columns = new Set<string>();
  const stmt = database.prepare(`PRAGMA table_info(${tableName})`);

  while (stmt.step()) {
    const row = stmt.getAsObject();
    if (typeof row.name === "string") {
      columns.add(row.name);
    }
  }

  stmt.free();
  return columns;
}

async function readCachedDatabase(dbPath: string): Promise<Uint8Array | null> {
  if (!("caches" in globalThis)) {
    return null;
  }

  try {
    const cache = await caches.open(DB_CACHE_NAME);
    const cachedResponse = await cache.match(dbPath);
    if (!cachedResponse?.ok) {
      return null;
    }

    return new Uint8Array(await cachedResponse.arrayBuffer());
  } catch (error) {
    console.warn("Unable to read cached database:", error);
    return null;
  }
}

async function writeDatabaseCache(dbPath: string, dbBuffer: Uint8Array): Promise<void> {
  if (!("caches" in globalThis)) {
    return;
  }

  const cacheBuffer = dbBuffer.buffer.slice(
    dbBuffer.byteOffset,
    dbBuffer.byteOffset + dbBuffer.byteLength,
  ) as ArrayBuffer;

  try {
    const cache = await caches.open(DB_CACHE_NAME);
    await cache.put(dbPath, new Response(cacheBuffer, { headers: { "content-type": "application/vnd.sqlite3" } }));
  } catch (error) {
    console.warn("Unable to cache database:", error);
  }
}

async function fetchDatabase(dbPath: string, onProgress: (progress: number) => void): Promise<Uint8Array> {
  const cachedDatabase = await readCachedDatabase(dbPath);
  if (cachedDatabase) {
    onProgress(85);
    return cachedDatabase;
  }

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
      // Progress from 30% to 80% during download.
      const downloadProgress = 30 + (receivedLength / total) * 50;
      onProgress(downloadProgress);
    }
  }

  onProgress(85);

  const dbBuffer = new Uint8Array(receivedLength);
  let position = 0;
  for (const chunk of chunks) {
    dbBuffer.set(chunk, position);
    position += chunk.length;
  }

  void writeDatabaseCache(dbPath, dbBuffer);

  return dbBuffer;
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
        const snpediaFields = extractSnpediaFields(genoset.content);

        matchedGenosets.push({
          genoset,
          matchedGenotypes: matchingGenotypes,
          parsedData: {
            id: genoset.id,
            rawContent: genoset.content,
            magnitude: snpediaFields.magnitude,
            repute: snpediaFields.repute,
            summary: snpediaFields.summary,
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
    const result = await parseFileWithDetection(fileContent, onProgress, parserId);
    result.traits = analyzeTraits(result.genotypes);
    return result;
  },

  /**
   * Parses a DNA file Blob. VCF/gVCF files are streamed in the worker so large files
   * do not need to be read into one main-thread string before parsing.
   */
  async parseFileBlob(
    file: File,
    onProgress: (current: number, total: number) => void,
    parserId?: string,
  ): Promise<ParseResult & { detectedFormat?: string }> {
    const result = await parseFileBlobWithDetection(file, onProgress, parserId);
    result.traits = analyzeTraits(result.genotypes);
    return result;
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
      const SQL = await getSqlModule();

      onProgress(30);

      const dbBuffer = await fetchDatabase(dbPath, onProgress);

      onProgress(90);

      // Create database instance
      db = new SQL.Database(dbBuffer);
      snpsTableColumns = loadTableColumns(db, "snps");
      prepareReferenceColumns(db, snpsTableColumns);

      onProgress(100);
    } catch (error) {
      db = null;
      snpsTableColumns = new Set<string>();
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
    await referenceInitialization?.catch(() => undefined);
    const snpediaMatches = db
      ? await matchSNPsInBatches(db, snpsTableColumns, genotypes, (current, total) =>
          onProgress(Math.round((current / Math.max(total, 1)) * genotypes.length * 0.7), genotypes.length),
        )
      : [];
    const { summaries } = await referenceStore.match(
      genotypes,
      (current, total) =>
        onProgress(Math.round(genotypes.length * (0.7 + (0.3 * current) / Math.max(total, 1))), genotypes.length),
      true,
      buildSnpediaGeneHints(snpediaMatches),
    );
    onProgress(genotypes.length, genotypes.length);
    return mergeReferenceMatches(genotypes, snpediaMatches, summaries);
  },

  /**
   * Matches genosets based on matched SNPs
   */
  async matchGenosets(
    matchedSNPs: MatchedSNP[],
    onProgress: (current: number, total: number) => void,
  ): Promise<MatchedGenoset[]> {
    if (!db) return [];

    return matchGenosets(db, matchedSNPs, onProgress);
  },

  /**
   * Search/browse SNPs with filtering
   */
  async searchSNPs(filters: SNPSearchFilters): Promise<{ results: SNPRecord[]; total: number }> {
    if (filters.referencePackId) {
      const page = await referenceStore.search(filters.referencePackId, filters);
      const pack = referenceStore.getStates().find((state) => state.pack.id === filters.referencePackId)?.pack;
      return {
        total: page.total,
        results: page.annotations.map((annotation) => ({
          rsid:
            annotation.rsid ||
            (annotation.chromosome && annotation.position
              ? `${annotation.chromosome}:${annotation.position}${annotation.alt ? ` ${annotation.ref || "?"}>${annotation.alt}` : ""}`
              : annotation.gene || annotation.id),
          referenceKey: `${annotation.source}:${annotation.id}`,
          referenceSource: annotation.source,
          sourceUrl: annotation.url,
          content: annotation.summary || annotation.title,
          gene: annotation.gene,
          chromosome: annotation.chromosome,
          position: annotation.position?.toString(),
          annotations: [
            {
              ...annotation,
              fields: {
                ...annotation.fields,
                sourceVersion: pack?.version ?? "",
                referenceBuiltAt: pack?.builtAt ?? "",
                upstreamRelease: pack?.sourceRelease ?? null,
              },
              matchType: annotation.scope === "gene" ? ("gene" as const) : ("locus" as const),
              matchReason: "Reference evidence; no uploaded genotype is being interpreted here.",
            },
          ],
        })),
      };
    }
    if (!filters.referenceExport) referenceStore.cancelSearch();
    if (!db) throw new Error("Database not loaded. Call loadDatabase first.");
    return searchSNPs(db, snpsTableColumns, filters);
  },

  async initializeReferenceCatalog(manifestUrl: string) {
    const initialization = referenceStore.initialize(manifestUrl);
    referenceInitialization = initialization;
    return initialization;
  },
  getReferenceStates() {
    return referenceStore.getStates();
  },
  async downloadReferencePack(packId: string, onProgress: (progress: ReferenceDownloadProgress) => void) {
    return referenceStore.download(packId, onProgress);
  },
  async removeReferencePack(packId: string) {
    return referenceStore.remove(packId);
  },
  async clearReferencePacks() {
    return referenceStore.clear();
  },
  cancelReferenceSearch(searchId?: string) {
    referenceStore.cancelSearch(searchId);
  },
  async setReferenceEnabled(packId: string, enabled: boolean) {
    return referenceStore.setEnabled(packId, enabled);
  },
  async getReferenceAnnotations(rsid: string, location?: ReferenceLocation) {
    return referenceStore.lookup(rsid, location);
  },
  async getMatchedAnnotations(user: UserGenotype | MatchedSNP, ambiguous = false) {
    const { evidence } = await referenceStore.match([user], () => undefined, false, buildSnpediaGeneHints([user]));
    const entries = evidence.get(user.rsid.toLowerCase()) ?? [];
    return ambiguous
      ? entries.map((annotation) => ({
          ...annotation,
          matchType: "unresolved" as const,
          matchReason: "This file contains conflicting calls or coordinates for the same variant.",
        }))
      : entries;
  },
};

export type SNPMatcherWorkerApi = typeof workerApi;

// Expose the API to Comlink
expose(workerApi);
