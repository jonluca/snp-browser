import type { AnnotationEvidence, GenomeAssembly, VariantAnnotation } from "../types/annotations";
import type { UserGenotype } from "../types/snp";

export function normalizeRsid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^rs0*([1-9]\d*)$/i.exec(value.trim());
  return match ? `rs${match[1]}` : undefined;
}

export function normalizeChromosome(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const chromosome = String(value).trim().replace(/^chr/i, "").toUpperCase();
  if (chromosome === "M" || chromosome === "MT") return "MT";
  if (chromosome === "X" || chromosome === "Y") return chromosome;
  if (/^\d+$/.test(chromosome) && Number(chromosome) >= 1 && Number(chromosome) <= 22) {
    return String(Number(chromosome));
  }
  return undefined;
}

export function normalizeAssembly(value: unknown): GenomeAssembly | undefined {
  if (typeof value !== "string") return undefined;
  const assembly = value
    .trim()
    .replace(/[\s:_-]/g, "")
    .toLowerCase();
  if (/^(?:grch37(?:\.p\d+)?|hg19|b37|(?:ncbi)?build37|ncbi37)$/.test(assembly)) return "GRCh37";
  if (/^(?:grch38(?:\.p\d+)?|hg38|b38|(?:ncbi)?build38|ncbi38)$/.test(assembly)) return "GRCh38";
  return undefined;
}

export function normalizePosition(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value.trim()))) return undefined;
  const position = Number(value);
  return Number.isSafeInteger(position) && position > 0 ? position : undefined;
}

type AnnotationMatch = Pick<AnnotationEvidence, "matchType" | "matchReason">;
const COMPLEMENTS: Record<string, string> = { A: "T", C: "G", G: "C", T: "A" };

function unresolved(matchReason: string): AnnotationMatch {
  return { matchType: "unresolved", matchReason };
}

/**
 * Allele evidence is only confirmed on the same build and exact locus, with a
 * known strand. An rsID retrieves reference context but cannot establish that
 * a person's called allele has a clinical classification. Annotation alleles
 * must use the forward reference orientation.
 */
export function matchVariantAnnotation(user: UserGenotype, annotation: VariantAnnotation): AnnotationMatch {
  if (annotation.scope === "gene") return unresolved("Gene-level evidence does not identify a called allele.");

  const userRsid = normalizeRsid(user.rsid);
  const sameRsid = Boolean(
    userRsid && [annotation.rsid, ...(annotation.aliases ?? [])].some((value) => normalizeRsid(value) === userRsid),
  );
  const userAssembly = normalizeAssembly(user.assembly);
  const annotationAssembly = normalizeAssembly(annotation.assembly);
  const userChromosome = normalizeChromosome(user.chromosome);
  const annotationChromosome = normalizeChromosome(annotation.chromosome);
  const userPosition = normalizePosition(user.position);
  const annotationPosition = normalizePosition(annotation.position);

  if (userAssembly && annotationAssembly && userAssembly !== annotationAssembly) {
    return unresolved(
      "The uploaded file and reference use different genome builds; no coordinate conversion was applied.",
    );
  }
  if (
    userAssembly &&
    userAssembly === annotationAssembly &&
    ((userChromosome && annotationChromosome && userChromosome !== annotationChromosome) ||
      (userPosition && annotationPosition && userPosition !== annotationPosition))
  ) {
    return unresolved("The reference coordinates do not match the uploaded variant.");
  }

  const sameLocus = Boolean(
    userAssembly &&
    userAssembly === annotationAssembly &&
    userChromosome &&
    userChromosome === annotationChromosome &&
    userPosition &&
    userPosition === annotationPosition,
  );
  if (!sameRsid && !sameLocus) return unresolved("No matching variant identifier or confirmed genomic location.");
  if (annotation.scope === "variant") {
    return {
      matchType: "locus",
      matchReason: "Reference information for this variant; not a called-allele interpretation.",
    };
  }
  if (!userAssembly || !annotationAssembly) {
    return unresolved("A known genome build is required to confirm this allele.");
  }
  if (!sameLocus) return unresolved("Exact chromosome and position are required to confirm this allele.");
  if (user.strand !== "plus" && user.strand !== "minus") {
    return unresolved("The uploaded file does not declare its allele strand.");
  }

  const genotype = user.genotype.toUpperCase();
  if (!/^[ACGT]{1,2}$/.test(genotype))
    return unresolved("The uploaded genotype is missing or is not a supported SNP call.");
  const allele = annotation.alt?.toUpperCase();
  if (!allele || !/^[ACGT]$/.test(allele)) {
    return unresolved("The reference does not specify a single supported alternate allele.");
  }
  const orient = (base: string) => (user.strand === "minus" ? COMPLEMENTS[base] : base);
  if (user.ref && annotation.ref) {
    const userRef = user.ref.toUpperCase();
    const annotationRef = annotation.ref.toUpperCase();
    if (!/^[ACGT]$/.test(userRef) || !/^[ACGT]$/.test(annotationRef) || orient(userRef) !== annotationRef) {
      return unresolved("The reference allele does not agree with the uploaded variant.");
    }
  }
  if (!genotype.split("").map(orient).includes(allele)) {
    return {
      matchType: "locus",
      matchReason: `The annotated ${allele} allele is not present in the uploaded genotype.`,
    };
  }
  return { matchType: "allele", matchReason: "Called allele confirmed using genome build, coordinates, and strand." };
}
