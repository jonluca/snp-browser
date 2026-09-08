import type { GenomeAssembly } from "./annotations";

export type TraitStatus = "matched" | "missing" | "conflicting" | "unresolved";
export type TraitCategory = "Appearance" | "Taste" | "Metabolism";

export interface TraitCitation {
  title: string;
  url: string;
  year: number;
}

export interface TraitEvidence {
  /** Describes the research, never an individual probability. */
  label: string;
  summary: string;
  population: string;
  citations: TraitCitation[];
}

export interface TraitPrediction {
  label: string;
  description: string;
  /** An absent marker does not establish absence of the trait. */
  markerEffect: "present" | "absent" | "mixed";
}

export interface TraitRule {
  id: string;
  title: string;
  category: TraitCategory;
  rsid: string;
  gene: string;
  chromosome: string;
  positions: Record<GenomeAssembly, number>;
  /** All coordinates, bases, and genotype keys use the forward genome strand. */
  ref: string;
  alleles: readonly string[];
  outcomes: Record<string, TraitPrediction>;
  evidence: TraitEvidence;
  limitations: string[];
  mappingUrl: string;
  mappingNote: string;
}

export type TraitIssue =
  | "unknown-strand"
  | "unknown-build"
  | "missing-coordinate"
  | "coordinate-conflict"
  | "reference-conflict"
  | "allele-conflict"
  | "unsupported-call"
  | "no-call"
  | "unexpected-allele"
  | "discordant-calls";

export interface TraitResult {
  id: string;
  title: string;
  category: TraitCategory;
  rsid: string;
  gene: string;
  status: TraitStatus;
  /** Sorted, diploid, forward-strand genotype; present only for a resolved call. */
  genotype?: string;
  prediction?: TraitPrediction;
  reason: string;
  callCount: number;
  issues: TraitIssue[];
  evidence: TraitEvidence;
  limitations: string[];
  mappingUrl: string;
  mappingNote: string;
}

export interface TraitAnalysis {
  rulesVersion: string;
  reviewedAt: string;
  analyzedCallCount: number;
  candidateCallCount: number;
  summary: Record<TraitStatus, number> & { total: number };
  results: TraitResult[];
}
