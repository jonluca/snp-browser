import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { twMerge } from "tailwind-merge";
import { Virtuoso } from "react-virtuoso";
import type { Remote } from "comlink";
import type { SNPRecord } from "../types/snp";
import type { SNPMatcherWorkerApi } from "../workers/snpMatcher.worker";
import type { SNPSearchSort } from "../workers/snpSearch";
import { buildCsv, downloadCsvFile, type CsvColumn } from "../utils/csvExport";
import { extractSnpediaFields } from "../utils/snpediaFields";
import { getVariantPresentation } from "../utils/variantPresentation";
import { WikiContent } from "./WikiContent";

interface SNPBrowserProps {
  workerApi: Remote<SNPMatcherWorkerApi>;
}
interface SNPBrowserExportRow {
  rsid: string;
  geneSymbol?: string;
  magnitude?: number;
  repute?: string;
  summary?: string;
  clinicalSignificance?: string;
  disease?: string;
  snpediaUrl: string;
  scrapedAt?: string;
}
const CHROMOSOMES = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
  "22",
  "X",
  "Y",
  "MT",
];

const CLINICAL_SIGNIFICANCE_OPTIONS = [
  "Pathogenic",
  "Likely pathogenic",
  "Benign",
  "Likely benign",
  "Uncertain significance",
  "risk factor",
  "association",
];

const SNP_BROWSER_EXPORT_COLUMNS: CsvColumn<SNPBrowserExportRow>[] = [
  { header: "RSID", value: (snp) => snp.rsid },
  { header: "Gene Symbol", value: (snp) => snp.geneSymbol },
  { header: "Magnitude", value: (snp) => snp.magnitude },
  { header: "Repute", value: (snp) => snp.repute },
  { header: "Summary", value: (snp) => snp.summary },
  { header: "Clinical Significance", value: (snp) => snp.clinicalSignificance },
  { header: "Disease", value: (snp) => snp.disease },
  { header: "SNPedia URL", value: (snp) => snp.snpediaUrl },
  { header: "Scraped At", value: (snp) => snp.scrapedAt },
];

const PAGE_SIZE = 100;

function toExportRow(snp: SNPRecord): SNPBrowserExportRow {
  const fields = extractSnpediaFields(snp.content, snp);
  return {
    rsid: snp.rsid,
    geneSymbol: fields.geneSymbol,
    magnitude: fields.magnitude,
    repute: fields.repute,
    summary: fields.summary,
    clinicalSignificance: fields.clinicalSignificance,
    disease: fields.disease,
    snpediaUrl: `https://www.snpedia.com/index.php/${snp.rsid}`,
    scrapedAt: snp.scraped_at,
  };
}

const EMPTY_FILTERS = { searchTerm: "", chromosome: "", gene: "", clinicalSignificance: "", disease: "" };
type Filters = typeof EMPTY_FILTERS;

function useDebouncedFilters(filters: Filters) {
  const [settled, setSettled] = useState(filters);
  useEffect(() => {
    const timeout = window.setTimeout(() => setSettled(filters), 180);
    return () => window.clearTimeout(timeout);
  }, [filters]);
  return settled;
}

export function SNPBrowser({ workerApi }: SNPBrowserProps) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const queryFilters = useDebouncedFilters(filters);
  const [sortBy, setSortBy] = useState<SNPSearchSort>("relevance");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailPaneRef = useRef<HTMLDivElement>(null);
  const isDebouncing = filters !== queryFilters;
  const {
    data,
    error: searchError,
    isPending,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey: ["snp-browser", queryFilters, sortBy],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => workerApi.searchSNPs({ ...queryFilters, sortBy, limit: PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((count, page) => count + page.results.length, 0);
      return lastPage.results.length > 0 && loaded < lastPage.total ? loaded : undefined;
    },
  });
  const results = isDebouncing ? [] : (data?.pages.flatMap((page) => page.results) ?? []);
  const total = isDebouncing ? 0 : (data?.pages[0]?.total ?? 0);
  const isSearching = isPending || isDebouncing;
  const selectedSNP = results.find((snp) => snp.rsid === selectedId) ?? results[0] ?? null;
  const selectedFields = selectedSNP ? getVariantPresentation(selectedSNP) : null;
  const activeFilters = (Object.entries(filters) as [keyof Filters, string][]).filter(([, value]) => value.trim());
  const advancedCount = activeFilters.filter(([key]) => key !== "searchTerm").length;
  const {
    isPending: isExporting,
    error: exportError,
    mutate: exportResults,
    reset: resetExport,
  } = useMutation({
    mutationFn: async () => {
      const { results: exportedSNPs } = await workerApi.searchSNPs({
        ...queryFilters,
        sortBy,
        limit: total,
        offset: 0,
      });
      downloadCsvFile("snp-browser-results.csv", buildCsv(exportedSNPs.map(toExportRow), SNP_BROWSER_EXPORT_COLUMNS));
    },
  });

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target?.isContentEditable ||
        target?.closest("input, textarea, select")
      )
        return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (detailOpen) {
      detailHeadingRef.current?.focus({ preventScroll: true });
      if (window.matchMedia("(max-width: 1023px)").matches) detailPaneRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [detailOpen, selectedId]);

  useEffect(() => {
    if (detailPaneRef.current) detailPaneRef.current.scrollTop = 0;
  }, [selectedSNP?.rsid]);

  const updateFilter = (key: keyof Filters, value: string) => {
    setFilters((current) => (current[key] === value ? current : { ...current, [key]: value }));
    setSelectedId(null);
    setDetailOpen(false);
    if (!isExporting) resetExport();
  };
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSelectedId(null);
    setDetailOpen(false);
    if (!isExporting) resetExport();
    searchRef.current?.focus();
  };
  const loadMore = () => {
    if (!isFetching && !isDebouncing && hasNextPage) void fetchNextPage({ cancelRefetch: false });
  };
  const backToList = () => {
    setDetailOpen(false);
    // Return focus to the selected virtualized row when it is still mounted.
    requestAnimationFrame(() => document.getElementById(`reference-${selectedId}`)?.focus({ preventScroll: true }));
  };
  const filterLabels: Record<keyof Filters, string> = {
    searchTerm: "Search",
    chromosome: "Chromosome",
    gene: "Gene",
    clinicalSignificance: "Clinical significance",
    disease: "Condition",
  };

  return (
    <section className="space-y-4" aria-label="Reference explorer">
      <div className={twMerge("flex flex-wrap items-end justify-between gap-4", detailOpen && "hidden lg:flex")}>
        <div>
          <p className="section-label mb-2">SNPedia reference</p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">Explore the database</h1>
          <p className="mt-2 text-sm text-slate-500">Find a variant, follow a gene, or explore a condition.</p>
        </div>
        <button
          type="button"
          onClick={() => exportResults()}
          disabled={isSearching || isExporting || total === 0}
          className="secondary-button inline-flex items-center gap-2"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 fill-none stroke-current" strokeWidth="1.5">
            <path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {isExporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>

      <div className={twMerge("surface-panel p-3 sm:p-4", detailOpen && "hidden lg:block")}>
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="relative min-w-0 flex-1">
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 fill-none stroke-slate-400"
              strokeWidth="1.6"
            >
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4 4" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              type="search"
              aria-label="Search SNP database"
              placeholder="Search rsID, gene, or condition…"
              value={filters.searchTerm}
              onChange={(event) => updateFilter("searchTerm", event.target.value)}
              className="field-control pl-10 pr-10"
            />
            {!filters.searchTerm && (
              <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-slate-200 px-1.5 text-xs text-slate-400 sm:block">
                /
              </kbd>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            aria-expanded={showFilters}
            aria-controls="reference-filters"
            className={twMerge(
              "secondary-button inline-flex shrink-0 items-center gap-2",
              (showFilters || advancedCount > 0) && "border-brand-500 bg-brand-50 text-brand-700",
            )}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 fill-none stroke-current" strokeWidth="1.5">
              <path d="M3 5h14M3 10h14M3 15h14M7 3v4m6 1v4m-5 1v4" strokeLinecap="round" />
            </svg>
            Filters{advancedCount > 0 && <span className="rounded bg-brand-100 px-1.5 text-xs">{advancedCount}</span>}
          </button>
        </div>
        {showFilters && (
          <div
            id="reference-filters"
            className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Chromosome
              <select
                aria-label="Filter by chromosome"
                value={filters.chromosome}
                onChange={(e) => updateFilter("chromosome", e.target.value)}
                className="field-control"
              >
                <option value="">All chromosomes</option>
                {CHROMOSOMES.map((chr) => (
                  <option key={chr} value={chr}>
                    {chr}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Gene
              <input
                aria-label="Filter by gene"
                placeholder="e.g. BRCA1"
                value={filters.gene}
                onChange={(e) => updateFilter("gene", e.target.value)}
                className="field-control"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Clinical significance
              <select
                aria-label="Filter by clinical significance"
                value={filters.clinicalSignificance}
                onChange={(e) => updateFilter("clinicalSignificance", e.target.value)}
                className="field-control"
              >
                <option value="">Any significance</option>
                {CLINICAL_SIGNIFICANCE_OPTIONS.map((sig) => (
                  <option key={sig} value={sig}>
                    {sig}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Condition
              <input
                aria-label="Filter by condition"
                placeholder="e.g. diabetes"
                value={filters.disease}
                onChange={(e) => updateFilter("disease", e.target.value)}
                className="field-control"
              />
            </label>
          </div>
        )}
        {activeFilters.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Active filters">
            {activeFilters.map(([key, value]) => (
              <button
                key={key}
                type="button"
                onClick={() => updateFilter(key, "")}
                aria-label={`Remove ${filterLabels[key].toLowerCase()} filter: ${value}`}
                className="filter-chip max-w-full"
              >
                <span className="truncate">
                  {filterLabels[key]}: {value}
                </span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
            <button
              type="button"
              onClick={clearFilters}
              className="cursor-pointer px-1 py-1 text-xs font-medium text-slate-500 hover:text-brand-700"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {(searchError || exportError) && !isDebouncing && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          <p>{(searchError || exportError)?.message}</p>
          {searchError && (
            <button
              type="button"
              onClick={() => void (isFetchNextPageError ? fetchNextPage({ cancelRefetch: false }) : refetch())}
              className="secondary-button"
              disabled={isFetching}
            >
              Retry search
            </button>
          )}
        </div>
      )}

      <div className="workspace-split surface-panel">
        <div className={twMerge("workspace-list flex-col", detailOpen ? "hidden lg:flex" : "flex")}>
          <div className="flex items-center justify-between gap-2 border-b border-slate-200/70 px-4 py-3">
            <p aria-live="polite" className="text-xs font-medium text-slate-500">
              {isSearching ? "Searching…" : `${total.toLocaleString()} variant${total !== 1 ? "s" : ""}`}
            </p>
            <select
              aria-label="Sort reference results"
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value as SNPSearchSort);
                setSelectedId(null);
                setDetailOpen(false);
              }}
              className="max-w-36 cursor-pointer rounded-md border-0 bg-transparent py-1 text-xs font-medium text-slate-600 focus:outline-brand-500"
            >
              <option value="relevance">Best match</option>
              <option value="rsid-asc">RSID: A–Z</option>
              <option value="rsid-desc">RSID: Z–A</option>
            </select>
          </div>
          <div className="min-h-0 flex-1" aria-busy={isSearching}>
            {isSearching ? (
              <div className="space-y-6 p-5" aria-label="Loading variants">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="animate-pulse space-y-3">
                    <div className="h-3 w-24 rounded bg-slate-200" />
                    <div className="h-2 w-full rounded bg-slate-100" />
                    <div className="h-2 w-2/3 rounded bg-slate-100" />
                  </div>
                ))}
              </div>
            ) : results.length === 0 ? (
              <div className="empty-state h-full px-6">
                <span className="mb-3 text-3xl text-slate-300" aria-hidden="true">
                  ⌕
                </span>
                <h2 className="font-semibold text-slate-800">
                  {searchError ? "Search unavailable" : "No variants found"}
                </h2>
                <p className="mt-2 max-w-xs text-sm leading-6 text-slate-500">
                  {searchError
                    ? "Retry the search to load reference records."
                    : "Try a different rsID or remove a filter to broaden your search."}
                </p>
                {activeFilters.length > 0 && (
                  <button type="button" onClick={clearFilters} className="secondary-button mt-4">
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <Virtuoso
                key={JSON.stringify([queryFilters, sortBy])}
                style={{ height: "100%" }}
                data={results}
                computeItemKey={(_, snp) => snp.rsid}
                endReached={hasNextPage ? loadMore : undefined}
                itemContent={(_, snp) => {
                  const fields = getVariantPresentation(snp);
                  return (
                    <button
                      id={`reference-${snp.rsid}`}
                      type="button"
                      className="variant-row"
                      aria-pressed={selectedSNP?.rsid === snp.rsid}
                      onClick={() => {
                        setSelectedId(snp.rsid);
                        setDetailOpen(true);
                      }}
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold tracking-tight text-slate-900">
                          {snp.rsid}
                        </span>
                        {fields.geneSymbol && (
                          <span className="max-w-36 truncate text-xs font-medium text-brand-700">
                            {fields.geneSymbol}
                          </span>
                        )}
                      </div>
                      <p className="line-clamp-2 text-xs leading-5 text-slate-500">{fields.preview}</p>
                      {fields.clinicalSignificance && (
                        <span className="tag mt-2 max-w-full truncate">{fields.clinicalSignificance}</span>
                      )}
                    </button>
                  );
                }}
              />
            )}
          </div>
          {results.length > 0 && (
            <div className="flex min-h-10 items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
              <span>{results.length.toLocaleString()} loaded</span>
              {isFetchingNextPage ? (
                <span role="status">Loading more…</span>
              ) : hasNextPage ? (
                <button type="button" onClick={loadMore} className="cursor-pointer font-medium text-brand-700">
                  Load more
                </button>
              ) : (
                <span>End of results</span>
              )}
            </div>
          )}
        </div>

        <div
          ref={detailPaneRef}
          className={twMerge("workspace-detail", detailOpen ? "block" : "hidden lg:block")}
          onKeyDown={(e) => {
            if (e.key === "Escape" && detailOpen) {
              e.preventDefault();
              backToList();
            }
          }}
        >
          {selectedSNP && selectedFields ? (
            <article className="p-5 sm:p-7">
              <button type="button" onClick={backToList} className="detail-back mb-5">
                ← Back to variants
              </button>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="section-label mb-2">Variant record</p>
                  <h2
                    ref={detailHeadingRef}
                    tabIndex={-1}
                    className="font-mono text-2xl font-semibold tracking-tight text-slate-950 focus:outline-none sm:text-3xl"
                  >
                    {selectedSNP.rsid}
                  </h2>
                </div>
                <a
                  href={`https://www.snpedia.com/index.php/${encodeURIComponent(selectedSNP.rsid)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                >
                  View on SNPedia <span aria-hidden="true">↗</span>
                </a>
              </div>
              {selectedFields.summary && (
                <p className="mt-5 text-lg leading-7 text-slate-700">{selectedFields.summary}</p>
              )}
              <dl className="my-6 grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border border-slate-100 bg-slate-50/70 p-4 text-sm">
                <div>
                  <dt className="mb-1 text-xs text-slate-400">Gene</dt>
                  <dd className="break-words font-medium text-slate-800">
                    {selectedFields.geneSymbol || "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt className="mb-1 text-xs text-slate-400">Clinical significance</dt>
                  <dd className="break-words font-medium text-slate-800">
                    {selectedFields.clinicalSignificance || "Not classified"}
                  </dd>
                </div>
                {selectedSNP.chromosome && (
                  <div>
                    <dt className="mb-1 text-xs text-slate-400">Chromosome</dt>
                    <dd className="font-medium text-slate-800">
                      {selectedSNP.chromosome}
                      {selectedSNP.position ? ` · ${Number(selectedSNP.position).toLocaleString()}` : ""}
                    </dd>
                  </div>
                )}
                {selectedFields.disease && (
                  <div className="col-span-2">
                    <dt className="mb-1 text-xs text-slate-400">Associated condition</dt>
                    <dd className="break-words leading-6 text-slate-700">{selectedFields.disease}</dd>
                  </div>
                )}
              </dl>
              <div className="border-t border-slate-100 pt-5">
                <h3 className="mb-4 text-sm font-semibold text-slate-900">Reference notes</h3>
                <WikiContent content={selectedSNP.content} hideSummary={Boolean(selectedFields.summary)} />
              </div>
              <p className="mt-8 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-400">
                Source: SNPedia
                {selectedSNP.scraped_at && !Number.isNaN(Date.parse(selectedSNP.scraped_at))
                  ? ` · Retrieved ${new Date(selectedSNP.scraped_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
                  : ""}
              </p>
            </article>
          ) : (
            <div className="empty-state h-full px-8">
              <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="size-7 fill-none stroke-current"
                  strokeWidth="1.3"
                >
                  <path d="M7 3c10 4 0 14 10 18M17 3C7 7 17 17 7 21M8.5 7h7M7.5 12h9M8.5 17h7" strokeLinecap="round" />
                </svg>
              </div>
              <h2 className="font-semibold text-slate-800">A closer look at each variant</h2>
              <p className="mt-2 max-w-xs text-center text-sm leading-6 text-slate-500">
                Choose a record to read its summary, gene information, and source notes.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
