import wtf from "wtf_wikipedia";
import wtf_plugin_html from "wtf-plugin-html";

wtf.extend(wtf_plugin_html);

/**
 * Parses WikiMedia content and returns structured data
 */
export function parseWikiContent(content: string) {
  if (!content) return null;

  try {
    const doc = wtf(content);

    // Get text with links resolved
    const text = doc.text();

    // Convert the text, adding styling to what looks like linked terms
    // We'll use a simple approach - preserve the text as is but format it nicely
    const html = doc.html();

    return {
      text,
      html,
    };
  } catch (error) {
    console.error("Error parsing wiki content:", error);
    return null;
  }
}

/**
 * Extracts template data from WikiMedia content
 * For example, extracts Genotype template parameters
 */
export function extractTemplateData(content: string, templateName: string): Record<string, string> | null {
  if (!content) return null;

  try {
    const doc = wtf(content);
    const templates = doc.templates();

    if (!templates || templates.length === 0) return null;

    // Find the template by name - templates() returns an array of Template objects
    // We need to get the data from each template
    for (const template of templates) {
      const data = template.json() as Record<string, unknown>;

      // Check if this is the template we're looking for
      if (typeof data.template === "string" && data.template.toLowerCase() === templateName.toLowerCase()) {
        const params: Record<string, string> = {};

        // Extract all parameters
        Object.entries(data).forEach(([key, value]) => {
          if (key !== "template" && value !== null && value !== undefined) {
            params[key] = String(value);
          }
        });

        return params;
      }
    }

    return null;
  } catch (error) {
    console.error("Error extracting template data:", error);
    return null;
  }
}
