import { useMemo, type ReactElement } from "react";
import { extractTemplateData, parseWikiContent } from "../utils/wikiParser";

interface WikiContentProps {
  content: string;
  className?: string;
}

/**
 * Formats a key name for display (converts camelCase/snake_case to Title Case)
 */
function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
}

/**
 * Determines if a value should be highlighted (e.g., magnitude)
 */
function shouldHighlight(key: string): boolean {
  return key.toLowerCase() === "magnitude";
}

/**
 * Gets color class for repute-like values
 */
function getValueColorClass(key: string, value: unknown): string {
  if (key.toLowerCase() === "repute" && typeof value === "string") {
    const lowerValue = value.toLowerCase();
    if (lowerValue === "bad" || lowerValue === "pathogenic") return "text-red-700 font-medium";
    if (lowerValue === "good" || lowerValue === "benign") return "text-brand-700 font-medium";
  }
  return "text-slate-900";
}

/**
 * Renders a single value with appropriate formatting
 */
function renderValue(key: string, value: unknown): ReactElement {
  // Null/undefined
  if (value === null || value === undefined) {
    return <span className="text-slate-400 italic">N/A</span>;
  }

  // Boolean
  if (typeof value === "boolean") {
    return <span className="text-slate-900">{value ? "Yes" : "No"}</span>;
  }

  // Number or String
  if (typeof value === "number" || typeof value === "string") {
    const stringValue = String(value);
    const colorClass = getValueColorClass(key, value);

    if (shouldHighlight(key)) {
      return <span className="rounded-full bg-violet-100 px-2 py-0.5 font-bold text-violet-800">{stringValue}</span>;
    }

    return <span className={colorClass}>{stringValue}</span>;
  }

  // Array - render as comma-separated list
  if (Array.isArray(value)) {
    return (
      <span className="text-slate-900">
        {value.map((item, idx) => (
          <span key={idx}>
            {idx > 0 && ", "}
            {String(item)}
          </span>
        ))}
      </span>
    );
  }

  // Object - render as nested structure
  if (typeof value === "object" && !Array.isArray(value)) {
    return <TemplateDataRenderer data={value as Record<string, unknown>} nested />;
  }

  // Fallback
  return <span className="text-slate-900">{String(value)}</span>;
}

/**
 * Component that renders template data (nested JSON) in a nice grid format
 */
function TemplateDataRenderer({ data, nested = false }: { data: Record<string, unknown>; nested?: boolean }) {
  const entries = Object.entries(data).filter(([, value]) => value !== null && value !== undefined);

  if (entries.length === 0) return null;

  return (
    <div className={`${nested ? "ml-4 mt-2 border-l-2 border-violet-200 pl-3" : "grid grid-cols-2 gap-2"} text-sm`}>
      {entries.map(([key, value]) => {
        const isLongText = typeof value === "string" && value.length > 60;
        const isSummaryLike = key.toLowerCase().includes("summary") || key.toLowerCase().includes("description");
        const shouldSpanFull = isLongText || isSummaryLike;

        if (nested) {
          // Nested rendering - simple key: value format
          return (
            <div key={key} className="mb-1">
              <span className="font-medium text-slate-700">{formatKey(key)}:</span> {renderValue(key, value)}
            </div>
          );
        }

        // Grid rendering
        if (shouldSpanFull) {
          return (
            <div key={key} className="col-span-2">
              <div className="mb-1 border-t border-violet-200 pt-2 font-medium text-slate-700">{formatKey(key)}:</div>
              <div className="text-slate-900">{renderValue(key, value)}</div>
            </div>
          );
        }

        return (
          <div key={key} className="contents">
            <div className="font-medium text-slate-700">{formatKey(key)}:</div>
            <div>{renderValue(key, value)}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Component that parses and displays WikiMedia formatted content
 */
export function WikiContent({ content, className = "" }: WikiContentProps) {
  const parsedContent = useMemo(() => {
    if (!content) return null;

    // Extract template data if present
    const templateData = extractTemplateData(content);

    // Parse the wiki content
    const parsed = parseWikiContent(content);
    if (!parsed) return null;

    return {
      templateData,
      htmlContent: parsed.html || "",
    };
  }, [content]);

  if (!parsedContent) return null;

  const { templateData, htmlContent } = parsedContent;

  return (
    <div className={className}>
      {/* Template Data */}
      {templateData && Object.keys(templateData).length > 0 && (
        <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 p-3">
          <div className="mb-2 font-semibold text-violet-900">Template Information</div>
          <TemplateDataRenderer data={templateData} />
        </div>
      )}

      {/* Remaining Content */}
      {htmlContent && (
        <div className="prose prose-sm max-w-none text-slate-800" dangerouslySetInnerHTML={{ __html: htmlContent }} />
      )}
    </div>
  );
}
