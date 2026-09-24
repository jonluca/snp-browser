import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { twMerge } from "tailwind-merge";
import { useSNPMatcherWorker, proxy } from "./hooks/useSNPMatcherWorker";
import { FileUpload } from "./components/FileUpload";
import { ResultsDisplay } from "./components/ResultsDisplay";
import { ImportedReportView } from "./components/ImportedReportView";
import { ImportedCallsView } from "./components/ImportedCallsView";
import { SNPBrowser } from "./components/SNPBrowser";
import { ReferenceLibrary } from "./components/ReferenceLibrary";
import { DNASuggestions } from "./components/DNASuggestions";
import { LocalWorkspaceStatus } from "./components/LocalWorkspaceStatus";
import { useReferenceLibrary } from "./hooks/useReferenceLibrary";
import type { ParseResult, MatchedSNP, MatchedGenoset } from "./types/snp";
import { DB_URL } from "./constants.ts";
import { useAnalysisProgress } from "./hooks/useAnalysisProgress";
import { ProcessingProgress } from "./components/ProcessingProgress";
import type { ImportProgress } from "./types/progress";

type AppMode = "upload" | "browse" | "references";

function App() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<AppMode>("upload");
  const [isDbLoading, setIsDbLoading] = useState(true);
  const [dbLoadProgress, setDbLoadProgress] = useState(0);
  const [dbError, setDbError] = useState<Error | null>(null);
  const [dbStats, setDbStats] = useState<{ totalSNPs: number } | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const processingRef = useRef(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [detectedFormat, setDetectedFormat] = useState<string | null>(null);
  const [resultView, setResultView] = useState<"suggestions" | "matches" | "calls" | "report">("suggestions");
  const [isParsing, setIsParsing] = useState(false);
  const [matches, setMatches] = useState<MatchedSNP[] | null>(null);
  const [genosets, setGenosets] = useState<MatchedGenoset[] | null>(null);
  const [isMatching, setIsMatching] = useState(false);
  const [isMatchingGenosets, setIsMatchingGenosets] = useState(false);
  const [matchError, setMatchError] = useState<Error | null>(null);
  const [analyzedReferenceRevision, setAnalyzedReferenceRevision] = useState(0);

  const {
    snapshot: analysisProgress,
    start: startProgress,
    update: updateProgress,
    finish: finishProgress,
  } = useAnalysisProgress();
  // Background database updates only belong to an analysis while it is waiting for the reference.
  const progressPhaseRef = useRef<"database" | "parse" | "snps" | "genosets" | null>(null);
  const dbLoadProgressRef = useRef(0);
  const dbLoadPromiseRef = useRef<Promise<void> | null>(null);

  // Use separate workers so uploads can be parsed while the database worker is loading SQLite.
  const { api: workerApi, isReady: isWorkerReady, error: workerError } = useSNPMatcherWorker();
  const { api: parserWorkerApi, isReady: isParserWorkerReady, error: parserWorkerError } = useSNPMatcherWorker();
  const references = useReferenceLibrary(workerApi, mode === "references");

  // Load database when worker is ready
  useEffect(() => {
    if (!isWorkerReady || !workerApi) return;
    let isCurrent = true;

    async function loadDB() {
      if (!workerApi) return;

      try {
        setIsDbLoading(true);
        setDbError(null);

        // Load database in worker thread
        await workerApi.loadDatabase(
          DB_URL,
          proxy((progress: number) => {
            if (!isCurrent) return;
            const roundedProgress = Math.round(progress);
            if (dbLoadProgressRef.current !== roundedProgress) {
              dbLoadProgressRef.current = roundedProgress;
              setDbLoadProgress(roundedProgress);
            }
            if (progressPhaseRef.current !== "database") return;
            updateProgress({ stage: "database", current: roundedProgress, total: 100, unit: "percent" });
          }),
        );

        // Get database stats
        const stats = await workerApi.getDatabaseStats();
        if (!isCurrent) return;
        setDbStats(stats);

        setDbLoadProgress(100);
        setIsDbLoading(false);
      } catch (err) {
        console.error("Error loading database:", err);
        const databaseError = err instanceof Error ? err : new Error("Failed to load database");
        if (isCurrent) {
          setDbError(databaseError);
          setIsDbLoading(false);
        }
        throw databaseError;
      }
    }

    const loadPromise = loadDB();
    dbLoadPromiseRef.current = loadPromise;
    void loadPromise.catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, [isWorkerReady, workerApi, updateProgress]);

  const handleFileSelect = useCallback(
    async (file: File) => {
      if (!workerApi || !parserWorkerApi || processingRef.current) return;
      processingRef.current = true;
      setFileName(file.name);
      setParseResult(null);
      setMatches(null);
      setGenosets(null);
      queryClient.removeQueries({ queryKey: ["matched-annotations"] });

      try {
        // Parse file in worker thread with progress reporting
        progressPhaseRef.current = "parse";
        setIsParsing(true);
        startProgress({ stage: "reading" });
        setMatchError(null);

        const result = await parserWorkerApi.parseFileBlob(
          file,
          undefined,
          undefined,
          proxy((progress: ImportProgress) => {
            if (progressPhaseRef.current === "parse") updateProgress(progress);
          }),
        );

        setParseResult(result);
        setDetectedFormat(result.detectedFormat || null);
        setIsParsing(false);

        if (result.report && result.genotypes.length === 0) {
          setResultView("report");
          setMatches([]);
          setGenosets([]);
          progressPhaseRef.current = null;
          processingRef.current = false;
          finishProgress();
          return;
        }
        setResultView("suggestions");
        if (result.genotypes.length === 0) {
          setMatchError(
            new Error(
              result.errors[0] ||
                result.warnings?.join(" ") ||
                (result.detectedFormat === "vcf"
                  ? "No supported genotype calls were found in this VCF/gVCF. Calls need an rsID, or an explicit GRCh37/GRCh38 build and valid coordinates. Reference blocks and symbolic alleles do not specify a concrete called sequence."
                  : "No valid genotype data found in file"),
            ),
          );
          progressPhaseRef.current = null;
          processingRef.current = false;
          finishProgress();
          return;
        }

        // Match SNPs using worker
        setIsMatching(true);

        progressPhaseRef.current = "database";
        updateProgress({ stage: "database", current: dbLoadProgressRef.current, total: 100, unit: "percent" });
        if (dbLoadPromiseRef.current) {
          // Trait analysis and independently cached references remain usable when SNPedia is unavailable.
          await dbLoadPromiseRef.current.catch(() => undefined);
        }

        progressPhaseRef.current = "snps";
        updateProgress({ stage: "matches" });
        const matchedSNPs = await workerApi.matchSNPs(
          result.genotypes,
          proxy((current: number, total: number) => {
            if (progressPhaseRef.current !== "snps") return;
            updateProgress({
              stage: "matches",
              current: total > 0 ? (current / total) * 100 : undefined,
              total: total > 0 ? 100 : undefined,
              unit: "percent",
            });
          }),
        );

        setMatches(matchedSNPs);
        setIsMatching(false);

        // Match genosets
        setIsMatchingGenosets(true);

        progressPhaseRef.current = "genosets";
        updateProgress({ stage: "genosets" });
        const matchedGenosets = await workerApi.matchGenosets(
          matchedSNPs,
          proxy((current: number, total: number) => {
            if (progressPhaseRef.current !== "genosets") return;
            updateProgress({ stage: "genosets", current, total, unit: "genosets" });
          }),
        );

        progressPhaseRef.current = null;
        setGenosets(matchedGenosets);
        setIsMatchingGenosets(false);
        setAnalyzedReferenceRevision(references.revision);
      } catch (err) {
        progressPhaseRef.current = null;
        console.error("Error processing file:", err);
        setMatchError(err instanceof Error ? err : new Error("Unknown error"));
        setIsParsing(false);
        setIsMatching(false);
        setIsMatchingGenosets(false);
      }
      finishProgress();
      progressPhaseRef.current = null;
      processingRef.current = false;
    },
    [parserWorkerApi, workerApi, references.revision, queryClient, startProgress, updateProgress, finishProgress],
  );

  const refreshAnalysis = async () => {
    if (!workerApi || !parseResult || processingRef.current || references.busy) return;
    processingRef.current = true;
    setIsMatching(true);
    setMatchError(null);
    progressPhaseRef.current = "snps";
    startProgress({ stage: "matches" });
    try {
      const updated = await workerApi.matchSNPs(
        parseResult.genotypes,
        proxy((current: number, total: number) => {
          if (progressPhaseRef.current !== "snps") return;
          updateProgress({
            stage: "matches",
            current: total > 0 ? (current / total) * 100 : undefined,
            total: total > 0 ? 100 : undefined,
            unit: "percent",
          });
        }),
      );
      setMatches(updated);
      setIsMatching(false);
      setIsMatchingGenosets(true);
      progressPhaseRef.current = "genosets";
      updateProgress({ stage: "genosets" });
      const related = await workerApi.matchGenosets(
        updated,
        proxy((current: number, total: number) => {
          if (progressPhaseRef.current === "genosets")
            updateProgress({ stage: "genosets", current, total, unit: "genosets" });
        }),
      );
      setGenosets(related);
      setAnalyzedReferenceRevision(references.revision);
    } catch (error) {
      setMatchError(error instanceof Error ? error : new Error("Could not update this analysis."));
    }
    progressPhaseRef.current = null;
    setIsMatching(false);
    setIsMatchingGenosets(false);
    processingRef.current = false;
    finishProgress();
  };

  const handleReset = useCallback(() => {
    finishProgress();
    queryClient.removeQueries({ queryKey: ["matched-annotations"] });
    setFileName(null);
    setParseResult(null);
    setDetectedFormat(null);
    setResultView("suggestions");
    setMatches(null);
    setGenosets(null);
    setMatchError(null);
    setMode("upload");
  }, [queryClient, finishProgress]);

  // Determine app state
  const hasResults = Boolean(parseResult && (parseResult.genotypes.length || parseResult.report));
  const uploadError = mode === "upload" ? matchError : null;
  const error = workerError || parserWorkerError || uploadError || dbError;
  const isFileError = Boolean(uploadError && error === uploadError && error !== dbError);
  const hasError = Boolean(error);
  const isDatabaseReady = Boolean(dbStats) && !isDbLoading && !dbError;
  const isProcessing = isParsing || isMatching || isMatchingGenosets;
  const canUpload =
    Boolean(parserWorkerApi) &&
    Boolean(workerApi) &&
    isParserWorkerReady &&
    isWorkerReady &&
    !isProcessing &&
    !references.busy &&
    !workerError &&
    !parserWorkerError;
  const isLandingView = mode === "upload" && !hasResults && !isProcessing;
  const databaseStatus = isDatabaseReady
    ? `${dbStats?.totalSNPs.toLocaleString()} SNPs ready`
    : isDbLoading && !dbError
      ? `Preparing database - ${dbLoadProgress}%`
      : "Database unavailable";

  return (
    <div className="min-h-screen">
      <a href="#main-content" className="skip-link">
        Skip to workspace
      </a>
      <header className="border-b border-slate-200/80 bg-white/80">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-x-6 gap-y-4 px-4 py-4 sm:px-6 lg:px-9">
          <button
            type="button"
            onClick={() => setMode("upload")}
            disabled={isProcessing}
            className="flex shrink-0 cursor-pointer items-center gap-3 rounded-md text-slate-950 disabled:cursor-wait"
            aria-label="SNP Browser home"
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-brand-700 text-white">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 fill-none stroke-current" strokeWidth="1.6">
                <path d="M7 3c10 4 0 14 10 18M17 3C7 7 17 17 7 21M8.5 7h7M7.5 12h9M8.5 17h7" strokeLinecap="round" />
              </svg>
            </span>
            <span className="text-lg font-semibold tracking-tight">SNP Browser</span>
          </button>
          <nav
            aria-label="Workspace view"
            className="order-3 flex w-full gap-1 rounded-lg bg-slate-100/80 p-1 sm:order-2 sm:w-auto"
          >
            {(["upload", "browse", "references"] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => setMode(view)}
                disabled={isProcessing}
                aria-current={mode === view ? "page" : undefined}
                className={twMerge(
                  "flex-1 cursor-pointer rounded-md px-2.5 py-2 text-xs font-medium whitespace-nowrap transition-colors disabled:cursor-wait disabled:opacity-50 sm:flex-none sm:px-4 sm:text-sm",
                  mode === view
                    ? "bg-white text-brand-700 shadow-sm ring-1 ring-slate-200/60"
                    : "text-slate-500 hover:text-slate-900",
                )}
              >
                {view === "upload"
                  ? hasResults
                    ? "Your analysis"
                    : "Analyze file"
                  : view === "browse"
                    ? "Browse reference"
                    : "Data sources"}
              </button>
            ))}
          </nav>
          <div className="order-2 flex items-center gap-2 text-xs text-slate-500 sm:order-3" role="status">
            <span
              className={twMerge(
                "size-1.5 shrink-0 rounded-full",
                isDatabaseReady ? "bg-brand-500" : dbError ? "bg-red-500" : "animate-pulse bg-amber-500",
              )}
            />
            {databaseStatus}
          </div>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-[1440px] px-4 pb-8 pt-6 sm:px-6 lg:px-9">
        <LocalWorkspaceStatus referenceRevision={references.revision} />
        {hasError && (
          <div
            role="alert"
            className="mb-6 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <h2 className="text-sm font-semibold text-red-950">
                {isFileError ? "We couldn't read this file" : "The workspace could not finish loading"}
              </h2>
              <p className="mt-1 text-sm leading-6 text-red-800">{error?.message || "An unknown error occurred"}</p>
              {isFileError && (
                <p className="mt-1 text-sm text-red-700">Try another supported DNA export or report below.</p>
              )}
            </div>
            {!isFileError && (
              <button type="button" className="secondary-button shrink-0" onClick={() => window.location.reload()}>
                Reload workspace
              </button>
            )}
          </div>
        )}

        {mode === "browse" &&
          !isProcessing &&
          (workerApi && (isDatabaseReady || references.packs.some((pack) => pack.status === "ready")) ? (
            <SNPBrowser
              workerApi={workerApi}
              snpediaReady={isDatabaseReady}
              referencePacks={references.packs}
              referenceRevision={references.revision}
              onManageReferences={() => setMode("references")}
            />
          ) : !hasError ? (
            <section className="surface-panel px-6 py-20 text-center" aria-busy="true">
              <p className="section-label mb-3">Reference database</p>
              <h1 className="mb-3 text-2xl font-semibold tracking-tight text-slate-900">Preparing SNPedia data</h1>
              <p className="mb-7 text-sm text-slate-500">
                The reference downloads once for this session. You can start a file analysis while it loads.
              </p>
              <div className="mx-auto mb-4 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-500 transition-[width] duration-300"
                  style={{ width: `${dbLoadProgress}%` }}
                />
              </div>
              <p className="text-sm tabular-nums text-slate-500">{dbLoadProgress}% complete</p>
            </section>
          ) : null)}

        {mode === "references" && !isProcessing && (
          <ReferenceLibrary
            packs={references.packs}
            loading={references.loading}
            error={references.error}
            busy={references.busy}
            clearing={references.clearing}
            cleared={references.cleared}
            onDownload={references.download}
            onRemove={references.remove}
            onToggle={references.toggle}
            onRetry={references.retry}
            onClear={references.clear}
          />
        )}

        {isLandingView && (
          <section className="grid items-center gap-8 py-5 lg:min-h-[660px] lg:grid-cols-[1fr_1.05fr] lg:gap-14 lg:py-12 xl:gap-20">
            <div className="max-w-xl">
              <p className="section-label mb-5">Your DNA, in context</p>
              <h1 className="text-4xl font-semibold leading-[1.08] tracking-[-0.04em] text-slate-950 sm:text-5xl xl:text-6xl">
                A clearer view of your genetic data.
              </h1>
              <p className="mt-6 max-w-lg text-base leading-7 text-slate-600 sm:text-lg">
                Discover what your DNA may suggest about you, then explore the research behind your variants. Bring
                together public genetic references in one workspace that runs entirely in your browser.
              </p>
              <div className="my-8 h-px w-14 bg-brand-500" />
              <ol className="space-y-5">
                {[
                  ["01", "Bring your DNA export", "Provider exports, VCF, Promethease and PDF reports."],
                  ["02", "See what your DNA suggests", "Everyday traits, with the evidence and uncertainty visible."],
                  ["03", "Build your reference library", "Choose public datasets to download and explore offline."],
                ].map(([step, title, detail]) => (
                  <li key={step} className="flex gap-4">
                    <span className="pt-0.5 font-mono text-xs text-brand-700">{step}</span>
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{title}</p>
                      <p className="mt-1 text-sm leading-5 text-slate-500">{detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                onClick={() => setMode("browse")}
                className="mt-8 inline-flex cursor-pointer items-center gap-2 rounded-md text-sm font-semibold text-brand-700 hover:text-brand-600"
              >
                Explore the reference without a file <span aria-hidden="true">→</span>
              </button>
            </div>
            <div className="space-y-4">
              <FileUpload onFileSelect={handleFileSelect} disabled={!canUpload} />
              <div className="flex items-start gap-2.5 px-1 text-xs leading-5 text-slate-500">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  className="mt-0.5 size-4 shrink-0 fill-none stroke-brand-700"
                  strokeWidth="1.5"
                >
                  <path d="m10 2 6 2v5c0 4-6 7-6 7S4 13 4 9V4l6-2Z" strokeLinejoin="round" />
                  <path d="m7 9 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p>
                  <span className="font-semibold text-slate-700">Your file stays yours.</span> All genetic data is
                  processed on this device. No account or upload required.
                </p>
              </div>
              {isDbLoading && (
                <p className="px-1 text-xs leading-5 text-slate-500">
                  Reference data is loading in the background. You can choose your file now.
                </p>
              )}
            </div>
          </section>
        )}

        {isProcessing && analysisProgress && (
          <ProcessingProgress
            snapshot={analysisProgress}
            fileName={fileName}
            summariesReady={Boolean(parseResult?.traits && !isParsing)}
          />
        )}

        {mode === "upload" && isProcessing && !isParsing && parseResult?.traits && (
          <DNASuggestions
            analysis={parseResult.traits}
            haplogroups={parseResult.haplogroups}
            packs={references.packs}
            matching
            onReferences={() => setMode("references")}
            onMatches={() => setResultView("matches")}
          />
        )}

        {mode === "upload" && hasResults && !isProcessing && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
              <div className="min-w-0">
                <h1
                  className="truncate text-lg font-semibold tracking-tight text-slate-950"
                  title={fileName ?? undefined}
                >
                  {fileName ?? "DNA analysis"}
                </h1>
                {parseResult && (
                  <p className="mt-1 text-xs text-slate-500">
                    {parseResult.report?.format === "pdf"
                      ? `${parseResult.report.pages.length.toLocaleString()} report pages read`
                      : `${parseResult.genotypes.length.toLocaleString()} ${parseResult.genotypes.length === 1 ? "variant" : "variants"} read`}
                    {detectedFormat && (
                      <>
                        {" "}
                        · <span className="capitalize">{detectedFormat.replaceAll("-", " ")}</span>
                      </>
                    )}
                    {parseResult.errors.length > 0 && (
                      <> · {parseResult.errors.length.toLocaleString()} parse warnings</>
                    )}
                  </p>
                )}
              </div>
              <button type="button" onClick={handleReset} className="secondary-button shrink-0">
                Analyze another file
              </button>
            </div>
            {parseResult?.warnings?.length ? (
              <details className="mb-5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                <summary className="cursor-pointer font-medium">Import notes ({parseResult.warnings.length})</summary>
                <ul className="mt-3 list-disc space-y-2 pl-5 text-xs leading-6">
                  {parseResult.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {parseResult && parseResult.genotypes.length > 0 && (
              <nav aria-label="Analysis results" className="mb-3 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
                {(["suggestions", "matches", "calls", ...(parseResult.report ? ["report" as const] : [])] as const).map(
                  (view) => (
                    <button
                      key={view}
                      type="button"
                      onClick={() => setResultView(view)}
                      aria-current={resultView === view ? "page" : undefined}
                      className={twMerge(
                        "cursor-pointer rounded-md px-4 py-2 text-sm font-medium",
                        resultView === view
                          ? "bg-white text-brand-700 shadow-sm"
                          : "text-slate-500 hover:text-slate-900",
                      )}
                    >
                      {view === "suggestions"
                        ? "About you"
                        : view === "matches"
                          ? "Reference matches"
                          : view === "calls"
                            ? "Imported calls"
                            : "Source report"}
                    </button>
                  ),
                )}
              </nav>
            )}
            {parseResult && parseResult.genotypes.length > 0 && analyzedReferenceRevision !== references.revision && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
                <p className="text-sm text-brand-800">
                  Your enabled reference datasets have changed. Update this analysis to include them.
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={references.busy}
                  onClick={() => void refreshAnalysis()}
                >
                  Update analysis
                </button>
              </div>
            )}
            {resultView === "report" && parseResult?.report && <ImportedReportView report={parseResult.report} />}
            {resultView === "calls" && parseResult && <ImportedCallsView calls={parseResult.genotypes} />}
            {resultView === "suggestions" && parseResult?.traits && (
              <DNASuggestions
                analysis={parseResult.traits}
                haplogroups={parseResult.haplogroups}
                packs={references.packs}
                onReferences={() => setMode("references")}
                onMatches={() => setResultView("matches")}
              />
            )}
            {resultView === "matches" && (
              <ResultsDisplay
                matches={matches ?? []}
                genosets={genosets ?? []}
                workerApi={workerApi!}
                referenceRevision={references.revision}
              />
            )}
          </>
        )}

        <footer
          className={twMerge(
            "mt-8 flex flex-wrap justify-between gap-2 text-[11px] leading-5 text-slate-400",
            isLandingView && "border-t border-slate-200 pt-5",
          )}
        >
          <span>A private workspace for genetic exploration.</span>
          <button
            type="button"
            onClick={() => setMode("references")}
            disabled={isProcessing}
            className="cursor-pointer rounded-sm hover:text-brand-700"
          >
            SNPedia + {references.packs.filter((pack) => pack.enabled).length} additional datasets · Manage sources
          </button>
        </footer>
      </main>
    </div>
  );
}

export default App;
