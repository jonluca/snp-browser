import { HAPLOGROUP_SOURCES } from "../data/haplogroupMarkers";
import type { HaplogroupAnalysis, HaplogroupResult } from "../types/haplogroups";
import { downloadCsvFile } from "../utils/csvExport";
import { buildHaplogroupCsv, HAPLOGROUP_LIMITATIONS } from "../utils/haplogroupExport";

const STATUS_LABELS = {
  predicted: "Marker-based estimate",
  insufficient: "Not enough markers",
  conflicting: "Conflicting markers",
  unavailable: "Unavailable",
};

function HaplogroupCard({ result, panelVersion }: { result: HaplogroupResult; panelVersion: string }) {
  const predicted = result.status === "predicted" && result.haplogroup;
  const paternal = result.lineage === "Y";

  return (
    <article className="surface-panel flex min-w-0 flex-col overflow-hidden">
      <div className="flex-1 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="section-label">{paternal ? "Y-DNA haplogroup" : "mtDNA haplogroup"}</h3>
          <span className={predicted ? "tag border-brand-100 bg-brand-50 text-brand-700" : "tag"}>
            {STATUS_LABELS[result.status]}
          </span>
        </div>
        <p className="mt-3 text-xs text-slate-500">Direct {paternal ? "paternal" : "maternal"} line</p>
        <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
          {predicted ? result.haplogroup : "No estimate"}
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">{result.reason}</p>
      </div>
      <details className="border-t border-slate-100 px-5 py-4 text-xs leading-5 sm:px-6">
        <summary className="cursor-pointer font-semibold text-brand-700">Evidence & limitations</summary>
        <p className="mt-4 text-slate-600">
          Panel coverage: {result.observedMarkers} of {result.totalMarkers} markers have interpretable calls. This is
          coverage of the supported panel, not a confidence score.
        </p>
        {result.supportingMarkers.length ? (
          <div className="mt-3">
            <p className="font-semibold text-slate-800">Supporting markers</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {result.supportingMarkers.map(({ marker, genotype }) => (
                <li
                  key={marker}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-slate-700"
                >
                  {marker}: {genotype}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-3 text-slate-500">No supporting markers for a haplogroup estimate.</p>
        )}
        {result.issues.length > 0 && (
          <div className="mt-3">
            <p className="font-semibold text-slate-800">Issues in this file</p>
            <ul className="mt-2 list-disc space-y-2 pl-4 text-slate-600">
              {result.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}
        <ul className="mt-3 list-disc space-y-2 pl-4 text-slate-500">
          {HAPLOGROUP_LIMITATIONS.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
        <p className="mt-3 text-slate-500">Panel version {panelVersion}</p>
        <div className="mt-3 space-y-2">
          {HAPLOGROUP_SOURCES.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block break-words text-brand-700 underline underline-offset-2"
            >
              {source.title} ↗
            </a>
          ))}
        </div>
      </details>
    </article>
  );
}

export function HaplogroupSummary({ analysis }: { analysis: HaplogroupAnalysis }) {
  return (
    <section aria-label="Your haplogroups" className="mb-10 min-w-0">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="section-label">Two family lines</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Your haplogroups</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
            Broad estimates for your direct paternal and maternal lines, calculated on this device from a small
            supported marker panel. These do not describe your full ancestry, and sparse DNA-chip data can be
            inconclusive.
          </p>
        </div>
        <button
          type="button"
          className="secondary-button text-xs"
          onClick={() => downloadCsvFile("haplogroups.csv", buildHaplogroupCsv(analysis))}
        >
          Export haplogroups
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {analysis.results.map((result) => (
          <HaplogroupCard key={result.lineage} result={result} panelVersion={analysis.panelVersion} />
        ))}
      </div>
    </section>
  );
}
