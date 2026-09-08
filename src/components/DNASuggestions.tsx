import { useState } from "react";
import type { TraitAnalysis, TraitResult } from "../types/traits";
import type { ReferencePackState } from "../types/annotations";
import { buildCsv, downloadCsvFile } from "../utils/csvExport";

const STATUS_LABELS = {
  matched: "Marker-based guess",
  missing: "Not in this file",
  unresolved: "Cannot interpret",
  conflicting: "Conflicting calls",
};

function TraitCard({ result }: { result: TraitResult }) {
  const matched = result.status === "matched" && result.prediction;
  return (
    <article className={`surface-panel flex min-w-0 flex-col overflow-hidden ${matched ? "" : "bg-slate-50/50"}`}>
      <div className="flex-1 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="section-label">{result.category}</p>
          <span className={matched ? "tag border-brand-100 bg-brand-50 text-brand-700" : "tag"}>
            {STATUS_LABELS[result.status]}
          </span>
        </div>
        <p className="mt-5 text-xs font-medium text-slate-500">{result.title}</p>
        <h3 className="mt-1.5 text-xl font-semibold leading-7 tracking-tight text-slate-950">
          {matched
            ? result.prediction!.label
            : result.status === "missing"
              ? "Marker not found"
              : result.status === "conflicting"
                ? "Conflicting calls"
                : "Not enough information"}
        </h3>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          {matched ? result.prediction!.description : result.reason}
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="font-mono">{result.rsid}</span>
          <span aria-hidden="true">·</span>
          <span>{result.gene}</span>
          {result.genotype && (
            <span className="ml-auto rounded-md border border-slate-200 bg-white px-2 py-1 font-mono font-semibold text-slate-800">
              {result.genotype}
            </span>
          )}
        </div>
      </div>
      <details className="border-t border-slate-100 px-5 py-4 text-xs leading-5 sm:px-6">
        <summary className="cursor-pointer font-semibold text-brand-700">Evidence & limitations</summary>
        <p className="mt-4 font-semibold text-slate-800">{result.evidence.label}</p>
        <p className="mt-2 text-slate-600">{result.evidence.summary}</p>
        <p className="mt-3 text-slate-600">{result.evidence.population}</p>
        <ul className="mt-3 list-disc space-y-2 pl-4 text-slate-500">
          {result.limitations.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
        <p className="mt-3 text-slate-500">{result.mappingNote}</p>
        <div className="mt-3 space-y-2">
          {result.evidence.citations.map((citation) => (
            <a
              key={citation.url}
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block break-words text-brand-700 underline underline-offset-2"
            >
              {citation.title} ({citation.year}) ↗
            </a>
          ))}
          <a
            href={result.mappingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-brand-700 underline underline-offset-2"
          >
            Reference allele mapping ↗
          </a>
        </div>
      </details>
    </article>
  );
}

export function DNASuggestions({
  analysis,
  packs,
  onReferences,
  onMatches,
  matching = false,
}: {
  analysis: TraitAnalysis;
  packs: ReferencePackState[];
  onReferences: () => void;
  onMatches: () => void;
  matching?: boolean;
}) {
  const [onlyGuesses, setOnlyGuesses] = useState(false);
  const enabled = packs.filter((state) => state.status === "ready" && state.enabled);
  const results = onlyGuesses ? analysis.results.filter((result) => result.status === "matched") : analysis.results;
  const exportSummary = () =>
    downloadCsvFile(
      "dna-suggestions.csv",
      buildCsv(analysis.results, [
        { header: "Trait", value: (result) => result.title },
        { header: "Status", value: (result) => STATUS_LABELS[result.status] },
        { header: "Suggestion", value: (result) => result.prediction?.label },
        { header: "Explanation", value: (result) => result.prediction?.description ?? result.reason },
        { header: "rsID", value: (result) => result.rsid },
        { header: "Forward genotype", value: (result) => result.genotype },
        { header: "Evidence", value: (result) => result.evidence.summary },
        { header: "Population context", value: (result) => result.evidence.population },
        { header: "Limitations", value: (result) => result.limitations.join("; ") },
        { header: "Sources", value: (result) => result.evidence.citations.map((citation) => citation.url).join("; ") },
        { header: "Rule version", value: () => analysis.rulesVersion },
      ]),
    );
  return (
    <section aria-label="What your DNA suggests" className="min-w-0">
      <div className="mb-6 grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="section-label">A few things your DNA may tell you</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            What your DNA suggests
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
            Research-backed guesses about everyday traits, calculated on this device. Each card shows one marker’s
            contribution; other genes and your environment also matter.
          </p>
        </div>
        <div className="rounded-xl border border-brand-100 bg-brand-50 px-5 py-4">
          <p className="text-2xl font-semibold tabular-nums text-brand-700">
            {analysis.summary.matched}{" "}
            <span className="text-base font-normal text-brand-700/70">of {analysis.summary.total}</span>
          </p>
          <p className="mt-1 text-xs text-brand-700">markers interpretable in this file</p>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2" aria-label="Suggestion filters">
          <button
            type="button"
            className="filter-chip"
            aria-pressed={!onlyGuesses}
            onClick={() => setOnlyGuesses(false)}
          >
            All markers
          </button>
          <button type="button" className="filter-chip" aria-pressed={onlyGuesses} onClick={() => setOnlyGuesses(true)}>
            Available guesses ({analysis.summary.matched})
          </button>
        </div>
        <button type="button" className="secondary-button text-xs" onClick={exportSummary}>
          Export suggestions
        </button>
      </div>
      {results.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {results.map((result) => (
            <TraitCard key={result.id} result={result} />
          ))}
        </div>
      ) : (
        <div className="surface-panel px-6 py-12 text-center text-sm leading-6 text-slate-600">
          No guesses can be made from the supported markers in this file. Choose All markers to see what is missing or
          unresolved.
        </div>
      )}
      <p className="mt-4 text-xs leading-5 text-slate-500">
        These are trait tendencies, not a diagnosis or a disease-risk score. Rule set {analysis.rulesVersion} · reviewed{" "}
        {analysis.reviewedAt}.
      </p>
      <div className="surface-panel mt-7 grid gap-5 p-5 sm:p-6 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <p className="section-label">Go beyond these markers</p>
          <h3 className="mt-2 text-lg font-semibold text-slate-900">Explore the evidence behind your variants</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            {enabled.length
              ? `${enabled.length} additional ${enabled.length === 1 ? "source is" : "sources are"} enabled. `
              : "Add clinical, gene–disease, population, and research datasets. "}
            Each source keeps its own evidence and coverage. Disease associations appear in reference matches, with
            their applicability to your call.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="primary-button" disabled={matching} onClick={onMatches}>
            {matching ? "Matching references…" : "Explore reference matches"}
          </button>
          <button type="button" className="secondary-button" disabled={matching} onClick={onReferences}>
            Manage data sources
          </button>
        </div>
      </div>
    </section>
  );
}
