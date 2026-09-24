import { HAPLOGROUP_SOURCES } from "../data/haplogroupMarkers";
import type { HaplogroupAnalysis } from "../types/haplogroups";
import { buildCsv } from "./csvExport";

export const HAPLOGROUP_LIMITATIONS = [
  "These estimates cover only the broad branches supported by this marker panel; more specific lineages may be missing.",
  "Y-DNA and mtDNA trace your direct paternal and maternal lines, not your full ancestry.",
  "Sparse DNA-chip coverage can be inconclusive. Missing markers do not establish a haplogroup.",
];

export function buildHaplogroupCsv(analysis: HaplogroupAnalysis): string {
  return buildCsv(analysis.results, [
    { header: "Lineage", value: (result) => (result.lineage === "Y" ? "Y-DNA" : "mtDNA") },
    { header: "Status", value: (result) => result.status },
    { header: "Haplogroup", value: (result) => result.haplogroup },
    { header: "Explanation", value: (result) => result.reason },
    { header: "Observed panel markers", value: (result) => result.observedMarkers },
    { header: "Total panel markers", value: (result) => result.totalMarkers },
    {
      header: "Supporting markers",
      value: (result) => result.supportingMarkers.map(({ marker, genotype }) => `${marker}: ${genotype}`).join("; "),
    },
    { header: "Issues", value: (result) => result.issues.join("; ") },
    { header: "Limitations", value: () => HAPLOGROUP_LIMITATIONS.join("; ") },
    { header: "Sources", value: () => HAPLOGROUP_SOURCES.map((source) => source.url).join("; ") },
    { header: "Panel version", value: () => analysis.panelVersion },
  ]);
}
