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
