import type { ReferencePackState } from "../types/annotations";
import { formatReferenceBytes, safeReferenceUrl } from "../utils/annotationPresentation";

interface ReferenceLibraryProps {
  packs: ReferencePackState[];
  loading: boolean;
  error?: string | null;
  busy?: boolean;
  clearing?: boolean;
  cleared?: boolean;
  onDownload: (packId: string) => void;
  onRemove: (packId: string) => void;
  onToggle: (packId: string, enabled: boolean) => void;
  onRetry: () => void;
  onClear: () => void;
}

function PackCard({
  state,
  busy,
  onDownload,
  onRemove,
  onToggle,
}: {
  state: ReferencePackState;
  busy: boolean;
} & Pick<ReferenceLibraryProps, "onDownload" | "onRemove" | "onToggle">) {
  const { pack, status } = state;
  const bytes = state.totalBytes || pack.shards.reduce((total, shard) => total + shard.bytes, 0);
  const downloaded = Math.max(0, Math.min(state.downloadedBytes, bytes || state.downloadedBytes));
  const homepage = safeReferenceUrl(pack.homepage);
  const licenseUrl = safeReferenceUrl(pack.licenseUrl);
  const sample = /\b(?:sample|demo|example|subset)\b/i.test(pack.coverage);
  const downloading = status === "downloading";
  const ready = status === "ready";

  return (
    <article className="surface-panel flex min-w-0 flex-col overflow-hidden">
      <div className="flex-1 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="min-w-0 text-base font-semibold tracking-tight break-words text-slate-900">{pack.name}</h3>
          <span className={ready ? "tag border-brand-100 bg-brand-50 text-brand-700" : "tag"}>
            {downloading
              ? "Downloading"
              : ready
                ? "Saved in this browser"
                : status === "error"
                  ? "Download failed"
                  : "Not downloaded"}
          </span>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-600">{pack.description}</p>
        <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50/70 p-3">
          <p className="text-[11px] font-semibold tracking-wide text-slate-500">
            {sample ? "SAMPLE COVERAGE" : "COVERAGE"}
          </p>
          <p className="mt-1 text-xs leading-5 break-words text-slate-700">{pack.coverage}</p>
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-x-3 gap-y-4 text-xs">
          <div className="min-w-0">
            <dt className="text-slate-500">Pack</dt>
            <dd className="mt-1 font-medium break-words text-slate-800">{pack.version}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Records</dt>
            <dd className="mt-1 font-medium tabular-nums text-slate-800">{pack.recordCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Download</dt>
            <dd className="mt-1 font-medium tabular-nums text-slate-800">{formatReferenceBytes(bytes)}</dd>
          </div>
        </dl>
        {pack.sourceRelease && (
          <p className="mt-3 text-xs leading-5 break-words text-slate-500">Source release: {pack.sourceRelease}</p>
        )}

        {downloading && (
          <div className="mt-5" role="status">
            <div className="mb-2 flex justify-between gap-3 text-xs text-slate-600">
              <span>Saving reference data…</span>
              <span className="shrink-0 tabular-nums">
                {formatReferenceBytes(downloaded)}
                {bytes > 0 ? ` / ${formatReferenceBytes(bytes)}` : ""}
              </span>
            </div>
            <progress
              aria-label={`Download progress for ${pack.name}`}
              max={bytes || 1}
              value={bytes ? downloaded : undefined}
              className="block h-1.5 w-full overflow-hidden rounded-full accent-brand-600 [&::-webkit-progress-bar]:bg-slate-100 [&::-webkit-progress-value]:bg-brand-600"
            />
          </div>
        )}
        {state.error && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 break-words text-slate-700"
          >
            {state.error}
          </p>
        )}
      </div>

      <div className="border-t border-slate-100 px-5 py-4 sm:px-6">
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-3">
          {ready ? (
            <>
              <label className="inline-flex cursor-pointer items-center gap-2.5 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={state.enabled}
                  disabled={busy}
                  onChange={(event) => onToggle(pack.id, event.currentTarget.checked)}
                  aria-label={`Use ${pack.name} in this browser`}
                  className="size-4 rounded accent-brand-600 disabled:cursor-not-allowed"
                />
                Use this reference
              </label>
              <button
                type="button"
                onClick={() => onRemove(pack.id)}
                disabled={busy}
                aria-label={`Remove ${pack.name} from this browser`}
                className="secondary-button text-xs"
              >
                Remove
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy || downloading}
                onClick={() => onDownload(pack.id)}
                aria-label={`${status === "error" ? "Retry downloading" : "Download"} ${pack.name}`}
                className="primary-button w-full sm:w-auto"
              >
                {downloading ? "Downloading…" : status === "error" ? "Retry download" : "Download reference"}
              </button>
              {downloading && (
                <button
                  type="button"
                  onClick={() => onRemove(pack.id)}
                  aria-label={`Cancel downloading ${pack.name}`}
                  className="secondary-button text-xs"
                >
                  Cancel download
                </button>
              )}
            </>
          )}
        </div>
        <details className="group mt-4 text-xs leading-5 text-slate-500">
          <summary className="w-fit cursor-pointer rounded-sm text-slate-500 hover:text-brand-700">
            Source and license
          </summary>
          <p className="mt-2 break-words">{pack.attribution}</p>
          <p className="mt-2">Pack built {pack.builtAt}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {homepage && (
              <a
                href={homepage}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-700 underline underline-offset-2"
              >
                Source website ↗
              </a>
            )}
            {licenseUrl ? (
              <a
                href={licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="break-words text-brand-700 underline underline-offset-2"
              >
                {pack.license} ↗
              </a>
            ) : (
              <span>{pack.license}</span>
            )}
          </div>
        </details>
      </div>
    </article>
  );
}

export function ReferenceLibrary({
  packs,
  loading,
  error,
  busy = false,
  clearing = false,
  cleared = false,
  onDownload,
  onRemove,
  onToggle,
  onRetry,
  onClear,
}: ReferenceLibraryProps) {
  const readyCount = packs.filter((state) => state.status === "ready").length;
  return (
    <section className="min-w-0" aria-label="Reference library" aria-busy={loading}>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="section-label">More context for your variants</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Reference library</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Download reference packs to this browser, then choose which sources to include. Matching happens on your
            device.
          </p>
        </div>
        {packs.length > 0 && (
          <p className="text-xs text-slate-500">
            <span className="font-medium text-slate-800">
              {readyCount} of {packs.length}
            </span>{" "}
            saved here
          </p>
        )}
      </div>
      <div className="surface-panel mb-5 flex flex-wrap items-center justify-between gap-4 p-4 sm:px-5">
        <div className="max-w-2xl text-xs leading-5 text-slate-500">
          <p id="reference-storage-description">
            Free browser storage by removing all downloaded reference packs, including older versions. Your uploaded
            analysis and SNPedia stay available.
          </p>
          {cleared && (
            <p role="status" className="mt-1 font-medium text-brand-700">
              Reference downloads cleared.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          disabled={loading || busy}
          aria-describedby="reference-storage-description"
          className="secondary-button shrink-0 text-xs"
        >
          {clearing ? "Clearing downloads…" : "Clear reference downloads"}
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4"
        >
          <p className="min-w-0 text-sm leading-6 break-words text-slate-700">{error}</p>
          <button type="button" onClick={onRetry} disabled={loading || busy} className="secondary-button">
            Retry loading library
          </button>
        </div>
      )}
      {loading && (
        <p role="status" className="mb-5 text-sm text-slate-500">
          Loading reference library…
        </p>
      )}
      {!loading && !error && packs.length === 0 && (
        <div className="surface-panel p-8 text-center text-sm leading-6 text-slate-500">
          No reference packs are available in the current library.
        </div>
      )}
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        {packs.map((state) => (
          <PackCard
            key={state.pack.id}
            state={state}
            busy={busy}
            onDownload={onDownload}
            onRemove={onRemove}
            onToggle={onToggle}
          />
        ))}
      </div>
    </section>
  );
}
