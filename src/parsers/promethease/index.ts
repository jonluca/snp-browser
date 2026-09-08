import type { DNAParser, ParserMetadata, ProgressCallback, ValidationResult } from "../types";
import type { ImportedReport, ParseResult, UserGenotype } from "../../types/snp";
import { normalizeAssembly } from "../../utils/variantIdentity";

const METADATA: ParserMetadata = {
  id: "promethease",
  name: "Promethease",
  description: "Promethease HTML report with embedded personal genotypes",
  version: "1.0.0",
  fileExtensions: [".html", ".htm"],
  providerUrl: "https://promethease.com",
};

const MAX_DATA_BYTES = 256 * 1024 * 1024;
const ENTRIES_PER_PAGE = 100;
const COMPRESSED_CALLS =
  /\bmygenos\s*\.\s*push\s*\.\s*apply\s*\(\s*mygenos\s*,\s*decompressString\s*\(\s*(["'])([A-Za-z0-9+/=\s]+)\1\s*\)\s*\)/g;
const CALLS_ASSIGNMENT = /\b(?:var|let|const)\s+mygenos\s*=\s*(\[)/;

type ReportEntry = Record<string, unknown>;

/** Decode presentation markup as text. Imported HTML is never inserted into a document. */
function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
  };
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (!code.startsWith("#")) return entities[code.toLowerCase()] ?? entity;
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "";
    })
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}

/** Extract only a JSON array literal; do not evaluate the surrounding JavaScript. */
function initialCallArray(content: string): { value: unknown; end: number } | undefined {
  const match = CALLS_ASSIGNMENT.exec(content);
  if (!match) return undefined;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < content.length; index++) {
    const character = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "[") depth++;
    else if (character === "]" && --depth === 0) {
      try {
        return { value: JSON.parse(content.slice(start, index + 1)), end: index + 1 };
      } catch {
        throw new Error("Promethease personal genotypes must be stored as JSON data.");
      }
    }
  }
  throw new Error("The Promethease personal genotype data is incomplete.");
}

async function decompressCalls(encoded: string, remainingBytes: number): Promise<{ value: unknown; bytes: number }> {
  const binary = atob(encoded.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > remainingBytes) {
        await reader.cancel();
        throw new Error("Promethease report data exceeds the supported 256 MB expanded size.");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { value: JSON.parse(chunks.join("")), bytes: count };
  } finally {
    reader.releaseLock();
  }
}

function parseCall(entry: ReportEntry): UserGenotype | undefined {
  if (typeof entry.rsnum !== "string" || !/^(?:rs|i)\d+$/i.test(entry.rsnum)) return undefined;
  // `was` is the person's input call, while `geno` is oriented for SNPedia.
  // Positions/orientations on these records describe the annotation and must
  // not be combined with the original input's reference build.
  const original = typeof entry.was === "string";
  const value = original ? entry.was : entry.geno;
  if (typeof value !== "string") return undefined;
  const match = /^\(\s*([ACGTID-]+)\s*;\s*([ACGTID-]+)\s*\)$/i.exec(value);
  if (!match) return undefined;
  const alleles = [match[1].toLowerCase(), match[2].toLowerCase()];
  // A pair of dashes in a display genotype can mean either a deletion or a
  // no-call. Keep it in report text unless an explicit original call resolves it.
  if (alleles.every((allele) => allele === "-")) return undefined;
  const isSnp = alleles.every((allele) => /^[acgt]$/.test(allele));
  const assembly = original
    ? normalizeAssembly(typeof entry.reference === "number" ? `GRCh${entry.reference}` : entry.reference)
    : undefined;
  return {
    rsid: entry.rsnum.toLowerCase(),
    chromosome: "",
    position: "",
    genotype: isSnp ? alleles.join("") : alleles.join("/"),
    ...(isSnp ? {} : { alleles }),
    ...(assembly ? { assembly } : {}),
    strand: "unknown",
  };
}

function entryText(entry: ReportEntry): string {
  const title = plainText(entry.rsnum) || plainText(entry.title) || "Report entry";
  const lines = [title];
  if (typeof entry.was === "string") lines.push(`Original genotype: ${plainText(entry.was)}`);
  if (typeof entry.geno === "string") lines.push(`Report genotype: ${plainText(entry.geno)}`);
  if (typeof entry.reference === "string" || typeof entry.reference === "number") {
    lines.push(`Reported input build: ${String(entry.reference)}`);
  }
  if (typeof entry.magnitude === "number") lines.push(`Report magnitude: ${entry.magnitude}`);
  if (typeof entry.repute === "string") lines.push(`Report classification: ${plainText(entry.repute)}`);
  for (const key of ["genosummary", "genobody", "rstext"]) {
    const text = plainText(entry[key]);
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

export class PrometheaseParser implements DNAParser {
  readonly metadata = METADATA;

  validate(content: string): ValidationResult {
    // Embedded data can occur well past the first page of an HTML report.
    const valid = /promethease/i.test(content) && CALLS_ASSIGNMENT.test(content);
    return {
      valid,
      confidence: valid ? 1 : 0,
      detectedFormat: valid ? METADATA.id : undefined,
      reason: valid ? "Promethease report with embedded personal genotype data" : "No Promethease personal data found",
    };
  }

  async parse(content: string, onProgress: ProgressCallback): Promise<ParseResult> {
    const initial = initialCallArray(content);
    if (!initial || !/promethease/i.test(content))
      throw new Error("No embedded Promethease personal genotype data was found.");
    if (content.length > MAX_DATA_BYTES) throw new Error("Promethease report exceeds the supported 256 MB size.");
    const genotypes: UserGenotype[] = [];
    const seen = new Set<string>();
    const pages: ImportedReport["pages"] = [];
    let pageEntries: string[] = [];
    let recordCount = 0;
    let genosets = 0;
    let skipped = 0;
    let duplicateCalls = 0;
    let dataBytes = initial.end;
    const flushPage = () => {
      if (!pageEntries.length) return;
      pages.push({ page: pages.length + 1, text: pageEntries.join("\n\n") });
      pageEntries = [];
    };
    const consume = (value: unknown) => {
      if (!Array.isArray(value))
        throw new Error("Promethease personal genotype data must contain an array of records.");
      for (const record of value) {
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          throw new Error("The Promethease personal genotype data contains an invalid record.");
        }
        const entry = record as ReportEntry;
        recordCount++;
        if (typeof entry.title === "string" && /^gs\d+$/i.test(entry.title)) genosets++;
        pageEntries.push(entryText(entry));
        if (pageEntries.length >= ENTRIES_PER_PAGE) flushPage();
        const call = parseCall(entry);
        if (!call) {
          skipped++;
          continue;
        }
        const identity = JSON.stringify([call.rsid, call.genotype, call.assembly, call.alleles]);
        if (seen.has(identity)) {
          duplicateCalls++;
          skipped++;
          continue;
        }
        seen.add(identity);
        genotypes.push(call);
      }
    };
    onProgress(0, content.length);
    consume(initial.value);
    // Match only personal-data append statements. `rsinfo`, prose, genosets,
    // and comparison/example genotypes are never mined for variant calls.
    for (const match of content.matchAll(COMPRESSED_CALLS)) {
      let decompressed;
      try {
        decompressed = await decompressCalls(match[2], MAX_DATA_BYTES - dataBytes);
      } catch (error) {
        throw new Error(
          `Could not decode Promethease personal genotype data: ${error instanceof Error ? error.message : "invalid payload"}`,
          { cause: error },
        );
      }
      dataBytes += decompressed.bytes;
      consume(decompressed.value);
      onProgress(match.index + match[0].length, content.length);
    }
    if (!recordCount) throw new Error("The Promethease report contains no readable personal genotype records.");
    flushPage();
    onProgress(content.length, content.length);
    const notes = [
      `${recordCount.toLocaleString("en-US")} report entries; ${genotypes.length.toLocaleString("en-US")} distinct personal genotype calls imported.`,
      "Only genotypes explicitly stored in the report's personal data are imported. Literature examples and comparison genotypes are excluded.",
      "Report annotations are preserved as text from the original report. They have not been reclassified or verified against current references.",
      "Report annotation coordinates and strand are not treated as original input coordinates. New allele interpretations require an original raw DNA file.",
    ];
    if (genosets)
      notes.push(
        `${genosets.toLocaleString("en-US")} genoset summaries are preserved as report text, not individual genotype calls.`,
      );
    if (duplicateCalls) notes.push(`${duplicateCalls.toLocaleString("en-US")} repeated personal calls were combined.`);
    const assemblies = new Set(genotypes.map((call) => call.assembly));
    return {
      genotypes,
      totalLines: recordCount,
      skippedLines: skipped,
      errors: [],
      ...(assemblies.size === 1 && genotypes[0]?.assembly ? { assembly: genotypes[0].assembly } : {}),
      report: { format: "promethease", title: "Promethease report", pages, notes },
    };
  }
}

export default new PrometheaseParser();
