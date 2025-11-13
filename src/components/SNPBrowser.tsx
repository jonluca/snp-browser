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
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-bold text-gray-900">{snp.rsid.toUpperCase()}</span>
          {snp.clin_sig && (
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                snp.clin_sig.toLowerCase().includes("pathogenic")
                  ? "bg-red-100 text-red-800"
                  : snp.clin_sig.toLowerCase().includes("benign")
                    ? "bg-green-100 text-green-800"
                    : "bg-yellow-100 text-yellow-800"
              }`}
            >
              {snp.clin_sig}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-600">
          {snp.chromosome && <span>Chr: {snp.chromosome}</span>}
          {snp.position && <span className="ml-2">Pos: {snp.position.toLocaleString()}</span>}
          {(snp.gene || snp.gene_s || snp.clin_gene_name) && (
            <span className="ml-2">Gene: {snp.gene || snp.gene_s || snp.clin_gene_name}</span>
          )}
        </div>
        {snp.clin_disease && <div className="mt-1 text-xs text-gray-500">Disease: {snp.clin_disease}</div>}
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

              {/* Basic Info */}
              <div className="mb-4 rounded bg-white p-3 shadow-sm">
                <h4 className="mb-2 text-sm font-semibold text-gray-800">Genomic Location</h4>
                {selectedSNP.chromosome && (
                  <div className="mb-1 text-sm">
                    <strong className="text-gray-700">Chromosome:</strong> {selectedSNP.chromosome}
                  </div>
                )}
                {selectedSNP.position && (
                  <div className="mb-1 text-sm">
                    <strong className="text-gray-700">Position:</strong> {selectedSNP.position.toLocaleString()}
                  </div>
                )}
                {(selectedSNP.gene || selectedSNP.gene_s || selectedSNP.clin_gene_name) && (
                  <div className="mb-1 text-sm">
                    <strong className="text-gray-700">Gene:</strong>{" "}
                    {selectedSNP.gene || selectedSNP.gene_s || selectedSNP.clin_gene_name}
                  </div>
                )}
                {selectedSNP.assembly && (
                  <div className="mb-1 text-sm">
                    <strong className="text-gray-700">Assembly:</strong> {selectedSNP.assembly}
                  </div>
                )}
              </div>

              {/* Genotypes */}
              {(selectedSNP.geno1 || selectedSNP.geno2 || selectedSNP.geno3) && (
                <div className="mb-4 rounded bg-white p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">Genotypes</h4>
                  {selectedSNP.geno1 && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Genotype 1:</strong> {selectedSNP.geno1}
                    </div>
                  )}
                  {selectedSNP.geno2 && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Genotype 2:</strong> {selectedSNP.geno2}
                    </div>
                  )}
                  {selectedSNP.geno3 && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Genotype 3:</strong> {selectedSNP.geno3}
                    </div>
                  )}
                </div>
              )}

              {/* Clinical Information */}
              {(selectedSNP.clin_sig ||
                selectedSNP.clin_disease ||
                selectedSNP.clin_dbn ||
                selectedSNP.clin_accession) && (
                <div className="mb-4 rounded bg-white p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">Clinical Information</h4>
                  {selectedSNP.clin_sig && (
                    <div className="mb-2">
                      <strong className="text-gray-700">Clinical Significance:</strong>
                      <span
                        className={`ml-2 rounded px-2 py-0.5 text-xs font-medium ${
                          selectedSNP.clin_sig.toLowerCase().includes("pathogenic")
                            ? "bg-red-100 text-red-800"
                            : selectedSNP.clin_sig.toLowerCase().includes("benign")
                              ? "bg-green-100 text-green-800"
                              : "bg-yellow-100 text-yellow-800"
                        }`}
                      >
                        {selectedSNP.clin_sig}
                      </span>
                    </div>
                  )}
                  {selectedSNP.clin_disease && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Disease:</strong> {selectedSNP.clin_disease}
                    </div>
                  )}
                  {selectedSNP.clin_dbn && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Condition:</strong> {selectedSNP.clin_dbn}
                    </div>
                  )}
                  {selectedSNP.clin_accession && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">ClinVar Accession:</strong> {selectedSNP.clin_accession}
                    </div>
                  )}
                  {selectedSNP.clin_ref && selectedSNP.clin_alt && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Alleles:</strong> {selectedSNP.clin_ref} →{" "}
                      {selectedSNP.clin_alt}
                    </div>
                  )}
                </div>
              )}

              {/* SNPedia Content */}
              {selectedSNP.content && (
                <div className="mb-4 rounded bg-white p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">SNPedia Information</h4>
                  <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-800">
                    {selectedSNP.content}
                  </div>
                </div>
              )}

              {/* Publication */}
              {(selectedSNP.pmid || selectedSNP.pmid_title) && (
                <div className="mb-4 rounded bg-white p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">Publication</h4>
                  {selectedSNP.pmid && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">PMID:</strong>{" "}
                      <a
                        href={`https://pubmed.ncbi.nlm.nih.gov/${selectedSNP.pmid}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {selectedSNP.pmid}
                      </a>
                    </div>
                  )}
                  {selectedSNP.pmid_title && <div className="text-sm text-gray-600">{selectedSNP.pmid_title}</div>}
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
