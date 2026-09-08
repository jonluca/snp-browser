# Browser DNA workspace

All personal DNA parsing, reference matching, trait suggestions, browsing, and CSV export run on the user's device. Python tools prepare public reference assets before publication; they never run a personal analysis service. The browser only requests public app files, catalog URLs, and versioned reference shards. It does not put personal variants into upstream requests.

## About you

After importing a DNA file, the default panel presents six curated everyday trait tendencies: lactose digestion, earwax type, eye pigmentation, bitter taste, freckling, and alcohol flushing. Each card includes the observed marker, primary research, population context, allele mapping, and limitations. Suggestions become available after parsing while reference matching continues.

The rules require a known genome build, matching chromosome/position, explicit strand orientation, and compatible alleles. Missing markers, unresolved orientation, no-calls, and conflicting duplicates do not produce a guess. These are single-marker associations, not ancestry estimates, diagnoses, or personal risk scores. Rule versions and evidence travel with the local CSV export.

## Optional public data

The current catalog is `https://static.snpbrowser.com/references/manifest-v2.json`. The original catalog remains available for older clients. Existing shard cache entries are reused and original source preferences are used when no v2 preferences exist.

Alongside SNPedia and the original seven packs (ClinVar, GWAS Catalog, dbSNP, gnomAD, Ensembl, ClinPGx, and CPIC), five additions provide 102,829 annotation records in 36,977,883 compressed bytes:

| Addition     | Records | Download bytes | Interpretation                                                                   |
| ------------ | ------: | -------------: | -------------------------------------------------------------------------------- |
| ClinGen      |   3,670 |        902,355 | Curated gene–disease validity                                                    |
| Orphanet     |   8,503 |      1,926,102 | Rare-disease gene relationships, preserving relationship types                   |
| UniProt      |  70,891 |     10,660,858 | rsID-linked protein variant context, not an inferred protein allele match        |
| Open Targets |   3,667 |        844,113 | Selected FinnGen credible sets for Alzheimer's, Parkinson's, and Crohn's disease |
| HPO          |  16,098 |     22,644,455 | Gene–disease clinical features, including explicitly excluded features           |

Open Targets coverage is a clearly named subset; the credible-set probability is not a person's disease probability. Gene-only evidence is labeled as gene context and never promoted to an allele-specific finding. PanelApp has an import adapter but no distributed pack while access and redistribution remain unresolved.

The library shows coverage, source releases, licenses, and download sizes before download. Search and evidence-type filters, plus a packs-under-25-MiB filter, help control storage. Downloads are optional and can be disabled, removed, or canceled. New source choices can be applied to an open analysis without reopening the file.

See [curated sources](curated-references.md), [Open Targets](open-targets-reference.md), and [HPO](phenotype-reference.md) for provenance and build commands. Source license and attribution files are published alongside the immutable data shards. `tools/reference/publish.py` verifies assets and the preserved baseline before publishing the new catalog last.

## Offline and privacy

Production builds save integrity-verified public app files with a service worker. After the first successful online load, the app and downloaded references can be reopened offline. The development server does not install this worker. A new app version waits until all old tabs close, so an update cannot reload an open DNA analysis.

Personal DNA, reports, suggestions, and match details remain in tab memory. Reloading or closing the tab clears them; reopen the file to analyze again. Browser storage contains public app files, public reference data, and source preferences. The workspace status shows storage usage and allows requesting persistent storage; the browser may decline that request. Offline use requires saving the app and wanted sources first.
