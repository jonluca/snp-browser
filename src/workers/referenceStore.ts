import type { Database } from "sql.js";
import type {
  AnnotationEvidence,
  AnnotationMatchSummary,
  ReferenceDownloadProgress,
  ReferenceManifest,
  ReferencePack,
  ReferencePackState,
  ReferenceShard,
  VariantAnnotation,
} from "../types/annotations";
import type { UserGenotype } from "../types/snp";
import { MAX_REFERENCE_EXPORT_ROWS, type SNPSearchFilters } from "./snpSearch";
import {
  matchVariantAnnotation,
  normalizeAssembly,
  normalizeChromosome,
  normalizePosition,
  normalizeRsid,
} from "../utils/variantIdentity";
import { publicReferenceUrl, validateReferenceManifest } from "./referenceManifest";
import {
  cachedReferenceBytes,
  cachedReferenceSize,
  downloadReferencePack,
  referenceCache,
  referenceCacheKey,
  REFERENCE_CACHE,
  REFERENCE_SETTINGS_CACHE,
} from "./referenceCache";
import {
  lookupReferenceAliases,
  lookupReferenceAnnotations,
  lookupReferenceCoordinates,
  type ReferenceLocation,
  lookupReferenceGenes,
  referenceAnnotationOrder,
  searchReferenceAnnotations,
} from "./referenceQueries";
import {
  filterReferenceKeys,
  prepareReferenceKeys,
  referenceLookupKeys,
  shardMayContain,
  type PreparedReferenceKeys,
} from "./referenceRouting";

export function referenceLocation(value: {
  assembly?: string;
  chromosome?: string;
  position?: string | number;
}): ReferenceLocation | undefined {
  const assembly = normalizeAssembly(value.assembly);
  const chromosome = normalizeChromosome(value.chromosome);
  const position = normalizePosition(value.position);
  return assembly && chromosome && position ? { assembly, chromosome, position } : undefined;
}
const locationKey = (location: ReferenceLocation) => `${location.assembly}:${location.chromosome}:${location.position}`;
const geneSymbols = (value: string) =>
  value
    .split(/[,;|]|\s+-\s+/)
    .map((gene) => gene.trim())
    .filter((gene) => /^[A-Za-z][A-Za-z0-9.-]*$/.test(gene));
function callSignature(user: UserGenotype): string {
  const complements: Record<string, string> = { A: "T", T: "A", C: "G", G: "C" };
  const orient = (value: string) =>
    value
      .toUpperCase()
      .split("")
      .map((base) => (user.strand === "minus" ? (complements[base] ?? base) : base))
      .join("");
  return JSON.stringify([
    normalizeAssembly(user.assembly),
    normalizeChromosome(user.chromosome),
    normalizePosition(user.position),
    orient(user.genotype).split("").sort().join(""),
    user.ref ? orient(user.ref) : undefined,
    user.strand === "plus" || user.strand === "minus" ? "plus" : "unknown",
  ]);
}

type IndexedUsers = UserGenotype | UserGenotype[];

function indexUser(index: Map<string, IndexedUsers>, key: string, user: UserGenotype): void {
  const existing = index.get(key);
  if (!existing) index.set(key, user);
  else if (Array.isArray(existing)) existing.push(user);
  else index.set(key, [existing, user]);
}

function matchingKeys(
  canonicalUsers: Map<string, IndexedUsers>,
  byLocation: Map<string, IndexedUsers>,
): PreparedReferenceKeys {
  const keys: string[] = [];
  for (const id of canonicalUsers.keys()) {
    const rsid = normalizeRsid(id);
    if (rsid) keys.push(`r:${rsid}`);
  }
  // The locus index already owns these strings; reuse them for shard routing.
  for (const key of byLocation.keys()) keys.push(key);
  return prepareReferenceKeys(keys);
}

function ambiguousUsers(...indexes: Map<string, IndexedUsers>[]): Set<string> {
  const ambiguous = new Set<string>();
  for (const index of indexes) {
    for (const users of index.values()) {
      if (!Array.isArray(users)) continue;
      const signature = callSignature(users[0]);
      for (let position = 1; position < users.length; position++) {
        if (callSignature(users[position]) === signature) continue;
        for (const user of users) ambiguous.add(user.rsid.toLowerCase());
        break;
      }
    }
  }
  return ambiguous;
}

export class ReferenceStore {
  private openDatabase: (bytes: Uint8Array) => Promise<Database>;
  private manifest: ReferenceManifest | null = null;
  private manifestUrl = "";
  private states = new Map<string, ReferencePackState>();
  private queue: Promise<unknown> = Promise.resolve();
  private downloads = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private clearing: Promise<ReferencePackState[]> | null = null;
  private removals = new Map<string, Promise<ReferencePackState[]>>();
  private searchGeneration = 0;
  private latestSearchId?: string;

  constructor(openDatabase: (bytes: Uint8Array) => Promise<Database>) {
    this.openDatabase = openDatabase;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private settingsKey(): string {
    const url = new URL(this.manifestUrl);
    url.searchParams.set("__reference_settings", "enabled-packs");
    return url.href;
  }

  private async persistSelection(): Promise<void> {
    const cache = await caches.open(REFERENCE_SETTINGS_CACHE);
    const enabled = this.getStates()
      .filter((state) => state.enabled)
      .map((state) => `${state.pack.id}@${state.pack.version}`);
    await cache.put(this.settingsKey(), new Response(JSON.stringify(enabled)));
  }

  async initialize(url: string): Promise<ReferencePackState[]> {
    ++this.searchGeneration;
    return this.serialize(async () => {
      if (this.clearing)
        throw new Error("Wait for reference downloads to finish clearing before refreshing the catalog.");
      if (this.removals.size)
        throw new Error("Wait for reference downloads to finish removing before refreshing the catalog.");
      if (!("caches" in globalThis))
        throw new Error("Reference downloads require browser storage on HTTPS or localhost.");
      if (this.downloads.size)
        throw new Error("Wait for the current reference download to finish before refreshing the catalog.");
      // Keep the old catalog and asset base intact until every refresh step
      // succeeds. Queries already in the queue finish against one catalog.
      const manifestUrl = publicReferenceUrl(url, globalThis.location?.href ?? "http://localhost/");
      const cache = await caches.open(REFERENCE_SETTINGS_CACHE);
      let manifest: ReferenceManifest;
      try {
        const response = await fetch(manifestUrl, { credentials: "omit", cache: "no-cache" });
        if (!response.ok) throw new Error(`Reference catalog unavailable (${response.status}).`);
        manifest = validateReferenceManifest(await response.json(), manifestUrl);
        await cache.put(manifestUrl, new Response(JSON.stringify(manifest)));
      } catch (error) {
        const cached = await cache.match(manifestUrl);
        if (!cached) throw error;
        manifest = validateReferenceManifest(await cached.json(), manifestUrl);
      }
      const settingsUrl = new URL(manifestUrl);
      settingsUrl.searchParams.set("__reference_settings", "enabled-packs");
      const saved = await cache.match(settingsUrl.href);
      const enabled: unknown = saved ? await saved.json().catch(() => []) : [];
      const selected = new Set(Array.isArray(enabled) ? enabled.filter((item) => typeof item === "string") : []);
      const states = new Map<string, ReferencePackState>();
      for (const pack of manifest.packs) {
        const totalBytes = pack.shards.reduce((sum, shard) => sum + shard.bytes, 0);
        const downloadedBytes = await cachedReferenceSize(pack, manifestUrl);
        const ready = downloadedBytes === totalBytes;
        states.set(pack.id, {
          pack,
          status: ready ? "ready" : "available",
          totalBytes,
          downloadedBytes,
          enabled: ready && selected.has(`${pack.id}@${pack.version}`),
        });
      }
      this.manifestUrl = manifestUrl;
      this.manifest = manifest;
      this.states = states;
      return this.getStates();
    });
  }

  getStates(): ReferencePackState[] {
    // Routing indexes stay in the worker; UI updates need only download metadata.
    return [...this.states.values()].map((state) => ({
      ...state,
      pack: {
        ...state.pack,
        shards: state.pack.shards.map((shard) => ({
          url: shard.url,
          bytes: shard.bytes,
          sha256: shard.sha256,
          records: shard.records,
          ...(shard.compression ? { compression: { ...shard.compression } } : {}),
        })),
      },
    }));
  }

  private packState(id: string): ReferencePackState {
    const state = this.states.get(id);
    if (!state) throw new Error("This dataset is not in the installed reference catalog.");
    return state;
  }

  async download(id: string, onProgress: (progress: ReferenceDownloadProgress) => void): Promise<ReferencePackState[]> {
    // Register against the catalog selected by prior queued operations, but do
    // not hold the query queue during network I/O or completion's setEnabled.
    const active = await this.serialize(async () => {
      if (this.clearing) throw new Error("Wait for reference downloads to finish clearing before downloading again.");
      if (this.removals.has(id))
        throw new Error("Wait for this reference download to finish removing before downloading again.");
      const existing = this.downloads.get(id);
      if (existing) return existing;
      const state = this.packState(id);
      const controller = new AbortController();
      const promise = (async () => {
        state.status = "downloading";
        state.enabled = false;
        state.error = undefined;
        try {
          await downloadReferencePack(
            state.pack,
            this.manifestUrl,
            (progress) => {
              state.downloadedBytes = progress.downloadedBytes;
              onProgress(progress);
            },
            controller.signal,
          );
          state.status = "ready";
          state.downloadedBytes = state.totalBytes;
          await this.setEnabled(id, true);
        } catch (error) {
          state.status = "error";
          state.enabled = false;
          state.error = error instanceof Error ? error.message : "Reference download failed.";
          throw error;
        } finally {
          this.downloads.delete(id);
        }
      })();
      const registered = { controller, promise };
      this.downloads.set(id, registered);
      return registered;
    });
    await active.promise;
    return this.getStates();
  }

  async setEnabled(id: string, enabled: boolean): Promise<ReferencePackState[]> {
    return this.serialize(async () => {
      if (this.clearing) throw new Error("Wait for reference downloads to finish clearing before changing sources.");
      if (this.removals.has(id))
        throw new Error("Wait for this reference download to finish removing before changing sources.");
      const state = this.packState(id);
      if (enabled && state.status !== "ready") throw new Error("Download the complete dataset before enabling it.");
      // A single release per source avoids duplicating or mixing interpretations.
      if (enabled)
        for (const other of this.states.values()) if (other.pack.source === state.pack.source) other.enabled = false;
      state.enabled = enabled;
      await this.persistSelection();
      return this.getStates();
    });
  }

  clear(): Promise<ReferencePackState[]> {
    if (this.clearing) return this.clearing;
    ++this.searchGeneration;
    const active = [...this.downloads.values()];
    for (const download of active) download.controller.abort();
    // Reserve the clearing operation immediately so queued/new download starts
    // cannot create files after the snapshot above or after cache deletion.
    this.clearing = (async () => {
      await Promise.allSettled(active.map((download) => download.promise));
      return this.serialize(async () => {
        await caches.delete(REFERENCE_CACHE);
        for (const state of this.states.values()) {
          state.status = "available";
          state.downloadedBytes = 0;
          state.enabled = false;
          state.error = undefined;
        }
        // Retain cached manifests for offline browsing, clearing selections for
        // every catalog alongside orphaned assets from previous releases.
        const settings = await caches.open(REFERENCE_SETTINGS_CACHE);
        for (const request of await settings.keys())
          if (new URL(request.url).searchParams.get("__reference_settings") === "enabled-packs")
            await settings.delete(request);
        return this.getStates();
      });
    })().finally(() => {
      this.clearing = null;
    });
    return this.clearing;
  }

  remove(id: string): Promise<ReferencePackState[]> {
    if (this.clearing) return this.clearing;
    const removing = this.removals.get(id);
    if (removing) return removing;
    const active = this.downloads.get(id);
    active?.controller.abort();
    const operation = (async () => {
      await active?.promise.catch(() => undefined);
      return this.serialize(async () => {
        const state = this.packState(id);
        state.enabled = false;
        const cache = await referenceCache();
        const retained = new Set(
          this.getStates()
            .filter((other) => other.pack.id !== id && (other.status === "ready" || other.downloadedBytes > 0))
            .flatMap((other) => other.pack.shards.map((shard) => referenceCacheKey(shard, this.manifestUrl))),
        );
        for (const shard of state.pack.shards) {
          const key = referenceCacheKey(shard, this.manifestUrl);
          if (!retained.has(key)) await cache.delete(key);
        }
        state.status = "available";
        state.downloadedBytes = 0;
        state.error = undefined;
        await this.persistSelection();
        return this.getStates();
      });
    })().finally(() => {
      this.removals.delete(id);
    });
    this.removals.set(id, operation);
    return operation;
  }

  private enabledPacks(): ReferencePack[] {
    return [...this.states.values()]
      .filter((state) => state.enabled && state.status === "ready")
      .map((state) => state.pack);
  }

  private async scan(
    pack: ReferencePack,
    operation: (database: Database, shard: ReferenceShard) => void,
    keys?: PreparedReferenceKeys,
  ): Promise<void> {
    for (const shard of pack.shards) {
      if (keys && !shardMayContain(shard, keys)) continue;
      // Querying never fetches: all data must already be downloaded and verified.
      let database: Database | undefined;
      try {
        database = await this.openDatabase(await cachedReferenceBytes(shard, this.manifestUrl));
        operation(database, shard);
      } catch (error) {
        const state = this.packState(pack.id);
        state.status = "error";
        state.enabled = false;
        state.error = error instanceof Error ? error.message : "Unable to read the reference dataset.";
        throw error;
      } finally {
        database?.close();
      }
    }
  }

  cancelSearch(searchId?: string): void {
    if (searchId && searchId !== this.latestSearchId) return;
    ++this.searchGeneration;
  }

  async search(
    packId: string,
    filters: SNPSearchFilters,
  ): Promise<{ annotations: VariantAnnotation[]; total: number }> {
    // Allocate before joining the queue: obsolete queued work must not begin a
    // scan, and an active scan stops after its current asynchronous file read.
    const generation = filters.referenceExport ? this.searchGeneration : ++this.searchGeneration;
    if (!filters.referenceExport) this.latestSearchId = filters.referenceSearchId;
    const checkCurrent = () => {
      if (!filters.referenceExport && generation !== this.searchGeneration) {
        const error = new Error("This search was replaced by a newer request.");
        error.name = "AbortError";
        throw error;
      }
    };
    return this.serialize(async () => {
      checkCurrent();
      const state = this.packState(packId);
      if (state.status !== "ready") throw new Error("Download this reference dataset before browsing it.");
      const limit = Math.max(0, Math.trunc(filters.limit ?? 100));
      const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
      if (!Number.isSafeInteger(limit + offset)) throw new Error("Invalid reference result range.");
      const rejectLargeExport = (rows: number) => {
        if (filters.referenceExport && rows > MAX_REFERENCE_EXPORT_ROWS) {
          throw new Error("Source CSV exports support up to 100,000 records. Narrow the search before exporting.");
        }
      };
      rejectLargeExport(limit + offset);
      const term = filters.searchTerm?.trim();
      const mode = filters.referenceSearchMode ?? "variant";
      const unfiltered = ![term, filters.chromosome, filters.gene, filters.clinicalSignificance, filters.disease].some(
        (value) => value?.trim(),
      );
      const sourceOrder = unfiltered && (!filters.sortBy || filters.sortBy === "relevance");
      const exactKeys =
        term && mode !== "all-fields"
          ? prepareReferenceKeys(mode === "gene" ? [`g:${term.toUpperCase()}`] : referenceLookupKeys(term))
          : undefined;
      if (exactKeys && !exactKeys.keys.length) return { annotations: [], total: 0 };

      const readShard = async (shard: ReferenceShard, operation: (database: Database) => void) => {
        checkCurrent();
        let database: Database | undefined;
        try {
          const bytes = await cachedReferenceBytes(shard, this.manifestUrl, checkCurrent);
          checkCurrent();
          database = await this.openDatabase(bytes);
          checkCurrent();
          operation(database);
        } catch (error) {
          // Superseded searches are ordinary navigation, not damaged data.
          if (!(error instanceof Error && error.name === "AbortError")) {
            state.status = "error";
            state.enabled = false;
            state.error = error instanceof Error ? error.message : "Unable to read the reference dataset.";
          }
          throw error;
        } finally {
          database?.close();
        }
      };
      if (sourceOrder) {
        rejectLargeExport(state.pack.recordCount);
        const annotations: VariantAnnotation[] = [];
        let skipped = offset;
        for (const shard of state.pack.shards) {
          checkCurrent();
          if (annotations.length >= limit) break;
          if (skipped >= shard.records) {
            skipped -= shard.records;
            continue;
          }
          await readShard(shard, (database) => {
            const page = searchReferenceAnnotations(
              database,
              { ...filters, limit: limit - annotations.length, offset: skipped },
              { sourceOrder: true, knownTotal: shard.records },
            );
            for (const row of page.annotations) annotations.push(row);
          });
          skipped = 0;
        }
        return { annotations, total: state.pack.recordCount };
      }
      let candidates: VariantAnnotation[] = [];
      let total = 0;
      for (const shard of state.pack.shards) {
        checkCurrent();
        if (exactKeys && !shardMayContain(shard, exactKeys)) continue;
        await readShard(shard, (database) => {
          const page = searchReferenceAnnotations(database, { ...filters, offset: 0, limit: limit + offset });
          total += page.total;
          for (const row of page.annotations) candidates.push(row);
          candidates.sort((a, b) => referenceAnnotationOrder(a, b, filters));
          candidates = candidates.slice(0, limit + offset);
        });
        rejectLargeExport(total);
      }
      return { annotations: candidates.slice(offset, offset + limit), total };
    });
  }

  private async resolveMatchAliases(genotypes: UserGenotype[], packs: ReferencePack[]): Promise<Map<string, string>> {
    const aliases = new Map<string, string>();
    const dbsnpPacks = packs.filter((pack) => pack.source === "dbsnp");
    if (!dbsnpPacks.length) return aliases;
    const keys = new Set<string>();
    for (const user of genotypes) {
      const rsid = normalizeRsid(user.rsid);
      if (rsid) keys.add(`r:${rsid}`);
    }
    if (!keys.size) return aliases;
    const rawKeys = prepareReferenceKeys([...keys]);
    keys.clear();
    for (const pack of dbsnpPacks) {
      await this.scan(
        pack,
        (database, shard) => {
          for (const [alias, canonical] of lookupReferenceAliases(
            database,
            filterReferenceKeys(shard, rawKeys).map((key) => key.slice(2)),
          ))
            aliases.set(alias, canonical);
        },
        rawKeys,
      );
    }
    return aliases;
  }

  async match(
    genotypes: UserGenotype[],
    onProgress: (current: number, total: number) => void,
    summaryOnly = false,
  ): Promise<{ evidence: Map<string, AnnotationEvidence[]>; summaries: Map<string, AnnotationMatchSummary> }> {
    return this.serialize(async () => {
      const packs = this.enabledPacks();
      const evidence = new Map<string, AnnotationEvidence[]>();
      const summaries = new Map<string, AnnotationMatchSummary>();
      if (!packs.length || !genotypes.length) return { evidence, summaries };
      // Resolve aliases before retaining the genome indexes, so temporary alias
      // routing data does not remain live throughout a multi-million-call match.
      const aliases = await this.resolveMatchAliases(genotypes, packs);
      const canonicalUsers = new Map<string, IndexedUsers>();
      const byLocation = new Map<string, IndexedUsers>();
      const genes = new Map<string, Set<string>>();
      for (const user of genotypes) {
        const rsid = user.rsid.toLowerCase();
        indexUser(canonicalUsers, aliases.get(rsid) ?? rsid, user);
        const location = referenceLocation(user);
        if (location) indexUser(byLocation, `l:${locationKey(location)}`, user);
      }
      const candidateKeys = matchingKeys(canonicalUsers, byLocation);
      // Both complete indexes must be checked before the first annotation is
      // added, including conflicting calls far apart in the uploaded file.
      const ambiguous = ambiguousUsers(canonicalUsers, byLocation);
      const seen = new Map<string, Set<string>>();
      const add = (rsid: string, annotation: AnnotationEvidence) => {
        const key = rsid.toLowerCase();
        const ids = seen.get(key) ?? new Set<string>();
        const id = `${annotation.source}:${annotation.id}`;
        if (ids.has(id)) return;
        ids.add(id);
        seen.set(key, ids);
        const summary = summaries.get(key) ?? { sources: [], count: 0, alleleCount: 0, unresolvedCount: 0, genes: [] };
        if (!summary.sources.includes(annotation.source)) summary.sources.push(annotation.source);
        summary.count++;
        if (annotation.matchType === "allele") summary.alleleCount++;
        if (annotation.matchType === "unresolved") summary.unresolvedCount++;
        if (annotation.gene && !summary.genes.includes(annotation.gene)) summary.genes.push(annotation.gene);
        summaries.set(key, { ...summary, ambiguous: ambiguous.has(key) });
        if (!summaryOnly) {
          const entries = evidence.get(key) ?? [];
          entries.push(annotation);
          evidence.set(key, entries);
        }
      };
      let completed = 0;
      const genePacks = packs.filter((pack) => pack.source === "cpic" || pack.source === "clinpgx");
      const total = [...packs, ...genePacks].reduce((sum, pack) => sum + pack.shards.length, 0);
      for (const pack of packs) {
        await this.scan(
          pack,
          (database, shard) => {
            const possible = filterReferenceKeys(shard, candidateKeys);
            const ids: string[] = [];
            const coordinates: ReferenceLocation[] = [];
            for (const key of possible) {
              if (key.startsWith("r:")) ids.push(key.slice(2));
              else {
                const group = byLocation.get(key);
                const representative = Array.isArray(group) ? group[0] : group;
                const location = representative && referenceLocation(representative);
                if (location) coordinates.push(location);
              }
            }
            const found = new Map(
              [...lookupReferenceAnnotations(database, ids), ...lookupReferenceCoordinates(database, coordinates)].map(
                (annotation) => [annotation.id, annotation],
              ),
            );
            for (const annotation of found.values()) {
              const locus = referenceLocation(annotation);
              const users = new Set<UserGenotype>();
              for (const group of [
                canonicalUsers.get(annotation.rsid?.toLowerCase() ?? ""),
                locus ? byLocation.get(`l:${locationKey(locus)}`) : undefined,
              ]) {
                if (Array.isArray(group)) for (const user of group) users.add(user);
                else if (group) users.add(group);
              }
              for (const user of users) {
                const identity = ambiguous.has(user.rsid.toLowerCase())
                  ? {
                      matchType: "unresolved" as const,
                      matchReason: "This file contains conflicting calls or coordinates for the same variant.",
                    }
                  : matchVariantAnnotation(
                      { ...user, rsid: aliases.get(user.rsid.toLowerCase()) ?? user.rsid },
                      annotation,
                    );
                add(user.rsid, {
                  ...annotation,
                  fields: {
                    ...annotation.fields,
                    sourceVersion: pack.version,
                    referenceBuiltAt: pack.builtAt,
                    upstreamRelease: pack.sourceRelease ?? null,
                  },
                  ...identity,
                });
                if (annotation.gene) {
                  for (const gene of geneSymbols(annotation.gene)) {
                    const variants = genes.get(gene.toUpperCase()) ?? new Set<string>();
                    variants.add(user.rsid);
                    genes.set(gene.toUpperCase(), variants);
                  }
                }
              }
            }
            onProgress(++completed, total);
          },
          candidateKeys,
        );
      }
      const geneKeys = prepareReferenceKeys(referenceLookupKeys(undefined, undefined, [...genes.keys()]));
      for (const pack of genePacks) {
        await this.scan(
          pack,
          (database, shard) => {
            for (const annotation of lookupReferenceGenes(
              database,
              filterReferenceKeys(shard, geneKeys).map((key) => key.slice(2)),
            )) {
              const relatedVariants = new Set(
                geneSymbols(annotation.gene ?? "").flatMap((gene) => [...(genes.get(gene.toUpperCase()) ?? [])]),
              );
              for (const rsid of relatedVariants) {
                add(rsid, {
                  ...annotation,
                  fields: {
                    ...annotation.fields,
                    sourceVersion: pack.version,
                    referenceBuiltAt: pack.builtAt,
                    upstreamRelease: pack.sourceRelease ?? null,
                  },
                  matchType: "gene",
                  matchReason:
                    "Gene-level reference evidence. A drug-response phenotype has not been inferred from this variant.",
                });
              }
            }
            onProgress(++completed, total);
          },
          geneKeys,
        );
      }
      onProgress(total, total);
      return { evidence, summaries };
    });
  }

  async lookup(rsid: string, location?: ReferenceLocation): Promise<AnnotationEvidence[]> {
    return this.serialize(async () => {
      const result: AnnotationEvidence[] = [];
      const genes = new Set<string>();
      const seen = new Set<string>();
      const packs = this.enabledPacks();
      let canonical = rsid.toLowerCase();
      for (const pack of packs.filter((pack) => pack.source === "dbsnp")) {
        await this.scan(
          pack,
          (database) => {
            canonical = lookupReferenceAliases(database, [canonical]).get(canonical) ?? canonical;
          },
          prepareReferenceKeys(referenceLookupKeys(canonical)),
        );
      }
      const candidateKeys = prepareReferenceKeys(referenceLookupKeys(canonical, location));
      const add = (annotation: VariantAnnotation) => {
        const key = `${annotation.source}:${annotation.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        result.push({
          ...annotation,
          matchType: annotation.scope === "gene" ? "gene" : "locus",
          matchReason: "Reference information; no uploaded genotype is being interpreted here.",
        });
      };
      for (const pack of packs) {
        await this.scan(
          pack,
          (database) => {
            for (const annotation of [
              ...lookupReferenceAnnotations(database, [canonical]),
              ...lookupReferenceCoordinates(database, location ? [location] : []),
            ]) {
              add({
                ...annotation,
                fields: {
                  ...annotation.fields,
                  sourceVersion: pack.version,
                  referenceBuiltAt: pack.builtAt,
                  upstreamRelease: pack.sourceRelease ?? null,
                },
              });
              if (annotation.gene) for (const gene of geneSymbols(annotation.gene)) genes.add(gene);
            }
          },
          candidateKeys,
        );
      }
      const geneKeys = prepareReferenceKeys(referenceLookupKeys(undefined, undefined, [...genes]));
      for (const pack of packs.filter((pack) => pack.source === "clinpgx" || pack.source === "cpic")) {
        await this.scan(
          pack,
          (database) =>
            lookupReferenceGenes(database, [...genes]).forEach((annotation) =>
              add({
                ...annotation,
                fields: {
                  ...annotation.fields,
                  sourceVersion: pack.version,
                  referenceBuiltAt: pack.builtAt,
                  upstreamRelease: pack.sourceRelease ?? null,
                },
              }),
            ),
          geneKeys,
        );
      }
      return result;
    });
  }

  hasCatalog(): boolean {
    return this.manifest !== null;
  }
}
