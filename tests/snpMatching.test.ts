import { afterEach, beforeAll, expect, test } from "bun:test";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { matchSNPsInBatches } from "../src/workers/snpMatching";
import type { UserGenotype } from "../src/types/snp";

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

test("sequence alleles cannot collapse into a compact SNPedia genotype", async () => {
  const database = fixture("rs123", "A;T", "{{Rsnum|Orientation=plus}}");
  const calls: UserGenotype[] = [
    { ...userGenotype("at"), ref: "A", alt: "AT", alleles: ["AT"] },
    { ...userGenotype("a/t"), ref: "AT", alt: "A,T", alleles: ["A", "T"] },
    { ...userGenotype("at"), ref: "AT" },
    { ...userGenotype("a/t") },
  ];
  const context = await matchSNPsInBatches(database, columns, calls, () => {});
  expect(context).toHaveLength(4);
  expect(context.every((match) => !match.genotypeData)).toBe(true);
  expect(await matchSNPsInBatches(database, columns, [userGenotype("at")], () => {})).toHaveLength(1);
});

test("explicitly unknown strand retains variant context without genotype-specific annotations", async () => {
  const database = fixture("rs123", "A;G", "{{Rsnum|Orientation=plus|summary=Variant context}}");
  const call: UserGenotype = { ...userGenotype("ag"), strand: "unknown" };
  const matches = await matchSNPsInBatches(database, columns, separatedCalls(call, { ...call }, true), () => {});
  expect(matches).toHaveLength(1);
  expect(matches[0].genotypeData).toBeUndefined();
  expect(matches[0].parsedData.summary).toBe("Variant context");
  expect(matches[0].parsedData.genotypeContent).toBeUndefined();
  database.run("DELETE FROM genotypes");
  const withoutGenotypes = await matchSNPsInBatches(database, columns, [call], () => {});
  expect(withoutGenotypes).toHaveLength(1);
  expect(withoutGenotypes[0].genotypeData).toBeUndefined();
});

test("explicit minus-strand calls align with the declared source strand and stay contextual if it is unknown", async () => {
  for (const [orientation, genotype] of [
    ["minus", "C;T"],
    ["plus", "A;G"],
    ["unknown", "C;T"],
  ]) {
    const database = fixture("rs123", genotype, `{{Rsnum|Orientation=${orientation}}}`);
    const matches = await matchSNPsInBatches(database, columns, [{ ...userGenotype("ct"), strand: "minus" }], () => {});
    expect(matches).toHaveLength(1);
    expect(Boolean(matches[0].genotypeData)).toBe(orientation !== "unknown");
  }
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

function separatedCalls(first: UserGenotype, last: UserGenotype, acrossBatches: boolean): UserGenotype[] {
  const calls = acrossBatches
    ? [first, ...Array.from({ length: 499 }, (_, index) => userGenotype("ag", `rs${900000 + index}`)), last]
    : [first, last];
  for (const call of calls) Object.freeze(call);
  // Neither duplicate suppression nor matching may rewrite the uploaded calls.
  Object.freeze(calls);
  return calls;
}

for (const acrossBatches of [false, true]) {
  const placement = acrossBatches ? "across the 500-row batch boundary" : "in the same batch";

  test(`identical uploaded calls collapse to one match ${placement}`, async () => {
    const database = fixture("rs123", "A;G", "{{Rsnum|Orientation=plus}}");
    const first: UserGenotype = {
      ...userGenotype("ag"),
      assembly: "GRCh37",
      ref: "A",
      alt: "G",
      strand: "plus",
      phased: false,
    };
    const input = separatedCalls(first, { ...first }, acrossBatches);
    const before = JSON.stringify(input);
    const matches = await matchSNPsInBatches(database, columns, input, () => {});
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject(first);
    expect(JSON.stringify(input)).toBe(before);
  });

  const differences: Array<[string, Partial<UserGenotype>]> = [
    ["called bases", { genotype: "aa" }],
    ["allele order", { genotype: "ga" }],
    ["assembly", { assembly: "GRCh38" }],
    ["unknown assembly", { assembly: undefined }],
    ["chromosome", { chromosome: "2" }],
    ["position", { position: "101" }],
    ["reference allele", { ref: "C" }],
    ["alternate allele", { alt: "C" }],
    ["strand", { strand: "minus" }],
    ["unknown strand", { strand: undefined }],
    ["phase", { phased: true }],
    ["unknown phase", { phased: undefined }],
  ];
  for (const [field, difference] of differences) {
    test(`calls with different ${field} remain distinct ${placement}`, async () => {
      const database = fixture("rs123", "A;G", "{{Rsnum|Orientation=plus}}");
      database.run("INSERT INTO genotypes VALUES (?, ?, ?, ?, NULL)", [
        "synthetic-homozygous",
        "rs123",
        "A;A",
        "{{Genotype|summary=Synthetic homozygous definition}}",
      ]);
      if (field === "strand")
        database.run("INSERT INTO genotypes VALUES (?, ?, ?, ?, NULL)", [
          "synthetic-complement",
          "rs123",
          "C;T",
          "{{Genotype|summary=Synthetic complemented definition}}",
        ]);
      const first: UserGenotype = {
        ...userGenotype("ag"),
        assembly: "GRCh37",
        ref: "A",
        alt: "G",
        strand: "plus",
        phased: false,
      };
      const second = { ...first, ...difference };
      const input = separatedCalls(first, second, acrossBatches);
      const before = JSON.stringify(input);
      const matches = await matchSNPsInBatches(database, columns, input, () => {});
      expect(matches).toHaveLength(2);
      expect(matches).toContainEqual(expect.objectContaining(first));
      expect(matches).toContainEqual(expect.objectContaining(second));
      expect(JSON.stringify(input)).toBe(before);
    });
  }
}

test("identical repeated source rows collapse even when the uploaded call spans batches", async () => {
  const database = fixture("rs123", "A;G", "{{Rsnum|Orientation=plus}}");
  database.run("INSERT INTO genotypes SELECT * FROM genotypes");
  const matches = await matchSNPsInBatches(
    database,
    columns,
    separatedCalls(userGenotype("ag"), userGenotype("ag"), true),
    () => {},
  );
  expect(matches).toHaveLength(1);
  expect(matches[0].genotypeData?.content).toBe("{{Genotype|summary=Matched genotype}}");
});

test("equivalent allele order in distinct source definitions does not discard evidence", async () => {
  const database = fixture("rs123", "A;G", "{{Rsnum|Orientation=plus}}");
  database.run("INSERT INTO genotypes VALUES (?, ?, ?, ?, NULL)", [
    "synthetic-reversed-definition",
    "rs123",
    "G;A",
    "{{Genotype|summary=Separate source evidence}}",
  ]);
  const matches = await matchSNPsInBatches(
    database,
    columns,
    separatedCalls(userGenotype("ag"), userGenotype("ag"), true),
    () => {},
  );
  expect(matches).toHaveLength(2);
  expect(matches.map((match) => match.genotypeData?.id).sort()).toEqual([
    "rs123(A;G)",
    "synthetic-reversed-definition",
  ]);
  expect(new Set(matches.map((match) => match.genotypeData?.content)).size).toBe(2);
});

test("source rows with the same ID and different content remain distinct", async () => {
  const database = fixture("rs123", "A;G", "{{Rsnum|Orientation=plus}}");
  database.run("INSERT INTO genotypes VALUES (?, ?, ?, ?, NULL)", [
    "rs123(A;G)",
    "rs123",
    "A;G",
    "{{Genotype|summary=Additional evidence under the same source ID}}",
  ]);
  const matches = await matchSNPsInBatches(database, columns, [userGenotype("ag")], () => {});
  expect(matches).toHaveLength(2);
  expect(new Set(matches.map((match) => match.genotypeData?.id)).size).toBe(1);
  expect(new Set(matches.map((match) => match.genotypeData?.content)).size).toBe(2);
});
