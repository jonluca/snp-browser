/** Progress describes the active import operation, never overall completion. */
export interface ImportProgress {
  stage: "reading" | "extracting" | "detecting" | "parsing" | "summarizing" | "preparing";
  current?: number;
  total?: number;
  unit?: "bytes" | "lines" | "pages" | "characters";
}
