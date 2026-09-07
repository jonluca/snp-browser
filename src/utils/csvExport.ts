type CsvValue = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

function formatCsvValue(value: CsvValue): string {
  if (value === null || value === undefined) return "";

  // Spreadsheet programs evaluate formula-like strings even in quoted CSV cells.
  // Keep actual numeric values numeric, including negative numbers.
  const text =
    typeof value === "string" && (/^\s*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value)) ? `'${value}` : String(value);
  if (!/[",\r\n]/.test(text)) return text;

  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((column) => formatCsvValue(column.header)).join(",");
  const body = rows.map((row) => columns.map((column) => formatCsvValue(column.value(row))).join(","));

  return [header, ...body].join("\r\n");
}

export function downloadCsvFile(filename: string, csv: string) {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}
