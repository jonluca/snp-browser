"""Synthetic regression fixtures for Open Targets fine-mapping conversion."""
import copy
import contextlib
import gzip
import io
import json
import math
import sys
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import open_targets as ot


def study():
    return {
        "studyId": "FINNGEN_R12_G6_PARKINSON", "studyType": "gwas", "projectId": "FINNGEN_R12",
        "traitFromSource": "Parkinson's disease", "diseaseIds": ["MONDO_0005180"],
        "pubmedId": "12345678", "publicationDate": "2025-02-01", "nCases": 25, "nControls": 100,
        "discoverySamples": [{"sampleSize": 125, "ancestry": "Finnish"}],
        "ldPopulationStructure": [{"ldPopulation": "fin", "relativeSampleSize": 1.0}],
    }


def credible():
    return {
        "studyId": study()["studyId"], "studyLocusId": "synthetic-signal-1", "studyType": "gwas",
        "variantId": "1_100_A_G", "finemappingMethod": "SuSiE", "confidence": "Synthetic confidence",
        "beta": 4.0,
        "locus": [
            {"variantId": "1_100_A_G", "is95CredibleSet": True, "is99CredibleSet": True,
             "posteriorProbability": 0.7, "beta": -0.12, "standardError": 0.02, "pValueMantissa": 2.5,
             "pValueExponent": -9, "logBF": 14.2},
            {"variantId": "1_125_A_AT", "is95CredibleSet": True, "is99CredibleSet": True,
             "posteriorProbability": 0.27, "beta": None},
            {"variantId": "1_150_T_C", "is95CredibleSet": False, "is99CredibleSet": True,
             "posteriorProbability": 0.02, "beta": 0.8},
        ],
    }


class AnnotationTests(unittest.TestCase):
    def test_full_95_percent_members_have_exact_identity_but_variant_scope(self):
        rows = list(ot.annotations_for_set(credible(), study()))
        self.assertEqual(len(rows), 2)
        self.assertEqual([r["scope"] for r in rows], ["variant", "variant"])
        self.assertEqual(rows[0]["assembly"], "GRCh38")
        self.assertEqual(rows[0]["position"], 100)
        self.assertEqual(rows[1]["ref"], "A")
        self.assertEqual(rows[1]["alt"], "AT")
        self.assertNotIn("rsid", rows[0])
        self.assertNotIn("gene", rows[0])

    def test_member_effect_not_lead_effect_and_no_orientation_inference(self):
        row = next(ot.annotations_for_set(credible(), study()))
        self.assertEqual(row["fields"]["reportedBeta"], -0.12)
        self.assertEqual(row["fields"]["posteriorInclusionProbability"], 0.7)
        self.assertIn("not personal disease risk", row["fields"]["probabilityMeaning"])
        self.assertIn("without an inferred effect allele", row["fields"]["effectInterpretation"])
        self.assertEqual(json.loads(row["fields"]["credibleSetMetadata"])["beta"], 4.0)
        self.assertEqual(json.loads(row["fields"]["variantFineMapping"])["logBF"], 14.2)

    def test_study_ancestry_and_citations_retained(self):
        row = next(ot.annotations_for_set(credible(), study()))
        self.assertEqual(json.loads(row["fields"]["studyMetadata"]), study())
        self.assertEqual(json.loads(row["fields"]["discoverySamples"])[0]["ancestry"], "Finnish")
        self.assertEqual(row["lastEvaluated"], "2025-02-01")
        self.assertEqual(row["citations"][2]["url"], "https://pubmed.ncbi.nlm.nih.gov/12345678/")

    def test_identity_preserves_distinct_studies_and_signals(self):
        first = next(ot.annotations_for_set(credible(), study()))
        data, source = credible(), study()
        data["studyLocusId"] = "synthetic-signal-2"
        second = next(ot.annotations_for_set(data, source))
        self.assertNotEqual(first["id"], second["id"])
        data["studyId"] = source["studyId"] = "ANOTHER_PUBLIC_STUDY"
        third = next(ot.annotations_for_set(data, source))
        self.assertNotEqual(second["id"], third["id"])

    def test_exact_duplicate_members_are_collapsed_before_probability_sum(self):
        data = credible()
        data["locus"].append(copy.deepcopy(data["locus"][0]))
        self.assertEqual(len(list(ot.annotations_for_set(data, study()))), 2)
        data["locus"][-1]["beta"] = 0.2
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            list(ot.annotations_for_set(data, study()))

    def test_invalid_probability_and_incomplete_set_rejected(self):
        for value in (-0.1, 1.1, math.nan, math.inf, True, None):
            with self.subTest(value=value):
                data = credible()
                data["locus"][0]["posteriorProbability"] = value
                with self.assertRaises(ValueError):
                    list(ot.annotations_for_set(data, study()))
        data = credible()
        data["locus"] = data["locus"][:1]
        with self.assertRaisesRegex(ValueError, "probability total"):
            list(ot.annotations_for_set(data, study()))

    def test_mismatched_or_molecular_studies_rejected(self):
        for key, value in (("studyId", "OTHER"), ("studyType", "eqtl")):
            source = study()
            source[key] = value
            with self.assertRaisesRegex(ValueError, "GWAS study identity"):
                list(ot.annotations_for_set(credible(), source))

    def test_hashed_or_invalid_variant_never_fabricates_coordinates(self):
        for value in ("OTVAR_1_100_hash", "chr1_100_A_G", "1_0_A_G", "1_10_A_A", "23_100_A_G", "1_100_N_T"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ot.variant_location(value)

    def test_nonfinite_and_invalid_uncertainty_rejected(self):
        for field, value in (("beta", math.nan), ("standardError", -1), ("r2Overall", 1.1), ("pValueExponent", 1.2)):
            data = credible()
            data["locus"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                list(ot.annotations_for_set(data, study()))


class RangeTests(unittest.TestCase):
    def test_budget_bounds_cumulative_downloads(self):
        budget = ot.DownloadBudget(10)
        budget.consume(8)
        with self.assertRaisesRegex(ValueError, "budget exceeded"):
            budget.consume(3)
        self.assertEqual(budget.used, 8)

    def test_range_response_identity_length_and_cached_hash_verified(self):
        class Response(io.BytesIO):
            def __init__(self, data, status, headers):
                super().__init__(data)
                self.status, self.headers = status, headers
        calls = []
        def urlopen(request, timeout):
            calls.append(request)
            if request.get_method() == "HEAD":
                return Response(b"", 200, {"Content-Length": "6", "ETag": '"fixed"'})
            return Response(b"abc", 206, {"Content-Range": "bytes 0-2/6", "ETag": '"fixed"'})
        with tempfile.TemporaryDirectory() as temp, patch.object(ot.urllib.request, "urlopen", urlopen):
            remote = ot.RangeFile(ot.BASE_URL + "/credible_set/test.parquet", temp, ot.DownloadBudget(3))
            self.assertEqual(remote.read(3), b"abc")
            remote.seek(0)
            self.assertEqual(remote.read(3), b"abc")
            self.assertEqual(len(calls), 2)
            (remote.cache / "0-3.bin").write_bytes(b"bad")
            remote.seek(0)
            with self.assertRaisesRegex(ValueError, "integrity"):
                remote.read(3)

    def test_unpinned_or_wrong_range_response_is_rejected(self):
        class Response(io.BytesIO):
            status = 206
            headers = {"Content-Length": "6", "ETag": '"fixed"', "Content-Range": "bytes 1-3/6"}

        with tempfile.TemporaryDirectory() as temp, patch.object(
            ot.urllib.request, "urlopen", lambda request, timeout: Response(b"abc")
        ):
            remote = ot.RangeFile(ot.BASE_URL + "/credible_set/test.parquet", temp, ot.DownloadBudget(3))
            with self.assertRaisesRegex(ValueError, "pinned byte range"):
                remote.read(3)
        with tempfile.TemporaryDirectory() as temp, self.assertRaisesRegex(ValueError, "pinned public"):
            ot.RangeFile("https://example.com/personal.parquet", temp, ot.DownloadBudget(3))


class PackTests(unittest.TestCase):
    def test_real_builder_preserves_rows_and_deduplicates_repeated_sets(self):
        selected = {"release": ot.RELEASE, "studyIds": list(ot.STUDIES), "studies": {}, "credibleSets": []}
        for index, study_id in enumerate(ot.STUDIES):
            source, data = study(), credible()
            source["studyId"] = data["studyId"] = study_id
            data["studyLocusId"] = f"synthetic-signal-{index}"
            selected["studies"][study_id] = source
            selected["credibleSets"].append(data)
        selected["credibleSets"].append(copy.deepcopy(selected["credibleSets"][0]))
        previous = ot.build.SOURCES
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            manifest = ot.prepare(selected, {}, temp, "synthetic-test")
            pack = manifest["packs"][0]
            self.assertEqual(pack["recordCount"], 6)
            root = Path(temp) / "opentargets" / pack["version"]
            shard = pack["shards"][0]
            binary = root / Path(shard["url"]).name
            self.assertEqual(ot.build.sha256_file(binary), shard["sha256"])
            database_path = Path(temp) / "verify.sqlite"
            database_path.write_bytes(gzip.decompress(binary.read_bytes()))
            with sqlite3.connect(database_path) as database:
                self.assertEqual(database.execute("PRAGMA quick_check").fetchone()[0], "ok")
                self.assertEqual(database.execute("SELECT COUNT(*) FROM annotations WHERE scope='variant'").fetchone()[0], 6)
            provenance = json.loads((root / "provenance.json").read_text())
            self.assertEqual(provenance["credibleSetCount"], 3)
            with self.assertRaisesRegex(ValueError, "Immutable output already exists"):
                ot.prepare(selected, {}, temp, "synthetic-test")
        self.assertEqual(ot.build.SOURCES, previous)


if __name__ == "__main__":
    unittest.main()
