import { afterEach, beforeAll, expect, test } from "bun:test";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { searchSNPs } from "../src/workers/snpSearch";

let SQL: SqlJsStatic;
const databases: Database[] = [];
const columns = new Set(["rsid", "content", "scraped_at", "gene", "chromosome"]);
beforeAll(async () => {
  SQL = await initSqlJs();
});
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = new SQL.Database();
  databases.push(db);
  db.run("CREATE TABLE snps (rsid TEXT, content TEXT, scraped_at TEXT, gene TEXT, chromosome TEXT)");
  for (const row of [
    ["rs2", "Mentions rs1; frequency 50%", null, "GENE2", "2"],
    ["rs10", "Prefix record", null, "GENE1", "1"],
    ["rs1", "Exact record", null, "GENE1", "1"],
  ])
    db.run("INSERT INTO snps VALUES (?, ?, ?, ?, ?)", row);
  return db;
}

test("reference search ranks exact rsIDs ahead of prefixes and article mentions", () => {
  const { results, total } = searchSNPs(fixture(), columns, { searchTerm: "RS1" });
  expect(results.map((snp) => snp.rsid)).toEqual(["rs1", "rs10", "rs2"]);
  expect(total).toBe(3);
});

test("reference pagination preserves ranking without duplicates or gaps", () => {
  const db = fixture();
  const pages = [0, 1, 2].flatMap((offset) => searchSNPs(db, columns, { searchTerm: "rs1", limit: 1, offset }).results);
  expect(pages.map((snp) => snp.rsid)).toEqual(["rs1", "rs10", "rs2"]);
});

test("reference ordering and export use the same filtered result order", () => {
  const db = fixture();
  const all = searchSNPs(db, columns, { gene: "GENE1", chromosome: "1", sortBy: "rsid-desc", limit: 100 });
  expect(all.results.map((snp) => snp.rsid)).toEqual(["rs10", "rs1"]);
  expect(all.total).toBe(2);
  expect(all.results[0].chromosome).toBe("1");
  expect(all.results[0].clin_sig).toBeNull();
});

test("search treats wildcard characters as literal user text", () => {
  const db = fixture();
  expect(searchSNPs(db, columns, { searchTerm: "%" }).results.map((snp) => snp.rsid)).toEqual(["rs2"]);
  expect(searchSNPs(db, columns, { searchTerm: "_" }).total).toBe(0);
  expect(searchSNPs(db, columns, { searchTerm: "' OR 1=1 --" }).total).toBe(0);
});
