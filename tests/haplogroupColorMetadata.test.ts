import { expect, test } from "bun:test";
import { ParserColor } from "../src/parsers/color";

const parser = new ParserColor();
const parse = (header: string, referenceVersion = "") =>
  parser.parse(
    `${header}\n# plus strand\nSampleID,Chromosome,Position,RSID,Genotype,REFERENCEVERSION\nsample,MT,2706,rs123,AA,${referenceVersion}`,
    () => undefined,
  );

test("Color retains explicit unsupported mitochondrial references from file headers", async () => {
  for (const header of ["# hg19", "# GRCh37\n# RSRS", "# GRCh37\n# NC_001807.4"]) {
    const result = await parse(header);
    expect(result.genotypes).toHaveLength(1);
    expect(result.genotypes[0]).toMatchObject({
      assembly: "GRCh37",
      strand: "plus",
      mitochondrialReference: "unsupported",
    });
  }
});

test("Color retains the mitochondrial distinction when a row declares hg19", async () => {
  for (const referenceVersion of ["hg19", "HG19", "hg_19"]) {
    const result = await parse("# Color discovery export", referenceVersion);
    expect(result.genotypes[0]).toMatchObject({ assembly: "GRCh37", mitochondrialReference: "unsupported" });
  }
});

test("Color allows an explicit rCRS declaration to qualify hg19 nuclear coordinates", async () => {
  for (const header of ["# hg19\n# rCRS", "# Color discovery export\n# NC_012920.1"]) {
    const result = await parse(header, "hg19");
    expect(result.genotypes[0]).toMatchObject({ assembly: "GRCh37", mitochondrialReference: "rCRS" });
  }
});

test("Color keeps unsupported mitochondrial references when rCRS is also mentioned", async () => {
  const result = await parse("# GRCh37\n# RSRS or rCRS", "hg19");
  expect(result.genotypes[0]?.mitochondrialReference).toBe("unsupported");
});

test("Color does not reject ordinary GRCh37 and GRCh38 row references", async () => {
  for (const assembly of ["GRCh37", "GRCh38"]) {
    const result = await parse("# Color discovery export", assembly);
    expect(result.genotypes[0]?.assembly).toBe(assembly);
    expect(result.genotypes[0]?.mitochondrialReference).toBeUndefined();
  }
});
