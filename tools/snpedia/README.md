# SNPedia refresh

`refresh.py` copies a checkpointed baseline SQLite database into a separate output and refreshes SNP, genotype, and genoset pages from SNPedia's official anonymous MediaWiki API. It uses Python's standard library and does not require credentials.

```sh
python3 tools/snpedia/refresh.py \
  --baseline /absolute/path/to/baseline.db \
  --output .reference-cache/snpedia/refreshed.db
```

Use `--resume` with the same paths after a failed or interrupted request. Use `--status` to read the saved checkpoint without making source requests. `--max-requests N` pauses after at most N source requests in that invocation, including retries; it exits with status 2 and is resumable. Requests use form POST with at least three seconds between request starts. HTTP 429, 502, 503, and 504 retry the identical query at most twice, waiting at least 10 then 30 seconds and respecting any longer `Retry-After`. Other HTTP failures, invalid JSON or challenges, API warnings, inaccessible revisions, inconsistent hashes, and malformed or repeated pagination stop the run; they never silently skip records.

The baseline is opened read-only and is never modified. Existing output files require `--resume`. Baselines with an active SQLite WAL are rejected: first obtain a stable, checkpointed copy. The baseline SHA256 is checked when initializing and resuming.

Each category inventory uses `generator=categorymembers` plus the latest revision ID, timestamp, and SHA1, up to 500 pages per request. It includes main-namespace pages (`gcmnamespace=0`), excluding templates, user pages, and other non-article namespaces. The complete continuation object is saved atomically with every batch. A `batchcomplete` field does **not** end enumeration while `continue` is present. All three inventories must end before content is updated. Category summary counts may differ from completed inventories and are not substituted for the actual enumerated records.

The old database has no revision IDs and its `scraped_at` timestamps may lack a timezone. Comparing the source SHA1 with the existing text identifies unchanged content without assuming those timestamps are reliable. Only differing or missing content is downloaded, in batches of at most 50 pinned revision IDs, and every response is checked against its SHA1 and inventoried revision metadata. Unchanged rows retain their previous `scraped_at`; refreshed rows receive their actual content fetch time. The source revision timestamps remain available separately.

The output contains these audit tables:

- `snpedia_refresh_run`: baseline hash, source URL, run interval, terminal status, and last error.
- `snpedia_refresh_categories`: complete pagination checkpoints and per-category inventory interval.
- `snpedia_refresh_inventory`: source page/revision IDs, hashes, timestamps, and content refresh state.
- `snpedia_refresh_audit`: additions, updates, unchanged records, and removal candidates.

An **addition** means a source category page was absent from this baseline. It does not mean the source page was recently created; old omissions are additions too. A **removal candidate** is a baseline record absent from the completed current category inventory. Such records remain in the output because category absence alone does not prove deletion. No automatic deletions are performed.

`OUTPUT.report.json` summarizes the saved state and counts, including incomplete runs. A complete run verifies the current category pages observed during the recorded inventory intervals. MediaWiki can change during enumeration, so this is a source sweep with exact revision provenance, not a globally atomic snapshot or a guarantee that no page changed after its inventory request. Publishing and cache invalidation are separate steps.

```sh
python3 -m unittest discover -s tools/snpedia/tests -v
```

Tests use synthetic local databases and mocked responses; they make no network requests.

## Preparing a public release

After the refresh reports `complete`, export a separate release artifact:

```sh
python3 tools/snpedia/release.py \
  --database .reference-cache/snpedia/refreshed.db \
  --output .reference-cache/snpedia/release.db
```

The exporter rechecks every inventoried content hash, verifies the audit and SQLite integrity, removes local checkpoint tables, and adds public source/license provenance. It preserves all content rows, their retrieval timestamps, and query indexes. Scraper counters are corrected and obsolete category cursors are removed. The adjacent `release.db.json` records the artifact's SHA256, byte size, counts, and changes. Existing output files are never overwritten.

Publish the verified database under a new immutable R2 key. Download it from the public URL and verify its full hash and production CORS response before switching the app's database URL. The browser caches SNPedia by URL, so updating only the old `snpedia.db` object would leave existing clients with stale data. Keep a copy of the previous artifact and separately refresh the legacy URL after validating the release.

Source: [SNPedia bulk access](https://bots.snpedia.com/index.php/Bulk), via its anonymous bot API. SNPedia content is [CC BY-NC-SA 3.0 US](https://creativecommons.org/licenses/by-nc-sa/3.0/us/); the source attribution and data license travel with the released artifact.
