import { expect, test } from "bun:test";
import type { MatchedSNP } from "../src/types/snp";
import { countMatchVariants, createMatchRows, userCallIdentity } from "../src/utils/matchIdentity";

function match(sourceId = "rs123(A;G)", summary = "Synthetic evidence"): MatchedSNP {
  return {
    rsid: "rs123",
    chromosome: "1",
    position: "100",
    genotype: "ag",
    assembly: "GRCh38",
    strand: "plus",
    snpData: { rsid: "rs123", content: "Synthetic variant" },
    genotypeData: { id: sourceId, snp_id: "rs123", genotype: "ag", content: summary },
    parsedData: { rsid: "rs123", rawContent: "Synthetic variant", summary },
  };
}

test("distinct source evidence rows remain selectable after sorting and filtering the same variant", () => {
  const first = match("rs123(A;G)", "First source evidence");
  const second = match("rs123(G;A)", "Second source evidence");
  const rows = createMatchRows([first, second]);
  const selectedKey = rows[1].key;

  expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  expect(rows.find((row) => row.key === selectedKey)?.match).toBe(second);
  expect([...rows].reverse().find((row) => row.key === selectedKey)?.match).toBe(second);
  expect(rows.filter((row) => row.match === second)[0].key).toBe(selectedKey);
  expect(createMatchRows([second, first])[0].key).toBe(selectedKey);
});

test("different evidence under the same source ID receives unique keys before filtering", () => {
  const first = match();
  const second = match(first.genotypeData!.id, "Different synthetic evidence");
  const rows = createMatchRows([first, second]);

  expect(rows[0].key).not.toBe(rows[1].key);
  expect(rows.filter((row) => row.match === second)[0].key).toBe(rows[1].key);
  expect(rows.find((row) => row.key === rows[1].key)?.match.genotypeData?.content).toBe("Different synthetic evidence");
});

test("row and annotation-query identities retain every declared call dimension", () => {
  const baseline = { ...match(), ref: "A", alt: "G", phased: false };
  const changes: Partial<MatchedSNP>[] = [
    { genotype: "aa" },
    { genotype: "ga" },
    { assembly: "GRCh37" },
    { assembly: undefined },
    { chromosome: "2" },
    { position: "101" },
    { ref: "C" },
    { alt: "T" },
    { strand: "minus" },
    { strand: undefined },
    { phased: true },
    { phased: undefined },
    { alleles: ["A", "G"] },
  ];

  for (const change of changes) {
    const other = { ...baseline, ...change };
    expect(userCallIdentity(other)).not.toBe(userCallIdentity(baseline));
    expect(createMatchRows([other])[0].key).not.toBe(createMatchRows([baseline])[0].key);
  }
});

test("variant totals count distinct IDs while evidence rows and annotated variants remain separate", () => {
  const first = match();
  const second = { ...match("rs123(G;A)"), rsid: "RS123" };
  const referenceOnly: MatchedSNP = {
    ...match(),
    rsid: "rs456",
    genotypeData: undefined,
    snpData: { rsid: "rs456", content: "", referenceSource: "references" },
  };
  const matches = [first, second, referenceOnly];

  expect(createMatchRows(matches)).toHaveLength(3);
  expect(countMatchVariants(matches)).toBe(2);
  expect(countMatchVariants(matches, (row) => Boolean(row.genotypeData))).toBe(1);
  expect(countMatchVariants([])).toBe(0);
});
