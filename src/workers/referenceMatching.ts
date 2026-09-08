import type { AnnotationMatchSummary } from "../types/annotations";
import type { MatchedSNP, UserGenotype } from "../types/snp";

export function mergeReferenceMatches(
  users: UserGenotype[],
  snpediaMatches: MatchedSNP[],
  summaries: Map<string, AnnotationMatchSummary>,
): MatchedSNP[] {
  const result = snpediaMatches.map((match) => ({
    ...match,
    annotationSummary: summaries.get(match.rsid.toLowerCase()),
  }));
  const existing = new Set(result.map((match) => match.rsid.toLowerCase()));
  for (const user of users) {
    const id = user.rsid.toLowerCase();
    const annotationSummary = summaries.get(id);
    if (!annotationSummary || existing.has(id)) continue;
    existing.add(id);
    result.push({
      ...user,
      annotationSummary,
      snpData: {
        rsid: user.rsid,
        content: "",
        referenceSource: "references",
        chromosome: user.chromosome,
        position: user.position,
        gene: annotationSummary.genes.join(", "),
      },
      parsedData: {
        rsid: user.rsid,
        rawContent: "",
        geneSymbol: annotationSummary.genes.join(", "),
        summary: `${annotationSummary.count.toLocaleString()} reference annotations from ${annotationSummary.sources.length} ${annotationSummary.sources.length === 1 ? "source" : "sources"}.`,
      },
    });
  }
  return result;
}
