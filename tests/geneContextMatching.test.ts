import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import type { AnnotationSource, ReferenceManifest, ReferencePack, VariantAnnotation } from "../src/types/annotations";
import type { UserGenotype } from "../src/types/snp";
import { ReferenceStore } from "../src/workers/referenceStore";
import { matchSNPsInBatches } from "../src/workers/snpMatching";
import { mergeReferenceMatches } from "../src/workers/referenceMatching";
import { buildSnpediaGeneHints } from "../src/workers/snpediaGeneHints";
import { referenceCacheKey, REFERENCE_CACHE, REFERENCE_SETTINGS_CACHE } from "../src/workers/referenceCache";

const CATALOG = "https://gene-context.test/manifest.json";
const originalFetch = globalThis.fetch;
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
let SQL: SqlJsStatic;
let networkRequests: string[];
let cached: Map<string, Map<string, Response>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(() => {
  networkRequests = [];
  cached = new Map();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async (name: string) => {
        const entries = cached.get(name) ?? new Map<string, Response>();
        cached.set(name, entries);
        const key = (input: RequestInfo | URL) => new Request(input).url;
        return {
          match: async (input: RequestInfo | URL) => entries.get(key(input))?.clone(),
          put: async (input: RequestInfo | URL, response: Response) => {
            entries.set(key(input), response.clone());
          },
          delete: async (input: RequestInfo | URL) => entries.delete(key(input)),
        };
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    networkRequests.push(new Request(input).url);
    throw new Error("Offline fixture: queries must use downloaded reference packs");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
  else Reflect.deleteProperty(globalThis, "caches");
});

const user = (rsid = "rs100"): UserGenotype => ({
  rsid,
  chromosome: "1",
  position: "100",
  genotype: "AG",
  assembly: "GRCh38",
  strand: "plus",
});
const geneRow = (source: AnnotationSource, gene = "TEST1", id = `${source}-gene`): VariantAnnotation => ({
  id,
  source,
  gene,
  scope: "gene",
  title: "Synthetic gene association",
  url: "https://gene-context.test/source",
  // A gene assertion must remain context even if its source mentions pathogenicity.
  fields: { clinicalSignificance: "Pathogenic", evidence: "Definitive", disease: "Synthetic condition" },
});
const variantRow = (
  source: AnnotationSource = "uniprot",
  overrides: Partial<VariantAnnotation> = {},
): VariantAnnotation => ({
  id: `${source}-variant`,
  source,
  rsid: "rs100",
  chromosome: "1",
  position: 100,
  assembly: "GRCh38",
  gene: "TEST1",
  scope: "variant",
  title: "Synthetic variant-to-gene mapping",
  url: "https://gene-context.test/variant",
  fields: {},
  ...overrides,
});
const sha256 = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");

/** Seed actual gzip-compressed SQLite files, with both digests verified on read. */
async function installFixture(
  definitions: Array<{ source: AnnotationSource; rows: VariantAnnotation[]; columnScopes?: Record<string, string> }>,
) {
  const packs: ReferencePack[] = [];
  const assetCache = await caches.open(REFERENCE_CACHE);
  for (const [index, definition] of definitions.entries()) {
    const database = new SQL.Database();
    database.run(
      "CREATE TABLE annotations (id TEXT PRIMARY KEY, rsid TEXT, assembly TEXT, chromosome TEXT, position INTEGER, ref TEXT, alt TEXT, gene TEXT, scope TEXT, source TEXT, title TEXT, search_text TEXT, payload TEXT)",
    );
    database.run("CREATE TABLE aliases (alias TEXT, rsid TEXT)");
    const insert = database.prepare("INSERT INTO annotations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of definition.rows) {
      insert.run([
        row.id,
        row.rsid ?? null,
        row.assembly ?? null,
        row.chromosome ?? null,
        row.position ?? null,
        row.ref ?? null,
        row.alt ?? null,
        row.gene ?? null,
        definition.columnScopes?.[row.id] ?? row.scope,
        row.source,
        row.title,
        JSON.stringify(row),
        JSON.stringify(row),
      ]);
    }
    insert.free();
    const bytes = database.export();
    database.close();
    const compressed = new Uint8Array(gzipSync(bytes));
    const shard = {
      url: `${definition.source}-${index}.sqlite.gz`,
      bytes: compressed.length,
      sha256: await sha256(compressed),
      records: definition.rows.length,
      compression: {
        format: "gzip" as const,
        uncompressedBytes: bytes.length,
        uncompressedSha256: await sha256(bytes),
      },
    };
    await assetCache.put(
      referenceCacheKey(shard, CATALOG),
      new Response(compressed, { headers: { "x-reference-sha256": shard.sha256 } }),
    );
    packs.push({
      id: `${definition.source}-${index}`,
      source: definition.source,
      version: "fixture-v1",
      sourceRelease: "public-fixture-release",
      name: definition.source,
      description: "Synthetic compressed SQLite fixture",
      builtAt: "2026-09-07T00:00:00Z",
      homepage: "https://gene-context.test/",
      license: "Synthetic test data",
      licenseUrl: "https://gene-context.test/license",
      attribution: "Synthetic fixture",
      coverage: "Synthetic fixture",
      recordCount: definition.rows.length,
      shards: [shard],
    });
  }
  const settings = await caches.open(REFERENCE_SETTINGS_CACHE);
  const manifest: ReferenceManifest = { schemaVersion: 1, createdAt: "2026-09-07T00:00:00Z", packs };
  await settings.put(CATALOG, new Response(JSON.stringify(manifest)));
  const selection = new URL(CATALOG);
  selection.searchParams.set("__reference_settings", "enabled-packs");
  await settings.put(selection.href, new Response(JSON.stringify(packs.map((pack) => `${pack.id}@${pack.version}`))));
  let openedDatabases = 0;
  const store = new ReferenceStore(async (bytes) => {
    openedDatabases++;
    return new SQL.Database(bytes);
  });
  const states = await store.initialize(CATALOG);
  expect(states.every((state) => state.status === "ready" && state.enabled)).toBe(true);
  // Catalog initialization may try its fixed public URL, then falls back to the
  // installed catalog. All matching and detail queries below must be offline.
  networkRequests.length = 0;
  return { store, opened: () => openedDatabases };
}

describe("downloaded gene context packs", () => {
  test("actual SNPedia matches carry equivalent hints through summary merging and opened details", async () => {
    const { store } = await installFixture([{ source: "orphanet", rows: [geneRow("orphanet")] }]);
    const database = new SQL.Database();
    try {
      database.run("CREATE TABLE snps (rsid TEXT PRIMARY KEY, content TEXT, scraped_at TEXT)");
      database.run("CREATE TABLE genotypes (id TEXT, snp_id TEXT, genotype TEXT, content TEXT, scraped_at TEXT)");
      database.run("INSERT INTO snps VALUES ('rs100', '{{Rsnum|Gene=TEST1|Orientation=plus}}', NULL)");
      database.run(
        "INSERT INTO genotypes VALUES ('rs100(A;G)', 'rs100', 'A;G', '{{Genotype|summary=Synthetic genotype}}', NULL)",
      );
      const calls = [user()];
      const snpedia = await matchSNPsInBatches(database, new Set(["rsid", "content", "scraped_at"]), calls, () => {});
      expect(snpedia).toHaveLength(1);
      const summary = await store.match(calls, () => {}, true, buildSnpediaGeneHints(snpedia));
      const selected = mergeReferenceMatches(calls, snpedia, summary.summaries)[0];
      const details = await store.match([selected], () => {}, false, buildSnpediaGeneHints([selected]));
      expect(selected.annotationSummary).toMatchObject({ sources: ["orphanet"], count: 1, alleleCount: 0 });
      expect(details.evidence.get("rs100")).toHaveLength(1);
      expect(details.evidence.get("rs100")![0]).toMatchObject({ source: "orphanet", scope: "gene", matchType: "gene" });
      expect(details.summaries.get("rs100")).toEqual(selected.annotationSummary);
      expect(networkRequests).toEqual([]);
    } finally {
      database.close();
    }
  });

  test.each(["clingen", "orphanet", "panelapp", "hpo"] as const)(
    "%s matches public gene hints without requiring a variant pack",
    async (source) => {
      const { store, opened } = await installFixture([{ source, rows: [geneRow(source)] }]);
      const hints = new Map([["rs100", ["TEST1"]]]);
      const full = await store.match([user()], () => {}, false, hints);
      const compact = await store.match([user()], () => {}, true, hints);
      const details = await store.match([user()], () => {}, false, hints);
      expect(full.evidence.get("rs100")).toHaveLength(1);
      expect(full.evidence.get("rs100")![0]).toMatchObject({
        source,
        scope: "gene",
        matchType: "gene",
        fields: { sourceVersion: "fixture-v1", upstreamRelease: "public-fixture-release" },
      });
      expect(full.evidence.get("rs100")![0].matchReason).toContain("does not establish an associated condition");
      expect(full.summaries.get("rs100")).toMatchObject({
        count: 1,
        alleleCount: 0,
        unresolvedCount: 0,
        sources: [source],
      });
      expect(compact.summaries).toEqual(full.summaries);
      expect(compact.evidence.size).toBe(0);
      expect(details.evidence).toEqual(full.evidence);
      expect(opened()).toBeGreaterThan(0);
      expect(networkRequests).toEqual([]);
    },
  );

  test("variant-derived genes yield the same gene context in whole-file matches and reference lookup", async () => {
    const sources = ["clingen", "orphanet", "panelapp", "hpo"] as const;
    const { store } = await installFixture([
      { source: "uniprot", rows: [variantRow()] },
      ...sources.map((source) => ({ source, rows: [geneRow(source)] })),
    ]);
    const full = await store.match([user()], () => {});
    const details = await store.lookup("rs100", { assembly: "GRCh38", chromosome: "1", position: 100 });
    const ids = (rows: VariantAnnotation[]) => rows.map((row) => row.id).sort();
    expect(ids(details)).toEqual(ids(full.evidence.get("rs100")!));
    expect(
      details
        .filter((row) => row.matchType === "gene")
        .map((row) => row.source)
        .sort(),
    ).toEqual([...sources].sort());
    expect(full.summaries.get("rs100")).toMatchObject({ count: 5, alleleCount: 0 });
    expect(details.some((row) => row.matchType === "allele")).toBe(false);
    expect(networkRequests).toEqual([]);
  });

  test("hint normalization preserves legitimate cluster symbols and never uses hints for an absent call", async () => {
    const { store } = await installFixture([{ source: "clingen", rows: [geneRow("clingen", "IGL@")] }]);
    const hints = new Map([
      ["RS0100", [" igl@ ", "Some unrelated words", "<script>"]],
      ["rs999", ["IGL@"]],
    ]);
    const matched = await store.match([user()], () => {}, false, hints);
    expect([...matched.evidence.keys()]).toEqual(["rs100"]);
    expect(matched.evidence.get("rs100")![0].gene).toBe("IGL@");
    const unmatched = await store.match([user("rs101")], () => {}, false, hints);
    expect(unmatched.evidence.size).toBe(0);
    expect(unmatched.summaries.size).toBe(0);
    expect(networkRequests).toEqual([]);
  });

  test("gene-only packs without any observed gene mapping produce no invented matches", async () => {
    const { store } = await installFixture([{ source: "orphanet", rows: [geneRow("orphanet")] }]);
    expect((await store.match([user()], () => {})).evidence.size).toBe(0);
    expect(await store.lookup("rs100")).toEqual([]);
    expect(networkRequests).toEqual([]);
  });

  test("an explicit gene-scope row with an rsID stays gene context in both passes", async () => {
    const row = { ...geneRow("clingen"), rsid: "rs100" };
    const { store } = await installFixture([{ source: "clingen", rows: [row] }]);
    const full = await store.match([user()], () => {});
    const lookup = await store.lookup("rs100");
    expect(full.evidence.get("rs100")).toHaveLength(1);
    expect(full.evidence.get("rs100")![0].matchType).toBe("gene");
    expect(lookup).toHaveLength(1);
    expect(lookup[0].matchType).toBe("gene");
    expect(full.summaries.get("rs100")).toMatchObject({ count: 1, alleleCount: 0, unresolvedCount: 0 });
    expect(networkRequests).toEqual([]);
  });

  test("only explicit gene-scope payloads can propagate from a gene hint", async () => {
    const gene = geneRow("clingen");
    const unrelatedAllele = variantRow("clingen", {
      id: "other-allele",
      rsid: "rs999",
      position: 999,
      scope: "allele",
      ref: "A",
      alt: "G",
      fields: { clinicalSignificance: "Pathogenic" },
    });
    const mismatchedPayload = { ...unrelatedAllele, id: "column-payload-scope-disagrees" };
    const { store } = await installFixture([
      {
        source: "clingen",
        rows: [gene, unrelatedAllele, mismatchedPayload],
        columnScopes: { [mismatchedPayload.id]: "gene" },
      },
    ]);
    const full = await store.match([user()], () => {}, false, new Map([["rs100", ["TEST1"]]]));
    expect(full.evidence.get("rs100")!.map((row) => row.id)).toEqual([gene.id]);
    expect(full.summaries.get("rs100")!.alleleCount).toBe(0);
    expect(networkRequests).toEqual([]);
  });

  test.each(["cpic", "clinpgx"] as const)(
    "%s retains drug-context wording and never infers a drug phenotype",
    async (source) => {
      const { store } = await installFixture([{ source, rows: [geneRow(source)] }]);
      const full = await store.match([user()], () => {}, false, new Map([["rs100", ["TEST1"]]]));
      expect(full.evidence.get("rs100")![0].matchType).toBe("gene");
      expect(full.evidence.get("rs100")![0].matchReason).toContain("drug-response phenotype has not been inferred");
      expect(full.summaries.get("rs100")!).toMatchObject({ alleleCount: 0 });
      expect(networkRequests).toEqual([]);
    },
  );
});
