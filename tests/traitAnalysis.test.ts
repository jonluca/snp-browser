import { describe, expect, test } from "bun:test";
import { TRAIT_RULES, TRAIT_RULES_VERSION } from "../src/data/traitRules";
import type { UserGenotype } from "../src/types/snp";
import { analyzeTraits } from "../src/utils/traitAnalysis";

function lactase(genotype: string, overrides: Partial<UserGenotype> = {}): UserGenotype {
  return {
    rsid: "rs4988235",
    chromosome: "2",
    position: "136608646",
    assembly: "GRCh37",
    strand: "plus",
    genotype,
    ...overrides,
  };
}

const result = (calls: UserGenotype[], id = "lactase-persistence") =>
  analyzeTraits(calls).results.find((trait) => trait.id === id)!;

describe("curated trait analysis", () => {
  test("missing markers never become an absent-marker or normal result", () => {
    const analysis = analyzeTraits([]);
    expect(analysis.summary).toEqual({ total: 6, matched: 0, missing: 6, conflicting: 0, unresolved: 0 });
    for (const trait of analysis.results) {
      expect(trait.prediction).toBeUndefined();
      expect(trait.genotype).toBeUndefined();
      expect(trait.reason).toContain("Missing data");
    }
  });

  test("exact plus-strand genotypes distinguish marker presence from absence", () => {
    expect(result([lactase("AG")]).prediction?.markerEffect).toBe("present");
    expect(result([lactase("AA")]).prediction?.markerEffect).toBe("present");
    expect(result([lactase("GG")]).prediction?.markerEffect).toBe("absent");
    expect(result([lactase("GG")]).prediction?.description).toContain("does not establish lactose intolerance");
  });

  test("reverse-strand calls are complemented with their reference and alternate alleles", () => {
    const trait = result([lactase("TC", { strand: "minus", ref: "C", alt: "T" })]);
    expect(trait.status).toBe("matched");
    expect(trait.genotype).toBe("AG");
    expect(trait.prediction?.markerEffect).toBe("present");
  });

  test("declared plus strand never opportunistically flips unexpected alleles", () => {
    const trait = result([lactase("TC")]);
    expect(trait.status).toBe("unresolved");
    expect(trait.issues).toContain("unexpected-allele");
    expect(trait.prediction).toBeUndefined();
  });

  test.each(["unknown", undefined] as const)("does not infer strand from familiar alleles: %s", (strand) => {
    const trait = result([lactase("AA", { strand })]);
    expect(trait.status).toBe("unresolved");
    expect(trait.issues).toContain("unknown-strand");
    expect(trait.prediction).toBeUndefined();
  });

  test("palindromic taste alleles still require a strand declaration", () => {
    const trait = result(
      [{ rsid: "rs713598", chromosome: "7", position: "141673345", assembly: "GRCh37", genotype: "CG" }],
      "ptc-bitterness",
    );
    expect(trait.status).toBe("unresolved");
    expect(trait.issues).toContain("unknown-strand");
  });

  test("repeated equivalent calls and opposite-strand equivalents agree", () => {
    const trait = result([lactase("AG"), lactase("ga"), lactase("CT", { strand: "minus" })]);
    expect(trait.status).toBe("matched");
    expect(trait.genotype).toBe("AG");
    expect(trait.callCount).toBe(3);
  });

  test("conflicting calls suppress a prediction in either input order", () => {
    for (const calls of [
      [lactase("AA"), lactase("GG")],
      [lactase("GG"), lactase("AA")],
    ]) {
      const trait = result(calls);
      expect(trait.status).toBe("conflicting");
      expect(trait.issues).toContain("discordant-calls");
      expect(trait.prediction).toBeUndefined();
      expect(trait.genotype).toBeUndefined();
    }
  });

  test("a usable duplicate cannot hide an unresolved or missing genotype entry", () => {
    for (const ambiguous of [lactase("AA", { strand: "unknown" }), lactase("--")]) {
      const trait = result([lactase("AA"), ambiguous]);
      expect(trait.status).toBe("unresolved");
      expect(trait.prediction).toBeUndefined();
    }
  });

  test.each(["--", "00", "NN", "A.", "./.", "", "A0"])("no-call %s stays distinct from missing marker", (genotype) => {
    const trait = result([lactase(genotype)]);
    expect(trait.status).toBe("unresolved");
    expect(trait.callCount).toBe(1);
    expect(trait.issues).toContain("no-call");
    expect(trait.prediction).toBeUndefined();
  });

  test.each(["A", "AAA", "A/AG", "I/D"])("unsupported ploidy or sequence %s has no phenotype", (genotype) => {
    const trait = result([lactase(genotype)]);
    expect(trait.status).toBe("unresolved");
    expect(trait.issues).toContain("unsupported-call");
    expect(trait.prediction).toBeUndefined();
  });

  test("phased versus unphased SNP calls do not invent haplotypes", () => {
    const a = result([lactase("A|G", { alleles: ["A", "G"], phased: true })]);
    const b = result([lactase("G/A", { alleles: ["G", "A"], phased: false })]);
    expect(a.genotype).toBe("AG");
    expect(a.prediction).toEqual(b.prediction);
  });

  test("declared allele boundaries must agree with the raw genotype", () => {
    const trait = result([lactase("AA", { alleles: ["A", "G"] })]);
    expect(trait.status).toBe("conflicting");
    expect(trait.issues).toContain("allele-conflict");
    expect(trait.prediction).toBeUndefined();
  });

  test("known rsIDs do not bypass coordinate and assembly checks", () => {
    for (const overrides of [{ chromosome: "1" }, { position: "136608645" }, { assembly: "GRCh38" as const }]) {
      const trait = result([lactase("AA", overrides)]);
      expect(trait.status).toBe("conflicting");
      expect(trait.issues).toContain("coordinate-conflict");
      expect(trait.prediction).toBeUndefined();
    }
  });

  test("both supported builds work without attempting liftover", () => {
    const trait = result([lactase("AA", { assembly: "GRCh38", position: "135851076", chromosome: "chr2" })]);
    expect(trait.status).toBe("matched");
    expect(trait.prediction?.markerEffect).toBe("present");
  });

  test("unknown builds and incomplete coordinates remain unresolved", () => {
    expect(result([lactase("AA", { assembly: undefined })]).issues).toContain("unknown-build");
    expect(result([lactase("AA", { chromosome: "" })]).issues).toContain("missing-coordinate");
    expect(result([lactase("AA", { position: "" })]).issues).toContain("missing-coordinate");
  });

  test("a mismatching coordinate duplicate cannot be hidden by an exact rsID match", () => {
    const trait = result([lactase("AA"), lactase("AA", { position: "123" })]);
    expect(trait.status).toBe("conflicting");
    expect(trait.prediction).toBeUndefined();
  });

  test("reference metadata must agree with the oriented genome reference", () => {
    expect(result([lactase("AA", { ref: "G" })]).status).toBe("matched");
    for (const ref of ["A", "GG", "N"]) {
      const trait = result([lactase("AA", { ref })]);
      expect(trait.status).toBe("conflicting");
      expect(trait.issues).toContain("reference-conflict");
      expect(trait.prediction).toBeUndefined();
    }
  });

  test("called-ALT metadata cannot invent or omit a called non-reference allele", () => {
    expect(result([lactase("AG", { ref: "G", alt: "A" })]).status).toBe("matched");
    expect(result([lactase("GG", { ref: "G", alt: "A" })]).issues).toContain("allele-conflict");
    expect(result([lactase("AG", { ref: "G", alt: "G" })]).issues).toContain("allele-conflict");
  });

  test("an ID-less VCF call can match by exact assembly and locus", () => {
    const trait = result([lactase("AG", { rsid: "GRCh37:2:136608646:G:A", ref: "G", alt: "A" })]);
    expect(trait.status).toBe("matched");
    expect(trait.genotype).toBe("AG");
  });

  test("a different rsID or the wrong ID-less locus is not silently reidentified", () => {
    for (const overrides of [
      { rsid: "rs999999999" },
      { rsid: ".", chromosome: "3" },
      { rsid: ".", assembly: undefined },
    ]) {
      expect(result([lactase("AA", overrides)]).status).toBe("missing");
    }
  });

  test("rsID casing and leading zeroes normalize without changing allele orientation", () => {
    expect(result([lactase("AG", { rsid: " RS04988235 " })]).status).toBe("matched");
  });

  test("primary-study reverse-strand mappings do not invert the three appearance/taste markers", () => {
    const calls: UserGenotype[] = [
      {
        rsid: "rs17822931",
        chromosome: "16",
        position: "48258198",
        assembly: "GRCh37",
        strand: "plus",
        genotype: "TT",
      },
      {
        rsid: "rs12913832",
        chromosome: "15",
        position: "28365618",
        assembly: "GRCh37",
        strand: "plus",
        genotype: "GG",
      },
      { rsid: "rs713598", chromosome: "7", position: "141673345", assembly: "GRCh37", strand: "plus", genotype: "GG" },
    ];
    const analysis = analyzeTraits(calls);
    expect(analysis.results.find((trait) => trait.id === "earwax-type")?.prediction?.label).toContain("Dry");
    expect(analysis.results.find((trait) => trait.id === "eye-pigmentation")?.prediction?.label).toContain(
      "blue over brown",
    );
    expect(analysis.results.find((trait) => trait.id === "ptc-bitterness")?.prediction?.label).toContain("stronger");
  });

  test("every rule has exactly the three diploid outcomes and reviewable primary evidence", () => {
    for (const rule of TRAIT_RULES) {
      const [a, b] = [...rule.alleles].sort();
      expect(Object.keys(rule.outcomes).sort()).toEqual([a + a, a + b, b + b].sort());
      expect(rule.evidence.citations.length).toBeGreaterThan(0);
      expect(rule.evidence.population.length).toBeGreaterThan(0);
      expect(rule.limitations.length).toBeGreaterThan(0);
      for (const citation of rule.evidence.citations)
        expect(citation.url).toMatch(/^https:\/\/(doi.org|pmc.ncbi.nlm.nih.gov)\//);
    }
  });

  test("all imported calls are scanned once, with no genome-sized index or input mutation", () => {
    let visited = 0;
    const unrelated = Object.freeze(lactase("AG", { rsid: "rs999999999" }));
    function* calls() {
      for (let i = 0; i < 100_000; i++) {
        visited++;
        yield unrelated;
      }
      visited++;
      yield Object.freeze(lactase("AG"));
    }
    const analysis = analyzeTraits(calls());
    expect(visited).toBe(100_001);
    expect(analysis.analyzedCallCount).toBe(100_001);
    expect(analysis.candidateCallCount).toBe(1);
    expect(analysis.summary.matched).toBe(1);
    expect(JSON.stringify(analysis).length).toBeLessThan(20_000);
    expect(analysis.rulesVersion).toBe(TRAIT_RULES_VERSION);
    expect(structuredClone(analysis)).toEqual(analysis);
  });
});
