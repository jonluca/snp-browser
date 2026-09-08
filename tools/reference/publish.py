#!/usr/bin/env python3
"""Publish public reference assets, then a new catalog; preserve the prior catalog."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
from urllib.parse import urlparse
import uuid

from compact import checked_identity, verify_gzip

CLI_WRITE_LIMITATION = (
    "Wrangler does not expose an atomic create-only put. Direct R2 existence and byte-identity checks "
    "run before uploads, but another writer could create the same key between get and put. "
    "Use unique immutable version keys and do not run concurrent writers for these keys."
)
METADATA_NAME = re.compile(r"LICENSE(?:\..*)?|provenance\.json|selection\.json|build-stats\.json|manifest\.json", re.I)
SAFE_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]*")
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def digest(path):
    checksum = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            checksum.update(chunk)
    return checksum.hexdigest()


def manifest_packs(manifest):
    data = json.loads(Path(manifest).read_text())
    if data.get("schemaVersion") != 1 or not isinstance(data.get("packs"), list):
        raise ValueError("Expected a schemaVersion 1 reference catalog")
    packs = {}
    for pack in data["packs"]:
        if not isinstance(pack, dict) or not isinstance(pack.get("id"), str) or not SAFE_ID.fullmatch(pack["id"]):
            raise ValueError("Invalid reference pack identity")
        if pack["id"] in packs:
            raise ValueError("Duplicate reference pack identity: " + pack["id"])
        packs[pack["id"]] = pack
    return packs


def validate_catalog(baseline, requested, catalog):
    old, new, combined = (manifest_packs(path) for path in (baseline, requested, catalog))
    if not old or not new:
        raise ValueError("Baseline and new-assets catalogs must be nonempty")
    if old.keys() & new.keys():
        raise ValueError("New packs must not replace any baseline pack identity")
    expected = {**old, **new}
    if combined.keys() != expected.keys():
        raise ValueError("Catalog must contain exactly the baseline packs plus the requested additions")
    for pack_id, pack in expected.items():
        if combined[pack_id] != pack:
            raise ValueError("Catalog changes a baseline pack or disagrees with a requested addition: " + pack_id)


def inventory(public, manifest):
    public = Path(public).resolve()
    reference_root = public / "references"
    files = {}
    shard_keys = set()
    scanned_directories = set()
    for pack in manifest_packs(manifest).values():
        version = pack.get("version")
        if not isinstance(version, str) or not SAFE_ID.fullmatch(version):
            raise ValueError("Invalid immutable pack version")
        if not isinstance(pack.get("shards"), list) or not pack["shards"]:
            raise ValueError("Reference pack has no shards")
        prefix = f"references/{pack['id']}/{version}/"
        for shard in pack["shards"]:
            url = urlparse(shard["url"])
            key = url.path.removeprefix("/")
            if (url.scheme or url.netloc or url.query or url.fragment or url.params
                    or not url.path.startswith("/") or not key.startswith(prefix)
                    or not re.fullmatch(r"[a-zA-Z0-9/._-]+", key)
                    or str(PurePosixPath(key)) != key
                    or ".." in PurePosixPath(key).parts
                    or len(PurePosixPath(key).parts) != 4
                    or not key.endswith((".sqlite", ".sqlite.gzip"))):
                raise ValueError("Only canonical local immutable reference shard paths may be published")
            if key in shard_keys:
                raise ValueError("Duplicate reference asset path: " + key)
            shard_keys.add(key)
            path = (public / key).resolve()
            if not path.is_relative_to(reference_root) or path != public / key:
                raise ValueError("Reference path escapes public/references or uses a symlink")
            checked_identity(shard["bytes"], shard["sha256"])
            if not path.is_file() or path.stat().st_size != shard["bytes"] or digest(path) != shard["sha256"]:
                raise ValueError("Asset integrity mismatch: " + key)
            compression = shard.get("compression")
            if compression is not None:
                if compression.get("format") != "gzip" or not key.endswith(".sqlite.gzip"):
                    raise ValueError("Unexpected reference compression metadata: " + key)
                verify_gzip(path, compression["uncompressedBytes"], compression["uncompressedSha256"])
            elif key.endswith(".gzip"):
                raise ValueError("Compressed shard has no expanded identity: " + key)
            files[key] = path
            if path.parent in scanned_directories:
                continue
            scanned_directories.add(path.parent)
            for metadata in path.parent.iterdir():
                if not METADATA_NAME.fullmatch(metadata.name):
                    continue
                resolved = metadata.resolve()
                if metadata.is_symlink() or not resolved.is_relative_to(reference_root):
                    raise ValueError("Reference metadata symlinks or escaped paths are not allowed: " + metadata.name)
                if not metadata.is_file():
                    raise ValueError("Reference metadata must be a regular file: " + metadata.name)
                metadata_key = metadata.relative_to(public).as_posix()
                if metadata_key in files:
                    raise ValueError("Duplicate reference metadata path: " + metadata_key)
                files[metadata_key] = metadata
    return [{"key": key, "path": path, "bytes": path.stat().st_size, "sha256": digest(path)}
            for key, path in sorted(files.items())]


def public_object(host, entry, origin):
    with tempfile.TemporaryDirectory(prefix="snp-public-reference-") as temporary:
        body = Path(temporary) / "body"
        headers_file = Path(temporary) / "headers"
        # Each request needs a fresh query: the preflight itself can cache a 404
        # immediately before a successful upload under the same checksum query.
        result = subprocess.run([
            "curl", "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "180",
            "--retry", "2", "--dump-header", str(headers_file), "--output", str(body),
            "--write-out", "%{http_code}", "-H", f"Origin: {origin}",
            f"{host.rstrip('/')}/{entry['key']}?verify={entry['sha256']}&request={uuid.uuid4().hex}",
        ], capture_output=True, text=True, check=True)
        headers = {}
        for line in headers_file.read_text().splitlines():
            if line.startswith("HTTP/"):
                headers = {}
            elif ":" in line:
                key, value = line.split(":", 1)
                headers[key.lower()] = value.strip()
        return int(result.stdout), headers, body.stat().st_size, digest(body)


def known_missing_r2(result, path):
    """Only Wrangler's observed explicit missing-key error permits a new upload."""
    if result.returncode != 1 or path.is_symlink():
        return False
    # Wrangler creates its --file destination before reporting a missing key.
    # An empty regular file is compatible with absence; partial data is not.
    if path.exists() and (not path.is_file() or path.stat().st_size != 0):
        return False
    lines = ANSI_ESCAPE.sub("", result.stderr + "\n" + result.stdout).splitlines()
    missing = re.compile(r"\s*(?:[✘×xX]\s*)?(?:\[ERROR\]|ERROR)?\s*The specified key does not exist\.\s*")
    if not any(missing.fullmatch(line) for line in lines):
        return False
    return not any(re.search(r"\bERROR\b", line, re.I) and not missing.fullmatch(line) for line in lines)


def r2_preflight(entry, args, root):
    """Return True only for a confirmed missing R2 key; never turn auth failures into absence."""
    with tempfile.TemporaryDirectory(prefix="snp-r2-preflight-") as temporary:
        path = Path(temporary) / "object"
        result = subprocess.run([
            "bunx", "wrangler", "r2", "object", "get", f"{args.bucket}/{entry['key']}",
            "--remote", "--file", str(path),
        ], cwd=root, capture_output=True, text=True, timeout=240)
        if result.returncode == 0:
            if not path.is_file() or path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
                raise ValueError("Refusing to overwrite different content already present in R2: " + entry["key"])
            return False
        if known_missing_r2(result, path):
            return True
        output = ANSI_ESCAPE.sub("", result.stderr + "\n" + result.stdout).strip()
        raise RuntimeError(f"R2 preflight could not establish object existence for {entry['key']}: {output[-1200:]}")


def verify_local_entry(entry):
    path = entry["path"]
    if not path.is_file() or path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
        raise ValueError("Local asset changed after inventory: " + entry["key"])


def publish(entry, args, root):
    root = Path(root).resolve()
    verify_local_entry(entry)
    status, headers, size, checksum = public_object(args.host, entry, args.origin)
    if status == 200 and (size != entry["bytes"] or checksum != entry["sha256"]):
        raise ValueError("Refusing to overwrite different published content: " + entry["key"])
    if status not in (200, 404):
        raise ValueError(f"Unexpected public HTTP {status}: {entry['key']}")
    catalog = entry["key"] == args.catalog.resolve().relative_to(root / "public").as_posix()
    cache_control = "public, max-age=0, must-revalidate" if catalog else "public, max-age=31536000, immutable"
    content_type = ("application/gzip" if entry["key"].endswith(".gzip") else
                    "application/octet-stream" if entry["key"].endswith(".sqlite") else
                    "application/json" if entry["key"].endswith(".json") else "text/plain; charset=utf-8")
    uploaded = False
    if status == 404:
        missing = r2_preflight(entry, args, root)
        if missing:
            verify_local_entry(entry)
            result = subprocess.run([
                "bunx", "wrangler", "r2", "object", "put", f"{args.bucket}/{entry['key']}", "--remote",
                "--file", str(entry["path"]), "--content-type", content_type, "--cache-control", cache_control,
            ], cwd=root, capture_output=True, text=True, timeout=240)
            if result.returncode:
                raise RuntimeError(f"Upload failed for {entry['key']}: {(result.stderr + result.stdout)[-1200:]}")
            uploaded = True
        status, headers, size, checksum = public_object(args.host, entry, args.origin)
    if status != 200 or size != entry["bytes"] or checksum != entry["sha256"]:
        raise ValueError("Public verification failed: " + entry["key"])
    if headers.get("access-control-allow-origin") not in ("*", args.origin):
        raise ValueError("Public CORS verification failed: " + entry["key"])
    if headers.get("content-encoding") and entry["key"].endswith(".gzip"):
        raise ValueError("Compressed reference asset must not have HTTP Content-Encoding: " + entry["key"])
    if (headers.get("content-type", "").split(";")[0] != content_type.split(";")[0]
            or headers.get("cache-control") != cache_control):
        raise ValueError("Unexpected public content/cache headers: " + entry["key"])
    return {key: value for key, value in dict(entry, uploaded=uploaded).items() if key != "path"}


def run_publication(args, root):
    root = Path(root).resolve()
    public = root / "public"
    catalog_path = args.catalog.resolve()
    baseline_path = args.baseline_manifest.resolve()
    for path in (catalog_path, baseline_path):
        if not path.is_relative_to(public / "references") or path.suffix != ".json":
            raise ValueError("Catalog and baseline must be JSON files inside public/references")
    if catalog_path == baseline_path:
        raise ValueError("The new catalog must not overwrite the baseline catalog path")
    for host in (args.host, args.origin):
        parsed = urlparse(host)
        if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ValueError("Public asset host and origin must be HTTPS origins")
    args.host, args.origin = args.host.rstrip("/"), args.origin.rstrip("/")
    validate_catalog(baseline_path, args.assets_manifest, catalog_path)
    entries = inventory(public, args.assets_manifest)
    catalog_entry = {"key": catalog_path.relative_to(public).as_posix(), "path": catalog_path,
                     "bytes": catalog_path.stat().st_size, "sha256": digest(catalog_path)}
    if catalog_entry["key"] in {entry["key"] for entry in entries}:
        raise ValueError("The catalog must not also be a versioned asset; it must publish last")
    baseline_entry = {"key": baseline_path.relative_to(public).as_posix(), "path": baseline_path,
                      "bytes": baseline_path.stat().st_size, "sha256": digest(baseline_path)}
    status, _, size, checksum = public_object(args.host, baseline_entry, args.origin)
    if status != 200 or size != baseline_entry["bytes"] or checksum != baseline_entry["sha256"]:
        raise ValueError("The supplied baseline does not match the existing public catalog")
    print(json.dumps({"new_asset_files": len(entries), "bytes": sum(entry["bytes"] for entry in entries)}), flush=True)
    print(CLI_WRITE_LIMITATION, flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        receipts = list(executor.map(lambda entry: publish(entry, args, root), entries))
    print("Versioned assets verified; publishing catalog last.", flush=True)
    receipts.append(publish(catalog_entry, args, root))
    # Preserve the exact old catalog throughout this publication.
    status, _, size, checksum = public_object(args.host, baseline_entry, args.origin)
    if status != 200 or size != baseline_entry["bytes"] or checksum != baseline_entry["sha256"]:
        raise ValueError("The prior public catalog changed during publication")
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps({"host": args.host, "bucket": args.bucket, "baseline": baseline_entry["key"],
                                      "writeConcurrencyLimitation": CLI_WRITE_LIMITATION, "verified": receipts}, indent=2) + "\n")
    print(json.dumps({"result": "PUBLICATION_VERIFIED", "files": len(receipts),
                      "catalog": f"{args.host}/{catalog_entry['key']}"}), flush=True)
    return receipts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-manifest", type=Path, required=True, help="Manifest containing only the new packs to upload")
    parser.add_argument("--baseline-manifest", type=Path, required=True, help="Unchanged existing public catalog")
    parser.add_argument("--catalog", type=Path, required=True, help="New catalog path in public/references; published last")
    parser.add_argument("--host", default="https://static.snpbrowser.com")
    parser.add_argument("--origin", default="https://snpbrowser.com")
    parser.add_argument("--bucket", default="snp-browser")
    parser.add_argument("--receipt", type=Path, required=True)
    run_publication(parser.parse_args(), Path(__file__).resolve().parents[2])


if __name__ == "__main__":
    main()
