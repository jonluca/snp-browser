import { useState, useCallback, useEffect, useRef } from "react";
import { twMerge } from "tailwind-merge";
import { useSNPMatcherWorker, proxy } from "./hooks/useSNPMatcherWorker";
import { FileUpload } from "./components/FileUpload";
import { ResultsDisplay } from "./components/ResultsDisplay";
import { SNPBrowser } from "./components/SNPBrowser";
import type { ParseResult, MatchedSNP, MatchedGenoset } from "./types/snp";
import { DB_URL } from "./constants.ts";

type AppMode = "upload" | "browse";

function isVcfLikeFile(file: File): boolean {
  const lowerFilename = file.name.toLowerCase();
  return (
    lowerFilename.endsWith(".vcf") ||
    lowerFilename.endsWith(".gvcf") ||
    lowerFilename.endsWith(".g.vcf") ||
    lowerFilename.endsWith(".vcf.gz") ||
    lowerFilename.endsWith(".g.vcf.gz") ||
    (lowerFilename.endsWith(".gz") && lowerFilename.includes("vcf"))
  );
}

function isZipFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".zip");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function App() {
  const [mode, setMode] = useState<AppMode>("upload");
  const [isDbLoading, setIsDbLoading] = useState(true);
  const [dbLoadProgress, setDbLoadProgress] = useState(0);
  const [dbError, setDbError] = useState<Error | null>(null);
  const [dbStats, setDbStats] = useState<{ totalSNPs: number } | null>(null);

  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [detectedFormat, setDetectedFormat] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [matches, setMatches] = useState<MatchedSNP[] | null>(null);
  const [genosets, setGenosets] = useState<MatchedGenoset[] | null>(null);
  const [isMatching, setIsMatching] = useState(false);
  const [isMatchingGenosets, setIsMatchingGenosets] = useState(false);
  const [matchError, setMatchError] = useState<Error | null>(null);

  // Refs for direct DOM manipulation of progress bar (shared across all operations)
  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressTextRef = useRef<HTMLParagraphElement>(null);
  const dbLoadProgressRef = useRef(0);
  const dbLoadPromiseRef = useRef<Promise<void> | null>(null);

  // Use separate workers so uploads can be parsed while the database worker is loading SQLite.
  const { api: workerApi, isReady: isWorkerReady, error: workerError } = useSNPMatcherWorker();
  const { api: parserWorkerApi, isReady: isParserWorkerReady, error: parserWorkerError } = useSNPMatcherWorker();

  // Load database when worker is ready
  useEffect(() => {
    if (!isWorkerReady || !workerApi) return;

    async function loadDB() {
      if (!workerApi) return;

      try {
        setIsDbLoading(true);
        setDbError(null);

        // Load database in worker thread
        await workerApi.loadDatabase(
          DB_URL,
          proxy((progress: number) => {
            const roundedProgress = Math.round(progress);
            if (dbLoadProgressRef.current !== roundedProgress) {
              dbLoadProgressRef.current = roundedProgress;
              setDbLoadProgress(roundedProgress);
            }
            if (progressBarRef.current) {
              progressBarRef.current.style.width = `${progress}%`;
            }
            if (progressTextRef.current) {
              progressTextRef.current.textContent = `${Math.round(progress)}% complete`;
            }
          }),
        );

        // Get database stats
        const stats = await workerApi.getDatabaseStats();
        setDbStats(stats);

        setDbLoadProgress(100);
        setIsDbLoading(false);
      } catch (err) {
        console.error("Error loading database:", err);
        const databaseError = err instanceof Error ? err : new Error("Failed to load database");
        setDbError(databaseError);
        setIsDbLoading(false);
        throw databaseError;
      }
    }

    const loadPromise = loadDB();
    dbLoadPromiseRef.current = loadPromise;
    void loadPromise.catch(() => undefined);
  }, [isWorkerReady, workerApi]);

  const handleFileSelect = useCallback(
    async (file: File) => {
      if (!workerApi || !parserWorkerApi) return;

      try {
        // Parse file in worker thread with progress reporting
        setIsParsing(true);
        setMatchError(null);

        const parseAsBlob = isVcfLikeFile(file) || isZipFile(file);
        const showByteProgress = isVcfLikeFile(file) && !isZipFile(file);
        const result = parseAsBlob
          ? await parserWorkerApi.parseFileBlob(
              file,
              proxy((current: number, total: number) => {
                const progress = total > 0 ? (current / total) * 100 : 0;
                if (progressBarRef.current) {
                  progressBarRef.current.style.width = `${progress}%`;
                }
                if (progressTextRef.current) {
                  progressTextRef.current.textContent = showByteProgress
                    ? `${formatBytes(current)} / ${formatBytes(total)} read`
                    : `${current.toLocaleString()} / ${total.toLocaleString()} processed`;
                }
              }),
            )
          : await parserWorkerApi.parseFile(
              await file.text(),
              proxy((current: number, total: number) => {
                const progress = total > 0 ? (current / total) * 100 : 0;
                if (progressBarRef.current) {
                  progressBarRef.current.style.width = `${progress}%`;
                }
                if (progressTextRef.current) {
                  progressTextRef.current.textContent = `${current.toLocaleString()} / ${total.toLocaleString()} lines processed`;
                }
              }),
            );

        setParseResult(result);
        setDetectedFormat(result.detectedFormat || null);
        setIsParsing(false);

        if (result.genotypes.length === 0) {
          throw new Error(
            result.detectedFormat === "vcf"
              ? "No rsID SNP genotype records were found in this VCF/gVCF. Reference blocks and indels are skipped because SNP Browser can only match SNP records with rsIDs against SNPedia."
              : "No valid SNP data found in file",
          );
        }

        // Match SNPs using worker
        setIsMatching(true);

        if (dbLoadPromiseRef.current) {
          await dbLoadPromiseRef.current;
        }

        const matchedSNPs = await workerApi.matchSNPs(
          result.genotypes,
          proxy((current: number, total: number) => {
            const progress = total > 0 ? (current / total) * 100 : 0;
            if (progressBarRef.current) {
              progressBarRef.current.style.width = `${progress}%`;
            }
            if (progressTextRef.current) {
              progressTextRef.current.textContent = `${current.toLocaleString()} / ${total.toLocaleString()} SNPs processed`;
            }
          }),
        );

        setMatches(matchedSNPs);
        setIsMatching(false);

        // Match genosets
        setIsMatchingGenosets(true);

        const matchedGenosets = await workerApi.matchGenosets(
          matchedSNPs,
          proxy((current: number, total: number) => {
            const progress = total > 0 ? (current / total) * 100 : 0;
            if (progressBarRef.current) {
              progressBarRef.current.style.width = `${progress}%`;
            }
            if (progressTextRef.current) {
              progressTextRef.current.textContent = `${current.toLocaleString()} / ${total.toLocaleString()} genosets checked`;
            }
          }),
        );

        setGenosets(matchedGenosets);
        setIsMatchingGenosets(false);
      } catch (err) {
        console.error("Error processing file:", err);
        setMatchError(err instanceof Error ? err : new Error("Unknown error"));
        setIsParsing(false);
        setIsMatching(false);
        setIsMatchingGenosets(false);
        alert(err instanceof Error ? err.message : "Unknown error");
      }
    },
    [parserWorkerApi, workerApi],
  );

  const handleReset = useCallback(() => {
    setParseResult(null);
    setDetectedFormat(null);
    setMatches(null);
    setGenosets(null);
    setMatchError(null);
    setMode("upload");
  }, []);

  // Determine app state
  const hasResults = matches && matches.length >= 0 && genosets !== null;
  const error = dbError || matchError || workerError || parserWorkerError;
  const hasError = Boolean(error);
  const isDatabaseReady = Boolean(dbStats) && !isDbLoading && !dbError;
  const isProcessing = isParsing || isMatching || isMatchingGenosets;
  const isWaitingForDatabase = isMatching && !isDatabaseReady;
  const canUpload =
    Boolean(parserWorkerApi) && Boolean(workerApi) && isParserWorkerReady && isWorkerReady && !isProcessing;
  const isLandingView = mode === "upload" && !hasError && !hasResults && !isProcessing;
  const databaseStatus = isDatabaseReady
    ? `${dbStats?.totalSNPs.toLocaleString()} SNPs ready`
    : isDbLoading && !dbError
      ? `Preparing database - ${dbLoadProgress}%`
      : "Database unavailable";

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute -left-40 top-32 size-96 rounded-full bg-brand-100/60 blur-3xl" />
      <div className="pointer-events-none absolute -right-40 top-0 size-96 rounded-full bg-teal-100/50 blur-3xl" />
      <main className="relative mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
        <header
          className={twMerge(
            "surface-panel mb-6 overflow-hidden bg-white/75 backdrop-blur",
            isLandingView ? "p-5 sm:p-8" : "p-4 sm:px-6 sm:py-5",
          )}
        >
          <div
            className={twMerge(
              "flex flex-col lg:flex-row lg:justify-between",
              isLandingView ? "gap-7 lg:items-end" : "gap-4 lg:items-center",
            )}
          >
            <div className={twMerge(isLandingView && "max-w-3xl")}>
              <div className={twMerge("flex flex-wrap items-center gap-3", isLandingView && "mb-6")}>
                <div className="flex size-11 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-sm">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="size-6 fill-none stroke-current"
                    strokeWidth="1.8"
                  >
                    <path d="M7 3c10 4 0 14 10 18M17 3C7 7 17 17 7 21" strokeLinecap="round" />
                    <path d="M8.5 7h7M7.5 12h9M8.5 17h7" strokeLinecap="round" />
                  </svg>
                </div>
                <span className="text-lg font-semibold tracking-tight text-slate-900">SNP Browser</span>
                <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                  Private analysis
                </span>
              </div>
              {isLandingView && (
                <>
                  <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                    Explore genetic variants without sending your DNA anywhere.
                  </h1>
                  <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
                    Match raw DNA exports with SNPedia insights or browse the reference database directly. Processing
                    stays inside your browser.
                  </p>
                </>
              )}
            </div>

            <div
              className={twMerge(
                "flex shrink-0",
                isLandingView ? "flex-col items-start gap-4 lg:items-end" : "flex-wrap items-center gap-3",
              )}
            >
              <div
                className={twMerge(
                  "flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium",
                  isDatabaseReady
                    ? "border-brand-100 bg-brand-50 text-brand-700"
                    : dbError
                      ? "border-red-100 bg-red-50 text-red-700"
                      : "border-amber-100 bg-amber-50 text-amber-700",
                )}
              >
                <span
                  className={twMerge(
                    "size-2 rounded-full",
                    isDatabaseReady ? "bg-brand-500" : dbError ? "bg-red-500" : "animate-pulse bg-amber-500",
                  )}
                />
                {databaseStatus}
              </div>

              {!hasError && !hasResults && !isProcessing && (
                <nav
                  aria-label="Workspace view"
                  className="inline-flex gap-1 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => setMode("upload")}
                    className={twMerge(
                      "cursor-pointer rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors",
                      mode === "upload" ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50",
                    )}
                  >
                    Analyze file
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("browse")}
                    disabled={!isDatabaseReady}
                    title={isDatabaseReady ? undefined : "Database is still loading"}
                    className={twMerge(
                      "cursor-pointer rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors",
                      mode === "browse" ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50",
                      !isDatabaseReady && "cursor-not-allowed opacity-45 hover:bg-transparent",
                    )}
                  >
                    Browse database
                  </button>
                </nav>
              )}
            </div>
          </div>
        </header>

        {/* Error */}
        {hasError && (
          <div className="mb-6 flex gap-4 rounded-2xl border border-red-200 bg-red-50 p-5 sm:items-center">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-red-100 text-red-700">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6 fill-none stroke-current" strokeWidth="1.8">
                <path d="M12 8v5m0 3h.01M12 3.5 2.7 20h18.6L12 3.5Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className="font-semibold text-red-950">Something stopped the analysis</h2>
              <p className="mt-1 text-sm text-red-700">{error?.message || "An unknown error occurred"}</p>
              <p className="mt-1 text-sm text-slate-600">Choose another file below to try again.</p>
            </div>
          </div>
        )}

        {/* Main content area */}
        {!hasResults && !isParsing && !isMatching && !isMatchingGenosets && (
          <>
            {mode === "browse" &&
              !hasError &&
              (isDatabaseReady && workerApi ? (
                <SNPBrowser workerApi={workerApi} />
              ) : (
                <div className="surface-panel px-6 py-14 text-center">
                  <p className="section-label mb-3">Reference database</p>
                  <h2 className="mb-5 text-2xl font-semibold tracking-tight text-slate-900">Preparing SNPedia data</h2>
                  <div className="mx-auto mb-4 h-2.5 w-full max-w-md overflow-hidden rounded-full bg-slate-100">
                    <div
                      ref={progressBarRef}
                      className="h-full rounded-full bg-brand-500 transition-all duration-300"
                      style={{ width: `${dbLoadProgress}%` }}
                    />
                  </div>
                  <p ref={progressTextRef} className="text-sm text-slate-500">
                    {dbLoadProgress}% complete
                  </p>
                </div>
              ))}
            {(mode === "upload" || hasError) && (
              <section className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
                <div className="order-1 space-y-3 lg:order-2">
                  <FileUpload onFileSelect={handleFileSelect} disabled={!canUpload} />
                  {isDbLoading && (
                    <div className="subtle-panel flex items-center gap-3 px-4 py-3 text-sm text-slate-600">
                      <span className="size-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
                      Reference data is loading in the background. Matching starts as soon as it is ready.
                    </div>
                  )}
                </div>
                <aside className="surface-panel order-2 flex flex-col justify-between p-6 sm:p-8 lg:order-1">
                  <div>
                    <p className="section-label">Your workspace</p>
                    <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                      From raw export to interpretable matches.
                    </h2>
                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      Bring an export from your DNA provider. SNP Browser detects the format, matches SNPs and finds
                      relevant genosets.
                    </p>
                    <ol className="mt-8 space-y-5">
                      {[
                        ["01", "Choose a DNA export", "Common provider files, VCF and ZIP archives are supported."],
                        ["02", "Match locally", "Analysis runs in this tab using the SNPedia reference."],
                        ["03", "Explore findings", "Review SNPs and genosets, then export useful results."],
                      ].map(([step, title, detail]) => (
                        <li key={step} className="flex gap-4">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700">
                            {step}
                          </span>
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{title}</p>
                            <p className="mt-1 text-sm leading-5 text-slate-500">{detail}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="mt-9 rounded-2xl border border-brand-100 bg-brand-50 p-4">
                    <p className="text-sm font-semibold text-brand-700">Privacy built in</p>
                    <p className="mt-1 text-sm leading-5 text-slate-600">
                      Your genetic file remains on this device and is never uploaded to a server.
                    </p>
                  </div>
                </aside>
              </section>
            )}
          </>
        )}

        {/* Parsing file */}
        {isParsing && (
          <div className="surface-panel px-6 py-14 text-center">
            <p className="section-label mb-3">Step 1 of 3</p>
            <h2 className="mb-3 text-2xl font-semibold tracking-tight text-slate-900">Reading your DNA file</h2>
            <p className="mx-auto mb-7 max-w-lg text-sm text-slate-500">
              Detecting its format and extracting genotype records.
            </p>
            <div className="mx-auto mb-4 h-2.5 w-full max-w-md overflow-hidden rounded-full bg-slate-100">
              <div
                ref={progressBarRef}
                className="h-full rounded-full bg-brand-500 transition-all duration-300"
                style={{ width: "0%" }}
              />
            </div>
            <p ref={progressTextRef} className="text-sm text-slate-500">
              0 / 0 lines processed
            </p>
          </div>
        )}

        {/* Matching SNPs */}
        {isMatching && (
          <div className="surface-panel px-6 py-14 text-center">
            <p className="section-label mb-3">Step 2 of 3</p>
            <h2 className="mb-3 text-2xl font-semibold tracking-tight text-slate-900">
              {isWaitingForDatabase ? "Preparing SNP database..." : "Matching SNPs with database..."}
            </h2>
            {parseResult && (
              <p className="mx-auto mb-7 max-w-lg text-sm text-slate-500">
                Found {parseResult.genotypes.length.toLocaleString()} SNPs in your file
              </p>
            )}
            <div className="mx-auto mb-4 h-2.5 w-full max-w-md overflow-hidden rounded-full bg-slate-100">
              <div
                ref={progressBarRef}
                className="h-full rounded-full bg-brand-500 transition-all duration-300"
                style={{ width: isWaitingForDatabase ? `${dbLoadProgress}%` : "0%" }}
              />
            </div>
            <p ref={progressTextRef} className="text-sm text-slate-500">
              {isWaitingForDatabase ? `${dbLoadProgress}% complete` : "0 / 0 SNPs processed"}
            </p>
          </div>
        )}

        {/* Matching Genosets */}
        {isMatchingGenosets && (
          <div className="surface-panel px-6 py-14 text-center">
            <p className="section-label mb-3">Step 3 of 3</p>
            <h2 className="mb-3 text-2xl font-semibold tracking-tight text-slate-900">Finding matching genosets</h2>
            {matches && (
              <p className="mx-auto mb-7 max-w-lg text-sm text-slate-500">
                Checking genosets against {matches.length.toLocaleString()} matched SNPs
              </p>
            )}
            <div className="mx-auto mb-4 h-2.5 w-full max-w-md overflow-hidden rounded-full bg-slate-100">
              <div
                ref={progressBarRef}
                className="h-full rounded-full bg-brand-500 transition-all duration-300"
                style={{ width: "0%" }}
              />
            </div>
            <p ref={progressTextRef} className="text-sm text-slate-500">
              0 / 0 genosets checked
            </p>
          </div>
        )}

        {/* Results */}
        {hasResults && matches && genosets && !isMatching && !isMatchingGenosets && (
          <>
            <div className="surface-panel mb-5 flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                {parseResult && (
                  <div className="space-y-1">
                    <p className="m-0 text-sm font-medium text-slate-700">
                      Processed {parseResult.genotypes.length.toLocaleString()} SNPs from your file
                      {parseResult.errors.length > 0 && ` (${parseResult.errors.length} errors)`}
                    </p>
                    {detectedFormat && (
                      <p className="m-0 text-xs text-slate-500">
                        Detected format:{" "}
                        <span className="font-medium capitalize">{detectedFormat.replace("-", " ")}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
              <button type="button" onClick={handleReset} className="secondary-button">
                Analyze another file
              </button>
            </div>
            <ResultsDisplay matches={matches} genosets={genosets} />
          </>
        )}
      </main>
    </div>
  );
}

export default App;
