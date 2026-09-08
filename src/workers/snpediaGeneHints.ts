import type { MatchedSNP, UserGenotype } from "../types/snp";
import { normalizeRsid } from "../utils/variantIdentity";

/**
 * Gene context from explicit SNPedia fields on exact-rsID matches. Never mine
 * narrative text or recycle genes from an already merged reference summary.
 * The same extraction is used for whole-file summaries and opened details.
 */
export function buildSnpediaGeneHints(matches: readonly (UserGenotype | MatchedSNP)[]): Map<string, string[]> {
  const hints = new Map<string, string[]>();
  for (const match of matches) {
    if (!("snpData" in match) || !("parsedData" in match)) continue;
    if (match.snpData.referenceSource && match.snpData.referenceSource !== "snpedia") continue;
    const rsid = normalizeRsid(match.rsid);
    if (!rsid || normalizeRsid(match.snpData.rsid) !== rsid) continue;
    const genes = new Set(hints.get(rsid));
    for (const value of [
      match.parsedData.geneSymbol,
      match.snpData.gene,
      match.snpData.gene_s,
      match.snpData.clin_gene_name,
    ]) {
      if (typeof value !== "string") continue;
      for (const token of value.split(/[,;|]|\s+-\s+/)) {
        const gene = token.trim().toUpperCase();
        if (/^[A-Z][A-Z0-9.-]*@?$/.test(gene)) genes.add(gene);
      }
    }
    if (genes.size) hints.set(rsid, [...genes]);
  }
  return hints;
}
