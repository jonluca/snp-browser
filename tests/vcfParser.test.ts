import { expect, test } from "bun:test";
import { deflateRawSync, gzipSync } from "node:zlib";
import parserVCF from "../src/parsers/vcf";

const gvcfContent = `##fileformat=VCFv4.2
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE
1\t100\t.\tA\t<NON_REF>\t.\t.\tEND=200\tGT:DP\t0/0:10
1\t250\trs123\tA\tG,<NON_REF>\t.\t.\t.\tGT:DP\t0/1:20
1\t260\trs789\tA\tAC,<NON_REF>\t.\t.\t.\tGT:DP\t0/1:20
chrM\t270\trs456\tC\t<NON_REF>\t.\t.\tEND=270\tGT:DP\t0/0:20
`;

function createBgzfBlock(content: string): Uint8Array {
  const input = new TextEncoder().encode(content);
  const compressed = deflateRawSync(input);
  const blockSize = 18 + compressed.byteLength + 8;

  if (blockSize > 0x10000) {
    throw new Error("Test BGZF block exceeds the maximum block size");
  }

  const block = new Uint8Array(blockSize);
  const bsize = blockSize - 1;
  block.set([
    0x1f,
    0x8b,
    0x08,
    0x04,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0xff,
    0x06,
    0x00,
    0x42,
    0x43,
    0x02,
    0x00,
    bsize & 0xff,
    (bsize >> 8) & 0xff,
  ]);
  block.set(compressed, 18);
  new DataView(block.buffer).setUint32(blockSize - 4, input.byteLength, true);

  return block;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

test("VCF parser metadata advertises gVCF extensions", () => {
  expect(parserVCF.metadata.fileExtensions).toContain(".gvcf");
  expect(parserVCF.metadata.fileExtensions).toContain(".g.vcf.gz");
  expect(parserVCF.metadata.fileExtensions).toContain(".gz");
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
      ref: "A",
      alt: "G",
      strand: "plus",
      phased: false,
    },
    {
      rsid: "rs456",
      chromosome: "MT",
      position: "270",
      genotype: "cc",
      ref: "C",
      strand: "plus",
      phased: false,
    },
  ]);
});

test("VCF parser streams VCF blobs", async () => {
  const result = await parserVCF.parseBlob(new Blob([gvcfContent], { type: "text/plain" }), () => undefined);

  expect(result.genotypes.map((genotype) => genotype.rsid)).toEqual(["rs123", "rs456"]);
  expect(result.totalLines).toBe(7);
});

test("VCF parser streams provider-style gzip VCF blobs", async () => {
  const file = new File([gzipSync(gvcfContent)], "JonLuca_DeCaro_nucleus_dna_download_vcf_NU-NQAF-0943.gz");

  const result = await parserVCF.parseBlob(file, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.genotypes.map((genotype) => genotype.rsid)).toEqual(["rs123", "rs456"]);
});

test("VCF parser streams blocked gzip VCF blobs without relying on browser gzip member handling", async () => {
  const originalDecompressionStream = globalThis.DecompressionStream;
  const breakAt = gvcfContent.indexOf("1\t250");
  const bgzfContent = concatBytes([
    createBgzfBlock(gvcfContent.slice(0, breakAt)),
    createBgzfBlock(gvcfContent.slice(breakAt)),
    createBgzfBlock(""),
  ]);
  const file = new File([bgzfContent], "JonLuca_DeCaro_nucleus_dna_download_vcf_NU-NQAF-0943.gz");

  class RejectingGzipDecompressionStream extends originalDecompressionStream {
    constructor(format: CompressionFormat) {
      if (format === "gzip") {
        throw new Error("Junk found after end of compressed data.");
      }
      super(format);
    }
  }

  globalThis.DecompressionStream = RejectingGzipDecompressionStream;

  try {
    const result = await parserVCF.parseBlob(file, () => undefined);

    expect(result.errors).toEqual([]);
    expect(result.genotypes.map((genotype) => genotype.rsid)).toEqual(["rs123", "rs456"]);
  } finally {
    globalThis.DecompressionStream = originalDecompressionStream;
  }
});

test("VCF parser skips coordinate-only records with no declared build without treating them as parse failures", async () => {
  const content = `##fileformat=VCFv4.2
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE
chr1\t10616\t.\tC\tG\t.\tPASS\t.\tGT\t0/1
chr1\t10642\t.\tG\tA\t.\tPASS\t.\tGT\t1/1`;

  const result = await parserVCF.parse(content, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.genotypes).toEqual([]);
  expect(result.skippedLines).toBe(result.totalLines);
});

test("VCF parser skips sample records whose FORMAT has no GT field", async () => {
  const content = `##fileformat=VCFv4.2
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE
1\t100\trs123\tA\tG\t.\tPASS\t.\tDP:GQ\t0:99`;

  const result = await parserVCF.parse(content, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.genotypes).toEqual([]);
  expect(result.skippedLines).toBe(result.totalLines);
});

test("VCF parser does not interpret depth fields as a genotype when GT is absent", async () => {
  const content = [
    "##fileformat=VCFv4.2",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    "1\t100\trs123\tA\tG\t.\tPASS\t.\tDP\t1",
    "1\t200\trs456\tC\tT\t.\tPASS\t.\tDP:GT\t20:0/1",
  ].join("\n");

  for (const result of [
    await parserVCF.parse(content, () => undefined),
    await parserVCF.parseBlob(new Blob([content]), () => undefined),
  ]) {
    expect(result.genotypes).toEqual([
      {
        rsid: "rs456",
        chromosome: "1",
        position: "200",
        genotype: "ct",
        ref: "C",
        alt: "T",
        strand: "plus",
        phased: false,
      },
    ]);
    expect(result.errors).toEqual([]);
  }
});

test("VCF text and streaming parsing preserve reference build and called multiallelic identity", async () => {
  const content = [
    "##fileformat=VCFv4.2",
    "##reference=file:///data/GRCh38.p14.fa",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    "1\t100\trs123\tA\tC,G\t.\tPASS\t.\tGT\t2|1",
    "1\t101\trs124\tA\tC,G\t.\tPASS\t.\tGT\t0/2",
    "1\t102\trs125\tA\tG\t.\tPASS\t.\tGT\t0/0",
    "1\t103\trs126\tA\tG\t.\tPASS\t.\tGT\t./.",
    "1\t104\trs127\tAC\tG\t.\tPASS\t.\tGT\t1/1",
  ].join("\n");
  for (const result of [
    await parserVCF.parse(content, () => undefined),
    await parserVCF.parseBlob(new Blob([content]), () => undefined),
  ]) {
    expect(result.assembly).toBe("GRCh38");
    expect(result.errors).toEqual([]);
    expect(result.genotypes).toEqual([
      {
        rsid: "rs123",
        chromosome: "1",
        position: "100",
        genotype: "cg",
        ref: "A",
        alt: "C,G",
        strand: "plus",
        phased: true,
        assembly: "GRCh38",
      },
      {
        rsid: "rs124",
        chromosome: "1",
        position: "101",
        genotype: "ag",
        ref: "A",
        alt: "G",
        strand: "plus",
        phased: false,
        assembly: "GRCh38",
      },
      {
        rsid: "rs125",
        chromosome: "1",
        position: "102",
        genotype: "aa",
        ref: "A",
        strand: "plus",
        phased: false,
        assembly: "GRCh38",
      },
      { rsid: "rs126", chromosome: "1", position: "103", genotype: "--", ref: "A", strand: "plus", assembly: "GRCh38" },
    ]);
  }
});

test("VCF contig build declarations survive streaming and conflicting builds remain unresolved", async () => {
  const content = [
    "##fileformat=VCFv4.2",
    "##contig=<ID=1,assembly=GRCh37>",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    "1\t100\trs123\tA\tG\t.\tPASS\t.\tGT\t0/1",
  ].join("\n");
  const result = await parserVCF.parseBlob(new Blob([content]), () => undefined);
  expect(result.genotypes[0].assembly).toBe("GRCh37");
  for (const header of ["##reference=hg38.fa\n", ""]) {
    const unresolvedContent = header ? header + content : content.replace("##contig=<ID=1,assembly=GRCh37>\n", "");
    const unresolved = await parserVCF.parseBlob(new Blob([unresolvedContent]), () => undefined);
    expect(unresolved.assembly).toBeUndefined();
    expect(unresolved.genotypes[0].assembly).toBeUndefined();
    expect(unresolved.genotypes[0].strand).toBe("plus");
  }
});

test("VCF text, streaming, and gzip parsing retain ID-less SNPs under stable declared-build identities", async () => {
  const content = [
    "##fileformat=VCFv4.2",
    "##reference=file:///references/GRCh38.p14.fa",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    "chr22\t000100\t.\ta\tg,<NON_REF>\t.\tPASS\t.\tGT\t0/1",
    "chr22\t101\t.\tA\tG,C\t.\tPASS\t.\tGT\t1|2",
    "chrM\t102\t.\tC\tT\t.\tPASS\t.\tGT\t0/0",
    "22\t103\t.\tA\tG\t.\tPASS\t.\tGT\t./.",
    "22\t104\t.\tA\t<NON_REF>\t.\tPASS\tEND=200\tGT\t0/0",
    "22\t201\t.\tA\tAC\t.\tPASS\t.\tGT\t0/1",
    "22\t202\t.\tAC\tG\t.\tPASS\t.\tGT\t1/1",
    "22\t0\t.\tA\tG\t.\tPASS\t.\tGT\t0/1",
    "GL000207.1\t203\t.\tA\tG\t.\tPASS\t.\tGT\t0/1",
    "22\t204\t.\tA\tG\t.\tPASS\t.\tDP\t10",
    "22\t205\tcustom-name\tA\tG\t.\tPASS\t.\tGT\t0/1",
  ].join("\n");
  expect(parserVCF.validate(content).valid).toBe(true);
  expect(parserVCF.validate(content).reason).toContain("4 genotype records");
  for (const result of [
    await parserVCF.parse(content, () => undefined),
    await parserVCF.parseBlob(new Blob([content]), () => undefined),
    await parserVCF.parseBlob(new File([gzipSync(content)], "coordinates.vcf.gz"), () => undefined),
  ]) {
    expect(result.errors).toEqual([]);
    expect(result.assembly).toBe("GRCh38");
    expect(result.genotypes.map((genotype) => genotype.rsid)).toEqual([
      "GRCh38:22:100:A:G",
      "GRCh38:22:101:A:C,G",
      "GRCh38:MT:102:C:T",
      "GRCh38:22:103:A:G",
    ]);
    expect(result.genotypes[0]).toMatchObject({
      genotype: "ag",
      ref: "A",
      alt: "G",
      strand: "plus",
      assembly: "GRCh38",
    });
    expect(result.genotypes[1]).toMatchObject({ genotype: "cg", alt: "C,G", phased: true });
    expect(result.genotypes[2].genotype).toBe("cc");
    expect(result.genotypes[2].alt).toBeUndefined();
    expect(result.genotypes[3].genotype).toBe("--");
    expect(result.skippedLines + result.genotypes.length).toBe(result.totalLines);
  }
});

test("VCF coordinate identities require one supported build and accept explicit contig declarations", async () => {
  const content = [
    "##fileformat=VCFv4.2",
    "##contig=<ID=22,assembly=GRCh37>",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    "22\t100\t.\tA\tG\t.\tPASS\t.\tGT\t0/1",
  ].join("\n");
  for (const parse of [
    (input: string) => parserVCF.parse(input, () => undefined),
    (input: string) => parserVCF.parseBlob(new Blob([input]), () => undefined),
  ]) {
    expect((await parse(content)).genotypes[0].rsid).toBe("GRCh37:22:100:A:G");
    for (const unresolved of [
      content.replace("##contig=<ID=22,assembly=GRCh37>\n", ""),
      content.replace("GRCh37", "GRCh36"),
      content.replace("##contig", "##reference=GRCh38.fa\n##contig"),
    ]) {
      const result = await parse(unresolved);
      expect(result.genotypes).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.skippedLines).toBe(result.totalLines);
    }
  }
});
