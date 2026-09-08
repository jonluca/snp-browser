import type { AnnotationSource, ReferenceManifest } from "../types/annotations";
import { validateReferenceRouting } from "./referenceRouting";

export const REFERENCE_SCHEMA_VERSION = 1;
export const MAX_REFERENCE_SHARD_BYTES = 128 * 1024 * 1024;
export const ANNOTATION_SOURCES: AnnotationSource[] = [
  "clinvar",
  "dbsnp",
  "gnomad",
  "gwas",
  "ensembl",
  "clinpgx",
  "cpic",
];

export function publicReferenceUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Reference assets must use public HTTP or HTTPS URLs.");
  }
  return url.href;
}

export function validateReferenceManifest(input: unknown, base: string): ReferenceManifest {
  if (!input || typeof input !== "object") throw new Error("Invalid reference manifest.");
  const manifest = input as ReferenceManifest;
  if (manifest.schemaVersion !== REFERENCE_SCHEMA_VERSION || !Array.isArray(manifest.packs)) {
    throw new Error("This reference catalog requires a different application version.");
  }
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("The reference catalog has no valid release date.");
  }
  const ids = new Set<string>();
  for (const pack of manifest.packs) {
    if (!pack || !/^[a-z0-9][a-z0-9._-]*$/i.test(pack.id) || ids.has(pack.id)) {
      throw new Error("Reference pack identifiers must be unique.");
    }
    ids.add(pack.id);
    if (pack.sourceRelease !== undefined && (typeof pack.sourceRelease !== "string" || !pack.sourceRelease.trim())) {
      throw new Error(`Reference pack ${pack.id} has an invalid source release.`);
    }
    if (!ANNOTATION_SOURCES.includes(pack.source)) throw new Error(`Unknown reference source: ${pack.source}`);
    for (const key of [
      "name",
      "description",
      "version",
      "builtAt",
      "homepage",
      "license",
      "licenseUrl",
      "attribution",
      "coverage",
    ] as const) {
      if (typeof pack[key] !== "string" || !pack[key].trim())
        throw new Error(`Reference pack ${pack.id} is missing ${key}.`);
    }
    publicReferenceUrl(pack.homepage, base);
    publicReferenceUrl(pack.licenseUrl, base);
    if (!Number.isFinite(Date.parse(pack.builtAt)) || !Array.isArray(pack.shards) || !pack.shards.length) {
      throw new Error(`Reference pack ${pack.id} has no usable data files.`);
    }
    let records = 0;
    let bytes = 0;
    const shardUrls = new Set<string>();
    for (const shard of pack.shards) {
      validateReferenceRouting(shard?.routing);
      if (
        !shard ||
        typeof shard.url !== "string" ||
        typeof shard.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(shard.sha256)
      ) {
        throw new Error(`Reference pack ${pack.id} has an invalid integrity checksum.`);
      }
      const url = publicReferenceUrl(shard.url, base);
      if (shardUrls.has(url)) throw new Error(`Reference pack ${pack.id} repeats a data file.`);
      shardUrls.add(url);
      if (!Number.isSafeInteger(shard.bytes) || shard.bytes <= 0 || shard.bytes > MAX_REFERENCE_SHARD_BYTES) {
        throw new Error(`Reference files must be at most ${MAX_REFERENCE_SHARD_BYTES / 1024 / 1024} MB each.`);
      }
      if (shard.compression !== undefined) {
        const compression = shard.compression;
        if (
          !compression ||
          typeof compression !== "object" ||
          Array.isArray(compression) ||
          compression.format !== "gzip" ||
          !Number.isSafeInteger(compression.uncompressedBytes) ||
          compression.uncompressedBytes <= 0 ||
          compression.uncompressedBytes > MAX_REFERENCE_SHARD_BYTES ||
          typeof compression.uncompressedSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(compression.uncompressedSha256)
        ) {
          throw new Error(
            `Reference pack ${pack.id} has invalid compression metadata or an oversized uncompressed file.`,
          );
        }
      }
      if (!Number.isSafeInteger(shard.records) || shard.records < 0) throw new Error("Invalid reference record count.");
      records += shard.records;
      bytes += shard.bytes;
    }
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(records) || records !== pack.recordCount) {
      throw new Error(`Reference pack ${pack.id} has inconsistent record counts.`);
    }
  }
  return manifest;
}
