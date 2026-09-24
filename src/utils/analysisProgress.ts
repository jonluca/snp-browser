import type { ImportProgress } from "../types/progress";

export type AnalysisProgress =
  | ImportProgress
  | {
      stage: "database" | "matches" | "genosets";
      current?: number;
      total?: number;
      unit?: "percent" | "genosets";
    };

export interface AnalysisProgressSnapshot {
  progress: AnalysisProgress;
  startedAt: number;
  lastChangedAt: number;
}

export const PROGRESS_STAGES = {
  reading: { title: "Opening your DNA file", detail: "Reading the file from your device.", step: 0 },
  extracting: {
    title: "Unpacking your archive",
    detail: "Extracting your file locally. Large archives can take a while.",
    step: 0,
  },
  detecting: { title: "Checking your file format", detail: "Identifying the data in your file.", step: 0 },
  parsing: {
    title: "Reading your DNA data",
    detail: "Processing the calls or report in your file on this device.",
    step: 0,
  },
  summarizing: {
    title: "Calculating your DNA summaries",
    detail: "Checking the markers for traits and haplogroups locally.",
    step: 0,
  },
  preparing: {
    title: "Preparing your results",
    detail: "Making the imported data ready to display. Large files can take a while.",
    step: 0,
  },
  database: {
    title: "Preparing the reference database",
    detail: "The reference is loading. Matching will start automatically when it is ready.",
    step: 1,
  },
  matches: {
    title: "Finding your reference matches",
    detail: "Comparing your imported calls with the available reference data.",
    step: 1,
  },
  genosets: {
    title: "Checking related genosets",
    detail: "Looking for combinations across your matching records.",
    step: 2,
  },
} as const;

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Percentages describe just the current measurable stage, never total completion. */
export function describeProgress(progress: AnalysisProgress) {
  const measurable = Number.isFinite(progress.current) && Number.isFinite(progress.total) && progress.total! > 0;
  if (!measurable) return { percent: undefined, label: "Waiting for a progress report…", finishing: false };
  const total = progress.total!;
  const current = Math.max(0, Math.min(progress.current!, total));
  const percent = Math.floor((current / total) * 100);
  const units = {
    bytes: "read",
    lines: "lines processed",
    pages: "pages read",
    characters: "characters processed",
    genosets: "genosets checked",
  };
  const label =
    progress.unit === "percent"
      ? `${percent}% of this step`
      : progress.unit === "bytes"
        ? `${formatBytes(current)} / ${formatBytes(total)} read`
        : `${Math.floor(current).toLocaleString()} / ${Math.floor(total).toLocaleString()} ${units[progress.unit ?? "lines"]}`;
  // Reading all compressed bytes can precede decoding their content. Matching
  // also has a final merge after its last count. Do not show analysis complete.
  return { percent, label, finishing: current >= total };
}
