import type { Database, Statement } from "sql.js";

type ReferenceColumn = "chromosome" | "position";
const REFERENCE_COLUMNS: ReferenceColumn[] = ["chromosome", "position"];

function firstTemplateCoordinates(content: string): Partial<Record<ReferenceColumn, string>> {
  const start = content.indexOf("{{");
  if (start < 0) return {};

  const fields: Partial<Record<ReferenceColumn, string>> = {};
  let depth = 1;
  let linkDepth = 0;
  let parameterStart = start + 2;
  const readParameter = (end: number) => {
    const parameter = content.slice(parameterStart, end);
    const match = parameter.match(/^\s*(chromosome|position)\s*=\s*([^{}|[\]]*?)\s*$/i);
    if (!match) return;
    const key = match[1].toLowerCase() as ReferenceColumn;
    fields[key] = match[2];
  };

  // Only top-level parameters of the first template count. Pipes in nested
  // templates and wiki links must not introduce unrelated coordinate fields.
  for (let index = start + 2; index < content.length; index++) {
    const pair = content.slice(index, index + 2);
    if (pair === "{{") {
      depth++;
      index++;
    } else if (pair === "}}") {
      depth--;
      if (depth === 0) {
        readParameter(index);
        return fields;
      }
      index++;
    } else if (pair === "[[") {
      linkDepth++;
      index++;
    } else if (pair === "]]") {
      linkDepth = Math.max(0, linkDepth - 1);
      index++;
    } else if (content[index] === "|" && depth === 1 && linkDepth === 0) {
      readParameter(index);
      parameterStart = index + 1;
    }
  }

  // An incomplete template cannot reliably establish the field boundaries.
  return {};
}

function normalizeChromosome(value: string | undefined): string | null {
  const chromosome = value
    ?.trim()
    .toUpperCase()
    .replace(/^CHR\s*/, "");
  if (!chromosome) return null;
  if (/^0*(?:[1-9]|1\d|2[0-2])$/.test(chromosome)) return String(Number(chromosome));
  if (chromosome === "X" || chromosome === "Y" || chromosome === "MT") return chromosome;
  return chromosome === "M" ? "MT" : null;
}

/** Add coordinates to legacy reference schemas in the worker's in-memory DB. */
export function prepareReferenceColumns(database: Database, columns: Set<string>): void {
  const missingColumns = REFERENCE_COLUMNS.filter((column) => !columns.has(column));
  if (missingColumns.length === 0) return;

  let rows: Statement | undefined;
  let update: Statement | undefined;
  database.run("BEGIN TRANSACTION");
  try {
    for (const column of missingColumns) database.run(`ALTER TABLE snps ADD COLUMN ${column} TEXT`);
    rows = database.prepare("SELECT rsid, content FROM snps");
    update = database.prepare(
      `UPDATE snps SET ${missingColumns.map((column) => `${column} = ?`).join(", ")} WHERE rsid = ?`,
    );

    while (rows.step()) {
      const [rsid, content] = rows.get();
      if (typeof content !== "string") continue;
      const fields = firstTemplateCoordinates(content);
      const values: Record<ReferenceColumn, string | null> = {
        chromosome: normalizeChromosome(fields.chromosome),
        position: fields.position && /^\d+$/.test(fields.position) ? fields.position : null,
      };
      // NULL is already the default, so avoid writes for entries without data.
      if (!missingColumns.some((column) => values[column] !== null)) continue;
      update.run([...missingColumns.map((column) => values[column]), rsid]);
    }

    rows.free();
    rows = undefined;
    update.free();
    update = undefined;
    database.run("COMMIT");
    for (const column of missingColumns) columns.add(column);
  } catch (error) {
    rows?.free();
    update?.free();
    database.run("ROLLBACK");
    throw error;
  }
}
