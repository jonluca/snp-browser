import { afterEach, beforeAll, expect, test } from "bun:test";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { prepareReferenceColumns } from "../src/workers/referenceColumns";
import { searchSNPs } from "../src/workers/snpSearch";

let SQL: SqlJsStatic;
const databases: Database[] = [];

beforeAll(async () => {
  SQL = await initSqlJs();
});
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function fixture(extraColumns = "") {
  const database = new SQL.Database();
  databases.push(database);
  database.run(`CREATE TABLE snps (rsid TEXT PRIMARY KEY, content TEXT, scraped_at TEXT${extraColumns})`);
  const columns = new Set(["rsid", "content", "scraped_at"]);
  const add = database.prepare("INSERT INTO snps (rsid, content) VALUES (?, ?)");
  for (const [rsid, content] of [
    ["rs1", "{{Rsnum|Chromosome = chr01 | position = 12345 }}\nArticle."],
    ["rs2", "{{Rsnum\n| chromosome= x\n| Position=00042\n}}"],
    ["rs3", "{{Rsnum|chromosome=chrM|position=678}}"],
    ["rs4", "{{Rsnum|chromosome=Y|position=999}}"],
  ])
    add.run([rsid, content]);
  add.free();
  return { database, columns };
}

test("legacy references gain normalized coordinates and usable chromosome filters", () => {
  const { database, columns } = fixture();
  prepareReferenceColumns(database, columns);

  expect([...columns]).toContain("chromosome");
  expect([...columns]).toContain("position");
  expect(database.exec("SELECT chromosome, position FROM snps ORDER BY rsid")[0].values).toEqual([
    ["1", "12345"],
    ["X", "00042"],
    ["MT", "678"],
    ["Y", "999"],
  ]);
  expect(searchSNPs(database, columns, { chromosome: "X" }).results.map((row) => row.rsid)).toEqual(["rs2"]);
});

test("existing coordinate columns and their null values are preserved on partial schemas", () => {
  const { database, columns } = fixture(", chromosome TEXT");
  columns.add("chromosome");
  database.run("UPDATE snps SET chromosome = '19' WHERE rsid = 'rs1'");
  prepareReferenceColumns(database, columns);
  expect(
    database.exec("SELECT chromosome, position FROM snps WHERE rsid IN ('rs1', 'rs2') ORDER BY rsid")[0].values,
  ).toEqual([
    ["19", "12345"],
    [null, "00042"],
  ]);
  database.run("UPDATE snps SET position = '777' WHERE rsid = 'rs1'");
  prepareReferenceColumns(database, columns);
  expect(database.exec("SELECT chromosome, position FROM snps WHERE rsid = 'rs1'")[0].values).toEqual([["19", "777"]]);
});

test("only exact first-template coordinate fields are trusted", () => {
  const { database, columns } = fixture();
  database.run("DELETE FROM snps");
  const insert = database.prepare("INSERT INTO snps (rsid, content) VALUES (?, ?)");
  for (const [rsid, content] of [
    [
      "rs1",
      "{{Rsnum|nested={{Other|chromosome=4|position=12}}|link=[[Article|chromosome=5]]}}\n{{Other|chromosome=6|position=99}}",
    ],
    ["rs2", "{{Rsnum|other_chromosome=9|otherposition=42|chromosome=23|position=1,000}}"],
    ["rs3", "{{Rsnum|chromosome=1 or 2|position=-100}}"],
    ["rs4", "{{Rsnum|chromosome=2|position=25"],
  ])
    insert.run([rsid, content]);
  insert.free();

  prepareReferenceColumns(database, columns);
  expect(database.exec("SELECT chromosome, position FROM snps")[0].values).toEqual([
    [null, null],
    [null, null],
    [null, null],
    [null, null],
  ]);
});

test("a failed backfill rolls back schema changes and leaves the columns set unchanged", () => {
  const { database, columns } = fixture();
  database.run("CREATE TRIGGER reject_update BEFORE UPDATE ON snps BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect(() => prepareReferenceColumns(database, columns)).toThrow("fixture failure");
  expect(columns.has("chromosome")).toBe(false);
  expect(columns.has("position")).toBe(false);
  expect(database.exec("PRAGMA table_info(snps)")[0].values.map((row) => row[1])).toEqual([
    "rsid",
    "content",
    "scraped_at",
  ]);
});
