# Curated reference packs

These packs add expert-curated gene–disease and protein-variant context to the
existing reference catalog. The browser downloads immutable public reference
files, verifies both compressed and decoded SHA-256 digests, and performs all
personal matching locally. Source preparation has no DNA-file argument and does
not send a user's identifiers, gene list or variants to an upstream service.

## Included snapshots

| Pack | Upstream snapshot | Records | Download bytes |
| --- | --- | ---: | ---: |
| ClinGen gene validity | CSV created 2026-09-08 | 3,670 | 902,355 |
| Orphanet rare disease genes | Product 6 XML, 2026-06-23 | 8,503 | 1,926,102 |
| UniProt curated human variants | 2026_02, 10-Jun-2026 | 70,891 | 10,660,858 |

The combined download is 13,489,315 bytes (12.9 MiB), split into four gzip shards.
The release directory is `2026-09-08-curated-v1-gzip-v1`. Each source directory
includes its own manifest, source URL, input checksum, selection counts, license,
release date and compression verification in `provenance.json`. Source snapshot
dates are independent of the application build date. No full raw XML or text
snapshot is committed or sent to R2 by the preparation tool.

### ClinGen

The [official gene-validity CSV](https://search.clinicalgenome.org/kb/gene-validity/download)
is linked from [ClinGen's download catalog](https://search.clinicalgenome.org/kb/downloads).
Every supplied row with a gene, HGNC identifier, MONDO identifier and curation
identity is retained. The snapshot contains 3,670 such rows and no excluded rows.
The original classification, mode of inheritance, SOP, classification date,
expert panel and curation link remain attached. Limited, disputed, refuted and
other classifications are preserved instead of silently treating them as support.

These records have `scope: gene`. They describe the strength of a gene–disease
relationship, not whether a particular called allele causes the disease. This
pack does not include ClinGen's separate dosage, actionability or variant-curation
datasets. [ClinGen curated content is CC0](https://clinicalgenome.org/docs/terms-of-use/);
the pack retains attribution and the access date.

### Orphanet

The [English product 6 XML](https://www.orphadata.com/data/xml/en_product6.xml)
is linked from [Orphadata Science's gene download page](https://sciences.orphadata.com/genes/).
The snapshot supplies 4,245 disorder entries and 8,503 gene relationships. All
relationships are retained, including cluster symbols such as `SNORD116@`.
The source's exact disorder or subtype, association type, assessment status,
gene identifiers and validation references are preserved. No relationships are
propagated to parent diseases, and cytogenetic gene locations are not converted
into guessed variant coordinates.

These records have `scope: gene`. Candidate, susceptibility, somatic and other
relationship types remain distinguishable from germline disease-causing
relationships. The XML declares CC BY 4.0; attribution and transformation notes
follow the [Orphadata Science citation guidance](https://sciences.orphadata.com/faq/).
The original website link embedded in XML is not executed; the adapter constructs
an HTTPS disease link from the ORPHA identifier. XML DTD/entity declarations are
rejected.

### UniProt

The [official humsavar table](https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/complete/docs/humsavar.txt)
contains 84,845 literature-curated protein-variant rows. The pack retains all
70,891 rows with a valid rsID; 13,954 rows lacking an rsID are counted as omitted.
Benign and uncertain categories are retained alongside pathogenic categories.
One protein feature can appear against multiple disease names; each association
is preserved with its original feature ID, protein substitution and source
category. Disease/sample text is retained as supplied, including cancer-sample
labels; it is not promoted into an inherited-disease conclusion.

These records have `scope: variant`, with no assembly, REF, ALT or invented genomic
position. An rsID identifies context and cannot establish that the user carries
the source protein substitution. Full protein-to-genome mapping would require a
separate, versioned exact-allele data source. The pack is derived under
[UniProt's CC BY 4.0 license](https://www.uniprot.org/help/license/).

## PanelApp status

`panelapp_rows` supports offline conversion of authorised PanelApp gene exports.
It preserves only Green (3/4) gene records on public version 1+ panels, including
panel version, evidence, inheritance, pathogenicity exceptions, phenotypes and
publication IDs. It never converts the gene's interval into an allele match.

No PanelApp data pack is published. The UK endpoint returned HTTP 403 during
preparation. More significantly, the official
[PanelApp content terms](https://prod-media-panelapp.genomicsengland.co.uk/media/files/GEL_-_PanelApp_Terms_of_Use_December_2019.pdf)
restrict commercialisation of outputs and include separate third-party data
rights. The application's Apache software license is not a data license. The
Australian API was reachable, but an applicable unrestricted redistribution
license was not established. The normal preparation command therefore excludes
PanelApp; its metadata explicitly says `adapter-only`. Do not present it as a
downloadable reference pack until the applicable data terms permit that use.

## Rebuilding

```sh
python3 tools/reference/curated.py \
  --version YYYY-MM-DD-curated-v1 \
  --output public/references \
  --output-manifest /tmp/curated-manifest.json

python3 -m unittest discover -s tools/reference/tests -p test_curated.py -v
```

The default command fetches fixed public URLs into `.reference-cache/curated` and
creates three new immutable pack directories. Reusing a cache retains its
original fetch receipt; remove a source file and its receipt together to request
a new snapshot. The tool rejects an existing immutable version and refuses to
replace `public/references/manifest.json`. Integrate its separate manifest only
after all files have been verified and uploaded to the configured static host.

The wrapper temporarily extends the existing builder's closed source tuple only
inside its standalone build call, then restores it. Existing adapters and the
main preparation command remain unchanged. Identical records deduplicate;
conflicting records sharing a stable identity fail the build. The same SQLite
schema, shard limits, local routing index and gzip integrity checks are used as
for the existing packs.
