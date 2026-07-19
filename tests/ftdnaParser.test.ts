import { expect, test } from "bun:test";
import { detectFormat } from "../src/parsers";
import parserFTDNA from "../src/parsers/ftdna";

const familyTreeDNAContent = [
  'RSID,"CHROMOSOME","POSITION","RESULT"',
  'rs123,"1","12345","AG"',
  'rs456,"2","23456","CC"',
  'rs789,"X","34567","0"',
].join("\n");

test("registry prefers FamilyTreeDNA for its documented CSV shape", () => {
  const detection = detectFormat(familyTreeDNAContent);

  expect(detection.parser?.metadata.id).toBe("ftdna");
});

test("FamilyTreeDNA parser normalizes zero no-calls", async () => {
  const result = await parserFTDNA.parse(familyTreeDNAContent, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.genotypes.at(-1)?.genotype).toBe("--");
});
