import { expect, test } from "bun:test";
import { detectFormat } from "../src/parsers";
import parserColor from "../src/parsers/color";

const colorContent = [
  "SampleID,Chromosome,Position,RSID,Genotype,ReferenceVersion",
  "L2137024,2,136707981,rs6754311,CC,GRCh37",
  "L2137024,7,141673344,rs713598,CT,GRCh37",
  "L2137024,11,6891757,not-rsid,AA,GRCh37",
].join("\n");

test("Color parser detects discovery genotype CSV exports", () => {
  const validation = parserColor.validate(colorContent);

  expect(validation.valid).toBe(true);
  expect(validation.confidence).toBeGreaterThanOrEqual(0.8);
});

test("Color parser emits rsid genotype rows", async () => {
  const result = await parserColor.parse(colorContent, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.genotypes).toEqual([
    {
      rsid: "rs6754311",
      chromosome: "2",
      position: "136707981",
      genotype: "cc",
    },
    {
      rsid: "rs713598",
      chromosome: "7",
      position: "141673344",
      genotype: "ct",
    },
  ]);
});

test("registry detects Color discovery genotype CSV exports", () => {
  const detection = detectFormat(colorContent);

  expect(detection.parser?.metadata.id).toBe("color");
  expect(detection.confident).toBe(true);
});
