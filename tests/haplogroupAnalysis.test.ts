import { describe, expect, test } from "bun:test";
import { HAPLOGROUP_RULES } from "../src/data/haplogroupMarkers";
import type { HaplogroupRule } from "../src/types/haplogroups";
import type { UserGenotype } from "../src/types/snp";
import { analyzeHaplogroups } from "../src/utils/haplogroupAnalysis";
import { parseFileBlobWithDetection, parseFileWithDetection } from "../src/workers/fileParsing";
import { detectFileMetadata } from "../src/parsers/metadata";

const complement: Record<string, string> = { A: "T", C: "G", G: "C", T: "A" };
const yRule = () => HAPLOGROUP_RULES.find((rule) => rule.lineage === "Y" && rule.label.startsWith("R1b"))!;
const mtRule = () => HAPLOGROUP_RULES.find((rule) => rule.lineage === "MT" && rule.label === "H")!;

function callsFor(rule: HaplogroupRule, overrides: Partial<UserGenotype> = {}): UserGenotype[] {
  return rule.markers.map((marker, index) => ({
    rsid: marker.rsid ?? `i${index + 1}`,
    chromosome: rule.lineage,
    position: String(marker.positions[overrides.assembly ?? "GRCh37"]),
    assembly: "GRCh37",
    strand: "plus",
    genotype: marker.allele,
    ref: marker.refs?.[overrides.assembly ?? "GRCh37"] ?? marker.ref,
    ...overrides,
  }));
}

function result(calls: UserGenotype[], lineage = "Y") {
  return analyzeHaplogroups(calls).results.find((entry) => entry.lineage === lineage)!;
}

describe("haplogroup marker panel", () => {
  test("has verified, internally consistent coordinates and an acyclic hierarchy", () => {
    expect(new Set(HAPLOGROUP_RULES.map((rule) => rule.id)).size).toBe(HAPLOGROUP_RULES.length);
    const loci = new Map<string, { position: number; ref?: string }>();
    for (const rule of HAPLOGROUP_RULES) {
      expect(rule.markers.length).toBeGreaterThanOrEqual(rule.lineage === "MT" ? 2 : 1);
      const visited = new Set([rule.id]);
      let parent = rule.parent;
      while (parent) {
        expect(visited.has(parent)).toBe(false);
        visited.add(parent);
        const ancestor = HAPLOGROUP_RULES.find((entry) => entry.id === parent);
        expect(ancestor?.lineage).toBe(rule.lineage);
        parent = ancestor?.parent;
      }
      for (const marker of rule.markers) {
        expect(marker.allele).toMatch(/^[ACGT]$/);
        expect(Number.isSafeInteger(marker.positions.GRCh37)).toBe(true);
        expect(marker.positions.GRCh37).toBeGreaterThan(0);
        const key = `${rule.lineage}:${marker.positions.GRCh37}`;
        const coordinate = { position: marker.positions.GRCh38, ref: marker.ref };
        if (loci.has(key)) expect(coordinate).toEqual(loci.get(key));
        else loci.set(key, coordinate);
      }
    }
  });

  test("every supported motif produces its documented broad estimate on both builds", () => {
    for (const rule of HAPLOGROUP_RULES) {
      for (const assembly of ["GRCh37", "GRCh38"] as const) {
        const actual = result(callsFor(rule, { assembly }), rule.lineage);
        expect({ label: rule.label, status: actual.status, prediction: actual.haplogroup }).toEqual({
          label: rule.label,
          status: "predicted",
          prediction: rule.label,
        });
      }
    }
  });
});

describe("conservative haplogroup inference", () => {
  test("absent chromosomes have no estimate and never infer sex", () => {
    for (const entry of analyzeHaplogroups([]).results) {
      expect(entry.status).toBe("unavailable");
      expect(entry.haplogroup).toBeUndefined();
    }
    const maternalOnly = analyzeHaplogroups(callsFor(mtRule()));
    expect(maternalOnly.results[0].status).toBe("unavailable");
    expect(maternalOnly.results[1].haplogroup).toBe("H");
    expect(result([{ rsid: "rs1", chromosome: "Y", position: "1", genotype: "A" }]).status).toBe("insufficient");
  });

  test("missing mitochondrial markers are not filled with reference bases", () => {
    const calls = callsFor(mtRule());
    expect(result(calls.slice(1), "MT").haplogroup).toBeUndefined();
    expect(
      result(
        calls.map((call) => ({ ...call, genotype: "--" })),
        "MT",
      ).haplogroup,
    ).toBeUndefined();
  });

  test("haploid, homozygous, explicit diploid and reverse-strand calls agree", () => {
    const calls = callsFor(yRule());
    for (const transform of [
      (call: UserGenotype) => call,
      (call: UserGenotype) => ({ ...call, genotype: call.genotype.repeat(2).toLowerCase() }),
      (call: UserGenotype) => ({
        ...call,
        genotype: `${call.genotype}|${call.genotype}`,
        alleles: [call.genotype, call.genotype],
      }),
      (call: UserGenotype) => ({
        ...call,
        strand: "minus" as const,
        genotype: complement[call.genotype],
        ref: call.ref ? complement[call.ref] : undefined,
      }),
    ])
      expect(result(calls.map(transform)).haplogroup).toBe(yRule().label);
  });

  test("unknown build, strand and invalid coordinates never make an estimate", () => {
    for (const overrides of [
      { assembly: undefined },
      { strand: undefined },
      { strand: "unknown" as const },
      { position: "0" },
      { position: "999999999" },
      { chromosome: "X" },
    ])
      expect(result(callsFor(yRule(), overrides)).haplogroup).toBeUndefined();
  });

  test("matching provider IDs and ID-less calls can use the exact supported locus", () => {
    expect(result(callsFor(yRule(), { rsid: "i999" })).haplogroup).toBe(yRule().label);
    expect(result(callsFor(yRule(), { rsid: "GRCh37:Y:synthetic" })).haplogroup).toBe(yRule().label);
    expect(result(callsFor(yRule(), { rsid: "rs999999999" })).haplogroup).toBeUndefined();
  });

  test("mixed alleles, discordant duplicates, reference and allele conflicts block output", () => {
    const calls = callsFor(yRule());
    const first = calls[0];
    const opposite = complement[first.genotype];
    for (const bad of [
      { ...first, genotype: `${first.genotype}${opposite}` },
      { ...first, genotype: opposite },
      { ...first, ref: "AA" },
      { ...first, alleles: [opposite] },
      { ...first, alt: opposite },
    ]) {
      expect(result([...calls, bad]).status).toBe("conflicting");
      expect(result([bad, ...calls]).haplogroup).toBeUndefined();
    }
    expect(result([...calls, ...calls]).haplogroup).toBe(yRule().label);
    expect(result([...calls, { ...first, genotype: "--" }]).haplogroup).toBeUndefined();
  });

  test("incompatible branches are not resolved by marker count", () => {
    const other = HAPLOGROUP_RULES.find((rule) => rule.lineage === "Y" && rule.label.startsWith("R1a"))!;
    const actual = result([...callsFor(yRule()), ...callsFor(other)]);
    expect(actual.status).toBe("conflicting");
    expect(actual.haplogroup).toBeUndefined();
  });

  test("known ancestral contradictions block a positive descendant", () => {
    const child = HAPLOGROUP_RULES.find((rule) => rule.lineage === "Y" && rule.parent)!;
    const parent = HAPLOGROUP_RULES.find((rule) => rule.id === child.parent)!;
    const contrary = callsFor(parent).map((call) => ({ ...call, genotype: complement[call.genotype] }));
    expect(result([...callsFor(child), ...contrary]).status).toBe("conflicting");
  });

  test("the UCSC hg19 and RSRS mitochondrial reference sequences are unsupported", () => {
    expect(result(callsFor(mtRule(), { mitochondrialReference: "unsupported" }), "MT").haplogroup).toBeUndefined();
    expect(detectFileMetadata("##reference=hg19.fa\n#CHROM", true)).toMatchObject({
      mitochondrialReference: "unsupported",
    });
    expect(detectFileMetadata("# GRCh37\n# mitochondrial RSRS")).toMatchObject({
      mitochondrialReference: "unsupported",
    });
    expect(
      detectFileMetadata("##reference=hg19.fa\n##contig=<ID=MT,assembly=NC_012920.1>\n#CHROM", true),
    ).toMatchObject({ mitochondrialReference: "rCRS" });
  });
});

describe("haplogroup import paths", () => {
  test("23andMe and streamed VCF imports preserve calls needed for both outputs", async () => {
    const calls = [...callsFor(yRule()), ...callsFor(mtRule())];
    const raw = [
      "# 23andMe raw data",
      "# genome build 37",
      "# plus strand",
      ...calls.map(
        (call, index) =>
          `${call.rsid.startsWith("rs") ? call.rsid : `i${index + 1}`}\t${call.chromosome}\t${call.position}\t${call.genotype}`,
      ),
    ].join("\n");
    const parsed = await parseFileWithDetection(raw, () => undefined);
    expect(analyzeHaplogroups(parsed.genotypes).results.map((entry) => entry.status)).toEqual([
      "predicted",
      "predicted",
    ]);
    const vcf = [
      "##fileformat=VCFv4.2",
      "##reference=GRCh37",
      "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
      ...calls.map((call) => {
        const ref = call.ref ?? complement[call.genotype];
        const referenceCall = ref === call.genotype;
        return `${call.chromosome}\t${call.position}\t.\t${ref}\t${referenceCall ? complement[ref] : call.genotype}\t.\tPASS\t.\tGT\t${referenceCall ? "0" : "1"}`;
      }),
    ].join("\n");
    const file = new File([vcf], "synthetic-haplogroups.vcf");
    const streamed = await parseFileBlobWithDetection(file, () => undefined);
    expect(analyzeHaplogroups(streamed.genotypes).results.map((entry) => entry.status)).toEqual([
      "predicted",
      "predicted",
    ]);
    const legacy = await parseFileBlobWithDetection(
      new File([vcf.replace("GRCh37", "hg19")], "legacy.vcf"),
      () => undefined,
    );
    expect(result(legacy.genotypes, "MT").haplogroup).toBeUndefined();
    expect(result(legacy.genotypes).status).toBe("predicted");
  });
});
