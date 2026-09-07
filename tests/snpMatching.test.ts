import { afterEach, beforeAll, expect, test } from "bun:test";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { matchSNPsInBatches } from "../src/workers/snpMatching";

let SQL: SqlJsStatic;
const databases: Database[] = [];
const columns = new Set(["rsid", "content", "scraped_at"]);

beforeAll(async () => {
  SQL = await initSqlJs();
});

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
});

function fixture(snpId: string, genotype: string, content: string, genotypeSnpId = snpId): Database {
  const database = new SQL.Database();
  databases.push(database);
  database.run("CREATE TABLE snps (rsid TEXT PRIMARY KEY, content TEXT, scraped_at TEXT)");
  database.run("CREATE TABLE genotypes (id TEXT, snp_id TEXT, genotype TEXT, content TEXT, scraped_at TEXT)");
  database.run("INSERT INTO snps VALUES (?, ?, NULL)", [snpId, content]);
  database.run("INSERT INTO genotypes VALUES (?, ?, ?, ?, NULL)", [
    `${genotypeSnpId}(${genotype})`,
    genotypeSnpId,
    genotype,
    "{{Genotype|summary=Matched genotype}}",
  ]);
  return database;
}

function userGenotype(genotype: string, rsid = "rs123") {
  return { rsid, chromosome: "1", position: "100", genotype };
}

test("unphased heterozygous genotypes match regardless of allele order", async () => {
  const database = fixture("rs123", "A;G", "{{Rsnum|Orientation=plus}}");
  const matches = await matchSNPsInBatches(database, columns, [userGenotype("ga")], () => {});
  expect(matches).toHaveLength(1);
  expect(matches[0].genotype).toBe("ga");
  expect(matches[0].genotypeData?.genotype).toBe("ag");
});

test("minus-strand matching normalizes allele order after complementing", async () => {
  const database = fixture("rs123", "C;T", "{{Rsnum|Orientation=minus}}");
  expect(await matchSNPsInBatches(database, columns, [userGenotype("ag")], () => {})).toHaveLength(1);
});

test("spaced stabilized orientation takes precedence over orientation", async () => {
  const database = fixture("rs123", "C;T", "{{Rsnum\n| Orientation = plus\n| StabilizedOrientation = minus\n}}");
  const matches = await matchSNPsInBatches(database, columns, [userGenotype("ag")], () => {});
  expect(matches).toHaveLength(1);
  expect(matches[0].parsedData.orientation).toBe("plus");
  expect(matches[0].parsedData.stabilizedOrientation).toBe("minus");
});

test("rsID comparisons are case insensitive through lookup and join", async () => {
  const database = fixture("Rs123", "A;G", "{{Rsnum|Orientation=plus}}", "rs123");
  expect(await matchSNPsInBatches(database, columns, [userGenotype("ag", "RS123")], () => {})).toHaveLength(1);
});

test("missing database genotypes do not act as wildcards", async () => {
  const database = fixture("rs123", "", "{{Rsnum|Orientation=plus}}");
  expect(await matchSNPsInBatches(database, columns, [userGenotype("ag")], () => {})).toEqual([]);
});

test("database query failures reject instead of returning partial successful results", async () => {
  const database = fixture("rs123", "A;G", "{{Rsnum|Orientation=plus}}");
  database.run("ALTER TABLE genotypes DROP COLUMN content");
  await expect(matchSNPsInBatches(database, columns, [userGenotype("ag")], () => {})).rejects.toThrow("no such column");
});

test("progress reports the final batch even when it is not a multiple of 1000", async () => {
  const database = fixture("rs123", "A;G", "{{Rsnum|Orientation=plus}}");
  const genotypes = Array.from({ length: 501 }, (_, index) => userGenotype("ag", `rs${index}`));
  const progress: [number, number][] = [];
  await matchSNPsInBatches(database, columns, genotypes, (current, total) => progress.push([current, total]));
  expect(progress.at(-1)).toEqual([501, 501]);
});
