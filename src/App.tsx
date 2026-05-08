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
    lowerFilename.endsWith(".g.vcf.gz")
  );
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

        const parseAsStream = isVcfLikeFile(file);
        const result = parseAsStream
          ? await parserWorkerApi.parseFileBlob(
              file,
              proxy((current: number, total: number) => {
                const progress = total > 0 ? (current / total) * 100 : 0;
                if (progressBarRef.current) {
                  progressBarRef.current.style.width = `${progress}%`;
                }
                if (progressTextRef.current) {
                  progressTextRef.current.textContent = `${formatBytes(current)} / ${formatBytes(total)} read`;
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
  const hasError = dbError || matchError || workerError || parserWorkerError;
  const isDatabaseReady = Boolean(dbStats) && !isDbLoading && !dbError;
  const isProcessing = isParsing || isMatching || isMatchingGenosets;
  const isWaitingForDatabase = isMatching && !isDatabaseReady;
  const canUpload =
    Boolean(parserWorkerApi) && Boolean(workerApi) && isParserWorkerReady && isWorkerReady && !isProcessing;

  return (
    <div className="min-h-screen bg-gray-50 p-5">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 text-center">
          <h1 className="mb-2 text-4xl font-bold text-gray-900">🧬 SNP Browser</h1>
          <p className="text-base text-gray-600">Explore genetic variants from SNPedia and match with your DNA data</p>
          {isDatabaseReady && dbStats && (
            <p className="mt-1 text-sm text-gray-500">Database contains {dbStats.totalSNPs.toLocaleString()} SNPs</p>
          )}
          {isDbLoading && !dbError && (
            <p className="mt-1 text-sm text-gray-500">Loading database in the background: {dbLoadProgress}% complete</p>
          )}

          {/* Mode toggle */}
          {!hasError && !hasResults && !isProcessing && (
            <div className="mt-4 inline-flex rounded-lg border gap-1 border-gray-300 bg-white p-1 shadow-sm">
              <button
                onClick={() => setMode("browse")}
                disabled={!isDatabaseReady}
                title={isDatabaseReady ? undefined : "Database is still loading"}
                className={twMerge(
                  "rounded-md px-4 py-2 text-sm font-medium cursor-pointer transition-colors",
                  mode === "browse" ? "bg-blue-500 text-white" : "text-gray-700 hover:bg-gray-100",
                  !isDatabaseReady && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                Browse Database
              </button>
              <button
                onClick={() => setMode("upload")}
                className={twMerge(
                  "rounded-md px-4 py-2 text-sm font-medium transition-colors cursor-pointer",
                  mode === "upload" ? "bg-blue-500 text-white" : "text-gray-700 hover:bg-gray-100",
                )}
              >
                Upload Your Data
              </button>
            </div>
          )}
        </header>

        {/* Database error */}
        {hasError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-10 text-center">
            <div className="mb-4 text-5xl">⚠️</div>
            <h2 className="mb-4 text-2xl font-semibold text-gray-800">Error</h2>
            <p className="text-red-600">
              {dbError?.message ||
                matchError?.message ||
                workerError?.message ||
                parserWorkerError?.message ||
                "An unknown error occurred"}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded bg-blue-500 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-600"
            >
              Reload Page
            </button>
          </div>
        )}

        {/* Main content area */}
        {!hasError && !hasResults && !isParsing && !isMatching && !isMatchingGenosets && (
          <>
            {mode === "browse" &&
              (isDatabaseReady && workerApi ? (
                <SNPBrowser workerApi={workerApi} />
              ) : (
                <div className="rounded-lg border border-gray-200 bg-white p-10 text-center">
                  <div className="mb-4 text-5xl">⏳</div>
                  <h2 className="mb-4 text-2xl font-semibold text-gray-800">Preparing SNP Database...</h2>
                  <div className="mx-auto mb-4 h-5 w-full max-w-md overflow-hidden rounded-full bg-gray-200">
                    <div
                      ref={progressBarRef}
                      className="h-full bg-blue-500 transition-all duration-300"
                      style={{ width: `${dbLoadProgress}%` }}
                    />
                  </div>
                  <p ref={progressTextRef} className="text-gray-600">
                    {dbLoadProgress}% complete
                  </p>
                </div>
              ))}
            {mode === "upload" && (
              <>
                <FileUpload onFileSelect={handleFileSelect} disabled={!canUpload} />
                {isDbLoading && (
                  <p className="mt-4 text-center text-sm text-gray-500">
                    Database is loading in the background. Matching starts as soon as it is ready.
                  </p>
                )}
              </>
            )}
          </>
        )}

        {/* Parsing file */}
        {isParsing && (
          <div className="py-10 text-center">
            <div className="mb-4 text-5xl">📄</div>
            <h2 className="mb-4 text-2xl font-semibold text-gray-800">Parsing your file...</h2>
            <div className="mx-auto mb-4 h-5 w-full max-w-md overflow-hidden rounded-full bg-gray-200">
              <div
                ref={progressBarRef}
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: "0%" }}
              />
            </div>
            <p ref={progressTextRef} className="text-gray-600">
              0 / 0 lines processed
            </p>
          </div>
        )}

        {/* Matching SNPs */}
        {isMatching && (
          <div className="py-10 text-center">
            <div className="mb-4 text-5xl">🔍</div>
            <h2 className="mb-4 text-2xl font-semibold text-gray-800">
              {isWaitingForDatabase ? "Preparing SNP database..." : "Matching SNPs with database..."}
            </h2>
            {parseResult && (
              <p className="mb-4 text-gray-600">
                Found {parseResult.genotypes.length.toLocaleString()} SNPs in your file
              </p>
            )}
            <div className="mx-auto mb-4 h-5 w-full max-w-md overflow-hidden rounded-full bg-gray-200">
              <div
                ref={progressBarRef}
                className="h-full bg-green-500 transition-all duration-300"
                style={{ width: isWaitingForDatabase ? `${dbLoadProgress}%` : "0%" }}
              />
            </div>
            <p ref={progressTextRef} className="text-gray-600">
              {isWaitingForDatabase ? `${dbLoadProgress}% complete` : "0 / 0 SNPs processed"}
            </p>
          </div>
        )}

        {/* Matching Genosets */}
        {isMatchingGenosets && (
          <div className="py-10 text-center">
            <div className="mb-4 text-5xl">🧬</div>
            <h2 className="mb-4 text-2xl font-semibold text-gray-800">Finding matching genosets...</h2>
            {matches && (
              <p className="mb-4 text-gray-600">
                Checking genosets against {matches.length.toLocaleString()} matched SNPs
              </p>
            )}
            <div className="mx-auto mb-4 h-5 w-full max-w-md overflow-hidden rounded-full bg-gray-200">
              <div
                ref={progressBarRef}
                className="h-full bg-purple-500 transition-all duration-300"
                style={{ width: "0%" }}
              />
            </div>
            <p ref={progressTextRef} className="text-gray-600">
              0 / 0 genosets checked
            </p>
          </div>
        )}

        {/* Results */}
        {hasResults && matches && genosets && !isMatching && !isMatchingGenosets && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div>
                {parseResult && (
                  <div className="space-y-1">
                    <p className="m-0 text-sm text-gray-600">
                      Processed {parseResult.genotypes.length.toLocaleString()} SNPs from your file
                      {parseResult.errors.length > 0 && ` (${parseResult.errors.length} errors)`}
                    </p>
                    {detectedFormat && (
                      <p className="m-0 text-xs text-gray-500">
                        Detected format:{" "}
                        <span className="font-medium capitalize">{detectedFormat.replace("-", " ")}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={handleReset}
                className="rounded border border-gray-300 bg-gray-100 px-4 py-2 text-sm transition-colors hover:bg-gray-200"
              >
                Upload New File
              </button>
            </div>
            <ResultsDisplay matches={matches} genosets={genosets} />
          </>
        )}
      </div>
    </div>
  );
}

export default App;
