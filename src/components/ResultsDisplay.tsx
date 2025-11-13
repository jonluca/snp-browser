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
    return (
      <div
        className={`cursor-pointer border-b border-gray-200 p-3 transition-colors ${
          isSelected ? "bg-blue-50" : "bg-white hover:bg-gray-50"
        }`}
        onClick={() => setSelectedSNP(match)}
      >
        <div className="mb-1 text-sm font-bold text-gray-900">{match.rsid.toUpperCase()}</div>
        <div className="text-xs text-gray-600">
          Genotype: <strong>{match.genotype}</strong> | Chr: {match.chromosome} | Pos: {match.position}
        </div>
        <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-500">
          {match.snpData.content.substring(0, 100)}...
        </div>
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
            <>
              <h3 className="mt-0 text-2xl font-bold text-gray-900">{selectedSNP.rsid.toUpperCase()}</h3>
              <div className="mb-4 rounded bg-white p-3 shadow-sm">
                <div className="mb-2">
                  <strong className="text-gray-700">Your Genotype:</strong>{" "}
                  <span className="text-gray-900">{selectedSNP.genotype}</span>
                </div>
                <div className="mb-2">
                  <strong className="text-gray-700">Chromosome:</strong>{" "}
                  <span className="text-gray-900">{selectedSNP.chromosome}</span>
                </div>
                <div className="mb-2">
                  <strong className="text-gray-700">Position:</strong>{" "}
                  <span className="text-gray-900">{selectedSNP.position}</span>
                </div>
                <div>
                  <strong className="text-gray-700">Scraped:</strong>{" "}
                  <span className="text-gray-900">{new Date(selectedSNP.snpData.scraped_at).toLocaleDateString()}</span>
                </div>
              </div>

              <div className="mb-4">
                <h4 className="mb-2 text-lg font-semibold text-gray-800">SNPedia Information</h4>
                <div className="whitespace-pre-wrap rounded bg-white p-3 font-mono text-xs leading-relaxed text-gray-800 shadow-sm">
                  {selectedSNP.snpData.content}
                </div>
              </div>

              {selectedSNP.snpData.attribution && (
                <div className="italic text-xs text-gray-500">{selectedSNP.snpData.attribution}</div>
              )}
            </>
          ) : (
            <div className="mt-24 text-center text-gray-400">Select a SNP from the list to view details</div>
          )}
        </div>
      </div>
    </div>
  );
}
