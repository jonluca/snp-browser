import { TRAIT_RULES, TRAIT_RULES_REVIEWED_AT, TRAIT_RULES_VERSION } from "../data/traitRules";
import type { UserGenotype } from "../types/snp";
import type { TraitAnalysis, TraitIssue, TraitResult, TraitRule, TraitStatus } from "../types/traits";
import { normalizeAssembly, normalizeChromosome, normalizePosition, normalizeRsid } from "./variantIdentity";

const COMPLEMENT: Record<string, string> = { A: "T", C: "G", G: "C", T: "A" };
const RULES_BY_RSID = new Map(TRAIT_RULES.map((rule) => [rule.rsid, rule]));
const RULES_BY_POSITION = new Map<string, TraitRule[]>();
for (const rule of TRAIT_RULES) {
  for (const position of new Set(Object.values(rule.positions))) {
    const key = String(position);
    RULES_BY_POSITION.set(key, [...(RULES_BY_POSITION.get(key) ?? []), rule]);
  }
}

interface Accumulator {
  count: number;
  genotypes: Set<string>;
  issues: Set<TraitIssue>;
}

const CONFLICTS = new Set<TraitIssue>([
  "coordinate-conflict",
  "reference-conflict",
  "allele-conflict",
  "discordant-calls",
]);

const ISSUE_REASONS: Record<TraitIssue, string> = {
  "unknown-strand": "The file does not declare a supported allele strand.",
  "unknown-build": "A declared GRCh37 or GRCh38 genome build is needed to verify this marker.",
  "missing-coordinate": "An exact chromosome and position are needed to verify this marker.",
  "coordinate-conflict": "The supplied chromosome or position disagrees with this marker on the declared build.",
  "reference-conflict": "The supplied reference allele disagrees with the forward reference genome.",
  "allele-conflict": "The supplied allele fields disagree with the genotype.",
  "unsupported-call": "A complete diploid, single-base genotype is needed for this rule.",
  "no-call": "This marker is present, but at least one entry does not contain a complete genotype call.",
  "unexpected-allele": "A called allele is outside the alleles covered by this trait's evidence.",
  "discordant-calls": "Repeated entries contain different verified genotypes; no entry was selected over another.",
};

function collectCall(rule: TraitRule, call: UserGenotype, accumulator: Accumulator): void {
  accumulator.count++;
  const issues = new Set<TraitIssue>();
  const assembly = normalizeAssembly(call.assembly);
  const chromosome = normalizeChromosome(call.chromosome);
  const position = normalizePosition(call.position);
  if (!assembly) issues.add("unknown-build");
  if (!chromosome || !position) issues.add("missing-coordinate");
  if (
    (chromosome && chromosome !== rule.chromosome) ||
    (assembly && position && position !== rule.positions[assembly])
  ) {
    issues.add("coordinate-conflict");
  }
  const knownStrand = call.strand === "plus" || call.strand === "minus";
  if (!knownStrand) issues.add("unknown-strand");
  const orient = (base: string): string => (call.strand === "minus" ? COMPLEMENT[base] : base);

  const genotype = call.genotype.trim().toUpperCase();
  const bases = /^[ACGT]{2}$/.test(genotype)
    ? genotype.split("")
    : /^[ACGT][/|][ACGT]$/.test(genotype)
      ? genotype.split(/[/|]/)
      : undefined;
  if (!bases) {
    issues.add(!genotype || /[.\-?N0]/.test(genotype) ? "no-call" : "unsupported-call");
  }
  if (call.alleles !== undefined) {
    if (call.alleles.length !== 2 || call.alleles.some((allele) => !/^[ACGT]$/i.test(allele))) {
      issues.add("unsupported-call");
    } else if (
      !bases ||
      call.alleles
        .map((allele) => allele.toUpperCase())
        .sort()
        .join("") !== [...bases].sort().join("")
    ) {
      issues.add("allele-conflict");
    }
  }
  if (call.ref !== undefined) {
    const ref = call.ref.toUpperCase();
    if (!/^[ACGT]$/.test(ref) || (knownStrand && orient(ref) !== rule.ref)) {
      issues.add("reference-conflict");
    }
  }
  if (call.alt !== undefined) {
    const alternatives = call.alt.toUpperCase().split(",");
    // UserGenotype.alt contains called non-reference alleles (not every VCF ALT).
    if (
      !bases ||
      alternatives.some((allele) => !/^[ACGT]$/.test(allele) || !bases.includes(allele)) ||
      (call.ref !== undefined && bases.some((base) => base !== call.ref?.toUpperCase() && !alternatives.includes(base)))
    ) {
      issues.add("allele-conflict");
    }
  }
  const oriented = knownStrand ? bases?.map(orient).sort().join("") : undefined;
  if (oriented && [...oriented].some((base) => !rule.alleles.includes(base))) issues.add("unexpected-allele");
  // Record only fully validated calls. The set is bounded to the rule's three
  // possible diploid genotypes, and unresolved duplicates still block output.
  if (issues.size === 0 && oriented) accumulator.genotypes.add(oriented);
  for (const issue of issues) accumulator.issues.add(issue);
  if (accumulator.genotypes.size > 1) accumulator.issues.add("discordant-calls");
}

function makeResult(rule: TraitRule, accumulator: Accumulator): TraitResult {
  const issues = [...accumulator.issues].sort();
  const status: TraitStatus =
    accumulator.count === 0
      ? "missing"
      : issues.some((issue) => CONFLICTS.has(issue))
        ? "conflicting"
        : issues.length > 0 || accumulator.genotypes.size !== 1
          ? "unresolved"
          : "matched";
  const genotype = status === "matched" ? [...accumulator.genotypes][0] : undefined;
  return {
    id: rule.id,
    title: rule.title,
    category: rule.category,
    rsid: rule.rsid,
    gene: rule.gene,
    status,
    ...(genotype ? { genotype, prediction: rule.outcomes[genotype] } : {}),
    reason:
      status === "missing"
        ? "This marker was not present in the imported calls. Missing data does not mean the associated trait is absent."
        : status === "matched"
          ? "Genotype verified against the rule's build, exact locus, and strand; any supplied reference allele also agrees."
          : issues.map((issue) => ISSUE_REASONS[issue]).join(" "),
    callCount: accumulator.count,
    issues,
    evidence: rule.evidence,
    limitations: rule.limitations,
    mappingUrl: rule.mappingUrl,
    mappingNote: rule.mappingNote,
  };
}

/**
 * One scan over all imported calls, independently of annotation-pack matches.
 * Keeps counters, bounded issue sets, and at most three genotypes per rule;
 * never copies the input or builds a genome-wide index. Makes no network calls.
 */
export function analyzeTraits(genotypes: Iterable<UserGenotype>): TraitAnalysis {
  const accumulators = new Map<string, Accumulator>(
    TRAIT_RULES.map((rule) => [
      rule.id,
      {
        count: 0,
        genotypes: new Set<string>(),
        issues: new Set<TraitIssue>(),
      },
    ]),
  );
  let analyzedCallCount = 0;
  let candidateCallCount = 0;
  for (const call of genotypes) {
    analyzedCallCount++;
    const direct = RULES_BY_RSID.get(call.rsid);
    const rsid = direct ? direct.rsid : normalizeRsid(call.rsid);
    const byId = direct ?? (rsid ? RULES_BY_RSID.get(rsid) : undefined);
    if (byId) {
      collectCall(byId, call, accumulators.get(byId.id)!);
      candidateCallCount++;
      continue;
    }
    // A different explicit rsID cannot be silently reidentified. An ID-less
    // VCF call can be identified by a supported assembly and exact coordinates.
    if (rsid) continue;
    const atPosition = RULES_BY_POSITION.get(call.position);
    if (!atPosition) continue;
    const assembly = normalizeAssembly(call.assembly);
    const chromosome = normalizeChromosome(call.chromosome);
    if (!assembly) continue;
    for (const rule of atPosition) {
      if (rule.chromosome !== chromosome || rule.positions[assembly] !== Number(call.position)) continue;
      collectCall(rule, call, accumulators.get(rule.id)!);
      candidateCallCount++;
    }
  }
  const results = TRAIT_RULES.map((rule) => makeResult(rule, accumulators.get(rule.id)!));
  const summary: TraitAnalysis["summary"] = {
    total: results.length,
    matched: 0,
    missing: 0,
    conflicting: 0,
    unresolved: 0,
  };
  for (const result of results) summary[result.status]++;
  return {
    rulesVersion: TRAIT_RULES_VERSION,
    reviewedAt: TRAIT_RULES_REVIEWED_AT,
    analyzedCallCount,
    candidateCallCount,
    summary,
    results,
  };
}
