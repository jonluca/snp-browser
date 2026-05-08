import { expect, test } from "bun:test";
import parserVCF from "../src/parsers/vcf";

const gvcfContent = `##fileformat=VCFv4.2
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE
1\t100\t.\tA\t<NON_REF>\t.\t.\tEND=200\tGT:DP\t0/0:10
1\t250\trs123\tA\tG,<NON_REF>\t.\t.\t.\tGT:DP\t0/1:20
1\t260\trs789\tA\tAC,<NON_REF>\t.\t.\t.\tGT:DP\t0/1:20
chrM\t270\trs456\tC\t<NON_REF>\t.\t.\tEND=270\tGT:DP\t0/0:20
`;

test("VCF parser metadata advertises gVCF extensions", () => {
  expect(parserVCF.metadata.fileExtensions).toContain(".gvcf");
  expect(parserVCF.metadata.fileExtensions).toContain(".g.vcf.gz");
});

test("VCF parser accepts gVCF records and skips indels", async () => {
  const validation = parserVCF.validate(gvcfContent);
  expect(validation.valid).toBe(true);

  const result = await parserVCF.parse(gvcfContent, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.genotypes).toEqual([
    {
      rsid: "rs123",
      chromosome: "1",
      position: "250",
      genotype: "ag",
    },
    {
      rsid: "rs456",
      chromosome: "MT",
      position: "270",
      genotype: "cc",
    },
  ]);
});

test("VCF parser streams VCF blobs", async () => {
  const result = await parserVCF.parseBlob(new Blob([gvcfContent], { type: "text/plain" }), () => undefined);

  expect(result.genotypes.map((genotype) => genotype.rsid)).toEqual(["rs123", "rs456"]);
  expect(result.totalLines).toBe(7);
});
