import type { Database } from "sql.js";
import type { SNPRecord } from "../types/snp";

export type SNPSearchSort = "relevance" | "rsid-asc" | "rsid-desc";
export interface SNPSearchFilters {
  searchTerm?: string;
  chromosome?: string;
  gene?: string;
  clinicalSignificance?: string;
  disease?: string;
  sortBy?: SNPSearchSort;
  limit?: number;
  offset?: number;
}

const OPTIONAL_COLUMNS = ["gene", "gene_s", "clin_gene_name", "clin_sig", "clin_disease", "chromosome", "position"];

export function searchSNPs(
  database: Database,
  columns: Set<string>,
  filters: SNPSearchFilters,
): { results: SNPRecord[]; total: number } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const addLike = (candidates: string[], text: string) => {
    const available = candidates.filter((column) => columns.has(column));
    if (!available.length) return;
    conditions.push(`(${available.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    // Search input is literal text; '%' and '_' must not turn into SQL wildcards.
    const term = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(...available.map(() => term));
  };
  const term = filters.searchTerm?.trim();
  if (term) addLike(["rsid", "gene", "gene_s", "content", "clin_disease", "clin_gene_name"], term);
  if (filters.chromosome) {
    conditions.push(columns.has("chromosome") ? "chromosome = ?" : "0 = 1");
    if (columns.has("chromosome")) params.push(filters.chromosome);
  }
  if (filters.gene?.trim()) {
    const genes = ["gene", "gene_s", "clin_gene_name"].filter((column) => columns.has(column));
    addLike(genes.length ? genes : ["content"], filters.gene.trim());
  }
  if (filters.clinicalSignificance)
    addLike(columns.has("clin_sig") ? ["clin_sig"] : ["content"], filters.clinicalSignificance);
  if (filters.disease?.trim())
    addLike(columns.has("clin_disease") ? ["clin_disease"] : ["content"], filters.disease.trim());
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countStmt = database.prepare(`SELECT COUNT(*) AS count FROM snps ${where}`);
  let total = 0;
  try {
    countStmt.bind(params);
    if (countStmt.step()) total = Number(countStmt.getAsObject().count);
  } finally {
    countStmt.free();
  }
  const orderParams: string[] = [];
  let order = `rsid COLLATE NOCASE ${filters.sortBy === "rsid-desc" ? "DESC" : "ASC"}`;
  if ((!filters.sortBy || filters.sortBy === "relevance") && term) {
    order = `CASE WHEN rsid = ? COLLATE NOCASE THEN 0 WHEN rsid LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, ${order}`;
    orderParams.push(term, `${term.replace(/[\\%_]/g, "\\$&")}%`);
  }
  const selectColumns = [
    "rsid",
    "content",
    "scraped_at",
    ...OPTIONAL_COLUMNS.map((column) => (columns.has(column) ? column : `NULL AS ${column}`)),
  ];
  const limit = Math.max(0, Math.trunc(filters.limit ?? 50));
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
  const statement = database.prepare(
    `SELECT ${selectColumns.join(", ")} FROM snps ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
  );
  const results: SNPRecord[] = [];
  try {
    statement.bind([...params, ...orderParams, limit, offset]);
    while (statement.step()) results.push(statement.getAsObject() as unknown as SNPRecord);
  } finally {
    statement.free();
  }
  return { results, total };
}
