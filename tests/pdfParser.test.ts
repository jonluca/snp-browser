import { afterEach, beforeEach, expect, test } from "bun:test";
import { parsePdfReport } from "../src/parsers/pdf";

const originalWorker = globalThis.Worker;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // PDF.js uses its in-process worker in Node/Bun. Browser worker startup is
  // checked in the app's production build; extraction here uses real PDF.js.
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: undefined });
  globalThis.fetch = (() => {
    throw new Error("PDF parsing must not fetch document resources.");
  }) as typeof fetch;
  Reflect.deleteProperty(globalThis, "__pdfReportActionExecuted");
});

afterEach(() => {
  globalThis.Worker = originalWorker;
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "__pdfReportActionExecuted");
});

/** Tiny in-memory PDF fixtures contain only synthetic report text. */
function pdf(pages: string[][], encrypted = false): File {
  const escape = (text: string) => text.replace(/[\\()]/g, "\\$&");
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (globalThis.__pdfReportActionExecuted = true) >> >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, lines] of pages.entries()) {
    const content = lines.length
      ? `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((line) => `(${escape(line)}) Tj T*`).join(" ")} ET`
      : "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  if (encrypted) {
    objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<${"00".repeat(16)}> <${"00".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([body], "synthetic-report.pdf", { type: "application/pdf" });
}

test("PDF reports preserve every text page and never infer genotype calls from variant mentions", async () => {
  const progress: [number, number][] = [];
  const result = await parsePdfReport(
    pdf([
      ["Synthetic report", "A variant mention: rs123 A/G is narrative, not a raw call."],
      ["Second page", "An original citation: https://example.invalid/reference"],
    ]),
    (current, total) => progress.push([current, total]),
  );
  expect(result.genotypes).toEqual([]);
  expect(Reflect.get(globalThis, "__pdfReportActionExecuted")).toBeUndefined();
  expect(result.errors).toEqual([]);
  expect(result.report).toMatchObject({ format: "pdf", title: "synthetic-report" });
  expect(result.report?.pages.map((page) => page.page)).toEqual([1, 2]);
  expect(result.report?.pages[0].text).toBe(
    "Synthetic report\nA variant mention: rs123 A/G is narrative, not a raw call.",
  );
  expect(result.report?.pages[1].text).toBe("Second page\nAn original citation: https://example.invalid/reference");
  expect(result.totalLines).toBe(4);
  expect(progress[0]).toEqual([0, 1]);
  expect(progress.at(-1)).toEqual([2, 2]);
});

test("empty pages retain their original page numbers and receive an explicit note", async () => {
  const result = await parsePdfReport(pdf([["First page"], [], ["Third page"]]), () => undefined);
  expect(result.report?.pages).toEqual([
    { page: 1, text: "First page" },
    { page: 2, text: "" },
    { page: 3, text: "Third page" },
  ]);
  expect(result.report?.notes.some((note) => note.includes("1 page has no extractable text"))).toBe(true);
});

test("image-only PDFs return an actionable local OCR error without invented data", async () => {
  const result = await parsePdfReport(pdf([[]]), () => undefined);
  expect(result.report).toBeUndefined();
  expect(result.genotypes).toEqual([]);
  expect(result.errors[0]).toContain("Run OCR locally");
});

test("password-protected, empty and invalid PDFs receive useful errors", async () => {
  await expect(parsePdfReport(pdf([["Encrypted synthetic page"]], true), () => undefined)).rejects.toThrow(
    "password-protected",
  );
  await expect(parsePdfReport(new Blob([]), () => undefined)).rejects.toThrow("PDF is empty");
  await expect(parsePdfReport(new Blob(["not a PDF"]), () => undefined)).rejects.toThrow("not a readable PDF");
});

test("aborting from progress stops extraction and a later PDF import still succeeds", async () => {
  const error = new DOMException("Canceled", "AbortError");
  await expect(
    parsePdfReport(pdf([["First page"], ["Second page"]]), (current) => {
      if (current > 0) throw error;
    }),
  ).rejects.toThrow("Canceled");
  const result = await parsePdfReport(pdf([["A later synthetic report"]]), () => undefined);
  expect(result.report?.pages[0].text).toBe("A later synthetic report");
});
