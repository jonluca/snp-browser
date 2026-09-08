import { expect, test } from "bun:test";
import { detectFileMetadata } from "../src/parsers/metadata";
import {
  parser23andMe,
  parserAncestry,
  parserColor,
  parserFTDNA,
  parserMyHeritage,
  parserVitagene,
} from "../src/parsers";

test("metadata detection reads explicit build and strand declarations without provider defaults", () => {
  expect(detectFileMetadata("# 23andMe raw data\nrs123 1 100 AG")).toEqual({});
  expect(
    detectFileMetadata(
      "# positions refer to human genome build 37\n# using the plus strand of the reference genome\nrs123 1 100 AG",
    ),
  ).toEqual({ assembly: "GRCh37", strand: "plus" });
  expect(detectFileMetadata("# Build: 38\n# Forward (+) strand\nrs123 1 100 AG")).toEqual({
    assembly: "GRCh38",
    strand: "plus",
  });
  expect(detectFileMetadata("# GRCh37\n# negative strand\nrs123 1 100 CT")).toEqual({
    assembly: "GRCh37",
    strand: "minus",
  });
});

test("ambiguous declarations and build mentions after genotype data cannot supply metadata", () => {
  expect(detectFileMetadata("# hg19 or hg38\n# plus strand and minus strand\nrs123 1 100 AG")).toEqual({});
  expect(detectFileMetadata("# build 36\n# build 37\nrs123 1 100 AG")).toEqual({});
  expect(detectFileMetadata("# source\nrs123 1 100 AG\n# GRCh38\n# plus strand")).toEqual({});
});

test("VCF metadata only trusts reference and contig build declarations", () => {
  expect(detectFileMetadata("##reference=file:///data/GRCh38.p14.fa\n#CHROM", true)).toEqual({ assembly: "GRCh38" });
  expect(detectFileMetadata("##reference=file:///data/GRCh38_full_analysis_set.fa\n#CHROM", true)).toEqual({
    assembly: "GRCh38",
  });
  expect(detectFileMetadata("##contig=<ID=1,length=249250621,assembly=GRCh37>\n#CHROM", true)).toEqual({
    assembly: "GRCh37",
  });
  expect(
    detectFileMetadata(
      '##assembly=file:///GRCh38/breakpoints.fa\n##INFO=<ID=NOTE,Description="hg38 annotation">\n#CHROM',
      true,
    ),
  ).toEqual({});
  expect(detectFileMetadata("##reference=hg19.fa\n##contig=<ID=1,assembly=GRCh38>\n#CHROM", true)).toEqual({});
});

test("all consumer parsers preserve declared build and strand on returned calls", async () => {
  for (const [parser, record] of [
    [parser23andMe, "rs123 1 100 AG"],
    [parserAncestry, "rs123\t1\t100\tA\tG"],
    [parserColor, "SampleID,Chromosome,Position,RSID,Genotype\nsample,1,100,rs123,AG"],
    [parserFTDNA, "RSID,CHROMOSOME,POSITION,RESULT\nrs123,1,100,AG"],
    [parserMyHeritage, "RSID,CHROMOSOME,POSITION,RESULT\nrs123,1,100,AG"],
    [parserVitagene, "RSID,CHROMOSOME,POSITION,RESULT\nrs123,1,100,AG"],
  ] as const) {
    const result = await parser.parse(`# genome build 37\n# plus strand\n${record}`, () => undefined);
    expect(result.errors).toEqual([]);
    expect(result.assembly).toBe("GRCh37");
    expect(result.genotypes).toHaveLength(1);
    expect(result.genotypes[0]).toMatchObject({ rsid: "rs123", assembly: "GRCh37", strand: "plus" });
  }
});
