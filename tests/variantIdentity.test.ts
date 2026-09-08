import { expect, test } from "bun:test";
import type { VariantAnnotation } from "../src/types/annotations";
import type { UserGenotype } from "../src/types/snp";
import {
  matchVariantAnnotation,
  normalizeAssembly,
  normalizeChromosome,
  normalizeRsid,
} from "../src/utils/variantIdentity";

const user: UserGenotype = {
  rsid: "rs123",
  chromosome: "chr1",
  position: "100",
  genotype: "ag",
  assembly: "GRCh37",
  strand: "plus",
};
const annotation: VariantAnnotation = {
  id: "test",
  source: "clinvar",
  rsid: "rs123",
  assembly: "GRCh37",
  chromosome: "1",
  position: 100,
  ref: "A",
  alt: "G",
  scope: "allele",
  title: "Example",
  url: "https://www.ncbi.nlm.nih.gov/clinvar/",
  fields: {},
};

test("normalizes supported variant identifiers without inventing genome builds or chromosomes", () => {
  expect(normalizeRsid(" RS000123 ")).toBe("rs123");
  expect(normalizeRsid("i123")).toBeUndefined();
  expect(normalizeRsid("rs123;rs456")).toBeUndefined();
  expect(normalizeChromosome("chrM")).toBe("MT");
  expect(normalizeChromosome("CHR01")).toBe("1");
  expect(normalizeChromosome("23")).toBeUndefined();
  expect(normalizeAssembly("GRCh38.p14")).toBe("GRCh38");
  expect(normalizeAssembly("NCBI build 37")).toBe("GRCh37");
  expect(normalizeAssembly("hg19")).toBe("GRCh37");
  expect(normalizeAssembly("37")).toBeUndefined();
  expect(normalizeAssembly("GRCh36")).toBeUndefined();
});

test("allele matches require a known compatible build, exact locus, and declared strand", () => {
  expect(matchVariantAnnotation(user, annotation).matchType).toBe("allele");
  for (const changed of [
    { assembly: undefined },
    { assembly: "GRCh38" as const },
    { strand: undefined },
    { strand: "unknown" as const },
    { position: "101" },
    { chromosome: "2" },
    { position: "1e2" },
    { genotype: "--" },
  ]) {
    expect(matchVariantAnnotation({ ...user, ...changed }, annotation).matchType).toBe("unresolved");
  }
  expect(matchVariantAnnotation(user, { ...annotation, position: undefined }).matchType).toBe("unresolved");
  expect(matchVariantAnnotation(user, { ...annotation, assembly: undefined }).matchType).toBe("unresolved");
});

test("explicit opposite-strand calls are complemented and known reference alleles are checked", () => {
  expect(matchVariantAnnotation({ ...user, genotype: "ct", ref: "T", strand: "minus" }, annotation).matchType).toBe(
    "allele",
  );
  expect(matchVariantAnnotation({ ...user, genotype: "ct", strand: "plus" }, annotation).matchType).toBe("locus");
  expect(matchVariantAnnotation({ ...user, ref: "C" }, annotation).matchType).toBe("unresolved");
  expect(matchVariantAnnotation({ ...user, genotype: "ct", strand: undefined }, annotation).matchType).toBe(
    "unresolved",
  );
});

test("reference and other alternate calls cannot inherit an uncarried allele's classification", () => {
  expect(matchVariantAnnotation({ ...user, genotype: "aa", ref: "A" }, annotation).matchType).toBe("locus");
  expect(matchVariantAnnotation({ ...user, genotype: "ac", ref: "A", alt: "C" }, annotation).matchType).toBe("locus");
  expect(matchVariantAnnotation({ ...user, genotype: "cg", ref: "A", alt: "C,G" }, annotation).matchType).toBe(
    "allele",
  );
  expect(matchVariantAnnotation(user, { ...annotation, alt: "G,C" }).matchType).toBe("unresolved");
  expect(matchVariantAnnotation(user, { ...annotation, alt: "AG" }).matchType).toBe("unresolved");
});

test("rsID-only annotations remain reference context while exact loci and declared aliases can identify records", () => {
  expect(matchVariantAnnotation(user, { ...annotation, position: undefined, scope: "variant" }).matchType).toBe(
    "locus",
  );
  expect(matchVariantAnnotation(user, { ...annotation, position: undefined }).matchType).toBe("unresolved");
  expect(matchVariantAnnotation(user, { ...annotation, rsid: undefined }).matchType).toBe("allele");
  expect(matchVariantAnnotation(user, { ...annotation, rsid: "rs456", aliases: ["rs123"] }).matchType).toBe("allele");
  expect(matchVariantAnnotation(user, { ...annotation, rsid: "rs456", position: undefined }).matchType).toBe(
    "unresolved",
  );
});
