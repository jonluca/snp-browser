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
      <div
        className={twMerge(
          "cursor-pointer border-b border-gray-200 p-3 transition-colors",
          isSelected ? "bg-blue-50" : "bg-white hover:bg-gray-50",
        )}
        onClick={() => setSelectedSNP(snp)}
      >
        <div className="mb-1">
          <span className="text-sm font-bold text-gray-900">{snp.rsid.toUpperCase()}</span>
        </div>
        {snp.content && (
          <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-500">
            {snp.content.substring(0, 100)}...
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Search and Filters */}
      <div className="rounded border border-gray-300 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900">Browse SNP Database</h2>
          {hasActiveFilters && (
            <button onClick={handleClearFilters} className="text-sm text-blue-600 hover:text-blue-800 hover:underline">
              Clear all filters
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {/* General Search */}
          <div className="lg:col-span-3">
            <label className="mb-1 block text-xs font-medium text-gray-700">Search</label>
            <input
              type="text"
              placeholder="Search by rsid, gene, disease, or content..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Chromosome */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Chromosome</label>
            <select
              value={chromosome}
              onChange={(e) => setChromosome(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
            <label className="mb-1 block text-xs font-medium text-gray-700">Gene</label>
            <input
              type="text"
              placeholder="e.g. BRCA1"
              value={gene}
              onChange={(e) => setGene(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Clinical Significance */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Clinical Significance</label>
            <select
              value={clinicalSignificance}
              onChange={(e) => setClinicalSignificance(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
            <label className="mb-1 block text-xs font-medium text-gray-700">Disease</label>
            <input
              type="text"
              placeholder="e.g. diabetes, cancer..."
              value={disease}
              onChange={(e) => setDisease(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Results count */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-sm text-gray-600">
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
            className={twMerge(
              "rounded bg-blue-500 px-3 py-2 text-sm font-medium text-white transition-colors",
              isSearching || isExporting || total === 0
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer hover:bg-blue-600",
            )}
          >
            {isExporting ? "Exporting..." : "Export CSV"}
          </button>
        </div>
      </div>

      {/* Results area */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Left panel - List of results */}
        <div className="w-[400px] flex-shrink-0 overflow-hidden rounded border border-gray-300">
          <Virtuoso
            style={{ height: "600px" }}
            totalCount={results.length}
            itemContent={itemContent}
            endReached={hasMoreResults ? loadMoreResults : undefined}
          />
        </div>

        {/* Right panel - Selected SNP details */}
        <div className="flex-1 overflow-y-auto rounded border border-gray-300 bg-gray-50 p-4">
          {selectedSNP ? (
            <div>
              <h3 className="mt-0 text-2xl font-bold text-gray-900">{selectedSNP.rsid.toUpperCase()}</h3>

              {/* SNPedia Content */}
              {selectedSNP.content && (
                <div className="mb-4 rounded bg-white p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">SNPedia Information</h4>
                  <WikiContent content={selectedSNP.content} />
                </div>
              )}
            </div>
          ) : (
            <div className="mt-24 text-center text-gray-400">Select a SNP from the list to view details</div>
          )}
        </div>
      </div>
    </div>
  );
}
