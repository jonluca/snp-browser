import hashlib
import importlib.util
import io
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs


SPEC = importlib.util.spec_from_file_location("snpedia_refresh", Path(__file__).parents[1] / "refresh.py")
refresh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(refresh)

OLD_TIME = "2025-11-13 15:00:00"
SOURCE_TIME = "2024-01-01T00:00:00Z"


def page(title, revision_id, content, *, with_content=False, version=2):
    revision = {"revid": revision_id, "timestamp": SOURCE_TIME, "sha1": refresh.content_sha1(content)}
    if with_content:
        revision["slots"] = {"main": {"content" if version == 2 else "*": content}}
    return {"pageid": revision_id, "title": title, "ns": 0, "revisions": [revision]}


def response(pages, *, continuation=None, version=2):
    result = {"batchcomplete": "", "query": {"pages": pages if version == 2 else {str(p["pageid"]): p for p in pages}}}
    if continuation:
        result["continue"] = continuation
    return result


class FakeApi:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def query(self, params):
        self.calls.append(params)
        if not self.responses:
            raise AssertionError("Unexpected API call")
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.baseline = Path(self.temporary.name) / "baseline.db"
        self.output = Path(self.temporary.name) / "output.db"
        with closing(sqlite3.connect(self.baseline)) as conn, conn:
            conn.executescript("""
                CREATE TABLE snps(rsid TEXT PRIMARY KEY, content TEXT, scraped_at TIMESTAMP);
                CREATE TABLE genotypes(id TEXT PRIMARY KEY, snp_id TEXT, genotype TEXT, content TEXT, scraped_at TIMESTAMP);
                CREATE TABLE genosets(id TEXT PRIMARY KEY, content TEXT, scraped_at TIMESTAMP);
            """)
            conn.executemany("INSERT INTO snps VALUES (?, ?, ?)", [
                ("rs1", "old SNP", OLD_TIME), ("rs2", "stable SNP", OLD_TIME), ("rs999", "retain absent", OLD_TIME),
            ])
            conn.execute("INSERT INTO genotypes VALUES (?, ?, ?, ?, ?)", ("rs1(a;a)", "rs1", "a;a", "old genotype", OLD_TIME))
            conn.execute("INSERT INTO genosets VALUES (?, ?, ?)", ("gs1", "stable genoset", OLD_TIME))
        self.baseline_hash = refresh.file_sha256(self.baseline)
        self.connection = refresh.initialize(self.baseline, self.output, resume=False)

    def tearDown(self):
        self.connection.close()
        self.temporary.cleanup()

    def inventory_responses(self):
        return [
            response([page("Rs1", 11, "new SNP"), page("Rs2", 12, "stable SNP")],
                     continuation={"gcmcontinue": "next SNP page", "continue": "gcmcontinue||"}, version=1),
            response([page("I1000004", 13, "old source omission")]),
            response([page("Rs1(A;A)", 14, "new genotype")]),
            response([page("Gs1", 15, "stable genoset")]),
        ]

    def content_response(self):
        return response([
            page("Rs1", 11, "new SNP", with_content=True, version=1),
            page("I1000004", 13, "old source omission", with_content=True),
            page("Rs1(A;A)", 14, "new genotype", with_content=True),
        ], version=1)

    def test_refresh_preserves_baseline_and_unchanged_timestamps_and_audits_every_action(self):
        api = FakeApi(self.inventory_responses() + [self.content_response()])
        refresh.run_refresh(self.connection, api)
        self.assertEqual(refresh.file_sha256(self.baseline), self.baseline_hash)
        self.assertEqual(api.calls[1]["gcmcontinue"], "next SNP page")
        self.assertEqual(api.calls[1]["continue"], "gcmcontinue||")
        self.assertEqual(api.calls[-1]["revids"], "11|13|14")
        stable = self.connection.execute("SELECT * FROM snps WHERE rsid = 'rs2'").fetchone()
        self.assertEqual(stable["scraped_at"], OLD_TIME)
        changed = self.connection.execute("SELECT * FROM snps WHERE rsid = 'rs1'").fetchone()
        self.assertEqual(changed["content"], "new SNP")
        self.assertNotEqual(changed["scraped_at"], OLD_TIME)
        genotype = self.connection.execute("SELECT * FROM genotypes WHERE id = 'rs1(a;a)'").fetchone()
        self.assertEqual((genotype["snp_id"], genotype["genotype"], genotype["content"]), ("rs1", "a;a", "new genotype"))
        audit = {(row["table_name"], row["identifier"]): row["action"] for row in self.connection.execute("SELECT * FROM snpedia_refresh_audit")}
        self.assertEqual(audit[("snps", "rs999")], "removal_candidate")
        self.assertEqual(audit[("snps", "i1000004")], "addition")
        self.assertEqual(audit[("snps", "rs2")], "unchanged")
        self.assertEqual(audit[("snps", "rs1")], "update")
        self.assertEqual(self.connection.execute("SELECT content FROM snps WHERE rsid = 'rs999'").fetchone()[0], "retain absent")
        result = refresh.summary(self.connection)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["pending_content"], 0)
        self.assertEqual(result["deletions_applied"], 0)
        refresh.run_refresh(self.connection, FakeApi([]))  # A completed resume has no source requests.

    def test_pause_resumes_from_full_committed_continuation(self):
        responses = self.inventory_responses()
        api = FakeApi([responses[0], refresh.RequestBudgetReached("budget")])
        with self.assertRaises(refresh.RequestBudgetReached):
            refresh.run_refresh(self.connection, api)
        self.assertEqual(refresh.summary(self.connection)["status"], "paused")
        self.connection.close()
        self.connection = refresh.initialize(self.baseline, self.output, resume=True)
        resumed = FakeApi(responses[1:] + [self.content_response()])
        refresh.run_refresh(self.connection, resumed)
        self.assertEqual(resumed.calls[0]["gcmcontinue"], "next SNP page")
        self.assertEqual(resumed.calls[0]["continue"], "gcmcontinue||")
        self.assertEqual(refresh.summary(self.connection)["status"], "complete")

    def test_missing_content_rejects_entire_batch_and_resume_fetches_pending_only(self):
        partial = response([page("Rs1", 11, "new SNP", with_content=True)])
        with self.assertRaisesRegex(refresh.RefreshError, "every requested revision"):
            refresh.run_refresh(self.connection, FakeApi(self.inventory_responses() + [partial]))
        self.assertEqual(self.connection.execute("SELECT content FROM snps WHERE rsid = 'rs1'").fetchone()[0], "old SNP")
        self.assertEqual(refresh.summary(self.connection)["pending_content"], 3)
        resumed = FakeApi([self.content_response()])
        refresh.run_refresh(self.connection, resumed)
        self.assertEqual(len(resumed.calls), 1)
        self.assertEqual(refresh.summary(self.connection)["status"], "complete")

    def test_hash_mismatch_never_updates_content(self):
        corrupted = self.content_response()
        corrupted["query"]["pages"]["11"]["revisions"][0]["slots"]["main"]["*"] = "corrupted"
        with self.assertRaisesRegex(refresh.RefreshError, "does not match source SHA1"):
            refresh.run_refresh(self.connection, FakeApi(self.inventory_responses() + [corrupted]))
        self.assertEqual(self.connection.execute("SELECT content FROM snps WHERE rsid = 'rs1'").fetchone()[0], "old SNP")

    def test_repeated_cursor_or_inaccessible_inventory_revision_cannot_finish(self):
        first = self.inventory_responses()[0]
        with self.assertRaisesRegex(refresh.RefreshError, "repeated a continuation"):
            refresh.run_refresh(self.connection, FakeApi([first, first]))
        self.assertEqual(self.connection.execute("SELECT count(*) FROM snpedia_refresh_inventory").fetchone()[0], 2)
        self.assertEqual(refresh.summary(self.connection)["status"], "failed")
        invalid = response([{"pageid": 13, "title": "I1000004", "missing": True}])
        with self.assertRaisesRegex(refresh.RefreshError, "no unambiguous current revision"):
            refresh.run_refresh(self.connection, FakeApi([invalid]))
        self.assertEqual(refresh.summary(self.connection)["status"], "failed")

    def test_empty_inventory_cannot_replace_a_populated_source(self):
        with self.assertRaisesRegex(refresh.RefreshError, "Empty snps inventory"):
            refresh.run_refresh(self.connection, FakeApi([{"batchcomplete": ""}]))
        self.assertEqual(refresh.summary(self.connection)["categories"][0]["status"], "pending")

    def test_baseline_changes_and_output_overwrite_are_rejected(self):
        with self.assertRaisesRegex(refresh.RefreshError, "already exists"):
            refresh.initialize(self.baseline, self.output, resume=False)
        with self.assertRaisesRegex(refresh.RefreshError, "separate file"):
            refresh.initialize(self.baseline, self.baseline, resume=False)
        with closing(sqlite3.connect(self.baseline)) as baseline, baseline:
            baseline.execute("UPDATE snps SET content = 'concurrent edit' WHERE rsid = 'rs1'")
        with self.assertRaisesRegex(refresh.RefreshError, "does not match"):
            refresh.initialize(self.baseline, self.output, resume=True)

    def test_database_aliases_are_never_used_for_output_or_reports(self):
        alias = Path(self.temporary.name) / "baseline-alias.db"
        alias.hardlink_to(self.baseline)
        with self.assertRaisesRegex(refresh.RefreshError, "separate file"):
            refresh.initialize(self.baseline, alias, resume=True)
        for report in (self.baseline, self.output, alias):
            with self.assertRaisesRegex(refresh.RefreshError, "must not overwrite"):
                refresh.validate_report_path(report, self.baseline, self.output)
        self.assertEqual(refresh.file_sha256(self.baseline), self.baseline_hash)


class ApiTests(unittest.TestCase):
    def mocked_transport(self, outcomes, *, max_requests=None):
        clock = [0.0]
        starts, sleeps, bodies = [], [], []
        outcomes = iter(outcomes)

        def sleep(seconds):
            sleeps.append(seconds)
            clock[0] += seconds

        def transport(request, timeout):
            starts.append(clock[0])
            bodies.append(request.data)
            outcome = next(outcomes)
            if isinstance(outcome, Exception):
                raise outcome
            result = io.BytesIO(outcome)
            result.status = 200
            return result

        api = refresh.WikiApi(max_requests=max_requests)
        with patch.object(refresh, "urlopen", side_effect=transport), \
                patch.object(refresh.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(refresh.time, "sleep", side_effect=sleep):
            try:
                result = api.query({"generator": "categorymembers", "gcmcontinue": "retained|cursor"})
            except refresh.RefreshError as error:
                result = error
        return api, result, starts, sleeps, bodies

    def test_transient_retries_preserve_query_and_backoff_and_retry_after(self):
        api, result, starts, sleeps, bodies = self.mocked_transport([
            HTTPError(refresh.API_URL, 502, "Bad Gateway", {}, None),
            HTTPError(refresh.API_URL, 503, "Unavailable", {"Retry-After": "40"}, None),
            b'{"batchcomplete":""}',
        ])
        self.assertEqual(result, {"batchcomplete": ""})
        self.assertEqual(api.requests, 3)
        self.assertEqual(starts, [0, 10, 50])
        self.assertEqual([delay for delay in sleeps if delay], [10, 40])
        self.assertEqual(len(set(bodies)), 1)
        self.assertEqual(parse_qs(bodies[0].decode())["gcmcontinue"], ["retained|cursor"])

    def test_three_attempt_limit_and_request_budget_include_retries(self):
        failures = [HTTPError(refresh.API_URL, 504, "Timeout", {}, None) for _ in range(3)]
        api, result, starts, _, _ = self.mocked_transport(failures)
        self.assertIsInstance(result, refresh.RefreshError)
        self.assertNotIsInstance(result, refresh.RequestBudgetReached)
        self.assertEqual(api.requests, 3)
        self.assertEqual(starts, [0, 10, 40])
        failures = [HTTPError(refresh.API_URL, 429, "Rate limited", {}, None) for _ in range(2)]
        api, result, starts, _, _ = self.mocked_transport(failures, max_requests=2)
        self.assertIsInstance(result, refresh.RequestBudgetReached)
        self.assertEqual(api.requests, 2)
        self.assertEqual(starts, [0, 10])

    def test_auth_failures_and_challenge_html_or_api_errors_never_retry(self):
        for outcome in [
            HTTPError(refresh.API_URL, code, "Rejected", {}, None) for code in (401, 403, 404, 500)
        ] + [b"<html>Challenge</html>", b'{"error":{"code":"maxlag"}}']:
            api, result, starts, sleeps, _ = self.mocked_transport([outcome])
            self.assertIsInstance(result, refresh.RefreshError)
            self.assertEqual(api.requests, 1)
            self.assertEqual(starts, [0])
            self.assertEqual(sleeps, [])

    def test_retry_after_supports_http_date_and_ignores_invalid_values(self):
        with patch.object(refresh.time, "time", return_value=0):
            self.assertEqual(refresh.retry_after_seconds("Thu, 01 Jan 1970 00:01:00 GMT"), 60)
        for value in (None, "", "invalid", "nan", "inf", "-5"):
            self.assertEqual(refresh.retry_after_seconds(value), 0)

    def test_post_requests_have_no_cookie_or_credentials_and_are_spaced(self):
        calls = []

        def open_response(request, timeout):
            calls.append(request)
            result = io.BytesIO(json.dumps({"batchcomplete": ""}).encode())
            result.status = 200
            return result

        with patch.object(refresh, "urlopen", side_effect=open_response), \
                patch.object(refresh.time, "monotonic", side_effect=[100, 101, 103]), \
                patch.object(refresh.time, "sleep") as sleep:
            api = refresh.WikiApi(max_requests=2)
            api.query({"generator": "categorymembers"})
            api.query({"generator": "categorymembers", "continue": "next"})
            with self.assertRaises(refresh.RequestBudgetReached):
                api.query({})
        sleep.assert_called_once_with(2)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].method, "POST")
        self.assertEqual(calls[0].full_url, refresh.API_URL)
        self.assertFalse(any(key.lower() in ("cookie", "authorization") for key in calls[0].headers))
        self.assertEqual(parse_qs(calls[1].data.decode())["continue"], ["next"])

    def test_api_errors_and_warnings_are_not_successes(self):
        for body in ({"error": {"code": "maxlag"}}, {"warnings": {"query": "invalid parameter"}}, []):
            result = io.BytesIO(json.dumps(body).encode())
            result.status = 200
            with patch.object(refresh, "urlopen", return_value=result), self.assertRaises(refresh.RefreshError):
                refresh.WikiApi().query({})
        with self.assertRaises(ValueError):
            refresh.WikiApi(delay=2.9)

    def test_sha1_accepts_mediawiki_hex_and_base36(self):
        # SHA1('hello') = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d.
        self.assertTrue(refresh.source_hash_matches("hello", hashlib.sha1(b"hello").hexdigest()))
        self.assertTrue(refresh.source_hash_matches("hello", "jywkymwk5kel4plcu17bdqhwzuuz3nx"))
        self.assertFalse(refresh.source_hash_matches("changed", "jywkymwk5kel4plcu17bdqhwzuuz3nx"))


if __name__ == "__main__":
    unittest.main()
