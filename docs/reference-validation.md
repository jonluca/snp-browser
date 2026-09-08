# Reference integration validation

Validated locally on 2026-09-07 using the production Vite build and Chromium 152 on macOS. Synthetic genotypes were used throughout; no personal DNA was used for preparation or testing.

## Automated checks

- `bun test`: 146 passing tests (660 assertions) covering parsers, identity, SQL pagination, source routing, download integrity, bounded gzip decompression, cancellation, catalog lifecycle, cache cleanup, and source CSV export.
- `python3 -m unittest discover -s tools/reference/tests -v`: 29 passing tests covering official source adapters, allele cardinality, source selection, provenance, shard limits, duplicate handling, atomic publication, existing-file integrity, deterministic gzip conversion, and Python/TypeScript routing compatibility.
- `bun run typecheck`, `npx eslint .`, Prettier, and `git diff --check`.
- `bun run build`: copies only the catalog-selected reference files and their source provenance. SQLite checksums are checked again by browser downloads.

React Doctor also reviewed the changes. The compiler errors are resolved. Its remaining diagnostics concern component complexity/manual memoization, grouped state, and a small allele-array iteration. The CSV mutation warning describes a read-only export; it does not change cached data.

## Compressed catalog verification

- All 195 shards retain the same 5,773,714 annotations. Verified every original SQLite hash against its fully expanded gzip output. Download/storage bytes fell from **12,813,369,344 to 1,263,507,627**, a **90.14%** reduction; no evidence or source fields were removed.
- Cleared the original cached release through Data sources, then downloaded all seven compact packs through the production UI. An independent Cache API read counted exactly **195 gzip files and 1,263,507,627 stored bytes**, confirming the files remain compressed on disk.
- Repeated the same synthetic 100,000-call analysis offline before and after compression. Both produced **5,019 referenced variants**, **5,001 with allele/genotype annotations**, and **zero network requests**. The complete 5,019-row CSV exports were byte-identical (SHA-256 `7de394c81cd3cabd3471a45a72cae1aa15783d38efcd847abc05e09054d71f23`).
- The two local timing samples were **17.849 seconds uncompressed** and **19.853 seconds compressed**. This measures the complete browser workflow on this machine, not an isolated decompression benchmark or a guarantee for other devices. The approximately two-second difference is the observed tradeoff for the storage reduction.
- Verified the development and production-preview hosts serve `.sqlite.gzip` files without `Content-Encoding`. The `.gz` suffix was rejected during hosting QA because the static server automatically marked it as HTTP gzip, causing Fetch to expand bytes before application verification.
- The production build contains only the 195 selected compressed shards, with their manifests, provenance, selection report, and license. Obsolete original/intermediate releases are archived outside `public/`; the separate small sample catalog remains available for development.

## Browser checks

- Downloaded all seven original uncompressed packs in a fresh persistent browser profile: **5,773,714 annotations, 195 shards, 12,813,369,344 bytes**. Every file passed download size and SHA-256 verification. The library showed all seven packs saved and enabled.
- Final offline ClinVar gene search for `LOC129929063` returned all **57** records, matching an independent SQLite count. `rs1291411884` retained both `SAMD11` and `LOC129929063`. dbSNP search returned all four supplied GRCh37/GRCh38 allele records for `rs367994214`, and merged ID `rs5764786` resolved to `rs1118`. These lookups made **zero network requests**.
- Downloaded and verified the complete supplied ClinVar and curated GWAS packs, plus the common chromosome 22 gnomAD/VEP packs and pharmacogenomic metadata. The catalog at this stage contained approximately 12.7 GB of SQLite files, with every shard at most 64 MiB. dbSNP was still the small public sample during these initial measurements.
- With the browser offline, parsed a synthetic GRCh38 VCF and opened its annotations. There were **zero network requests**. The corresponding GRCh38 allele was confirmed; the GRCh37 record remained unresolved, and GWAS/gene-level evidence stayed contextual.
- A synthetic 100,000-call VCF containing 5,000 distinct public chromosome 22 variants completed parsing/matching in **14.9 seconds**, with **zero network requests** and 5,019 referenced results. The remaining calls were synthetic; a few coincided with public coordinates. This is a local benchmark, not a guarantee for other devices, storage, or whole-genome files.
- Exact GWAS search for `rs429358` returned all **1,421** records in **287 ms**, and cross-source details finished within **467 ms**. The UI initially rendered five GWAS cards; “Show more” expanded that to fifteen without removing any records from the result.
- After this workload, Chromium reported about **31 MB** of main-renderer JavaScript heap and **227 MB** of reference-worker backing storage, plus about **3.5 MB** of worker JavaScript heap. These are post-workload snapshots, not peak process memory; they exclude browser overhead and disk cache.
- Inspected desktop and 390-pixel mobile analysis/library layouts. The mobile document had no horizontal overflow, and variant details retained navigation back to the results.

- Fresh, uncached coordinate-only VCF lookup succeeds offline and produces gnomAD/VEP evidence without a fabricated SNPedia record. Fresh GWAS search and a 1,183-row CSV export also complete with zero network requests. The final CSV has 61 columns, including source release, citations, p-value, sample size, and effect size. Local query scheduling uses `networkMode: "always"` so connection status cannot pause database work.
- Deliberately evicted a cached CPIC file: browsing showed the storage error, entering Data sources offered retry, and re-download repaired it. Canceling a new ClinVar download left zero partial assets. Clearing reference downloads removed current and orphaned public assets while preserving unrelated cache data, SNPedia, and the uploaded analysis; the analysis correctly requested a refresh.
- A VCF containing only an unsupported reference block shows the specific no-supported-records error. Uploading a valid VCF immediately afterward succeeds and returns both expected variants.

## Scope

The prepared catalog's exact releases, record counts, coverage restrictions, and licenses are shown in **Data sources** and described in [reference-data.md](reference-data.md). Source order and exact variant/gene searches use local shard routing. All-fields searches and global sorts can read an entire enabled source. Source CSV export requires a result set of at most 100,000 records; larger requests are rejected explicitly.

These checks validate local implementation and static build artifacts. They do not assert that the assets or application have been deployed to the public production site.
