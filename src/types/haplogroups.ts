import type { GenomeAssembly } from "./annotations";

export type HaplogroupLineage = "Y" | "MT";
export type HaplogroupStatus = "predicted" | "insufficient" | "conflicting" | "unavailable";

export interface HaplogroupMarker {
  /** Human-readable marker name; coordinates and alleles use the forward strand. */
  id: string;
  rsid?: string;
  positions: Record<GenomeAssembly, number>;
  allele: string;
  /** Forward reference base, when verified separately from the diagnostic allele. */
  ref?: string;
  refs?: Record<GenomeAssembly, string>;
}

export interface HaplogroupRule {
  id: string;
  label: string;
  lineage: HaplogroupLineage;
  parent?: string;
  /** Every marker must be observed and agree; missing calls never imply reference bases. */
  markers: readonly HaplogroupMarker[];
}

export interface HaplogroupResult {
  lineage: HaplogroupLineage;
  status: HaplogroupStatus;
  haplogroup?: string;
  reason: string;
  /** Distinct panel positions with an unambiguous, verified single-base call. */
  observedMarkers: number;
  totalMarkers: number;
  supportingMarkers: Array<{ marker: string; genotype: string }>;
  issues: string[];
}

export interface HaplogroupAnalysis {
  panelVersion: string;
  results: HaplogroupResult[];
}
