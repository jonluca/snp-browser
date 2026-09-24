import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisProgress, AnalysisProgressSnapshot } from "../utils/analysisProgress";

/** Keep callbacks cheap even when a parser reports every chunk or record batch. */
export function useAnalysisProgress() {
  const [snapshot, setSnapshot] = useState<AnalysisProgressSnapshot | null>(null);
  const pending = useRef<AnalysisProgressSnapshot | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const publishedAt = useRef(0);
  const clearPending = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => clearPending, [clearPending]);

  const start = useCallback(
    (progress: AnalysisProgress) => {
      clearPending();
      const now = Date.now();
      pending.current = { progress, startedAt: now, lastChangedAt: now };
      publishedAt.current = now;
      setSnapshot(pending.current);
    },
    [clearPending],
  );

  const update = useCallback(
    (progress: AnalysisProgress) => {
      const previous = pending.current;
      if (!previous) return;
      if (
        previous.progress.stage === progress.stage &&
        previous.progress.current === progress.current &&
        previous.progress.total === progress.total &&
        previous.progress.unit === progress.unit
      )
        return;
      const now = Date.now();
      pending.current = { progress, startedAt: previous.startedAt, lastChangedAt: now };
      const publish = () => {
        clearPending();
        publishedAt.current = Date.now();
        setSnapshot(pending.current);
      };
      if (previous.progress.stage !== progress.stage || now - publishedAt.current >= 100) publish();
      else if (timer.current === undefined) timer.current = setTimeout(publish, 100 - (now - publishedAt.current));
    },
    [clearPending],
  );

  const finish = useCallback(() => {
    clearPending();
    pending.current = null;
    setSnapshot(null);
  }, [clearPending]);

  return { snapshot, start, update, finish };
}
