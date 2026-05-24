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
      <button
        type="button"
        className={twMerge(
          "w-full cursor-pointer rounded-xl border border-transparent p-3 text-left transition-colors",
          isSelected ? "border-brand-100 bg-brand-50" : "bg-white hover:bg-slate-50",
        )}
        onClick={() => setSelectedSNP(match)}
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{match.rsid.toUpperCase()}</span>
            {match.parsedData.magnitude !== undefined && (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">
                Mag: {match.parsedData.magnitude}
              </span>
            )}
          </div>
        </div>
        <div className="text-xs text-slate-600">
          Your Genotype: <strong>{match.genotype.toUpperCase()}</strong> | Chr: {match.chromosome} | Pos:{" "}
          {match.position}
        </div>
        {match.genotypeData?.content && (
          <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-slate-500">
            {match.genotypeData.content.substring(0, 100)}...
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col gap-5">
      {/* View mode toggle */}
      {genosets.length > 0 && (
        <div className="inline-flex self-start gap-1 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm">
          <button
            type="button"
            onClick={() => setViewMode("snps")}
            className={twMerge(
              "cursor-pointer rounded-xl px-4 py-2 text-sm font-semibold transition-colors",
              viewMode === "snps" ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50",
            )}
          >
            SNPs ({matches.length.toLocaleString()})
          </button>
          <button
            type="button"
            onClick={() => setViewMode("genosets")}
            className={twMerge(
              "cursor-pointer rounded-xl px-4 py-2 text-sm font-semibold transition-colors",
              viewMode === "genosets" ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50",
            )}
          >
            Genosets ({genosets.length.toLocaleString()})
          </button>
        </div>
      )}

      {/* SNP View */}
      {viewMode === "snps" && (
        <div className="flex h-full flex-col gap-5">
          <div className="surface-panel p-5 sm:p-6">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="section-label mb-2">Analysis results</p>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Found {matches.length.toLocaleString()} matching SNP{matches.length !== 1 ? "s" : ""}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Prioritized by magnitude, with genotype matches shown first.
                </p>
              </div>
              <button
                type="button"
                onClick={handleExportSNPs}
                disabled={filteredMatches.length === 0}
                className="primary-button"
              >
                Export CSV
              </button>
            </div>
            <input
              type="text"
              aria-label="Search matching SNPs"
              placeholder="Search by rsid, genotype, or content..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="field-control"
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  aria-label="Only show SNPs with matching genotype data"
                  checked={onlyWithGenotype}
                  onChange={(e) => setOnlyWithGenotype(e.target.checked)}
                  className="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                <span>Only show SNPs with matching genotype data</span>
              </label>
              <div className="text-xs font-medium text-slate-500">
                Showing {filteredMatches.length.toLocaleString()} of {matches.length.toLocaleString()} results
              </div>
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-4 lg:min-h-[640px] lg:flex-row">
            {/* Left panel - List of matches */}
            <div className="surface-panel h-[360px] flex-shrink-0 overflow-hidden p-2 lg:h-[640px] lg:w-[390px]">
              <Virtuoso style={{ height: "100%" }} totalCount={filteredMatches.length} itemContent={itemContent} />
            </div>

            {/* Right panel - Selected SNP details */}
            <div className="surface-panel min-h-[320px] flex-1 overflow-y-auto p-5 sm:p-6 lg:h-[640px]">
              {selectedSNP ? (
                <div>
                  <p className="section-label mb-2">Variant detail</p>
                  <h3 className="mt-0 text-2xl font-semibold tracking-tight text-slate-950">
                    <a
                      href={`https://www.snpedia.com/index.php/${selectedSNP.rsid}`}
                      target="_blank"
                      rel="noreferrer"
                      className="transition-colors hover:text-brand-700"
                    >
                      {selectedSNP.rsid.toUpperCase()}
                    </a>
                  </h3>

                  {/* Your Genotype */}
                  <div className="mt-5 mb-4 rounded-2xl border border-brand-100 bg-brand-50 p-4">
                    <h4 className="mb-2 text-sm font-semibold text-slate-800">Your genotype</h4>
                    <div className="mb-1 flex items-center gap-2">
                      <div className="text-lg font-bold text-brand-700">{selectedSNP.genotype.toUpperCase()}</div>
                      {selectedSNP.parsedData.magnitude !== undefined && (
                        <span className="rounded-full bg-violet-100 px-2.5 py-1 text-sm font-medium text-violet-800">
                          Magnitude: {selectedSNP.parsedData.magnitude}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-600">
                      Chr {selectedSNP.chromosome} : {selectedSNP.position}
                    </div>
                  </div>

                  {/* Genotype-Specific Content */}
                  {selectedSNP.genotypeData?.content && (
                    <div className="subtle-panel mb-4 p-4">
                      <h4 className="mb-3 text-sm font-semibold text-slate-800">
                        Genotype-specific information ({selectedSNP.genotype})
                      </h4>
                      <WikiContent content={selectedSNP.genotypeData.content} />
                    </div>
                  )}

                  {/* SNPedia Content */}
                  {selectedSNP.snpData.content && (
                    <div className="subtle-panel mb-4 p-4">
                      <h4 className="mb-3 text-sm font-semibold text-slate-800">General SNP information</h4>
                      <WikiContent content={selectedSNP.snpData.content} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex min-h-[280px] items-center justify-center text-center text-sm font-medium text-slate-400">
                  Select a SNP from the list to view details
                </div>
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
