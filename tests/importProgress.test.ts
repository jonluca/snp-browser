import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { ImportProgress } from "../src/types/progress";
import { parseFileBlobWithDetection, parseFileWithDetection } from "../src/workers/fileParsing";

const raw = "# 23andMe raw data\nrs123\t1\t100\tAG\nrs124\t1\t101\tCC\nrs125\t1\t102\tTT\n";
const vcf =
  "##fileformat=VCFv4.2\n##reference=GRCh38\n" +
  "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE\n" +
  "1\t100\trs123\tA\tG\t.\tPASS\t.\tGT\t0/1\n";

/** A single uncompressed entry keeps archive progress tests independent of ZIP libraries. */
function zip(filename: string, content: string | Uint8Array): File {
  const name = new TextEncoder().encode(filename);
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const centralOffset = 30 + name.length + bytes.length;
  const endOffset = centralOffset + 46 + name.length;
  const buffer = new ArrayBuffer(endOffset + 22);
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
  data.setUint32(endOffset, 0x06054b50, true);
  data.setUint16(endOffset + 8, 1, true);
  data.setUint16(endOffset + 10, 1, true);
  data.setUint32(endOffset + 12, 46 + name.length, true);
  data.setUint32(endOffset + 16, centralOffset, true);
  return new File([buffer], "input.zip");
}

test("file reads announce an indeterminate stage before text loading and parser detection", async () => {
  const statuses: ImportProgress[] = [];
  class ObservedFile extends File {
    override async text() {
      expect(statuses.at(-1)).toEqual({ stage: "reading" });
      return super.text();
    }
  }
  const numeric: [number, number][] = [];
  const result = await parseFileBlobWithDetection(
    new ObservedFile([raw], "input.txt"),
    (current, total) => numeric.push([current, total]),
    undefined,
    (status) => statuses.push(status),
  );
  expect(result.detectedFormat).toBe("23andme");
  expect(statuses[0]).toEqual({ stage: "reading" });
  const parsingIndex = statuses.findIndex((status) => status.stage === "parsing");
  expect(statuses[parsingIndex - 1]).toEqual({ stage: "detecting" });
  expect(numeric).toEqual([[0, 5]]);
  expect(statuses.at(-1)).toEqual({ stage: "parsing", current: 5, total: 5, unit: "lines" });
});

test("VCF strings report lines while streamed VCF and gzip inputs report their actual input bytes", async () => {
  const textStatuses: ImportProgress[] = [];
  await parseFileWithDetection(
    vcf,
    () => undefined,
    undefined,
    (status) => textStatuses.push(status),
  );
  expect(textStatuses.at(-1)).toEqual({ stage: "parsing", unit: "lines", current: 5, total: 5 });

  const compressed = gzipSync(vcf);
  for (const [name, content] of [
    ["input.vcf", vcf],
    ["input.vcf.gz", compressed],
    ["input.gz", compressed],
  ] as const) {
    for (const archived of [false, true]) {
      const file = archived ? zip(name, content) : new File([content], name);
      const inputSize = typeof content === "string" ? new TextEncoder().encode(content).length : content.length;
      const statuses: ImportProgress[] = [];
      const numeric: [number, number][] = [];
      const result = await parseFileBlobWithDetection(
        file,
        (current, total) => numeric.push([current, total]),
        undefined,
        (status) => statuses.push(status),
      );
      expect(result.detectedFormat).toBe("vcf");
      expect(result.genotypes).toHaveLength(1);
      expect(statuses.at(-1)).toEqual({ stage: "parsing", current: inputSize, total: inputSize, unit: "bytes" });
      expect(numeric.at(-1)).toEqual([inputSize, inputSize]);
      const parsingStatuses = statuses.filter((status) => status.stage === "parsing");
      expect(parsingStatuses.every((status) => status.unit === "bytes")).toBe(true);
      if (archived) {
        expect(statuses[0]).toEqual({ stage: "reading" });
        expect(statuses[1]).toEqual({ stage: "extracting" });
        expect(statuses.filter((status) => status.stage === "extracting").every((status) => !status.total)).toBe(true);
        expect(statuses.findIndex((status) => status.stage === "detecting")).toBeGreaterThan(1);
      }
    }
  }
});

test("units follow the selected parser inside ZIP rather than the upload filename", async () => {
  const html = '<html><title>Promethease</title><script>var mygenos=[{"rsnum":"rs123","was":"(A;G)"}];</script></html>';
  for (const [file, unit, total] of [
    [zip("input.txt", raw), "lines", 5],
    [zip("report.html", html), "characters", html.length],
  ] as const) {
    const statuses: ImportProgress[] = [];
    await parseFileBlobWithDetection(
      file,
      () => undefined,
      undefined,
      (status) => statuses.push(status),
    );
    expect(statuses.at(-1)).toEqual({ stage: "parsing", current: total, total, unit });
  }
});

function pdf(): File {
  const text = "BT /F1 12 Tf 72 720 Td (Synthetic report) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([body], "report.pdf");
}

test("PDF progress remains indeterminate until the real page count is available", async () => {
  const originalWorker = globalThis.Worker;
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: undefined });
  try {
    const statuses: ImportProgress[] = [];
    const numeric: [number, number][] = [];
    const result = await parseFileBlobWithDetection(
      pdf(),
      (current, total) => numeric.push([current, total]),
      undefined,
      (status) => statuses.push(status),
    );
    expect(result.report?.pages).toHaveLength(2);
    expect(statuses[0]).toEqual({ stage: "reading" });
    expect(numeric).toEqual([
      [0, 1],
      [1, 2],
      [2, 2],
    ]);
    expect(statuses.filter((status) => status.total !== undefined)).toEqual([
      { stage: "parsing", unit: "pages", current: 1, total: 2 },
      { stage: "parsing", unit: "pages", current: 2, total: 2 },
    ]);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test("read and detection failures retain the stage that failed without reporting parsing completion", async () => {
  const statuses: ImportProgress[] = [];
  class UnreadableFile extends File {
    override async text(): Promise<string> {
      expect(statuses.at(-1)).toEqual({ stage: "reading" });
      throw new Error("Unreadable input");
    }
  }
  await expect(
    parseFileBlobWithDetection(
      new UnreadableFile([raw], "input.txt"),
      () => undefined,
      "23andme",
      (status) => statuses.push(status),
    ),
  ).rejects.toThrow("Unreadable input");
  expect(statuses.at(-1)).toEqual({ stage: "reading" });
  statuses.length = 0;
  await expect(
    parseFileBlobWithDetection(
      new File(["Unrecognized input"], "input.txt"),
      () => undefined,
      undefined,
      (status) => statuses.push(status),
    ),
  ).rejects.toThrow("Could not detect file format");
  expect(statuses.at(-1)).toEqual({ stage: "detecting" });
  expect(statuses.some((status) => status.stage === "parsing")).toBe(false);
});
