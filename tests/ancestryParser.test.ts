import { expect, test } from "bun:test";
import { detectFormat } from "../src/parsers";
import parserAncestry from "../src/parsers/ancestry";
import { matchVariantAnnotation, normalizeChromosome } from "../src/utils/variantIdentity";

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

test("Ancestry numeric X and Y codes preserve calls and allow confirmed coordinate matching", async () => {
  const content = [
    "# AncestryDNA raw data",
    "# genome build 37; plus strand",
    "rsid\tchromosome\tposition\tallele1\tallele2",
    "rs100\t23\t100\tA\tG",
    "rs200\t24\t200\tA\tG",
  ].join("\n");
  const detection = detectFormat(content);
  expect(detection.parser?.metadata.id).toBe("ancestry");
  expect(parserAncestry.validate(content).reason).toContain("2 valid data lines");
  const result = await detection.parser!.parse(content, () => undefined);
  expect(result.errors).toEqual([]);
  expect(result.skippedLines).toBe(3);
  expect(result.genotypes).toHaveLength(2);
  expect(result.genotypes.map((row) => row.chromosome)).toEqual(["X", "Y"]);
  expect(result.genotypes.map((row) => row.genotype)).toEqual(["ag", "ag"]);

  for (const [index, chromosome] of ["X", "Y"].entries()) {
    expect(
      matchVariantAnnotation(result.genotypes[index], {
        id: `synthetic-${chromosome}`,
        source: "gnomad",
        assembly: "GRCh37",
        chromosome,
        position: (index + 1) * 100,
        ref: "A",
        alt: "G",
        scope: "allele",
        title: "Synthetic allele",
        url: "https://example.com/annotation",
        fields: {},
      }).matchType,
    ).toBe("allele");
  }
});

test("Ancestry leaves undocumented codes unresolved and does not change global chromosome conventions", async () => {
  const result = await parserAncestry.parse(
    [
      "# AncestryDNA raw data",
      "# genome build 37; plus strand",
      "rs100\t25\t100\tA\tG",
      "rs200\t26\t200\tA\tG",
      "rs300\tX\t300\t0\t0",
      "rs400\tY\t400\tI\tD",
      "rs500\t22\t500\tC\tT",
    ].join("\n"),
    () => undefined,
  );
  expect(result.errors).toEqual([]);
  expect(result.genotypes.map((row) => row.chromosome)).toEqual(["25", "26", "X", "Y", "22"]);
  expect(result.genotypes.map((row) => row.genotype)).toEqual(["ag", "ag", "--", "id", "ct"]);
  expect(normalizeChromosome("23")).toBeUndefined();
  expect(normalizeChromosome("24")).toBeUndefined();
  expect(normalizeChromosome(result.genotypes[0].chromosome)).toBeUndefined();
  expect(normalizeChromosome(result.genotypes[1].chromosome)).toBeUndefined();
});
