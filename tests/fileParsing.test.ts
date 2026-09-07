import { expect, test } from "bun:test";
import { parseFileBlobWithDetection } from "../src/workers/fileParsing";

function storedZip(filename: string, content: string): File {
  const name = new TextEncoder().encode(filename);
  const bytes = new TextEncoder().encode(content);
  const centralOffset = 30 + name.length + bytes.length;
  const centralSize = 46 + name.length;
  const buffer = new ArrayBuffer(centralOffset + centralSize + 22);
  const data = new DataView(buffer);
  const output = new Uint8Array(buffer);
  data.setUint32(0, 0x04034b50, true);
  data.setUint16(4, 20, true);
  data.setUint32(18, bytes.length, true);
  data.setUint32(22, bytes.length, true);
  data.setUint16(26, name.length, true);
  output.set(name, 30);
  output.set(bytes, 30 + name.length);
  data.setUint32(centralOffset, 0x02014b50, true);
  data.setUint16(centralOffset + 6, 20, true);
  data.setUint32(centralOffset + 20, bytes.length, true);
  data.setUint32(centralOffset + 24, bytes.length, true);
  data.setUint16(centralOffset + 28, name.length, true);
  output.set(name, centralOffset + 46);
  const end = centralOffset + centralSize;
  data.setUint32(end, 0x06054b50, true);
  data.setUint16(end + 8, 1, true);
  data.setUint16(end + 10, 1, true);
  data.setUint32(end + 12, centralSize, true);
  data.setUint32(end + 16, centralOffset, true);
  return new File([buffer], "genome.zip");
}

test("ZIP files are extracted before parsing an explicitly selected provider", async () => {
  const file = storedZip("genome.txt", "# 23andMe raw data\nrs123\t1\t100\tAG\n");
  const result = await parseFileBlobWithDetection(file, () => {}, "23andme");
  expect(result.genotypes).toEqual([{ rsid: "rs123", chromosome: "1", position: "100", genotype: "ag" }]);
  expect(result.detectedFormat).toBe("23andme");
  expect(result.errors).toEqual([]);
});

test("ZIP extraction preserves the selected parser for a file without identifying headers", async () => {
  const file = storedZip("genome.txt", "rs123\t1\t100\tAG\n");
  const result = await parseFileBlobWithDetection(file, () => {}, "23andme");
  expect(result.genotypes).toEqual([{ rsid: "rs123", chromosome: "1", position: "100", genotype: "ag" }]);
  expect(result.detectedFormat).toBe("23andme");
});
