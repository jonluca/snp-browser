import { expect, test } from "bun:test";
import type { ReferenceShard } from "../src/types/annotations";
import {
  filterReferenceKeys,
  MAX_REFERENCE_ROUTING_BYTES,
  prepareReferenceKeys,
  referenceLookupKeys,
  shardMayContain,
  validateReferenceRouting,
} from "../src/workers/referenceRouting";
import golden from "./fixtures/reference-routing-golden.json";

const shard: ReferenceShard = {
  url: "data.sqlite",
  bytes: 4096,
  records: 7,
  sha256: "0".repeat(64),
  routing: golden.routing as ReferenceShard["routing"],
};

test("Python golden routing fixture preserves ASCII, UTF-8, 32-bit wrap, and little-endian bit membership", () => {
  // Generated independently with Python integer arithmetic. A non-power-of-two
  // bitCount makes wrapping before modulo observable in this fixture.
  validateReferenceRouting(golden.routing);
  const inserted = golden.entries.map((entry) => entry.key);
  for (const key of inserted) expect(shardMayContain(shard, [key])).toBe(true);
  expect(filterReferenceKeys(shard, inserted)).toEqual(inserted);
  expect(shardMayContain(shard, ["r:rs999", "g:UNRELATED", "l:GRCh38:1:100"])).toBe(false);
  expect(shardMayContain(shard, ["r:rs999", "g:BRCA1"])).toBe(true);
});

test("prepared genome-wide keys agree with direct lookups and snapshot caller arrays", () => {
  const keys = [...golden.entries.map((entry) => entry.key), "g:UNRELATED", "r:rs999"];
  const prepared = prepareReferenceKeys(keys);
  expect(filterReferenceKeys(shard, prepared)).toEqual(filterReferenceKeys(shard, keys));
  expect(shardMayContain(shard, prepared)).toBe(true);
  keys.splice(0, keys.length, "g:UNRELATED");
  expect(shardMayContain(shard, keys)).toBe(false);
  expect(shardMayContain(shard, prepared)).toBe(true);
});

test("routing keys normalize assemblies and explicit loci without inventing unknown metadata", () => {
  expect(
    referenceLookupKeys(" RS000123 ", { assembly: "hg19", chromosome: "chr01", position: "0100" }, [
      "brca1;CYP2D6",
      " BRCA1 ",
    ]),
  ).toEqual(["r:rs123", "l:GRCh37:1:100", "g:BRCA1", "g:CYP2D6"]);
  expect(referenceLookupKeys(undefined, { assembly: "GRCh38", chromosome: "chrM", position: 16569 }, ["ÅΩ"])).toEqual([
    "l:GRCh38:MT:16569",
    "g:ÅΩ",
  ]);
  expect(referenceLookupKeys("i123", { chromosome: "1", position: 100 })).toEqual([]);
  expect(referenceLookupKeys("rs0", { assembly: "GRCh38", chromosome: "23", position: 100 })).toEqual([]);
  expect(referenceLookupKeys(undefined, { assembly: "GRCh38", chromosome: "1", position: "1e2" })).toEqual([]);
});

test("legacy packs always remain eligible while valid empty queries can skip indexed shards", () => {
  const legacy = { ...shard, routing: undefined };
  expect(shardMayContain(legacy, ["r:rs999"])).toBe(true);
  expect(filterReferenceKeys(legacy, ["r:rs999"])).toEqual(["r:rs999"]);
  expect(shardMayContain(legacy, [])).toBe(true);
  expect(shardMayContain(shard, [])).toBe(false);
  validateReferenceRouting(undefined);
});

test("invalid routing fails visibly instead of silently excluding reference data", () => {
  const invalid = [
    null,
    {},
    { ...golden.routing, algorithm: "unknown" },
    { ...golden.routing, hashes: 6 },
    { ...golden.routing, bitCount: 1023 },
    { ...golden.routing, bitCount: 1041 },
    { ...golden.routing, bitCount: (MAX_REFERENCE_ROUTING_BYTES + 1) * 8 },
    { ...golden.routing, bits: golden.routing.bits.slice(0, -1) },
    { ...golden.routing, bits: " ".repeat(golden.routing.bits.length) },
    { ...golden.routing, bits: golden.routing.bits.replace(/.$/, "-") },
    { ...golden.routing, bits: golden.routing.bits.replace(/g==$/, "h==") },
  ];
  for (const routing of invalid) {
    expect(() => validateReferenceRouting(routing)).toThrow("routing index");
    expect(() => shardMayContain({ ...shard, routing } as ReferenceShard, [])).toThrow("routing index");
  }
});

test("decoded routing cache notices changed metadata instead of reusing stale bits", () => {
  const mutable = { ...golden.routing };
  const changed = { ...shard, routing: mutable } as ReferenceShard;
  expect(shardMayContain(changed, ["r:rs123"])).toBe(true);
  mutable.bits = "!".repeat(mutable.bits.length);
  expect(() => shardMayContain(changed, ["r:rs123"])).toThrow("routing index");
});
