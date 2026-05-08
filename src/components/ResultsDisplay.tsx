import { useState, useMemo } from "react";
import { twMerge } from "tailwind-merge";
import { Virtuoso } from "react-virtuoso";
import type { MatchedSNP, MatchedGenoset } from "../types/snp";
import { buildCsv, downloadCsvFile, type CsvColumn } from "../utils/csvExport";
import { WikiContent } from "./WikiContent";
import { GenosetDisplay } from "./GenosetDisplay";

type ViewMode = "snps" | "genosets";

interface ResultsDisplayProps {
  matches: MatchedSNP[];
  genosets: MatchedGenoset[];
}

const parsedValue = (value: unknown) => (value === null || value === undefined ? "" : String(value));

const SNP_EXPORT_COLUMNS: CsvColumn<MatchedSNP>[] = [
  { header: "RSID", value: (match) => match.rsid },
  { header: "Gene Symbol", value: (match) => match.parsedData.geneSymbol },
  { header: "User Genotype", value: (match) => match.genotype },
  { header: "Chromosome", value: (match) => match.chromosome },
  { header: "Position", value: (match) => match.position },
  { header: "SNPedia Genotype", value: (match) => match.genotypeData?.genotype },
  { header: "Genotype ID", value: (match) => match.genotypeData?.id },
  { header: "Magnitude", value: (match) => match.parsedData.magnitude },
  { header: "Repute", value: (match) => parsedValue(match.parsedData.repute) },
  { header: "Summary", value: (match) => parsedValue(match.parsedData.summary) },
  { header: "Orientation", value: (match) => parsedValue(match.parsedData.orientation) },
  { header: "Stabilized Orientation", value: (match) => parsedValue(match.parsedData.stabilizedOrientation) },
  { header: "SNPedia URL", value: (match) => `https://www.snpedia.com/index.php/${match.rsid}` },
];

export function ResultsDisplay({ matches, genosets }: ResultsDisplayProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("snps");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedSNP, setSelectedSNP] = useState<MatchedSNP | null>(null);
  const [onlyWithGenotype, setOnlyWithGenotype] = useState(true); // Filter by default

  const filteredMatches = useMemo(() => {
    let filtered = [...matches];

    // Filter by genotype match (only show SNPs with matching genotype data)
    if (onlyWithGenotype) {
      filtered = filtered.filter((match) => match.genotypeData !== undefined);
    }

    // Apply search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (match) =>
          match.rsid.toLowerCase().includes(term) ||
          match.genotype.toLowerCase().includes(term) ||
          match.snpData.content.toLowerCase().includes(term) ||
          match.genotypeData?.content.toLowerCase().includes(term),
      );
    }

    // Sort by magnitude (descending) - higher magnitudes first
    // Put items without magnitude at the end
    return filtered.sort((a, b) => {
      const magA = a.parsedData.magnitude ?? -1;
      const magB = b.parsedData.magnitude ?? -1;
      return magB - magA;
    });
  }, [matches, searchTerm, onlyWithGenotype]);

  const handleExportSNPs = () => {
    downloadCsvFile("snp-matches.csv", buildCsv(filteredMatches, SNP_EXPORT_COLUMNS));
  };

  const itemContent = (index: number) => {
    const match = filteredMatches[index];
    const isSelected = selectedSNP?.rsid === match.rsid;

    return (
      <div
        className={twMerge(
          "cursor-pointer border-b border-gray-200 p-3 transition-colors",
          isSelected ? "bg-blue-50" : "bg-white hover:bg-gray-50",
        )}
        onClick={() => setSelectedSNP(match)}
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-gray-900">{match.rsid.toUpperCase()}</span>
            {match.parsedData.magnitude !== undefined && (
              <span className="rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                Mag: {match.parsedData.magnitude}
              </span>
            )}
          </div>
        </div>
        <div className="text-xs text-gray-600">
          Your Genotype: <strong>{match.genotype.toUpperCase()}</strong> | Chr: {match.chromosome} | Pos:{" "}
          {match.position}
        </div>
        {match.genotypeData?.content && (
          <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-500">
            {match.genotypeData.content.substring(0, 100)}...
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col gap-2">
      {/* View mode toggle */}
      {genosets.length > 0 && (
        <div className="inline-flex rounded-lg border gap-1 border-gray-300 bg-white p-1 shadow-sm">
          <button
            onClick={() => setViewMode("snps")}
            className={twMerge(
              "rounded-md px-4 py-2 text-sm font-medium cursor-pointer transition-colors",
              viewMode === "snps" ? "bg-blue-500 text-white" : "text-gray-700 hover:bg-gray-100",
            )}
          >
            SNPs ({matches.length.toLocaleString()})
          </button>
          <button
            onClick={() => setViewMode("genosets")}
            className={twMerge(
              "rounded-md px-4 py-2 text-sm font-medium transition-colors cursor-pointer",
              viewMode === "genosets" ? "bg-blue-500 text-white" : "text-gray-700 hover:bg-gray-100",
            )}
          >
            Genosets ({genosets.length.toLocaleString()})
          </button>
        </div>
      )}

      {/* SNP View */}
      {viewMode === "snps" && (
        <div className="flex h-full flex-col gap-4">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-gray-900">
                Found {matches.length.toLocaleString()} matching SNP{matches.length !== 1 ? "s" : ""}
              </h2>
              <button
                type="button"
                onClick={handleExportSNPs}
                disabled={filteredMatches.length === 0}
                className={twMerge(
                  "rounded bg-blue-500 px-3 py-2 text-sm font-medium text-white transition-colors",
                  filteredMatches.length === 0 ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-blue-600",
                )}
              >
                Export CSV
              </button>
            </div>
            <input
              type="text"
              placeholder="Search by rsid, genotype, or content..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded border border-gray-300 p-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="mt-2 flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={onlyWithGenotype}
                  onChange={(e) => setOnlyWithGenotype(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span>Only show SNPs with matching genotype data</span>
              </label>
              <div className="text-xs text-gray-600">
                Showing {filteredMatches.length.toLocaleString()} of {matches.length.toLocaleString()} results
              </div>
            </div>
          </div>

          <div className="flex flex-1 gap-4 max-h-[70vh] min-h-[70vh]">
            {/* Left panel - List of matches */}
            <div className="w-[400px] flex-shrink-0 overflow-hidden rounded border border-gray-300">
              <Virtuoso style={{ height: "100%" }} totalCount={filteredMatches.length} itemContent={itemContent} />
            </div>

            {/* Right panel - Selected SNP details */}
            <div className="flex-1 overflow-y-auto rounded border border-gray-300 bg-gray-50 p-4">
              {selectedSNP ? (
                <div>
                  <h3
                    className="mt-0 text-2xl font-bold text-gray-900 cursor-pointer"
                    onClick={() => {
                      window.open(`https://www.snpedia.com/index.php/${selectedSNP.rsid}`, "_blank");
                    }}
                  >
                    {selectedSNP.rsid.toUpperCase()}
                  </h3>

                  {/* Your Genotype */}
                  <div className="mb-4 rounded bg-blue-50 p-3 shadow-sm">
                    <h4 className="mb-2 text-sm font-semibold text-gray-800">Your Genotype</h4>
                    <div className="mb-1 flex items-center gap-2">
                      <div className="text-lg font-bold text-blue-900">{selectedSNP.genotype.toUpperCase()}</div>
                      {selectedSNP.parsedData.magnitude !== undefined && (
                        <span className="rounded bg-purple-100 px-2 py-1 text-sm font-medium text-purple-800">
                          Magnitude: {selectedSNP.parsedData.magnitude}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-600">
                      Chr {selectedSNP.chromosome} : {selectedSNP.position}
                    </div>
                  </div>

                  {/* Genotype-Specific Content */}
                  {selectedSNP.genotypeData?.content && (
                    <div className="mb-4 rounded bg-white p-3 shadow-sm">
                      <h4 className="mb-2 text-sm font-semibold text-gray-800">
                        Genotype-Specific Information ({selectedSNP.genotype})
                      </h4>
                      <WikiContent content={selectedSNP.genotypeData.content} />
                    </div>
                  )}

                  {/* SNPedia Content */}
                  {selectedSNP.snpData.content && (
                    <div className="mb-4 rounded bg-white p-3 shadow-sm">
                      <h4 className="mb-2 text-sm font-semibold text-gray-800">General SNP Information</h4>
                      <WikiContent content={selectedSNP.snpData.content} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-24 text-center text-gray-400">Select a SNP from the list to view details</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Genoset View */}
      {viewMode === "genosets" && <GenosetDisplay genosets={genosets} />}
    </div>
  );
}
