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

test("VCF parser skips coordinate-only records without treating them as parse failures", async () => {
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
