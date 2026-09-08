import { expect, test } from "bun:test";
import { deflateRawSync, gzipSync } from "node:zlib";
import { parseFileBlobWithDetection, parseFileWithDetection } from "../src/workers/fileParsing";

function storedZip(filename: string, content: string): File {
  return archive([{ filename, content }]);
}

function archive(entries: Array<{ filename: string; content: string | Uint8Array }>): File {
  const encoder = new TextEncoder();
  const encoded = entries.map((entry) => ({
    name: encoder.encode(entry.filename),
    bytes: typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content,
  }));
  const centralOffset = encoded.reduce((sum, entry) => sum + 30 + entry.name.length + entry.bytes.length, 0);
  const centralSize = encoded.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const buffer = new ArrayBuffer(centralOffset + centralSize + 22);
  const data = new DataView(buffer);
  const output = new Uint8Array(buffer);
  let localOffset = 0;
  let directoryOffset = centralOffset;
  for (const { name, bytes } of encoded) {
    data.setUint32(localOffset, 0x04034b50, true);
    data.setUint16(localOffset + 4, 20, true);
    data.setUint32(localOffset + 18, bytes.length, true);
    data.setUint32(localOffset + 22, bytes.length, true);
    data.setUint16(localOffset + 26, name.length, true);
    output.set(name, localOffset + 30);
    output.set(bytes, localOffset + 30 + name.length);
    data.setUint32(directoryOffset, 0x02014b50, true);
    data.setUint16(directoryOffset + 6, 20, true);
    data.setUint32(directoryOffset + 20, bytes.length, true);
    data.setUint32(directoryOffset + 24, bytes.length, true);
    data.setUint16(directoryOffset + 28, name.length, true);
    data.setUint32(directoryOffset + 42, localOffset, true);
    output.set(name, directoryOffset + 46);
    localOffset += 30 + name.length + bytes.length;
    directoryOffset += 46 + name.length;
  }
  const end = centralOffset + centralSize;
  data.setUint32(end, 0x06054b50, true);
  data.setUint16(end + 8, encoded.length, true);
  data.setUint16(end + 10, encoded.length, true);
  data.setUint32(end + 12, centralSize, true);
  data.setUint32(end + 16, centralOffset, true);
  return new File([buffer], "genome.zip");
}

test("ZIP files are extracted before parsing an explicitly selected provider", async () => {
  const file = storedZip("genome.txt", "# 23andMe raw data\nrs123\t1\t100\tAG\n");
  const result = await parseFileBlobWithDetection(file, () => {}, "23andme");
  expect(result.genotypes).toEqual([
    { rsid: "rs123", chromosome: "1", position: "100", genotype: "ag", strand: "unknown" },
  ]);
  expect(result.detectedFormat).toBe("23andme");
  expect(result.errors).toEqual([]);
});

test("ZIP extraction preserves the selected parser for a file without identifying headers", async () => {
  const file = storedZip("genome.txt", "rs123\t1\t100\tAG\n");
  const result = await parseFileBlobWithDetection(file, () => {}, "23andme");
  expect(result.genotypes).toEqual([
    { rsid: "rs123", chromosome: "1", position: "100", genotype: "ag", strand: "unknown" },
  ]);
  expect(result.detectedFormat).toBe("23andme");
});

test("ZIP selection skips README and unrelated HTML before the actual report", async () => {
  const file = archive([
    { filename: "README.txt", content: "Instructions for opening your Promethease report." },
    { filename: "help.html", content: "<html>Promethease instructions</html>" },
    {
      filename: "report.html",
      content:
        '<html><title>Promethease</title><script>var mygenos=[{"rsnum":"rs100","was":"(A;G)","reference":37}];</script></html>',
    },
  ]);
  const result = await parseFileBlobWithDetection(file, () => {});
  expect(result.detectedFormat).toBe("promethease");
  expect(result.genotypes).toHaveLength(1);
  expect(result.genotypes[0].strand).toBe("unknown");
});

test("ZIP content detection finds embedded report data beyond a raw-file header sample", async () => {
  const file = storedZip(
    "report.html",
    "<html><title>Promethease</title>" +
      " ".repeat(300000) +
      '<script>var mygenos=[{"rsnum":"rs100","was":"(A;G)"}];</script></html>',
  );
  const result = await parseFileBlobWithDetection(file, () => {});
  expect(result.detectedFormat).toBe("promethease");
});

test("manual provider selection skips a README before a headerless raw file", async () => {
  const file = archive([
    { filename: "README.txt", content: "This archive contains a raw genotype export." },
    { filename: "genome.txt", content: "rs123\t1\t100\tAG\n" },
  ]);
  const result = await parseFileBlobWithDetection(file, () => {}, "23andme");
  expect(result.genotypes).toHaveLength(1);
});

test("ZIP files with multiple recognizable inputs require an explicit file choice", async () => {
  const file = archive([
    { filename: "first.txt", content: "# 23andMe raw data\nrs123\t1\t100\tAG\n" },
    { filename: "second.txt", content: "# 23andMe raw data\nrs124\t1\t101\tAA\n" },
  ]);
  await expect(parseFileBlobWithDetection(file, () => {})).rejects.toThrow("multiple supported");
});

test("ZIP files containing only documentation do not invoke a raw parser", async () => {
  const file = archive([
    { filename: "README.txt", content: "Raw DNA instructions" },
    { filename: "guide.html", content: "<html>Read your report</html>" },
  ]);
  await expect(parseFileBlobWithDetection(file, () => {})).rejects.toThrow("No supported");
});

test("ZIP selection skips platform metadata copies of a recognized file", async () => {
  const content = "# 23andMe raw data\nrs123\t1\t100\tAG\n";
  const file = archive([
    { filename: "__MACOSX/._genome.txt", content },
    { filename: "genome.txt", content },
  ]);
  expect((await parseFileBlobWithDetection(file, () => {})).genotypes).toHaveLength(1);
});

test("VCF archives with long metadata headers reach the streaming parser", async () => {
  const content =
    "##fileformat=VCFv4.2\n##reference=GRCh38\n" +
    "##description=metadata\n".repeat(600) +
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE\n1\t100\trs100\tA\tG\t.\tPASS\t.\tGT\t0/1\n";
  const result = await parseFileBlobWithDetection(storedZip("genome.vcf", content), () => {});
  expect(result.detectedFormat).toBe("vcf");
  expect(result.genotypes).toHaveLength(1);
  expect(result.genotypes[0].strand).toBe("plus");
});

test("app imports make missing strand explicit for every raw call before matching", async () => {
  const sources = [
    ["23andme", "# 23andMe raw data\nrs123\t1\t100\tAG\nrs124\t1\t101\tCC\nrs125\t1\t102\tTT\n"],
    [
      "vitagene",
      "# Vitagene raw data\nRSID,CHROMOSOME,POSITION,RESULT\nrs123,1,100,AG\nrs124,1,101,CC\nrs125,1,102,TT\n",
    ],
    [
      "color",
      "SampleID,Chromosome,Position,RSID,Genotype,ReferenceVersion\nsynthetic,1,100,rs123,AG,GRCh37\nsynthetic,1,101,rs124,CC,GRCh37\nsynthetic,1,102,rs125,TT,GRCh37\n",
    ],
  ];
  for (const [parserId, content] of sources) {
    const results = [
      await parseFileWithDetection(content, () => {}, parserId),
      await parseFileWithDetection(content, () => {}),
      await parseFileBlobWithDetection(new File([content], "genome.txt"), () => {}, parserId),
      await parseFileBlobWithDetection(storedZip("genome.txt", content), () => {}),
    ];
    for (const result of results) {
      expect(result.detectedFormat).toBe(parserId);
      expect(result.genotypes).toHaveLength(3);
      expect(result.genotypes.map((call) => call.strand)).toEqual(["unknown", "unknown", "unknown"]);
    }
  }
});

test("app import strand defaults preserve explicit plus and minus declarations", async () => {
  for (const strand of ["plus", "minus"]) {
    const content = `# 23andMe raw data\n# ${strand} strand\nrs123\t1\t100\tAG\n`;
    for (const result of [
      await parseFileWithDetection(content, () => {}),
      await parseFileBlobWithDetection(storedZip("genome.txt", content), () => {}),
    ]) {
      expect(result.genotypes).toHaveLength(1);
      expect(result.genotypes[0].strand).toBe(strand);
    }
  }
});

test("ZIP-contained BGZF uses the same block decoder for detection and parsing", async () => {
  const header =
    "##fileformat=VCFv4.5\n##reference=GRCh38\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE\n";
  const row = "1\t100\t.\tA\tAT\t.\tPASS\t.\tGT\t0/1\n";
  function block(text: string): Uint8Array {
    const input = new TextEncoder().encode(text);
    const compressed = deflateRawSync(input);
    const result = new Uint8Array(18 + compressed.byteLength + 8);
    result.set([0x1f, 0x8b, 0x08, 0x04, 0, 0, 0, 0, 0, 0xff, 6, 0, 0x42, 0x43, 2, 0]);
    new DataView(result.buffer).setUint16(16, result.byteLength - 1, true);
    result.set(compressed, 18);
    new DataView(result.buffer).setUint32(result.byteLength - 4, input.byteLength, true);
    return result;
  }
  const blocks = [block(header), block(row), block("")];
  const bytes = new Uint8Array(blocks.reduce((sum, current) => sum + current.byteLength, 0));
  let offset = 0;
  for (const current of blocks) {
    bytes.set(current, offset);
    offset += current.byteLength;
  }
  const original = globalThis.DecompressionStream;
  class RejectingGzip extends original {
    constructor(format: CompressionFormat) {
      if (format === "gzip") throw new Error("Native gzip does not support concatenated members");
      super(format);
    }
  }
  globalThis.DecompressionStream = RejectingGzip;
  try {
    const result = await parseFileBlobWithDetection(archive([{ filename: "genome.vcf.gz", content: bytes }]), () => {});
    expect(result.detectedFormat).toBe("vcf");
    expect(result.errors).toEqual([]);
    expect(result.genotypes).toHaveLength(1);
    expect(result.genotypes[0].alleles).toEqual(["A", "AT"]);
  } finally {
    globalThis.DecompressionStream = original;
  }
});

test("automatic and manual VCF selection support a generic gzip filename inside ZIP", async () => {
  const source =
    "##fileformat=VCFv4.5\n##reference=GRCh38\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE\n1\t100\t.\tA\tAT\t.\tPASS\t.\tGT\t0/1\n";
  const file = archive([{ filename: "genome.gz", content: gzipSync(source) }]);
  for (const parserId of [undefined, "vcf"]) {
    const result = await parseFileBlobWithDetection(file, () => {}, parserId);
    expect(result.detectedFormat).toBe("vcf");
    expect(result.genotypes).toHaveLength(1);
  }
});

test("a generic gzip file is detected as VCF from its decompressed header", async () => {
  const source =
    "##fileformat=VCFv4.5\n##reference=GRCh38\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE\n1\t100\t.\tA\tAT\t.\tPASS\t.\tGT\t0/1\n";
  const result = await parseFileBlobWithDetection(new File([gzipSync(source)], "genome.gz"), () => {});
  expect(result.detectedFormat).toBe("vcf");
  expect(result.genotypes).toHaveLength(1);
  await expect(
    parseFileBlobWithDetection(new File([gzipSync("Unrelated document")], "document.gz"), () => {}),
  ).rejects.toThrow("Could not detect file format");
});
