import { useState, useCallback, useEffect } from "react";
import { useSNPMatcherWorker, proxy } from "./hooks/useSNPMatcherWorker";
import { FileUpload } from "./components/FileUpload";
import { ResultsDisplay } from "./components/ResultsDisplay";
import { parse23andMeFile, validate23andMeFile } from "./utils/fileParser";
import type { ParseResult, MatchedSNP } from "./types/snp";
import { DB_URL } from "./constants.ts";

function App() {
  const [dbProgress, setDbProgress] = useState(0);
  const [isDbLoading, setIsDbLoading] = useState(true);
  const [dbError, setDbError] = useState<Error | null>(null);
  const [dbStats, setDbStats] = useState<{ totalSNPs: number } | null>(null);

  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [matchProgress, setMatchProgress] = useState({ current: 0, total: 0 });
  const [matches, setMatches] = useState<MatchedSNP[] | null>(null);
  const [isMatching, setIsMatching] = useState(false);
  const [matchError, setMatchError] = useState<Error | null>(null);

  // Initialize persistent worker
  const { api: workerApi, isReady: isWorkerReady, error: workerError } = useSNPMatcherWorker();

  const isParsing = false; // We'll set this when parsing

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
            setDbProgress(progress);
          }),
        );

        // Get database stats
        const stats = await workerApi.getDatabaseStats();
        setDbStats(stats);

        setIsDbLoading(false);
      } catch (err) {
        console.error("Error loading database:", err);
        setDbError(err instanceof Error ? err : new Error("Failed to load database"));
        setIsDbLoading(false);
      }
    }

    loadDB();
  }, [isWorkerReady, workerApi]);

  const handleFileSelect = useCallback(
    async (file: File) => {
      if (!workerApi) return;

      try {
        // Read file
        const content = await file.text();

        // Validate format
        const validation = validate23andMeFile(content);
        if (!validation.valid) {
          throw new Error(validation.reason || "Invalid file format");
        }

        // Parse file
        const result = parse23andMeFile(content);
        setParseResult(result);

        if (result.genotypes.length === 0) {
          throw new Error("No valid SNP data found in file");
        }

        // Match SNPs using worker
        setIsMatching(true);
        setMatchError(null);
        setMatchProgress({ current: 0, total: 0 });

        const matchedSNPs = await workerApi.matchSNPs(
          result.genotypes,
          proxy((current: number, total: number) => {
            setMatchProgress({ current, total });
          }),
        );

        setMatches(matchedSNPs);
        setIsMatching(false);
      } catch (err) {
        console.error("Error processing file:", err);
        setMatchError(err instanceof Error ? err : new Error("Unknown error"));
        setIsMatching(false);
        alert(err instanceof Error ? err.message : "Unknown error");
      }
    },
    [workerApi],
  );

  const handleReset = useCallback(() => {
    setParseResult(null);
    setMatchProgress({ current: 0, total: 0 });
    setMatches(null);
    setMatchError(null);
  }, []);

  // Determine app state
  const hasResults = matches && matches.length >= 0;
  const hasError = dbError || matchError || workerError;

  return (
    <div className="min-h-screen bg-gray-50 p-5">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 text-center">
          <h1 className="mb-2 text-4xl font-bold text-gray-900">🧬 SNP Browser</h1>
          <p className="text-base text-gray-600">Upload your 23andMe data to explore your genetic variants</p>
          {dbStats && !isDbLoading && (
            <p className="mt-1 text-sm text-gray-500">Database contains {dbStats.totalSNPs.toLocaleString()} SNPs</p>
          )}
        </header>

        {/* Loading database */}
        {isDbLoading && (
          <div className="py-10 text-center">
            <div className="mb-4 text-5xl">⏳</div>
            <h2 className="mb-4 text-2xl font-semibold text-gray-800">Loading SNP Database...</h2>
            <div className="mx-auto mb-4 h-5 w-full max-w-md overflow-hidden rounded-full bg-gray-200">
              <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${dbProgress}%` }} />
            </div>
            <p className="text-gray-600">{Math.round(dbProgress)}% complete</p>
            <p className="mt-2 text-xs text-gray-500">Loading 155MB database (~30-60 seconds)</p>
          </div>
        )}

        {/* Database error */}
        {hasError && !isDbLoading && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-10 text-center">
            <div className="mb-4 text-5xl">⚠️</div>
            <h2 className="mb-4 text-2xl font-semibold text-gray-800">Error</h2>
            <p className="text-red-600">
              {dbError?.message || matchError?.message || workerError?.message || "An unknown error occurred"}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded bg-blue-500 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-600"
            >
              Reload Page
            </button>
          </div>
        )}

        {/* Ready to upload */}
        {!isDbLoading && !hasError && !hasResults && <FileUpload onFileSelect={handleFileSelect} />}

        {/* Parsing (this state is brief, might not show) */}
        {isParsing && (
          <div className="py-10 text-center">
            <div className="mb-4 text-5xl">📄</div>
            <h2 className="text-2xl font-semibold text-gray-800">Parsing your genomic data...</h2>
          </div>
        )}

        {/* Matching SNPs */}
        {isMatching && (
          <div className="py-10 text-center">
            <div className="mb-4 text-5xl">🔍</div>
            <h2 className="mb-4 text-2xl font-semibold text-gray-800">Matching SNPs with database...</h2>
            {parseResult && (
              <p className="mb-4 text-gray-600">
                Found {parseResult.genotypes.length.toLocaleString()} SNPs in your file
              </p>
            )}
            <div className="mx-auto mb-4 h-5 w-full max-w-md overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full bg-green-500 transition-all duration-300"
                style={{
                  width: `${matchProgress.total > 0 ? (matchProgress.current / matchProgress.total) * 100 : 0}%`,
                }}
              />
            </div>
            <p className="text-gray-600">
              {matchProgress.current.toLocaleString()} / {matchProgress.total.toLocaleString()} processed
            </p>
          </div>
        )}

        {/* Results */}
        {hasResults && matches && !isMatching && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div>
                {parseResult && (
                  <p className="m-0 text-sm text-gray-600">
                    Processed {parseResult.genotypes.length.toLocaleString()} SNPs from your file
                    {parseResult.errors.length > 0 && ` (${parseResult.errors.length} errors)`}
                  </p>
                )}
              </div>
              <button
                onClick={handleReset}
                className="rounded border border-gray-300 bg-gray-100 px-4 py-2 text-sm transition-colors hover:bg-gray-200"
              >
                Upload New File
              </button>
            </div>
            <ResultsDisplay matches={matches} />
          </>
        )}
      </div>
    </div>
  );
}

export default App;
