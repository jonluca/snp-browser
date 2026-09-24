import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProcessingProgress } from "../src/components/ProcessingProgress";
import { describeProgress, formatElapsed, type AnalysisProgress } from "../src/utils/analysisProgress";

test("unknown and invalid totals never invent percentages", () => {
  for (const total of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(describeProgress({ stage: "parsing", current: 10, total }).percent).toBeUndefined();
  }
  expect(describeProgress({ stage: "extracting" }).percent).toBeUndefined();
});

test("file bytes, pages and character positions retain their own units", () => {
  expect(describeProgress({ stage: "parsing", current: 1024 ** 2, total: 4 * 1024 ** 2, unit: "bytes" })).toEqual({
    percent: 25,
    label: "1.0 MB / 4.0 MB read",
    finishing: false,
  });
  expect(describeProgress({ stage: "parsing", current: 2, total: 5, unit: "pages" }).label).toBe("2 / 5 pages read");
  expect(describeProgress({ stage: "parsing", current: 2, total: 5, unit: "characters" }).label).toBe(
    "2 / 5 characters processed",
  );
  expect(describeProgress({ stage: "matches", current: 70, total: 100, unit: "percent" }).label).toBe(
    "70% of this step",
  );
});

test("a full input count means finishing the stage, not a completed analysis", () => {
  expect(describeProgress({ stage: "parsing", current: 1000, total: 1000, unit: "bytes" }).finishing).toBe(true);
  expect(describeProgress({ stage: "parsing", current: 999.99, total: 1000 }).percent).toBe(99);
  expect(describeProgress({ stage: "matches", current: 101, total: 100 }).percent).toBe(100);
  expect(describeProgress({ stage: "matches", current: -1, total: 100 }).percent).toBe(0);
});

function render(progress: AnalysisProgress, quietFor = 0) {
  const now = Date.now();
  return renderToStaticMarkup(
    createElement(ProcessingProgress, {
      snapshot: { progress, startedAt: now - 30000, lastChangedAt: now - quietFor },
      fileName: "large.vcf.gz",
    }),
  );
}

test("accessible meter distinguishes measurable and unmeasurable stages", () => {
  const measurable = render({ stage: "parsing", current: 1, total: 4, unit: "bytes" });
  expect(measurable).toContain('role="progressbar"');
  expect(measurable).toContain('aria-label="Reading your DNA data"');
  expect(measurable).toContain('aria-valuenow="25"');
  expect(measurable).toContain('role="status"');
  for (const progress of [{ stage: "summarizing" }, { stage: "parsing", current: 4, total: 4, unit: "bytes" }] as const)
    expect(render(progress)).not.toContain("aria-valuenow");
  expect(render({ stage: "parsing", current: 4, total: 4, unit: "bytes" })).toContain("Finishing this step");
});

test("elapsed time and delayed reports do not claim worker liveness", () => {
  expect(formatElapsed(65000)).toBe("1:05");
  expect(formatElapsed(-1000)).toBe("0:00");
  expect(formatElapsed(3601000)).toBe("60:01");
  const stalled = render({ stage: "preparing" }, 20000);
  expect(stalled).toContain("Elapsed 0:30");
  expect(stalled).toContain("No new progress report for 0:20");
  expect(render({ stage: "parsing", current: 5, total: 10 })).not.toContain("No new progress report");
});
