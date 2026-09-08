# HPO gene–disease phenotype reference

The Human Phenotype Ontology pack supplies disease-level clinical features for
genes already described in HPO's public gene–disease mappings. Every record has
`scope: gene`. A matching gene does not mean the person has a listed condition or
phenotype. Frequencies describe the source disease annotations, not the user's
probability of having a condition.

## Pinned source and size

The pack uses the official [HPO v2026-09-01 release](https://github.com/obophenotype/human-phenotype-ontology/releases/tag/v2026-09-01).
Its `phenotype.hpoa` header separately declares annotation version `2026-09-02`.
Release assets are downloaded by exact official URL and verified against GitHub's
published SHA-256 digest and byte size. Reused cache entries must retain their
matching download receipts.

The immutable directory `hpo/2026-09-08-hpo-v1-gzip-v1` contains **16,098
gene–disease records in four shards**, totaling **22,644,455 compressed bytes
(21.6 MiB)**. Both compressed and decoded identities are recorded and checked by
the existing reference system. The preparation tool enforces a 25 MiB compressed
budget and never replaces the application's main reference manifest.

## Content and audit counts

| Input or conversion | Count |
| --- | ---: |
| Original `genes_to_disease.txt` rows, all retained | 16,099 |
| Original `genes_to_phenotype.txt` rows, all retained | 333,983 |
| Original `phenotype.hpoa` rows examined | 286,651 |
| HPOA rows with no source gene mapping, not attached | 62,210 |
| Gene–disease records emitted | 16,098 |
| HPOA row copies attached to exact source gene–disease pairs | 334,631 |
| Attached negated (`NOT`) row copies | 826 |
| Gene–disease records without HPOA descriptions | 3,425 |
| Records without a supplied gene symbol | 10 |

The HPOA attachment count can exceed the number of distinct HPOA rows because a
disease can have several source gene mappings. No additional gene–disease
relationship is inferred. Rows without a gene symbol retain the exact NCBI Gene
identifier for browsing, rather than inventing a symbol. Rows and identifiers
from OMIM and Orphanet remain distinct; no MONDO merge is performed.

Each indexed record contains the exact original gene mapping rows, gene phenotype
rows, and relevant disease annotation rows as JSON arrays. Adjacent `columns`
fields document their order, so every retained field can be reconstructed.
Duplicate source rows are preserved. The original disease qualifiers, evidence,
publication references, onset, frequency, sex, modifier, aspect and biocuration
values remain attached. Unknown qualifiers fail the build instead of being
treated as a positive phenotype.

The display projection labels negated observations with `NOT` and identifies
frequency as a disease frequency. Inheritance comes only from HPOA rows whose
source aspect is `I`; it is never derived from a person's genotype. The source
ontology is used only for term labels; ontology relationships are neither
rewritten nor expanded to ancestor terms. Both positive and negative clinical
features remain available in the preserved source rows.

See the official documentation for
[gene mappings](https://obophenotype.github.io/human-phenotype-ontology/annotations/genes_to_disease/),
[gene phenotype summaries](https://obophenotype.github.io/human-phenotype-ontology/annotations/genes_to_phenotype/),
and [disease annotations](https://obophenotype.github.io/human-phenotype-ontology/annotations/introduction/).

## License and acknowledgement

HPO uses its own [license conditions](https://human-phenotype-ontology.github.io/license.html),
not CC BY. The same conditions are present in the
[official current HPO website source](https://github.com/TheJacksonLaboratory/hpo-web/blob/main/src/app/static/resources/license/license.component.html):
acknowledge and cite the Consortium, display the source date/version, and preserve
source content and logical relationships. This pack is an index over preserved
source rows, not a modified ontology. The original source version, URLs, hashes
and conversion counts are retained in `provenance.json`.

The pack attribution includes the required product acknowledgement:

> This service/product uses the Human Phenotype Ontology (v2026-09-01).

The reference library should display that acknowledgement and version together
with the license link. Cite the Human Phenotype Ontology Consortium and
[Köhler et al., 2014](https://doi.org/10.1093/nar/gkt1026). No logo is embedded or
endorsement implied.

## Rebuild and checks

```sh
python3 tools/reference/phenotypes.py \
  --release v2026-09-01 \
  --version YYYY-MM-DD-hpo-v1 \
  --output-manifest /tmp/hpo-manifest.json

python3 -m unittest discover -s tools/reference/tests -p test_phenotypes.py -v
```

Use a separate cache directory for a different release. The command accepts only
a dated release tag in the fixed official repository; it has no personal DNA,
gene-list or phenotype-query input. The result is a separate manifest for reviewed
integration and static hosting. Existing immutable directories cannot be
overwritten. Browser downloads remain fixed public reference assets; personal
matching is local.
