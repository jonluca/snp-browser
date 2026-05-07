const REMOTE_DB_URL = "https://static.snpbrowser.com/snpedia.db";
const LOCAL_DB_PROXY_URL = "/snpedia.db";

const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

export const DB_URL = isLocalHost ? LOCAL_DB_PROXY_URL : REMOTE_DB_URL;
