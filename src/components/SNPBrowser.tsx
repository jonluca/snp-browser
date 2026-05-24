import { useCallback, useEffect, useState } from "react";
import { twMerge } from "tailwind-merge";
import { Virtuoso } from "react-virtuoso";
import type { Remote } from "comlink";
import type { SNPRecord } from "../types/snp";
import type { SNPMatcherWorkerApi } from "../workers/snpMatcher.worker";
import { buildCsv, downloadCsvFile, type CsvColumn } from "../utils/csvExport";
import { extractSnpediaFields } from "../utils/snpediaFields";
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

export function SNPBrowser({ workerApi }: SNPBrowserProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [chromosome, setChromosome] = useState("");
  const [gene, setGene] = useState("");
  const [clinicalSignificance, setClinicalSignificance] = useState("");
  const [disease, setDisease] = useState("");
  const [results, setResults] = useState<SNPRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedSNP, setSelectedSNP] = useState<SNPRecord | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Perform search when filters change
  useEffect(() => {
    let isCurrent = true;

    async function performSearch() {
      if (!isCurrent) return;

      setIsSearching(true);
      try {
        const { results: newResults, total: newTotal } = await workerApi.searchSNPs({
          searchTerm: searchTerm || undefined,
          chromosome: chromosome || undefined,
          gene: gene || undefined,
          clinicalSignificance: clinicalSignificance || undefined,
          disease: disease || undefined,
          limit: PAGE_SIZE,
          offset: 0,
        });

        if (!isCurrent) return;

        setResults(newResults);
        setTotal(newTotal);
        setSelectedSNP(null);
      } catch (error) {
        if (isCurrent) {
          console.error("Search error:", error);
        }
      } finally {
        if (isCurrent) {
          setIsSearching(false);
        }
      }
    }

    const timeoutId = window.setTimeout(() => {
      void performSearch();
    }, 0);

    return () => {
      isCurrent = false;
      window.clearTimeout(timeoutId);
    };
  }, [workerApi, searchTerm, chromosome, gene, clinicalSignificance, disease]);

  const loadMoreResults = useCallback(async () => {
    if (isSearching || isLoadingMore || results.length >= total) return;

    setIsLoadingMore(true);
    try {
      const { results: newResults, total: newTotal } = await workerApi.searchSNPs({
        searchTerm: searchTerm || undefined,
        chromosome: chromosome || undefined,
        gene: gene || undefined,
        clinicalSignificance: clinicalSignificance || undefined,
        disease: disease || undefined,
        limit: PAGE_SIZE,
        offset: results.length,
      });

      setResults((currentResults) => [...currentResults, ...newResults]);
      setTotal(newTotal);
    } catch (error) {
      console.error("Search error:", error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    chromosome,
    clinicalSignificance,
    disease,
    gene,
    isLoadingMore,
    isSearching,
    results.length,
    searchTerm,
    total,
    workerApi,
  ]);

  const handleClearFilters = () => {
    setSearchTerm("");
    setChromosome("");
    setGene("");
    setClinicalSignificance("");
    setDisease("");
  };

  const handleExportResults = async () => {
    if (total === 0) return;

    setIsExporting(true);
    try {
      const { results: exportResults } = await workerApi.searchSNPs({
        searchTerm: searchTerm || undefined,
        chromosome: chromosome || undefined,
        gene: gene || undefined,
        clinicalSignificance: clinicalSignificance || undefined,
        disease: disease || undefined,
        limit: total,
        offset: 0,
      });
      downloadCsvFile("snp-browser-results.csv", buildCsv(exportResults.map(toExportRow), SNP_BROWSER_EXPORT_COLUMNS));
    } catch (error) {
      console.error("Export error:", error);
    } finally {
      setIsExporting(false);
    }
  };

  const hasActiveFilters = searchTerm || chromosome || gene || clinicalSignificance || disease;
  const hasMoreResults = results.length < total;

  const itemContent = (index: number) => {
    const snp = results[index];
    if (!snp) return null;

    const isSelected = selectedSNP?.rsid === snp.rsid;
    return (
      <button
        type="button"
        className={twMerge(
          "w-full cursor-pointer rounded-xl border border-transparent p-3 text-left transition-colors",
          isSelected ? "border-brand-100 bg-brand-50" : "bg-white hover:bg-slate-50",
        )}
        onClick={() => setSelectedSNP(snp)}
      >
        <div className="mb-1">
          <span className="text-sm font-semibold text-slate-900">{snp.rsid.toUpperCase()}</span>
        </div>
        {snp.content && (
          <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-slate-500">
            {snp.content.substring(0, 100)}...
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col gap-5">
      {/* Search and Filters */}
      <div className="surface-panel p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="section-label mb-2">Reference search</p>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Browse SNP database</h2>
            <p className="mt-1 text-sm text-slate-500">Search SNPedia records by variant, gene or clinical context.</p>
          </div>
          {hasActiveFilters && (
            <button type="button" onClick={handleClearFilters} className="secondary-button px-3 py-2">
              Clear all filters
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {/* General Search */}
          <div className="lg:col-span-3">
            <label
              htmlFor="snp-search"
              className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Search
            </label>
            <input
              id="snp-search"
              type="text"
              aria-label="Search SNP database"
              placeholder="Search by rsid, gene, disease, or content..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="field-control"
            />
          </div>

          {/* Chromosome */}
          <div>
            <label
              htmlFor="snp-chromosome"
              className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Chromosome
            </label>
            <select
              id="snp-chromosome"
              value={chromosome}
              onChange={(e) => setChromosome(e.target.value)}
              className="field-control"
            >
              <option value="">All</option>
              {CHROMOSOMES.map((chr) => (
                <option key={chr} value={chr}>
                  {chr}
                </option>
              ))}
            </select>
          </div>

          {/* Gene */}
          <div>
            <label
              htmlFor="snp-gene"
              className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Gene
            </label>
            <input
              id="snp-gene"
              type="text"
              aria-label="Filter by gene"
              placeholder="e.g. BRCA1"
              value={gene}
              onChange={(e) => setGene(e.target.value)}
              className="field-control"
            />
          </div>

          {/* Clinical Significance */}
          <div>
            <label
              htmlFor="snp-clinical-significance"
              className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Clinical significance
            </label>
            <select
              id="snp-clinical-significance"
              value={clinicalSignificance}
              onChange={(e) => setClinicalSignificance(e.target.value)}
              className="field-control"
            >
              <option value="">All</option>
              {CLINICAL_SIGNIFICANCE_OPTIONS.map((sig) => (
                <option key={sig} value={sig}>
                  {sig}
                </option>
              ))}
            </select>
          </div>

          {/* Disease */}
          <div className="lg:col-span-2">
            <label
              htmlFor="snp-disease"
              className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Disease
            </label>
            <input
              id="snp-disease"
              type="text"
              aria-label="Filter by disease"
              placeholder="e.g. diabetes, cancer..."
              value={disease}
              onChange={(e) => setDisease(e.target.value)}
              className="field-control"
            />
          </div>
        </div>

        {/* Results count */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <div className="text-sm text-slate-500">
            {isSearching ? (
              "Searching..."
            ) : (
              <>
                Showing {results.length.toLocaleString()} of {total.toLocaleString()} SNP{total !== 1 ? "s" : ""}
                {hasActiveFilters && " (filtered)"}
                {isLoadingMore && " - loading more..."}
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleExportResults()}
            disabled={isSearching || isExporting || total === 0}
            className="primary-button"
          >
            {isExporting ? "Exporting..." : "Export CSV"}
          </button>
        </div>
      </div>

      {/* Results area */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* Left panel - List of results */}
        <div className="surface-panel h-[360px] flex-shrink-0 overflow-hidden p-2 lg:h-[640px] lg:w-[390px]">
          <Virtuoso
            style={{ height: "100%" }}
            totalCount={results.length}
            itemContent={itemContent}
            endReached={hasMoreResults ? loadMoreResults : undefined}
          />
        </div>

        {/* Right panel - Selected SNP details */}
        <div className="surface-panel min-h-[320px] flex-1 overflow-y-auto p-5 sm:p-6 lg:h-[640px]">
          {selectedSNP ? (
            <div>
              <p className="section-label mb-2">Variant detail</p>
              <h3 className="mt-0 text-2xl font-semibold tracking-tight text-slate-950">
                {selectedSNP.rsid.toUpperCase()}
              </h3>

              {/* SNPedia Content */}
              {selectedSNP.content && (
                <div className="subtle-panel mt-5 p-4">
                  <h4 className="mb-3 text-sm font-semibold text-slate-800">SNPedia information</h4>
                  <WikiContent content={selectedSNP.content} />
                </div>
              )}
            </div>
          ) : (
            <div className="flex min-h-[280px] flex-col items-center justify-center text-center text-slate-400">
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-slate-50 text-slate-400">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="size-6 fill-none stroke-current"
                  strokeWidth="1.7"
                >
                  <path d="M11 19a8 8 0 1 1 5.3-14M16 16l5 5" strokeLinecap="round" />
                </svg>
              </div>
              <p className="text-sm font-medium text-slate-500">Select a SNP to view its details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
