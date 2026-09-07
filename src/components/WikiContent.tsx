import { useMemo, type ReactElement } from "react";
import { extractSnpediaFields } from "../utils/snpediaFields";
import { plainWikiText } from "../utils/variantPresentation";
import { extractTemplateData, parseWikiContent } from "../utils/wikiParser";

interface WikiContentProps {
  content: string;
  className?: string;
  hideSummary?: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  rsid: "Variant ID",
  clin_sig: "Clinical significance",
  clin_disease: "Associated condition",
  clin_gene_name: "Gene",
  gene_s: "Genes",
  dbsnp: "dbSNP",
  omim: "OMIM",
  pmid: "PubMed ID",
  gmaf: "Global minor allele frequency",
};

function formatKey(key: string): string {
  return (
    FIELD_LABELS[key.toLowerCase()] ??
    key
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/^./, (character) => character.toUpperCase())
      .trim()
  );
}

function renderValue(key: string, value: unknown): ReactElement {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-400">Not provided</span>;
  }

  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;

  if (Array.isArray(value)) {
    return (
      <ul className="space-y-1">
        {value.map((item, index) => (
          <li key={index}>{renderValue(key, item)}</li>
        ))}
      </ul>
    );
  }

  if (typeof value === "object") {
    return <SourceFields data={value as Record<string, unknown>} nested />;
  }

  const text = String(value);
  if (key.toLowerCase() === "magnitude") {
    return <span className="font-mono font-semibold tabular-nums text-slate-900">{text}</span>;
  }

  // Source values stay ordinary React text; wiki-derived strings never become HTML.
  return <span>{text}</span>;
}

function SourceFields({ data, nested = false }: { data: Record<string, unknown>; nested?: boolean }) {
  const entries = Object.entries(data).filter(([, value]) => value !== null && value !== undefined);
  if (entries.length === 0) return null;

  return (
    <dl className={nested ? "space-y-3 border-l border-slate-200 pl-3" : "divide-y divide-slate-100"}>
      {entries.map(([key, value]) => (
        <div
          key={key}
          className={nested ? "min-w-0" : "grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-4"}
        >
          <dt className="text-xs font-medium leading-6 break-words text-slate-500">{formatKey(key)}</dt>
          <dd className="min-w-0 text-sm leading-6 break-words text-slate-800 [overflow-wrap:anywhere]">
            {renderValue(key, value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function WikiContent({ content, className = "", hideSummary = false }: WikiContentProps) {
  const parsedContent = useMemo(() => {
    if (!content) return null;

    const parsed = parseWikiContent(content);
    const templateData = extractTemplateData(content);
    const summary = plainWikiText(extractSnpediaFields(content).summary || "");

    return { templateData, summary, htmlContent: parsed?.html || "" };
  }, [content]);

  if (!parsedContent) return null;

  const { templateData, summary, htmlContent } = parsedContent;
  const fieldCount = templateData ? Object.keys(templateData).length : 0;

  return (
    <div className={`min-w-0 ${className}`}>
      {htmlContent ? (
        <div
          className="space-y-3 text-sm leading-7 break-words text-slate-700 [overflow-wrap:anywhere] [&_a]:text-brand-700 [&_a]:underline [&_a]:decoration-brand-100 [&_a]:underline-offset-3 hover:[&_a]:text-brand-700 [&_p]:mb-3"
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      ) : summary ? (
        !hideSummary && <p className="text-sm leading-7 break-words text-slate-700">{summary}</p>
      ) : (
        <p className="text-sm leading-6 text-slate-500">This entry contains source data without an article summary.</p>
      )}

      {templateData && fieldCount > 0 && (
        <details className="group mt-6 border-t border-slate-200 pt-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-sm font-medium text-slate-600 transition-colors hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600 [&::-webkit-details-marker]:hidden">
            <span>
              Source fields <span className="ml-1 font-normal text-slate-400">({fieldCount})</span>
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
            >
              <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </summary>
          <p className="mt-3 text-xs leading-5 text-slate-500">Structured information from the SNPedia entry.</p>
          <SourceFields data={templateData} />
        </details>
      )}
    </div>
  );
}
