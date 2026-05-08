export interface SnpediaSourceFields {
  gene?: unknown;
  gene_s?: unknown;
  clin_gene_name?: unknown;
  clin_sig?: unknown;
  clin_disease?: unknown;
}

export interface SnpediaFields {
  geneSymbol?: string;
  magnitude?: number;
  repute?: string;
  summary?: string;
  clinicalSignificance?: string;
  disease?: string;
}

const FIELD_ALIASES = {
  geneSymbol: ["gene", "gene symbol", "genesymbol", "gene_s", "symbol", "clin_gene_name"],
  magnitude: ["magnitude"],
  repute: ["repute", "reputation"],
  summary: ["summary", "description"],
  clinicalSignificance: ["clin_sig", "clinical significance", "clinicalsignificance"],
  disease: ["clin_disease", "disease", "condition"],
} satisfies Record<keyof SnpediaFields, string[]>;

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

function stripReferenceMarkup(value: string): string {
  return value
    .replace(/==+\s*(references|external links|see also)\s*==+[\s\S]*$/i, "")
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref\b[^/>]*\/>/gi, "")
    .replace(/\{\{\s*(cite|citation)\b[\s\S]*?\}\}/gi, "");
}

function cleanWikiText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  const text = Array.isArray(value)
    ? value
        .map((item) => cleanWikiText(item))
        .filter(Boolean)
        .join("; ")
    : String(value);
  const cleaned = stripReferenceMarkup(text)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[(?:https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, "$1")
    .replace(/\[(?:https?:\/\/[^\s\]]+)\]/g, "")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > 0 ? cleaned : undefined;
}

function splitTemplateParameters(content: string): string[] {
  const start = content.indexOf("{{");
  const source = start >= 0 ? content.slice(start + 2) : content;
  const parameters: string[] = [];
  let current = "";
  let braceDepth = 0;
  let linkDepth = 0;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "{" && next === "{") {
      braceDepth++;
      current += char;
      continue;
    }

    if (char === "}" && next === "}") {
      if (braceDepth === 0) {
        parameters.push(current);
        break;
      }
      braceDepth--;
      current += char;
      continue;
    }

    if (char === "[" && next === "[") {
      linkDepth++;
      current += char;
      continue;
    }

    if (char === "]" && next === "]") {
      linkDepth = Math.max(0, linkDepth - 1);
      current += char;
      continue;
    }

    if (char === "|" && braceDepth === 0 && linkDepth === 0) {
      parameters.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parameters.push(current);
  }

  return parameters;
}

function extractTemplateFields(content: string): Map<string, string> {
  const fields = new Map<string, string>();
  const contentWithoutReferences = stripReferenceMarkup(content);

  for (const parameter of splitTemplateParameters(contentWithoutReferences)) {
    const separatorIndex = parameter.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = normalizeFieldName(parameter.slice(0, separatorIndex).trim());
    const value = parameter.slice(separatorIndex + 1).trim();
    if (key && value) {
      fields.set(key, value);
    }
  }

  return fields;
}

function getTemplateValue(fields: Map<string, string>, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const value = cleanWikiText(fields.get(normalizeFieldName(alias)));
    if (value) return value;
  }
  return undefined;
}

function getSourceValue(source: SnpediaSourceFields, keys: Array<keyof SnpediaSourceFields>): string | undefined {
  for (const key of keys) {
    const value = cleanWikiText(source[key]);
    if (value) return value;
  }
  return undefined;
}

export function extractMagnitude(content: string): number | undefined {
  const fields = extractTemplateFields(content);
  const templateMagnitude = getTemplateValue(fields, FIELD_ALIASES.magnitude);
  const magnitudeText = templateMagnitude ?? content.match(/magnitude[:\s=]+(\d+(?:\.\d+)?)/i)?.[1];

  if (!magnitudeText) return undefined;

  const magnitude = Number.parseFloat(magnitudeText);
  return Number.isFinite(magnitude) ? magnitude : undefined;
}

export function extractSnpediaFields(content: string, source: SnpediaSourceFields = {}): SnpediaFields {
  const fields = extractTemplateFields(content);

  return {
    geneSymbol:
      getSourceValue(source, ["gene", "gene_s", "clin_gene_name"]) ??
      getTemplateValue(fields, FIELD_ALIASES.geneSymbol),
    magnitude: extractMagnitude(content),
    repute: getTemplateValue(fields, FIELD_ALIASES.repute),
    summary: getTemplateValue(fields, FIELD_ALIASES.summary),
    clinicalSignificance:
      getSourceValue(source, ["clin_sig"]) ?? getTemplateValue(fields, FIELD_ALIASES.clinicalSignificance),
    disease: getSourceValue(source, ["clin_disease"]) ?? getTemplateValue(fields, FIELD_ALIASES.disease),
  };
}
