import { useMemo } from "react";
import { extractTemplateData, parseWikiContent } from "../utils/wikiParser";

interface WikiContentProps {
  content: string;
  className?: string;
}

/**
 * Component that parses and displays WikiMedia formatted content
 */
export function WikiContent({ content, className = "" }: WikiContentProps) {
  const parsedContent = useMemo(() => {
    if (!content) return null;

    // Extract genotype template data if present
    const genotypeData = extractTemplateData(content, "Genotype");

    // Parse the wiki content using wtf_wikipedia
    const parsed = parseWikiContent(content);
    if (!parsed) return null;

    // Get the HTML output which will have links and formatting parsed
    let htmlContent = parsed.html || "";

    // Remove the template from the HTML output
    htmlContent = htmlContent.replace(/<div class="template"[^>]*>[\s\S]*?<\/div>/gi, "").trim();

    return {
      genotypeData,
      htmlContent,
    };
  }, [content]);

  if (!parsedContent) return null;

  const { genotypeData, htmlContent } = parsedContent;

  return (
    <div className={className}>
      {/* Genotype Template Data */}
      {genotypeData && (
        <div className="mb-4 rounded-lg border border-purple-200 bg-purple-50 p-3">
          <div className="mb-2 font-semibold text-purple-900">Genotype Information</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {genotypeData.rsid && (
              <>
                <div className="font-medium text-gray-700">RSID:</div>
                <div className="text-gray-900">{genotypeData.rsid}</div>
              </>
            )}
            {genotypeData.allele1 && genotypeData.allele2 && (
              <>
                <div className="font-medium text-gray-700">Alleles:</div>
                <div className="text-gray-900">
                  {genotypeData.allele1}/{genotypeData.allele2}
                </div>
              </>
            )}
            {genotypeData.magnitude && (
              <>
                <div className="font-medium text-gray-700">Magnitude:</div>
                <div className="text-gray-900">
                  <span className="rounded bg-purple-100 px-2 py-0.5 font-bold text-purple-800">
                    {genotypeData.magnitude}
                  </span>
                </div>
              </>
            )}
            {genotypeData.repute && (
              <>
                <div className="font-medium text-gray-700">Repute:</div>
                <div
                  className={`font-medium ${
                    genotypeData.repute.toLowerCase() === "bad"
                      ? "text-red-600"
                      : genotypeData.repute.toLowerCase() === "good"
                        ? "text-green-600"
                        : "text-gray-900"
                  }`}
                >
                  {genotypeData.repute}
                </div>
              </>
            )}
            {genotypeData.summary && (
              <>
                <div className="col-span-2 mt-2 border-t border-purple-200 pt-2 font-medium text-gray-700">
                  Summary:
                </div>
                <div className="col-span-2 text-gray-900">{genotypeData.summary}</div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Remaining Content */}
      {htmlContent && (
        <div className="prose prose-sm max-w-none text-gray-800" dangerouslySetInnerHTML={{ __html: htmlContent }} />
      )}
    </div>
  );
}
