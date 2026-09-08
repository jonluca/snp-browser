import { expect, test } from "bun:test";
import type { AnnotationEvidence, ReferencePack } from "../src/types/annotations";
import type { SNPRecord } from "../src/types/snp";
import { buildReferenceCsv } from "../src/utils/referenceCsvExport";

/** Parse quoted CSV independently so multiline source values are verified whole. */
function csvRows(csv: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\r" || char === "\n")) {
      row.push(cell);
      cell = "";
      if (char !== ",") {
        rows.push(row);
        row = [];
        if (char === "\r" && csv[index + 1] === "\n") index++;
      }
    } else cell += char;
  }
  expect(quoted).toBe(false);
  row.push(cell);
  rows.push(row);
  const [headers, ...body] = rows;
  expect(new Set(headers).size).toBe(headers.length);
  return body.map((cells) => {
    expect(cells.length).toBe(headers.length);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  });
}

function evidence(overrides: Partial<AnnotationEvidence> = {}): AnnotationEvidence {
  return {
    id: "gwas:GCST000001:rs429358",
    source: "gwas",
    rsid: "rs429358",
    aliases: ["rsold1", "rsold2"],
    assembly: "GRCh38",
    chromosome: "19",
    position: 44908684,
    ref: "T",
    alt: "C",
    gene: "APOE",
    scope: "allele",
    matchType: "locus",
    matchReason: "Reference evidence; no uploaded genotype is interpreted.",
    title: "LDL cholesterol association",
    summary: "Reported association in a study population.",
    reviewStatus: "Literature curated",
    lastEvaluated: "2026-09-01",
    url: "https://www.ebi.ac.uk/gwas/studies/GCST000001",
    citations: [
      { label: 'Study "A", discovery cohort', url: "https://pubmed.ncbi.nlm.nih.gov/12345/" },
      { label: "Replication cohort", url: "https://pubmed.ncbi.nlm.nih.gov/67890/" },
    ],
    fields: {
      Trait: "LDL cholesterol",
      "Effect allele": "C",
      "Odds ratio": 1.18,
      Beta: -0.21,
      "P-value": 1e-10,
      Population: "European",
      "Sample size": 100000,
      upstreamRelease: "2026-09-01",
      sourceVersion: "curated-v3",
      referenceBuiltAt: "2026-09-06T12:00:00Z",
    },
    ...overrides,
  };
}

function record(annotations: AnnotationEvidence[], rsid = "rs429358"): SNPRecord {
  return { rsid, content: "Compact UI summary", referenceSource: annotations[0]?.source, annotations };
}

const pack: ReferencePack = {
  id: "gwas-full",
  source: "gwas",
  name: "GWAS Catalog",
  description: "Public reference fixture",
  version: "pack-fallback-v1",
  sourceRelease: "upstream-fallback-v1",
  builtAt: "2026-09-07T00:00:00Z",
  homepage: "https://www.ebi.ac.uk/gwas/",
  license: "Fixture",
  licenseUrl: "https://www.ebi.ac.uk/gwas/docs/faq",
  attribution: "Synthetic test records",
  recordCount: 2,
  coverage: "Fixture",
  shards: [],
};

test("GWAS CSV preserves study fields, variant identity, evidence, release metadata, and every citation", () => {
  const annotation = evidence();
  const [row] = csvRows(buildReferenceCsv([record([annotation])], pack));
  expect(row).toMatchObject({
    "Display ID": "rs429358",
    Source: "gwas",
    "Source record ID": annotation.id,
    "Variant ID": "rs429358",
    "Genome assembly": "GRCh38",
    Chromosome: "19",
    Position: "44908684",
    REF: "T",
    ALT: "C",
    Gene: "APOE",
    "Evidence scope": "allele",
    "Match type": "locus",
    "Match reason": annotation.matchReason,
    Title: annotation.title,
    Summary: annotation.summary,
    "Review status": "Literature curated",
    "Last evaluated": "2026-09-01",
    "Upstream release": "2026-09-01",
    "Reference pack ID": "gwas-full",
    "Reference pack version": "curated-v3",
    "Reference built at": "2026-09-06T12:00:00Z",
    "Source URL": annotation.url,
    "Source field: Trait": "LDL cholesterol",
    "Source field: Effect allele": "C",
    "Source field: Odds ratio": "1.18",
    "Source field: Beta": "-0.21",
    "Source field: P-value": "1e-10",
    "Source field: Population": "European",
    "Source field: Sample size": "100000",
    "Source field: upstreamRelease": "2026-09-01",
    "Source field: sourceVersion": "curated-v3",
    "Source field: referenceBuiltAt": "2026-09-06T12:00:00Z",
  });
  expect(JSON.parse(row.Aliases)).toEqual(annotation.aliases);
  expect(JSON.parse(row.Citations)).toEqual(annotation.citations);
});

test("each annotation remains a separate row with a union of GWAS and gnomAD fields and no invented rsID", () => {
  const gwas = evidence();
  const gnomad = evidence({
    id: "gnomad:19-44908684-T-C",
    source: "gnomad",
    rsid: undefined,
    aliases: undefined,
    fields: { AF: 0.147, AC: 147, AN: 1000, "AF African/African American": 0.201, "Homozygote count": 0 },
    url: "https://gnomad.broadinstitute.org/variant/19-44908684-T-C?dataset=gnomad_r4",
  });
  const rows = csvRows(buildReferenceCsv([record([gwas, gnomad], "19:44908684 T>C")], pack));
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row["Source record ID"])).toEqual([gwas.id, gnomad.id]);
  expect(rows[0]["Source field: AF"]).toBe("");
  expect(rows[1]).toMatchObject({
    "Display ID": "19:44908684 T>C",
    Source: "gnomad",
    "Variant ID": "",
    "Genome assembly": "GRCh38",
    Chromosome: "19",
    Position: "44908684",
    REF: "T",
    ALT: "C",
    "Source field: AF": "0.147",
    "Source field: AC": "147",
    "Source field: AN": "1000",
    "Source field: AF African/African American": "0.201",
    "Source field: Homozygote count": "0",
    "Source field: Trait": "",
    "Upstream release": "",
    "Reference pack ID": "",
    "Reference pack version": "",
    "Reference built at": "",
  });
});

test("pack metadata fills absent fields only for its own source", () => {
  const rows = csvRows(buildReferenceCsv([record([evidence({ fields: {} })])], pack));
  expect(rows[0]).toMatchObject({
    "Reference pack ID": pack.id,
    "Reference pack version": pack.version,
    "Upstream release": pack.sourceRelease,
    "Reference built at": pack.builtAt,
  });
});

test("source text round-trips quotes and newlines while spreadsheet formula strings stay inert", () => {
  const annotation = evidence({
    title: '=HYPERLINK("https://example.test","Open")',
    summary: 'First line, "quoted"\nSecond line',
    fields: {
      'Reported "trait", name': 'LDL, "fasting"\r\nRepeated measurement',
      Formula: "+SUM(A1:A2)",
      "Text beta": "-0.21",
      "Numeric beta": -0.21,
      Missing: null,
    },
  });
  const [row] = csvRows(buildReferenceCsv([record([annotation])]));
  expect(row.Title).toBe(`'${annotation.title}`);
  expect(row.Summary).toBe(annotation.summary);
  expect(row['Source field: Reported "trait", name']).toBe('LDL, "fasting"\r\nRepeated measurement');
  expect(row["Source field: Formula"]).toBe("'+SUM(A1:A2)");
  expect(row["Source field: Text beta"]).toBe("'-0.21");
  expect(row["Source field: Numeric beta"]).toBe("-0.21");
  expect(row["Source field: Missing"]).toBe("");
});

test("invalid or absent source links never become a fabricated SNPedia page", () => {
  const rows = csvRows(
    buildReferenceCsv([
      record([evidence({ url: "javascript:alert(1)" })]),
      record([evidence({ id: "gwas:missing-url", url: "" })]),
    ]),
  );
  expect(rows.map((row) => row["Source URL"])).toEqual(["", ""]);
  expect(rows.every((row) => !row["Source URL"].includes("snpedia"))).toBe(true);
});

test("a supplied record URL is reused only for evidence from the same source", () => {
  const entry = record([evidence({ url: "" }), evidence({ id: "gnomad:other-source", source: "gnomad", url: "" })]);
  entry.sourceUrl = "https://www.ebi.ac.uk/gwas/studies/GCST000001";
  const rows = csvRows(buildReferenceCsv([entry]));
  expect(rows.map((row) => row["Source URL"])).toEqual([entry.sourceUrl, ""]);
});

test("export rejects missing evidence instead of silently dropping rows or substituting the UI summary", () => {
  expect(() => buildReferenceCsv([{ rsid: "rs1", content: "Summary without evidence" }])).toThrow();
  expect(() => buildReferenceCsv([record([])])).toThrow();
  expect(() => buildReferenceCsv([record([evidence()]), record([])])).toThrow();
});

test("the row limit counts annotations rather than input records", () => {
  const annotation = evidence();
  const tooMany = record(Array.from({ length: 100001 }, () => annotation));
  expect(() => buildReferenceCsv([tooMany])).toThrow(/100,000|100000/);
});
