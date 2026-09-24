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

test("VCF parser accepts gVCF records and preserves concrete indels", async () => {
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
      rsid: "rs789",
      chromosome: "1",
      position: "260",
      genotype: "a/ac",
      ref: "A",
      alt: "AC",
      strand: "plus",
      phased: false,
      alleles: ["A", "AC"],
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

  expect(result.genotypes.map((genotype) => genotype.rsid)).toEqual(["rs123", "rs789", "rs456"]);
  expect(result.totalLines).toBe(7);
});

test("VCF parser streams provider-style gzip VCF blobs", async () => {
  const file = new File([gzipSync(gvcfContent)], "synthetic-provider-vcf.gz");

  const result = await parserVCF.parseBlob(file, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.genotypes.map((genotype) => genotype.rsid)).toEqual(["rs123", "rs789", "rs456"]);
});

test("VCF parser streams blocked gzip VCF blobs without relying on browser gzip member handling", async () => {
  const originalDecompressionStream = globalThis.DecompressionStream;
  const breakAt = gvcfContent.indexOf("1\t250");
  const bgzfContent = concatBytes([
    createBgzfBlock(gvcfContent.slice(0, breakAt)),
    createBgzfBlock(gvcfContent.slice(breakAt)),
    createBgzfBlock(""),
  ]);
  const file = new File([bgzfContent], "synthetic-provider-vcf.gz");

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
    expect(result.genotypes.map((genotype) => genotype.rsid)).toEqual(["rs123", "rs789", "rs456"]);
  } finally {
    globalThis.DecompressionStream = originalDecompressionStream;
  }
});

test("compressed VCF progress counts consumed file bytes before gzip or BGZF expansion", async () => {
  const firstText = [
    "##fileformat=VCFv4.2",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    `#${"synthetic padding ".repeat(2000)}`,
    "1\t100\trs123\tA\tG\t.\tPASS\t.\tGT\t0/1",
    "",
  ].join("\n");
  const lastText = `#${"more synthetic padding ".repeat(2000)}\n1\t200\trs456\tC\tT\t.\tPASS\t.\tGT\t1/1\n`;
  const gzip = gzipSync(firstText + lastText);
  const firstBlock = createBgzfBlock(firstText);
  const bgzf = concatBytes([firstBlock, createBgzfBlock(lastText), createBgzfBlock("")]);

  for (const [format, compressed, prefixBytes] of [
    ["gzip", gzip, Math.floor(gzip.byteLength / 2)],
    ["bgzf", bgzf, firstBlock.byteLength],
  ] as const) {
    let releaseTail!: () => void;
    const tailReady = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const file = new File([compressed], `synthetic-progress.${format}.vcf.gz`);
    // Hold the remaining compressed bytes until parsing makes progress. This
    // distinguishes bytes actually consumed from much larger inflated chunks.
    Object.defineProperty(file, "stream", {
      value: () => {
        let first = true;
        return new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              if (first) {
                first = false;
                controller.enqueue(compressed.subarray(0, prefixBytes));
                return;
              }
              await tailReady;
              controller.enqueue(compressed.subarray(prefixBytes));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        );
      },
    });
    const progress: number[] = [];
    const result = await parserVCF.parseBlob(file, (current, total) => {
      expect(total).toBe(compressed.byteLength);
      progress.push(current);
      if (current > 0) releaseTail();
    });

    expect(progress[0]).toBe(0);
    expect(progress.find((current) => current > 0)).toBe(prefixBytes);
    expect(progress.at(-1)).toBe(compressed.byteLength);
    expect(
      progress.every((current, index) => current <= compressed.byteLength && current >= (progress[index - 1] ?? 0)),
    ).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.genotypes.map((genotype) => genotype.rsid)).toEqual(["rs123", "rs456"]);
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
      {
        rsid: "rs127",
        chromosome: "1",
        position: "104",
        genotype: "g/g",
        ref: "AC",
        alt: "G",
        strand: "plus",
        assembly: "GRCh38",
        phased: false,
        alleles: ["G", "G"],
      },
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
  expect(parserVCF.validate(content).reason).toContain("8 genotype records");
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
      "GRCh38:22:201:A:AC",
      "GRCh38:22:202:AC:G",
      "GRCh38:GL000207.1:203:A:G",
      "GRCh38:22:205:A:G",
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

test("sequence calls preserve allele boundaries, ploidy, phasing, and VCF padding", async () => {
  const content = [
    "##fileformat=VCFv4.5",
    "##reference=GRCh38.fa",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    "1\t100\t.\tA\tAT\t.\tPASS\t.\tGT\t0/1",
    "1\t101\t.\tAT\tA\t.\tPASS\t.\tGT\t1|0",
    "1\t102\t.\tAC\tGT,AG\t.\tPASS\t.\tGT\t2/1",
    "1\t103\t.\tA\tAT\t.\tPASS\t.\tGT\t1",
    "1\t104\t.\tAT\tA\t.\tPASS\t.\tGT\t0/0",
    "1\t105\t.\tA\tAT\t.\tPASS\t.\tGT\t0/1|1",
    "1\t106\t.\tA\tAT\t.\tPASS\t.\tGT\t/1/0",
    "1\t107\t.\tA\tAT\t.\tPASS\t.\tGT\t./1",
    "1\t108\t.\tA\tG\t.\tPASS\t.\tGT\t0/1/1",
  ].join("\n");
  for (const result of [
    await parserVCF.parse(content, () => undefined),
    await parserVCF.parseBlob(new File([gzipSync(content)], "synthetic-sequences.vcf.gz"), () => undefined),
  ]) {
    expect(result.errors).toEqual([]);
    expect(result.genotypes.map((call) => call.genotype)).toEqual([
      "a/at",
      "a|at",
      "ag/gt",
      "at",
      "at/at",
      "a/at|at",
      "/at/a",
      "--",
      "a/g/g",
    ]);
    expect(result.genotypes.map((call) => call.alleles)).toEqual([
      ["A", "AT"],
      ["A", "AT"],
      ["AG", "GT"],
      ["AT"],
      ["AT", "AT"],
      ["A", "AT", "AT"],
      ["AT", "A"],
      undefined,
      ["A", "G", "G"],
    ]);
    expect(result.genotypes[0].rsid).toBe("GRCh38:1:100:A:AT");
    expect(result.genotypes[1].phased).toBe(true);
    expect(result.genotypes[2].alt).toBe("AG,GT");
    expect(result.genotypes[4].alt).toBeUndefined();
    expect(result.genotypes[5].phased).toBe(false);
  }
});

test("symbolic calls, ambiguous bases, reference blocks, and missing GT produce aggregate notices", async () => {
  const content = [
    "##fileformat=VCFv4.5",
    "##reference=GRCh38.fa",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    "1\t100\t.\tA\t<NON_REF>\t.\tPASS\tEND=200\tGT\t0/0",
    "1\t201\trs100\tA\t<NON_REF>\t.\tPASS\tEND=300\tGT\t0/0",
    "1\t301\trs101\tA\tAT,<DEL>\t.\tPASS\t.\tGT\t0/2",
    "1\t302\trs102\tA\tAT,*\t.\tPASS\t.\tGT\t1/2",
    "1\t303\trs103\tA\tA]2:100]\t.\tPASS\t.\tGT\t1/1",
    "1\t304\trs104\tA\tAN\t.\tPASS\t.\tGT\t1/1",
    "1\t305\trs105\tN\tG\t.\tPASS\t.\tGT\t0/1",
    "1\t306\t.\tA\tAT\t.\tPASS\t.\tDP\t20",
    "1\t307\t.\tA\tAT,<NON_REF>\t.\tPASS\t.\tGT\t0/1",
  ].join("\n");
  const result = await parserVCF.parse(content, () => undefined);
  expect(result.genotypes).toHaveLength(1);
  expect(result.genotypes[0].genotype).toBe("a/at");
  expect(result.errors).toEqual([]);
  expect(result.warnings).toHaveLength(4);
  expect(result.warnings?.join(" ")).toContain("2 reference blocks");
  expect(result.warnings?.join(" ")).toContain("4 calls used symbolic");
});

test("malformed or out-of-range GT indexes cannot become sequence calls", async () => {
  const content = [
    "##fileformat=VCFv4.5",
    "##reference=GRCh38.fa",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    ...["0//1", "0/2", "0/-1", "0/x", "0/", "0//."].map(
      (gt, index) => `1\t${100 + index}\t.\tA\tAT\t.\tPASS\t.\tGT\t${gt}`,
    ),
  ].join("\n");
  const result = await parserVCF.parse(content, () => undefined);
  expect(result.genotypes).toEqual([]);
  expect(result.errors).toHaveLength(6);
});

test("noncanonical contigs retain exact names and safe coordinate IDs without inventing canonical chromosomes", async () => {
  const content = [
    "##fileformat=VCFv4.5",
    "##reference=GRCh38.fa",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    "alternate*01:02\t100\t.\tA\tAT\t.\tPASS\t.\tGT\t0/1",
    "chrUn_example\t101\tprovider-call\tAC\tA\t.\tPASS\t.\tGT\t1/1",
    "<invalid>\t102\t.\tA\tG\t.\tPASS\t.\tGT\t0/1",
  ].join("\n");
  const result = await parserVCF.parse(content, () => undefined);
  expect(result.errors).toEqual([]);
  expect(result.genotypes.map(({ chromosome, rsid }) => ({ chromosome, rsid }))).toEqual([
    { chromosome: "alternate*01:02", rsid: "GRCh38:alternate*01%3A02:100:A:AT" },
    { chromosome: "chrUn_example", rsid: "GRCh38:chrUn_example:101:AC:A" },
  ]);
  expect(result.warnings).toHaveLength(1);
});

const singleSampleHeader = [
  "##fileformat=VCFv4.5",
  "##reference=GRCh38",
  "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
].join("\n");

const parseVcfSources = [
  (content: string) => parserVCF.parse(content, () => {}),
  (content: string) => parserVCF.parseBlob(new File([content], "input.vcf"), () => {}),
  (content: string) => parserVCF.parseBlob(new File([gzipSync(content)], "input.vcf.gz"), () => {}),
  (content: string) => {
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < content.length; offset += 16000) {
      chunks.push(createBgzfBlock(content.slice(offset, offset + 16000)));
    }
    chunks.push(createBgzfBlock(""));
    return parserVCF.parseBlob(new File([concatBytes(chunks)], "input.bgzf.vcf.gz"), () => {});
  },
];

test("VCF text, streaming, gzip and BGZF reject multiple samples instead of choosing the first person", async () => {
  const content = `${singleSampleHeader}\tUPLOADER\n1\t100\trs123\tA\tG\t99\tPASS\t.\tGT\t1/1\t0/0\n`;
  for (const parse of parseVcfSources) {
    await expect(parse(content)).rejects.toThrow("Line 3: This VCF contains multiple samples");
  }
});

test("late extra sample columns or repeated headers reject the whole VCF rather than returning earlier calls", async () => {
  // Put the invalid line beyond a normal text chunk, and omit the final newline.
  const prefix = `${singleSampleHeader}\n${"1\t100\trs123\tA\tG\t99\tPASS\t.\tGT\t0/1\n".repeat(3000)}`;
  const extraSample = "1\t101\trs124\tA\tG\t0\tLowQual\t.\tGT\t1/1\t0/0";
  const repeatedHeader = singleSampleHeader.split("\n")[2];
  for (const suffix of [
    extraSample,
    repeatedHeader,
    `${repeatedHeader}\tOTHER`,
    repeatedHeader.replace("SAMPLE", "OTHER"),
  ]) {
    for (const parse of parseVcfSources) {
      await expect(parse(prefix + suffix)).rejects.toThrow("single-sample VCF");
    }
  }
});

test("fatal VCF rejection cancels the remaining input stream", async () => {
  let cancelled = false;
  const file = new File([singleSampleHeader], "input.vcf");
  Object.defineProperty(file, "stream", {
    value: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${singleSampleHeader}\tOTHER\n`));
          // The rest of the input deliberately remains open until cancellation.
        },
        cancel() {
          cancelled = true;
        },
      }),
  });
  await expect(parserVCF.parseBlob(file, () => {})).rejects.toThrow("multiple samples");
  expect(cancelled).toBe(true);
});

test("failed VCF site or sample filters are excluded with a counted import notice in every input path", async () => {
  const content = [
    singleSampleHeader,
    "1\t100\trs100\tA\tG\t99\tLowQual\t.\tGT:FT:GQ\t1/1:PASS:99",
    "1\t101\trs101\tA\tG\t99\tPASS\t.\tGT:FT:GQ\t1/1:LowDepth:99",
    "1\t102\trs102\tA\tG\t99\tPASS\t.\tFT:GQ:GT\tPASS;LowDepth:99:1/1",
    "1\t103\trs103\tA\tG\t0\tLowQual;LowDepth\t.\tGT:FT:GQ\t1/1:FAIL:0",
    "1\t104\trs104\tA\tG\t0\tPASS\t.\tGT:FT:GQ\t0/1:PASS:0",
  ].join("\n");
  for (const parse of parseVcfSources) {
    const result = await parse(content);
    expect(result.genotypes.map((call) => call.rsid)).toEqual(["rs104"]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "4 calls failed a VCF site (FILTER) or sample (FT) quality filter and were excluded from analysis.",
    ]);
    expect(result.skippedLines).toBe(7);
  }
});

test("PASS, unapplied and absent filters preserve calls without inventing numeric QUAL or GQ cutoffs", async () => {
  const content = [
    singleSampleHeader,
    "1\t100\trs100\tA\tG\t0\tPASS\t.\tGT:FT:GQ\t0/1:PASS:0",
    "1\t101\trs101\tA\tG\t0\t.\t.\tGT:FT:GQ\t0/1:.:0",
    "1\t102\trs102\tA\tG\t.\t.\t.\tGT\t0/1",
    "1\t103\trs103\tA\tG\t0\tPASS\t.\tGT:GQ:FT\t0/1:0",
    "1\t104\trs104\tA\tG\t0\t\t.\tGT:FT:GQ\t0/1::0",
  ].join("\n");
  for (const parse of parseVcfSources) {
    const result = await parse(content);
    expect(result.genotypes.map((call) => call.rsid)).toEqual(["rs100", "rs101", "rs102", "rs103", "rs104"]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toBeUndefined();
  }
});

test("VCFs containing only failed quality calls retain the exclusion reason and no personal calls", async () => {
  const content = `${singleSampleHeader}\n1\t100\trs123\tA\tG\t0\tLowQual\t.\tGT:FT:GQ\t1/1:FAIL:0`;
  for (const parse of parseVcfSources) {
    const result = await parse(content);
    expect(result.genotypes).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "1 calls failed a VCF site (FILTER) or sample (FT) quality filter and were excluded from analysis.",
    ]);
  }
});
