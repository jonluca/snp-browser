import type { AnnotationEvidence, AnnotationSource } from "../types/annotations";
import { useState } from "react";
import {
  ANNOTATION_SOURCE_NAMES,
  ANNOTATION_SOURCE_ORDER,
  annotationFieldLabel,
  safeReferenceUrl,
} from "../utils/annotationPresentation";

interface AnnotationDetailsProps {
  annotations: AnnotationEvidence[];
  loading?: boolean;
  error?: string | null;
}

const MATCH_LABELS: Record<AnnotationEvidence["matchType"], string> = {
  allele: "Called allele confirmed",
  locus: "Variant context",
  gene: "Gene context",
  unresolved: "Allele match unresolved",
};

const SOURCE_CONTEXT: Partial<Record<AnnotationSource, string>> = {
  clinvar: "Submitted interpretations may differ. Review status and evaluation dates reflect the source.",
  gnomad: "Population frequencies describe the sampled groups and quality filters in this source.",
  gwas: "Associations describe the reported study population, effect estimate, and statistical evidence.",
  ensembl: "Predicted consequences depend on the annotated transcript and reference release.",
  clinpgx: "Drug-response interpretation can depend on additional variants, phase, and diplotypes.",
  cpic: "Gene–drug guideline context can depend on a complete diplotype and other clinical information.",
};

const PRIMARY_FIELDS = new Set([
  "clnsig",
  "clinicalsignificance",
  "germlineclassification",
  "clnsigconf",
  "conflicts",
  "clndn",
  "phenotypelist",
  "af",
  "ac",
  "an",
  "afjoint",
  "filter",
  "pvalue",
  "ororbeta",
  "95citext",
  "initialsamplesize",
  "replicationsamplesize",
  "strongestsnpriskallele",
  "riskallelefrequency",
  "population",
  "ancestry",
  "ancestrydescription",
  "levelofevidence",
  "drug",
  "drugname",
  "cpiclevel",
  "clinpgxlevel",
  "usedforrecommendation",
  "provisional",
  "drugs",
  "phenotypes",
  "diplotype",
  "consequence",
  "consequenceterms",
  "transcriptid",
  "hgvsc",
  "hgvsp",
]);

function normalizedField(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fieldText(value: string | number | null): string {
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" || typeof item === "number")) {
        return parsed.join("; ");
      }
    } catch {
      // Preserve source text that is not a JSON array.
    }
  }
  return String(value);
}

function EvidenceFields({ entries }: { entries: Array<[string, string | number | null]> }) {
  return (
    <dl className="divide-y divide-slate-100">
      {entries.map(([key, value]) => (
        <div key={key} className="grid min-w-0 gap-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)] sm:gap-4">
          <dt className="text-xs leading-5 text-slate-500">{annotationFieldLabel(key)}</dt>
          <dd className="min-w-0 text-xs leading-5 break-words text-slate-800 [overflow-wrap:anywhere]">
            {fieldText(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EvidenceCard({ annotation }: { annotation: AnnotationEvidence }) {
  const { fields } = annotation;
  const sourceUrl = safeReferenceUrl(annotation.url);
  const entries = Object.entries(fields).filter(
    ([key, value]) =>
      value !== null &&
      value !== "" &&
      !["sourceversion", "referencebuiltat", "upstreamrelease"].includes(normalizedField(key)),
  );
  const primary = entries.filter(([key]) => PRIMARY_FIELDS.has(normalizedField(key)));
  const secondary = entries.filter(([key]) => !PRIMARY_FIELDS.has(normalizedField(key)));
  const citations = new Map(
    (annotation.citations ?? []).flatMap((citation) => {
      const url = safeReferenceUrl(citation.url);
      return url ? [[url, citation.label] as const] : [];
    }),
  );
  const release = fields.sourceVersion;
  const releaseDate = fields.referenceBuiltAt;
  const upstreamRelease = fields.upstreamRelease;
  const locus =
    annotation.chromosome && annotation.position
      ? `${annotation.chromosome}:${annotation.position.toLocaleString()}`
      : undefined;

  return (
    <article className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span className="tag">{MATCH_LABELS[annotation.matchType]}</span>
        {annotation.gene && <span className="font-medium break-words text-slate-700">{annotation.gene}</span>}
        {annotation.assembly && <span>{annotation.assembly}</span>}
        {locus && <span className="font-mono">{locus}</span>}
        {annotation.alt && (
          <span className="font-mono">
            {annotation.ref ? `${annotation.ref} → ${annotation.alt}` : `Allele ${annotation.alt}`}
          </span>
        )}
      </div>
      {annotation.matchReason && (
        <p className="mt-2 text-xs leading-5 break-words text-slate-500">{annotation.matchReason}</p>
      )}
      <h4 className="mt-4 text-sm font-semibold leading-6 break-words text-slate-900">{annotation.title}</h4>
      {annotation.summary && (
        <p className="mt-1.5 text-sm leading-6 break-words text-slate-600 [overflow-wrap:anywhere]">
          {annotation.summary}
        </p>
      )}

      {(annotation.reviewStatus || annotation.lastEvaluated || release || releaseDate || upstreamRelease) && (
        <dl className="mt-4 space-y-1.5 rounded-lg bg-slate-50 px-3 py-2.5 text-xs leading-5">
          {annotation.reviewStatus && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-slate-500">Review / evidence status</dt>
              <dd className="min-w-0 break-words text-slate-700">{annotation.reviewStatus}</dd>
            </div>
          )}
          {annotation.lastEvaluated && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-slate-500">Last evaluated</dt>
              <dd className="text-slate-700">{annotation.lastEvaluated}</dd>
            </div>
          )}
          {upstreamRelease && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-slate-500">Source release</dt>
              <dd className="min-w-0 break-words text-slate-700">{upstreamRelease}</dd>
            </div>
          )}
          {release && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-slate-500">Reference pack</dt>
              <dd className="min-w-0 break-words text-slate-700">{release}</dd>
            </div>
          )}
          {releaseDate && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-slate-500">Pack prepared</dt>
              <dd className="min-w-0 break-words text-slate-700">{releaseDate}</dd>
            </div>
          )}
        </dl>
      )}

      {primary.length > 0 && (
        <div className="mt-3">
          <EvidenceFields entries={primary} />
        </div>
      )}
      {secondary.length > 0 && (
        <details className="mt-3 border-t border-slate-100 pt-3">
          <summary className="w-fit cursor-pointer rounded-sm text-xs font-medium text-slate-500 hover:text-brand-700">
            {primary.length ? "More source fields" : "Source fields"} ({secondary.length})
          </summary>
          <div className="mt-2">
            <EvidenceFields entries={secondary} />
          </div>
        </details>
      )}
      {(sourceUrl || citations.size > 0) && (
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-slate-100 pt-3 text-xs leading-5">
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-700 underline underline-offset-2"
            >
              View source record ↗
            </a>
          )}
          {[...citations].map(([url, label]) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="break-words text-brand-700 underline underline-offset-2"
            >
              {label} ↗
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function EvidenceGroup({ source, records }: { source: AnnotationSource; records: AnnotationEvidence[] }) {
  const [visible, setVisible] = useState(5);
  return (
    <section aria-label={`${ANNOTATION_SOURCE_NAMES[source]} evidence`}>
      <div className="mb-3">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
          {ANNOTATION_SOURCE_NAMES[source]}
          <span className="font-normal tabular-nums text-slate-400">
            {records.length.toLocaleString()} {records.length === 1 ? "record" : "records"}
          </span>
        </h3>
        {SOURCE_CONTEXT[source] && <p className="mt-1.5 text-xs leading-5 text-slate-500">{SOURCE_CONTEXT[source]}</p>}
      </div>
      <div className="space-y-3">
        {records.slice(0, visible).map((annotation) => (
          <EvidenceCard key={annotation.id} annotation={annotation} />
        ))}
      </div>
      {visible < records.length && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            Showing {visible.toLocaleString()} of {records.length.toLocaleString()} records
          </p>
          <button type="button" onClick={() => setVisible((count) => count + 10)} className="secondary-button text-xs">
            Show more {ANNOTATION_SOURCE_NAMES[source]} records
          </button>
        </div>
      )}
    </section>
  );
}

export function AnnotationDetails({ annotations, loading = false, error }: AnnotationDetailsProps) {
  if (loading)
    return (
      <p role="status" className="py-5 text-sm text-slate-500">
        Looking up downloaded references…
      </p>
    );
  if (error)
    return (
      <p
        role="alert"
        className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-6 break-words text-slate-700"
      >
        {error}
      </p>
    );
  if (annotations.length === 0)
    return (
      <p className="py-5 text-sm leading-6 text-slate-500">
        No additional records for this variant in the enabled reference packs. Coverage varies by source.
      </p>
    );

  return (
    <div className="mt-6 min-w-0 space-y-7 border-t border-slate-100 pt-6" aria-label="Additional reference evidence">
      {ANNOTATION_SOURCE_ORDER.map((source) => {
        const records = annotations.filter((annotation) => annotation.source === source);
        if (records.length === 0) return null;
        return <EvidenceGroup key={`${source}:${records[0].id}`} source={source} records={records} />;
      })}
    </div>
  );
}
