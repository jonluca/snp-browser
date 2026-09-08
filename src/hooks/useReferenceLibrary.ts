import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Remote } from "comlink";
import { proxy } from "comlink";
import type { SNPMatcherWorkerApi } from "../workers/snpMatcher.worker";
import type { ReferenceDownloadProgress, ReferencePackState } from "../types/annotations";
import { REFERENCE_MANIFEST_URL } from "../constants";
import { REFERENCE_CATALOG_QUERY_KEY as CATALOG_KEY, refreshReferenceLibraryState } from "./referenceLibraryState";

type LibraryAction =
  | { kind: "clear" }
  | { kind: "download"; id: string }
  | { kind: "remove"; id: string }
  | { kind: "toggle"; id: string; enabled: boolean };

export function useReferenceLibrary(api: Remote<SNPMatcherWorkerApi> | null, visible = false) {
  const client = useQueryClient();
  const [progress, setProgress] = useState<ReferenceDownloadProgress | null>(null);
  const [revision, setRevision] = useState(0);
  const [stateRefreshError, setStateRefreshError] = useState<Error | null>(null);
  const catalog = useQuery({
    queryKey: CATALOG_KEY,
    enabled: Boolean(api),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () => api!.initializeReferenceCatalog(REFERENCE_MANIFEST_URL),
    retry: false,
  });
  const canRefreshState = catalog.data !== undefined && !catalog.isFetching;
  useEffect(() => {
    if (!api || !visible || !canRefreshState) return;
    let current = true;
    void refreshReferenceLibraryState(
      client,
      () => api.getReferenceStates(),
      () => current,
    )
      .then((changed) => {
        if (!current) return;
        setStateRefreshError(null);
        if (changed) setRevision((value) => value + 1);
      })
      .catch((error: unknown) => {
        if (current)
          setStateRefreshError(
            error instanceof Error ? error : new Error("Unable to refresh reference download states."),
          );
      });
    return () => {
      current = false;
    };
  }, [api, visible, canRefreshState, client]);
  const operation = useMutation({
    mutationFn: async (action: LibraryAction) => {
      if (!api) throw new Error("The reference worker is still starting.");
      if (action.kind === "clear") return api.clearReferencePacks();
      if (action.kind === "download") {
        let reported = -1;
        return api.downloadReferencePack(
          action.id,
          proxy((value: ReferenceDownloadProgress) => {
            const percent = Math.floor((value.downloadedBytes / value.totalBytes) * 100);
            if (percent !== reported) {
              reported = percent;
              setProgress(value);
            }
          }),
        );
      }
      if (action.kind === "remove") return api.removeReferencePack(action.id);
      return api.setReferenceEnabled(action.id, action.enabled);
    },
    onMutate: (action) => {
      if (action.kind === "download") {
        client.setQueryData<ReferencePackState[]>(CATALOG_KEY, (states) =>
          states?.map((state) =>
            state.pack.id === action.id ? { ...state, status: "downloading", error: undefined } : state,
          ),
        );
      }
    },
    onSettled: async () => {
      if (api) client.setQueryData(CATALOG_KEY, await api.getReferenceStates());
      setProgress(null);
      setRevision((value) => value + 1);
      await client.invalidateQueries({ queryKey: ["snp-browser"] });
      await client.invalidateQueries({ queryKey: ["reference-annotations"] });
      await client.invalidateQueries({ queryKey: ["matched-annotations"] });
    },
  });
  const packs = (catalog.data ?? []).map((state) =>
    progress?.packId === state.pack.id ? { ...state, downloadedBytes: progress.downloadedBytes } : state,
  );
  return {
    packs,
    revision,
    loading: catalog.isPending,
    busy: operation.isPending || catalog.isFetching,
    clearing: operation.isPending && operation.variables?.kind === "clear",
    cleared: operation.isSuccess && operation.variables?.kind === "clear",
    error: (catalog.error || operation.error || stateRefreshError)?.message ?? null,
    download: (id: string) => operation.mutate({ kind: "download", id }),
    remove: (id: string) => operation.mutate({ kind: "remove", id }),
    toggle: (id: string, enabled: boolean) => operation.mutate({ kind: "toggle", id, enabled }),
    clear: () => operation.mutate({ kind: "clear" }),
    retry: () => {
      operation.reset();
      void catalog.refetch();
    },
  };
}
