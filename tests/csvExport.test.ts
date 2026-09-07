import { expect, test } from "bun:test";
import { buildCsv, type CsvColumn } from "../src/utils/csvExport";

interface CsvTestRow {
  id: string;
  notes?: string | null;
  count?: number;
  flagged?: boolean;
}

const columns: CsvColumn<CsvTestRow>[] = [
  { header: "ID", value: (row) => row.id },
  { header: "Notes", value: (row) => row.notes },
  { header: "Count", value: (row) => row.count },
  { header: "Flagged", value: (row) => row.flagged },
];

test("buildCsv escapes commas, quotes, and newlines", () => {
  const csv = buildCsv(
    [
      { id: "rs1", notes: "plain", count: 1, flagged: true },
      { id: "rs2", notes: 'has, comma and "quote"\nand newline', flagged: false },
    ],
    columns,
  );

  expect(csv).toBe('ID,Notes,Count,Flagged\r\nrs1,plain,1,true\r\nrs2,"has, comma and ""quote""\nand newline",,false');
});

test("buildCsv neutralizes spreadsheet formulas in strings and headers", () => {
  const values = ["=1+1", "+SUM(A1:A2)", "-1+1", "@SUM(A1:A2)", "  =1+1", "\t=1+1", "\r=1+1", "\n=1+1"];
  const csv = buildCsv(values, [{ header: "=formula", value: (value) => value }]);

  expect(csv).toBe(
    "'=formula\r\n'=1+1\r\n'+SUM(A1:A2)\r\n'-1+1\r\n'@SUM(A1:A2)\r\n'  =1+1\r\n'\t=1+1\r\n\"'\r=1+1\"\r\n\"'\n=1+1\"",
  );
});

test("buildCsv keeps numeric values numeric and safely quotes formula strings", () => {
  expect(buildCsv([{ id: "rs1", count: -1.5, notes: '=HYPERLINK("https://example.com","click")' }], columns)).toBe(
    'ID,Notes,Count,Flagged\r\nrs1,"\'=HYPERLINK(""https://example.com"",""click"")",-1.5,',
  );
});
