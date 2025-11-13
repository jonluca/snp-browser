import { useState, useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import type { MatchedSNP } from "../types/snp";

interface ResultsDisplayProps {
  matches: MatchedSNP[];
}

export function ResultsDisplay({ matches }: ResultsDisplayProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedSNP, setSelectedSNP] = useState<MatchedSNP | null>(null);

  const filteredMatches = useMemo(() => {
    if (!searchTerm) return matches;

    const term = searchTerm.toLowerCase();
    return matches.filter(
      (match) =>
        match.rsid.toLowerCase().includes(term) ||
        match.genotype.toLowerCase().includes(term) ||
        match.snpData.content.toLowerCase().includes(term),
    );
  }, [matches, searchTerm]);

  const itemContent = (index: number) => {
    const match = filteredMatches[index];
    const isSelected = selectedSNP?.rsid === match.rsid;
    const snpData = match.snpData;

    return (
      <div
        className={`cursor-pointer border-b border-gray-200 p-3 transition-colors ${
          isSelected ? "bg-blue-50" : "bg-white hover:bg-gray-50"
        }`}
        onClick={() => setSelectedSNP(match)}
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-bold text-gray-900">{match.rsid.toUpperCase()}</span>
          {snpData.clin_sig && (
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                snpData.clin_sig.toLowerCase().includes("pathogenic")
                  ? "bg-red-100 text-red-800"
                  : snpData.clin_sig.toLowerCase().includes("benign")
                    ? "bg-green-100 text-green-800"
                    : "bg-yellow-100 text-yellow-800"
              }`}
            >
              {snpData.clin_sig}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-600">
          Your Genotype: <strong>{match.genotype}</strong> | Chr: {match.chromosome} | Pos: {match.position}
        </div>
        {(snpData.gene || snpData.gene_s || snpData.clin_gene_name) && (
          <div className="mt-1 text-xs text-gray-600">
            Gene: {snpData.gene || snpData.gene_s || snpData.clin_gene_name}
          </div>
        )}
        {snpData.clin_disease && <div className="mt-1 text-xs text-gray-500">Disease: {snpData.clin_disease}</div>}
        {snpData.content && (
          <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-500">
            {snpData.content.substring(0, 100)}...
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <h2 className="mb-2 text-xl font-semibold text-gray-900">
          Found {matches.length} matching SNP{matches.length !== 1 ? "s" : ""}
        </h2>
        <input
          type="text"
          placeholder="Search by rsid, genotype, or content..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full rounded border border-gray-300 p-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        {searchTerm && (
          <div className="mt-1 text-xs text-gray-600">
            Showing {filteredMatches.length} of {matches.length} results
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Left panel - List of matches */}
        <div className="w-[400px] flex-shrink-0 overflow-hidden rounded border border-gray-300">
          <Virtuoso style={{ height: "600px" }} totalCount={filteredMatches.length} itemContent={itemContent} />
        </div>

        {/* Right panel - Selected SNP details */}
        <div className="flex-1 overflow-y-auto rounded border border-gray-300 bg-gray-50 p-4">
          {selectedSNP ? (
            <div>
              <h3 className="mt-0 text-2xl font-bold text-gray-900">{selectedSNP.rsid.toUpperCase()}</h3>

              {/* Your Genotype */}
              <div className="mb-4 rounded bg-blue-50 p-3 shadow-sm">
                <h4 className="mb-2 text-sm font-semibold text-gray-800">Your Genotype</h4>
                <div className="mb-1 text-lg font-bold text-blue-900">{selectedSNP.genotype}</div>
                <div className="text-xs text-gray-600">
                  Chr {selectedSNP.chromosome} : {selectedSNP.position}
                </div>
              </div>

              {/* Basic Info */}
              <div className="mb-4 rounded bg-white p-3 shadow-sm">
                <h4 className="mb-2 text-sm font-semibold text-gray-800">Genomic Location</h4>
                {selectedSNP.snpData.chromosome && (
                  <div className="mb-1 text-sm">
                    <strong className="text-gray-700">Chromosome:</strong> {selectedSNP.snpData.chromosome}
                  </div>
                )}
                {selectedSNP.snpData.position && (
                  <div className="mb-1 text-sm">
                    <strong className="text-gray-700">Position:</strong> {selectedSNP.snpData.position.toLocaleString()}
                  </div>
                )}
                {(selectedSNP.snpData.gene || selectedSNP.snpData.gene_s || selectedSNP.snpData.clin_gene_name) && (
                  <div className="mb-1 text-sm">
                    <strong className="text-gray-700">Gene:</strong>{" "}
                    {selectedSNP.snpData.gene || selectedSNP.snpData.gene_s || selectedSNP.snpData.clin_gene_name}
                  </div>
                )}
                {selectedSNP.snpData.assembly && (
                  <div className="mb-1 text-sm">
                    <strong className="text-gray-700">Assembly:</strong> {selectedSNP.snpData.assembly}
                  </div>
                )}
              </div>

              {/* Genotypes */}
              {(selectedSNP.snpData.geno1 || selectedSNP.snpData.geno2 || selectedSNP.snpData.geno3) && (
                <div className="mb-4 rounded bg-white p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">Possible Genotypes</h4>
                  {selectedSNP.snpData.geno1 && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Genotype 1:</strong> {selectedSNP.snpData.geno1}
                    </div>
                  )}
                  {selectedSNP.snpData.geno2 && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Genotype 2:</strong> {selectedSNP.snpData.geno2}
                    </div>
                  )}
                  {selectedSNP.snpData.geno3 && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Genotype 3:</strong> {selectedSNP.snpData.geno3}
                    </div>
                  )}
                </div>
              )}

              {/* Clinical Information */}
              {(selectedSNP.snpData.clin_sig ||
                selectedSNP.snpData.clin_disease ||
                selectedSNP.snpData.clin_dbn ||
                selectedSNP.snpData.clin_accession) && (
                <div className="mb-4 rounded bg-white p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">Clinical Information</h4>
                  {selectedSNP.snpData.clin_sig && (
                    <div className="mb-2">
                      <strong className="text-gray-700">Clinical Significance:</strong>
                      <span
                        className={`ml-2 rounded px-2 py-0.5 text-xs font-medium ${
                          selectedSNP.snpData.clin_sig.toLowerCase().includes("pathogenic")
                            ? "bg-red-100 text-red-800"
                            : selectedSNP.snpData.clin_sig.toLowerCase().includes("benign")
                              ? "bg-green-100 text-green-800"
                              : "bg-yellow-100 text-yellow-800"
                        }`}
                      >
                        {selectedSNP.snpData.clin_sig}
                      </span>
                    </div>
                  )}
                  {selectedSNP.snpData.clin_disease && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Disease:</strong> {selectedSNP.snpData.clin_disease}
                    </div>
                  )}
                  {selectedSNP.snpData.clin_dbn && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Condition:</strong> {selectedSNP.snpData.clin_dbn}
                    </div>
                  )}
                  {selectedSNP.snpData.clin_accession && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">ClinVar Accession:</strong> {selectedSNP.snpData.clin_accession}
                    </div>
                  )}
                  {selectedSNP.snpData.clin_ref && selectedSNP.snpData.clin_alt && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">Alleles:</strong> {selectedSNP.snpData.clin_ref} →{" "}
                      {selectedSNP.snpData.clin_alt}
                    </div>
                  )}
                </div>
              )}

              {/* SNPedia Content */}
              {selectedSNP.snpData.content && (
                <div className="mb-4 rounded bg-white p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">SNPedia Information</h4>
                  <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-800">
                    {selectedSNP.snpData.content}
                  </div>
                </div>
              )}

              {/* Publication */}
              {(selectedSNP.snpData.pmid || selectedSNP.snpData.pmid_title) && (
                <div className="mb-4 rounded bg-white p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">Publication</h4>
                  {selectedSNP.snpData.pmid && (
                    <div className="mb-1 text-sm">
                      <strong className="text-gray-700">PMID:</strong>{" "}
                      <a
                        href={`https://pubmed.ncbi.nlm.nih.gov/${selectedSNP.snpData.pmid}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {selectedSNP.snpData.pmid}
                      </a>
                    </div>
                  )}
                  {selectedSNP.snpData.pmid_title && (
                    <div className="text-sm text-gray-600">{selectedSNP.snpData.pmid_title}</div>
                  )}
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
