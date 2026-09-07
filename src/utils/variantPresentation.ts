import type { SNPRecord } from "../types/snp";
import { extractSnpediaFields, type SnpediaFields } from "./snpediaFields";

// Previews only need plain text. One scan handles nested templates without
// parsing a full article or requiring a browser DOM for every visible result.
function removeTemplates(text: string): string {
  let result = "";
  let depth = 0;

  for (let index = 0; index < text.length; index++) {
    const pair = text.slice(index, index + 2);
    if (pair === "{{") {
      if (depth === 0) result += " ";
      depth++;
      index++;
    } else if (pair === "}}") {
      depth = Math.max(0, depth - 1);
      index++;
    } else if (depth === 0) {
      result += text[index];
    }
  }

  return result;
}

const TEXT_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeTextEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return TEXT_ENTITIES[name.toLowerCase()] ?? entity;

    const hexadecimal = name[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (codePoint < 32 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return " ";
    return String.fromCodePoint(codePoint);
  });
}

/** Produces display text only. Always render the result as text, never as HTML. */
export function plainWikiText(text: string): string {
  const withoutReferences = decodeTextEntities(text)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<ref\b[^>]*\/>/gi, " ")
    .replace(/<(ref|script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/==+\s*(references|external links|see also)\s*==+[\s\S]*$/i, "");

  return removeTemplates(withoutReferences)
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\{\|[\s\S]*?(?:\|\}|$)/g, " ")
    .replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[(?:https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, "$1")
    .replace(/\[(?:https?:\/\/[^\s\]]+)\]/g, " ")
    .replace(/'{2,}/g, "")
    .replace(/^\s*[#*:;]+\s*/gm, "")
    .replace(/={2,}/g, " ")
    .replace(/[[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function previewText(text: string): string {
  if (text.length <= 180) return text;
  const excerpt = text.slice(0, 179);
  const lastSpace = excerpt.lastIndexOf(" ");
  return `${excerpt.slice(0, lastSpace > 130 ? lastSpace : undefined).trimEnd()}…`;
}

export function getVariantPresentation(record: SNPRecord): SnpediaFields & { preview: string } {
  const extracted = extractSnpediaFields(record.content, record);
  const fields: SnpediaFields = {
    ...extracted,
    geneSymbol: extracted.geneSymbol ? plainWikiText(extracted.geneSymbol) || undefined : undefined,
    repute: extracted.repute ? plainWikiText(extracted.repute) || undefined : undefined,
    summary: extracted.summary ? plainWikiText(extracted.summary) || undefined : undefined,
    clinicalSignificance: extracted.clinicalSignificance
      ? plainWikiText(extracted.clinicalSignificance) || undefined
      : undefined,
    disease: extracted.disease ? plainWikiText(extracted.disease) || undefined : undefined,
  };

  return {
    ...fields,
    preview: previewText(fields.summary || plainWikiText(record.content) || "No summary available."),
  };
}
