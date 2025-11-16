import InfoboxParser from "infobox-parser";

/**
 * Parses WikiMedia content and returns structured data
 */
export function parseWikiContent(content: string) {
  if (!content) return null;

  try {
    // Remove templates from content to get the remaining text
    const textWithoutTemplates = content.replace(/\{\{[^}]*\}\}/g, "").trim();

    // Parse wiki links [[Link]] or [[Link|Display]]
    let html = textWithoutTemplates.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, link, display) => {
      const displayText = display || link;
      return `<a href="https://www.snpedia.com/index.php/${link}" target="_blank" class="cursor-pointer text-blue-600 font-medium">${displayText}</a>`;
    });

    // Convert newlines to paragraphs
    html = html
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed) {
          return `<p class="mb-2">${trimmed}</p>`;
        }
        return "";
      })
      .filter((line) => line)
      .join("");

    return {
      text: textWithoutTemplates,
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
export function extractTemplateData(content: string): Record<string, unknown> | null {
  if (!content) return null;

  try {
    // Use infobox-parser to extract template data
    const parsed = InfoboxParser(content);

    // Find the template by name (case-insensitive)
    const template = parsed.general;

    if (!template) return null;
    return template;
  } catch (error) {
    console.error("Error extracting template data:", error);
    return null;
  }
}
