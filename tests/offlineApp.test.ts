import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { offlineApp, offlineWorkerSource } from "../tools/offlineApp";

const ORIGIN = "https://dna.example.test";
const BASE = "/workbench/";
const FILES = ["/workbench/index.html", "/workbench/assets/main-abc.js", "/workbench/assets/pdf-worker-xyz.mjs"];
const absolute = (url: string) => new URL(url, ORIGIN).href;
const integrityFor = async (body: string | Uint8Array) => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return `sha256-${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("base64")}`;
};

interface WorkerRequest {
  url: string;
  method: string;
  mode: string;
  headers?: Headers;
}

type CacheStorage = Map<string, Map<string, Response>>;
const cachedRequestHeaders = new WeakMap<Response, Headers>();

function cacheMatch(
  entries: Map<string, Response> | undefined,
  request: string | WorkerRequest,
  options: { ignoreVary?: boolean } = {},
) {
  const url = typeof request === "string" ? absolute(request) : request.url;
  const response = entries?.get(url);
  if (!response) return undefined;
  if (!options.ignoreVary) {
    const incoming = typeof request === "string" ? new Headers() : (request.headers ?? new Headers());
    const stored = cachedRequestHeaders.get(response) ?? new Headers();
    const vary =
      response.headers
        .get("vary")
        ?.split(",")
        .map((name) => name.trim().toLowerCase()) ?? [];
    if (vary.some((name) => name === "*" || incoming.get(name) !== stored.get(name))) return undefined;
  }
  return response.clone();
}
type WorkerListener = (event: {
  request?: WorkerRequest;
  waitUntil: (promise: Promise<unknown>) => void;
  respondWith: (promise: Promise<Response>) => void;
}) => void;

/**
 * Execute the emitted worker, not a reimplementation of its routing. The host
 * supplies just the standard lifecycle/cache boundaries so that every fetch,
 * cache write, claim, and skipWaiting call can be observed without a browser.
 */
function workerHarness(
  options: {
    version?: string;
    files?: string[];
    base?: string;
    storage?: CacheStorage;
    source?: string;
    /** Headers materialized by the browser's precache fetch, before Cache.addAll stores its request. */
    precacheRequestHeaders?: HeadersInit;
  } = {},
) {
  const storage = options.storage ?? new Map<string, Map<string, Response>>();
  const listeners = new Map<string, WorkerListener>();
  const networkRequests: WorkerRequest[] = [];
  const installRequests: Request[] = [];
  const requestInitializers: Array<{ url: string; init?: RequestInit }> = [];
  const requestOptions = new WeakMap<WorkerRequest, RequestInit>();
  const deletedCaches: string[] = [];
  const serverResponses = new Map<string, string>();
  const serverResponseHeaders = new Map<string, HeadersInit>();
  let offline = false;
  let failUrl: string | undefined;
  let skipWaitingCalls = 0;
  let claimCalls = 0;
  let navigationCalls = 0;

  const networkFetch = async (request: WorkerRequest) => {
    networkRequests.push({ url: request.url, mode: request.mode, method: request.method });
    if (offline || request.url === failUrl) throw new TypeError("Network unavailable");
    const body = serverResponses.get(request.url) ?? `public:${new URL(request.url).pathname}`;
    const integrity = requestOptions.get(request)?.integrity;
    // Model the browser fetch boundary's SRI enforcement. The worker still
    // supplies the real expected digest and handles the resulting rejection.
    if (integrity && integrity !== (await integrityFor(body))) throw new TypeError("Subresource integrity mismatch");
    return new Response(body, { headers: serverResponseHeaders.get(request.url) });
  };

  class WorkerRelativeRequest extends Request {
    constructor(input: string, init?: RequestInit) {
      super(absolute(input), init);
      // Bun's Request currently reports credentials="include" even when omit
      // is supplied. Observe the actual constructor boundary instead.
      requestInitializers.push({ url: absolute(input), init: init && { ...init } });
      if (init) requestOptions.set(this, init);
    }
  }

  const context = createContext({
    URL,
    Request: WorkerRelativeRequest,
    fetch: networkFetch,
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, listener: WorkerListener) => listeners.set(type, listener),
      skipWaiting: async () => {
        skipWaitingCalls++;
      },
      clients: {
        claim: async () => {
          claimCalls++;
        },
        matchAll: async () => [
          {
            navigate: async () => {
              navigationCalls++;
            },
          },
        ],
      },
    },
    caches: {
      open: async (name: string) => {
        let cache = storage.get(name);
        if (!cache) {
          cache = new Map();
          storage.set(name, cache);
        }
        const entries = cache;
        return {
          addAll: async (requests: Request[]) => {
            installRequests.push(...requests);
            // Native Cache.addAll commits atomically after all responses succeed.
            const responses = await Promise.all(requests.map(networkFetch));
            for (let i = 0; i < requests.length; i++) {
              const stored = new Headers(requests[i].headers);
              new Headers(options.precacheRequestHeaders).forEach((value, key) => stored.set(key, value));
              cachedRequestHeaders.set(responses[i], stored);
              entries.set(requests[i].url, responses[i]);
            }
          },
          match: async (request: string | WorkerRequest, settings?: { ignoreVary?: boolean }) =>
            cacheMatch(entries, request, settings),
        };
      },
      keys: async () => [...storage.keys()],
      delete: async (name: string) => {
        deletedCaches.push(name);
        return storage.delete(name);
      },
    },
  });
  runInContext(
    options.source ?? offlineWorkerSource(options.version ?? "release-a", options.files ?? FILES, options.base ?? BASE),
    context,
  );

  const lifecycle = async (type: "install" | "activate") => {
    const waits: Promise<unknown>[] = [];
    const listener = listeners.get(type);
    if (!listener) throw new Error(`Missing ${type} handler`);
    listener({
      waitUntil: (promise) => waits.push(promise),
      respondWith: () => {
        throw new Error("respondWith outside fetch");
      },
    });
    expect(waits.length).toBeGreaterThan(0);
    await Promise.all(waits);
  };

  const request = async (path: string, settings: { method?: string; mode?: string; headers?: HeadersInit } = {}) => {
    let response: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    listeners.get("fetch")?.({
      request: {
        url: absolute(path),
        method: settings.method ?? "GET",
        mode: settings.mode ?? "cors",
        headers: new Headers(settings.headers),
      },
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => {
        if (response) throw new Error("respondWith invoked more than once");
        response = Promise.resolve(promise);
      },
    });
    await Promise.all(waits);
    return response ? await response : undefined;
  };

  return {
    storage,
    networkRequests,
    installRequests,
    requestInitializers,
    deletedCaches,
    serverResponses,
    serverResponseHeaders,
    lifecycle,
    request,
    goOffline: () => {
      offline = true;
    },
    fail: (url: string) => {
      failUrl = absolute(url);
    },
    controls: () => ({ skipWaitingCalls, claimCalls, navigationCalls }),
  };
}

describe("generated offline application worker", () => {
  test("build output includes application chunks and icons but excludes reference packs, maps, and other public files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "snp-offline-worker-test-"));
    try {
      const fixtureFiles = {
        "index.html": "<html>public app — 🧬</html>",
        "assets/main-abc.js": "public application JavaScript",
        "assets/nested/pdf-worker.mjs": "public PDF worker",
        "assets/main-abc.js.map": "source map",
        "site.webmanifest": "{}",
        "favicon.ico": "icon",
        "references/large.json.gz": "public optional reference pack",
        "uploads/synthetic.txt": "synthetic unlisted file",
        "sw.js": "an obsolete service worker",
      };
      for (const [file, contents] of Object.entries(fixtureFiles)) {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await writeFile(path.join(directory, file), contents);
      }
      const plugin = offlineApp();
      if (typeof plugin.configResolved !== "function" || typeof plugin.closeBundle !== "function") {
        throw new Error("Expected callable offline build hooks");
      }
      // The plugin reads only these resolved build fields.
      await (plugin.configResolved as (config: unknown) => unknown)({
        root: directory,
        build: { outDir: "." },
        base: BASE,
      });
      await (plugin.closeBundle as () => Promise<void>)();
      const worker = workerHarness({ source: await readFile(path.join(directory, "sw.js"), "utf8") });
      for (const [file, contents] of Object.entries(fixtureFiles)) {
        worker.serverResponses.set(absolute(`${BASE}${file}`), contents);
      }
      await worker.lifecycle("install");
      expect(worker.networkRequests.map((request) => request.url).sort()).toEqual(
        ["assets/main-abc.js", "assets/nested/pdf-worker.mjs", "favicon.ico", "index.html", "site.webmanifest"]
          .map((file) => absolute(`${BASE}${file}`))
          .sort(),
      );
      for (const { url, init } of worker.requestInitializers) {
        const file = new URL(url).pathname.slice(BASE.length);
        expect(init?.integrity).toBe(await integrityFor(await readFile(path.join(directory, file))));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("installation downloads only the fixed public app assets without credentials", async () => {
    const worker = workerHarness();
    await worker.lifecycle("install");
    expect(worker.networkRequests.map((request) => request.url)).toEqual(FILES.map(absolute));
    expect([...worker.storage.keys()]).toEqual(["snp-browser-app-release-a"]);
    expect([...worker.storage.get("snp-browser-app-release-a")!.keys()]).toEqual(FILES.map(absolute));
    expect(worker.requestInitializers.map(({ url }) => url)).toEqual(FILES.map(absolute));
    expect(
      worker.requestInitializers.every(({ init }) => init?.credentials === "omit" && init.cache === "reload"),
    ).toBe(true);
    expect(worker.controls()).toEqual({ skipWaitingCalls: 0, claimCalls: 0, navigationCalls: 0 });
  });

  test("a failed installation removes its incomplete cache and preserves existing releases and references", async () => {
    const storage: CacheStorage = new Map([
      ["snp-browser-app-previous", new Map([[absolute("/old.html"), new Response("old release")]])],
      ["snp-browser-reference-packs", new Map([[absolute("/reference.gz"), new Response("public reference")]])],
    ]);
    const worker = workerHarness({ storage });
    worker.fail(FILES[1]);
    await expect(worker.lifecycle("install")).rejects.toThrow("Network unavailable");
    expect(worker.deletedCaches).toEqual(["snp-browser-app-release-a"]);
    expect([...storage.keys()]).toEqual(["snp-browser-app-previous", "snp-browser-reference-packs"]);
    expect(worker.controls()).toEqual({ skipWaitingCalls: 0, claimCalls: 0, navigationCalls: 0 });
  });

  test("an integrity failure rejects a mixed release, cleans its cache, and preserves the installed release", async () => {
    const storage: CacheStorage = new Map([
      ["snp-browser-app-previous", new Map([[absolute(FILES[0]), new Response("installed release")]])],
      ["snp-browser-reference-packs", new Map()],
    ]);
    const integrity: Record<string, string> = {};
    for (const file of FILES) integrity[file] = await integrityFor(`public:${file}`);
    const worker = workerHarness({
      storage,
      source: offlineWorkerSource("release-b", FILES, BASE, integrity),
    });
    worker.serverResponses.set(absolute(FILES[0]), "<html>newer deployment with different chunks</html>");
    await expect(worker.lifecycle("install")).rejects.toThrow("Subresource integrity mismatch");
    expect(worker.requestInitializers[0].init?.integrity).toBe(integrity[FILES[0]]);
    expect(worker.deletedCaches).toEqual(["snp-browser-app-release-b"]);
    expect([...storage.keys()]).toEqual(["snp-browser-app-previous", "snp-browser-reference-packs"]);
    expect(await storage.get("snp-browser-app-previous")!.get(absolute(FILES[0]))!.text()).toBe("installed release");
    expect(worker.controls()).toEqual({ skipWaitingCalls: 0, claimCalls: 0, navigationCalls: 0 });
  });

  test("a new release waits without replacing an open analysis or deleting the installed release", async () => {
    const installed = workerHarness();
    installed.serverResponses.set(absolute(FILES[0]), "<html>release A</html>");
    await installed.lifecycle("install");
    await installed.lifecycle("activate");
    const next = workerHarness({ storage: installed.storage, version: "release-b" });
    next.serverResponses.set(absolute(FILES[0]), "<html>release B</html>");
    await next.lifecycle("install");
    expect(next.controls()).toEqual({ skipWaitingCalls: 0, claimCalls: 0, navigationCalls: 0 });
    expect(next.deletedCaches).toEqual([]);
    expect(await (await installed.request(BASE, { mode: "navigate" }))?.text()).toBe("<html>release A</html>");
    expect([...next.storage.keys()]).toEqual(["snp-browser-app-release-a", "snp-browser-app-release-b"]);
  });

  test("activation deletes only its older application caches, preserving all reference and unrelated caches", async () => {
    const storage: CacheStorage = new Map([
      ["snp-browser-app-old", new Map()],
      ["snp-browser-app-release-a", new Map()],
      ["snp-browser-references-v2", new Map()],
      ["snpbrowser-sqlite-reference", new Map()],
      ["another-application-cache", new Map()],
    ]);
    const worker = workerHarness({ storage });
    await worker.lifecycle("activate");
    expect(worker.deletedCaches).toEqual(["snp-browser-app-old"]);
    expect([...storage.keys()]).toEqual([
      "snp-browser-app-release-a",
      "snp-browser-references-v2",
      "snpbrowser-sqlite-reference",
      "another-application-cache",
    ]);
    expect(worker.controls()).toEqual({ skipWaitingCalls: 0, claimCalls: 1, navigationCalls: 0 });
  });

  test("offline navigation and dynamic worker assets come from the same installed release", async () => {
    const worker = workerHarness();
    worker.serverResponses.set(
      absolute(FILES[0]),
      '<html><script src="/workbench/assets/main-abc.js"></script></html>',
    );
    await worker.lifecycle("install");
    worker.serverResponses.set(absolute(FILES[0]), "<html>newer server release</html>");
    worker.goOffline();
    const initialRequestCount = worker.networkRequests.length;
    for (const route of [BASE, `${BASE}index.html`]) {
      expect(await (await worker.request(route, { mode: "navigate" }))?.text()).toContain("main-abc.js");
    }
    for (const asset of FILES.slice(1)) {
      expect(await (await worker.request(asset))?.text()).toBe(`public:${asset}`);
    }
    expect(worker.networkRequests).toHaveLength(initialRequestCount);
  });

  test("Vary: Origin on verified public assets cannot break offline module or navigation loads", async () => {
    const integrity: Record<string, string> = {};
    for (const file of FILES) integrity[file] = await integrityFor(`public:${file}`);
    const worker = workerHarness({
      source: offlineWorkerSource("release-vary", FILES, BASE, integrity),
      precacheRequestHeaders: { Origin: ORIGIN },
    });
    for (const file of FILES) worker.serverResponseHeaders.set(absolute(file), { Vary: "Origin" });
    await worker.lifecycle("install");
    const entries = worker.storage.get("snp-browser-app-release-vary");
    // This is the browser mismatch seen with Vite: querying by URL creates a
    // headerless Request, which ordinarily cannot match a precached Origin.
    expect(cacheMatch(entries, FILES[1])).toBeUndefined();
    expect(
      await cacheMatch(entries, {
        url: absolute(FILES[1]),
        method: "GET",
        mode: "cors",
        headers: new Headers({ origin: ORIGIN }),
      })?.text(),
    ).toBe(`public:${FILES[1]}`);
    worker.goOffline();
    const before = worker.networkRequests.length;
    expect(await (await worker.request(BASE, { mode: "navigate" }))?.text()).toBe(`public:${FILES[0]}`);
    for (const file of FILES.slice(1)) {
      expect(await (await worker.request(file, { headers: { Origin: ORIGIN } }))?.text()).toBe(`public:${file}`);
    }
    expect(worker.networkRequests).toHaveLength(before);
  });

  test("Vary differences stay limited to the public allowlist and never capture a query-bearing asset", async () => {
    const worker = workerHarness({ precacheRequestHeaders: { Origin: ORIGIN, "Accept-Language": "en" } });
    worker.serverResponseHeaders.set(absolute(FILES[1]), { Vary: "ORIGIN, accept-language" });
    await worker.lifecycle("install");
    const entries = worker.storage.get("snp-browser-app-release-a");
    const differentHeaders = new Headers({ Origin: ORIGIN, "Accept-Language": "fr" });
    expect(
      cacheMatch(entries, { url: absolute(FILES[1]), method: "GET", mode: "cors", headers: differentHeaders }),
    ).toBeUndefined();
    worker.goOffline();
    const before = worker.networkRequests.length;
    expect(await (await worker.request(FILES[1], { headers: differentHeaders }))?.text()).toBe(`public:${FILES[1]}`);
    expect(await worker.request(`${FILES[1]}?genotype=AG`, { headers: differentHeaders })).toBeUndefined();
    expect(await worker.request("/workbench/references/private.txt", { headers: differentHeaders })).toBeUndefined();
    expect(worker.networkRequests).toHaveLength(before);
  });

  test("origin-root installations also serve the installed HTML for offline home navigation", async () => {
    const worker = workerHarness({ base: "/", files: ["/index.html", "/assets/main.js"] });
    await worker.lifecycle("install");
    worker.goOffline();
    expect(await (await worker.request("/", { mode: "navigate" }))?.text()).toBe("public:/index.html");
    expect(await (await worker.request("/index.html", { mode: "navigate" }))?.text()).toBe("public:/index.html");
  });

  test.each([
    ["/workbench/references/clinvar.json.gz", "GET", "cors"],
    ["https://references.example.test/clinvar.json.gz", "GET", "cors"],
    ["https://other.example.test/workbench/assets/main-abc.js", "GET", "cors"],
    ["/workbench/import/dna.txt", "GET", "cors"],
    ["/workbench/api/analyze", "POST", "cors"],
    ["/workbench/assets/main-abc.js", "POST", "cors"],
    ["/workbench/assets/main-abc.js", "HEAD", "cors"],
    ["/workbench/assets/main-abc.js?genotype=AG", "GET", "cors"],
    ["/workbench/assets/new-release.js", "GET", "cors"],
    ["/workbench/unlisted-page", "GET", "navigate"],
    ["https://other.example.test/workbench/", "GET", "navigate"],
    ["/workbench/", "POST", "navigate"],
  ])("does not intercept unlisted or private resources: %s %s %s", async (path, method, mode) => {
    const worker = workerHarness();
    await worker.lifecycle("install");
    const before = worker.networkRequests.length;
    expect(await worker.request(path, { method, mode })).toBeUndefined();
    expect(worker.networkRequests).toHaveLength(before);
    expect([...worker.storage.get("snp-browser-app-release-a")!.keys()]).toEqual(FILES.map(absolute));
  });

  test.each(["/workbench/?genotype=AG", "/workbench/index.html?report=private"])(
    "does not intercept query-bearing navigation: %s",
    async (path) => {
      const worker = workerHarness();
      await worker.lifecycle("install");
      const before = worker.networkRequests.length;
      expect(await worker.request(path, { mode: "navigate" })).toBeUndefined();
      expect(worker.networkRequests).toHaveLength(before);
    },
  );

  test("a missing listed asset can use the network without caching a runtime response", async () => {
    const worker = workerHarness();
    await worker.lifecycle("install");
    const entries = worker.storage.get("snp-browser-app-release-a")!;
    entries.delete(absolute(FILES[1]));
    worker.serverResponses.set(absolute(FILES[1]), "runtime fallback");
    expect(await (await worker.request(FILES[1]))?.text()).toBe("runtime fallback");
    expect(entries.has(absolute(FILES[1]))).toBe(false);
    expect(worker.networkRequests.at(-1)?.url).toBe(absolute(FILES[1]));
  });
});
