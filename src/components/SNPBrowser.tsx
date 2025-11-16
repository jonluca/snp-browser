import { useState, useCallback, useEffect } from "react";
import { Virtuoso } from "react-virtuoso";
import type { Remote } from "comlink";
import type { SNPRecord } from "../types/snp";
import type { SNPMatcherWorkerApi } from "../workers/snpMatcher.worker";

interface SNPBrowserProps {
  workerApi: Remote<SNPMatcherWorkerApi>;
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
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const performSearch = useCallback(
    async (resetPage = false) => {
      setIsSearching(true);
      try {
        const currentPage = resetPage ? 0 : page;
        if (resetPage) setPage(0);

        const { results: newResults, total: newTotal } = await workerApi.searchSNPs({
          searchTerm: searchTerm || undefined,
          chromosome: chromosome || undefined,
          gene: gene || undefined,
          clinicalSignificance: clinicalSignificance || undefined,
          disease: disease || undefined,
          limit: pageSize,
          offset: currentPage * pageSize,
        });

        setResults(newResults);
        setTotal(newTotal);
      } catch (error) {
        console.error("Search error:", error);
      } finally {
        setIsSearching(false);
      }
    },
    [workerApi, searchTerm, chromosome, gene, clinicalSignificance, disease, page, pageSize],
  );

  // Perform search when filters change
  useEffect(() => {
    performSearch(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, chromosome, gene, clinicalSignificance, disease]);

  // Perform search when page changes
  useEffect(() => {
    performSearch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const handleClearFilters = () => {
    setSearchTerm("");
    setChromosome("");
    setGene("");
    setClinicalSignificance("");
    setDisease("");
    setPage(0);
  };

  const hasActiveFilters = searchTerm || chromosome || gene || clinicalSignificance || disease;

  const itemContent = (index: number) => {
    const snp = results[index];
    if (!snp) return null;

    const isSelected = selectedSNP?.rsid === snp.rsid;
    return (
      <div
        className={`cursor-pointer border-b border-gray-200 p-3 transition-colors ${
          isSelected ? "bg-blue-50" : "bg-white hover:bg-gray-50"
        }`}
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

  const totalPages = Math.ceil(total / pageSize);

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
        <div className="mt-3 text-sm text-gray-600">
          {isSearching ? (
            "Searching..."
          ) : (
            <>
              Showing {results.length} of {total.toLocaleString()} SNP{total !== 1 ? "s" : ""}
              {hasActiveFilters && " (filtered)"}
            </>
          )}
        </div>
      </div>

      {/* Results area */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Left panel - List of results */}
        <div className="w-[400px] flex-shrink-0">
          <div className="overflow-hidden rounded border border-gray-300">
            <Virtuoso style={{ height: "600px" }} totalCount={results.length} itemContent={itemContent} />
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="rounded border border-gray-300 bg-white px-3 py-1 text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-gray-600">
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="rounded border border-gray-300 bg-white px-3 py-1 text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
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
                  <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-800">
                    {selectedSNP.content}
                  </div>
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
