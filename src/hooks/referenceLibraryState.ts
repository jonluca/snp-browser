import type { QueryClient } from "@tanstack/react-query";
import type { ReferencePackState } from "../types/annotations";

export const REFERENCE_CATALOG_QUERY_KEY = ["reference-catalog"];

/** Refresh worker state without fetching a catalog or dismissing a catalog error. */
export async function refreshReferenceLibraryState(
  client: QueryClient,
  getStates: () => Promise<ReferencePackState[]>,
  isCurrent: () => boolean,
): Promise<boolean> {
  const query = client.getQueryCache().find<ReferencePackState[]>({ queryKey: REFERENCE_CATALOG_QUERY_KEY });
  const previous = query?.state.data;
  if (!query || !previous) return false;
  const states = await getStates();
  // A download, toggle, or refreshed catalog may have updated the cache while
  // the worker response was in transit. Never overwrite that newer state.
  if (!isCurrent() || query.state.data !== previous) return false;
  const unchanged =
    previous.length === states.length &&
    previous.every((state, index) => {
      const next = states[index];
      return (
        state.pack.id === next.pack.id &&
        state.pack.version === next.pack.version &&
        state.status === next.status &&
        state.enabled === next.enabled &&
        state.downloadedBytes === next.downloadedBytes &&
        state.error === next.error
      );
    });
  if (unchanged) return false;
  // setQueryData marks a query successful and clears its error. Updating only
  // data keeps a failed cached-catalog refresh visible with its retry action.
  query.setState({ data: states });
  return true;
}
