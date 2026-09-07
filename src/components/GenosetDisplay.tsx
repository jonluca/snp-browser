import { useEffect, useMemo, useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import { Virtuoso } from "react-virtuoso";
import type { MatchedGenoset } from "../types/snp";
import { buildCsv, downloadCsvFile, type CsvColumn } from "../utils/csvExport";
import { plainWikiText } from "../utils/variantPresentation";
import { WikiContent } from "./WikiContent";

interface GenosetDisplayProps {
  genosets: MatchedGenoset[];
}

const idCollator = new Intl.Collator(undefined, { numeric: true });
function genosetSummary(genoset: MatchedGenoset): string {
  const summary = plainWikiText(genoset.parsedData.summary ?? "");
  if (summary) return summary;
  const text = plainWikiText(genoset.genoset.content);
  return text.length > 260 ? `${text.slice(0, 260).replace(/\s+\S*$/, "")}…` : text;
}

const GENOSET_EXPORT_COLUMNS: CsvColumn<MatchedGenoset>[] = [
  { header: "Genoset ID", value: (genoset) => genoset.genoset.id },
  { header: "Magnitude", value: (genoset) => genoset.parsedData.magnitude },
  { header: "Repute", value: (genoset) => genoset.parsedData.repute },
  { header: "Summary", value: (genoset) => genoset.parsedData.summary },
  { header: "Referenced Genotype Count", value: (genoset) => genoset.matchedGenotypes.length },
  {
    header: "Referenced User Genotypes",
    value: (genoset) =>
      genoset.matchedGenotypes
        .map((match) => `${match.rsid.toUpperCase()}: ${match.genotype.toUpperCase()}`)
        .join("; "),
  },
  {
    header: "Genotype IDs",
    value: (genoset) =>
      genoset.matchedGenotypes.flatMap((match) => (match.genotypeData?.id ? [match.genotypeData.id] : [])).join("; "),
  },
  { header: "Association Status", value: () => "Related page; full genoset conditions not evaluated" },
  { header: "SNPedia URL", value: (genoset) => `https://www.snpedia.com/index.php/${genoset.genoset.id}` },
];

export function GenosetDisplay({ genosets }: GenosetDisplayProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [sortMode, setSortMode] = useState("magnitude");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);
  const detailPaneRef = useRef<HTMLDivElement>(null);

  const filteredGenosets = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return genosets
      .filter(
        (genoset) =>
          !term ||
          [
            genoset.genoset.id,
            genoset.genoset.content,
            genoset.parsedData.summary,
            ...genoset.matchedGenotypes.map((match) => match.rsid),
          ].some((value) => value?.toLowerCase().includes(term)),
      )
      .sort((a, b) => {
        const byId = idCollator.compare(a.genoset.id, b.genoset.id);
        return sortMode === "id" ? byId : (b.parsedData.magnitude ?? -1) - (a.parsedData.magnitude ?? -1) || byId;
      });
  }, [genosets, searchTerm, sortMode]);

  const selectedGenoset = filteredGenosets.find((genoset) => genoset.genoset.id === selectedId);

  useEffect(() => {
    if (detailPaneRef.current) detailPaneRef.current.scrollTop = 0;
    if (selectedGenoset) {
      detailRef.current?.focus({ preventScroll: true });
      if (window.matchMedia("(max-width: 1023px)").matches) {
        detailPaneRef.current?.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedGenoset]);

  const itemContent = (index: number) => {
    const genoset = filteredGenosets[index];
    const isSelected = selectedGenoset?.genoset.id === genoset.genoset.id;

    return (
      <button
        type="button"
        aria-pressed={isSelected}
        aria-label={`View related genoset ${genoset.genoset.id.toUpperCase()}`}
        className="variant-row"
        onClick={() => setSelectedId(genoset.genoset.id)}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-sm font-semibold text-slate-900">{genoset.genoset.id}</span>
          <span className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500">
            Related page
          </span>
        </div>
        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-slate-600">
          {genosetSummary(genoset) || "Explore the genotype combination described in this SNPedia page."}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-slate-500">
          {genoset.parsedData.magnitude !== undefined && (
            <span>
              Magnitude <span className="text-slate-800">{genoset.parsedData.magnitude}</span>
            </span>
          )}
          <span>
            {genoset.matchedGenotypes.length} referenced genotype{genoset.matchedGenotypes.length !== 1 ? "s" : ""}
          </span>
          <span className="ml-auto text-brand-700" aria-hidden="true">
            →
          </span>
        </div>
      </button>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className={twMerge("surface-panel p-5 sm:p-6", selectedGenoset && "hidden lg:block")}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="section-label mb-2">Explore the connections</p>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Related genosets</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              These pages reference one or more of your genotypes. Full genoset conditions have not been evaluated, so
              these associations do not confirm a trait.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              downloadCsvFile("snp-related-genosets.csv", buildCsv(filteredGenosets, GENOSET_EXPORT_COLUMNS))
            }
            disabled={filteredGenosets.length === 0}
            className="secondary-button"
          >
            Export CSV{" "}
            <span aria-hidden="true" className="ml-1">
              ↓
            </span>
          </button>
        </div>
        <div className="mt-5">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
                className="pointer-events-none absolute top-3 left-3.5 size-5 text-slate-400"
              >
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m16 16 4 4" />
              </svg>
              <input
                ref={searchRef}
                type="search"
                aria-label="Search related genosets"
                placeholder="Search a genoset, variant, or keyword"
                value={searchTerm}
                onChange={(event) => {
                  setSearchTerm(event.target.value);
                  setSelectedId(null);
                }}
                className="field-control pl-11"
              />
            </div>
            <select
              aria-label="Sort related genosets"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value)}
              className="field-control sm:w-52"
            >
              <option value="magnitude">Magnitude: high to low</option>
              <option value="id">Genoset ID</option>
            </select>
          </div>
          <div className="mt-3 text-right text-xs tabular-nums text-slate-500" aria-live="polite">
            {filteredGenosets.length.toLocaleString()} of {genosets.length.toLocaleString()} related pages
          </div>
        </div>
      </div>

      <div className="workspace-split">
        <div className={twMerge("workspace-list flex flex-col overflow-hidden", selectedGenoset && "hidden lg:flex")}>
          {filteredGenosets.length > 0 ? (
            <Virtuoso
              style={{ height: "100%" }}
              totalCount={filteredGenosets.length}
              computeItemKey={(index) => filteredGenosets[index].genoset.id}
              itemContent={itemContent}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-5 text-center">
              <span
                aria-hidden="true"
                className="mb-4 grid size-12 place-items-center rounded-2xl bg-slate-50 text-xl text-slate-400"
              >
                ⌕
              </span>
              <h3 className="font-semibold text-slate-800">No related genosets found</h3>
              <p className="mt-2 max-w-64 text-sm leading-relaxed text-slate-500">
                {searchTerm.trim()
                  ? "Try a different keyword, variant ID, or genoset ID."
                  : "No genoset pages reference the genotypes matched in this file."}
              </p>
              {searchTerm.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchTerm("");
                    setSelectedId(null);
                    searchRef.current?.focus();
                  }}
                  className="secondary-button mt-5"
                >
                  Clear search
                </button>
              )}
            </div>
          )}
        </div>

        <div
          ref={detailPaneRef}
          className={twMerge("workspace-detail p-5 sm:p-7", !selectedGenoset && "hidden lg:block")}
        >
          {selectedGenoset ? (
            <article>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(null);
                  requestAnimationFrame(() => searchRef.current?.focus());
                }}
                className="detail-back"
              >
                ← Back to results
              </button>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="section-label mb-2">Related genoset</p>
                  <h3
                    ref={detailRef}
                    tabIndex={-1}
                    className="font-mono text-2xl font-semibold tracking-tight text-slate-950 outline-none"
                  >
                    {selectedGenoset.genoset.id}
                  </h3>
                </div>
                <a
                  href={`https://www.snpedia.com/index.php/${selectedGenoset.genoset.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 text-xs font-medium text-brand-700 hover:underline"
                >
                  Open SNPedia <span aria-hidden="true">↗</span>
                </a>
              </div>
              <p className="mt-5 text-lg leading-relaxed text-slate-800">
                {genosetSummary(selectedGenoset) || "No summary is available. Review the genoset research below."}
              </p>
              <dl className="my-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200">
                <div
                  className="bg-white p-3.5"
                  title="SNPedia's editorial measure of interest; not a probability or risk score."
                >
                  <dt className="text-[11px] font-medium text-slate-500">Magnitude</dt>
                  <dd className="mt-1 text-sm font-semibold text-slate-800">
                    {selectedGenoset.parsedData.magnitude ?? "Not rated"}
                  </dd>
                </div>
                <div className="bg-white p-3.5">
                  <dt className="text-[11px] font-medium text-slate-500">SNPedia repute</dt>
                  <dd className="mt-1 text-sm font-semibold capitalize text-slate-800">
                    {plainWikiText(selectedGenoset.parsedData.repute ?? "") || "Not listed"}
                  </dd>
                </div>
              </dl>
              <section className="border-t border-slate-200 pt-5">
                <h4 className="text-sm font-semibold text-slate-900">Your genotypes referenced on this page</h4>
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                  These references connect this page to your file; they do not establish that you meet all of its
                  conditions.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {selectedGenoset.matchedGenotypes.map((match) => (
                    <a
                      key={match.rsid}
                      href={`https://www.snpedia.com/index.php/${encodeURIComponent(match.genotypeData?.id ?? match.rsid)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-700 hover:bg-brand-100"
                    >
                      <span className="font-mono font-medium">{match.rsid}</span>
                      <span className="font-semibold">{match.genotype.toUpperCase()}</span>
                      <span aria-hidden="true">↗</span>
                    </a>
                  ))}
                </div>
              </section>
              {selectedGenoset.genoset.content && (
                <section className="mt-6 border-t border-slate-200 pt-5">
                  <h4 className="mb-4 text-sm font-semibold text-slate-900">Genoset research & conditions</h4>
                  <WikiContent content={selectedGenoset.genoset.content} hideSummary />
                </section>
              )}
            </article>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div
                aria-hidden="true"
                className="mb-5 grid size-14 place-items-center rounded-2xl border border-brand-100 bg-brand-50 text-2xl text-brand-600"
              >
                ↗
              </div>
              <h3 className="text-xl font-semibold tracking-tight text-slate-800">Explore a genotype combination</h3>
              <p className="mt-3 max-w-xs text-sm leading-relaxed text-slate-500">
                Choose a related page to see its research and the genotypes that connect it to your file.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
