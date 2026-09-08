#!/usr/bin/env python3
"""Build static SQLite reference packs using only Python's standard library."""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from contextlib import contextmanager, nullcontext
from pathlib import Path

from adapters import SOURCES, read_annotations
from routing import routing_for_shard

SCHEMA = """
CREATE TABLE annotations (
 id TEXT PRIMARY KEY, rsid TEXT, assembly TEXT, chromosome TEXT, position INTEGER,
 ref TEXT, alt TEXT, gene TEXT, scope TEXT, source TEXT, title TEXT,
 search_text TEXT, payload TEXT
);
CREATE INDEX annotations_rsid ON annotations(rsid COLLATE NOCASE);
CREATE INDEX annotations_position ON annotations(assembly, chromosome, position);
CREATE INDEX annotations_gene ON annotations(gene COLLATE NOCASE);
CREATE TABLE aliases(alias TEXT, rsid TEXT, UNIQUE(alias,rsid));
CREATE INDEX aliases_lookup ON aliases(alias COLLATE NOCASE);
PRAGMA user_version = 1;
"""
INSERT = "INSERT INTO annotations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"


def now():
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    value = datetime.fromtimestamp(int(epoch), timezone.utc) if epoch else datetime.now(timezone.utc)
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def connect(path):
    database = sqlite3.connect(path)
    database.execute("PRAGMA page_size = 4096")
    database.execute("PRAGMA journal_mode = DELETE")
    database.execute("PRAGMA cache_size = -16384")
    database.executescript(SCHEMA)
    database.execute("BEGIN")
    return database


def validate(record, source):
    required = ("id", "source", "scope", "title", "url", "fields")
    if any(key not in record for key in required) or record["source"] != source:
        raise ValueError("Invalid annotation identity/source")
    if record["scope"] not in ("gene", "variant", "allele"):
        raise ValueError("Invalid annotation scope")
    if not record["url"].startswith("https://"):
        raise ValueError("Reference URLs must use HTTPS")
    if record.get("assembly") not in (None, "GRCh37", "GRCh38"):
        raise ValueError("Unsupported genome assembly")
    if record["scope"] == "allele" and not all(record.get(k) for k in ("assembly", "chromosome", "position", "ref", "alt")):
        raise ValueError("Allele-scoped annotation lacks an explicit coordinate or allele")
    if record["scope"] == "gene" and not record.get("gene"):
        raise ValueError("Gene-scoped annotation has no gene")
    if not isinstance(record["fields"], dict) or any(not isinstance(v, (str, int, float, type(None))) for v in record["fields"].values()):
        raise ValueError("Annotation fields must contain scalar values")


@contextmanager
def ordered_annotations(records, directory):
    """Disk-backed grouping prevents common variants spanning an entire pack."""
    Path(directory).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".reference-build-sort-", dir=directory) as temporary:
        database = sqlite3.connect(Path(temporary) / "sort.sqlite")
        try:
            database.execute("PRAGMA journal_mode = OFF")
            database.execute("PRAGMA cache_size = -16384")
            database.execute("PRAGMA temp_store = FILE")
            database.execute("CREATE TABLE records(sort_key TEXT, id TEXT, payload TEXT)")
            count = 0
            for record in records:
                key = record.get("rsid", "").lower()
                if not key:
                    key = "l:" + ":".join(str(record.get(k, "")) for k in ("assembly", "chromosome", "position"))
                database.execute("INSERT INTO records VALUES (?,?,?)", (key, record["id"], json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))))
                count += 1
                if count % 100000 == 0:
                    database.commit()
                    print("Ordering: %s reference annotations" % count, file=sys.stderr)
            database.commit()
            database.execute("CREATE INDEX records_order ON records(sort_key,id)")
            yield (json.loads(row[0]) for row in database.execute("SELECT payload FROM records ORDER BY sort_key,id"))
        finally:
            database.close()


def build_pack(records, output, source, version, coverage, metadata, max_bytes=64 * 1024 * 1024,
               base_url="/references", built_at=None, pack_id=None):
    """Stream records to indexed shards; every finished file fits max_bytes."""
    if max_bytes < 65536:
        raise ValueError("Shard limit must be at least 64 KiB")
    if source not in SOURCES or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", version):
        raise ValueError("Invalid source or version")
    pack_id = pack_id or source
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", pack_id):
        raise ValueError("Invalid pack id")
    if not coverage.strip():
        raise ValueError("An honest coverage description is required")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    relative = Path(pack_id) / version
    destination = output / relative
    if destination.exists():
        raise ValueError("Version already exists; use a new version or explicitly remove your local build: " + str(destination))
    staging = Path(tempfile.mkdtemp(prefix=".reference-build-", dir=output))
    database = None
    dedupe = None
    shards = []
    total = duplicates = 0
    rows_in_shard = 0
    shard_path = None
    built_at = built_at or now()

    def start_shard():
        path = staging / ("part-%05d.sqlite" % (len(shards) + 1))
        return connect(path), path

    def finish_shard():
        database.commit()
        integrity = database.execute("PRAGMA quick_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError("SQLite validation failed: " + integrity)
        database.close()
        size = shard_path.stat().st_size
        if size > max_bytes:
            raise ValueError("Finished shard exceeded its size budget")
        shards.append({"url": base_url.rstrip("/") + "/" + relative.as_posix() + "/" + shard_path.name,
                       "bytes": size, "sha256": sha256_file(shard_path), "records": rows_in_shard,
                       "routing": routing_for_shard(shard_path)})

    try:
        # A disk-backed identity index keeps global de-duplication bounded even
        # for hundreds of millions of records across many shards.
        dedupe = sqlite3.connect(staging / "identities.tmp")
        dedupe.execute("PRAGMA cache_size = -8192")
        dedupe.execute("CREATE TABLE identities(id TEXT PRIMARY KEY, hash TEXT)")
        database, shard_path = start_shard()
        for record in records:
            validate(record, source)
            payload = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
            digest = hashlib.sha256(payload.encode()).hexdigest()
            previous = dedupe.execute("SELECT hash FROM identities WHERE id=?", (record["id"],)).fetchone()
            if previous:
                if previous[0] != digest:
                    raise ValueError("Conflicting records share an id: " + record["id"])
                duplicates += 1
                continue
            search = " ".join(str(record.get(k, "")) for k in ("rsid", "gene", "title", "summary"))
            search += " " + " ".join(str(v) for v in record["fields"].values())
            values = [record.get(k) for k in ("id", "rsid", "assembly", "chromosome", "position", "ref", "alt", "gene", "scope", "source", "title")]
            values += [search, payload]
            while True:
                database.execute("SAVEPOINT record")
                database.execute(INSERT, values)
                if record.get("rsid"):
                    database.executemany("INSERT OR IGNORE INTO aliases VALUES (?,?)",
                                         [(alias, record["rsid"]) for alias in record.get("aliases", [])])
                size = database.execute("PRAGMA page_count").fetchone()[0] * 4096
                if size <= max_bytes:
                    database.execute("RELEASE record")
                    break
                database.execute("ROLLBACK TO record")
                database.execute("RELEASE record")
                if not rows_in_shard:
                    raise ValueError("A single annotation exceeds the shard limit: " + record["id"])
                finish_shard()
                database, shard_path = start_shard()
                rows_in_shard = 0
            dedupe.execute("INSERT INTO identities VALUES (?,?)", (record["id"], digest))
            total += 1
            rows_in_shard += 1
            if total % 10000 == 0:
                database.commit()
                database.execute("BEGIN")
                dedupe.commit()
                print("%s: %s records, %s completed shards" % (source, total, len(shards)), file=sys.stderr)
        if not total:
            raise ValueError("No annotations produced; verify the source format, assembly, and input coverage")
        finish_shard()
        database = None
        dedupe.close()
        dedupe = None
        (staging / "identities.tmp").unlink()
        pack = {key: metadata[key] for key in ("name", "description", "homepage", "license", "licenseUrl", "attribution")}
        pack.update({"id": pack_id, "source": source, "version": version, "builtAt": built_at,
                     "coverage": coverage, "recordCount": total, "shards": shards})
        if metadata.get("sourceRelease"):
            pack["sourceRelease"] = str(metadata["sourceRelease"])
        manifest = {"schemaVersion": 1, "createdAt": built_at, "packs": [pack]}
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (staging / "build-stats.json").write_text(json.dumps({"records": total, "exactDuplicatesSkipped": duplicates,
                                                             "maxShardBytes": max_bytes}, indent=2) + "\n")
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging.rename(destination)
        return manifest
    finally:
        if database:
            database.close()
        if dedupe:
            dedupe.close()
        if staging.exists():
            shutil.rmtree(staging)


def download(url, target, expected_hash=None):
    """Explicit public URLs only. Does not read or transmit any local DNA file."""
    if not url.startswith("https://"):
        raise ValueError("Downloads require an explicit HTTPS source URL")
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".part")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "snp-browser-reference-builder/1"})
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as out:
            shutil.copyfileobj(response, out, 1024 * 1024)
        actual = sha256_file(temporary)
        if expected_hash and actual != expected_hash.lower():
            raise ValueError("Source SHA-256 does not match: " + url)
        temporary.replace(target)
        target.with_name(target.name + ".download.json").write_text(json.dumps({
            "url": url, "fetchedAt": now(), "sha256": actual,
            "bytes": target.stat().st_size,
        }, indent=2) + "\n")
        return actual
    finally:
        temporary.unlink(missing_ok=True)


def merge_manifests(paths, output):
    packs = {}
    for path in paths:
        value = json.loads(Path(path).read_text())
        if value.get("schemaVersion") != 1:
            raise ValueError("Unsupported manifest schema")
        for pack in value["packs"]:
            if pack["id"] in packs:
                raise ValueError("Duplicate pack id in merged manifests: " + pack["id"])
            packs[pack["id"]] = pack
    result = {"schemaVersion": 1, "createdAt": now(), "packs": list(packs.values())}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(output)
    return result


def refresh_routing(manifest_path):
    """Add routing to a per-version manifest without changing SQLite bytes."""
    manifest_path = Path(manifest_path)
    value = json.loads(manifest_path.read_text())
    if any(shard.get("compression") is not None for pack in value["packs"] for shard in pack["shards"]):
        raise ValueError("Compressed shards cannot be opened as SQLite. Refresh routing on the original uncompressed release, then compact into a new version.")
    for pack in value["packs"]:
        for shard in pack["shards"]:
            path = manifest_path.parent / shard["url"].rsplit("/", 1)[-1]
            if path.stat().st_size != shard["bytes"] or sha256_file(path) != shard["sha256"]:
                raise ValueError("Shard changed since manifest creation: " + str(path))
            shard["routing"] = routing_for_shard(path)
    temporary = manifest_path.with_name(manifest_path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(manifest_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="Convert official local files into static reference packs")
    build.add_argument("--source", choices=SOURCES, required=True)
    build.add_argument("--input", action="append", required=True, help="Repeat for multiple files from the same release")
    build.add_argument("--format", choices=("vcf", "tsv", "json"), required=True)
    build.add_argument("--assembly", choices=("GRCh37", "GRCh38"))
    build.add_argument("--version", required=True)
    build.add_argument("--coverage", required=True, help="Describe the exact release/subset, assemblies, exclusions and completeness")
    build.add_argument("--id", help="Unique pack id, defaults to source; use distinct ids for separate assembly packs")
    build.add_argument("--output", default="public/references")
    build.add_argument("--base-url", default="/references")
    build.add_argument("--max-shard-mib", type=float, default=64)
    build.add_argument("--metadata", default=str(Path(__file__).with_name("sources.json")))
    build.add_argument("--name", help="User-visible name for this assembly/chromosome/coverage pack")
    build.add_argument("--source-release", help="Verified upstream release/version or dated public snapshot, separate from the prepared pack version")
    build.add_argument("--group-by-variant", action="store_true", help="Disk-sort annotations by rsID before sharding; enabled automatically for GWAS")
    build.add_argument("--min-af", type=float, help="Public corpus per-allele AF threshold (gnomAD or VEP-annotated population VCF)")
    build.add_argument("--pass-only", action="store_true", help="Keep only public VCF FILTER=PASS records")
    build.add_argument("--canonical-only", action="store_true", help="Ensembl VCF: keep CANONICAL=YES or MANE transcript consequences")
    get = subparsers.add_parser("download", help="Download a known public reference file")
    get.add_argument("--url", required=True)
    get.add_argument("--output", required=True)
    get.add_argument("--sha256")
    merge = subparsers.add_parser("merge", help="Atomically assemble separately built source manifests")
    merge.add_argument("manifests", nargs="+")
    merge.add_argument("--output", default="public/references/manifest.json")
    route = subparsers.add_parser("refresh-routing", help="Add verified Bloom routing to an existing per-version manifest")
    route.add_argument("manifests", nargs="+")
    args = parser.parse_args()
    if args.command == "download":
        print(download(args.url, args.output, args.sha256))
    elif args.command == "merge":
        result = merge_manifests(args.manifests, args.output)
        print("Wrote %s packs to %s" % (len(result["packs"]), args.output))
    elif args.command == "refresh-routing":
        for path in args.manifests:
            refresh_routing(path)
            print("Updated routing: " + path, flush=True)
    else:
        metadata = json.loads(Path(args.metadata).read_text())[args.source]
        if args.name:
            metadata["name"] = args.name
        if args.source_release:
            metadata["sourceRelease"] = args.source_release
        if args.min_af is not None and (args.source not in ("gnomad", "ensembl") or not 0 <= args.min_af <= 1):
            raise ValueError("--min-af requires gnomAD/Ensembl and a threshold between 0 and 1")
        if args.canonical_only and args.source != "ensembl":
            raise ValueError("--canonical-only is an Ensembl filter")
        def records():
            for path in args.input:
                for record in read_annotations(args.source, path, args.format, args.assembly):
                    values = record["fields"]
                    if args.pass_only and values.get("FILTER") != "PASS":
                        continue
                    if args.min_af is not None:
                        try:
                            freq = float(values.get("AF", "nan"))
                        except ValueError:
                            continue
                        if not math.isfinite(freq) or freq < args.min_af:
                            continue
                    if args.canonical_only and values.get("CANONICAL") != "YES" and not values.get("MANE_SELECT") and not values.get("MANE_PLUS_CLINICAL"):
                        continue
                    yield record
        context = ordered_annotations(records(), args.output) if args.group_by_variant or args.source == "gwas" else nullcontext(records())
        with context as prepared:
            result = build_pack(prepared, args.output, args.source, args.version, args.coverage, metadata,
                                int(args.max_shard_mib * 1024 * 1024), args.base_url, pack_id=args.id)
        destination = Path(args.output) / (args.id or args.source) / args.version
        provenance = {"source": args.source, "format": args.format, "assembly": args.assembly,
                      "sourceRelease": args.source_release,
                      "adapterVersion": 1, "pythonVersion": sys.version.split()[0],
                      "sqliteVersion": sqlite3.sqlite_version,
                      "groupedByVariant": args.group_by_variant or args.source == "gwas",
                      "filters": {"minimumAF": args.min_af, "passOnly": args.pass_only, "canonicalOnly": args.canonical_only},
                      "inputs": [{"name": Path(p).name, "bytes": Path(p).stat().st_size, "sha256": sha256_file(p)} for p in args.input]}
        (destination / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
        print("Built %s records in %s" % (result["packs"][0]["recordCount"], destination))


if __name__ == "__main__":
    main()
