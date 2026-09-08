import type { MatchedSNP, UserGenotype } from "../types/snp";

/** Keep every declared call dimension; an rsID alone cannot identify a result. */
export function userCallIdentity(user: UserGenotype): string {
  return JSON.stringify([
    user.rsid.toLowerCase(),
    user.chromosome,
    user.position,
    user.genotype.toLowerCase(),
    user.assembly ?? null,
    user.ref ?? null,
    user.alt ?? null,
    user.strand ?? null,
    user.phased ?? null,
  ]);
}

export function createMatchRows(matches: MatchedSNP[]): { key: string; match: MatchedSNP }[] {
  const occurrences = new Map<string, number>();
  return matches.map((match) => {
    const identity = JSON.stringify([
      userCallIdentity(match),
      match.genotypeData?.id ?? null,
      match.snpData.referenceSource ?? null,
      match.snpData.referenceKey ?? null,
    ]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    // A source can supply different evidence under the same record ID. Assign
    // the suffix before filtering/sorting so either row stays selectable.
    return { key: `${identity}:${occurrence}`, match };
  });
}

export function countMatchVariants(
  matches: MatchedSNP[],
  include: (match: MatchedSNP) => boolean = () => true,
): number {
  const ids = new Set<string>();
  for (const match of matches) {
    if (include(match)) ids.add(match.rsid.toLowerCase());
  }
  return ids.size;
}
