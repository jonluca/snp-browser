import { expect, test } from "bun:test";
import { HAPLOGROUP_SOURCES } from "../src/data/haplogroupMarkers";
import type { HaplogroupAnalysis } from "../src/types/haplogroups";
import { buildHaplogroupCsv, HAPLOGROUP_LIMITATIONS } from "../src/utils/haplogroupExport";

test("haplogroup export includes both lineages with coverage and reproducible evidence", () => {
  const analysis: HaplogroupAnalysis = {
    panelVersion: "test-panel-1",
    results: [
      {
        lineage: "Y",
        status: "predicted",
        haplogroup: "R1b",
        reason: "Supported by observed panel markers.",
        observedMarkers: 3,
        totalMarkers: 12,
        supportingMarkers: [{ marker: "M343", genotype: "A" }],
        issues: ["Some panel markers are missing."],
      },
      {
        lineage: "MT",
        status: "unavailable",
        reason: "No mitochondrial calls in this file.",
        observedMarkers: 0,
        totalMarkers: 10,
        supportingMarkers: [],
        issues: [],
      },
    ],
  };

  const lines = buildHaplogroupCsv(analysis).split("\r\n");

  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(
    "Lineage,Status,Haplogroup,Explanation,Observed panel markers,Total panel markers,Supporting markers,Issues,Limitations,Sources,Panel version",
  );
  expect(lines[1]).toStartWith(
    "Y-DNA,predicted,R1b,Supported by observed panel markers.,3,12,M343: A,Some panel markers are missing.,",
  );
  expect(lines[2]).toStartWith("mtDNA,unavailable,,No mitochondrial calls in this file.,0,10,,,");
  for (const row of lines.slice(1)) {
    for (const limitation of HAPLOGROUP_LIMITATIONS) expect(row).toContain(limitation);
    for (const source of HAPLOGROUP_SOURCES) expect(row).toContain(source.url);
    expect(row).toEndWith(",test-panel-1");
  }
});

test("haplogroup export retains inconclusive explanations and conflicting supporting evidence", () => {
  const csv = buildHaplogroupCsv({
    panelVersion: "test-panel-2",
    results: [
      {
        lineage: "Y",
        status: "insufficient",
        reason: "Markers were observed but no supported branch could be assigned.",
        observedMarkers: 2,
        totalMarkers: 12,
        supportingMarkers: [],
        issues: [],
      },
      {
        lineage: "MT",
        status: "conflicting",
        reason: "Markers support incompatible branches.",
        observedMarkers: 4,
        totalMarkers: 10,
        supportingMarkers: [
          { marker: "m.1", genotype: "A" },
          { marker: "m.2", genotype: "G" },
        ],
        issues: ['Incompatible calls: "A" and "G".'],
      },
    ],
  });

  expect(csv).toContain("Y-DNA,insufficient,,Markers were observed but no supported branch could be assigned.,2,12,,,");
  expect(csv).toContain("mtDNA,conflicting,,Markers support incompatible branches.,4,10,m.1: A; m.2: G,");
  expect(csv).toContain('"Incompatible calls: ""A"" and ""G""."');
});
