import type { ReferenceShard } from "../types/annotations";
import { normalizeAssembly, normalizeChromosome, normalizePosition, normalizeRsid } from "../utils/variantIdentity";

export const MAX_REFERENCE_ROUTING_BYTES = 16 * 1024 * 1024;
const FNV_OFFSET = 2166136261;
const FNV_SECOND_OFFSET = (FNV_OFFSET ^ 0x9e3779b9) >>> 0;
const FNV_PRIME = 16777619;
const HASH_COUNT = 7;
const encoder = new TextEncoder();
type Routing = NonNullable<ReferenceShard["routing"]>;

interface DecodedRouting {
  bitCount: number;
  encoded: string;
  bytes: Uint8Array;
}

// Weak references let old catalog indexes be collected when a release changes.
const decodedRouting = new WeakMap<object, DecodedRouting>();

function decodeRouting(input: unknown): DecodedRouting {
  if (!input || typeof input !== "object") throw new Error("Invalid reference routing index.");
  const routing = input as Routing;
  if (
    routing.algorithm !== "fnv1a-double-v1" ||
    routing.hashes !== HASH_COUNT ||
    !Number.isSafeInteger(routing.bitCount) ||
    routing.bitCount < 1024 ||
    routing.bitCount % 8 !== 0 ||
    routing.bitCount / 8 > MAX_REFERENCE_ROUTING_BYTES ||
    typeof routing.bits !== "string"
  )
    throw new Error("Unsupported or oversized reference routing index.");
  const cached = decodedRouting.get(input);
  if (cached?.bitCount === routing.bitCount && cached.encoded === routing.bits) return cached;

  const byteCount = routing.bitCount / 8;
  if (routing.bits.length !== 4 * Math.ceil(byteCount / 3)) {
    throw new Error("A reference routing index has invalid base64 data.");
  }
  let binary: string;
  try {
    binary = atob(routing.bits);
  } catch {
    throw new Error("A reference routing index has invalid base64 data.");
  }
  if (binary.length !== byteCount || btoa(binary) !== routing.bits) {
    throw new Error("A reference routing index has an inconsistent bit count.");
  }
  const bytes = new Uint8Array(byteCount);
  for (let index = 0; index < byteCount; index++) bytes[index] = binary.charCodeAt(index);
  const result = { bitCount: routing.bitCount, encoded: routing.bits, bytes };
  decodedRouting.set(input, result);
  return result;
}

/** Missing routing is a supported legacy format; malformed routing must fail visibly. */
export function validateReferenceRouting(input: unknown): void {
  if (input !== undefined) decodeRouting(input);
}

function keyHashes(key: string): [number, number] {
  let first = FNV_OFFSET;
  let second = FNV_SECOND_OFFSET;
  // rsIDs, genome locations, and most gene symbols are ASCII. Avoid allocating
  // a UTF-8 buffer for every key in a genome-wide match.
  let ascii = true;
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code > 127) {
      ascii = false;
      break;
    }
    first = Math.imul(first ^ code, FNV_PRIME) >>> 0;
    second = Math.imul(second ^ code, FNV_PRIME) >>> 0;
  }
  if (!ascii) {
    first = FNV_OFFSET;
    second = FNV_SECOND_OFFSET;
    for (const code of encoder.encode(key)) {
      first = Math.imul(first ^ code, FNV_PRIME) >>> 0;
      second = Math.imul(second ^ code, FNV_PRIME) >>> 0;
    }
  }
  return [first, (second | 1) >>> 0];
}

export interface PreparedReferenceKeys {
  readonly keys: readonly string[];
  /** Internal precomputed hashes. Callers must not mutate this array. */
  readonly hashes: Uint32Array;
}

type LookupKeys = readonly string[] | PreparedReferenceKeys;

/** Compute hashes once for a batch reused across many shards. No user data is persisted. */
export function prepareReferenceKeys(keys: readonly string[]): PreparedReferenceKeys {
  const snapshot = Object.freeze([...keys]);
  const hashes = new Uint32Array(snapshot.length * 2);
  for (let index = 0; index < snapshot.length; index++) {
    const [first, second] = keyHashes(snapshot[index]);
    hashes[index * 2] = first;
    hashes[index * 2 + 1] = second;
  }
  return { keys: snapshot, hashes };
}

function isPrepared(keys: LookupKeys): keys is PreparedReferenceKeys {
  return !Array.isArray(keys);
}

function containsHashes(routing: DecodedRouting, first: number, second: number): boolean {
  for (let index = 0; index < HASH_COUNT; index++) {
    // The unsigned 32-bit wrap happens BEFORE reduction, identically in Python.
    const bit = ((first + index * second) >>> 0) % routing.bitCount;
    if ((routing.bytes[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

/** False means none of these exact lookup keys can occur; true still requires SQL verification. */
export function shardMayContain(shard: ReferenceShard, keys: LookupKeys): boolean {
  if (shard.routing === undefined) return true;
  const routing = decodeRouting(shard.routing);
  const prepared = isPrepared(keys);
  const values = prepared ? keys.keys : keys;
  for (let index = 0; index < values.length; index++) {
    const [first, second] = prepared ? [keys.hashes[index * 2], keys.hashes[index * 2 + 1]] : keyHashes(values[index]);
    if (containsHashes(routing, first, second)) return true;
  }
  return false;
}

/** Reduce SQL work to possible hits, while retaining every true hit and legacy-pack key. */
export function filterReferenceKeys(shard: ReferenceShard, keys: LookupKeys): string[] {
  const prepared = isPrepared(keys);
  const values = prepared ? keys.keys : keys;
  if (shard.routing === undefined) return [...values];
  const routing = decodeRouting(shard.routing);
  const result: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const [first, second] = prepared ? [keys.hashes[index * 2], keys.hashes[index * 2 + 1]] : keyHashes(values[index]);
    if (containsHashes(routing, first, second)) result.push(values[index]);
  }
  return result;
}

interface ReferenceLocation {
  assembly?: unknown;
  chromosome?: unknown;
  position?: unknown;
}

export function referenceLookupKeys(
  rsid?: string,
  location?: ReferenceLocation,
  genes: readonly string[] = [],
): string[] {
  const keys = new Set<string>();
  const normalizedRsid = normalizeRsid(rsid);
  if (normalizedRsid) keys.add(`r:${normalizedRsid}`);
  const assembly = normalizeAssembly(location?.assembly);
  const chromosome = normalizeChromosome(location?.chromosome);
  const position = normalizePosition(location?.position);
  if (assembly && chromosome && position) keys.add(`l:${assembly}:${chromosome}:${position}`);
  for (const value of genes) {
    for (const gene of value.split(/[,;|]|\s+-\s+/)) if (gene.trim()) keys.add(`g:${gene.trim().toUpperCase()}`);
  }
  return [...keys];
}
