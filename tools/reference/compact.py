#!/usr/bin/env python3
"""Losslessly gzip an existing local reference catalog into immutable versions."""

import argparse
import concurrent.futures
import copy
import gzip
import hashlib
import json
import re
import shutil
import sys
import tempfile
import zlib
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, urlunsplit

from build import now, sha256_file

MAX_SHARD_BYTES = 128 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024


def checked_identity(byte_count, digest):
    if type(byte_count) is not int or not 0 < byte_count <= MAX_SHARD_BYTES:
        raise ValueError("Shard bytes must be a positive integer at most 128 MiB")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Shard SHA-256 must be 64 lowercase hexadecimal characters")


def verify_gzip(path, byte_count, expected_hash):
    """Bounded decoding with exact identity and one-member gzip validation."""
    checked_identity(byte_count, expected_hash)
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    digest = hashlib.sha256()
    total = 0
    try:
        with Path(path).open("rb") as stream:
            while chunk := stream.read(CHUNK_BYTES):
                if decoder.eof:
                    raise ValueError("Expected exactly one gzip member with no trailing bytes")
                pending = chunk
                while pending:
                    data = decoder.decompress(pending, min(CHUNK_BYTES, byte_count - total + 1))
                    total += len(data)
                    if total > byte_count:
                        raise ValueError("Decoded shard exceeds its declared size")
                    digest.update(data)
                    if decoder.unused_data:
                        raise ValueError("Expected exactly one gzip member with no trailing bytes")
                    pending = decoder.unconsumed_tail
    except zlib.error as error:
        raise ValueError("Invalid gzip shard: " + str(error)) from error
    if not decoder.eof:
        raise ValueError("Truncated gzip shard")
    if total != byte_count:
        raise ValueError("Decoded shard size mismatch")
    if digest.hexdigest() != expected_hash:
        raise ValueError("Decoded shard SHA-256 mismatch")


def compress_shard(path, target, shard, level):
    checked_identity(shard["bytes"], shard["sha256"])
    if not path.is_file() or path.stat().st_size != shard["bytes"]:
        raise ValueError("Missing or incorrectly sized original shard: " + str(path))
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as incoming, target.open("wb") as raw:
        # One member, no stored filename, no clock-dependent timestamp.
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=level, mtime=0) as outgoing:
            while chunk := incoming.read(CHUNK_BYTES):
                total += len(chunk)
                if total > shard["bytes"]:
                    raise ValueError("Original shard grew while reading: " + str(path))
                digest.update(chunk)
                outgoing.write(chunk)
    if total != shard["bytes"] or digest.hexdigest() != shard["sha256"]:
        raise ValueError("Original shard SHA-256 or size mismatch: " + str(path))
    verify_gzip(target, shard["bytes"], shard["sha256"])
    result = copy.deepcopy(shard)
    result["bytes"] = target.stat().st_size
    result["sha256"] = sha256_file(target)
    checked_identity(result["bytes"], result["sha256"])
    result["compression"] = {"format": "gzip", "uncompressedBytes": shard["bytes"],
                             "uncompressedSha256": shard["sha256"]}
    return result


def compact_catalog(manifest_path, suffix="-gzip-v1", level=6, jobs=4, output_manifest=None):
    if level not in range(1, 10) or jobs not in range(1, 9):
        raise ValueError("Compression level must be 1–9 and jobs must be 1–8")
    if not suffix or not re.fullmatch(r"[a-zA-Z0-9._-]+", suffix):
        raise ValueError("Provide a nonempty version suffix using letters, digits, dots, underscores or hyphens")
    manifest_path = Path(manifest_path)
    output_manifest = Path(output_manifest) if output_manifest else manifest_path
    root = manifest_path.parent
    manifest_bytes = manifest_path.read_bytes()
    catalog = json.loads(manifest_bytes)
    if catalog.get("schemaVersion") != 1 or not catalog.get("packs"):
        raise ValueError("Expected a nonempty schemaVersion 1 catalog")
    built_at = now()
    plans = []
    ids = set()
    for pack in catalog["packs"]:
        pack_id, version = pack["id"], pack["version"]
        if any(not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", value) for value in (pack_id, version)) or pack_id in ids:
            raise ValueError("Invalid or duplicate pack identity")
        ids.add(pack_id)
        if not pack.get("shards"):
            raise ValueError("Pack has no shards: " + pack_id)
        if any(shard.get("compression") is not None for shard in pack["shards"]):
            raise ValueError("Catalog already contains compressed shards; use its original uncompressed catalog")
        destination = root / pack_id / (version + suffix)
        if destination.exists():
            raise ValueError("Immutable version already exists; use a new unused --suffix: " + str(destination))
        old_directory = root / pack_id / version
        new_pack = copy.deepcopy(pack)
        new_pack.update({"version": version + suffix, "builtAt": built_at})
        shard_plans = []
        filenames = set()
        for shard in pack["shards"]:
            checked_identity(shard["bytes"], shard["sha256"])
            url = urlsplit(shard["url"])
            parts = PurePosixPath(url.path).parts
            if len(parts) < 3 or parts[-3:-1] != (pack_id, version) or url.query or url.fragment:
                raise ValueError("Shard URL must identify its immutable pack/version directory")
            filename = parts[-1]
            if filename in (".", "..") or filename in filenames or not filename.endswith(".sqlite"):
                raise ValueError("Expected distinct .sqlite shard filenames")
            filenames.add(filename)
            path = old_directory / filename
            if not path.is_file() or path.stat().st_size != shard["bytes"]:
                raise ValueError("Missing or incorrectly sized original shard: " + str(path))
            # Vite preview treats .gz as HTTP Content-Encoding and Fetch then
            # expands it before our encoded checksum/cache verification. A
            # .gzip suffix keeps the bytes opaque to that static-host behavior.
            new_path = PurePosixPath(url.path).parent.parent / new_pack["version"] / (filename + ".gzip")
            new_url = urlunsplit((url.scheme, url.netloc, str(new_path), "", ""))
            shard_plans.append((path, filename + ".gzip", shard, new_url))
        plans.append((old_directory, destination, new_pack, shard_plans, filenames))

    staging = Path(tempfile.mkdtemp(prefix=".reference-compress-", dir=root))
    try:
        futures = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
            for old_directory, destination, new_pack, shard_plans, filenames in plans:
                directory = staging / new_pack["id"] / new_pack["version"]
                directory.mkdir(parents=True)
                for index, (path, filename, shard, new_url) in enumerate(shard_plans):
                    future = pool.submit(compress_shard, path, directory / filename, shard, level)
                    futures.append((future, new_pack, index, new_url))
            for finished, (future, new_pack, index, new_url) in enumerate(futures, 1):
                result = future.result()
                result["url"] = new_url
                new_pack["shards"][index] = result
                if finished % 10 == 0 or finished == len(futures):
                    print("Verified %s/%s compressed shards" % (finished, len(futures)), flush=True)

        for old_directory, destination, new_pack, shard_plans, filenames in plans:
            directory = staging / new_pack["id"] / new_pack["version"]
            for file in old_directory.iterdir():
                if file.name == "manifest.json" or file.name in filenames:
                    continue
                if file.is_dir():
                    shutil.copytree(file, directory / file.name)
                else:
                    shutil.copy2(file, directory / file.name)
            provenance_path = directory / "provenance.json"
            provenance = json.loads(provenance_path.read_text()) if provenance_path.exists() else {}
            provenance["assetCompression"] = {"format": "gzip", "level": level, "preparedAt": built_at,
                "sourcePackVersion": old_directory.name,
                "sourceCatalogSha256": hashlib.sha256(manifest_bytes).hexdigest(),
                "pythonVersion": sys.version.split()[0], "zlibVersion": zlib.ZLIB_RUNTIME_VERSION,
                "verification": "Every input SQLite hash and every fully inflated output hash match the original manifest; encoded hashes recorded separately."}
            provenance_path.write_text(json.dumps(provenance, indent=2) + "\n")
            (directory / "manifest.json").write_text(json.dumps({"schemaVersion": 1, "createdAt": built_at,
                                                                  "packs": [new_pack]}, indent=2) + "\n")

        result = {**catalog, "createdAt": built_at, "packs": [plan[2] for plan in plans]}
        # Validate and serialize everything before any release is made visible.
        serialized = json.dumps(result, indent=2) + "\n"
        output_manifest.parent.mkdir(parents=True, exist_ok=True)
        for old_directory, destination, new_pack, shard_plans, filenames in plans:
            if destination.exists():
                raise ValueError("Immutable destination appeared during compression: " + str(destination))
        for old_directory, destination, new_pack, shard_plans, filenames in plans:
            destination.parent.mkdir(parents=True, exist_ok=True)
            (staging / new_pack["id"] / new_pack["version"]).rename(destination)
        with tempfile.NamedTemporaryFile(mode="w", prefix=".reference-catalog-", suffix=".tmp",
                                         dir=output_manifest.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(serialized)
        try:
            temporary.replace(output_manifest)
        finally:
            temporary.unlink(missing_ok=True)
        return result
    finally:
        shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", help="Existing local catalog manifest; its parent is the reference asset root")
    parser.add_argument("--suffix", default="-gzip-v1", help="New immutable version suffix (default: -gzip-v1)")
    parser.add_argument("--level", type=int, default=6)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--output-manifest", help="Defaults to atomically replacing the input catalog")
    args = parser.parse_args()
    catalog = compact_catalog(args.manifest, args.suffix, args.level, args.jobs, args.output_manifest)
    for pack in catalog["packs"]:
        print("%s: %s records; %s -> %s bytes" % (pack["id"], pack["recordCount"],
              sum(s["compression"]["uncompressedBytes"] for s in pack["shards"]), sum(s["bytes"] for s in pack["shards"])))


if __name__ == "__main__":
    main()
