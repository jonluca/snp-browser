# Public reference data packs

All personal files, parsing, matching, searches, and exports stay in the browser. The application downloads **public reference assets** from a static host. These tools run separately, before deployment, to turn public releases into versioned SQLite files. They do not provide a service, read personal uploads, or send personal variants to an API.

`src/types/annotations.ts` defines the browser contract. Each source has its own provenance, license, prepared pack version, upstream `sourceRelease`, coverage description, and downloadable shards. Evidence from different sources remains separate. A clinical classification, a population frequency, a study association, a predicted consequence, and gene–drug evidence are different kinds of evidence.

## What is implemented

| Source             | Accepted input                                                         | Information retained                                                                                     | Interpretation boundary                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ClinVar            | Official VCF, `variant_summary.txt` TSV, optionally gzip               | Clinical classifications, conditions, gene, review status, evaluation dates when supplied                | Precise alleles only when assembly, VCF coordinates, reference and alternate bases are known. Multiallelic clinical assertions remain variant context. |
| dbSNP              | RefSNP JSON/JSONL, official VCF, optionally gzip/bzip2                 | Primary chromosome placements on GRCh37/GRCh38, alleles, rsIDs, merged aliases                           | SPDI coordinates converted from zero-based to one-based. Unanchored indels and unresolved placements are context, not a guessed allele match.          |
| gnomAD             | Sites VCF, gzip or BGZF                                                | Primary allele count, allele number, allele frequency, ancestry-group frequencies, filtering status      | VCF `Number=A/R` governs alternate-allele indexing. Does not infer an individual's ancestry or risk. Third-party prediction fields are excluded.       |
| GWAS Catalog       | Curated association TSV                                                | Trait, study, population/sample descriptions, reported effect size and risk allele, p-value, publication | Reported risk alleles are not assumed reference-forward. Associations remain variant context; no individual risk score is calculated.                  |
| Ensembl VEP        | VEP JSON/JSONL/REST array, VEP TSV, `--tab`, or annotated sites VCF    | Separate transcript/feature consequences, gene, protein changes and supplied predictions                 | No REST request contains a user's variants. TSV without an explicit genomic reference allele remains variant context.                                  |
| ClinPGx / PharmGKB | `clinical_annotations.tsv`, `var_*_ann.tsv`, exported public API JSON  | Drug-response evidence, evidence level, gene, dates, source text when supplied                           | No diplotype, phenotype, or prescription is inferred. Clinical metadata TSV alone does not include the separate genotype-text/evidence tables.         |
| CPIC               | Exported public `pair_view` JSON or compatible guideline metadata rows | Gene–drug evidence context, evidence level, citations, guideline links where supplied                    | Gene context only. Pairs without guidelines remain evidence context. Does not run CPIC's diplotype or recommendation lookups.                          |

The adapters preserve uncertainty. A missing genome assembly is not filled in from another record. Coordinates from different assemblies are never equated. Genome-wide dbSNP and gnomAD are very large; VEP requires **precomputation over public reference variants**. The browser does not run the Ensembl Perl pipeline or send a user's file to it.

## Prepared catalog coverage

The main manifest contains **5,773,714 annotations in 195 compressed SQLite shards, totaling 1,263,507,627 bytes** for download and browser storage. This preserves the complete original 12,813,369,344-byte corpus while reducing asset size by **90.14%**. Only one shard is expanded at a time for queries. Counts are annotation rows, not unique people or unique variants across sources. `sample-manifest.json` separately retains the small initial catalog for browser QA.

| Source       | Original SQLite bytes | Compressed asset bytes |
| ------------ | --------------------: | ---------------------: |
| ClinVar      |         7,940,599,808 |            766,667,207 |
| dbSNP        |           107,466,752 |             11,790,366 |
| gnomAD       |           331,919,360 |             51,949,817 |
| GWAS Catalog |         4,243,554,304 |            415,188,222 |
| Ensembl VEP  |           182,349,824 |             16,949,382 |
| ClinPGx      |             6,787,072 |                890,371 |
| CPIC         |               692,224 |                 72,262 |

Gzip level 9 was applied to the complete catalog. Every input SQLite hash and every fully expanded output hash matched. No record, source field, citation, review status, or routing key was removed. Manifest/provenance metadata and the existing SNPedia database are separate from these shard-byte totals.

| Source       | Upstream release                       | Annotation rows | Exact scope                                                                                                                                              |
| ------------ | -------------------------------------- | --------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ClinVar      | VCF 2026-09-05                         |       4,469,028 | Complete supplied GRCh38 VCF, including every supplied gene symbol; precise-location variants only.                                                      |
| dbSNP        | Chr22 RefSNP file dated 2025-01-15     |         134,733 | GRCh37/GRCh38 alleles and available merges for 33,721 public rsIDs selected from the gnomAD corpus below; 171 selected IDs absent from this source file. |
| gnomAD       | 4.1.1 exomes                           |          38,854 | Chromosome 22, GRCh38, `FILTER=PASS` and overall `AF>=0.001`; primary frequency metrics and ancestry-group frequencies.                                  |
| GWAS Catalog | Curated association file 2026-09-04    |       1,005,214 | Complete supplied curated association table, rows with rsIDs; rsID grouping preserves all annotations and reduces local file reads.                      |
| Ensembl      | VEP 105 bundled with gnomAD 4.1.1      |         120,125 | Consequences for the same public chromosome 22 corpus; canonical or MANE transcripts only.                                                               |
| ClinPGx      | Clinical metadata archive 2025-07-05   |           5,186 | Complete supplied clinical annotation metadata table; separate genotype-text and evidence tables are not imported.                                       |
| CPIC         | Public `pair_view` snapshot 2026-09-07 |             574 | Complete paginated gene–drug pair metadata, including evidence levels and guideline links where supplied.                                                |

The full dbSNP chromosome 22 file was scanned: 16,139,102 RefSNP records. Its derived identity pack includes 17,354 distinct alias-to-rsID pairs. All documented alleles for selected IDs are retained, so an individual alternate allele in the dbSNP pack is not necessarily common. The source-specific coverage limits remain visible in the browser.

The final ClinVar pack indexes all overlapping gene symbols in 482,276 records. A SHA-256 comparison over every one of its 4,469,028 annotation payloads, excluding only the changed `gene` field, verified that all other payload content stayed identical to the initial full build. The validation digest is retained in its provenance.

## Build the initial public catalog

Python 3.10+ and SQLite from Python's standard library are sufficient. `curl` is used only as a fallback for public hosts that reject Python's HTTP transport. No Python packages or API keys are required.

Git includes the prepared catalog metadata and version manifests, but excludes the SQLite binaries. A fresh clone therefore cannot reuse those prepared versions without separately restoring their exact shard files. Choose a new unused local version, such as `local-initial-1` below, to build assets from public sources. Existing versions are reused only after every local shard passes presence, byte-size, and SHA-256 checks; an incomplete or corrupt version fails with instructions to use a new version and is never overwritten.

```sh
python3 tools/reference/prepare_public.py --version local-initial-1
python3 -m unittest discover -s tools/reference/tests -v
```

This creates `public/references/manifest.json`. Its default coverage is deliberately mixed:

- ClinVar: the first 200 public GRCh38 VCF records.
- dbSNP and Ensembl: five fixed public identifiers listed in `prepare_public.py`.
- gnomAD: the first 100 records of the public 4.1.1 exome chromosome 22 VCF.
- GWAS: the first 200 rows of the curated association table, keeping rows with rsIDs.
- ClinPGx: the complete supplied clinical annotation **metadata table**. The archive currently served by the official download endpoint identifies itself as `CREATED_2025-07-05`; fetching it in 2026 does not make the upstream data a 2026 release.
- CPIC: the complete public gene–drug `pair_view`, paginated explicitly.

These subsets are labeled **Sample** in pack coverage. They test actual source integration; they are not genome-wide releases. To prepare larger ClinVar and GWAS packs through the same script, use a new version with `--full-clinvar --full-gwas`. That builds all usable records in the supplied files, not source information absent from those formats.

The download cache is reused to support reproducible local rebuilds. **Use a new empty `--cache` directory when fetching a new upstream release.** Changing only `--version` does not refresh cached files. Every output includes input SHA-256, byte size, source URL (for `prepare_public.py`), and coverage metadata. Upstream `latest` URLs can change; pin immutable official release URLs and retained raw-file hashes for production.

## Prepare a full release from pinned input files

Use the official download directories below to choose the actual release and assembly. `build.py` accepts repeated `--input` arguments for chromosome files from the same release and streams them with bounded memory. It never downloads a URL implicitly.

```sh
python3 tools/reference/build.py download \
  --url 'https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz' \
  --output /data/references/clinvar.vcf.gz

python3 tools/reference/build.py build \
  --source clinvar --format vcf --assembly GRCh38 \
  --input /data/references/clinvar.vcf.gz \
  --id clinvar-grch38 --version 2026-09-05 \
  --source-release 'VCF 2026-09-05' \
  --coverage 'ClinVar 2026-09-05 GRCh38 complete supplied VCF; precise-location variants only.'
```

For reproducible downloads, pass `--sha256` with a previously verified input hash. The hash printed by `download` is the downloaded raw file's SHA-256. The `build` command writes additional input provenance to the output version directory. Set `--source-release` to the verified upstream release or dated public snapshot; this differs from `--version`, which identifies your prepared immutable pack. `prepare_public.py` derives upstream labels from source headers, archive dates, or retained fetch receipts when available.

For dbSNP, pass official per-chromosome RefSNP JSONL files, including the merged-record file if you need historical aliases. `--assembly GRCh38` selects that assembly; omit it for explicit primary placements on both supported assemblies. RefSNP data without a supported primary chromosome placement is not invented or placed on another chromosome. Official VCF is also supported but cannot provide aliases absent from that file.

For gnomAD, use the official release's per-chromosome **sites** files with `--source gnomad --format vcf --assembly GRCh38`. The 4.1.1 exome and genome files use GRCh38; older releases may use GRCh37. Build distinct pack IDs for exomes, genomes, releases, or assemblies. Primary counts/frequencies are retained, and filtering status stays visible. Downloading every chromosome can require hundreds of gigabytes of raw assets.

For GWAS, extract the curated association TSV from the official archive and pass `--source gwas --format tsv`. The curated association catalog is different from study-level summary-statistics files. Set `--assembly` only after verifying the release's mapped assembly. Without that verification, rsID matching still works as variant context. The archive fetched for this implementation contains a 740 MB TSV.

For Ensembl, run the official VEP offline CLI with a pinned cache/FASTA on **public dbSNP/reference variants**, e.g. `vep --offline --cache --assembly GRCh38 --format vcf --json ...`, then pass its output to `--source ensembl --format json`. Keep the exact VEP, cache, FASTA, input release, and plugin versions in the release provenance. Preserve licenses for any optional third-party annotations; the initial pack uses basic Ensembl consequences and does not enable restricted plugins. The builder does not download or install the VEP runtime.

For ClinPGx, extract an exact known archive member such as `clinical_annotations.tsv`; do not indiscriminately concatenate companion tables with different schemas. Imported JSON can be an array, JSONL, a single object, or the public API's success envelope. Full genotype-specific text and evidence tables can be exported as enriched JSON with explicit source context, but they do not become personal allele matches without a normalized genomic allele. The initial clinical metadata pack retains source links for the full annotation.

For CPIC, export `https://api.cpicpgx.org/v1/pair_view` with pagination (`limit` and `offset`) and build with `--source cpic --format json`. The initial fetch script already paginates. This adds guideline discovery and gene–drug context, not a pharmacogenomic calling engine.

## Shards, manifests, and publishing

### Common chromosome 22 reference corpus

A larger public corpus aligns gnomAD, Ensembl, and dbSNP without any personal queries. The full gnomAD 4.1.1 exome chromosome 22 input is 5,079,291,100 bytes and matches the official MD5 `4543f706701bc746bf291884fd277934`. It contains 4,845,199 sites. Filtering on source `FILTER=PASS` and overall allele frequency `AF>=0.001` selects 38,854 source rows. These are common population variants on one chromosome, not rare-variant or genome-wide coverage.

```sh
python3 tools/reference/select_public_vcf.py \
  --input /data/references/gnomad.exomes.v4.1.1.sites.chr22.vcf.bgz \
  --output /data/references/gnomad-chr22-common.vcf --min-af 0.001

python3 tools/reference/build.py build \
  --source gnomad --format vcf --assembly GRCh38 \
  --input /data/references/gnomad-chr22-common.vcf \
  --id gnomad-chr22-common --version 4.1.1-pass-af001 \
  --source-release '4.1.1 exomes' \
  --min-af 0.001 --pass-only \
  --coverage 'gnomAD exomes 4.1.1 chromosome 22, GRCh38; PASS and AF>=0.001 only.'

python3 tools/reference/build.py build \
  --source ensembl --format vcf --assembly GRCh38 \
  --input /data/references/gnomad-chr22-common.vcf \
  --id ensembl-chr22-common --version vep105-gnomad4.1.1-af001 \
  --source-release 'VEP 105, bundled with gnomAD 4.1.1' \
  --min-af 0.001 --pass-only --canonical-only \
  --coverage 'Ensembl VEP105 as distributed by gnomAD4.1.1; chr22 PASS/AF>=0.001, canonical or MANE transcripts only.'

python3 tools/reference/select_refsnp.py \
  --input /data/references/refsnp-chr22.json.bz2 \
  --public-vcf /data/references/gnomad-chr22-common.vcf \
  --output /data/references/refsnp-chr22-common.jsonl

python3 tools/reference/build.py build \
  --source dbsnp --format json \
  --input /data/references/refsnp-chr22-common.jsonl \
  --id dbsnp-chr22-common --version public-2026-09-07-chr22-common \
  --source-release 'chr22 RefSNP file dated 2025-01-15' \
  --coverage 'Official chr22 RefSNP records for explicit rsIDs in the fixed public gnomAD common chr22 corpus; documented GRCh37/GRCh38 placements and available merges.'
```

The gnomAD file's header identifies its precomputed consequences as **VEP v105**. The Ensembl-derived pack preserves that version, transcript IDs, allele numbers, and consequences. `--canonical-only` retains canonical or MANE transcripts and excludes other transcripts/regulatory records. It does not pretend to be a freshly run current Ensembl annotation. Removing that flag includes all supplied consequence entries. LOFTEE fields are excluded from this Ensembl pack.

For multiallelic sites, the first selection retains any row with at least one qualifying alternate allele. The same `--min-af` during the pack build then filters each individual alternate allele using VCF `Number=A` metadata. Both stages are needed to retain the stated per-allele frequency scope.

The official dbSNP chromosome 22 JSON archive is 6,686,858,433 bytes, dated 2025-01-15 in the source directory. The selector scans it and retains complete RefSNP objects for explicit identifiers in the fixed public VCF. It preserves all documented alleles and available active-record merge history; it does not assert that every alternative allele is common. Missing identifiers are reported. Historical merge data absent from those records would require the separate official merged-record release. Both raw selection inputs and their hashes are retained in selection reports. These scripts reject VCFs with individual sample columns and never make per-person requests.

The selector uses Python's standard bzip2 decoder by default. Optional parallel decoding can accelerate large public archives with the [indexed_bzip2 library](https://github.com/mxmlnkn/librapidarchive). Install it into an isolated environment, then pass `--bz2-threads 8`. The local build used version 1.7.0 and verified an identical SHA-256 over 512 MiB of decoded data and over 1.12 GB of selected output before replacing the serial run. The optional decoder changes preparation speed only; it is not shipped to the browser.

```sh
python3 -m pip install --target tools/reference/.cache/python-deps indexed_bzip2==1.7.0
PYTHONPATH=tools/reference/.cache/python-deps python3 tools/reference/select_refsnp.py \
  --input /data/references/refsnp-chr22.json.bz2 \
  --public-vcf /data/references/gnomad-chr22-common.vcf \
  --output /data/references/refsnp-chr22-common.jsonl --bz2-threads 8
```

### File and routing guarantees

After building and merging an uncompressed catalog, prepare compact versions with:

```sh
python3 tools/reference/compact.py public/references/manifest.json --level 9 --jobs 4
```

This creates new immutable versions with a `-gzip-v1` suffix, verifies the original and fully expanded file hashes, retains source provenance and licenses, and replaces the main catalog only after every output verifies. Original versions remain available locally. Repeating the command on already compressed input is rejected; use the original catalog and a new suffix for a new compression release. The input manifest must be alongside its pack/version directories. `--output-manifest` can retain the original catalog while publishing a separate compact catalog. Gzip output is deterministic for the same input and Python/zlib versions.

Reference shards can be published as lossless `.sqlite.gzip` assets. The browser stores the compressed file and expands one shard at a time in its worker before opening SQLite. All annotation rows, source fields, routing keys, citations, and genome-build information are preserved. The manifest's `bytes` and `sha256` describe the downloaded file; optional `compression: { format: "gzip", uncompressedBytes, uncompressedSha256 }` describes the exact original SQLite bytes. Older uncompressed packs remain supported.

Both stored and expanded bytes have declared size limits and SHA-256 checks. Initial downloads verify both representations before saving. Queries verify cached files locally, without making a request for a user's variants. Canceling a query leaves valid cached files intact. The worker uses the browser's [standard decompression API](https://compression.spec.whatwg.org/#decompression-stream); browsers without gzip decompression support receive an explicit update-browser error.

Serve `.sqlite.gzip` files as `Content-Type: application/gzip` (or `application/octet-stream`) **without `Content-Encoding: gzip`**. The `.gzip` extension avoids the `.gz` suffix handling in Vite's static server, which otherwise automatically adds that encoding header. These are compressed application assets, not HTTP transport compression: automatic Fetch decoding would change the bytes before integrity verification and storage. Ordinary HTTP compression of JSON manifests is independent of this rule. The prepared catalog uses immutable `-gzip-v2` versions with these filenames.

Restart the Vite development server after preparing new public reference files. Its watcher deliberately excludes large reference-build outputs; a restart refreshes the public-file inventory. Production builds copy only the catalog-selected assets.

Older downloaded versions are retained until the user removes them. To reclaim their space when upgrading, reload the app, choose **Data sources → Clear reference downloads**, and download the new packs. This also clears older files that are absent from current-pack counts. SNPedia and the open analysis are preserved; references can be selected again after downloading.

Each SQLite file has `annotations` and `aliases` tables even if no aliases are supplied. Indexes cover case-insensitive rsIDs, assembly/chromosome/position, gene, and aliases. `annotations.payload` is a serialized `VariantAnnotation`; the SQL columns support lookup without loading all JSON.

Each shard also has a public Bloom routing index in its manifest. It contains normalized rsIDs (including aliases), assembly-specific loci, and gene symbols. The browser uses it to skip irrelevant **already downloaded** shards during detail lookup. It never uses a person's variants to choose remote download URLs. Routing is conservative: false positives can open an extra local shard, but there must be no false negatives. The builder verifies every inserted routing key. Existing SQLite assets can receive routing without changing their checksums:

```sh
python3 tools/reference/build.py refresh-routing \
  public/references/clinvar-grch38/2026-09-05/manifest.json
```

Refresh routing before compression. Running `refresh-routing` directly on a gzip pack is rejected; it requires the original SQLite files.

The shared routing format is `fnv1a-double-v1`: seven hashes, UTF-8 FNV-1a seeds `2166136261` and `2166136261 XOR 0x9e3779b9`, an odd second hash, unsigned 32-bit arithmetic, and little-endian bits within each byte. There are 20 bits per unique key, at least 1,024 bits, rounded to a byte. Decoded routing is capped at 16 MiB per shard. Merging a refreshed per-version manifest publishes the new routing.

- Each finished file is at most `--max-shard-mib` (64 MiB by default), including indexes. An individual record too large for a shard fails explicitly.
- Each shard has its actual bytes, SHA-256, and record count in the manifest. The builder runs SQLite `quick_check` before publishing a version directory.
- Global duplicate detection uses a disk-backed identity index. Identical repeated records are skipped; conflicting records with the same ID fail the build.
- GWAS builds group annotations by rsID using an additional disk-backed sort. This keeps a frequently studied variant in one or two shards instead of scattering its studies over the entire pack. Other sources can opt into `--group-by-variant`. This preserves every annotation; it changes file order, not evidence.
- A failed build removes its staging directory and publishes no partial version. Existing version directories cannot be silently overwritten.
- `SOURCE_DATE_EPOCH` fixes output timestamps for reproducibility. Byte-for-byte SQLite reproduction also requires the same Python/SQLite versions and ordered inputs.
- Shard limits bound browser memory for one reference database. Total network, persistent-storage, and lookup costs still grow with total reference data. Use separately downloadable source/release/assembly packs and review browser quota errors.

Merge completed manifests explicitly. Duplicate pack IDs fail rather than silently replacing a source:

```sh
python3 tools/reference/build.py merge \
  public/references/clinvar/public-2026-09-07-full-genes/manifest.json \
  public/references/dbsnp-chr22-common/public-2026-09-07-chr22-common/manifest.json \
  public/references/gnomad-chr22-common/4.1.1-pass-af001/manifest.json \
  public/references/gwas/public-2026-09-07-grouped/manifest.json \
  public/references/ensembl-chr22-common/vep105-gnomad4.1.1-af001/manifest.json \
  public/references/clinpgx/public-2026-09-07/manifest.json \
  public/references/cpic/public-2026-09-07-context/manifest.json \
  --output public/references/manifest.json
```

Upload versioned shard files and their license/provenance alongside the application assets, then publish the merged manifest **last**. Use `--base-url https://your-static-host.example/references` when building for a separate static asset origin and configure its CORS for the app. Serve immutable versioned shard URLs with long caching; serve the manifest with revalidation. SQLite/raw binary assets are ignored by Git and must be included in the static deployment separately. No production publishing is performed by these preparation scripts.

## Official source and license references

Metadata is centralized in `tools/reference/sources.json`. The relevant primary documentation was checked on 2026-09-07:

- [ClinVar downloads and format coverage](https://www.ncbi.nlm.nih.gov/clinvar/docs/downloads/) and [ClinVar file interpretation](https://www.ncbi.nlm.nih.gov/clinvar/docs/ftp_primer/). [NCBI molecular-data policy](https://www.ncbi.nlm.nih.gov/home/about/policies/) places no NCBI restrictions on molecular-data use/distribution and explains contributor rights. Preserve NCBI acknowledgment and source links.
- [dbSNP RefSNP data and download/API links](https://www.ncbi.nlm.nih.gov/snp/docs/RefSNP_about/). The supported current API path is `/variation/v0/refsnp/{id}`, without the former `/beta` segment.
- [gnomAD downloads](https://gnomad.broadinstitute.org/downloads) and [official terms source](https://github.com/broadinstitute/gnomad-browser/blob/main/browser/about/policies/terms.md). Primary exome/genome data use CC0 1.0; third-party annotations can have different restrictions. The builder includes primary frequency data and source filters only.
- [GWAS download formats](https://www.ebi.ac.uk/gwas/docs/file-downloads) and [GWAS terms FAQ](https://www.ebi.ac.uk/gwas/docs/faq). Curated association data use EMBL-EBI terms; do not assume the CC0 statement for many summary-statistics datasets applies identically to every catalog product.
- [Ensembl VEP output formats](https://www.ensembl.org/info/docs/tools/vep/vep_formats.html) and [Ensembl data policy](https://www.ensembl.org/info/about/legal/disclaimer.html). Ensembl-generated data are unrestricted; integrated third-party annotations can have separate terms.
- [ClinPGx public API](https://api.clinpgx.org/) and [downloads](https://www.clinpgx.org/downloads). The fetched archive's `LICENSE.txt` specifies CC BY-SA 4.0. Derived ClinPGx data packs retain that license and attribution; no endorsement is implied.
- [CPIC API](https://api.cpicpgx.org/), [CPIC database](https://github.com/cpicpgx/cpic-data), and [current CPIC content license](https://github.com/cpicpgx/cpic-data/blob/main/LICENSE.md). CPIC curated content is CC0 1.0, with requested attribution, source dates/versions, linked guideline publications, and notice that guidelines change. CPIC's terms differ from PharmGKB's annotation license even though both are part of ClinPGx.
