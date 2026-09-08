import type { ReferenceDownloadProgress, ReferencePack, ReferenceShard } from "../types/annotations";
import { MAX_REFERENCE_SHARD_BYTES, publicReferenceUrl } from "./referenceManifest";

export const REFERENCE_CACHE = "snp-browser-reference-assets-v1";
export const REFERENCE_SETTINGS_CACHE = "snp-browser-reference-settings-v1";

export async function referenceCache(): Promise<Cache> {
  if (!("caches" in globalThis)) throw new Error("Reference downloads require browser storage on HTTPS or localhost.");
  return caches.open(REFERENCE_CACHE);
}

export async function verifyReferenceBytes(
  bytes: Uint8Array,
  shard: Pick<ReferenceShard, "bytes" | "sha256">,
): Promise<void> {
  if (bytes.byteLength !== shard.bytes) throw new Error("A reference download has an unexpected size. Please retry.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== shard.sha256) throw new Error("A reference checksum did not match. Please download this dataset again.");
}

export function referenceCacheKey(shard: ReferenceShard, base: string): string {
  const url = new URL(publicReferenceUrl(shard.url, base));
  // Cache identity includes the content digest, even if a publisher reuses a path.
  url.searchParams.set("__reference_sha256", shard.sha256);
  return url.href;
}

type CheckCurrent = () => void;
const noCancellation: CheckCurrent = () => undefined;

class ReferenceCompressionUnavailableError extends Error {
  name = "ReferenceCompressionUnavailableError";
  constructor() {
    super("This browser cannot open compressed reference files. Update your browser and try again.");
  }
}

function preserveCachedAsset(error: unknown): boolean {
  return (
    error instanceof ReferenceCompressionUnavailableError ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  expectedBytes: number,
  checkCurrent: CheckCurrent,
  onBytes?: (received: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  checkCurrent();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_REFERENCE_SHARD_BYTES) {
    throw new Error("The reference file has an unsupported size.");
  }
  const reader = body?.getReader();
  if (!reader) throw new Error("This browser could not read the reference file.");
  const bytes = new Uint8Array(expectedBytes);
  let received = 0;
  try {
    while (true) {
      checkCurrent();
      const { done, value } = await reader.read();
      checkCurrent();
      if (done) break;
      if (value.byteLength > expectedBytes - received) throw new Error("The reference file exceeds its declared size.");
      bytes.set(value, received);
      received += value.byteLength;
      onBytes?.(received);
    }
    if (received !== expectedBytes) throw new Error("A reference download has an unexpected size. Please retry.");
    return bytes;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function decompressor(): DecompressionStream {
  try {
    return new DecompressionStream("gzip");
  } catch {
    throw new ReferenceCompressionUnavailableError();
  }
}

async function decodeReferenceBytes(
  bytes: Uint8Array<ArrayBuffer>,
  shard: ReferenceShard,
  checkCurrent: CheckCurrent,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!shard.compression) return bytes;
  checkCurrent();
  const decoder = decompressor();
  let offset = 0;
  // Small input chunks limit decompressor buffering before an output overrun
  // can be observed. Enqueue views, avoiding a Blob/Response copy of the asset.
  const encoded = new ReadableStream<BufferSource>({
    pull(controller) {
      checkCurrent();
      if (offset >= bytes.length) controller.close();
      else {
        const end = Math.min(offset + 16 * 1024, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      }
    },
  });
  const decoded = await readBoundedBytes(
    encoded.pipeThrough(decoder),
    shard.compression.uncompressedBytes,
    checkCurrent,
  );
  checkCurrent();
  await verifyReferenceBytes(decoded, {
    bytes: shard.compression.uncompressedBytes,
    sha256: shard.compression.uncompressedSha256,
  });
  checkCurrent();
  return decoded;
}

async function verifyDecodedReferenceBytes(
  bytes: Uint8Array<ArrayBuffer>,
  shard: ReferenceShard,
  checkCurrent: CheckCurrent,
): Promise<void> {
  // The resolved promise holds no decoded buffer while cache.put saves gzip.
  await decodeReferenceBytes(bytes, shard, checkCurrent);
}

async function cachedStoredReferenceBytes(
  shard: ReferenceShard,
  base: string,
  checkCurrent: CheckCurrent,
): Promise<Uint8Array<ArrayBuffer>> {
  checkCurrent();
  const cache = await referenceCache();
  const key = referenceCacheKey(shard, base);
  const response = await cache.match(key);
  checkCurrent();
  if (!response?.ok)
    throw new Error("A reference file is no longer stored in this browser. Download the dataset again.");
  try {
    const bytes = await readBoundedBytes(response.body, shard.bytes, checkCurrent);
    await verifyReferenceBytes(bytes, shard);
    checkCurrent();
    return bytes;
  } catch (error) {
    checkCurrent();
    if (!preserveCachedAsset(error)) await cache.delete(key);
    throw error;
  }
}

export async function cachedReferenceBytes(
  shard: ReferenceShard,
  base: string,
  checkCurrent: CheckCurrent = noCancellation,
): Promise<Uint8Array> {
  const bytes = await cachedStoredReferenceBytes(shard, base, checkCurrent);
  try {
    return await decodeReferenceBytes(bytes, shard, checkCurrent);
  } catch (error) {
    checkCurrent();
    if (!preserveCachedAsset(error)) {
      const cache = await referenceCache();
      await cache.delete(referenceCacheKey(shard, base));
    }
    throw error;
  }
}

export async function cachedReferenceSize(pack: ReferencePack, base: string): Promise<number> {
  const cache = await referenceCache();
  let bytes = 0;
  for (const shard of pack.shards) {
    const response = await cache.match(referenceCacheKey(shard, base));
    if (response?.ok && response.headers.get("x-reference-sha256") === shard.sha256) bytes += shard.bytes;
  }
  return bytes;
}

export async function downloadReferencePack(
  pack: ReferencePack,
  base: string,
  onProgress: (progress: ReferenceDownloadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const cache = await referenceCache();
  const totalBytes = pack.shards.reduce((sum, shard) => sum + shard.bytes, 0);
  let completed = 0;
  for (const shard of pack.shards) {
    signal.throwIfAborted();
    const key = referenceCacheKey(shard, base);
    if (await cache.match(key)) {
      try {
        // Reuse the already-validated encoded asset without inflating every
        // installed file merely to resume or repeat a public download.
        await cachedStoredReferenceBytes(shard, base, () => signal.throwIfAborted());
        signal.throwIfAborted();
        completed += shard.bytes;
        onProgress({ packId: pack.id, downloadedBytes: completed, totalBytes });
        continue;
      } catch {
        signal.throwIfAborted();
        // A damaged cached file is replaced from the same public asset URL.
      }
    }
    const response = await fetch(publicReferenceUrl(shard.url, base), { credentials: "omit", signal });
    if (!response.ok) throw new Error(`Reference download failed (${response.status}).`);
    const checkCurrent = () => signal.throwIfAborted();
    const bytes = await readBoundedBytes(response.body, shard.bytes, checkCurrent, (received) => {
      onProgress({ packId: pack.id, downloadedBytes: completed + received, totalBytes });
    });
    await verifyReferenceBytes(bytes, shard);
    signal.throwIfAborted();
    if (shard.compression) await verifyDecodedReferenceBytes(bytes, shard, checkCurrent);
    signal.throwIfAborted();
    try {
      await cache.put(
        key,
        new Response(bytes, {
          headers: {
            "content-type": shard.compression ? "application/gzip" : "application/vnd.sqlite3",
            "x-reference-sha256": shard.sha256,
          },
        }),
      );
    } catch {
      throw new Error(
        "Browser storage could not save this dataset. Free space or remove another reference dataset, then retry.",
      );
    }
    completed += shard.bytes;
    signal.throwIfAborted();
  }
  signal.throwIfAborted();
  onProgress({ packId: pack.id, downloadedBytes: totalBytes, totalBytes });
}
