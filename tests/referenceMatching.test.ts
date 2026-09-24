import { expect, test } from "bun:test";
import type { AnnotationMatchSummary } from "../src/types/annotations";
import type { MatchedSNP } from "../src/types/snp";
import { mergeReferenceMatches } from "../src/workers/referenceMatching";

function match(): MatchedSNP {
  return {
    rsid: "rs123",
    genotype: "AG",
    assembly: "GRCh37",
    chromosome: "1",
    position: "100",
    strand: "plus",
    snpData: { rsid: "rs123", content: "{{Rsnum|summary=General context|magnitude=1|gene=GENE}}" },
    genotypeData: {
      id: "rs123(A;G)",
      snp_id: "rs123",
      genotype: "ag",
      content: "{{Genotype|magnitude=4|summary=Personal claim}}",
    },
    parsedData: {
      rsid: "rs123",
      rawContent: "",
      summary: "Personal claim",
      genotypeContent: "Personal claim",
      magnitude: 4,
      repute: "Bad",
    },
  };
}

const summary = (ambiguous: boolean): AnnotationMatchSummary => ({
  sources: ["clinvar"],
  count: 1,
  alleleCount: 0,
  unresolvedCount: 1,
  genes: [],
  ambiguous,
});

test("SNPedia upload conflicts survive empty, uncovered and nonambiguous reference summary merges", () => {
  const source = { ...match(), ambiguous: true };
  for (const summaries of [
    new Map<string, AnnotationMatchSummary>(),
    new Map([["rs999", summary(false)]]),
    new Map([["rs123", summary(false)]]),
  ]) {
    const [merged] = mergeReferenceMatches([source], [source], summaries);
    expect(merged.ambiguous).toBe(true);
    expect(merged.genotype).toBe("AG");
    expect(merged.genotypeData).toBeUndefined();
    expect(merged.parsedData.summary).toBe("General context");
  }
  expect(source.genotypeData).toBeDefined();
  expect(source.parsedData.summary).toBe("Personal claim");
});

test("reference alias conflicts remove all genotype-specific fields before genoset matching", () => {
  const source = match();
  const [merged] = mergeReferenceMatches([source], [source], new Map([["rs123", summary(true)]]));
  expect(merged.ambiguous).toBe(true);
  expect(merged.genotypeData).toBeUndefined();
  expect(merged.parsedData).toMatchObject({
    summary: "General context",
    magnitude: 1,
    geneSymbol: "GENE",
  });
  expect(merged.parsedData.genotypeContent).toBeUndefined();
  expect(merged.parsedData.repute).toBeUndefined();
  expect(source.genotypeData).toBeDefined();
});

test("reference-only conflicts retain distinct calls and deduplicate only identical uploaded calls", () => {
  const first = match();
  const users = ["AG", "GG", "AG", "GG"].map((genotype) => ({
    rsid: first.rsid,
    genotype,
    assembly: first.assembly,
    chromosome: first.chromosome,
    position: first.position,
    strand: first.strand,
  }));
  for (const snpedia of [[], [first]]) {
    const merged = mergeReferenceMatches(users, snpedia, new Map([["rs123", summary(true)]]));
    expect(merged.map((row) => row.genotype)).toEqual(["AG", "GG"]);
    expect(merged.every((row) => row.ambiguous && !row.genotypeData)).toBe(true);
  }
});
