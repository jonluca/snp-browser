// Each verified release gets a new URL so cached older databases cannot mask updates.
const SNPEDIA_DB_PATH = "/snpedia/2026-09-24.db";
const REMOTE_DB_URL = `https://static.snpbrowser.com${SNPEDIA_DB_PATH}`;
const LOCAL_DB_PROXY_URL = SNPEDIA_DB_PATH;

const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

export const DB_URL = isLocalHost ? LOCAL_DB_PROXY_URL : REMOTE_DB_URL;

// The catalog contains only public reference asset URLs, never uploaded variant IDs.
export const REFERENCE_MANIFEST_URL = import.meta.env.VITE_REFERENCE_MANIFEST_URL || "/references/manifest-v2.json";
