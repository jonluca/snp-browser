import { useEffect, useState } from "react";
import {
  describeProgress,
  formatElapsed,
  PROGRESS_STAGES,
  type AnalysisProgressSnapshot,
} from "../utils/analysisProgress";

export function ProcessingProgress({
  snapshot,
  fileName,
  summariesReady = false,
}: {
  snapshot: AnalysisProgressSnapshot;
  fileName: string | null;
  summariesReady?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const stage = PROGRESS_STAGES[snapshot.progress.stage];
  const detail = describeProgress(snapshot.progress);
  const quietFor = Math.max(0, now - snapshot.lastChangedAt);
  const determinate = detail.percent !== undefined && !detail.finishing;

  return (
    <section aria-label="File analysis progress" className="surface-panel mx-auto my-6 w-full max-w-3xl p-5 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="section-label flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="size-4 motion-safe:animate-spin" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.2" />
            <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          Processing on your device
        </p>
        <p className="text-xs tabular-nums text-slate-500">Elapsed {formatElapsed(now - snapshot.startedAt)}</p>
      </div>
      <div role="status" aria-live="polite">
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-slate-950">{stage.title}</h1>
      </div>
      {fileName && (
        <p className="mt-1 truncate text-sm font-medium text-slate-700" title={fileName}>
          {fileName}
        </p>
      )}
      <p className="mt-2 text-sm leading-6 text-slate-600">{stage.detail}</p>
      <div
        className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label={stage.title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? detail.percent : undefined}
        aria-valuetext={detail.finishing ? `${detail.label}. Finishing this step.` : detail.label}
      >
        <div
          className={`h-full rounded-full bg-brand-500 ${determinate ? "transition-[width] duration-100 motion-reduce:transition-none" : "w-1/3 motion-safe:animate-pulse"}`}
          style={determinate ? { width: `${detail.percent}%` } : undefined}
        />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs tabular-nums text-slate-600">
        <span>{detail.label}</span>
        <span>
          {detail.finishing
            ? "Finishing this step…"
            : detail.percent !== undefined && snapshot.progress.unit !== "percent"
              ? `${detail.percent}% of this step`
              : null}
        </span>
      </div>
      {quietFor >= 15000 && (
        <p className="mt-3 text-xs leading-5 text-slate-600">
          No new progress report for {formatElapsed(quietFor)}. Large files can take time between updates.
        </p>
      )}
      <ol
        aria-label="Analysis steps"
        className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-t border-slate-100 pt-4 text-xs"
      >
        {["Read file", "Match variants", "Check genosets"].map((label, index) => (
          <li
            key={label}
            aria-current={index === stage.step ? "step" : undefined}
            className={index <= stage.step ? "font-medium text-brand-700" : "text-slate-400"}
          >
            <span aria-hidden="true">{index < stage.step ? "✓" : `${index + 1}.`} </span>
            {label}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs leading-5 text-slate-500">
        {summariesReady
          ? "Your summaries are ready below. Reference matching continues on this device."
          : "Keep this tab open. Your DNA file stays on this device."}
      </p>
    </section>
  );
}
