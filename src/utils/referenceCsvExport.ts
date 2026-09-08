import type { AnnotationEvidence, ReferencePack } from "../types/annotations";
import type { SNPRecord } from "../types/snp";
import { MAX_REFERENCE_EXPORT_ROWS } from "../workers/snpSearch";
import { safeReferenceUrl } from "./annotationPresentation";
import { buildCsv, type CsvColumn } from "./csvExport";

interface ReferenceCsvRow {
  record: SNPRecord;
  annotation: AnnotationEvidence;
  pack?: ReferencePack;
}

const REFERENCE_COLUMNS: CsvColumn<ReferenceCsvRow>[] = [
  { header: "Display ID", value: ({ record }) => record.rsid },
  { header: "Source", value: ({ annotation }) => annotation.source },
  { header: "Source record ID", value: ({ annotation }) => annotation.id },
  { header: "Variant ID", value: ({ annotation }) => annotation.rsid },
  {
    header: "Aliases",
    value: ({ annotation }) => (annotation.aliases?.length ? JSON.stringify(annotation.aliases) : undefined),
  },
  { header: "Genome assembly", value: ({ annotation }) => annotation.assembly },
  { header: "Chromosome", value: ({ annotation }) => annotation.chromosome },
  { header: "Position", value: ({ annotation }) => annotation.position },
  { header: "REF", value: ({ annotation }) => annotation.ref },
  { header: "ALT", value: ({ annotation }) => annotation.alt },
  { header: "Gene", value: ({ annotation }) => annotation.gene },
  { header: "Evidence scope", value: ({ annotation }) => annotation.scope },
  { header: "Match type", value: ({ annotation }) => annotation.matchType },
  { header: "Match reason", value: ({ annotation }) => annotation.matchReason },
  { header: "Title", value: ({ annotation }) => annotation.title },
  { header: "Summary", value: ({ annotation }) => annotation.summary },
  { header: "Review status", value: ({ annotation }) => annotation.reviewStatus },
  { header: "Last evaluated", value: ({ annotation }) => annotation.lastEvaluated },
  {
    header: "Upstream release",
    value: ({ annotation, pack }) => annotation.fields.upstreamRelease ?? pack?.sourceRelease,
  },
  { header: "Reference pack ID", value: ({ pack }) => pack?.id },
  {
    header: "Reference pack version",
    value: ({ annotation, pack }) => annotation.fields.sourceVersion ?? pack?.version,
  },
  {
    header: "Reference built at",
    value: ({ annotation, pack }) => annotation.fields.referenceBuiltAt ?? pack?.builtAt,
  },
  {
    header: "Source URL",
    value: ({ annotation, record }) =>
      safeReferenceUrl(annotation.url) ||
      (record.referenceSource === annotation.source ? safeReferenceUrl(record.sourceUrl) : undefined),
  },
  // Structured citation text retains labels and URLs without inventing a
  // destination or flattening multiple publications into ambiguous prose.
  {
    header: "Citations",
    value: ({ annotation }) => (annotation.citations?.length ? JSON.stringify(annotation.citations) : undefined),
  },
];

/** Exports evidence rows in browser order, with a dedicated column for every source field. */
export function buildReferenceCsv(records: SNPRecord[], pack?: ReferencePack): string {
  const rows: ReferenceCsvRow[] = [];
  const fieldKeys = new Set<string>();
  for (const record of records) {
    if (!record.annotations?.length) {
      throw new Error("Source annotation evidence is missing from this export. Retry the export.");
    }
    if (rows.length + record.annotations.length > MAX_REFERENCE_EXPORT_ROWS) {
      throw new Error("Source CSV exports support up to 100,000 records. Narrow the search before exporting.");
    }
    for (const annotation of record.annotations) {
      rows.push({ record, annotation, pack: pack?.source === annotation.source ? pack : undefined });
      for (const key of Object.keys(annotation.fields)) fieldKeys.add(key);
    }
  }
  const columns = [...REFERENCE_COLUMNS];
  for (const key of fieldKeys) {
    columns.push({
      header: `Source field: ${key}`,
      value: ({ annotation }) => (Object.hasOwn(annotation.fields, key) ? annotation.fields[key] : undefined),
    });
  }
  return buildCsv(rows, columns);
}
