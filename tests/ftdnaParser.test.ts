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

for (const provider of ["FamilyTreeDNA", "FTDNA"]) {
  test(`registry preserves no-calls in ${provider} exports`, async () => {
    const content = [
      `# ${provider} raw data`,
      "RSID,CHROMOSOME,POSITION,RESULT",
      "rs1,1,100,AA",
      "rs2,1,200,CC",
      "rs3,1,300,GG",
      "rs4,1,400,0",
      "rs5,1,500,00",
    ].join("\n");
    const detection = detectFormat(content);

    expect(detection.parser?.metadata.id).toBe("ftdna");
    const result = await detection.parser!.parse(content, () => undefined);
    expect(result.errors).toEqual([]);
    expect(result.genotypes.map((row) => row.genotype)).toEqual(["aa", "cc", "gg", "--", "--"]);
  });
}
