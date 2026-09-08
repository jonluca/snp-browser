import { useEffect, useMemo, useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import { Virtuoso } from "react-virtuoso";
import type { MatchedSNP, MatchedGenoset } from "../types/snp";
import { buildCsv, downloadCsvFile, type CsvColumn } from "../utils/csvExport";
import { getVariantPresentation, plainWikiText } from "../utils/variantPresentation";
import { WikiContent } from "./WikiContent";
import { GenosetDisplay } from "./GenosetDisplay";
import { AnnotationDetails } from "./AnnotationDetails";
import { useQuery } from "@tanstack/react-query";
import type { Remote } from "comlink";
import type { SNPMatcherWorkerApi } from "../workers/snpMatcher.worker";
import { ANNOTATION_SOURCE_NAMES } from "../utils/annotationPresentation";
import { countMatchVariants, createMatchRows, userCallIdentity } from "../utils/matchIdentity";

type ViewMode = "snps" | "genosets";
type SortMode = "magnitude" | "rsid";

interface ResultsDisplayProps {
  matches: MatchedSNP[];
  genosets: MatchedGenoset[];
  workerApi: Remote<SNPMatcherWorkerApi>;
  referenceRevision: number;
}

const parsedValue = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const rsidCollator = new Intl.Collator(undefined, { numeric: true });

function presentMatch(match: MatchedSNP) {
  const fallback = getVariantPresentation(match.snpData);
  return {
    gene: plainWikiText(match.parsedData.geneSymbol ?? fallback.geneSymbol ?? ""),
    preview: plainWikiText(match.parsedData.summary ?? "") || fallback.preview,
    repute: plainWikiText(match.parsedData.repute ?? ""),
  };
}

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
  {
    header: "SNPedia URL",
    value: (match) =>
      match.snpData.referenceSource ? "" : `https://www.snpedia.com/index.php/${encodeURIComponent(match.rsid)}`,
  },
  { header: "Genome Build", value: (match) => match.assembly },
  {
    header: "Reference Sources",
    value: (match) => match.annotationSummary?.sources.map((source) => ANNOTATION_SOURCE_NAMES[source]).join("; "),
  },
  { header: "Reference Annotations", value: (match) => match.annotationSummary?.count },
  { header: "Confirmed Allele Matches", value: (match) => match.annotationSummary?.alleleCount },
  { header: "Unresolved Matches", value: (match) => match.annotationSummary?.unresolvedCount },
];

const hasAlleleAnnotation = (match: MatchedSNP) => Boolean(match.genotypeData || match.annotationSummary?.alleleCount);

export function ResultsDisplay({ matches, genosets, workerApi, referenceRevision }: ResultsDisplayProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("snps");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [onlyWithGenotype, setOnlyWithGenotype] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("magnitude");
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);
  const detailPaneRef = useRef<HTMLDivElement>(null);
  const matchRows = useMemo(() => createMatchRows(matches), [matches]);
  const variantCount = useMemo(() => countMatchVariants(matches), [matches]);
  const annotatedCount = useMemo(() => countMatchVariants(matches, hasAlleleAnnotation), [matches]);

  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return matchRows
      .filter(({ match }) => {
        if (onlyWithGenotype && !hasAlleleAnnotation(match)) return false;
        return (
          !term ||
          [
            match.rsid,
            match.genotype,
            match.parsedData.geneSymbol,
            match.parsedData.summary,
            match.snpData.content,
            match.genotypeData?.content,
            match.annotationSummary?.sources.join(" "),
          ].some((value) => value?.toLowerCase().includes(term))
        );
      })
      .sort(({ match: a }, { match: b }) => {
        const byId = rsidCollator.compare(a.rsid, b.rsid);
        return sortMode === "rsid" ? byId : (b.parsedData.magnitude ?? -1) - (a.parsedData.magnitude ?? -1) || byId;
      });
  }, [matchRows, searchTerm, onlyWithGenotype, sortMode]);

  const selectedSNP = filteredRows.find((row) => row.key === selectedId)?.match;
  const selectedPresentation = selectedSNP ? presentMatch(selectedSNP) : undefined;
  const annotationDetails = useQuery({
    queryKey: [
      "matched-annotations",
      selectedSNP ? userCallIdentity(selectedSNP) : null,
      referenceRevision,
      selectedSNP?.annotationSummary?.ambiguous,
    ],
    enabled: Boolean(selectedSNP?.annotationSummary?.count),
    queryFn: () => workerApi.getMatchedAnnotations(selectedSNP!, selectedSNP?.annotationSummary?.ambiguous),
    retry: false,
  });

  useEffect(() => {
    if (detailPaneRef.current) detailPaneRef.current.scrollTop = 0;
    if (selectedSNP) {
      detailRef.current?.focus({ preventScroll: true });
      if (window.matchMedia("(max-width: 1023px)").matches) {
        detailPaneRef.current?.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedSNP]);

  const clearFilters = () => {
    setSearchTerm("");
    setOnlyWithGenotype(false);
    setSelectedId(null);
    searchRef.current?.focus();
  };

  const itemContent = (index: number) => {
    const { match, key } = filteredRows[index];
    const presentation = presentMatch(match);
    const isSelected = selectedId === key;

    return (
      <button
        type="button"
        aria-pressed={isSelected}
        aria-label={`View ${match.rsid.toUpperCase()}, genotype ${match.genotype.toUpperCase()}${match.genotypeData ? `, SNPedia record ${match.genotypeData.id}` : ""}`}
        className="variant-row"
        onClick={() => setSelectedId(key)}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 font-mono text-sm font-semibold text-slate-900 [overflow-wrap:anywhere]">
              {match.rsid}
            </span>
            {presentation.gene && (
              <span className="truncate text-xs font-medium text-slate-500">{presentation.gene}</span>
            )}
          </div>
          <span className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-xs font-semibold text-slate-700">
            {match.genotype.toUpperCase()}
          </span>
        </div>
        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-slate-600">
          {presentation.preview || "Explore the available reference evidence for this variant."}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-slate-500">
          {match.parsedData.magnitude !== undefined && (
            <span title="SNPedia's editorial measure of interest; not a probability or risk score.">
              Magnitude <span className="text-slate-800">{match.parsedData.magnitude}</span>
            </span>
          )}
          <span>{hasAlleleAnnotation(match) ? "Allele or genotype annotation" : "General variant information"}</span>
          {match.annotationSummary && (
            <span>{match.annotationSummary.sources.map((source) => ANNOTATION_SOURCE_NAMES[source]).join(" · ")}</span>
          )}
          <span className="ml-auto text-brand-700" aria-hidden="true">
            →
          </span>
        </div>
      </button>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {genosets.length > 0 && (
        <div
          className="inline-flex max-w-full self-start gap-1 rounded-xl border border-slate-200 bg-white p-1"
          aria-label="Result type"
        >
          <button
            type="button"
            aria-pressed={viewMode === "snps"}
            onClick={() => setViewMode("snps")}
            className={twMerge(
              "cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
              viewMode === "snps" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50",
            )}
          >
            Variants <span className="ml-1 text-xs opacity-65">{variantCount.toLocaleString()}</span>
          </button>
          <button
            type="button"
            aria-pressed={viewMode === "genosets"}
            onClick={() => setViewMode("genosets")}
            className={twMerge(
              "cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
              viewMode === "genosets" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50",
            )}
          >
            Related genosets <span className="ml-1 text-xs opacity-65">{genosets.length.toLocaleString()}</span>
          </button>
        </div>
      )}

      {viewMode === "snps" || genosets.length === 0 ? (
        <>
          <div className={twMerge("surface-panel p-5 sm:p-6", selectedSNP && "hidden lg:block")}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="section-label mb-2">Your DNA, in context</p>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Your variant matches</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">
                  <span className="font-medium text-slate-700">{variantCount.toLocaleString()}</span>{" "}
                  {variantCount === 1 ? "variant" : "variants"} in your enabled references ·{" "}
                  {annotatedCount.toLocaleString()} with an allele or genotype annotation
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  downloadCsvFile(
                    "snp-matches.csv",
                    buildCsv(
                      filteredRows.map(({ match }) => match),
                      SNP_EXPORT_COLUMNS,
                    ),
                  )
                }
                disabled={filteredRows.length === 0}
                className="secondary-button"
              >
                Export CSV{" "}
                <span aria-hidden="true" className="ml-1">
                  ↓
                </span>
              </button>
            </div>
            <div className="mt-5">
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    aria-hidden="true"
                    className="pointer-events-none absolute top-3 left-3.5 size-5 text-slate-400"
                  >
                    <circle cx="10.5" cy="10.5" r="6.5" />
                    <path d="m16 16 4 4" />
                  </svg>
                  <input
                    ref={searchRef}
                    type="search"
                    aria-label="Search matching SNPs"
                    placeholder="Search a variant, gene, or keyword"
                    value={searchTerm}
                    onChange={(event) => {
                      setSearchTerm(event.target.value);
                      setSelectedId(null);
                    }}
                    className="field-control pl-11"
                  />
                </div>
                <select
                  aria-label="Sort matching variants"
                  value={sortMode}
                  onChange={(event) => setSortMode(event.target.value as SortMode)}
                  className="field-control sm:w-52"
                >
                  <option value="magnitude">Magnitude: high to low</option>
                  <option value="rsid">Variant ID</option>
                </select>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600">
                  <input
                    type="checkbox"
                    checked={onlyWithGenotype}
                    onChange={(event) => {
                      setOnlyWithGenotype(event.target.checked);
                      setSelectedId(null);
                    }}
                    className="size-4 rounded border-slate-300 accent-brand-600"
                  />
                  With allele or genotype annotations
                </label>
                <span aria-live="polite" className="text-xs tabular-nums text-slate-500">
                  {filteredRows.length.toLocaleString()} {filteredRows.length === 1 ? "record" : "records"}
                </span>
              </div>
            </div>
          </div>

          <div className="workspace-split">
            <div className={twMerge("workspace-list flex flex-col overflow-hidden", selectedSNP && "hidden lg:flex")}>
              {filteredRows.length > 0 ? (
                <Virtuoso
                  style={{ height: "100%" }}
                  totalCount={filteredRows.length}
                  computeItemKey={(index) => filteredRows[index].key}
                  itemContent={itemContent}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-5 text-center">
                  <span
                    aria-hidden="true"
                    className="mb-4 grid size-12 place-items-center rounded-2xl bg-slate-50 text-xl text-slate-400"
                  >
                    ⌕
                  </span>
                  <h3 className="font-semibold text-slate-800">
                    {matches.length ? "No variants in this view" : "No variant matches found"}
                  </h3>
                  <p className="mt-2 max-w-64 text-sm leading-relaxed text-slate-500">
                    {matches.length
                      ? "Try a different keyword or include variants without genotype annotations."
                      : "No variants in this file match the currently enabled reference datasets."}
                  </p>
                  {matches.length > 0 && (
                    <button type="button" onClick={clearFilters} className="secondary-button mt-5">
                      Clear filters
                    </button>
                  )}
                </div>
              )}
            </div>

            <div
              ref={detailPaneRef}
              className={twMerge("workspace-detail p-5 sm:p-7", !selectedSNP && "hidden lg:block")}
            >
              {selectedSNP && selectedPresentation ? (
                <article>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(null);
                      requestAnimationFrame(() => searchRef.current?.focus());
                    }}
                    className="detail-back"
                  >
                    ← Back to results
                  </button>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 max-w-full">
                      <p className="section-label mb-2">Variant detail</p>
                      <h3
                        ref={detailRef}
                        tabIndex={-1}
                        className="font-mono text-2xl font-semibold tracking-tight text-slate-950 outline-none [overflow-wrap:anywhere]"
                      >
                        {selectedSNP.rsid}
                      </h3>
                    </div>
                    {!selectedSNP.snpData.referenceSource && (
                      <a
                        href={`https://www.snpedia.com/index.php/${encodeURIComponent(selectedSNP.rsid)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 text-xs font-medium text-brand-700 hover:underline"
                      >
                        Open SNPedia <span aria-hidden="true">↗</span>
                      </a>
                    )}
                  </div>
                  <p className="mt-5 text-lg leading-relaxed text-slate-800">
                    {selectedPresentation.preview ||
                      "No summary is available for this variant. Explore the research notes below."}
                  </p>
                  <dl
                    className={twMerge(
                      "my-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200",
                      !selectedSNP.snpData.referenceSource && "sm:grid-cols-4",
                    )}
                  >
                    <div className="bg-brand-50 p-3.5">
                      <dt className="text-[11px] font-medium text-brand-700">Your genotype</dt>
                      <dd className="mt-1 font-mono text-lg font-semibold text-brand-700">
                        {selectedSNP.genotype.toUpperCase()}
                      </dd>
                    </div>
                    <div className="bg-white p-3.5">
                      <dt className="text-[11px] font-medium text-slate-500">Gene</dt>
                      <dd className="mt-1 break-words text-sm font-semibold text-slate-800">
                        {selectedPresentation.gene || "Not listed"}
                      </dd>
                    </div>
                    {!selectedSNP.snpData.referenceSource && (
                      <>
                        <div
                          className="bg-white p-3.5"
                          title="SNPedia's editorial measure of interest; not a probability or risk score."
                        >
                          <dt className="text-[11px] font-medium text-slate-500">Magnitude</dt>
                          <dd className="mt-1 text-sm font-semibold text-slate-800">
                            {selectedSNP.parsedData.magnitude ?? "Not rated"}
                          </dd>
                        </div>
                        <div className="bg-white p-3.5">
                          <dt className="text-[11px] font-medium text-slate-500">SNPedia repute</dt>
                          <dd className="mt-1 break-words text-sm font-semibold capitalize text-slate-800">
                            {selectedPresentation.repute || "Not listed"}
                          </dd>
                        </div>
                      </>
                    )}
                  </dl>
                  <p className="mb-6 text-xs text-slate-500">
                    Chromosome {selectedSNP.chromosome} <span aria-hidden="true">·</span> Position{" "}
                    {selectedSNP.position} · {selectedSNP.assembly || "Genome build not declared"}
                  </p>
                  {selectedSNP.genotypeData?.content ? (
                    <section className="border-t border-slate-200 pt-5">
                      <h4 className="mb-4 text-sm font-semibold text-slate-900">About your genotype</h4>
                      <p className="mb-4 text-xs text-slate-500">SNPedia record: {selectedSNP.genotypeData.id}</p>
                      <WikiContent content={selectedSNP.genotypeData.content} hideSummary />
                    </section>
                  ) : !selectedSNP.snpData.referenceSource ? (
                    <p className="rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-600">
                      This variant is in SNPedia, but no annotation matches your genotype. The notes below describe the
                      variant in general.
                    </p>
                  ) : null}
                  <AnnotationDetails
                    annotations={annotationDetails.data ?? []}
                    loading={annotationDetails.isFetching}
                    error={annotationDetails.error?.message}
                  />
                  {selectedSNP.snpData.content && (
                    <details className="mt-6 border-t border-slate-200 pt-5" open={!selectedSNP.genotypeData}>
                      <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                        General variant research
                      </summary>
                      <div className="mt-4">
                        <WikiContent content={selectedSNP.snpData.content} hideSummary={!selectedSNP.genotypeData} />
                      </div>
                    </details>
                  )}
                </article>
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                  <div
                    aria-hidden="true"
                    className="mb-5 grid size-14 place-items-center rounded-2xl border border-brand-100 bg-brand-50 text-2xl text-brand-600"
                  >
                    ↗
                  </div>
                  <h3 className="text-xl font-semibold tracking-tight text-slate-800">
                    A closer look at your variants
                  </h3>
                  <p className="mt-3 max-w-xs text-sm leading-relaxed text-slate-500">
                    Select a result to explore your genotype, a readable summary, and the underlying research.
                  </p>
                  <p className="mt-6 max-w-xs text-xs leading-relaxed text-slate-400">
                    Magnitude reflects SNPedia’s level of interest in a finding. It is not a probability or a personal
                    risk score.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <GenosetDisplay genosets={genosets} />
      )}
    </div>
  );
}
