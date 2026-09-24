# SNPedia refresh — September 24, 2026

The current main-namespace SNP, genotype, and genoset category inventories were compared with the database published on November 16, 2025. Every existing content record matched the current source SHA1. The refresh recovered 948 previously omitted chip-ID SNP pages; their source revisions predate the previous scrape (2010–2020), so these are coverage corrections rather than newly published findings.

| Records | Previous database | Refreshed database | Added | Updated | Removed |
| --- | ---: | ---: | ---: | ---: | ---: |
| SNP pages | 110,778 | 111,726 | 948 | 0 | 0 |
| Genotypes | 104,806 | 104,806 | 0 | 0 | 0 |
| Genosets | 283 | 283 | 0 | 0 | 0 |

Inventory and pinned-revision downloads ran from `2026-09-24T08:12:29Z` through `2026-09-24T08:49:43Z`. All three inventories reached terminal pagination; all 216,815 inventoried records were hash-verified. Existing content and retrieval timestamps remain unchanged. New rows carry their actual retrieval time, with source revision timestamps in the change report.

A final source check found no edits, new pages, or logged events during the refresh through `2026-09-24T08:50:33Z`. SNPedia's category summary counters differed from the completed inventories by two SNP pages and 81 genotypes; non-article namespace checks returned no members. The cause of that counter discrepancy is unconfirmed. The release uses the fully enumerated, verified records above.

- [Versioned SQLite database](https://static.snpbrowser.com/snpedia/2026-09-24.db)
- [Release provenance and change report](https://static.snpbrowser.com/snpedia/2026-09-24.db.json)
- Compatibility URL: `https://static.snpbrowser.com/snpedia.db`
- Database size: `162320384` bytes
- Database SHA256: `c6cd2511db71410dfbb5a9b9370bbf358e24e296750f14ed18fec67124366149`
- Previous database SHA256: `7be2a25d101d6d5ea7a31e4a6abe8cb837436170e38b7fe541d66e33e47fa9ae`

The app uses the versioned URL to avoid reusing an older cached database. An already open offline app release activates its update after all tabs for the site are closed and the site is reopened.

The public artifact includes source and license provenance. Local checkpoint tables and filesystem paths are excluded. The [refresh/export procedure](../tools/snpedia/README.md) documents reproduction, checkpoints, validation, and publication.

Source: [SNPedia bulk access](https://bots.snpedia.com/index.php/Bulk), [bot API](https://bots.snpedia.com/api.php). SNPedia content remains [CC BY-NC-SA 3.0 US](https://creativecommons.org/licenses/by-nc-sa/3.0/us/).
