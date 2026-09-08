import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ReferencePackState } from "../src/types/annotations";
import { REFERENCE_CATALOG_QUERY_KEY, refreshReferenceLibraryState } from "../src/hooks/referenceLibraryState";

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(value);
  return value;
}
function ready(): ReferencePackState {
  return {
    status: "ready",
    enabled: true,
    downloadedBytes: 100,
    totalBytes: 100,
    pack: {
      id: "clinvar",
      source: "clinvar",
      name: "ClinVar",
      description: "Reference state fixture",
      version: "v1",
      builtAt: "2026-09-07T00:00:00Z",
      homepage: "https://reference.test/",
      license: "Fixture",
      licenseUrl: "https://reference.test/license",
      attribution: "Synthetic reference",
      coverage: "Fixture",
      recordCount: 1,
      shards: [],
    },
  };
}
function damaged(): ReferencePackState {
  return {
    ...ready(),
    status: "error",
    enabled: false,
    error: "A reference file is no longer stored in this browser.",
  };
}

test("worker damage state replaces saved status without fetching the catalog again", async () => {
  const cache = client();
  let catalogRequests = 0;
  await cache.fetchQuery({
    queryKey: REFERENCE_CATALOG_QUERY_KEY,
    queryFn: async () => {
      catalogRequests++;
      return [ready()];
    },
  });
  expect(
    await refreshReferenceLibraryState(
      cache,
      async () => [damaged()],
      () => true,
    ),
  ).toBe(true);
  expect(cache.getQueryData(REFERENCE_CATALOG_QUERY_KEY)).toEqual([damaged()]);
  expect(catalogRequests).toBe(1);
});

test("worker refresh retains a failed catalog refresh error alongside the recoverable pack state", async () => {
  const cache = client();
  cache.setQueryData(REFERENCE_CATALOG_QUERY_KEY, [ready()]);
  const error = new Error("The reference catalog could not be refreshed.");
  await expect(
    cache.fetchQuery({
      queryKey: REFERENCE_CATALOG_QUERY_KEY,
      queryFn: async () => {
        throw error;
      },
    }),
  ).rejects.toThrow(error.message);
  await refreshReferenceLibraryState(
    cache,
    async () => [damaged()],
    () => true,
  );
  const state = cache.getQueryState(REFERENCE_CATALOG_QUERY_KEY);
  expect(state?.data).toEqual([damaged()]);
  expect(state?.error).toBe(error);
  expect(state?.status).toBe("error");
});

test("a delayed worker snapshot cannot overwrite a newer download or selection change", async () => {
  const cache = client();
  cache.setQueryData(REFERENCE_CATALOG_QUERY_KEY, [ready()]);
  const response = Promise.withResolvers<ReferencePackState[]>();
  const refreshing = refreshReferenceLibraryState(
    cache,
    () => response.promise,
    () => true,
  );
  const newer = [{ ...ready(), status: "downloading" as const, enabled: false }];
  cache.setQueryData(REFERENCE_CATALOG_QUERY_KEY, newer);
  response.resolve([damaged()]);
  expect(await refreshing).toBe(false);
  expect(cache.getQueryData(REFERENCE_CATALOG_QUERY_KEY)).toEqual(newer);
});

test("navigation cancellation discards late state and unchanged snapshots do not publish another cache update", async () => {
  const cache = client();
  cache.setQueryData(REFERENCE_CATALOG_QUERY_KEY, [ready()]);
  let updates = 0;
  const unsubscribe = cache.getQueryCache().subscribe(() => {
    updates++;
  });
  expect(
    await refreshReferenceLibraryState(
      cache,
      async () => [damaged()],
      () => false,
    ),
  ).toBe(false);
  expect(
    await refreshReferenceLibraryState(
      cache,
      async () => [ready()],
      () => true,
    ),
  ).toBe(false);
  expect(updates).toBe(0);
  expect(cache.getQueryData(REFERENCE_CATALOG_QUERY_KEY)).toEqual([ready()]);
  unsubscribe();
});

test("state refresh waits for catalog initialization and failed reads preserve cached data", async () => {
  const cache = client();
  let calls = 0;
  const read = async () => {
    calls++;
    return [damaged()];
  };
  expect(await refreshReferenceLibraryState(cache, read, () => true)).toBe(false);
  expect(calls).toBe(0);
  cache.setQueryData(REFERENCE_CATALOG_QUERY_KEY, [ready()]);
  await expect(
    refreshReferenceLibraryState(
      cache,
      async () => {
        throw new Error("Worker disconnected");
      },
      () => true,
    ),
  ).rejects.toThrow("Worker disconnected");
  expect(cache.getQueryData(REFERENCE_CATALOG_QUERY_KEY)).toEqual([ready()]);
});
