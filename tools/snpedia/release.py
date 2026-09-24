#!/usr/bin/env python3
"""Export a completed SNPedia refresh without local checkpoint bookkeeping."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3

from refresh import API_URL, TABLES, RefreshError, content_sha1, file_sha256, source_hash_matches


SOURCE = "https://bots.snpedia.com/"
LICENSE = "CC BY-NC-SA 3.0 US"
LICENSE_URL = "https://creativecommons.org/licenses/by-nc-sa/3.0/us/"


def export_release(database: Path, output: Path) -> dict:
    database = database.resolve(strict=True)
    output = output.resolve()
    if output.exists():
        raise RefreshError("Release output must be a new file; existing files are never replaced.")
    source = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    target = None
    created = False
    try:
        run = source.execute("SELECT * FROM snpedia_refresh_run WHERE id = 1").fetchone()
        if not run or run["status"] != "complete" or not run["finished_at"]:
            raise RefreshError("Only a completed refresh can be released.")
        categories = source.execute("SELECT * FROM snpedia_refresh_categories").fetchall()
        if {row["table_name"] for row in categories} != set(TABLES) or any(
            row["status"] != "complete" or row["continuation"] for row in categories
        ):
            raise RefreshError("All source categories must reach terminal pagination.")
        if source.execute("SELECT 1 FROM snpedia_refresh_inventory WHERE status NOT IN ('verified', 'refreshed')").fetchone():
            raise RefreshError("Unverified source content remains.")
        if [row[0] for row in source.execute("PRAGMA integrity_check")] != ["ok"]:
            raise RefreshError("Refresh database failed SQLite integrity_check.")
        for table, (identifier, _) in TABLES.items():
            for row in source.execute(
                f"SELECT i.identifier, i.source_sha1, d.content, a.after_sha1 FROM snpedia_refresh_inventory i "
                f"LEFT JOIN {table} d ON d.{identifier} = i.identifier "
                "LEFT JOIN snpedia_refresh_audit a ON a.table_name = i.table_name AND a.identifier = i.identifier "
                "WHERE i.table_name = ?", (table,)
            ):
                if not isinstance(row["content"], str) or not source_hash_matches(row["content"], row["source_sha1"]):
                    raise RefreshError(f"Unverified release content: {table}/{row['identifier']}.")
                if row["after_sha1"] != content_sha1(row["content"]):
                    raise RefreshError(f"Audit content hash does not match: {table}/{row['identifier']}.")
        if source.execute(
            "SELECT 1 FROM snpedia_refresh_inventory i LEFT JOIN snpedia_refresh_audit a "
            "ON a.table_name = i.table_name AND a.identifier = i.identifier "
            "WHERE a.identifier IS NULL OR a.action IS NOT i.action OR a.revision_id IS NOT i.revision_id "
            "OR a.revision_timestamp IS NOT i.revision_timestamp OR a.before_sha1 IS NOT i.baseline_sha1"
        ).fetchone():
            raise RefreshError("Refresh audit does not reconcile with its inventory.")
        counts = {table: source.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in TABLES}
        changes = [dict(row) for row in source.execute(
            "SELECT table_name, identifier, action, before_sha1, after_sha1, revision_id, "
            "revision_timestamp FROM snpedia_refresh_audit WHERE action != 'unchanged' ORDER BY table_name, identifier"
        )]
        report = {
            "source": SOURCE,
            "source_api": API_URL,
            "license": LICENSE,
            "license_url": LICENSE_URL,
            "baseline_sha256": run["baseline_sha256"],
            "started_at": run["started_at"],
            "checked_at": run["finished_at"],
            "scope": "Current main-namespace category pages observed over the recorded interval; revisions pinned by ID and SHA1.",
            "namespace": 0,
            "addition_meaning": "Absent from the previous database; not necessarily newly published by SNPedia.",
            "deletions_applied": 0,
            "database_counts": counts,
            "audit_counts": [dict(row) for row in source.execute(
                "SELECT table_name, action, count(*) AS count FROM snpedia_refresh_audit GROUP BY table_name, action"
            )],
            "changes": changes,
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        os.close(descriptor)
        created = True
        target = sqlite3.connect(output)
        source.backup(target)
        with target:
            for table in ("run", "categories", "inventory", "audit", "cursors"):
                target.execute(f"DROP TABLE snpedia_refresh_{table}")
            target.execute("CREATE TABLE IF NOT EXISTS snpedia_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            target.execute("DELETE FROM snpedia_metadata")
            target.executemany(
                "INSERT INTO snpedia_metadata VALUES (?, ?)",
                [(key, json.dumps(value, sort_keys=True)) for key, value in report.items() if key != "changes"],
            )
            target.execute("CREATE TABLE IF NOT EXISTS progress (key TEXT PRIMARY KEY, value TEXT)")
            target.execute("DELETE FROM progress WHERE key IN ('cmcontinue_snp', 'cmcontinue_genotype', 'cmcontinue_genoset')")
            target.executemany("INSERT OR REPLACE INTO progress VALUES (?, ?)", [
                ("snp_count", str(counts["snps"])),
                ("genotype_count", str(counts["genotypes"])),
                ("genoset_count", str(counts["genosets"])),
                ("snpedia_checked_at", run["finished_at"]),
            ])
        target.execute("VACUUM")
        if target.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise RefreshError("Release database failed SQLite integrity_check.")
        target.close()
        target = None
        report["database_sha256"] = file_sha256(output)
        report["database_bytes"] = output.stat().st_size
        return report
    except BaseException:
        if target is not None:
            target.close()
            target = None
        if created:
            output.unlink(missing_ok=True)
        raise
    finally:
        source.close()
        if target is not None:
            target.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    # The report is adjacent to the new output, never a caller-selected input.
    report_path = Path(str(options.output) + ".json")
    if report_path.exists():
        parser.error("Release report already exists; choose a new output path.")
    try:
        report = export_release(options.database, options.output)
        with report_path.open("x") as file:
            json.dump(report, file, indent=2, sort_keys=True)
            file.write("\n")
    except (RefreshError, OSError, sqlite3.Error) as error:
        parser.exit(1, f"{error}\n")
    print(json.dumps({key: value for key, value in report.items() if key != "changes"}, indent=2))


if __name__ == "__main__":
    main()
