import { useState, useMemo } from "react";
import { twMerge } from "tailwind-merge";
import { Virtuoso } from "react-virtuoso";
import type { MatchedGenoset } from "../types/snp";
import { buildCsv, downloadCsvFile, type CsvColumn } from "../utils/csvExport";
import { WikiContent } from "./WikiContent";

interface GenosetDisplayProps {
  genosets: MatchedGenoset[];
}

const GENOSET_EXPORT_COLUMNS: CsvColumn<MatchedGenoset>[] = [
  { header: "Genoset ID", value: (genoset) => genoset.genoset.id },
  { header: "Magnitude", value: (genoset) => genoset.parsedData.magnitude },
  { header: "Repute", value: (genoset) => genoset.parsedData.repute },
  { header: "Summary", value: (genoset) => genoset.parsedData.summary },
  { header: "Matching Genotype Count", value: (genoset) => genoset.matchedGenotypes.length },
  {
    header: "Matching Genotypes",
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
  { header: "SNPedia URL", value: (genoset) => `https://www.snpedia.com/index.php/${genoset.genoset.id}` },
];

export function GenosetDisplay({ genosets }: GenosetDisplayProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedGenoset, setSelectedGenoset] = useState<MatchedGenoset | null>(null);

  const filteredGenosets = useMemo(() => {
    let filtered = [...genosets];

    // Apply search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (genoset) =>
          genoset.genoset.id.toLowerCase().includes(term) || genoset.genoset.content.toLowerCase().includes(term),
      );
    }

    // Sort by magnitude (descending) - higher magnitudes first
    return filtered.sort((a, b) => {
      const magA = a.parsedData.magnitude ?? -1;
      const magB = b.parsedData.magnitude ?? -1;
      return magB - magA;
    });
  }, [genosets, searchTerm]);

  const handleExportGenosets = () => {
    downloadCsvFile("snp-genosets.csv", buildCsv(filteredGenosets, GENOSET_EXPORT_COLUMNS));
  };

  const itemContent = (index: number) => {
    const genoset = filteredGenosets[index];
    const isSelected = selectedGenoset?.genoset.id === genoset.genoset.id;

    return (
      <div
        className={twMerge(
          "cursor-pointer border-b border-gray-200 p-3 transition-colors",
          isSelected ? "bg-blue-50" : "bg-white hover:bg-gray-50",
        )}
        onClick={() => setSelectedGenoset(genoset)}
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-gray-900">{genoset.genoset.id.toUpperCase()}</span>
            {genoset.parsedData.magnitude !== undefined && (
              <span className="rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                Mag: {genoset.parsedData.magnitude}
              </span>
            )}
          </div>
        </div>
        <div className="text-xs text-gray-600">
          {genoset.matchedGenotypes.length} matching genotype{genoset.matchedGenotypes.length !== 1 ? "s" : ""}
        </div>
        <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-500">
          {genoset.genoset.content.substring(0, 100)}...
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-gray-900">
            Found {genosets.length.toLocaleString()} matching genoset{genosets.length !== 1 ? "s" : ""}
          </h2>
          <button
            type="button"
            onClick={handleExportGenosets}
            disabled={filteredGenosets.length === 0}
            className={twMerge(
              "rounded bg-blue-500 px-3 py-2 text-sm font-medium text-white transition-colors",
              filteredGenosets.length === 0 ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-blue-600",
            )}
          >
            Export CSV
          </button>
        </div>
        <p className="mb-2 text-sm text-gray-600">
          Genosets are collections of genotypes that together indicate a trait, condition, or characteristic.
        </p>
        <input
          type="text"
          placeholder="Search by ID or content..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full rounded border border-gray-300 p-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <div className="mt-2 flex items-center justify-end">
          <div className="text-xs text-gray-600">
            Showing {filteredGenosets.length.toLocaleString()} of {genosets.length.toLocaleString()} results
          </div>
        </div>
      </div>

      <div className="flex flex-1 gap-4 max-h-[70vh] min-h-[70vh]">
        {/* Left panel - List of genosets */}
        <div className="w-[400px] flex-shrink-0 overflow-hidden rounded border border-gray-300">
          <Virtuoso style={{ height: "100%" }} totalCount={filteredGenosets.length} itemContent={itemContent} />
        </div>

        {/* Right panel - Selected genoset details */}
        <div className="flex-1 overflow-y-auto rounded border border-gray-300 bg-gray-50 p-4">
          {selectedGenoset ? (
            <div>
              <h3
                className="mt-0 text-2xl font-bold text-gray-900 cursor-pointer"
                onClick={() => {
                  window.open(`https://www.snpedia.com/index.php/${selectedGenoset.genoset.id}`, "_blank");
                }}
              >
                {selectedGenoset.genoset.id.toUpperCase()}
              </h3>

              {/* Magnitude */}
              {selectedGenoset.parsedData.magnitude !== undefined && (
                <div className="mb-4 rounded bg-purple-50 p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">Magnitude</h4>
                  <div className="text-lg font-bold text-purple-900">{selectedGenoset.parsedData.magnitude}</div>
                </div>
              )}

              {/* Matching Genotypes */}
              <div className="mb-4 rounded bg-blue-50 p-3 shadow-sm">
                <h4 className="mb-2 text-sm font-semibold text-gray-800">Your Matching Genotypes</h4>
                <div className="space-y-2">
                  {selectedGenoset.matchedGenotypes.map((match) => (
                    <div key={match.rsid} className="rounded bg-white p-2 text-xs">
                      <div className="font-bold text-gray-900">
                        {match.rsid.toUpperCase()}: {match.genotype.toUpperCase()}
                      </div>
                      {match.genotypeData?.id && (
                        <div className="mt-1 text-gray-600">Genotype ID: {match.genotypeData.id}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Genoset Content */}
              {selectedGenoset.genoset.content && (
                <div className="mb-4 rounded bg-white p-3 shadow-sm">
                  <h4 className="mb-2 text-sm font-semibold text-gray-800">Genoset Information</h4>
                  <WikiContent content={selectedGenoset.genoset.content} />
                </div>
              )}
            </div>
          ) : (
            <div className="mt-24 text-center text-gray-400">Select a genoset from the list to view details</div>
          )}
        </div>
      </div>
    </div>
  );
}
