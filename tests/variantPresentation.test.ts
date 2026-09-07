import { expect, test } from "bun:test";
import { getVariantPresentation, plainWikiText } from "../src/utils/variantPresentation";

test("preview cleanup removes balanced nested templates without leaking their fields", () => {
  expect(plainWikiText("Before{{SNP|summary={{nested|secret}}|gene=ABC}}after [[Rs1|this variant]].")).toBe(
    "Before after this variant.",
  );
  expect(plainWikiText("{{SNP|summary={{nested|secret}}}}")).toBe("");
  expect(plainWikiText("Useful prose. {{unfinished|field=hidden")).toBe("Useful prose.");
});

test("preview cleanup preserves text while removing references, HTML, and wiki formatting", () => {
  expect(
    plainWikiText(
      "'''A &amp; B''' <ref name='study'>Citation</ref> [[Gene]] [https://example.com a study].\n== Findings ==\n* &lt;b&gt;Readable&lt;/b&gt; &#945; &#x3B2;.\n== References ==\nCitation list",
    ),
  ).toBe("A & B Gene a study. Findings Readable α β.");
  expect(plainWikiText("One<script>alert('hidden')</script><!-- {{hidden -->two<ref name='x'/> continued.")).toBe(
    "One two continued.",
  );
});

test("variant presentations prefer readable summary and preserve extracted values", () => {
  const presentation = getVariantPresentation({
    rsid: "rs1",
    content: "{{SNP|summary=Associated with [[Trait|a trait]]|magnitude=2.5|repute=Good}}\nLong article.",
    gene: "[[ABC]]",
  });
  expect(presentation).toMatchObject({
    geneSymbol: "ABC",
    magnitude: 2.5,
    repute: "Good",
    summary: "Associated with a trait",
    preview: "Associated with a trait",
  });
});

test("variant presentations fall back to prose or a meaningful empty state", () => {
  expect(getVariantPresentation({ rsid: "rs1", content: "{{SNP|gene=ABC}}\nA readable article." }).preview).toBe(
    "A readable article.",
  );
  expect(getVariantPresentation({ rsid: "rs1", content: "{{SNP|gene=ABC}}" }).preview).toBe("No summary available.");
  const preview = getVariantPresentation({ rsid: "rs1", content: "Readable article text. ".repeat(30) }).preview;
  expect(preview.length).toBeLessThanOrEqual(180);
  expect(preview.endsWith("…")).toBe(true);
});
