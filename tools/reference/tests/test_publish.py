"""Publisher tests use synthetic files and mocked public/R2 responses only."""
import contextlib
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import publish as publisher


def write_manifest(path, packs):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schemaVersion": 1, "createdAt": "2026-09-07T00:00:00Z", "packs": packs}))
    return path


def prepare_fixture(root):
    public = root / "public"
    directory = public / "references/new/v1"
    directory.mkdir(parents=True)
    path = directory / "part-00001.sqlite.gzip"
    expanded = b"Synthetic reference data.\n" * 100
    path.write_bytes(gzip.compress(expanded, mtime=0))
    shard = {"url": "/references/new/v1/part-00001.sqlite.gzip", "bytes": path.stat().st_size,
             "sha256": publisher.digest(path), "compression": {"format": "gzip", "uncompressedBytes": len(expanded),
                                                                "uncompressedSha256": hashlib.sha256(expanded).hexdigest()}}
    new_pack = {"id": "new", "source": "opentargets", "version": "v1", "shards": [shard]}
    old_pack = {"id": "old", "source": "clinvar", "version": "old-v1", "shards": []}
    (directory / "LICENSE.txt").write_text("Synthetic public fixture license")
    write_manifest(directory / "manifest.json", [new_pack])
    baseline = write_manifest(public / "references/manifest.json", [old_pack])
    assets = write_manifest(root / "new-assets.json", [new_pack])
    catalog = write_manifest(public / "references/manifest-v2.json", [old_pack, new_pack])
    args = SimpleNamespace(baseline_manifest=baseline, assets_manifest=assets, catalog=catalog,
                           host="https://static.example.com", origin="https://example.com", bucket="fixture",
                           receipt=root / "receipt.json")
    return args, old_pack, new_pack


def entry_for(root, args):
    return next(entry for entry in publisher.inventory(root / "public", args.assets_manifest) if entry["key"].endswith(".gzip"))


def response(entry, status=200, headers=None):
    defaults = {"access-control-allow-origin": "*", "content-type": "application/gzip",
                "cache-control": "public, max-age=31536000, immutable"}
    if headers:
        defaults.update(headers)
    return status, defaults, entry["bytes"], entry["sha256"]


def completed(code=0, stdout="", stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class InventoryTests(unittest.TestCase):
    def test_valid_shards_and_metadata_have_exact_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args, _, _ = prepare_fixture(root)
            entries = publisher.inventory(root / "public", args.assets_manifest)
            self.assertEqual(len(entries), 3)
            for entry in entries:
                self.assertEqual(entry["sha256"], publisher.digest(entry["path"]))

    def test_bad_expanded_hash_fails_before_any_network(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(publisher.subprocess, "run") as run:
            root = Path(temporary)
            args, _, pack = prepare_fixture(root)
            pack["shards"][0]["compression"]["uncompressedSha256"] = "0" * 64
            write_manifest(args.assets_manifest, [pack])
            with self.assertRaisesRegex(ValueError, "Decoded shard SHA-256"):
                publisher.inventory(root / "public", args.assets_manifest)
            run.assert_not_called()

    def test_duplicate_asset_paths_and_fragmented_paths_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args, _, pack = prepare_fixture(root)
            pack["shards"].append(copy.deepcopy(pack["shards"][0]))
            write_manifest(args.assets_manifest, [pack])
            with self.assertRaisesRegex(ValueError, "Duplicate reference asset"):
                publisher.inventory(root / "public", args.assets_manifest)
            pack["shards"] = pack["shards"][:1]
            pack["shards"][0]["url"] += "#ignored"
            write_manifest(args.assets_manifest, [pack])
            with self.assertRaisesRegex(ValueError, "canonical local"):
                publisher.inventory(root / "public", args.assets_manifest)

    def test_metadata_and_shard_symlinks_cannot_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args, _, pack = prepare_fixture(root)
            target = root / "outside.txt"
            target.write_text("Synthetic outside-path fixture")
            license_file = root / "public/references/new/v1/LICENSE.txt"
            license_file.unlink()
            license_file.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "symlinks"):
                publisher.inventory(root / "public", args.assets_manifest)
            license_file.unlink()
            shard = root / "public/references/new/v1/part-00001.sqlite.gzip"
            shard.unlink()
            shard.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "symlink"):
                publisher.inventory(root / "public", args.assets_manifest)


class CatalogTests(unittest.TestCase):
    def test_exact_additions_allowed_but_changed_removed_or_extra_packs_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args, old, new = prepare_fixture(root)
            publisher.validate_catalog(args.baseline_manifest, args.assets_manifest, args.catalog)
            changed = {**old, "version": "replaced"}
            for packs in ([changed, new], [new], [old, new, {**new, "id": "unverified"}], [old, new, new]):
                write_manifest(args.catalog, packs)
                with self.subTest(packs=packs), self.assertRaises(ValueError):
                    publisher.validate_catalog(args.baseline_manifest, args.assets_manifest, args.catalog)

    def test_catalog_cannot_overwrite_baseline_or_enter_parallel_asset_batch(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(publisher, "public_object") as public:
            root = Path(temporary)
            args, old, new = prepare_fixture(root)
            args.catalog = args.baseline_manifest
            with self.assertRaisesRegex(ValueError, "overwrite the baseline"):
                publisher.run_publication(args, root)
            args.catalog = root / "public/references/new/v1/manifest.json"
            write_manifest(args.catalog, [old, new])
            with self.assertRaisesRegex(ValueError, "must publish last"):
                publisher.run_publication(args, root)
            public.assert_not_called()

    def test_catalog_only_publishes_after_every_asset_success_and_old_baseline_verified(self):
        with tempfile.TemporaryDirectory() as temporary, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temporary)
            args, _, _ = prepare_fixture(root)
            events = []
            def public(host, entry, origin):
                events.append("baseline-read")
                return response(entry)
            def publish(entry, args, root):
                events.append(entry["key"])
                return {"key": entry["key"], "uploaded": True}
            with patch.object(publisher, "public_object", public), patch.object(publisher, "publish", publish):
                publisher.run_publication(args, root)
            self.assertEqual(events[0], "baseline-read")
            self.assertEqual(events[-2:], ["references/manifest-v2.json", "baseline-read"])
            self.assertEqual(len(events), 6)
            self.assertIn("not expose an atomic", json.loads(args.receipt.read_text())["writeConcurrencyLimitation"])

    def test_failed_asset_or_wrong_public_baseline_prevents_catalog(self):
        with tempfile.TemporaryDirectory() as temporary, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temporary)
            args, _, _ = prepare_fixture(root)
            seen = []
            def fail(entry, args, root):
                seen.append(entry["key"])
                raise RuntimeError("Synthetic asset verification failure")
            with patch.object(publisher, "public_object", lambda host, entry, origin: response(entry)), patch.object(publisher, "publish", fail):
                with self.assertRaisesRegex(RuntimeError, "asset verification"):
                    publisher.run_publication(args, root)
            self.assertNotIn("references/manifest-v2.json", seen)
            with patch.object(publisher, "public_object", return_value=(404, {}, 0, "0" * 64)), patch.object(publisher, "publish") as publish:
                with self.assertRaisesRegex(ValueError, "baseline does not match"):
                    publisher.run_publication(args, root)
                publish.assert_not_called()


class R2Tests(unittest.TestCase):
    def test_public_verification_requests_do_not_reuse_negative_cache_and_reset_headers(self):
        urls = []
        def run(command, **kwargs):
            urls.append(command[-1])
            Path(command[command.index("--output") + 1]).write_bytes(b"public")
            Path(command[command.index("--dump-header") + 1]).write_text(
                "HTTP/2 503\r\nAccess-Control-Allow-Origin: *\r\n\r\nHTTP/2 200\r\nContent-Type: text/plain\r\n\r\n"
            )
            return completed(stdout="200")
        with patch.object(publisher.subprocess, "run", run):
            entry = {"key": "references/test/v1/LICENSE.txt", "sha256": "0" * 64}
            first = publisher.public_object("https://static.example.com", entry, "https://example.com")
            publisher.public_object("https://static.example.com", entry, "https://example.com")
        self.assertNotEqual(urls[0], urls[1])
        self.assertNotIn("access-control-allow-origin", first[1])
        self.assertEqual(first[1]["content-type"], "text/plain")

    def test_only_explicit_observed_missing_error_is_recognized(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "object"
            self.assertTrue(publisher.known_missing_r2(completed(1, stderr="✘ [ERROR] The specified key does not exist.\n"), path))
            for error in ("[ERROR] Authentication error", "[ERROR] Fetch failed", "[ERROR] The bucket does not exist",
                          '[ERROR] Unexpected response: "The specified key does not exist."',
                          "[ERROR] The specified key does not exist.\n[ERROR] Authentication error"):
                self.assertFalse(publisher.known_missing_r2(completed(1, stderr=error), path))
            self.assertFalse(publisher.known_missing_r2(completed(2, stderr="The specified key does not exist."), path))
            path.write_bytes(b"partial")
            self.assertFalse(publisher.known_missing_r2(completed(1, stderr="The specified key does not exist."), path))

    def test_missing_error_allows_wranger_empty_file_but_not_directory_or_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "object"
            missing = completed(1, stderr="✘ [ERROR] The specified key does not exist.\n")
            path.write_bytes(b"")
            self.assertTrue(publisher.known_missing_r2(missing, path))
            self.assertFalse(publisher.known_missing_r2(completed(1, stderr="[ERROR] Authentication error"), path))
            path.unlink()
            path.mkdir()
            self.assertFalse(publisher.known_missing_r2(missing, path))
            path.rmdir()
            target = Path(temporary) / "empty"
            target.write_bytes(b"")
            path.symlink_to(target)
            self.assertFalse(publisher.known_missing_r2(missing, path))

    def test_public404_existing_r2_different_bytes_or_auth_never_puts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args, _, _ = prepare_fixture(root)
            entry = entry_for(root, args)
            calls = []
            def get_different(command, **kwargs):
                calls.append(command)
                self.assertEqual(command[4], "get")
                Path(command[command.index("--file") + 1]).write_bytes(b"different existing object")
                return completed()
            with patch.object(publisher, "public_object", return_value=response(entry, 404)), patch.object(publisher.subprocess, "run", get_different):
                with self.assertRaisesRegex(ValueError, "already present in R2"):
                    publisher.publish(entry, args, root)
            self.assertEqual(len(calls), 1)
            with patch.object(publisher, "public_object", return_value=response(entry, 404)), patch.object(publisher.subprocess, "run", return_value=completed(1, stderr="[ERROR] Authentication error")) as run:
                with self.assertRaisesRegex(RuntimeError, "could not establish"):
                    publisher.publish(entry, args, root)
                self.assertEqual(run.call_count, 1)

    def test_missing_r2_get_precedes_put_and_public_hash_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args, _, _ = prepare_fixture(root)
            entry = entry_for(root, args)
            commands = []
            def run(command, **kwargs):
                commands.append(command[4])
                if command[4] == "get":
                    Path(command[command.index("--file") + 1]).write_bytes(b"")
                return completed(1, stderr="✘ [ERROR] The specified key does not exist.") if command[4] == "get" else completed()
            with patch.object(publisher, "public_object", side_effect=[response(entry, 404), response(entry)]), patch.object(publisher.subprocess, "run", run):
                self.assertTrue(publisher.publish(entry, args, root)["uploaded"])
            self.assertEqual(commands, ["get", "put"])

    def test_same_existing_r2_object_is_not_reuploaded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args, _, _ = prepare_fixture(root)
            entry = entry_for(root, args)
            def get_same(command, **kwargs):
                self.assertEqual(command[4], "get")
                Path(command[command.index("--file") + 1]).write_bytes(entry["path"].read_bytes())
                return completed()
            with patch.object(publisher, "public_object", side_effect=[response(entry, 404), response(entry)]), patch.object(publisher.subprocess, "run", get_same) as run:
                self.assertFalse(publisher.publish(entry, args, root)["uploaded"])

    def test_public_header_or_hash_failure_never_claims_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args, _, _ = prepare_fixture(root)
            entry = entry_for(root, args)
            bad = [response(entry, headers={"access-control-allow-origin": "https://other.example"}),
                   response(entry, headers={"content-encoding": "gzip"}),
                   response(entry, headers={"cache-control": "no-store"}),
                   response(entry, headers={"content-type": "text/plain"}),
                   (200, {}, entry["bytes"], "0" * 64)]
            for value in bad:
                with self.subTest(response=value), patch.object(publisher, "public_object", return_value=value), patch.object(publisher.subprocess, "run") as run:
                    with self.assertRaises(ValueError):
                        publisher.publish(entry, args, root)
                    run.assert_not_called()

    def test_local_bytes_changed_after_inventory_never_reach_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args, _, _ = prepare_fixture(root)
            entry = entry_for(root, args)
            entry["path"].write_bytes(b"changed")
            with patch.object(publisher, "public_object") as public, self.assertRaisesRegex(ValueError, "changed after inventory"):
                publisher.publish(entry, args, root)
            public.assert_not_called()


if __name__ == "__main__":
    unittest.main()
