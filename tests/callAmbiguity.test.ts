import { expect, test } from "bun:test";
import type { UserGenotype } from "../src/types/snp";
import { ambiguousCallIds } from "../src/utils/callAmbiguity";

const call = (overrides: Partial<UserGenotype> = {}): UserGenotype => ({
  rsid: "rs123",
  assembly: "GRCh37",
  chromosome: "1",
  position: "100",
  strand: "plus",
  genotype: "AG",
  ...overrides,
});

test("equivalent SNP allele order and opposite declared strands do not conflict", () => {
  expect(
    ambiguousCallIds([
      call({ ref: "A" }),
      call({ genotype: "ga", ref: "a", chromosome: "chr1", position: "0100", phased: true }),
      call({ genotype: "CT", ref: "T", strand: "minus" }),
    ]),
  ).toEqual(new Set());
});

test("normalized IDs detect conflicting calls without a confirmed locus", () => {
  expect(
    ambiguousCallIds([call({ assembly: undefined }), call({ rsid: "RS00123", assembly: undefined, genotype: "GG" })]),
  ).toEqual(new Set(["rs123", "rs00123"]));
});

test("conflicting calls sharing a confirmed locus flag every uploaded identifier", () => {
  expect(ambiguousCallIds([call(), call({ rsid: "i999", genotype: "GG" }), call({ rsid: "rs456" })])).toEqual(
    new Set(["rs123", "i999", "rs456"]),
  );
  expect(ambiguousCallIds([call(), call({ rsid: "rs456", genotype: "GG", assembly: undefined })])).toEqual(new Set());
});

test("coordinate, reference and unknown-strand disagreement remain conservative", () => {
  for (const changed of [
    { position: "101" },
    { chromosome: "2" },
    { assembly: "GRCh38" as const },
    { ref: "G" },
    { strand: "unknown" as const },
    { genotype: "--" },
  ]) {
    expect(ambiguousCallIds([call({ ref: "A" }), call({ ref: "A", ...changed })])).toEqual(new Set(["rs123"]));
  }
});

test("sequence allele boundaries and unsupported reverse representations are never flattened", () => {
  expect(ambiguousCallIds([call({ alleles: ["AG"] }), call({ alleles: ["A", "G"] })])).toEqual(new Set(["rs123"]));
  expect(
    ambiguousCallIds([
      call({ genotype: "A/AG", alleles: ["A", "AG"], ref: "A" }),
      call({ genotype: "AG/A", alleles: ["AG", "A"], ref: "A" }),
    ]),
  ).toEqual(new Set());
  expect(
    ambiguousCallIds([
      call({ genotype: "AG", alleles: ["AG"] }),
      call({ genotype: "TC", alleles: ["TC"], strand: "minus" }),
    ]),
  ).toEqual(new Set(["rs123"]));
});
