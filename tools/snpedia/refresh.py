#!/usr/bin/env python3
"""Refresh a separate SNPedia SQLite copy using a resumable, audited source sweep."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_URL = "https://bots.snpedia.com/api.php"
TABLES = {
    "snps": ("rsid", "Category:Is_a_snp"),
    "genotypes": ("id", "Category:Is_a_genotype"),
    "genosets": ("id", "Category:Is_a_genoset"),
}
SCHEMA_VERSION = 1


class RefreshError(RuntimeError):
    """A source or checkpoint inconsistency that must not be silently ignored."""


class RequestBudgetReached(RefreshError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def content_sha1(content: str) -> str:
    return hashlib.sha1(content.encode("utf-8")).hexdigest()


def source_hash_matches(content: str, source_sha1: str) -> bool:
    """MediaWiki usually returns a zero-padded base-36 SHA1, not hexadecimal."""
    hexadecimal = content_sha1(content)
    number = int(hexadecimal, 16)
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    encoded = ""
    while number:
        number, remainder = divmod(number, 36)
        encoded = digits[remainder] + encoded
    return source_sha1.lower() in (hexadecimal, encoded.zfill(31))


def canonical_id(title: str) -> str:
    return title.replace(" ", "_").lower()


def same_file(left: Path, right: Path) -> bool:
    return left.resolve() == right.resolve() or (left.exists() and right.exists() and left.samefile(right))


def validate_report_path(report: Path, baseline: Path, output: Path) -> None:
    if same_file(report, baseline) or same_file(report, output):
        raise RefreshError("The summary report must not overwrite the baseline or output database.")


def retry_after_seconds(value: str | None) -> float:
    if not value:
        return 0
    try:
        seconds = float(value)
        return max(0, seconds) if math.isfinite(seconds) else 0
    except ValueError:
        try:
            timestamp = parsedate_to_datetime(value)
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            return max(0, timestamp.timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            return 0


class WikiApi:
    """Serial anonymous POST requests; failures stop rather than skipping pages."""

    def __init__(self, *, delay: float = 3, max_requests: int | None = None,
                 user_agent: str = "SNPBrowserRefresh/1.0 (+https://github.com/jonluca/snp-browser)"):
        if delay < 3:
            raise ValueError("Request spacing must be at least 3 seconds.")
        self.delay = delay
        self.max_requests = max_requests
        self.requests = 0
        self.last_request: float | None = None
        self.user_agent = user_agent

    def query(self, parameters: dict[str, Any]) -> dict[str, Any]:
        parameters = {
            "action": "query", "format": "json", "formatversion": 2,
            "maxlag": 5, **parameters,
        }
        request = Request(
            API_URL, data=urlencode(parameters).encode("utf-8"), method="POST",
            headers={"User-Agent": self.user_agent, "Content-Type": "application/x-www-form-urlencoded"},
        )
        retry_delay = 0.0
        for attempt in range(3):
            if self.max_requests is not None and self.requests >= self.max_requests:
                raise RequestBudgetReached("Request budget reached; run again with --resume to continue.")
            if retry_delay:
                time.sleep(retry_delay)
            if self.last_request is not None:
                time.sleep(max(0, self.delay - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            self.requests += 1
            try:
                with urlopen(request, timeout=90) as response:
                    if response.status != 200:
                        raise HTTPError(API_URL, response.status, "Unexpected status", response.headers, None)
                    body = json.load(response)
                break
            except HTTPError as error:
                retry_after = error.headers.get("Retry-After") if error.headers else None
                error.close()
                if error.code not in (429, 502, 503, 504) or attempt == 2:
                    raise RefreshError(f"SNPedia request failed: {error}") from error
                if self.max_requests is not None and self.requests >= self.max_requests:
                    raise RequestBudgetReached("Request budget reached; run again with --resume to continue.") from error
                retry_delay = max((10, 30)[attempt], retry_after_seconds(retry_after))
                print(f"SNPedia HTTP {error.code}; retrying the same query in {retry_delay:g}s "
                      f"(attempt {attempt + 2}/3).", file=sys.stderr, flush=True)
            except (OSError, ValueError) as error:
                raise RefreshError(f"SNPedia request failed: {error}") from error
        if not isinstance(body, dict):
            raise RefreshError("SNPedia returned a non-object JSON response.")
        if body.get("error") or body.get("errors") or body.get("warnings"):
            raise RefreshError(f"SNPedia API rejected or warned about the request: {json.dumps(body, sort_keys=True)}")
        return body


def initialize(baseline: Path, output: Path, *, resume: bool) -> sqlite3.Connection:
    baseline = baseline.resolve(strict=True)
    output = output.resolve()
    if same_file(baseline, output):
        raise RefreshError("The output must be a separate file from the read-only baseline.")
    if Path(str(baseline) + "-wal").exists() and Path(str(baseline) + "-wal").stat().st_size:
        raise RefreshError("Baseline has an active WAL. Use a checkpointed, immutable baseline copy.")
    baseline_hash = file_sha256(baseline)
    if resume:
        if not output.is_file():
            raise RefreshError("Resume output does not exist.")
        connection = sqlite3.connect(output)
        connection.row_factory = sqlite3.Row
        try:
            run = connection.execute("SELECT * FROM snpedia_refresh_run WHERE id = 1").fetchone()
            if not run or run["schema_version"] != SCHEMA_VERSION or run["baseline_sha256"] != baseline_hash:
                raise RefreshError("Resume checkpoint does not match this baseline or refresh schema.")
            if run["api_url"] != API_URL:
                raise RefreshError("Resume checkpoint has an unexpected source API.")
        except (sqlite3.Error, RefreshError):
            connection.close()
            raise
        return connection

    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
    except FileExistsError as error:
        raise RefreshError("Output already exists. Use --resume or choose a new output path.") from error
    source = sqlite3.connect(baseline.as_uri() + "?mode=ro", uri=True)
    connection = sqlite3.connect(output)
    connection.row_factory = sqlite3.Row
    try:
        for table, (identifier, _) in TABLES.items():
            columns = {row[1] for row in source.execute(f"PRAGMA table_info({table})")}
            required = {identifier, "content", "scraped_at"}
            if table == "genotypes":
                required |= {"snp_id", "genotype"}
            if not required <= columns:
                raise RefreshError(f"Baseline {table} table is missing required columns.")
        source.backup(connection)
        if file_sha256(baseline) != baseline_hash:
            raise RefreshError("Baseline changed during backup; use an immutable baseline copy.")
        # A refreshed DB can itself be the next run's baseline. Only the separate
        # output copy's prior refresh bookkeeping is replaced.
        connection.executescript("""
            DROP TABLE IF EXISTS snpedia_refresh_run;
            DROP TABLE IF EXISTS snpedia_refresh_categories;
            DROP TABLE IF EXISTS snpedia_refresh_inventory;
            DROP TABLE IF EXISTS snpedia_refresh_audit;
            DROP TABLE IF EXISTS snpedia_refresh_cursors;
            CREATE TABLE snpedia_refresh_run (
                id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL,
                baseline_path TEXT NOT NULL, baseline_sha256 TEXT NOT NULL, api_url TEXT NOT NULL,
                started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, error TEXT
            );
            CREATE TABLE snpedia_refresh_categories (
                table_name TEXT PRIMARY KEY, category TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', continuation TEXT,
                started_at TEXT, finished_at TEXT, requests INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE snpedia_refresh_cursors (
                table_name TEXT NOT NULL, continuation TEXT NOT NULL,
                PRIMARY KEY (table_name, continuation)
            );
            CREATE TABLE snpedia_refresh_inventory (
                table_name TEXT NOT NULL, identifier TEXT NOT NULL, title TEXT NOT NULL,
                page_id INTEGER NOT NULL, revision_id INTEGER NOT NULL,
                revision_timestamp TEXT NOT NULL, source_sha1 TEXT NOT NULL,
                baseline_sha1 TEXT, action TEXT NOT NULL, status TEXT NOT NULL,
                observed_at TEXT NOT NULL, fetched_at TEXT,
                PRIMARY KEY (table_name, identifier)
            );
            CREATE INDEX snpedia_refresh_pending ON snpedia_refresh_inventory(status);
            CREATE TABLE snpedia_refresh_audit (
                table_name TEXT NOT NULL, identifier TEXT NOT NULL, action TEXT NOT NULL,
                before_sha1 TEXT, after_sha1 TEXT, revision_id INTEGER,
                revision_timestamp TEXT, observed_at TEXT NOT NULL,
                PRIMARY KEY (table_name, identifier)
            );
        """)
        with connection:
            connection.execute(
                "INSERT INTO snpedia_refresh_run VALUES (1, ?, ?, ?, ?, ?, NULL, 'ready', NULL)",
                (SCHEMA_VERSION, str(baseline), baseline_hash, API_URL, utc_now()),
            )
            connection.executemany(
                "INSERT INTO snpedia_refresh_categories(table_name, category) VALUES (?, ?)",
                [(table, category) for table, (_, category) in TABLES.items()],
            )
        return connection
    except BaseException:
        connection.close()
        output.unlink(missing_ok=True)
        raise
    finally:
        source.close()


def response_pages(body: dict[str, Any]) -> list[dict[str, Any]]:
    if body.get("error") or body.get("errors") or body.get("warnings"):
        raise RefreshError("API response contains errors or warnings.")
    query = body.get("query")
    if query is None:
        if "batchcomplete" in body and "continue" not in body:
            return []
        raise RefreshError("API response is missing its query result.")
    if not isinstance(query, dict) or query.get("badrevids"):
        raise RefreshError("API returned an invalid query or inaccessible revision IDs.")
    pages = query.get("pages")
    if isinstance(pages, dict):
        pages = list(pages.values())
    if not isinstance(pages, list) or any(not isinstance(page, dict) for page in pages):
        raise RefreshError("API query is missing its pages result.")
    return pages


def revision_metadata(revision: dict[str, Any]) -> tuple[int, str, str]:
    revision_id, timestamp, sha1 = (revision.get(field) for field in ("revid", "timestamp", "sha1"))
    if not isinstance(revision_id, int) or revision_id <= 0 or not isinstance(timestamp, str) or not isinstance(sha1, str):
        raise RefreshError("A revision is missing its public ID, timestamp, or SHA1.")
    if len(sha1) not in (31, 40) or any(char not in "0123456789abcdefghijklmnopqrstuvwxyz" for char in sha1.lower()):
        raise RefreshError("A revision has an invalid SHA1.")
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise RefreshError("A revision has an invalid timestamp.") from error
    return revision_id, timestamp, sha1


def inventory_category(connection: sqlite3.Connection, api: WikiApi, table: str, batch_size: int) -> None:
    identifier, category = TABLES[table]
    while True:
        checkpoint = connection.execute(
            "SELECT * FROM snpedia_refresh_categories WHERE table_name = ?", (table,),
        ).fetchone()
        if checkpoint["status"] == "complete":
            return
        continuation = json.loads(checkpoint["continuation"]) if checkpoint["continuation"] else {}
        parameters = {
            "generator": "categorymembers", "gcmtitle": category,
            "gcmtype": "page", "gcmnamespace": 0, "gcmlimit": batch_size,
            "prop": "revisions", "rvprop": "ids|timestamp|sha1", **continuation,
        }
        body = api.query(parameters)
        pages = response_pages(body)
        next_cursor = body.get("continue")
        if next_cursor is not None and (not isinstance(next_cursor, dict) or not next_cursor):
            raise RefreshError("Invalid MediaWiki continuation token.")
        if "query-continue" in body:
            raise RefreshError("Legacy continuation protocol returned; refusing to truncate the inventory.")
        encoded_cursor = json.dumps(next_cursor, sort_keys=True) if next_cursor else None
        if encoded_cursor and connection.execute(
            "SELECT 1 FROM snpedia_refresh_cursors WHERE table_name = ? AND continuation = ?", (table, encoded_cursor),
        ).fetchone():
            raise RefreshError(f"SNPedia repeated a continuation token for {table}.")
        observed_at = utc_now()
        with connection:
            for page in pages:
                title, page_id = page.get("title"), page.get("pageid")
                revisions = page.get("revisions")
                if not isinstance(title, str) or not isinstance(page_id, int) or page_id <= 0:
                    raise RefreshError("An inventory page is missing its public title or ID.")
                if not isinstance(revisions, list) or len(revisions) != 1:
                    raise RefreshError(f"Inventory page {title!r} has no unambiguous current revision.")
                revision_id, timestamp, sha1 = revision_metadata(revisions[0])
                item_id = canonical_id(title)
                previous = connection.execute(
                    "SELECT page_id FROM snpedia_refresh_inventory WHERE table_name = ? AND identifier = ?",
                    (table, item_id),
                ).fetchone()
                if previous and previous["page_id"] != page_id:
                    raise RefreshError(f"Different source pages map to the same database ID: {title!r}.")
                existing = connection.execute(f"SELECT content FROM {table} WHERE {identifier} = ?", (item_id,)).fetchone()
                old_content = existing["content"] if existing else None
                old_sha1 = content_sha1(old_content) if isinstance(old_content, str) else None
                unchanged = isinstance(old_content, str) and source_hash_matches(old_content, sha1)
                action = "unchanged" if unchanged else ("update" if existing else "addition")
                connection.execute(
                    "INSERT OR REPLACE INTO snpedia_refresh_inventory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
                    (table, item_id, title, page_id, revision_id, timestamp, sha1, old_sha1,
                     action, "verified" if unchanged else "pending", observed_at),
                )
                if unchanged:
                    connection.execute(
                        "INSERT OR REPLACE INTO snpedia_refresh_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (table, item_id, action, old_sha1, old_sha1, revision_id, timestamp, observed_at),
                    )
                else:
                    connection.execute(
                        "DELETE FROM snpedia_refresh_audit WHERE table_name = ? AND identifier = ?", (table, item_id),
                    )
            if not next_cursor:
                count = connection.execute(
                    "SELECT count(*) FROM snpedia_refresh_inventory WHERE table_name = ?", (table,),
                ).fetchone()[0]
                if not count and connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]:
                    raise RefreshError(f"Empty {table} inventory conflicts with the populated baseline.")
            if encoded_cursor:
                connection.execute("INSERT INTO snpedia_refresh_cursors VALUES (?, ?)", (table, encoded_cursor))
            connection.execute(
                "UPDATE snpedia_refresh_categories SET status = ?, continuation = ?, "
                "started_at = coalesce(started_at, ?), finished_at = ?, requests = requests + 1 WHERE table_name = ?",
                ("scanning" if next_cursor else "complete", encoded_cursor, observed_at,
                 None if next_cursor else observed_at, table),
            )
        if not next_cursor:
            return


def revision_content(revision: dict[str, Any]) -> str:
    slot = revision.get("slots", {}).get("main", revision)
    if not isinstance(slot, dict):
        raise RefreshError("Source revision has no readable main slot.")
    content = slot.get("content", slot.get("*"))
    if not isinstance(content, str):
        raise RefreshError("Source revision content is missing or suppressed.")
    return content


def refresh_content(connection: sqlite3.Connection, api: WikiApi, batch_size: int) -> None:
    while True:
        pending = connection.execute(
            "SELECT * FROM snpedia_refresh_inventory WHERE status = 'pending' ORDER BY table_name, identifier LIMIT ?",
            (batch_size,),
        ).fetchall()
        if not pending:
            return
        requested = {row["revision_id"] for row in pending}
        body = api.query({
            "prop": "revisions", "revids": "|".join(map(str, sorted(requested))),
            "rvprop": "ids|timestamp|sha1|content", "rvslots": "main",
        })
        if "continue" in body or "query-continue" in body:
            raise RefreshError("Unexpected pagination while fetching explicit revision IDs.")
        fetched: dict[int, tuple[str, str, str]] = {}
        for page in response_pages(body):
            revisions = page.get("revisions")
            if not isinstance(revisions, list):
                raise RefreshError("Requested source revision was deleted or is inaccessible.")
            for revision in revisions:
                revision_id, timestamp, sha1 = revision_metadata(revision)
                if revision_id not in requested or revision_id in fetched:
                    raise RefreshError("API returned an unexpected or repeated revision ID.")
                content = revision_content(revision)
                if not source_hash_matches(content, sha1):
                    raise RefreshError(f"Downloaded content does not match source SHA1 for revision {revision_id}.")
                fetched[revision_id] = (content, timestamp, sha1)
        if set(fetched) != requested:
            raise RefreshError("API did not return every requested revision; no part of this batch was committed.")
        fetched_at = utc_now()
        with connection:
            for row in pending:
                content, timestamp, sha1 = fetched[row["revision_id"]]
                if timestamp != row["revision_timestamp"] or sha1 != row["source_sha1"]:
                    raise RefreshError("Source revision metadata changed between inventory and content fetch.")
                table, item_id = row["table_name"], row["identifier"]
                identifier = TABLES[table][0]
                if table == "genotypes":
                    snp_id, separator, genotype = item_id.partition("(")
                    genotype = genotype.rstrip(")") if separator else ""
                    connection.execute(
                        "INSERT INTO genotypes(id, snp_id, genotype, content, scraped_at) VALUES (?, ?, ?, ?, ?) "
                        "ON CONFLICT(id) DO UPDATE SET snp_id = excluded.snp_id, genotype = excluded.genotype, "
                        "content = excluded.content, scraped_at = excluded.scraped_at",
                        (item_id, snp_id, genotype, content, fetched_at),
                    )
                else:
                    connection.execute(
                        f"INSERT INTO {table}({identifier}, content, scraped_at) VALUES (?, ?, ?) "
                        f"ON CONFLICT({identifier}) DO UPDATE SET content = excluded.content, scraped_at = excluded.scraped_at",
                        (item_id, content, fetched_at),
                    )
                connection.execute(
                    "UPDATE snpedia_refresh_inventory SET status = 'refreshed', fetched_at = ? "
                    "WHERE table_name = ? AND identifier = ?", (fetched_at, table, item_id),
                )
                connection.execute(
                    "INSERT INTO snpedia_refresh_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (table, item_id, row["action"], row["baseline_sha1"], content_sha1(content),
                     row["revision_id"], timestamp, fetched_at),
                )


def finish(connection: sqlite3.Connection) -> None:
    if connection.execute("SELECT 1 FROM snpedia_refresh_categories WHERE status != 'complete'").fetchone():
        raise RefreshError("Cannot finish before every category reaches terminal pagination.")
    if connection.execute("SELECT 1 FROM snpedia_refresh_inventory WHERE status = 'pending'").fetchone():
        raise RefreshError("Cannot finish while source content is pending.")
    observed_at = utc_now()
    with connection:
        for table, (identifier, _) in TABLES.items():
            # Category absence is not proof of deletion: keep the baseline row
            # and record it for separate authoritative reconciliation.
            for row in connection.execute(
                f"SELECT {identifier}, content FROM {table} WHERE NOT EXISTS "
                f"(SELECT 1 FROM snpedia_refresh_inventory i WHERE i.table_name = ? AND i.identifier = {table}.{identifier})",
                (table,),
            ):
                content = row["content"]
                sha1 = content_sha1(content) if isinstance(content, str) else None
                connection.execute(
                    "INSERT OR REPLACE INTO snpedia_refresh_audit VALUES (?, ?, 'removal_candidate', ?, ?, NULL, NULL, ?)",
                    (table, row[identifier], sha1, sha1, observed_at),
                )
        connection.execute(
            "UPDATE snpedia_refresh_run SET status = 'complete', finished_at = ?, error = NULL WHERE id = 1",
            (observed_at,),
        )
    if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise RefreshError("Refreshed database failed SQLite quick_check.")


def summary(connection: sqlite3.Connection) -> dict[str, Any]:
    run = dict(connection.execute("SELECT * FROM snpedia_refresh_run WHERE id = 1").fetchone())
    run["categories"] = [dict(row) for row in connection.execute("SELECT * FROM snpedia_refresh_categories")]
    run["audit_counts"] = [dict(row) for row in connection.execute(
        "SELECT table_name, action, count(*) AS count FROM snpedia_refresh_audit GROUP BY table_name, action",
    )]
    run["pending_content"] = connection.execute(
        "SELECT count(*) FROM snpedia_refresh_inventory WHERE status = 'pending'",
    ).fetchone()[0]
    run["database_counts"] = {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in TABLES}
    run["scope"] = "Current main-namespace category pages observed over the recorded interval; revisions pinned by ID and SHA1."
    run["deletions_applied"] = 0
    return run


def run_refresh(connection: sqlite3.Connection, api: WikiApi, *, inventory_batch_size: int = 500,
                content_batch_size: int = 50) -> None:
    if not 1 <= inventory_batch_size <= 500 or not 1 <= content_batch_size <= 50:
        raise ValueError("Inventory batch size must be 1..500 and content batch size must be 1..50.")
    if connection.execute("SELECT status FROM snpedia_refresh_run WHERE id = 1").fetchone()[0] == "complete":
        return
    with connection:
        connection.execute("UPDATE snpedia_refresh_run SET status = 'running', error = NULL WHERE id = 1")
    try:
        for table in TABLES:
            inventory_category(connection, api, table, inventory_batch_size)
        refresh_content(connection, api, content_batch_size)
        finish(connection)
    except BaseException as error:
        with connection:
            connection.execute(
                "UPDATE snpedia_refresh_run SET status = ?, error = ? WHERE id = 1",
                ("paused" if isinstance(error, (RequestBudgetReached, KeyboardInterrupt)) else "failed", str(error)),
            )
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--status", action="store_true", help="Read an existing checkpoint without network requests.")
    parser.add_argument("--report", type=Path, help="Summary JSON path; default: OUTPUT.report.json")
    parser.add_argument("--inventory-batch-size", type=int, default=500)
    parser.add_argument("--content-batch-size", type=int, default=50)
    parser.add_argument("--max-requests", type=int)
    parser.add_argument("--request-delay", type=float, default=3)
    options = parser.parse_args()
    connection = None
    exit_code = 0
    report = options.report or Path(str(options.output) + ".report.json")
    try:
        validate_report_path(report, options.baseline, options.output)
        if options.max_requests is not None and options.max_requests < 1:
            raise ValueError("--max-requests must be positive.")
        api = WikiApi(delay=options.request_delay, max_requests=options.max_requests)
        connection = initialize(options.baseline, options.output, resume=options.resume or options.status)
        if not options.status:
            run_refresh(connection, api, inventory_batch_size=options.inventory_batch_size,
                        content_batch_size=options.content_batch_size)
    except RequestBudgetReached as error:
        print(str(error), file=sys.stderr)
        exit_code = 2
    except KeyboardInterrupt:
        print("Interrupted; committed checkpoints can be resumed.", file=sys.stderr)
        exit_code = 130
    except (RefreshError, OSError, sqlite3.Error, ValueError) as error:
        print(str(error), file=sys.stderr)
        exit_code = 1
    finally:
        if connection is not None:
            result = summary(connection)
            encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
            report.write_text(encoded)
            print(encoded, end="")
            connection.close()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
