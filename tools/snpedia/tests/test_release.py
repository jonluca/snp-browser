from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest


TOOLS = Path(__file__).parents[1]
sys.path.insert(0, str(TOOLS))
import refresh
import release


OLD_TIME = "2025-11-13 15:00:00"
REVISION_TIME = "2024-01-01T00:00:00Z"


def page(title, revision_id, content, include_content=False):
    revision = {
        "revid": revision_id,
        "timestamp": REVISION_TIME,
        "sha1": refresh.content_sha1(content),
    }
    if include_content:
        revision["slots"] = {"main": {"content": content}}
    return {"pageid": revision_id, "title": title, "revisions": [revision]}


class OfflineApi:
    def __init__(self, responses):
        self.responses = iter(responses)

    def query(self, parameters):
        return {"batchcomplete": True, "query": {"pages": next(self.responses)}}


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.baseline = self.directory / "private-baseline.db"
        self.checkpoint = self.directory / "private-checkpoint.db"
        self.output = self.directory / "published.db"
        with closing(sqlite3.connect(self.baseline)) as connection, connection:
            connection.executescript("""
                CREATE TABLE snps(rsid TEXT PRIMARY KEY, content TEXT, scraped_at TIMESTAMP);
                CREATE TABLE genotypes(id TEXT PRIMARY KEY, content TEXT, scraped_at TIMESTAMP, snp_id TEXT, genotype TEXT);
                CREATE TABLE genosets(id TEXT PRIMARY KEY, content TEXT, scraped_at TIMESTAMP);
                CREATE INDEX idx_genotype_snp ON genotypes(snp_id);
                CREATE INDEX idx_snp_time ON snps(scraped_at);
                CREATE TABLE progress(key TEXT PRIMARY KEY, value TEXT);
            """)
            connection.executemany("INSERT INTO snps VALUES (?, ?, ?)", [
                ("rs1", "unchanged SNP", OLD_TIME),
                ("rs2", "old SNP", OLD_TIME),
                ("rs999", "retained absent SNP", OLD_TIME),
            ])
            connection.execute("INSERT INTO genotypes VALUES (?, ?, ?, ?, ?)",
                               ("rs1(a;g)", "unchanged genotype", OLD_TIME, "rs1", "a;g"))
            connection.execute("INSERT INTO genosets VALUES (?, ?, ?)", ("gs1", "unchanged genoset", OLD_TIME))
            connection.executemany("INSERT INTO progress VALUES (?, ?)", [
                ("snp_count", "3"), ("genotype_count", "1"), ("genoset_count", "1"),
                ("cmcontinue_snp", "old SNP cursor"),
                ("cmcontinue_genotype", "old genotype cursor"),
                ("cmcontinue_genoset", "old genoset cursor"),
                ("public_legacy_note", "preserve this"),
            ])
        self.baseline_hash = refresh.file_sha256(self.baseline)
        self.connection = refresh.initialize(self.baseline, self.checkpoint, resume=False)

    def tearDown(self):
        self.connection.close()
        self.temporary.cleanup()

    def complete(self):
        refresh.run_refresh(self.connection, OfflineApi([
            [page("Rs1", 11, "unchanged SNP"), page("Rs2", 12, "new SNP"), page("Rs3", 13, "old source omission")],
            [page("Rs1(A;G)", 14, "unchanged genotype")],
            [page("Gs1", 15, "unchanged genoset")],
            [page("Rs2", 12, "new SNP", True), page("Rs3", 13, "old source omission", True)],
        ]))

    def test_export_preserves_inputs_rows_indexes_and_unchanged_timestamps(self):
        self.complete()
        checkpoint_hash = refresh.file_sha256(self.checkpoint)
        expected_rows = {
            table: [tuple(row) for row in self.connection.execute(f"SELECT * FROM {table} ORDER BY 1")]
            for table in refresh.TABLES
        }
        expected_indexes = [tuple(row) for row in self.connection.execute(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name"
        )]
        report = release.export_release(self.checkpoint, self.output)
        self.assertEqual(refresh.file_sha256(self.baseline), self.baseline_hash)
        self.assertEqual(refresh.file_sha256(self.checkpoint), checkpoint_hash)
        self.assertEqual(report["database_sha256"], refresh.file_sha256(self.output))
        self.assertEqual(report["database_bytes"], self.output.stat().st_size)
        self.assertEqual(report["database_counts"], {"snps": 4, "genotypes": 1, "genosets": 1})
        self.assertEqual(report["deletions_applied"], 0)
        with closing(sqlite3.connect(self.output)) as connection:
            for table, rows in expected_rows.items():
                self.assertEqual(connection.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall(), rows)
            self.assertEqual(connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name"
            ).fetchall(), expected_indexes)
            self.assertEqual(connection.execute("SELECT scraped_at FROM snps WHERE rsid = 'rs1'").fetchone()[0], OLD_TIME)
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchall(), [("ok",)])

    def test_public_metadata_and_change_report_exclude_private_checkpoint_details(self):
        self.complete()
        report = release.export_release(self.checkpoint, self.output)
        with closing(sqlite3.connect(self.output)) as connection:
            self.assertEqual(connection.execute(
                "SELECT name FROM sqlite_master WHERE name LIKE 'snpedia_refresh_%'"
            ).fetchall(), [])
            metadata = {key: json.loads(value) for key, value in connection.execute("SELECT * FROM snpedia_metadata")}
            self.assertEqual(metadata["baseline_sha256"], self.baseline_hash)
            self.assertEqual(metadata["checked_at"], report["checked_at"])
            self.assertEqual(metadata["source_api"], refresh.API_URL)
            self.assertEqual(metadata["license"], release.LICENSE)
            self.assertNotIn("baseline_path", metadata)
            self.assertNotIn("changes", metadata)
            counters = dict(connection.execute("SELECT * FROM progress"))
            self.assertEqual(counters["snp_count"], "4")
            self.assertEqual(counters["genotype_count"], "1")
            self.assertEqual(counters["genoset_count"], "1")
            self.assertEqual(counters["snpedia_checked_at"], report["checked_at"])
            self.assertEqual(counters["public_legacy_note"], "preserve this")
            self.assertFalse(any(key.startswith("cmcontinue_") for key in counters))
        self.assertEqual({(change["identifier"], change["action"]) for change in report["changes"]}, {
            ("rs2", "update"), ("rs3", "addition"), ("rs999", "removal_candidate"),
        })
        public_bytes = self.output.read_bytes()
        self.assertNotIn(str(self.directory).encode(), public_bytes)
        self.assertNotIn(str(self.directory), json.dumps(report))

    def test_incomplete_inventory_or_pending_content_cannot_be_released(self):
        with self.assertRaises(refresh.RefreshError):
            release.export_release(self.checkpoint, self.output)
        self.assertFalse(self.output.exists())
        self.complete()
        with self.connection:
            self.connection.execute("UPDATE snpedia_refresh_categories SET status = 'scanning' WHERE table_name = 'snps'")
        with self.assertRaises(refresh.RefreshError):
            release.export_release(self.checkpoint, self.output)
        self.assertFalse(self.output.exists())
        with self.connection:
            self.connection.execute("UPDATE snpedia_refresh_categories SET status = 'complete'")
            self.connection.execute("UPDATE snpedia_refresh_inventory SET status = 'pending' WHERE identifier = 'rs3'")
        with self.assertRaises(refresh.RefreshError):
            release.export_release(self.checkpoint, self.output)
        self.assertFalse(self.output.exists())

    def test_release_never_overwrites_an_existing_file_or_source_alias(self):
        self.complete()
        self.output.write_bytes(b"existing artifact")
        with self.assertRaises(refresh.RefreshError):
            release.export_release(self.checkpoint, self.output)
        self.assertEqual(self.output.read_bytes(), b"existing artifact")
        alias = self.directory / "checkpoint-alias.db"
        alias.hardlink_to(self.checkpoint)
        checkpoint_hash = refresh.file_sha256(self.checkpoint)
        with self.assertRaises(refresh.RefreshError):
            release.export_release(self.checkpoint, alias)
        self.assertEqual(refresh.file_sha256(self.checkpoint), checkpoint_hash)

    def test_content_changed_after_refresh_cannot_claim_verified_provenance(self):
        self.complete()
        with self.connection:
            self.connection.execute("UPDATE snps SET content = 'accidental post-refresh edit' WHERE rsid = 'rs1'")
        with self.assertRaises(refresh.RefreshError):
            release.export_release(self.checkpoint, self.output)
        self.assertFalse(self.output.exists())

    def test_missing_inventoried_row_cannot_be_released(self):
        self.complete()
        with self.connection:
            self.connection.execute("DELETE FROM snps WHERE rsid = 'rs3'")
        with self.assertRaises(refresh.RefreshError):
            release.export_release(self.checkpoint, self.output)
        self.assertFalse(self.output.exists())

    def test_change_report_rejects_inconsistent_revision_or_hash_provenance(self):
        self.complete()
        for field, invalid_value in (
            ("revision_id", None),
            ("revision_timestamp", "1999-01-01T00:00:00Z"),
            ("after_sha1", "0" * 40),
        ):
            with self.subTest(field=field):
                original = self.connection.execute(
                    f"SELECT {field} FROM snpedia_refresh_audit WHERE identifier = 'rs2'"
                ).fetchone()[0]
                with self.connection:
                    self.connection.execute(
                        f"UPDATE snpedia_refresh_audit SET {field} = ? WHERE identifier = 'rs2'", (invalid_value,)
                    )
                try:
                    with self.assertRaises(refresh.RefreshError):
                        release.export_release(self.checkpoint, self.output)
                    self.assertFalse(self.output.exists())
                finally:
                    self.output.unlink(missing_ok=True)
                    with self.connection:
                        self.connection.execute(
                            f"UPDATE snpedia_refresh_audit SET {field} = ? WHERE identifier = 'rs2'", (original,)
                        )

    def test_refresh_database_without_legacy_progress_table_is_supported(self):
        self.complete()
        with self.connection:
            self.connection.execute("DROP TABLE progress")
        report = release.export_release(self.checkpoint, self.output)
        with closing(sqlite3.connect(self.output)) as connection:
            self.assertEqual(dict(connection.execute("SELECT * FROM progress"))["snp_count"], "4")
        self.assertEqual(report["database_counts"]["snps"], 4)


if __name__ == "__main__":
    unittest.main()
