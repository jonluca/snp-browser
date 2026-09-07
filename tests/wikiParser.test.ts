import { expect, test } from "bun:test";
import { parseWikiContent } from "../src/utils/wikiParser";

test("wiki article HTML and link labels are escaped before rendering", () => {
  const parsed = parseWikiContent('<img src=x onerror="alert(1)"> [[rs1|<svg onload=alert(1)>]] & text');

  expect(parsed?.html).not.toContain("<img");
  expect(parsed?.html).not.toContain("<svg");
  expect(parsed?.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(parsed?.html).toContain("&lt;svg onload=alert(1)&gt;</a>");
  expect(parsed?.html).toContain("&amp; text");
});

test("wiki link destinations cannot inject attributes or another URL origin", () => {
  const parsed = parseWikiContent('[[rs1" onclick="alert(1)|click]] [[//example.com|external-looking]]');

  expect(parsed?.html).toContain('href="https://www.snpedia.com/index.php/rs1%22_onclick%3D%22alert(1)"');
  expect(parsed?.html).not.toContain('onclick="');
  expect(parsed?.html).toContain('href="https://www.snpedia.com/index.php/%2F%2Fexample.com"');
  expect(parsed?.html).toContain('rel="noopener noreferrer"');
});

test("wiki links preserve page names, labels, and section anchors", () => {
  const parsed = parseWikiContent("[[Rs123]]\n[[Some page#More details|Read more]]");

  expect(parsed?.html).toContain('href="https://www.snpedia.com/index.php/Rs123"');
  expect(parsed?.html).toContain('href="https://www.snpedia.com/index.php/Some_page#More_details"');
  expect(parsed?.html).toContain(">Read more</a>");
  expect(parsed?.html.match(/<p /g)).toHaveLength(2);
});

test("nested templates are removed completely without losing surrounding prose", () => {
  const parsed = parseWikiContent("Before\n{{Genotype|summary={{note|text}}|magnitude=3}}\nAfter");

  expect(parsed?.text).toBe("Before\n\nAfter");
  expect(parsed?.html).toBe('<p class="mb-2">Before</p><p class="mb-2">After</p>');
});

test("unfinished templates do not discard the remaining article", () => {
  expect(parseWikiContent("Before {{unfinished\nAfter")?.text).toBe("Before {{unfinished\nAfter");
});

test("wiki lists and matching headings form blocks with correct paragraph boundaries", () => {
  const parsed = parseWikiContent(
    "Introduction\n== Findings ==\n* First finding\n* Second finding\n# First step\n# Second step\n\nAfter the list\n=== Details ===\n====== Footnote ======\n=== Mismatched ==",
  );
  expect(parsed?.html).toBe(
    '<p class="mb-2">Introduction</p>' +
      '<h2 class="mb-3 mt-6 font-semibold text-slate-900">Findings</h2>' +
      '<ul class="my-3 list-disc space-y-1 pl-5"><li>First finding</li><li>Second finding</li></ul>' +
      '<ol class="my-3 list-decimal space-y-1 pl-5"><li>First step</li><li>Second step</li></ol>' +
      '<p class="mb-2">After the list</p>' +
      '<h3 class="mb-3 mt-6 font-semibold text-slate-900">Details</h3>' +
      '<h6 class="mb-3 mt-6 font-semibold text-slate-900">Footnote</h6>' +
      '<p class="mb-2">=== Mismatched ==</p>',
  );
});

test("wiki headings and list items escape HTML and preserve safe link rendering", () => {
  const parsed = parseWikiContent(
    '== <img src=x onerror="alert(1)"> ==\n* [[rs1|<svg onload=alert(1)>]] & text\n# <script>alert(1)</script>',
  );
  expect(parsed?.html).toContain("<h2 ");
  expect(parsed?.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</h2>");
  expect(parsed?.html).toContain('href="https://www.snpedia.com/index.php/rs1"');
  expect(parsed?.html).toContain("&lt;svg onload=alert(1)&gt;</a> &amp; text</li>");
  expect(parsed?.html).toContain("<li>&lt;script&gt;alert(1)&lt;/script&gt;</li></ol>");
  expect(parsed?.html).not.toMatch(/<(?:img|svg|script)\b/i);
});
