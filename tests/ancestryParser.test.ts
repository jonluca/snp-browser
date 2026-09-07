import { expect, test } from "bun:test";
import { detectFormat } from "../src/parsers";
import parserAncestry from "../src/parsers/ancestry";

test("registry preserves both alleles in Ancestry records with generic comments", async () => {
  const content = ["# DNA raw data", "rs123\t1\t100\tA\tG", "rs456\t2\t200\tC\tT", "rs789\t3\t300\tG\tG"].join("\n");
  const detection = detectFormat(content);

  expect(detection.parser?.metadata.id).toBe("ancestry");
  const result = await detection.parser!.parse(content, () => undefined);
  expect(result.genotypes.map((row) => row.genotype)).toEqual(["ag", "ct", "gg"]);
});

test("Ancestry parser skips an uncommented column header", async () => {
  const content = [
    "# AncestryDNA raw data",
    "rsid\tchromosome\tposition\tallele1\tallele2",
    "rs123\t1\t100\tA\tG",
  ].join("\n");
  const result = await parserAncestry.parse(content, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.skippedLines).toBe(2);
  expect(result.genotypes).toEqual([{ rsid: "rs123", chromosome: "1", position: "100", genotype: "ag" }]);
});
