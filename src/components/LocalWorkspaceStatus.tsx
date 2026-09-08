import { useEffect, useState } from "react";
import { formatReferenceBytes } from "../utils/annotationPresentation";

let registrationPromise: Promise<ServiceWorkerRegistration> | undefined;

export function LocalWorkspaceStatus({ referenceRevision }: { referenceRevision: number }) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [offlineReady, setOfflineReady] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [offlineError, setOfflineError] = useState(() => !("serviceWorker" in navigator));
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({});
  const [storageMessage, setStorageMessage] = useState("");

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let current = true;
    const cleanups: Array<() => void> = [];
    registrationPromise ??= navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      updateViaCache: "none",
    });
    void registrationPromise
      .then(async (registration) => {
        const update = () => {
          if (!current) return;
          setOfflineReady(Boolean(registration.active));
          setUpdateReady(Boolean(registration.waiting));
        };
        const watch = () => {
          update();
          if (!registration.installing) return;
          const worker = registration.installing;
          const changed = () => {
            update();
            if (current && worker.state === "redundant" && !registration.active) setOfflineError(true);
          };
          worker.addEventListener("statechange", changed);
          cleanups.push(() => worker.removeEventListener("statechange", changed));
        };
        if (!current) return;
        registration.addEventListener("updatefound", watch);
        cleanups.push(() => registration.removeEventListener("updatefound", watch));
        watch();
        await navigator.serviceWorker.ready;
        update();
      })
      .catch(() => {
        registrationPromise = undefined;
        if (current) setOfflineError(true);
      });
    return () => {
      current = false;
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  useEffect(() => {
    let current = true;
    if (navigator.storage?.estimate) {
      void Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? Promise.resolve(false)])
        .then(([estimate, persisted]) => {
          if (current) setStorage({ ...estimate, persisted });
        })
        .catch(() => undefined);
    }
    return () => {
      current = false;
    };
  }, [referenceRevision]);

  const keepDownloads = async () => {
    try {
      const persisted = await navigator.storage.persist();
      setStorage((value) => ({ ...value, persisted }));
      setStorageMessage(
        persisted
          ? "Downloads are protected from automatic storage eviction."
          : "Your browser did not grant persistent storage. You can still use downloaded references.",
      );
    } catch {
      setStorageMessage("Persistent storage is unavailable in this browser.");
    }
  };

  return (
    <details className="mb-5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
      <summary className="cursor-pointer select-none font-medium text-slate-700">
        On-device workspace · {online ? "Online" : "Offline"} ·{" "}
        {offlineReady
          ? "App saved for offline use"
          : import.meta.env.DEV
            ? "Development preview"
            : offlineError
              ? "Offline setup unavailable"
              : "Preparing offline app"}
      </summary>
      <div className="mt-3 grid gap-3 leading-5 sm:grid-cols-2">
        <p>
          Your DNA and guesses stay in this tab’s memory. Reopen your file after closing or reloading. Only public app
          files, references, and source preferences are saved here.
        </p>
        <div>
          <p>
            {storage.usage !== undefined
              ? `${formatReferenceBytes(storage.usage)} used by this site${storage.quota ? ` · ${formatReferenceBytes(storage.quota)} browser allowance` : ""}. `
              : ""}
            Reference downloads are optional; saved sources work offline.
          </p>
          {storage.persisted ? (
            <p className="mt-2 font-medium text-brand-700">Persistent storage enabled</p>
          ) : (
            typeof navigator.storage?.persist === "function" && (
              <button
                type="button"
                onClick={() => void keepDownloads()}
                className="mt-2 cursor-pointer font-semibold text-brand-700 underline underline-offset-2"
              >
                Keep reference downloads
              </button>
            )
          )}
          {storageMessage && (
            <p role="status" className="mt-2">
              {storageMessage}
            </p>
          )}
        </div>
      </div>
      {updateReady && (
        <p role="status" className="mt-3 text-brand-700">
          An app update is saved. It will be used after you close all tabs for this site and reopen it.
        </p>
      )}
    </details>
  );
}
