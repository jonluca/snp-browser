import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import type {
  ReferenceDownloadProgress,
  ReferenceManifest,
  ReferencePack,
  ReferenceShard,
} from "../src/types/annotations";
import {
  cachedReferenceBytes,
  cachedReferenceSize,
  downloadReferencePack,
  referenceCacheKey,
  REFERENCE_CACHE,
} from "../src/workers/referenceCache";
import { MAX_REFERENCE_SHARD_BYTES, validateReferenceManifest } from "../src/workers/referenceManifest";
import { ReferenceStore } from "../src/workers/referenceStore";

const base = "https://reference.test/manifest.json";
const originalFetch = globalThis.fetch;
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
const originalDecoder = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream");
const NativeDecompressionStream = globalThis.DecompressionStream;
let SQL: SqlJsStatic;
let sqliteBytes: Uint8Array<ArrayBuffer>;
let cacheMaps: Map<string, Map<string, Response>>;
let responses: Map<string, Response>;
let requests: string[];
let beforePut: ((name: string, key: string) => Promise<void>) | undefined;

beforeAll(async () => {
  SQL = await initSqlJs();
  const database = new SQL.Database();
  database.run("CREATE TABLE evidence (rsid TEXT, content TEXT)");
  database.run("INSERT INTO evidence VALUES (?, ?), (?, ?)", [
    "rs429358",
    "Public reference α",
    "rs7412",
    "Another reference",
  ]);
  sqliteBytes = new Uint8Array(database.export());
  database.close();
});

beforeEach(() => {
  cacheMaps = new Map();
  responses = new Map();
  requests = [];
  beforePut = undefined;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      delete: async (name: string) => cacheMaps.delete(name),
      open: async (name: string) => {
        const entries = cacheMaps.get(name) ?? new Map<string, Response>();
        cacheMaps.set(name, entries);
        const key = (input: RequestInfo | URL) => new Request(input).url;
        return {
          keys: async () => [...entries.keys()].map((url) => new Request(url)),
          match: async (input: RequestInfo | URL) => entries.get(key(input))?.clone(),
          put: async (input: RequestInfo | URL, response: Response) => {
            await beforePut?.(name, key(input));
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
  if (originalDecoder) Object.defineProperty(globalThis, "DecompressionStream", originalDecoder);
  else Reflect.deleteProperty(globalThis, "DecompressionStream");
});

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function fixture(compressed = true, encodedOverride?: Uint8Array) {
  const encoded = new Uint8Array(encodedOverride ?? (compressed ? gzipSync(sqliteBytes) : sqliteBytes));
  const shard: ReferenceShard = {
    url: `https://reference.test/clinvar/v1/part.sqlite${compressed ? ".gz" : ""}`,
    bytes: encoded.length,
    sha256: await hash(encoded),
    records: 2,
    ...(compressed
      ? {
          compression: {
            format: "gzip" as const,
            uncompressedBytes: sqliteBytes.length,
            uncompressedSha256: await hash(sqliteBytes),
          },
        }
      : {}),
  };
  responses.set(shard.url, new Response(encoded));
  return { shard, encoded };
}

function pack(shards: ReferenceShard[]): ReferencePack {
  return {
    id: "clinvar",
    source: "clinvar",
    name: "ClinVar",
    description: "Synthetic public reference compression fixture",
    version: "v1",
    builtAt: "2026-09-07T00:00:00Z",
    homepage: "https://reference.test/",
    license: "Fixture",
    licenseUrl: "https://reference.test/license",
    attribution: "Synthetic public reference",
    coverage: "Fixture",
    recordCount: shards.reduce((sum, shard) => sum + shard.records, 0),
    shards,
  };
}

function manifest(source: ReferencePack): ReferenceManifest {
  return { schemaVersion: 1, createdAt: "2026-09-07T00:00:00Z", packs: [source] };
}

async function download(
  source: ReferencePack,
  onProgress: (progress: ReferenceDownloadProgress) => void = () => undefined,
  controller = new AbortController(),
) {
  return downloadReferencePack(source, base, onProgress, controller.signal);
}

function saved(shard: ReferenceShard) {
  return cacheMaps.get(REFERENCE_CACHE)?.get(referenceCacheKey(shard, base));
}

async function seed(shard: ReferenceShard, bytes: Uint8Array) {
  const cache = await caches.open(REFERENCE_CACHE);
  await cache.put(
    referenceCacheKey(shard, base),
    new Response(new Uint8Array(bytes), { headers: { "x-reference-sha256": shard.sha256 } }),
  );
}

test("legacy and gzip files retain identical SQLite data offline while cache sizes and progress count stored bytes", async () => {
  const raw = await fixture(false);
  const gzip = await fixture(true);
  const source = pack([raw.shard, gzip.shard]);
  const progress: ReferenceDownloadProgress[] = [];
  await download(source, (value) => progress.push(value));
  expect(requests).toEqual([raw.shard.url, gzip.shard.url]);
  expect(progress.at(-1)).toEqual({
    packId: source.id,
    totalBytes: raw.encoded.length + gzip.encoded.length,
    downloadedBytes: raw.encoded.length + gzip.encoded.length,
  });
  expect(progress.every((value) => value.downloadedBytes <= value.totalBytes)).toBe(true);
  expect(await cachedReferenceSize(source, base)).toBe(raw.encoded.length + gzip.encoded.length);
  expect(gzip.encoded.length).toBeLessThan(sqliteBytes.length);
  expect(new Uint8Array(await saved(gzip.shard)!.clone().arrayBuffer())).toEqual(gzip.encoded);
  expect(saved(gzip.shard)?.headers.get("content-type")).toBe("application/gzip");
  expect(saved(gzip.shard)?.headers.has("content-encoding")).toBe(false);

  responses.clear();
  requests = [];
  for (const shard of source.shards) {
    const bytes = await cachedReferenceBytes(shard, base);
    expect(bytes).toEqual(sqliteBytes);
    const database = new SQL.Database(bytes);
    expect(database.exec("SELECT rsid,content FROM evidence ORDER BY rsid")[0].values).toEqual([
      ["rs429358", "Public reference α"],
      ["rs7412", "Another reference"],
    ]);
    database.close();
  }
  expect(requests).toEqual([]);
});

test("resuming a valid gzip download requires neither the network nor a decompressor", async () => {
  const { shard } = await fixture();
  const source = pack([shard]);
  await download(source);
  Object.defineProperty(globalThis, "DecompressionStream", { configurable: true, value: undefined });
  responses.clear();
  requests = [];
  const progress: ReferenceDownloadProgress[] = [];
  await download(source, (value) => progress.push(value));
  expect(requests).toEqual([]);
  expect(progress.at(-1)?.downloadedBytes).toBe(shard.bytes);
  expect(await cachedReferenceSize(source, base)).toBe(shard.bytes);
  await expect(cachedReferenceBytes(shard, base)).rejects.toThrow("cannot open compressed");
  expect(saved(shard)).toBeDefined();
});

test("malformed gzip with a matching outer checksum is rejected before any cache write", async () => {
  const { shard } = await fixture(true, new TextEncoder().encode("This is not a gzip stream"));
  await expect(download(pack([shard]))).rejects.toThrow();
  expect(saved(shard)).toBeUndefined();
});

test.each(["CRC", "truncated trailer", "trailing bytes", "second member"])(
  "gzip %s corruption is rejected even when the encoded checksum is valid",
  async (problem) => {
    const gzip = await fixture();
    let encoded = new Uint8Array(gzip.encoded);
    if (problem === "CRC") encoded[encoded.length - 8] ^= 1;
    else if (problem === "truncated trailer") encoded = encoded.slice(0, -4);
    else encoded = new Uint8Array([...encoded, ...(problem === "second member" ? encoded : [1])]);
    const { shard } = await fixture(true, encoded);
    await expect(download(pack([shard]))).rejects.toThrow();
    expect(saved(shard)).toBeUndefined();
  },
);

test.each(["overflow", "short output", "decoded checksum"])("a gzip %s mismatch cannot be saved", async (problem) => {
  const { shard } = await fixture();
  if (problem === "overflow") shard.compression!.uncompressedBytes--;
  else if (problem === "short output") shard.compression!.uncompressedBytes++;
  else shard.compression!.uncompressedSha256 = "0".repeat(64);
  await expect(download(pack([shard]))).rejects.toThrow(problem === "decoded checksum" ? /checksum/ : /size/);
  expect(saved(shard)).toBeUndefined();
});

test.each(["encoded checksum", "encoded overrun", "decoded checksum", "invalid gzip"])(
  "a cached %s failure evicts the unusable file",
  async (problem) => {
    const { shard, encoded } = await fixture();
    let stored = new Uint8Array(encoded);
    if (problem === "encoded checksum") stored[stored.length - 1] ^= 1;
    else if (problem === "encoded overrun") stored = new Uint8Array([...stored, 0]);
    else if (problem === "decoded checksum") shard.compression!.uncompressedSha256 = "0".repeat(64);
    else {
      stored.fill(0);
      shard.sha256 = await hash(stored);
    }
    await seed(shard, stored);
    await expect(cachedReferenceBytes(shard, base)).rejects.toThrow();
    expect(saved(shard)).toBeUndefined();
    expect(requests).toEqual([]);
  },
);

test("a navigation abort during real gzip output preserves the valid compressed cache", async () => {
  const { shard, encoded } = await fixture();
  await download(pack([shard]));
  const controller = new AbortController();
  let deliveredOutput = false;
  class AbortingDecompressionStream {
    writable: WritableStream<BufferSource>;
    readable: ReadableStream<Uint8Array>;
    constructor() {
      const decoder = new NativeDecompressionStream("gzip");
      this.writable = decoder.writable;
      this.readable = decoder.readable.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, output) {
            deliveredOutput = true;
            output.enqueue(chunk);
            controller.abort();
          },
        }),
      );
    }
  }
  Object.defineProperty(globalThis, "DecompressionStream", { configurable: true, value: AbortingDecompressionStream });
  await expect(cachedReferenceBytes(shard, base, () => controller.signal.throwIfAborted())).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(deliveredOutput).toBe(true);
  expect(new Uint8Array(await saved(shard)!.clone().arrayBuffer())).toEqual(encoded);
});

test("an oversized cached stream is canceled immediately without buffering or waiting for its remaining body", async () => {
  const { shard } = await fixture();
  let canceled = false;
  let deleted = false;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async () => ({
        match: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(shard.bytes + 1));
                // Deliberately never finish. arrayBuffer() would wait indefinitely.
              },
              cancel() {
                canceled = true;
              },
            }),
          ),
        delete: async () => {
          deleted = true;
          return true;
        },
      }),
    },
  });
  await expect(cachedReferenceBytes(shard, base)).rejects.toThrow("exceeds its declared size");
  expect(canceled).toBe(true);
  expect(deleted).toBe(true);
  expect(requests).toEqual([]);
});

test("pre-aborted and mid-read downloads cannot save partial gzip data", async () => {
  const { shard } = await fixture();
  const source = pack([shard]);
  const before = new AbortController();
  before.abort();
  await expect(download(source, () => undefined, before)).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toEqual([]);
  expect(saved(shard)).toBeUndefined();
  const during = new AbortController();
  await expect(
    download(
      source,
      (progress) => {
        if (progress.downloadedBytes) during.abort();
      },
      during,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(saved(shard)).toBeUndefined();
});

test("removing a gzip download during its final cache write drains the write before deleting the saved file", async () => {
  const { shard } = await fixture();
  const source = pack([shard]);
  responses.set(base, new Response(JSON.stringify(manifest(source))));
  const store = new ReferenceStore(async (bytes) => new SQL.Database(bytes));
  expect((await store.initialize(base))[0].pack.shards[0].compression).toEqual(shard.compression);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforePut = async (name) => {
    if (name === REFERENCE_CACHE) {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = store.download(source.id, () => undefined).catch((error: Error) => error.name);
  await entered.promise;
  const removal = store.remove(source.id);
  release.resolve();
  expect(await pending).toBe("AbortError");
  expect((await removal)[0]).toMatchObject({ enabled: false, status: "available", downloadedBytes: 0 });
  expect(saved(shard)).toBeUndefined();
});

test("manifest compression metadata accepts bounded legacy/gzip files and rejects unsupported or unbounded decoding", async () => {
  const raw = await fixture(false);
  const gzip = await fixture();
  expect(validateReferenceManifest(manifest(pack([raw.shard, gzip.shard])), base).packs[0].shards).toHaveLength(2);
  const valid = gzip.shard.compression!;
  const invalid: unknown[] = [
    null,
    [],
    "gzip",
    {},
    { ...valid, format: "brotli" },
    { ...valid, uncompressedBytes: 0 },
    { ...valid, uncompressedBytes: -1 },
    { ...valid, uncompressedBytes: 1.5 },
    { ...valid, uncompressedBytes: MAX_REFERENCE_SHARD_BYTES + 1 },
    { ...valid, uncompressedBytes: Number.POSITIVE_INFINITY },
    { ...valid, uncompressedSha256: "x".repeat(64) },
    { ...valid, uncompressedSha256: "abc" },
    { ...valid, uncompressedSha256: [valid.uncompressedSha256] },
  ];
  for (const compression of invalid) {
    const input = manifest(pack([{ ...gzip.shard, compression } as ReferenceShard]));
    expect(() => validateReferenceManifest(input, base)).toThrow(/compression/);
  }
});
