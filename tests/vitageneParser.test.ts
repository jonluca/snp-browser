import { expect, test } from "bun:test";
import { detectFormat } from "../src/parsers";
import parserVitagene from "../src/parsers/vitagene";

const vitageneContent = [
  "RSID,CHROMOSOME,POSITION,RESULT",
  ...Array.from({ length: 240 }, (_, index) => `GSA-1:${index + 1},0,0,AA`),
  "rs123,1,12345,AG",
  "rs456,0,0,CC",
  "rs789,X,54321,--",
  "not-rsid,2,22222,TT",
  "rs111,2,33333,DI",
].join("\n");

test("Vitagene parser detects files with leading non-rs chip IDs", () => {
  const validation = parserVitagene.validate(vitageneContent);

  expect(validation.valid).toBe(true);
  expect(validation.confidence).toBeGreaterThanOrEqual(0.8);
});

test("Vitagene parser skips non-rs IDs and unsupported genotypes", async () => {
  const result = await parserVitagene.parse(vitageneContent, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.genotypes).toEqual([
    {
      rsid: "rs123",
      chromosome: "1",
      position: "12345",
      genotype: "ag",
    },
    {
      rsid: "rs456",
      chromosome: "0",
      position: "0",
      genotype: "cc",
    },
    {
      rsid: "rs789",
      chromosome: "X",
      position: "54321",
      genotype: "--",
    },
  ]);
});

test("registry detects Vitagene-style txt exports", () => {
  const detection = detectFormat(vitageneContent);

  expect(detection.parser?.metadata.id).toBe("vitagene");
  expect(detection.confident).toBe(true);
});
