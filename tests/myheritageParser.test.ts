import { expect, test } from "bun:test";
import { detectFormat } from "../src/parsers";
import parserMyHeritage from "../src/parsers/myheritage";

const myHeritageContent = [
  "##fileformat=MyHeritage",
  "# MyHeritage DNA raw data.",
  "RSID,CHROMOSOME,POSITION,RESULT",
  '"rs123","1","12345","AG"',
  '"rs456","2","23456","CC"',
  '"rs789","X","34567","--"',
].join("\n");

test("MyHeritage parser handles quoted CSV exports", async () => {
  const validation = parserMyHeritage.validate(myHeritageContent);
  expect(validation.valid).toBe(true);

  const result = await parserMyHeritage.parse(myHeritageContent, () => undefined);

  expect(result.errors).toEqual([]);
  expect(result.genotypes).toEqual([
    {
      rsid: "rs123",
      chromosome: "1",
      position: "12345",
      genotype: "ag",
    },
    {
      rsid: "rs456",
      chromosome: "2",
      position: "23456",
      genotype: "cc",
    },
    {
      rsid: "rs789",
      chromosome: "X",
      position: "34567",
      genotype: "--",
    },
  ]);
});

test("registry prefers MyHeritage for MyHeritage exports", () => {
  const detection = detectFormat(myHeritageContent);

  expect(detection.parser?.metadata.id).toBe("myheritage");
});
