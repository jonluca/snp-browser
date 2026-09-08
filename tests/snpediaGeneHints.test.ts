import { describe, expect, test } from "bun:test";
import type { MatchedSNP, UserGenotype } from "../src/types/snp";
import { buildSnpediaGeneHints } from "../src/workers/snpediaGeneHints";

const user: UserGenotype = { rsid: "rs100", chromosome: "1", position: "100", genotype: "AG" };
function matched(overrides: Partial<MatchedSNP> = {}): MatchedSNP {
  return {
    ...user,
    snpData: { rsid: "rs100", content: "Public SNPedia article" },
    parsedData: { rsid: "rs100", rawContent: "Public SNPedia article" },
    ...overrides,
  };
}

describe("SNPedia gene hints", () => {
  test("combines only explicit parsed and column gene fields with normalized whole symbols", () => {
    const input = matched({
      snpData: {
        rsid: "RS100",
        content: "narrative mentions BRCA1",
        gene: "hla-b",
        gene_s: "apoe | TOMM40",
        clin_gene_name: "IGL@",
      },
      parsedData: {
        rsid: "rs100",
        rawContent: "narrative mentions CFTR",
        geneSymbol: "APOE; HLA-B - MCM6",
        summary: "Narrative mentions TP53",
      },
    });
    expect(buildSnpediaGeneHints([input]).get("rs100")).toEqual(["APOE", "HLA-B", "MCM6", "TOMM40", "IGL@"]);
  });

  test("does not recycle genes from merged annotation summaries or reference-only matches", () => {
    const input = matched({
      snpData: { rsid: "rs100", content: "", referenceSource: "references", gene: "APOE" },
      parsedData: { rsid: "rs100", rawContent: "", geneSymbol: "APOE" },
      annotationSummary: { sources: ["clingen"], count: 1, alleleCount: 0, unresolvedCount: 0, genes: ["APOE"] },
    });
    expect(buildSnpediaGeneHints([input]).size).toBe(0);
    expect(buildSnpediaGeneHints([matched({ annotationSummary: input.annotationSummary })]).size).toBe(0);
  });

  test("requires exact normalized rsID agreement between the uploaded call and source article", () => {
    const source = { rsid: "rs101", content: "public", gene: "APOE" };
    expect(buildSnpediaGeneHints([matched({ snpData: source })]).size).toBe(0);
    expect(
      buildSnpediaGeneHints([matched({ rsid: "provider100", snpData: { ...source, rsid: "provider100" } })]).size,
    ).toBe(0);
    expect(
      buildSnpediaGeneHints([matched({ rsid: "RS0100", snpData: { ...source, rsid: "rs100" } })]).get("rs100"),
    ).toEqual(["APOE"]);
  });

  test("plain raw calls and narrative text do not produce gene hints", () => {
    expect(buildSnpediaGeneHints([user]).size).toBe(0);
    const input = matched({
      snpData: { rsid: "rs100", content: "APOE is mentioned here", clin_sig: "Pathogenic", clin_disease: "APOE" },
      parsedData: {
        rsid: "rs100",
        rawContent: "APOE",
        summary: "APOE",
        geneSymbol: "not a symbol, <APOE>, GENE/OTHER",
      },
    });
    expect(buildSnpediaGeneHints([input]).size).toBe(0);
  });

  test("duplicate SNPedia rows combine context without duplicating genes or changing input records", () => {
    const first = Object.freeze(matched({ parsedData: { rsid: "rs100", rawContent: "", geneSymbol: "APOE" } }));
    const second = Object.freeze(matched({ snpData: { rsid: "rs100", content: "", gene: "apoe;TOMM40" } }));
    expect(buildSnpediaGeneHints([first, second]).get("rs100")).toEqual(["APOE", "TOMM40"]);
    expect(first.parsedData.geneSymbol).toBe("APOE");
    expect(second.snpData.gene).toBe("apoe;TOMM40");
  });
});
