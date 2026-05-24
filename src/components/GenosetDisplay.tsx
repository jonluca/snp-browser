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
      <button
        type="button"
        className={twMerge(
          "w-full cursor-pointer rounded-xl border border-transparent p-3 text-left transition-colors",
          isSelected ? "border-brand-100 bg-brand-50" : "bg-white hover:bg-slate-50",
        )}
        onClick={() => setSelectedGenoset(genoset)}
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{genoset.genoset.id.toUpperCase()}</span>
            {genoset.parsedData.magnitude !== undefined && (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">
                Mag: {genoset.parsedData.magnitude}
              </span>
            )}
          </div>
        </div>
        <div className="text-xs text-slate-600">
          {genoset.matchedGenotypes.length} matching genotype{genoset.matchedGenotypes.length !== 1 ? "s" : ""}
        </div>
        <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-slate-500">
          {genoset.genoset.content.substring(0, 100)}...
        </div>
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="surface-panel p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="section-label mb-2">Analysis results</p>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
              Found {genosets.length.toLocaleString()} matching genoset{genosets.length !== 1 ? "s" : ""}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Collections of genotypes that together indicate a trait, condition or characteristic.
            </p>
          </div>
          <button
            type="button"
            onClick={handleExportGenosets}
            disabled={filteredGenosets.length === 0}
            className="primary-button"
          >
            Export CSV
          </button>
        </div>
        <input
          type="text"
          aria-label="Search matching genosets"
          placeholder="Search by ID or content..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="field-control"
        />
        <div className="mt-4 flex items-center justify-end border-t border-slate-100 pt-4">
          <div className="text-xs font-medium text-slate-500">
            Showing {filteredGenosets.length.toLocaleString()} of {genosets.length.toLocaleString()} results
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 lg:min-h-[640px] lg:flex-row">
        {/* Left panel - List of genosets */}
        <div className="surface-panel h-[360px] flex-shrink-0 overflow-hidden p-2 lg:h-[640px] lg:w-[390px]">
          <Virtuoso style={{ height: "100%" }} totalCount={filteredGenosets.length} itemContent={itemContent} />
        </div>

        {/* Right panel - Selected genoset details */}
        <div className="surface-panel min-h-[320px] flex-1 overflow-y-auto p-5 sm:p-6 lg:h-[640px]">
          {selectedGenoset ? (
            <div>
              <p className="section-label mb-2">Genoset detail</p>
              <h3 className="mt-0 text-2xl font-semibold tracking-tight text-slate-950">
                <a
                  href={`https://www.snpedia.com/index.php/${selectedGenoset.genoset.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="transition-colors hover:text-brand-700"
                >
                  {selectedGenoset.genoset.id.toUpperCase()}
                </a>
              </h3>

              {/* Magnitude */}
              {selectedGenoset.parsedData.magnitude !== undefined && (
                <div className="mt-5 mb-4 rounded-2xl border border-violet-100 bg-violet-50 p-4">
                  <h4 className="mb-2 text-sm font-semibold text-slate-800">Magnitude</h4>
                  <div className="text-lg font-bold text-violet-900">{selectedGenoset.parsedData.magnitude}</div>
                </div>
              )}

              {/* Matching Genotypes */}
              <div className="mb-4 rounded-2xl border border-brand-100 bg-brand-50 p-4">
                <h4 className="mb-3 text-sm font-semibold text-slate-800">Your matching genotypes</h4>
                <div className="space-y-2">
                  {selectedGenoset.matchedGenotypes.map((match) => (
                    <div key={match.rsid} className="rounded-xl border border-brand-100/60 bg-white p-3 text-xs">
                      <div className="font-bold text-slate-900">
                        {match.rsid.toUpperCase()}: {match.genotype.toUpperCase()}
                      </div>
                      {match.genotypeData?.id && (
                        <div className="mt-1 text-slate-600">Genotype ID: {match.genotypeData.id}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Genoset Content */}
              {selectedGenoset.genoset.content && (
                <div className="subtle-panel mb-4 p-4">
                  <h4 className="mb-3 text-sm font-semibold text-slate-800">Genoset information</h4>
                  <WikiContent content={selectedGenoset.genoset.content} />
                </div>
              )}
            </div>
          ) : (
            <div className="flex min-h-[280px] items-center justify-center text-center text-sm font-medium text-slate-400">
              Select a genoset from the list to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
