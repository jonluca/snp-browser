import { useEffect, useState, useRef } from "react";
import { wrap, proxy, type Remote } from "comlink";
import type { SNPMatcherWorkerApi } from "../workers/snpMatcher.worker";
import SNPMatcherWorker from "../workers/snpMatcher.worker?worker";

export interface UseSNPMatcherWorkerResult {
  api: Remote<SNPMatcherWorkerApi> | null;
  isReady: boolean;
  error: Error | null;
}

/**
 * Hook that manages a persistent Web Worker for SNP matching operations.
 * The worker is created once and persists for the lifetime of the component.
 */
export function useSNPMatcherWorker(): UseSNPMatcherWorkerResult {
  const [error, setError] = useState<Error | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const apiRef = useRef<Remote<SNPMatcherWorkerApi> | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    try {
      // Create worker instance
      const worker = new SNPMatcherWorker();
      workerRef.current = worker;

      // Wrap with Comlink
      apiRef.current = wrap<SNPMatcherWorkerApi>(worker);

      // Set up error handler
      worker.onerror = (errorEvent: ErrorEvent) => {
        console.error("Worker error:", errorEvent);
        setError(new Error(`Worker error: ${errorEvent.message}`));
      };

      setIsReady(true);
    } catch (err) {
      console.error("Failed to initialize worker:", err);
      setError(err instanceof Error ? err : new Error("Failed to initialize worker"));
    }

    // Cleanup on unmount
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
        apiRef.current = null;
      }
    };
  }, []);

  return {
    // eslint-disable-next-line react-hooks/refs -- This is intentional for worker API access
    api: apiRef.current,
    isReady,
    error,
  };
}

// Helper to wrap callbacks for Comlink
export { proxy };
