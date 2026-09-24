import { HAPLOGROUP_PANEL_VERSION, HAPLOGROUP_RULES } from "../data/haplogroupMarkers";
import type {
  HaplogroupAnalysis,
  HaplogroupLineage,
  HaplogroupMarker,
  HaplogroupResult,
  HaplogroupRule,
} from "../types/haplogroups";
import type { UserGenotype } from "../types/snp";
import { normalizeAssembly, normalizeChromosome, normalizePosition, normalizeRsid } from "./variantIdentity";

const COMPLEMENT: Record<string, string> = { A: "T", C: "G", G: "C", T: "A" };
const ISSUE_TEXT = {
  metadata: "Some panel markers lack a supported genome build or declared allele strand.",
  mitochondrialReference:
    "The file declares an unsupported mitochondrial reference (such as UCSC hg19 chrM or RSRS); this panel uses rCRS.",
  coordinate: "Some marker identifiers disagree with their expected chromosome or position.",
  reference: "Some reference alleles disagree with the panel's reference sequence.",
  missing: "Some panel markers have missing or unsupported single-base calls.",
  mixed: "Mixed alleles were found at a lineage marker; this panel cannot resolve mixtures or heteroplasmy.",
  duplicate: "Repeated entries disagree at the same lineage marker.",
  alleles: "Some genotype and allele fields disagree.",
} as const;
type Issue = keyof typeof ISSUE_TEXT;

interface Locus {
  lineage: HaplogroupLineage;
  marker: HaplogroupMarker;
  rsids: Set<string>;
  bases: Set<string>;
  issues: Set<Issue>;
}

function readCall(call: UserGenotype, locus: Locus): void {
  const issues = new Set<Issue>();
  const assembly = normalizeAssembly(call.assembly);
  const knownStrand = call.strand === "plus" || call.strand === "minus";
  if (!assembly || !knownStrand) issues.add("metadata");
  if (locus.lineage === "MT" && call.mitochondrialReference === "unsupported") issues.add("mitochondrialReference");
  if (
    normalizeChromosome(call.chromosome) !== locus.lineage ||
    !normalizePosition(call.position) ||
    (assembly && normalizePosition(call.position) !== locus.marker.positions[assembly])
  )
    issues.add("coordinate");
  const rsid = normalizeRsid(call.rsid);
  if (rsid && locus.rsids.size > 0 && !locus.rsids.has(rsid)) issues.add("coordinate");

  const genotype = call.genotype.trim().toUpperCase();
  const bases = /^[ACGT]{1,2}$/.test(genotype)
    ? genotype.split("")
    : /^[ACGT][/|][ACGT]$/.test(genotype)
      ? genotype.split(/[/|]/)
      : undefined;
  if (!bases) issues.add("missing");
  else if (new Set(bases).size > 1) issues.add("mixed");
  if (
    call.alleles !== undefined &&
    (!bases ||
      call.alleles.length !== bases.length ||
      call.alleles
        .map((base) => base.toUpperCase())
        .sort()
        .join("/") !== [...bases].sort().join("/"))
  )
    issues.add("alleles");

  const orient = (base: string) => (call.strand === "minus" ? COMPLEMENT[base] : base);
  if (call.ref !== undefined) {
    const ref = call.ref.toUpperCase();
    const expectedRef = (assembly ? locus.marker.refs?.[assembly] : undefined) ?? locus.marker.ref;
    if (!/^[ACGT]$/.test(ref) || (knownStrand && expectedRef && orient(ref) !== expectedRef)) {
      issues.add("reference");
    }
  }
  if (call.alt !== undefined) {
    const alternatives = call.alt.toUpperCase().split(",");
    if (
      !bases ||
      alternatives.some((base) => !/^[ACGT]$/.test(base) || !bases.includes(base)) ||
      (call.ref !== undefined && bases.some((base) => base !== call.ref!.toUpperCase() && !alternatives.includes(base)))
    ) {
      issues.add("alleles");
    }
  }
  if (issues.size === 0 && bases) locus.bases.add(orient(bases[0]));
  if (locus.bases.size > 1) issues.add("duplicate");
  for (const issue of issues) locus.issues.add(issue);
}

const locusKey = (lineage: HaplogroupLineage, marker: HaplogroupMarker) => `${lineage}:${marker.positions.GRCh37}`;

/**
 * A bounded marker-panel estimate, not a full phylogenetic classifier. One pass
 * over imported calls; missing sites are never filled from the reference genome.
 * All bases, counters and issue sets retained here are bounded by the panel size.
 */
export function analyzeHaplogroups(genotypes: Iterable<UserGenotype>): HaplogroupAnalysis {
  const loci = new Map<string, Locus>();
  const byRsid = new Map<string, Locus>();
  const byPosition = new Map<string, Set<Locus>>();
  for (const rule of HAPLOGROUP_RULES) {
    for (const marker of rule.markers) {
      const key = locusKey(rule.lineage, marker);
      let locus = loci.get(key);
      if (!locus) {
        locus = { lineage: rule.lineage, marker, rsids: new Set(), bases: new Set(), issues: new Set() };
        loci.set(key, locus);
      }
      if (marker.rsid) {
        locus.rsids.add(marker.rsid);
        byRsid.set(marker.rsid, locus);
      }
      for (const position of Object.values(marker.positions)) {
        const positionKey = `${rule.lineage}:${position}`;
        const atPosition = byPosition.get(positionKey) ?? new Set<Locus>();
        atPosition.add(locus);
        byPosition.set(positionKey, atPosition);
      }
    }
  }
  const lineageCounts = { Y: 0, MT: 0 };
  for (const call of genotypes) {
    const chromosome = normalizeChromosome(call.chromosome);
    if (chromosome === "Y" || chromosome === "MT") lineageCounts[chromosome]++;
    const byId = byRsid.get(normalizeRsid(call.rsid) ?? "");
    const position = normalizePosition(call.position);
    const atPosition = byPosition.get(`${chromosome}:${position}`);
    if (!byId && !atPosition) continue;
    const candidates = new Set(atPosition);
    if (byId) candidates.add(byId);
    for (const locus of candidates) {
      const assembly = normalizeAssembly(call.assembly);
      // A coordinate from another build is only relevant if the rsID also identifies it.
      if (assembly && position !== locus.marker.positions[assembly] && locus !== byId) continue;
      readCall(call, locus);
    }
  }

  const rulesById = new Map(HAPLOGROUP_RULES.map((rule) => [rule.id, rule]));
  const ancestors = (rule: HaplogroupRule): HaplogroupRule[] => {
    const result: HaplogroupRule[] = [];
    let parent = rule.parent ? rulesById.get(rule.parent) : undefined;
    while (parent && !result.includes(parent)) {
      result.push(parent);
      parent = parent.parent ? rulesById.get(parent.parent) : undefined;
    }
    return result;
  };
  const observed = (lineage: HaplogroupLineage, marker: HaplogroupMarker): string | undefined => {
    const locus = loci.get(locusKey(lineage, marker))!;
    return locus.issues.size === 0 && locus.bases.size === 1 ? [...locus.bases][0] : undefined;
  };
  const results = (["Y", "MT"] as const).map((lineage): HaplogroupResult => {
    const lineageLoci = [...loci.values()].filter((locus) => locus.lineage === lineage);
    const issues = new Set(lineageLoci.flatMap((locus) => [...locus.issues]));
    const base: HaplogroupResult = {
      lineage,
      status: "insufficient",
      reason:
        "Not enough verified markers to estimate a supported haplogroup. Missing sites are not treated as reference calls.",
      observedMarkers: lineageLoci.filter((locus) => locus.issues.size === 0 && locus.bases.size === 1).length,
      totalMarkers: lineageLoci.length,
      supportingMarkers: [],
      issues: [...issues].map((issue) => ISSUE_TEXT[issue]),
    };
    if (lineageCounts[lineage] === 0 && issues.size === 0) {
      return {
        ...base,
        status: "unavailable",
        reason:
          lineage === "Y"
            ? "No Y-chromosome calls were found in this file. A paternal haplogroup cannot be estimated."
            : "No mitochondrial calls were found in this file. A maternal haplogroup cannot be estimated.",
      };
    }
    if (["coordinate", "reference", "mixed", "duplicate", "alleles"].some((issue) => issues.has(issue as Issue))) {
      return {
        ...base,
        status: "conflicting",
        reason: "The lineage markers contain conflicting or mixed calls, so no haplogroup was selected.",
      };
    }
    const candidates = HAPLOGROUP_RULES.filter(
      (rule) => rule.lineage === lineage && rule.markers.every((marker) => observed(lineage, marker) === marker.allele),
    );
    const contradicted = candidates.some((rule) =>
      ancestors(rule).some((parent) =>
        parent.markers.some((marker) => {
          const value = observed(lineage, marker);
          return value !== undefined && value !== marker.allele;
        }),
      ),
    );
    const mostSpecific = candidates.filter((rule) => !candidates.some((other) => ancestors(other).includes(rule)));
    if (contradicted || mostSpecific.length > 1) {
      return {
        ...base,
        status: "conflicting",
        reason: "Markers support incompatible branches of the panel, so no haplogroup was selected.",
      };
    }
    const selected = mostSpecific[0];
    if (!selected) return base;
    const supportingMarkers = new Map<string, { marker: string; genotype: string }>();
    for (const rule of [...ancestors(selected).reverse(), selected]) {
      for (const marker of rule.markers) {
        if (observed(lineage, marker) === marker.allele) {
          supportingMarkers.set(locusKey(lineage, marker), { marker: marker.id, genotype: marker.allele });
        }
      }
    }
    return {
      ...base,
      status: "predicted",
      haplogroup: selected.label,
      supportingMarkers: [...supportingMarkers.values()],
      reason:
        "All required markers for this branch agree. This is a limited-panel estimate; untested branches and finer subclades remain unresolved.",
    };
  });
  return { panelVersion: HAPLOGROUP_PANEL_VERSION, results };
}
