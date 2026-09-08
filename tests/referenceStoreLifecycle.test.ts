import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ReferenceManifest, ReferencePack } from "../src/types/annotations";
import { ReferenceStore } from "../src/workers/referenceStore";
import { referenceCacheKey, REFERENCE_CACHE, REFERENCE_SETTINGS_CACHE } from "../src/workers/referenceCache";

const catalogUrl = "https://reference.test/manifest.json";
const originalFetch = globalThis.fetch;
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
let entries: Map<string, Map<string, Response>>;
let responses: Map<string, Response>;
let requests: string[];
let beforePut: ((name: string) => Promise<void>) | undefined;
let beforeFetch: ((url: string) => Promise<void>) | undefined;

beforeEach(() => {
  entries = new Map();
  responses = new Map();
  requests = [];
  beforePut = undefined;
  beforeFetch = undefined;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      delete: async (name: string) => entries.delete(name),
      open: async (name: string) => {
        const cache = entries.get(name) ?? new Map<string, Response>();
        entries.set(name, cache);
        const key = (input: RequestInfo | URL) => new Request(input).url;
        return {
          keys: async () => [...cache.keys()].map((url) => new Request(url)),
          match: async (input: RequestInfo | URL) => cache.get(key(input))?.clone(),
          put: async (input: RequestInfo | URL, response: Response) => {
            await beforePut?.(name);
            cache.set(key(input), response.clone());
          },
          delete: async (input: RequestInfo | URL) => cache.delete(key(input)),
        };
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new Request(input).url;
    requests.push(url);
    await beforeFetch?.(url);
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

async function pack(version = "v1"): Promise<ReferencePack> {
  // Storage lifecycle tests need integrity-checked public bytes, never a query.
  const bytes = new TextEncoder().encode(`public reference fixture ${version}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
  const url = `https://reference.test/clinvar/${version}/0.sqlite`;
  responses.set(url, new Response(bytes));
  return {
    id: "clinvar",
    source: "clinvar",
    name: "ClinVar",
    description: "Synthetic lifecycle fixture",
    version,
    builtAt: "2026-09-07T00:00:00Z",
    homepage: "https://reference.test/",
    license: "Test fixture",
    licenseUrl: "https://reference.test/license",
    attribution: "Synthetic public data",
    coverage: "Synthetic fixture",
    recordCount: 1,
    shards: [{ url, bytes: bytes.length, sha256, records: 1 }],
  };
}

function serve(source: ReferencePack) {
  const manifest: ReferenceManifest = {
    schemaVersion: 1,
    createdAt: "2026-09-07T00:00:00Z",
    packs: [source],
  };
  responses.set(catalogUrl, new Response(JSON.stringify(manifest)));
}

function store() {
  return new ReferenceStore(async () => {
    throw new Error("Storage cleanup should not open a database.");
  });
}

test("clearing removes current and orphaned assets and all selections, retaining other caches and offline catalog", async () => {
  const source = await pack();
  serve(source);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const assets = await caches.open(REFERENCE_CACHE);
  await assets.put("https://reference.test/obsolete/v0.sqlite", new Response("orphan"));
  const settings = await caches.open(REFERENCE_SETTINGS_CACHE);
  await settings.put(
    "https://reference.test/previous/manifest.json?__reference_settings=enabled-packs",
    new Response('["old@v0"]'),
  );
  const snpedia = await caches.open("snp-browser-snpedia");
  await snpedia.put("https://reference.test/snpedia.sqlite", new Response("keep SNPedia"));
  const unrelated = await caches.open("other-application");
  await unrelated.put("https://reference.test/other", new Response("keep unrelated cache"));

  const states = await references.clear();

  expect(entries.has(REFERENCE_CACHE)).toBe(false);
  expect(states[0]).toMatchObject({ status: "available", enabled: false, downloadedBytes: 0, error: undefined });
  expect((await settings.keys()).map((request) => request.url)).toEqual([catalogUrl]);
  expect(await (await snpedia.match("https://reference.test/snpedia.sqlite"))?.text()).toBe("keep SNPedia");
  expect(await (await unrelated.match("https://reference.test/other"))?.text()).toBe("keep unrelated cache");
  responses.clear();
  expect((await store().initialize(catalogUrl))[0]).toMatchObject({ status: "available", enabled: false });
});

test("clearing waits for a final cache write to finish and blocks newly queued downloads", async () => {
  const source = await pack();
  serve(source);
  const references = store();
  await references.initialize(catalogUrl);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforePut = async (name) => {
    if (name === REFERENCE_CACHE) {
      entered.resolve();
      await release.promise;
    }
  };
  const downloading = references.download(source.id, () => undefined).catch((error: Error) => error.name);
  await entered.promise;
  const clearing = references.clear();
  await expect(references.download(source.id, () => undefined)).rejects.toThrow("finish clearing");
  release.resolve();
  expect(await downloading).toBe("AbortError");
  expect((await clearing)[0]).toMatchObject({ status: "available", enabled: false, downloadedBytes: 0 });
  expect(entries.has(REFERENCE_CACHE)).toBe(false);

  beforePut = undefined;
  expect((await references.download(source.id, () => undefined))[0]).toMatchObject({ status: "ready", enabled: true });
  expect(entries.get(REFERENCE_CACHE)?.has(referenceCacheKey(source.shards[0], catalogUrl))).toBe(true);
});

test("clearing can recover orphaned files even when no catalog has loaded", async () => {
  const assets = await caches.open(REFERENCE_CACHE);
  await assets.put("https://reference.test/obsolete.sqlite", new Response("orphan"));
  expect(await store().clear()).toEqual([]);
  expect(entries.has(REFERENCE_CACHE)).toBe(false);
});

test("canceling immediately prevents a queued download from writing files after removal", async () => {
  const source = await pack();
  serve(source);
  const references = store();
  await references.initialize(catalogUrl);
  const downloading = references.download(source.id, () => undefined).catch((error: Error) => error.message);
  const removed = references.remove(source.id);
  expect(await downloading).toContain("finish removing");
  expect((await removed)[0]).toMatchObject({ status: "available", enabled: false, downloadedBytes: 0 });
  expect(requests).not.toContain(source.shards[0].url);
  expect(entries.get(REFERENCE_CACHE)?.size ?? 0).toBe(0);
});

test("clearing immediately cancels download starts that are still queued", async () => {
  const source = await pack();
  serve(source);
  const references = store();
  await references.initialize(catalogUrl);
  const downloading = references.download(source.id, () => undefined).catch((error: Error) => error.message);
  const cleared = references.clear();
  expect(await downloading).toContain("finish clearing");
  expect((await cleared)[0]).toMatchObject({ status: "available", enabled: false, downloadedBytes: 0 });
  expect(requests).not.toContain(source.shards[0].url);
  expect(entries.has(REFERENCE_CACHE)).toBe(false);
});

test("downloads started during a catalog refresh use the refreshed release and cannot mutate stale states", async () => {
  const previous = await pack("v1");
  serve(previous);
  const references = store();
  await references.initialize(catalogUrl);
  const next = await pack("v2");
  serve(next);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeFetch = async (url) => {
    if (url === catalogUrl) {
      entered.resolve();
      await release.promise;
    }
  };
  const refresh = references.initialize(catalogUrl);
  await entered.promise;
  const download = references.download(next.id, () => undefined);
  release.resolve();
  await refresh;
  expect((await download)[0]).toMatchObject({ pack: { version: "v2" }, enabled: true, status: "ready" });
  expect(requests).toContain(next.shards[0].url);
  expect(requests).not.toContain(previous.shards[0].url);
});

test("a selection change made during refresh is applied afterward and survives an offline reload", async () => {
  const source = await pack();
  serve(source);
  const references = store();
  await references.initialize(catalogUrl);
  await references.download(source.id, () => undefined);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeFetch = async (url) => {
    if (url === catalogUrl) {
      entered.resolve();
      await release.promise;
    }
  };
  const refresh = references.initialize(catalogUrl);
  await entered.promise;
  const toggle = references.setEnabled(source.id, false);
  release.resolve();
  await refresh;
  expect((await toggle)[0].enabled).toBe(false);
  beforeFetch = undefined;
  responses.clear();
  expect((await store().initialize(catalogUrl))[0]).toMatchObject({ enabled: false, status: "ready" });
});
