import { expect, test } from "bun:test";
import { extractSnpediaFields } from "../src/utils/snpediaFields";

test("extractSnpediaFields returns spreadsheet-friendly SNPedia fields", () => {
  const fields = extractSnpediaFields(
    `{{Genotype
| gene = [[BRCA1]]
| magnitude = 3.5
| repute = Bad
| summary = Elevated risk summary<ref>{{cite journal|title=Large reference}}</ref>
}}

==References==
* A long reference list that should not be exported`,
  );

  expect(fields.geneSymbol).toBe("BRCA1");
  expect(fields.magnitude).toBe(3.5);
  expect(fields.repute).toBe("Bad");
  expect(fields.summary).toBe("Elevated risk summary");
});

test("extractSnpediaFields prefers database gene and clinical fields when present", () => {
  const fields = extractSnpediaFields("{{Rsnum|gene=OLD|magnitude=1}}", {
    gene: "",
    gene_s: "APOE",
    clin_sig: "risk factor",
    clin_disease: "Alzheimer disease",
  });

  expect(fields.geneSymbol).toBe("APOE");
  expect(fields.clinicalSignificance).toBe("risk factor");
  expect(fields.disease).toBe("Alzheimer disease");
});
