import InfoboxParser from "infobox-parser";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function removeTemplates(content: string): string {
  let output = "";
  let depth = 0;
  let templateStart = 0;

  for (let index = 0; index < content.length; index++) {
    const pair = content.slice(index, index + 2);
    if (pair === "{{") {
      if (depth === 0) templateStart = index;
      depth++;
      index++;
    } else if (pair === "}}" && depth > 0) {
      depth--;
      index++;
    } else if (depth === 0) {
      output += content[index];
    }
  }

  // Preserve incomplete markup instead of discarding the rest of the article.
  return output + (depth > 0 ? content.slice(templateStart) : "");
}

function renderWikiLinks(text: string): string {
  let html = "";
  let previousEnd = 0;

  for (const match of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const [markup, link, display] = match;
    html += escapeHtml(text.slice(previousEnd, match.index));
    const hashIndex = link.indexOf("#");
    const page = hashIndex < 0 ? link : link.slice(0, hashIndex);
    const fragment = hashIndex < 0 ? "" : `#${encodeURIComponent(link.slice(hashIndex + 1).replace(/ /g, "_"))}`;
    const href = `https://www.snpedia.com/index.php/${encodeURIComponent(page.replace(/ /g, "_"))}${fragment}`;
    html += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="cursor-pointer text-blue-600 font-medium">${escapeHtml(display || link)}</a>`;
    previousEnd = match.index + markup.length;
  }

  return html + escapeHtml(text.slice(previousEnd));
}

function renderWikiBlocks(text: string): string {
  const blocks: string[] = [];
  let listType: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listType) blocks.push(`</${listType}>`);
    listType = null;
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const listItem = trimmed.match(/^([*#])\s+(.+)$/);
    if (listItem) {
      const nextListType = listItem[1] === "*" ? "ul" : "ol";
      if (nextListType !== listType) {
        closeList();
        listType = nextListType;
        const marker = listType === "ul" ? "list-disc" : "list-decimal";
        blocks.push(`<${listType} class="my-3 ${marker} space-y-1 pl-5">`);
      }
      blocks.push(`<li>${renderWikiLinks(listItem[2])}</li>`);
      continue;
    }

    closeList();
    if (!trimmed) continue;

    const heading = trimmed.match(/^(=+)\s*(.*?)\s*(=+)$/);
    if (heading && heading[1] === heading[3] && heading[1].length >= 2 && heading[1].length <= 6 && heading[2]) {
      const level = heading[1].length;
      blocks.push(
        `<h${level} class="mb-3 mt-6 font-semibold text-slate-900">${renderWikiLinks(heading[2])}</h${level}>`,
      );
    } else {
      blocks.push(`<p class="mb-2">${renderWikiLinks(trimmed)}</p>`);
    }
  }

  closeList();
  return blocks.join("");
}

/**
 * Parses WikiMedia content and returns structured data
 */
export function parseWikiContent(content: string) {
  if (!content) return null;

  try {
    // Remove templates from content to get the remaining text
    const textWithoutTemplates = removeTemplates(content).trim();

    // Only our generated block/link markup is HTML; all source text is escaped.
    const html = renderWikiBlocks(textWithoutTemplates);

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
