import type { AnnotationMatchSummary } from "../types/annotations";
import type { MatchedSNP, UserGenotype } from "../types/snp";
import { extractSnpediaFields } from "../utils/snpediaFields";
import { userCallIdentity } from "../utils/matchIdentity";

function mergeSummary(match: MatchedSNP, annotationSummary?: AnnotationMatchSummary): MatchedSNP {
  if (!match.ambiguous && !annotationSummary?.ambiguous) return { ...match, annotationSummary };
  // Reference alias resolution can reveal a conflict after SNPedia matching.
  // Keep the uploaded call and variant article, but remove personal genotype
  // evidence so downstream genoset matching cannot use an ambiguous call.
  const fields = extractSnpediaFields(match.snpData.content, match.snpData);
  return {
    ...match,
    ambiguous: true,
    annotationSummary,
    genotypeData: undefined,
    parsedData: {
      ...match.parsedData,
      geneSymbol: fields.geneSymbol,
      summary: fields.summary,
      magnitude: fields.magnitude,
      repute: fields.repute,
      genotypeContent: undefined,
    },
  };
}

export function mergeReferenceMatches(
  users: UserGenotype[],
  snpediaMatches: MatchedSNP[],
  summaries: Map<string, AnnotationMatchSummary>,
): MatchedSNP[] {
  const result = snpediaMatches.map((match) => mergeSummary(match, summaries.get(match.rsid.toLowerCase())));
  const existing = new Set(result.map(userCallIdentity));
  for (const user of users) {
    const id = user.rsid.toLowerCase();
    const identity = userCallIdentity(user);
    const annotationSummary = summaries.get(id);
    if (!annotationSummary || existing.has(identity)) continue;
    existing.add(identity);
    result.push({
      ...user,
      ...(annotationSummary.ambiguous ? { ambiguous: true } : {}),
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
