import { expect, test } from "bun:test";
import { detectFormat } from "../src/parsers";
import parserColor from "../src/parsers/color";

const colorContent = [
  "SampleID,Chromosome,Position,RSID,Genotype,ReferenceVersion",
  "synthetic-sample,1,100,rs100,AG,GRCh37",
  "synthetic-sample,2,200,rs200,CT,GRCh37",
  "synthetic-sample,3,300,not-rsid,AA,GRCh37",
].join("\n");

test("Color parser detects discovery genotype CSV exports", () => {
  const validation = parserColor.validate(colorContent);

  expect(validation.valid).toBe(true);
  expect(validation.confidence).toBeGreaterThanOrEqual(0.8);
});

test("Color parser emits rsid genotype rows", async () => {
  const result = await parserColor.parse(colorContent, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.assembly).toBe("GRCh37");
  expect(result.genotypes).toEqual([
    { rsid: "rs100", chromosome: "1", position: "100", genotype: "ag", assembly: "GRCh37" },
    { rsid: "rs200", chromosome: "2", position: "200", genotype: "ct", assembly: "GRCh37" },
  ]);
});

test("registry detects Color discovery genotype CSV exports", () => {
  const detection = detectFormat(colorContent);

  expect(detection.parser?.metadata.id).toBe("color");
  expect(detection.confident).toBe(true);
});

test("Color preserves row-specific reference versions without inferring a build or strand for other rows", async () => {
  const content = [
    "SampleID,Chromosome,Position,RSID,Genotype,ReferenceVersion",
    "synthetic-sample,1,100,rs100,AG,hg19",
    "synthetic-sample,1,101,rs101,CT,GRCh38",
    "synthetic-sample,1,102,rs102,AA,",
    "synthetic-sample,1,103,rs103,--,GRCh36",
  ].join("\n");
  const result = await parserColor.parse(content, () => undefined);
  expect(result.assembly).toBeUndefined();
  expect(result.genotypes.map((row) => row.assembly)).toEqual(["GRCh37", "GRCh38", undefined, undefined]);
  expect(result.genotypes.every((row) => row.strand === undefined)).toBe(true);
  expect(result.genotypes).toHaveLength(4);
  expect(result.errors).toEqual([]);
});

test("Color leaves contradictory or unsupported row builds unresolved instead of overwriting them from the header", async () => {
  const content = [
    "# genome build 37",
    "# plus strand",
    "SampleID,Chromosome,Position,RSID,Genotype,ReferenceVersion",
    "synthetic-sample,1,100,rs100,AG,GRCh38",
    "synthetic-sample,1,101,rs101,CT,GRCh36",
    "synthetic-sample,1,102,rs102,AA,",
  ].join("\n");
  const result = await parserColor.parse(content, () => undefined);
  expect(result.assembly).toBeUndefined();
  expect(result.genotypes.map((row) => row.assembly)).toEqual([undefined, undefined, "GRCh37"]);
  expect(result.genotypes.every((row) => row.strand === "plus")).toBe(true);
  expect(result.errors).toEqual([]);
});
