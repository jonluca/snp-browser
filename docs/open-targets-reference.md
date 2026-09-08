# Open Targets fine-mapping reference pack

This optional pack adds GWAS fine-mapping evidence while keeping analysis local. Preparation downloads public, release-pinned files once; the application later downloads a compressed SQLite asset from the same static reference host as the other packs. No personal file, locus, or genotype is sent to Open Targets or FinnGen.

The initial selection is fixed in `tools/reference/open_targets.py`, independent of any uploaded DNA:

| Study ID | Source phenotype definition |
| --- | --- |
| `FINNGEN_R12_G6_ALZHEIMER` | Alzheimer disease |
| `FINNGEN_R12_G6_PARKINSON` | Parkinson's disease |
| `FINNGEN_R12_K11_CD_STRICT2` | Crohn disease, strict definition: require KELA and at least two HDR records |

These are three FinnGen R12 studies published in the **Open Targets Platform 26.06** output. This is a focused disease pack, not the full Open Targets catalog or all studies of these diseases. Exact case/control counts, source phenotype labels, disease identifiers, publication IDs, discovery/replication ancestry, cohort metadata, and available source dates are retained per annotation.

The prepared `26.06-finngen-neuro-crohn-v2-gzip-v1` pack contains **3,667 unique variants across 46 credible sets**, in one **844,113-byte** compressed SQLite asset (30,658,560 bytes expanded). Alzheimer disease contributes 837 variants in 29 sets; Parkinson disease 2,506 variants in 4 sets; strict Crohn disease 324 variants in 13 sets. Counts describe the supplied fine-mapping sets, not clinical diagnoses or independent replications. Preparation fetched 462,606,497 bytes of credible-set columns plus a previously downloaded 98,706,914-byte study file; those upstream preparation downloads are not part of the browser download.

## Coverage and interpretation

The builder scans every published `credible_set` partition's study identifiers. For matching studies it retains every supplied member of the **95% credible set**, with the member's posterior inclusion probability (PIP), beta, standard error, p-value components, Bayes factor, and LD statistic when supplied. The source study and credible-set metadata stay separate from the member statistics, so a lead variant's effect is never substituted for another member's effect.

PIP expresses uncertainty in the source fine-mapping model for one study signal. It is **not a person's disease probability**. The pack does not calculate absolute risk, infer an effect allele, reinterpret beta as an odds ratio, or assign clinical pathogenicity. Every annotation has `scope: "variant"`.

Open Targets specifies GRCh38 and 1-based `chromosome_position_REF_ALT` variant identifiers. Explicit sequences are preserved for SNPs and small indels. Hashed `OTVAR` identifiers or inconsistent alleles cause a clear preparation error rather than fabricated coordinates. No rsIDs are present in this input dataset, so these records currently match uploaded GRCh38 loci. GRCh37 coordinates are not lifted over or equated with GRCh38.

Identity is `(studyId, studyLocusId, variantId)`. Identical duplicate members and source sets are collapsed; conflicting duplicates fail preparation. A variant can legitimately occur in multiple signals or studies. Those rows are not assumed to represent independent replication, and this pack does not import Open Targets' aggregate gene-disease evidence scores. Repeated studies or overlapping cohorts in another source must not be counted as independent support.

The selection excludes other studies, molecular QTLs, members found only in the 99% set, and the separate credible-set `ldSet` neighbour table. The locus-member LD field remains when supplied. Complete selected 95% membership is required: the converter validates its PIP sum against the source's [0.95, 1] criterion, with only a small floating-point tolerance. A partial selected set cannot silently become a complete-looking pack.

## Rebuild

Python prepares the public data; PyArrow is an optional **build-time** dependency. It is not shipped to the browser. The prepared snapshot used PyArrow 25.0.1.

```sh
python3 -m venv /tmp/snp-opentargets-env
/tmp/snp-opentargets-env/bin/pip install pyarrow==25.0.1
/tmp/snp-opentargets-env/bin/python tools/reference/open_targets.py \
  --cache /data/public-references/opentargets-26.06 \
  --output public/references \
  --version 26.06-finngen-neuro-crohn-v2 \
  --jobs 4
```

The release and public study IDs are explicit constants. To change selection or release, update those constants, review source compatibility, and use a new empty cache and immutable version. The tool never accepts personal variant lists. `--max-download-mib` limits newly downloaded range bytes (768 MiB by default); exceeding it fails without publishing a partial pack. Cached bytes do not consume that per-run network budget.

To avoid downloading the full multi-gigabyte credible-set dataset, the tool reads Parquet columns via HTTPS ranges. Each response must carry the expected exact byte range and unchanged strong ETag. Cached ranges are checked against individual SHA-256 receipts. The provenance records the release URLs, source size/ETag, requested ranges and hashes, projected columns, selected snapshot hash, build/runtime versions, and compressed/uncompressed shard hashes. Existing incomplete or corrupt caches fail explicitly.

`--study-file` can reuse an already downloaded official 26.06 study Parquet instead of fetching it again. Its full SHA-256 and source URL are recorded. The local prepared pack used the official file named `part-00000-1c0a4198-4d65-425e-82a1-d9d8b54d8549-c000.snappy.parquet`.

After collection, `selected.json` and `selection-provenance.json` remain in the cache. An offline rebuild validates that exact selected snapshot hash:

```sh
/tmp/snp-opentargets-env/bin/python tools/reference/open_targets.py \
  --cache /data/public-references/opentargets-26.06 \
  --output public/references \
  --version 26.06-finngen-neuro-crohn-rebuild \
  --reuse-selected
```

The wrapper uses the existing SQLite builder and lossless gzip compactor, then publishes one new `opentargets/<version>-gzip-v1` directory atomically. It does not modify the main catalog or upload anything. Source registration, catalog merging, and static-host publication are handled separately. Shard checksums, licenses, and provenance must accompany publication; publish the main catalog last.

Run the converter's synthetic regressions with:

```sh
python3 -m unittest discover -s tools/reference/tests -p test_open_targets.py -v
```

## Sources and licensing

Open Targets marks its data [CC0 1.0](https://platform-docs.opentargets.org/licence). The derived pack retains attribution and source publication links, including the requested [Open Targets Platform publication](https://academic.oup.com/nar/article/53/D1/D1467/7917960).

Primary documentation checked on 2026-09-07:

- [Release 26.06 bulk dataset directory](https://ftp.ebi.ac.uk/pub/databases/opentargets/platform/26.06/output/), containing the pinned `study` and `credible_set` Parquet partitions.
- [Dataset download format and access](https://platform-docs.opentargets.org/data-access/datasets).
- [Credible-set membership, exclusion criteria, and probability/effect meanings](https://platform-docs.opentargets.org/credible-set).
- [Variant assembly, coordinates, and explicit versus hashed identifiers](https://platform-docs.opentargets.org/variant).
- [Study definitions and cohort/ancestry metadata](https://platform-docs.opentargets.org/study).
