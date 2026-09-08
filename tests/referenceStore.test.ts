import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import type { ReferenceManifest, ReferencePack, ReferenceShard, VariantAnnotation } from "../src/types/annotations";
import type { UserGenotype } from "../src/types/snp";
import { ReferenceStore } from "../src/workers/referenceStore";
import { referenceCacheKey, REFERENCE_CACHE } from "../src/workers/referenceCache";
import { validateReferenceManifest } from "../src/workers/referenceManifest";
import { mergeReferenceMatches } from "../src/workers/referenceMatching";
import { prepareReferenceKeys, referenceLookupKeys } from "../src/workers/referenceRouting";
import { MAX_REFERENCE_EXPORT_ROWS } from "../src/workers/snpSearch";
import parserVCF from "../src/parsers/vcf";

let SQL: SqlJsStatic;
const originalFetch = globalThis.fetch;
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
const catalogUrl = "https://reference.test/manifest.json";
let requests: string[];
let responses: Map<string, Response>;
let cacheMaps: Map<string, Map<string, Response>>;
let beforeCachePut: ((cacheName: string, key: string) => Promise<void>) | undefined;
let beforeCacheMatch: ((cacheName: string, key: string) => Promise<void>) | undefined;

beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(() => {
  requests = [];
  responses = new Map();
  cacheMaps = new Map();
  beforeCachePut = undefined;
  beforeCacheMatch = undefined;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async (name: string) => {
        const entries = cacheMaps.get(name) ?? new Map<string, Response>();
        cacheMaps.set(name, entries);
        const key = (input: RequestInfo | URL) => new Request(input).url;
        return {
          match: async (input: RequestInfo | URL) => {
            await beforeCacheMatch?.(name, key(input));
            return entries.get(key(input))?.clone();
          },
          put: async (input: RequestInfo | URL, response: Response) => {
            await beforeCachePut?.(name, key(input));
            entries.set(key(input), response.clone());
          },
          delete: async (input: RequestInfo | URL) => entries.delete(key(input)),
        };
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new Request(input).url;
    requests.push(url);
    const response = responses.get(url);
    if (!response) throw new Error("Network unavailable");
    return response.clone();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
  else Reflect.deleteProperty(globalThis, "caches");
});

function annotation(id: string, rsid: string, overrides: Partial<VariantAnnotation> = {}): VariantAnnotation {
  return {
    id,
    rsid,
    source: "clinvar",
    assembly: "GRCh38",
    chromosome: "1",
    position: 100,
    ref: "A",
    alt: "G",
    gene: "TEST1",
    scope: "allele",
    title: `Reference ${rsid}`,
    url: "https://www.ncbi.nlm.nih.gov/clinvar/",
    fields: { clinicalSignificance: "Uncertain significance" },
    ...overrides,
  };
}

async function pack(
  id: string,
  pages: VariantAnnotation[][],
  aliases: Array<[string, string]> = [],
): Promise<ReferencePack> {
  const shards = [];
  for (const [index, annotations] of pages.entries()) {
    const database = new SQL.Database();
    database.run(
      "CREATE TABLE annotations (id TEXT PRIMARY KEY, rsid TEXT, assembly TEXT, chromosome TEXT, position INTEGER, ref TEXT, alt TEXT, gene TEXT, scope TEXT, source TEXT, title TEXT, search_text TEXT, payload TEXT)",
    );
    database.run("CREATE TABLE aliases (alias TEXT, rsid TEXT)");
    for (const [alias, rsid] of aliases) database.run("INSERT INTO aliases VALUES (?, ?)", [alias, rsid]);
    const insert = database.prepare("INSERT INTO annotations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of annotations)
      insert.run([
        row.id,
        row.rsid ?? null,
        row.assembly ?? null,
        row.chromosome ?? null,
        row.position ?? null,
        row.ref ?? null,
        row.alt ?? null,
        row.gene ?? null,
        row.scope,
        row.source,
        row.title,
        JSON.stringify(row),
        JSON.stringify(row),
      ]);
    insert.free();
    const bytes = database.export();
    database.close();
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const url = `https://reference.test/${id}/${index}.sqlite`;
    responses.set(url, new Response(bytes));
    shards.push({ url, bytes: bytes.length, sha256, records: annotations.length });
  }
  return {
    id,
    source: pages[0][0].source,
    name: id,
    description: "Synthetic regression fixture",
    version: "v1",
    builtAt: "2026-09-07T00:00:00Z",
    homepage: "https://reference.test/",
    license: "Test fixture",
    licenseUrl: "https://reference.test/license",
    attribution: "Synthetic test data",
    coverage: "Synthetic fixture",
    recordCount: pages.flat().length,
    shards,
  };
}

function serveCatalog(packs: ReferencePack[]): ReferenceManifest {
  const manifest: ReferenceManifest = { schemaVersion: 1, createdAt: "2026-09-07T00:00:00Z", packs };
  responses.set(catalogUrl, new Response(JSON.stringify(manifest)));
  return manifest;
}
function store(opened?: string[][]) {
  return new ReferenceStore(async (bytes) => {
    const database = new SQL.Database(bytes);
    if (opened)
      opened.push(
        database.exec("SELECT id FROM annotations ORDER BY id")[0]?.values.map((row) => String(row[0])) ?? [],
      );
    return database;
  });
}

function routing(keys: string[]): NonNullable<ReferenceShard["routing"]> {
  // Hash compatibility is covered independently by the Python golden fixture;
  // this helper equips real SQLite regression fixtures with lookup metadata.
  const prepared = prepareReferenceKeys(keys);
  const bits = new Uint8Array(128);
  for (let index = 0; index < keys.length; index++) {
    const first = prepared.hashes[index * 2];
    const second = prepared.hashes[index * 2 + 1];
    for (let hash = 0; hash < 7; hash++) {
      const bit = ((first + hash * second) >>> 0) % 1024;
      bits[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return { algorithm: "fnv1a-double-v1", hashes: 7, bitCount: 1024, bits: Buffer.from(bits).toString("base64") };
}

function addRouting(source: ReferencePack, pages: VariantAnnotation[][]): void {
  for (const [index, rows] of pages.entries()) {
    source.shards[index].routing = routing(
      rows.flatMap((row) => [
        ...referenceLookupKeys(row.rsid, row, row.gene ? [row.gene] : []),
        ...(row.aliases ?? []).flatMap((alias) => referenceLookupKeys(alias)),
      ]),
    );
  }
}
const user: UserGenotype = {
  rsid: "rs123",
  chromosome: "1",
  position: "100",
  genotype: "AG",
  assembly: "GRCh38",
  strand: "plus",
};

test("reference downloads persist selection separately from the manifest and matching uses no network", async () => {
  const source = await pack("clinvar", [[annotation("one", "rs123")]]);
  serveCatalog([source]);
  const first = store();
  expect((await first.initialize(catalogUrl))[0].enabled).toBe(false);
  await first.download("clinvar", () => undefined);
  responses.clear();
  const offline = store();
  expect((await offline.initialize(catalogUrl))[0]).toMatchObject({ enabled: true, status: "ready" });
  requests = [];
  const result = await offline.match([user], () => undefined);
  expect(result.evidence.get("rs123")?.[0].matchType).toBe("allele");
  expect(result.summaries.get("rs123")?.alleleCount).toBe(1);
  expect(requests).toEqual([]);
  await offline.remove("clinvar");
  expect(offline.getStates()[0]).toMatchObject({ status: "available", enabled: false, downloadedBytes: 0 });
  expect((await offline.match([user], () => undefined)).evidence.size).toBe(0);
});

test("merged dbSNP identifiers resolve into other sources and gene evidence remains context", async () => {
  const dbsnp = await pack(
    "dbsnp",
    [[annotation("db", "rs123", { source: "dbsnp", scope: "variant" })]],
    [["rs99", "rs123"]],
  );
  const clinvar = await pack("clinvar", [[annotation("cv", "rs123")]]);
  const cpic = await pack("cpic", [[annotation("pgx", "", { source: "cpic", scope: "gene", alt: undefined })]]);
  serveCatalog([clinvar, dbsnp, cpic]);
  const references = store();
  await references.initialize(catalogUrl);
  for (const source of [clinvar, dbsnp, cpic]) await references.download(source.id, () => undefined);
  requests = [];
  const result = await references.match([{ ...user, rsid: "rs99" }], () => undefined);
  expect(result.evidence.get("rs99")?.map((row) => [row.source, row.matchType])).toEqual([
    ["clinvar", "allele"],
    ["dbsnp", "locus"],
    ["cpic", "gene"],
  ]);
  expect((await references.lookup("rs99")).map((row) => row.source)).toEqual(["clinvar", "dbsnp", "cpic"]);
  expect(requests).toEqual([]);
});

test("large result summaries omit annotation bodies and expand coverage beyond SNPedia", async () => {
  const source = await pack("clinvar", [
    [annotation("one", "rs123"), annotation("two", "rs123", { title: "Another condition" })],
  ]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const { evidence, summaries } = await references.match([user], () => undefined, true);
  expect(evidence.size).toBe(0);
  expect(summaries.get("rs123")).toMatchObject({ sources: ["clinvar"], count: 2, alleleCount: 2 });
  const merged = mergeReferenceMatches([user], [], summaries);
  expect(merged).toHaveLength(1);
  expect(merged[0].snpData.referenceSource).toBe("references");
  expect(merged[0].genotypeData).toBeUndefined();
  expect(merged[0].annotations).toBeUndefined();
  expect(merged[0].annotationSummary?.count).toBe(2);
});

test("conflicting calls and unknown builds cannot become confirmed allele summaries", async () => {
  const source = await pack("clinvar", [[annotation("one", "rs123")]]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const conflicting = await references.match([user, { ...user, genotype: "AA" }], () => undefined);
  expect(conflicting.summaries.get("rs123")).toMatchObject({ ambiguous: true, alleleCount: 0, unresolvedCount: 1 });
  expect(conflicting.evidence.get("rs123")?.[0].matchType).toBe("unresolved");
  const unknown = await references.match([{ ...user, assembly: undefined }], () => undefined);
  expect(unknown.summaries.get("rs123")?.alleleCount).toBe(0);
});

test("cross-shard pagination preserves exact rsID ranking and literal wildcard search", async () => {
  const source = await pack("clinvar", [
    [annotation("prefix", "rs1234"), annotation("percent", "rs900", { title: "50% frequency" })],
    [annotation("exact", "rs123"), annotation("mention", "rs500", { title: "mentions rs123" })],
  ]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const ids: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const page = await references.search("clinvar", {
      searchTerm: "rs123",
      referenceSearchMode: "all-fields",
      limit: 1,
      offset,
    });
    expect(page.total).toBe(3);
    ids.push(page.annotations[0].id);
  }
  expect(ids).toEqual(["exact", "prefix", "mention"]);
  expect(
    (await references.search("clinvar", { searchTerm: "%", referenceSearchMode: "all-fields" })).annotations.map(
      (row) => row.id,
    ),
  ).toEqual(["percent"]);
});

test("checksum failures and evicted assets produce recoverable errors without a query fetch", async () => {
  const source = await pack("clinvar", [[annotation("one", "rs123")]]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  const valid = responses.get(source.shards[0].url)!;
  responses.set(source.shards[0].url, new Response(new Uint8Array(source.shards[0].bytes)));
  await expect(references.download(source.id, () => undefined)).rejects.toThrow("checksum");
  expect(references.getStates()[0].enabled).toBe(false);
  responses.set(source.shards[0].url, valid);
  await references.download(source.id, () => undefined);
  cacheMaps.get(REFERENCE_CACHE)!.delete(referenceCacheKey(source.shards[0], catalogUrl));
  requests = [];
  await expect(references.search(source.id, {})).rejects.toThrow("no longer stored");
  expect(requests).toEqual([]);
  expect(references.getStates()[0]).toMatchObject({ status: "error", enabled: false });
  await references.download(source.id, () => undefined);
  expect(references.getStates()[0].status).toBe("ready");
});

test("manifest validation rejects oversized assets, duplicates, and unsafe URLs", async () => {
  const source = await pack("clinvar", [[annotation("one", "rs123")]]);
  const manifest = serveCatalog([source]);
  expect(validateReferenceManifest(manifest, catalogUrl)).toBe(manifest);
  expect(() => validateReferenceManifest({ ...manifest, packs: [source, source] }, catalogUrl)).toThrow("unique");
  expect(() =>
    validateReferenceManifest(
      { ...manifest, packs: [{ ...source, shards: [{ ...source.shards[0], bytes: 2 ** 32 }] }] },
      catalogUrl,
    ),
  ).toThrow("at most");
  expect(() =>
    validateReferenceManifest(
      { ...manifest, packs: [{ ...source, shards: [{ ...source.shards[0], url: "file:///private/secret" }] }] },
      catalogUrl,
    ),
  ).toThrow("public HTTP");
});

test("coordinate-only gnomAD annotations match an exact known build and remain absent for unknown or different builds", async () => {
  const row = annotation("frequency", "", { source: "gnomad", rsid: undefined, fields: { AF: 0.01 } });
  const source = await pack("gnomad", [[row]]);
  addRouting(source, [[row]]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  requests = [];
  const known = await references.match([user], () => undefined);
  expect(known.evidence.get(user.rsid)?.[0]).toMatchObject({ id: "frequency", matchType: "allele" });
  expect(known.summaries.get(user.rsid)).toMatchObject({ count: 1, alleleCount: 1, ambiguous: false });
  for (const assembly of [undefined, "GRCh37"] as const) {
    const unresolved = await references.match([{ ...user, assembly }], () => undefined);
    expect(unresolved.evidence.size).toBe(0);
    expect(unresolved.summaries.size).toBe(0);
  }
  const lookup = await references.lookup(user.rsid, { assembly: "GRCh38", chromosome: "1", position: 100 });
  expect(lookup.map((entry) => [entry.id, entry.matchType])).toEqual([["frequency", "locus"]]);
  expect(requests).toEqual([]);
});

test("records found by both rsID and coordinates contribute exactly one annotation", async () => {
  const row = annotation("one", user.rsid);
  const source = await pack("clinvar", [[row]]);
  addRouting(source, [[row]]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const match = await references.match([user], () => undefined);
  expect(match.evidence.get(user.rsid)).toHaveLength(1);
  expect(match.summaries.get(user.rsid)).toMatchObject({ count: 1, alleleCount: 1 });
  expect(await references.lookup(user.rsid, { assembly: "GRCh38", chromosome: "1", position: 100 })).toHaveLength(1);
});

test("conflicting calls under canonical and merged rsIDs mark every original call ambiguous", async () => {
  const dbsnp = await pack(
    "dbsnp",
    [[annotation("db", "rs123", { source: "dbsnp", scope: "variant" })]],
    [["rs99", "rs123"]],
  );
  const clinvar = await pack("clinvar", [[annotation("cv", "rs123")]]);
  serveCatalog([dbsnp, clinvar]);
  const references = store();
  await references.initialize(catalogUrl);
  for (const source of [dbsnp, clinvar]) await references.download(source.id, () => undefined);
  const result = await references.match(
    [
      { ...user, rsid: "rs99", ref: "A" },
      { ...user, genotype: "AA", ref: "A" },
    ],
    () => undefined,
  );
  for (const rsid of ["rs99", "rs123"]) {
    expect(result.summaries.get(rsid)).toMatchObject({ ambiguous: true, alleleCount: 0, unresolvedCount: 2 });
    expect(result.evidence.get(rsid)?.find((row) => row.source === "clinvar")?.matchType).toBe("unresolved");
  }
});

test("contradictory REF metadata cannot retain a first-row confirmed allele after deduplication", async () => {
  const source = await pack("clinvar", [[annotation("one", user.rsid)]]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  for (const refs of [
    ["A", "C"],
    ["C", "A"],
  ]) {
    const result = await references.match(
      refs.map((ref) => ({ ...user, ref })),
      () => undefined,
    );
    expect(result.summaries.get(user.rsid)).toMatchObject({ ambiguous: true, alleleCount: 0, unresolvedCount: 1 });
    expect(result.evidence.get(user.rsid)?.[0].matchType).toBe("unresolved");
  }
});

test("equivalent allele order, chromosome notation, and explicit opposite strands do not create ambiguity", async () => {
  const source = await pack("clinvar", [[annotation("one", user.rsid)]]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const result = await references.match(
    [
      { ...user, ref: "A" },
      { ...user, genotype: "ga", chromosome: "chr01", position: "0100", ref: "a" },
      { ...user, genotype: "TC", strand: "minus", ref: "T" },
    ],
    () => undefined,
  );
  expect(result.summaries.get(user.rsid)).toMatchObject({
    ambiguous: false,
    alleleCount: 1,
    unresolvedCount: 0,
    count: 1,
  });
  expect(result.evidence.get(user.rsid)?.[0].matchType).toBe("allele");
});

test("canceling during final cache.put preserves the enabled release and removes the canceled pack", async () => {
  const oldRelease = await pack("clinvar-old", [[annotation("old", user.rsid)]]);
  const nextRelease = await pack("clinvar-next", [[annotation("next", user.rsid)]]);
  nextRelease.version = "v2";
  serveCatalog([oldRelease, nextRelease]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(oldRelease.id, () => undefined);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nextKey = referenceCacheKey(nextRelease.shards[0], catalogUrl);
  beforeCachePut = async (name, key) => {
    if (name === REFERENCE_CACHE && key === nextKey) {
      entered.resolve();
      await release.promise;
    }
  };
  const download = references
    .download(nextRelease.id, () => undefined)
    .then(
      () => "completed",
      (error: Error) => error.name,
    );
  await entered.promise;
  expect(references.getStates().find((state) => state.pack.id === oldRelease.id)?.enabled).toBe(true);
  const removal = references.remove(nextRelease.id);
  release.resolve();
  expect(await download).toBe("AbortError");
  await removal;
  expect(references.getStates().find((state) => state.pack.id === oldRelease.id)).toMatchObject({
    status: "ready",
    enabled: true,
  });
  expect(references.getStates().find((state) => state.pack.id === nextRelease.id)).toMatchObject({
    status: "available",
    enabled: false,
    downloadedBytes: 0,
  });
  expect(cacheMaps.get(REFERENCE_CACHE)?.has(nextKey)).toBe(false);
  const restored = store();
  const states = await restored.initialize(catalogUrl);
  expect(states.filter((state) => state.enabled).map((state) => state.pack.id)).toEqual([oldRelease.id]);
});

test("removing an older pack preserves shared cached files used by the enabled release", async () => {
  const older = await pack("older", [[annotation("shared", user.rsid)]]);
  const newer = { ...older, id: "newer", version: "v2" };
  serveCatalog([older, newer]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(older.id, () => undefined);
  await references.download(newer.id, () => undefined);
  requests = [];
  responses.clear();
  await references.remove(older.id);
  expect(cacheMaps.get(REFERENCE_CACHE)?.has(referenceCacheKey(newer.shards[0], catalogUrl))).toBe(true);
  expect(references.getStates().find((state) => state.pack.id === newer.id)).toMatchObject({
    status: "ready",
    enabled: true,
  });
  expect((await references.match([user], () => undefined)).evidence.get(user.rsid)?.[0].id).toBe("shared");
  expect(requests).toEqual([]);
  await references.remove(newer.id);
  expect(cacheMaps.get(REFERENCE_CACHE)?.has(referenceCacheKey(newer.shards[0], catalogUrl))).toBe(false);
});

test("routed details open only candidate SQLite files and general text searches retain mention matches", async () => {
  const pages = [
    [annotation("exact", user.rsid)],
    [annotation("mention", "rs456", { position: 200, title: "Study mentions rs123" })],
    [annotation("unrelated", "rs789", { position: 300 })],
  ];
  const source = await pack("routed", pages);
  addRouting(source, pages);
  serveCatalog([source]);
  const opened: string[][] = [];
  const references = store(opened);
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  requests = [];
  responses.clear();
  expect((await references.lookup(user.rsid)).map((row) => row.id)).toEqual(["exact"]);
  expect(opened).toEqual([["exact"]]);
  opened.length = 0;
  expect(
    (await references.lookup(user.rsid, { assembly: "GRCh38", chromosome: "1", position: 100 })).map((row) => row.id),
  ).toEqual(["exact"]);
  expect(opened).toEqual([["exact"]]);
  opened.length = 0;
  const matched = await references.match([user], () => undefined);
  expect(matched.summaries.get(user.rsid)).toMatchObject({ count: 1, alleleCount: 1 });
  expect(opened).toEqual([["exact"]]);
  opened.length = 0;
  expect(await references.lookup("i123")).toEqual([]);
  expect(opened).toEqual([]);
  const searched = await references.search(source.id, { searchTerm: "rs123", referenceSearchMode: "all-fields" });
  expect(searched.annotations.map((row) => row.id)).toEqual(["exact", "mention"]);
  expect(opened).toEqual([["exact"], ["mention"], ["unrelated"]]);
  expect(requests).toEqual([]);
});

test("legacy details remain searchable and empty lookup keys fall back safely without network", async () => {
  const source = await pack("legacy", [
    [annotation("exact", user.rsid)],
    [annotation("other", "rs456", { position: 200 })],
  ]);
  serveCatalog([source]);
  const opened: string[][] = [];
  const references = store(opened);
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  requests = [];
  responses.clear();
  expect((await references.lookup(user.rsid)).map((row) => row.id)).toEqual(["exact"]);
  expect(opened).toEqual([["exact"], ["other"]]);
  opened.length = 0;
  expect(await references.lookup("i123")).toEqual([]);
  expect(opened).toEqual([["exact"], ["other"]]);
  expect(requests).toEqual([]);
});

test("unfiltered source-order pages use manifest counts and open only the requested files", async () => {
  const pages = [
    [annotation("z", "rs900"), annotation("a", "rs100")],
    [annotation("middle", "rs500"), annotation("b", "rs200")],
    [annotation("tail", "rs050")],
  ];
  const source = await pack("source-order", pages);
  addRouting(source, pages);
  serveCatalog([source]);
  const opened: string[][] = [];
  const references = store(opened);
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  requests = [];
  const first = await references.search(source.id, { limit: 1 });
  expect(first.annotations.map((row) => row.id)).toEqual(["z"]);
  expect(first.total).toBe(5);
  expect(opened).toEqual([["a", "z"]]);
  opened.length = 0;
  const crossed = await references.search(source.id, { limit: 2, offset: 1 });
  expect(crossed.annotations.map((row) => row.id)).toEqual(["a", "middle"]);
  expect(opened).toEqual([
    ["a", "z"],
    ["b", "middle"],
  ]);
  opened.length = 0;
  expect((await references.search(source.id, { limit: 2, offset: 2 })).annotations.map((row) => row.id)).toEqual([
    "middle",
    "b",
  ]);
  expect(opened).toEqual([["b", "middle"]]);
  opened.length = 0;
  expect(await references.search(source.id, { limit: 0 })).toEqual({ annotations: [], total: 5 });
  expect(await references.search(source.id, { offset: 5, limit: 100 })).toEqual({ annotations: [], total: 5 });
  expect(opened).toEqual([]);
  const exported = await references.search(source.id, { limit: 5, referenceExport: true });
  expect(exported.annotations.map((row) => row.id)).toEqual(["z", "a", "middle", "b", "tail"]);
  expect(exported.annotations).toHaveLength(exported.total);
  opened.length = 0;
  expect(
    (await references.search(source.id, { sortBy: "rsid-asc", limit: 5 })).annotations.map((row) => row.id),
  ).toEqual(["tail", "a", "b", "middle", "z"]);
  expect(opened).toHaveLength(3);
  expect(requests).toEqual([]);
});

test("exact variant search prunes routed files while all-fields mode retains prefixes and mentions", async () => {
  const pages = [
    [annotation("exact", "rs123")],
    [annotation("prefix", "rs1234", { position: 200 })],
    [annotation("mention", "rs456", { position: 300, title: "mentions rs123" })],
  ];
  const source = await pack("exact-mode", pages);
  addRouting(source, pages);
  serveCatalog([source]);
  const opened: string[][] = [];
  const references = store(opened);
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  requests = [];
  const exact = await references.search(source.id, { searchTerm: " RS000123 ", referenceSearchMode: "variant" });
  expect(exact.annotations.map((row) => row.id)).toEqual(["exact"]);
  expect(exact.total).toBe(1);
  expect(opened).toEqual([["exact"]]);
  opened.length = 0;
  expect((await references.search(source.id, { searchTerm: "APOE" })).total).toBe(0);
  expect(opened).toEqual([]);
  const allFields = await references.search(source.id, { searchTerm: "rs123", referenceSearchMode: "all-fields" });
  expect(allFields.annotations.map((row) => row.id)).toEqual(["exact", "prefix", "mention"]);
  expect(allFields.total).toBe(3);
  expect(opened).toEqual([["exact"], ["prefix"], ["mention"]]);
  expect(requests).toEqual([]);
});

test("exact gene search respects whole symbols and source gene-list delimiters in routed and legacy packs", async () => {
  const genes = [
    "APOE",
    "BRCA1; APOE | TOMM40, HLA-B",
    "APOE - TOMM40",
    "APOE-AS1",
    "MYAPOE",
    "APOE2",
    "APOE AS1",
    "HLA-B",
    "HLA-B2",
  ];
  const pages = genes.map((gene, index) => [
    annotation(`row${index}`, `rs${100 + index}`, { gene, position: 100 + index }),
  ]);
  for (const indexed of [false, true]) {
    const source = await pack(`gene-${indexed}`, pages);
    if (indexed) addRouting(source, pages);
    serveCatalog([source]);
    const opened: string[][] = [];
    const references = store(opened);
    await references.initialize(catalogUrl);
    await references.download(source.id, () => undefined);
    const first = await references.search(source.id, { searchTerm: " apoe ", referenceSearchMode: "gene", limit: 2 });
    expect(first.total).toBe(3);
    expect(first.annotations.map((row) => row.id)).toEqual(["row0", "row1"]);
    expect(opened.length).toBe(indexed ? 3 : genes.length);
    const second = await references.search(source.id, {
      searchTerm: "APOE",
      referenceSearchMode: "gene",
      offset: 2,
      limit: 2,
    });
    expect(second.annotations.map((row) => row.id)).toEqual(["row2"]);
    expect(second.total).toBe(3);
    const hyphen = await references.search(source.id, { searchTerm: "HLA-B", referenceSearchMode: "gene" });
    expect(hyphen.annotations.map((row) => row.id)).toEqual(["row1", "row7"]);
    expect(hyphen.total).toBe(2);
  }
});

test("a newer search aborts active and obsolete queued scans between file reads without disabling the pack", async () => {
  const pages = [
    [annotation("first", "rs123", { title: "needle first" })],
    [annotation("second", "rs456", { title: "needle second", position: 200 })],
    [annotation("latest", "rs789", { title: "needle latest", position: 300 })],
  ];
  const source = await pack("cancel-search", pages);
  addRouting(source, pages);
  serveCatalog([source]);
  const opened: string[][] = [];
  const references = store(opened);
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  requests = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reads: string[] = [];
  const firstKey = referenceCacheKey(source.shards[0], catalogUrl);
  beforeCacheMatch = async (name, key) => {
    if (name !== REFERENCE_CACHE) return;
    reads.push(key);
    if (key === firstKey) {
      entered.resolve();
      await release.promise;
    }
  };
  const original = references
    .search(source.id, { searchTerm: "needle", referenceSearchMode: "all-fields" })
    .catch((error: Error) => error.name);
  await entered.promise;
  const superseded = references
    .search(source.id, { searchTerm: "needle", referenceSearchMode: "all-fields" })
    .catch((error: Error) => error.name);
  const latest = references.search(source.id, { searchTerm: "rs789" });
  release.resolve();
  expect(await original).toBe("AbortError");
  expect(await superseded).toBe("AbortError");
  expect((await latest).annotations.map((row) => row.id)).toEqual(["latest"]);
  expect(opened).toEqual([["latest"]]);
  expect(reads).toEqual([firstKey, referenceCacheKey(source.shards[2], catalogUrl)]);
  expect(references.getStates()[0]).toMatchObject({ status: "ready", enabled: true });
  expect(references.getStates()[0].error).toBeUndefined();
  expect(requests).toEqual([]);
});

test("an explicit complete export keeps every record when a newer browser search is queued", async () => {
  const pages = [[annotation("first", "rs123")], [annotation("second", "rs456", { position: 200 })]];
  const source = await pack("export-search", pages);
  addRouting(source, pages);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const firstKey = referenceCacheKey(source.shards[0], catalogUrl);
  beforeCacheMatch = async (name, key) => {
    if (name === REFERENCE_CACHE && key === firstKey) {
      entered.resolve();
      await release.promise;
    }
  };
  const exported = references.search(source.id, { referenceExport: true, limit: 2 });
  await entered.promise;
  const browsed = references.search(source.id, { searchTerm: "rs456" });
  release.resolve();
  const result = await exported;
  expect(result.annotations.map((row) => row.id)).toEqual(["first", "second"]);
  expect(result.annotations).toHaveLength(result.total);
  expect((await browsed).annotations.map((row) => row.id)).toEqual(["second"]);
});

test("large-source CSV exports reject oversized requests before opening files while browsing stays bounded", async () => {
  const source = await pack("large-source", [[annotation("first", "rs123")]]);
  // A large advertised source is sufficient to test the early metadata guard;
  // the first real SQLite row still exercises the normal browsing path.
  source.recordCount = MAX_REFERENCE_EXPORT_ROWS + 1;
  source.shards[0].records = source.recordCount;
  serveCatalog([source]);
  const opened: string[][] = [];
  const references = store(opened);
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  for (const range of [
    { limit: MAX_REFERENCE_EXPORT_ROWS },
    { limit: MAX_REFERENCE_EXPORT_ROWS + 1 },
    { limit: 1, offset: MAX_REFERENCE_EXPORT_ROWS },
  ]) {
    await expect(references.search(source.id, { ...range, referenceExport: true })).rejects.toThrow(
      "up to 100,000 records",
    );
  }
  expect(opened).toEqual([]);
  const browsed = await references.search(source.id, { limit: 1 });
  expect(browsed.annotations.map((row) => row.id)).toEqual(["first"]);
  expect(browsed.total).toBe(source.recordCount);
  expect(opened).toEqual([["first"]]);
  expect(references.getStates()[0]).toMatchObject({ status: "ready", enabled: true });
});

test("a failed catalog refresh preserves the installed catalog and relative asset base", async () => {
  const source = await pack("relative", [[annotation("old", "rs123")]]);
  source.shards[0].url = "relative/0.sqlite";
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  await expect(references.initialize("https://reference.test/other/manifest.json")).rejects.toThrow(
    "Network unavailable",
  );
  expect(references.getStates()[0]).toMatchObject({ status: "ready", enabled: true });
  requests = [];
  expect((await references.lookup("rs123")).map((row) => row.id)).toEqual(["old"]);
  expect(requests).toEqual([]);
});

test("catalog refresh waits for an active lookup to finish before replacing its catalog", async () => {
  const source = await pack("old-catalog", [[annotation("old", "rs123")]]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const nextUrl = "https://reference.test/next/manifest.json";
  responses.set(
    nextUrl,
    new Response(JSON.stringify({ schemaVersion: 1, createdAt: "2026-09-07T00:00:00Z", packs: [] })),
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const key = referenceCacheKey(source.shards[0], catalogUrl);
  beforeCacheMatch = async (name, requestedKey) => {
    if (name === REFERENCE_CACHE && requestedKey === key) {
      entered.resolve();
      await release.promise;
    }
  };
  requests = [];
  const lookup = references.lookup("rs123");
  await entered.promise;
  const refreshed = references.initialize(nextUrl);
  await Promise.resolve();
  expect(requests).toEqual([]);
  expect(references.getStates()[0].pack.id).toBe(source.id);
  release.resolve();
  expect((await lookup).map((row) => row.id)).toEqual(["old"]);
  expect(await refreshed).toEqual([]);
  expect(requests).toEqual([nextUrl]);
});

test("catalog refresh aborts an obsolete browser scan without marking its downloaded files as damaged", async () => {
  const source = await pack("refresh-search", [
    [annotation("first", "rs123")],
    [annotation("second", "rs456", { position: 200 })],
  ]);
  serveCatalog([source]);
  const opened: string[][] = [];
  const references = store(opened);
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const key = referenceCacheKey(source.shards[0], catalogUrl);
  beforeCacheMatch = async (name, requestedKey) => {
    if (name === REFERENCE_CACHE && requestedKey === key) {
      entered.resolve();
      await release.promise;
    }
  };
  const searching = references
    .search(source.id, { searchTerm: "Reference", referenceSearchMode: "all-fields" })
    .catch((error: Error) => error.name);
  await entered.promise;
  const refreshed = references.initialize(catalogUrl);
  release.resolve();
  expect(await searching).toBe("AbortError");
  expect((await refreshed)[0]).toMatchObject({ status: "ready", enabled: true });
  expect(opened).toEqual([]);
});

test("filtered reference pagination uses SQLite binary tie ordering, including Unicode identifiers", async () => {
  const ids = ["a", "A", "😀", "\ue000", "é", "É"];
  const source = await pack("binary-order", [ids.map((id) => annotation(id, "rs123"))]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const pages: string[] = [];
  for (let offset = 0; offset < ids.length; offset++) {
    const page = await references.search(source.id, { searchTerm: "rs123", limit: 1, offset });
    pages.push(...page.annotations.map((row) => row.id));
    expect(page.total).toBe(ids.length);
  }
  expect(pages).toEqual(["A", "a", "É", "é", "\ue000", "😀"]);
  const exported = await references.search(source.id, {
    searchTerm: "rs123",
    limit: ids.length,
    referenceExport: true,
  });
  expect(exported.annotations.map((row) => row.id)).toEqual(pages);
});

test("gene-context lookup associates combined complete gene symbols with each related variant exactly once", async () => {
  const first = { ...user, rsid: "rs123", position: "100" };
  const second = { ...user, rsid: "rs456", position: "200" };
  const variants = await pack("variant-genes", [
    [
      annotation("cyp", first.rsid, { gene: "CYP2C9" }),
      annotation("vkor", second.rsid, { gene: "VKORC1", position: 200 }),
    ],
  ]);
  const pgxPages = [
    [
      annotation("joint", "", {
        source: "cpic",
        scope: "gene",
        assembly: undefined,
        chromosome: undefined,
        position: undefined,
        gene: "CYP2C9; VKORC1",
        ref: undefined,
        alt: undefined,
      }),
      annotation("prefix", "", {
        source: "cpic",
        scope: "gene",
        assembly: undefined,
        chromosome: undefined,
        position: undefined,
        gene: "CYP2C9-AS1 | VKORC10",
        ref: undefined,
        alt: undefined,
      }),
    ],
  ];
  const pgx = await pack("joint-genes", pgxPages);
  addRouting(pgx, pgxPages);
  serveCatalog([variants, pgx]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(variants.id, () => undefined);
  await references.download(pgx.id, () => undefined);
  requests = [];
  const matched = await references.match([first, second], () => undefined);
  for (const id of [first.rsid, second.rsid]) {
    expect(
      matched.evidence
        .get(id)
        ?.filter((row) => row.scope === "gene")
        .map((row) => [row.id, row.matchType]),
    ).toEqual([["joint", "gene"]]);
    expect((await references.lookup(id)).filter((row) => row.scope === "gene").map((row) => row.id)).toEqual(["joint"]);
    expect(matched.summaries.get(id)?.count).toBe(2);
  }
  expect(requests).toEqual([]);
});

test("an ID-less VCF SNP reaches coordinate-only gnomAD evidence with no fabricated SNPedia record", async () => {
  const content = [
    "##fileformat=VCFv4.2",
    "##reference=GRCh38.fa",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    "chr22\t100\t.\tA\tG\t.\tPASS\t.\tGT\t0/1",
  ].join("\n");
  const parsed = await parserVCF.parseBlob(new Blob([content]), () => undefined);
  const source = await pack("gnomad-idless", [[annotation("population", "", { source: "gnomad", chromosome: "22" })]]);
  serveCatalog([source]);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  requests = [];
  const result = await references.match(parsed.genotypes, () => undefined);
  expect(result.evidence.get("grch38:22:100:a:g")?.map((row) => [row.id, row.matchType])).toEqual([
    ["population", "allele"],
  ]);
  const merged = mergeReferenceMatches(parsed.genotypes, [], result.summaries);
  expect(merged).toHaveLength(1);
  expect(merged[0].rsid).toBe("GRCh38:22:100:A:G");
  expect(merged[0].snpData.referenceSource).toBe("references");
  expect(merged[0].snpData.content).toBe("");
  expect(requests).toEqual([]);
});

test("navigation cancellation aborts the intended request and a late old abort cannot cancel its replacement", async () => {
  const pages = [[annotation("old", "rs123")], [annotation("new", "rs456", { position: 200 })]];
  const source = await pack("navigation-cancel", pages);
  addRouting(source, pages);
  serveCatalog([source]);
  const opened: string[][] = [];
  const references = store(opened);
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const key = referenceCacheKey(source.shards[0], catalogUrl);
  beforeCacheMatch = async (name, requestedKey) => {
    if (name === REFERENCE_CACHE && requestedKey === key) {
      entered.resolve();
      await release.promise;
    }
  };
  const old = references
    .search(source.id, { referenceSearchId: "old", searchTerm: "Reference", referenceSearchMode: "all-fields" })
    .catch((error: Error) => error.name);
  await entered.promise;
  references.cancelSearch("old");
  const replacement = references.search(source.id, { referenceSearchId: "new", searchTerm: "rs456" });
  references.cancelSearch("old");
  release.resolve();
  expect(await old).toBe("AbortError");
  expect((await replacement).annotations.map((row) => row.id)).toEqual(["new"]);
  expect(opened).toEqual([["new"]]);
  expect(references.getStates()[0]).toMatchObject({ status: "ready", enabled: true });
});
