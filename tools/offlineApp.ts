import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

/** Only public application files are cached. Reference datasets use their own verified, opt-in cache. */
export function offlineWorkerSource(
  version: string,
  files: string[],
  base: string,
  integrity: Record<string, string> = {},
): string {
  return `const CACHE = ${JSON.stringify(`snp-browser-app-${version}`)};
const FILES = ${JSON.stringify(files)};
const INTEGRITY = ${JSON.stringify(integrity)};
const HOME = ${JSON.stringify(base)};
const INDEX = ${JSON.stringify(`${base}index.html`)};
const paths = new Set(FILES.map(file => new URL(file, self.location.origin).href));
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      await cache.addAll(FILES.map(file => new Request(file, {cache: 'reload', credentials: 'omit', integrity: INTEGRITY[file] || ''})));
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});
// A new release waits until existing tabs close. Never reload an open DNA analysis.
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('snp-browser-app-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  if (request.mode === 'navigate' && (url.pathname === HOME || url.pathname === INDEX)) {
    // Serve the installed release so its HTML and chunks always agree, even during an update.
    event.respondWith((async () => (await (await caches.open(CACHE)).match(INDEX, {ignoreVary: true})) || fetch(request))());
  } else if (paths.has(url.href)) {
    // Module requests can carry an Origin header absent during precaching.
    // These exact public files were integrity-verified, so Vary cannot select another representation.
    event.respondWith((async () => (await (await caches.open(CACHE)).match(url.href, {ignoreVary: true})) || fetch(request))());
  }
});
`;
}

export function offlineApp(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "offline-app",
    apply: "build",
    enforce: "post",
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      const output = path.resolve(config.root, config.build.outDir);
      const base = config.base;
      if (!base.startsWith("/") || base.startsWith("//"))
        throw new Error("Offline app requires an origin-relative Vite base.");
      const files = ["index.html"];
      async function walk(directory: string) {
        for (const entry of await readdir(path.join(output, directory), { withFileTypes: true })) {
          const file = `${directory}/${entry.name}`;
          if (entry.isDirectory()) await walk(file);
          else if (entry.isFile() && !file.endsWith(".map")) files.push(file);
        }
      }
      await walk("assets");
      for (const file of [
        "site.webmanifest",
        "favicon.ico",
        "favicon-16x16.png",
        "favicon-32x32.png",
        "apple-touch-icon.png",
        "android-chrome-192x192.png",
        "android-chrome-512x512.png",
      ]) {
        if ((await readdir(output)).includes(file)) files.push(file);
      }
      files.sort();
      const hash = createHash("sha256");
      hash.update(offlineWorkerSource("template", [], base));
      const integrity: Record<string, string> = {};
      for (const file of files) {
        const bytes = await readFile(path.join(output, file));
        hash.update(file);
        hash.update(bytes);
        integrity[`${base}${file}`] = `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
      }
      const source = offlineWorkerSource(
        hash.digest("hex").slice(0, 20),
        files.map((file) => `${base}${file}`),
        base,
        integrity,
      );
      await writeFile(path.join(output, "sw.js"), source);
    },
  };
}
