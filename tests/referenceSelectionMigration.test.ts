import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ReferenceManifest, ReferencePack } from "../src/types/annotations";
import { ReferenceStore } from "../src/workers/referenceStore";
import { referenceCacheKey, REFERENCE_CACHE, REFERENCE_SETTINGS_CACHE } from "../src/workers/referenceCache";

const originalFetch = globalThis.fetch;
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
const legacyUrl = "https://reference.test/references/manifest.json";
const nextUrl = "https://reference.test/references/manifest-v2.json";
let entries: Map<string, Map<string, Response>>;
let responses: Map<string, Response>;
let requests: string[];
let writes: Array<{ cache: string; key: string }>;
let afterRead: ((cache: string, key: string) => Promise<void>) | undefined;

beforeEach(() => {
  entries = new Map();
  responses = new Map();
  requests = [];
  writes = [];
  afterRead = undefined;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async (name: string) => {
        const cache = entries.get(name) ?? new Map<string, Response>();
        entries.set(name, cache);
        const key = (input: RequestInfo | URL) => new Request(input).url;
        return {
          match: async (input: RequestInfo | URL) => {
            const url = key(input);
            const response = cache.get(url)?.clone();
            await afterRead?.(name, url);
            return response;
          },
          put: async (input: RequestInfo | URL, response: Response) => {
            const url = key(input);
            writes.push({ cache: name, key: url });
            cache.set(url, response.clone());
          },
        };
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new Request(input).url;
    requests.push(url);
    const response = responses.get(url);
    if (!response) throw new Error("Offline fixture");
    return response.clone();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
  else Reflect.deleteProperty(globalThis, "caches");
});

function settingsKey(url: string): string {
  const key = new URL(url);
  key.searchParams.set("__reference_settings", "enabled-packs");
  return key.href;
}

function store() {
  return new ReferenceStore(async () => {
    throw new Error("Preference migration must not open a database.");
  });
}

async function source(id: "clinvar" | "gwas", version = "v1"): Promise<ReferencePack> {
  const bytes = new TextEncoder().encode(`Synthetic public ${id} ${version}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const pack: ReferencePack = {
    id,
    source: id,
    name: id,
    description: "Synthetic preference migration fixture",
    version,
    builtAt: "2026-09-07T00:00:00Z",
    homepage: "https://reference.test/",
    license: "Synthetic test data",
    licenseUrl: "https://reference.test/license",
    attribution: "Synthetic test fixture",
    coverage: "No personal data",
    recordCount: 1,
    shards: [{ url: `/references/${id}/${version}/part.sqlite`, bytes: bytes.length, sha256, records: 1 }],
  };
  const assets = await caches.open(REFERENCE_CACHE);
  await assets.put(
    referenceCacheKey(pack.shards[0], legacyUrl),
    new Response(bytes, { headers: { "x-reference-sha256": sha256 } }),
  );
  return pack;
}

function serve(url: string, packs: ReferencePack[]) {
  const manifest: ReferenceManifest = { schemaVersion: 1, createdAt: "2026-09-07T00:00:00Z", packs };
  responses.set(url, new Response(JSON.stringify(manifest)));
}

async function save(url: string, json: string) {
  const cache = await caches.open(REFERENCE_SETTINGS_CACHE);
  await cache.put(settingsKey(url), new Response(json));
}

test("v2 reuses enabled same-version packs and existing cached bytes without copying assets or settings", async () => {
  const oldPack = await source("clinvar");
  const newPack = await source("gwas");
  serve(nextUrl, [oldPack, newPack]);
  await save(legacyUrl, '["clinvar@v1"]');
  writes = [];
  const assetKeys = [...entries.get(REFERENCE_CACHE)!.keys()];

  const states = await store().initialize(nextUrl);

  expect(states.map((state) => [state.pack.id, state.status, state.enabled])).toEqual([
    ["clinvar", "ready", true],
    ["gwas", "ready", false],
  ]);
  expect([...entries.get(REFERENCE_CACHE)!.keys()]).toEqual(assetKeys);
  expect(writes).toEqual([{ cache: REFERENCE_SETTINGS_CACHE, key: nextUrl }]);
  expect(requests).toEqual([nextUrl]);
  expect(entries.get(REFERENCE_SETTINGS_CACHE)?.has(settingsKey(nextUrl))).toBe(false);
});

test("explicit empty v2 choices take precedence and survive a later legacy change", async () => {
  serve(nextUrl, [await source("clinvar")]);
  await save(legacyUrl, '["clinvar@v1"]');
  await save(nextUrl, "[]");
  expect((await store().initialize(nextUrl))[0].enabled).toBe(false);
  await save(legacyUrl, '["clinvar@v1","gwas@v1"]');
  expect((await store().initialize(nextUrl))[0].enabled).toBe(false);
  expect(await entries.get(REFERENCE_SETTINGS_CACHE)!.get(settingsKey(nextUrl))!.clone().json()).toEqual([]);
});

test("saved v2 selections override the old selection and setEnabled persists only v2", async () => {
  serve(nextUrl, [await source("clinvar"), await source("gwas")]);
  await save(legacyUrl, '["clinvar@v1"]');
  await save(nextUrl, '["gwas@v1"]');
  const references = store();
  expect((await references.initialize(nextUrl)).filter((state) => state.enabled).map((state) => state.pack.id)).toEqual(
    ["gwas"],
  );
  await references.setEnabled("gwas", false);
  expect((await store().initialize(nextUrl)).some((state) => state.enabled)).toBe(false);
  expect(await entries.get(REFERENCE_SETTINGS_CACHE)!.get(settingsKey(legacyUrl))!.clone().json()).toEqual([
    "clinvar@v1",
  ]);
});

test("malformed existing v2 settings never fall back to legacy enabled choices", async () => {
  serve(nextUrl, [await source("clinvar")]);
  await save(legacyUrl, '["clinvar@v1"]');
  for (const malformed of ["not JSON", '{"enabled":["clinvar@v1"]}', "null"]) {
    await save(nextUrl, malformed);
    expect((await store().initialize(nextUrl))[0].enabled).toBe(false);
    expect(await entries.get(REFERENCE_SETTINGS_CACHE)!.get(settingsKey(nextUrl))!.clone().text()).toBe(malformed);
  }
});

test("malformed legacy settings are ignored instead of partially enabling packs", async () => {
  serve(nextUrl, [await source("clinvar")]);
  for (const malformed of ["not JSON", '{"enabled":["clinvar@v1"]}', '["clinvar@v1",42]', "null"]) {
    await save(legacyUrl, malformed);
    expect((await store().initialize(nextUrl))[0].enabled).toBe(false);
  }
});

test("migration is limited to the exact sibling path, origin, and query parameters", async () => {
  const pack = await source("clinvar");
  const settings = await caches.open(REFERENCE_SETTINGS_CACHE);
  const differentKeys = [
    "https://other.test/references/manifest.json",
    "https://reference.test/other/manifest.json",
    legacyUrl + "?edition=other",
  ];
  for (const url of differentKeys) await save(url, '["clinvar@v1"]');
  serve(nextUrl, [pack]);
  expect((await store().initialize(nextUrl))[0].enabled).toBe(false);
  await settings.put(settingsKey(legacyUrl + "?edition=public"), new Response('["clinvar@v1"]'));
  serve(nextUrl + "?edition=public", [pack]);
  expect((await store().initialize(nextUrl + "?edition=public"))[0].enabled).toBe(true);
  await save(legacyUrl, '["clinvar@v1"]');
  for (const filename of ["manifest-v3.json", "custom-manifest-v2.json", "manifest-v2.json.backup"]) {
    const url = new URL(filename, nextUrl).href;
    serve(url, [pack]);
    expect((await store().initialize(url))[0].enabled).toBe(false);
  }
});

test("legacy selection never enables a different release or an incompletely cached pack", async () => {
  const changed = await source("clinvar", "v2");
  const missing = await source("gwas");
  entries.get(REFERENCE_CACHE)!.delete(referenceCacheKey(missing.shards[0], legacyUrl));
  serve(nextUrl, [changed, missing]);
  await save(legacyUrl, '["clinvar@v1","gwas@v1"]');
  const states = await store().initialize(nextUrl);
  expect(states.map((state) => [state.status, state.enabled])).toEqual([
    ["ready", false],
    ["available", false],
  ]);
});

test("v2 choices saved while legacy settings are read take precedence without being overwritten", async () => {
  serve(nextUrl, [await source("clinvar")]);
  await save(legacyUrl, '["clinvar@v1"]');
  afterRead = async (name, key) => {
    if (name === REFERENCE_SETTINGS_CACHE && key === settingsKey(legacyUrl)) {
      afterRead = undefined;
      await save(nextUrl, "[]");
    }
  };
  expect((await store().initialize(nextUrl))[0].enabled).toBe(false);
  expect(await entries.get(REFERENCE_SETTINGS_CACHE)!.get(settingsKey(nextUrl))!.clone().json()).toEqual([]);
});

test("legacy choices also apply when the v2 catalog is loaded entirely from browser cache", async () => {
  const pack = await source("clinvar");
  serve(nextUrl, [pack]);
  const cache = await caches.open(REFERENCE_SETTINGS_CACHE);
  await cache.put(nextUrl, responses.get(nextUrl)!.clone());
  responses.clear();
  await save(legacyUrl, '["clinvar@v1"]');
  expect((await store().initialize(nextUrl))[0]).toMatchObject({ status: "ready", enabled: true });
  expect(requests).toEqual([nextUrl]);
});
