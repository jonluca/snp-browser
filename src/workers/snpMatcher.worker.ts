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
import { parserRegistry, parserVCF } from "../parsers";
import { extractSnpediaFields, type SnpediaSourceFields } from "../utils/snpediaFields";

/**
 * Worker state - holds the loaded database
 */
let db: Database | null = null;
let snpsTableColumns = new Set<string>();

const DB_CACHE_NAME = "snp-browser-db-v1";
const OPTIONAL_SNP_COLUMNS = ["gene", "gene_s", "clin_gene_name", "clin_sig", "clin_disease"] as const;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_STORED_METHOD = 0;
const ZIP_DEFLATE_METHOD = 8;

interface ZipEntry {
  filename: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

type OptionalSnpColumn = (typeof OPTIONAL_SNP_COLUMNS)[number];

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

function hasSnpColumn(column: string): boolean {
  return snpsTableColumns.has(column);
}

function selectOptionalSnpColumn(column: OptionalSnpColumn): string {
  return hasSnpColumn(column) ? column : `NULL as ${column}`;
}

function selectOptionalJoinedSnpColumn(column: OptionalSnpColumn, alias: string): string {
  return hasSnpColumn(column) ? `s.${column} as ${alias}` : `NULL as ${alias}`;
}

function getSnpSelectColumns(): string {
  return [
    "rsid",
    "content",
    "scraped_at",
    ...OPTIONAL_SNP_COLUMNS.map((column) => selectOptionalSnpColumn(column)),
  ].join(", ");
}

function getGenotypeJoinColumns(): string {
  return [
    "g.id as genotype_id",
    "g.content as genotype_content",
    "g.scraped_at as genotype_scraped_at",
    "g.snp_id",
    "g.genotype",
    "s.rsid",
    "s.content as snp_content",
    "s.scraped_at as snp_scraped_at",
    selectOptionalJoinedSnpColumn("gene", "snp_gene"),
    selectOptionalJoinedSnpColumn("gene_s", "snp_gene_s"),
    selectOptionalJoinedSnpColumn("clin_gene_name", "snp_clin_gene_name"),
    selectOptionalJoinedSnpColumn("clin_sig", "snp_clin_sig"),
    selectOptionalJoinedSnpColumn("clin_disease", "snp_clin_disease"),
  ].join(",\n  ");
}

function bindLikeCondition(conditions: string[], params: (string | number)[], columns: string[], value: string): void {
  const existingColumns = columns.filter((column) => hasSnpColumn(column));
  if (existingColumns.length === 0) return;

  conditions.push(`(${existingColumns.map((column) => `${column} LIKE ?`).join(" OR ")})`);
  params.push(...existingColumns.map(() => value));
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
function parseContentData(
  rsid: string,
  snpContent: string,
  genotypeContent?: string,
  snpFields: SnpediaSourceFields = {},
): ParsedSNPData {
  const snpSnpediaFields = extractSnpediaFields(snpContent, snpFields);
  const genotypeSnpediaFields = genotypeContent ? extractSnpediaFields(genotypeContent) : {};
  const { orientation, stabilizedOrientation } = parseOrientationFromContent(snpContent);

  return {
    rsid,
    rawContent: snpContent,
    genotypeContent,
    geneSymbol: snpSnpediaFields.geneSymbol ?? genotypeSnpediaFields.geneSymbol,
    magnitude: genotypeSnpediaFields.magnitude ?? snpSnpediaFields.magnitude,
    repute: genotypeSnpediaFields.repute ?? snpSnpediaFields.repute,
    summary: genotypeSnpediaFields.summary ?? snpSnpediaFields.summary,
    orientation,
    stabilizedOrientation,
  };
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
      SELECT ${getGenotypeJoinColumns()}
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
          const snpFields = {
            gene: row.snp_gene,
            gene_s: row.snp_gene_s,
            clin_gene_name: row.snp_clin_gene_name,
            clin_sig: row.snp_clin_sig,
            clin_disease: row.snp_clin_disease,
          };
          const parsedData = parseContentData(rsid, snpContent, genotypeContent, snpFields);

          matches.push({
            ...userGenotype,
            snpData: {
              rsid,
              content: snpContent,
              scraped_at: row.snp_scraped_at as string | undefined,
              gene: row.snp_gene as string | undefined,
              gene_s: row.snp_gene_s as string | undefined,
              clin_gene_name: row.snp_clin_gene_name as string | undefined,
              clin_sig: row.snp_clin_sig as string | undefined,
              clin_disease: row.snp_clin_disease as string | undefined,
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

function isVcfLikeFilename(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  return (
    lowerFilename.endsWith(".vcf") ||
    lowerFilename.endsWith(".gvcf") ||
    lowerFilename.endsWith(".g.vcf") ||
    lowerFilename.endsWith(".vcf.gz") ||
    lowerFilename.endsWith(".g.vcf.gz") ||
    (lowerFilename.endsWith(".gz") && lowerFilename.includes("vcf"))
  );
}

function isZipFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".zip");
}

function isSupportedArchiveEntry(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  if (lowerFilename.endsWith(".zip")) return false;
  if (isVcfLikeFilename(lowerFilename)) return true;

  return parserRegistry.getSupportedExtensions().some((extension) => lowerFilename.endsWith(extension));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readZipEntries(buffer: ArrayBuffer): ZipEntry[] {
  const data = new DataView(buffer);
  const maxCommentLength = 0xffff;
  const minEndRecordSize = 22;
  const searchStart = Math.max(0, data.byteLength - minEndRecordSize - maxCommentLength);
  let endRecordOffset = -1;

  for (let offset = data.byteLength - minEndRecordSize; offset >= searchStart; offset--) {
    if (data.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      endRecordOffset = offset;
      break;
    }
  }

  if (endRecordOffset < 0) {
    throw new Error("Could not read ZIP archive directory.");
  }

  const entryCount = data.getUint16(endRecordOffset + 10, true);
  let centralDirectoryOffset = data.getUint32(endRecordOffset + 16, true);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index++) {
    if (data.getUint32(centralDirectoryOffset, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("ZIP archive directory is invalid.");
    }

    const compressionMethod = data.getUint16(centralDirectoryOffset + 10, true);
    const compressedSize = data.getUint32(centralDirectoryOffset + 20, true);
    const filenameLength = data.getUint16(centralDirectoryOffset + 28, true);
    const extraLength = data.getUint16(centralDirectoryOffset + 30, true);
    const commentLength = data.getUint16(centralDirectoryOffset + 32, true);
    const localHeaderOffset = data.getUint32(centralDirectoryOffset + 42, true);
    const filenameStart = centralDirectoryOffset + 46;
    const filenameBytes = new Uint8Array(buffer, filenameStart, filenameLength);
    const filename = new TextDecoder().decode(filenameBytes);

    if (!filename.endsWith("/")) {
      entries.push({
        filename,
        compressionMethod,
        compressedSize,
        localHeaderOffset,
      });
    }

    centralDirectoryOffset = filenameStart + filenameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(compressedData: Uint8Array): Promise<Uint8Array> {
  if (!("DecompressionStream" in globalThis)) {
    throw new Error("Compressed ZIP entries are not supported in this browser.");
  }

  const stream = new Blob([bytesToArrayBuffer(compressedData)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(buffer: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const data = new DataView(buffer);
  if (data.getUint32(entry.localHeaderOffset, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`ZIP entry "${entry.filename}" has an invalid local header.`);
  }

  const filenameLength = data.getUint16(entry.localHeaderOffset + 26, true);
  const extraLength = data.getUint16(entry.localHeaderOffset + 28, true);
  const dataStart = entry.localHeaderOffset + 30 + filenameLength + extraLength;
  const compressedData = new Uint8Array(buffer, dataStart, entry.compressedSize);

  if (entry.compressionMethod === ZIP_STORED_METHOD) {
    return compressedData;
  }

  if (entry.compressionMethod === ZIP_DEFLATE_METHOD) {
    return inflateRaw(compressedData);
  }

  throw new Error(`ZIP entry "${entry.filename}" uses unsupported compression method ${entry.compressionMethod}.`);
}

async function extractSupportedFileFromZip(file: File): Promise<File> {
  const buffer = await file.arrayBuffer();
  const entries = readZipEntries(buffer);
  const entry = entries.find((candidate) => isSupportedArchiveEntry(candidate.filename));

  if (!entry) {
    throw new Error("No supported DNA data file was found inside the ZIP archive.");
  }

  const entryBytes = await readZipEntry(buffer, entry);
  return new File([bytesToArrayBuffer(entryBytes)], entry.filename);
}

async function parseFileBlobWithDetection(
  file: File,
  onProgress: (current: number, total: number) => void,
  parserId?: string,
): Promise<ParseResult & { detectedFormat?: string }> {
  if (!parserId && isZipFilename(file.name)) {
    return parseFileBlobWithDetection(await extractSupportedFileFromZip(file), onProgress);
  }

  if (parserId === parserVCF.metadata.id || (!parserId && isVcfLikeFilename(file.name))) {
    const result = await parserVCF.parseBlob(file, onProgress);
    return {
      ...result,
      detectedFormat: parserVCF.metadata.id,
    };
  }

  return parseFileWithDetection(await file.text(), onProgress, parserId);
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
    return parseFileWithDetection(fileContent, onProgress, parserId);
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
    return parseFileBlobWithDetection(file, onProgress, parserId);
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

      const dbBuffer = await fetchDatabase(dbPath, onProgress);

      onProgress(90);

      // Create database instance
      db = new SQL.Database(dbBuffer);
      snpsTableColumns = loadTableColumns(db, "snps");

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
      bindLikeCondition(
        conditions,
        params,
        ["rsid", "gene", "gene_s", "content", "clin_disease", "clin_gene_name"],
        term,
      );
    }

    // Chromosome filter
    if (filters.chromosome) {
      if (hasSnpColumn("chromosome")) {
        conditions.push("chromosome = ?");
        params.push(filters.chromosome);
      } else {
        conditions.push("0 = 1");
      }
    }

    // Gene filter
    if (filters.gene && filters.gene.trim()) {
      const geneTerm = `%${filters.gene.trim()}%`;
      const geneColumns = ["gene", "gene_s", "clin_gene_name"].filter((column) => hasSnpColumn(column));
      bindLikeCondition(conditions, params, geneColumns.length > 0 ? geneColumns : ["content"], geneTerm);
    }

    // Clinical significance filter
    if (filters.clinicalSignificance) {
      const clinicalSignificanceTerm = `%${filters.clinicalSignificance}%`;
      bindLikeCondition(
        conditions,
        params,
        hasSnpColumn("clin_sig") ? ["clin_sig"] : ["content"],
        clinicalSignificanceTerm,
      );
    }

    // Disease filter
    if (filters.disease && filters.disease.trim()) {
      const diseaseTerm = `%${filters.disease.trim()}%`;
      bindLikeCondition(conditions, params, hasSnpColumn("clin_disease") ? ["clin_disease"] : ["content"], diseaseTerm);
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
    const query = `SELECT ${getSnpSelectColumns()} FROM snps ${whereClause} LIMIT ? OFFSET ?`;

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
