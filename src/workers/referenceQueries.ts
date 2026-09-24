import type { Database } from "sql.js";
import type { VariantAnnotation } from "../types/annotations";
import type { SNPSearchFilters } from "./snpSearch";
import { normalizeRsid } from "../utils/variantIdentity";

export interface ReferenceLocation {
  assembly: string;
  chromosome: string;
  position: number;
}

export function lookupReferenceCoordinates(database: Database, locations: ReferenceLocation[]): VariantAnnotation[] {
  const result: VariantAnnotation[] = [];
  for (let offset = 0; offset < locations.length; offset += 300) {
    const batch = locations.slice(offset, offset + 300);
    const values = batch.flatMap((location) => [location.assembly, location.chromosome, location.position]);
    result.push(
      ...payloads(
        database,
        `WITH wanted(assembly, chromosome, position) AS (VALUES ${batch.map(() => "(?, ?, ?)").join(",")}) SELECT DISTINCT a.payload FROM annotations a JOIN wanted w ON a.assembly = w.assembly AND a.chromosome = w.chromosome AND a.position = w.position WHERE a.scope != 'gene'`,
        values,
      ),
    );
  }
  return result;
}

function payloads(database: Database, sql: string, values: (string | number)[]): VariantAnnotation[] {
  const statement = database.prepare(sql);
  try {
    statement.bind(values);
    const result: VariantAnnotation[] = [];
    while (statement.step()) {
      const row = statement.getAsObject();
      const annotation = JSON.parse(String(row.payload)) as VariantAnnotation;
      if (!annotation.id || !annotation.source || !annotation.title || !annotation.fields) {
        throw new Error("A reference record has an unsupported format.");
      }
      result.push(annotation);
    }
    return result;
  } finally {
    statement.free();
  }
}

export function lookupReferenceAnnotations(database: Database, rsids: string[]): VariantAnnotation[] {
  if (!rsids.length) return [];
  const result: VariantAnnotation[] = [];
  for (let offset = 0; offset < rsids.length; offset += 400) {
    const batch = rsids.slice(offset, offset + 400);
    const placeholders = batch.map(() => "?").join(",");
    result.push(
      ...payloads(database, `SELECT payload FROM annotations WHERE rsid COLLATE NOCASE IN (${placeholders})`, batch),
    );
  }
  return result;
}

export function lookupReferenceGenes(database: Database, genes: string[]): VariantAnnotation[] {
  if (!genes.length) return [];
  const result = new Map<string, VariantAnnotation>();
  for (let offset = 0; offset < genes.length; offset += 400) {
    const batch = genes.slice(offset, offset + 400);
    for (const annotation of payloads(
      database,
      `SELECT payload FROM annotations WHERE scope = 'gene' AND ${wholeGeneCondition(batch.map(() => "?").join(","))}`,
      batch,
    ))
      result.set(annotation.id, annotation);
  }
  return [...result.values()];
}

function wholeGeneCondition(placeholders: string): string {
  // Defensively enforce that this is a run of "?" parameter placeholders
  // (e.g. "?,?,?"), since the string below is interpolated into SQL text
  // rather than bound as a parameter.
  if (!/^\?(,\?)*$/.test(placeholders)) {
    throw new Error("Invalid placeholders for wholeGeneCondition.");
  }
  // Keep complete symbols: delimiters separate APOE from TOMM40, while the
  // hyphen in HLA-B and internal whitespace in a non-symbol remain intact.
  return `EXISTS (
    WITH RECURSIVE tokens(rest, symbol) AS (
      SELECT replace(replace(replace(replace(replace(replace(coalesce(gene, ''), char(9), ' '), char(10), ' '), char(13), ' '), ' - ', ','), ';', ','), '|', ',') || ',', ''
      UNION ALL
      SELECT substr(rest, instr(rest, ',') + 1), trim(substr(rest, 1, instr(rest, ',') - 1)) FROM tokens WHERE rest != ''
    ) SELECT 1 FROM tokens WHERE symbol COLLATE NOCASE IN (${placeholders})
  )`;
}

export function lookupReferenceAliases(database: Database, rsids: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let offset = 0; offset < rsids.length; offset += 400) {
    const batch = rsids.slice(offset, offset + 400);
    const statement = database.prepare(
      `SELECT alias, rsid FROM aliases WHERE alias COLLATE NOCASE IN (${batch.map(() => "?").join(",")})`,
    );
    try {
      statement.bind(batch);
      while (statement.step()) {
        const row = statement.getAsObject();
        result.set(String(row.alias).toLowerCase(), String(row.rsid).toLowerCase());
      }
    } finally {
      statement.free();
    }
  }
  return result;
}

// SQLite's default BINARY text order compares UTF-8 code points, and lower()
// folds ASCII only. Keep JS merging identical to the per-file SQL page order.
function sqliteTextOrder(left: string, right: string): number {
  for (let l = 0, r = 0; l < left.length && r < right.length; ) {
    const a = left.codePointAt(l)!;
    const b = right.codePointAt(r)!;
    if (a !== b) return a < b ? -1 : 1;
    l += a > 0xffff ? 2 : 1;
    r += b > 0xffff ? 2 : 1;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

export function referenceAnnotationOrder(
  a: VariantAnnotation,
  b: VariantAnnotation,
  filters: SNPSearchFilters,
): number {
  const key = (annotation: VariantAnnotation) =>
    (annotation.rsid || annotation.gene || annotation.id).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const term = filters.searchTerm?.trim().toLowerCase();
  const rank = (annotation: VariantAnnotation) =>
    !term ? 2 : key(annotation) === term ? 0 : key(annotation).startsWith(term) ? 1 : 2;
  if (!filters.sortBy || filters.sortBy === "relevance") {
    const difference = rank(a) - rank(b);
    if (difference) return difference;
  }
  const comparison = sqliteTextOrder(key(a), key(b));
  return comparison * (filters.sortBy === "rsid-desc" ? -1 : 1) || sqliteTextOrder(a.id, b.id);
}

export function searchReferenceAnnotations(
  database: Database,
  filters: SNPSearchFilters,
  options: { sourceOrder?: boolean; knownTotal?: number } = {},
): { annotations: VariantAnnotation[]; total: number } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const like = (column: string, value: string) => {
    conditions.push(`${column} LIKE ? ESCAPE '\\'`);
    params.push(`%${value.replace(/[\\%_]/g, "\\$&")}%`);
  };
  const term = filters.searchTerm?.trim();
  const mode = filters.referenceSearchMode ?? "variant";
  if (term && mode === "variant") {
    const rsid = normalizeRsid(term);
    if (!rsid) return { annotations: [], total: 0 };
    conditions.push("(rsid = ? COLLATE NOCASE OR rsid IN (SELECT rsid FROM aliases WHERE alias = ? COLLATE NOCASE))");
    params.push(rsid, rsid);
  } else if (term && mode === "gene") {
    conditions.push(wholeGeneCondition("?"));
    params.push(term);
  } else if (term) like("search_text", term);
  if (filters.gene?.trim()) like("gene", filters.gene.trim());
  if (filters.chromosome) {
    conditions.push("chromosome = ?");
    params.push(filters.chromosome);
  }
  // These fields retain the source's own terminology in the normalized payload.
  if (filters.clinicalSignificance) like("search_text", filters.clinicalSignificance);
  if (filters.disease?.trim()) like("search_text", filters.disease.trim());
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  let total = options.knownTotal ?? 0;
  if (options.knownTotal === undefined) {
    const count = database.prepare(`SELECT COUNT(*) AS total FROM annotations ${where}`);
    try {
      count.bind(params);
      if (count.step()) total = Number(count.getAsObject().total);
    } finally {
      count.free();
    }
  }
  const key = "lower(coalesce(nullif(rsid, ''), nullif(gene, ''), id))";
  let order = `${key} ${filters.sortBy === "rsid-desc" ? "DESC" : "ASC"}, id ASC`;
  const rankedTerm = term?.toLowerCase();
  const orderParams: string[] = [];
  if (!options.sourceOrder && rankedTerm && (!filters.sortBy || filters.sortBy === "relevance")) {
    order = `CASE WHEN ${key} = ? THEN 0 WHEN ${key} LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, ${order}`;
    orderParams.push(rankedTerm, `${rankedTerm.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (options.sourceOrder) order = "rowid ASC";
  const annotations = payloads(
    database,
    `SELECT payload FROM annotations ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [
      ...params,
      ...orderParams,
      Math.max(0, Math.trunc(filters.limit ?? 100)),
      Math.max(0, Math.trunc(filters.offset ?? 0)),
    ],
  );
  return { annotations, total };
}
