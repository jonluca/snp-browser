#!/usr/bin/env python3
"""Prepare public reference assets; no user-file arguments or user variants."""

import argparse
import csv
import gzip
import io
import json
import subprocess
import urllib.request
import zipfile
from pathlib import Path
from contextlib import nullcontext
from urllib.parse import urlsplit

from adapters import read_annotations, open_text
from build import build_pack, download, merge_manifests, now, sha256_file, ordered_annotations
from compact import verify_gzip

PUBLIC_IDS = ("rs429358", "rs7412", "rs4244285", "rs1799853", "rs4149056")
CLINVAR_URL = "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz"
GNOMAD_URL = "https://gnomad-public-us-east-1.s3.amazonaws.com/release/4.1.1/vcf/exomes/gnomad.exomes.v4.1.1.sites.chr22.vcf.bgz"
GWAS_URL = "https://ftp.ebi.ac.uk/pub/databases/gwas/releases/latest/gwas-catalog-associations_ontology-annotated-full.zip"
CLINPGX_URL = "https://api.clinpgx.org/v1/download/file/data/clinicalAnnotations.zip"
CPIC_URL = "https://api.cpicpgx.org/v1/pair_view?order=pairid"


def source_release(source, inputs, cache, urls):
    """Use actual file headers/archive timestamps or retained fetch receipts."""
    if source == "gnomad":
        return "4.1.1 exomes"
    if source == "clinvar":
        with open_text(inputs[0]) as stream:
            for line in stream:
                if line.startswith("##fileDate="):
                    return "VCF " + line.strip().split("=", 1)[1]
                if line.startswith("#CHROM"):
                    break
    if source == "gwas":
        with zipfile.ZipFile(cache / "gwas.zip") as archive:
            tables = [item for item in archive.infolist() if item.filename.endswith((".tsv", ".txt")) and "__MACOSX" not in item.filename]
            if len(tables) == 1:
                return "Curated association file %04d-%02d-%02d" % tables[0].date_time[:3]
    if source == "clinpgx":
        with zipfile.ZipFile(cache / "clinicalAnnotations.zip") as archive:
            dates = [name.removeprefix("CREATED_") for name in archive.namelist() if name.startswith("CREATED_")]
            if len(dates) == 1:
                return "Clinical annotation metadata archive " + dates[0]
    if source in ("cpic", "dbsnp", "ensembl"):
        dates = set()
        dated_urls = set()
        for receipt in cache.glob("*.download.json"):
            row = json.loads(receipt.read_text())
            if row.get("url") in urls and row.get("fetchedAt"):
                dates.add(row["fetchedAt"][:10])
                dated_urls.add(row["url"])
        if len(dates) == 1 and dated_urls == set(urls):
            label = {"cpic": "Public pair_view snapshot", "dbsnp": "RefSNP API snapshot", "ensembl": "Public VEP API snapshot"}[source]
            return label + " " + next(iter(dates))
    return None


def get_file(url, path):
    if path.exists():
        return
    try:
        download(url, path)
    except urllib.error.HTTPError as error:
        if error.code != 403:
            raise
        # Some public hosts reject urllib's HTTP transport while their documented
        # public download works with curl. No auth, cookies, or challenge bypass.
        subprocess.run(["curl", "--fail", "--location", "--max-time", "300", "--output", str(path) + ".part", url], check=True)
        Path(str(path) + ".part").replace(path)
        path.with_name(path.name + ".download.json").write_text(json.dumps({
            "url": url, "fetchedAt": now(), "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
        }, indent=2) + "\n")


def vcf_prefix(url, path, count):
    if path.exists():
        return
    temporary = path.with_name(path.name + ".part")
    try:
        with urllib.request.urlopen(url, timeout=120) as response, gzip.GzipFile(fileobj=response) as compressed, io.TextIOWrapper(compressed) as source, temporary.open("w") as out:
            records = 0
            for line in source:
                out.write(line)
                if line.strip() and not line.startswith("#"):
                    records += 1
                if records >= count:
                    break
        if records != count:
            raise ValueError("Public VCF ended before the requested sample size")
        temporary.replace(path)
        path.with_name(path.name + ".download.json").write_text(json.dumps({
            "url": url, "fetchedAt": now(), "sha256": sha256_file(path),
            "bytes": path.stat().st_size, "selection": "First %s public VCF records" % count,
        }, indent=2) + "\n")
    finally:
        temporary.unlink(missing_ok=True)
    path.with_name(path.name + ".download.json").write_text(json.dumps({
        "url": url, "fetchedAt": now(), "sha256": sha256_file(path),
        "bytes": path.stat().st_size, "selection": "first %d VCF records" % count,
    }, indent=2) + "\n")


def extract_member(archive, member, target):
    # Exact member names are used; archive paths are never extracted to disk.
    with zipfile.ZipFile(archive) as source, source.open(member) as incoming, target.open("wb") as outgoing:
        import shutil
        shutil.copyfileobj(incoming, outgoing)


def validate_existing_pack(manifest_path, source, version):
    """A delivered manifest alone is not a reusable local binary release."""
    manifest_path = Path(manifest_path)
    try:
        manifest = json.loads(manifest_path.read_text())
        if not isinstance(manifest, dict):
            raise ValueError("Expected a versioned source manifest")
        packs = manifest.get("packs", [])
        if manifest.get("schemaVersion") != 1 or not isinstance(packs, list) or len(packs) != 1:
            raise ValueError("Expected one versioned source pack")
        pack = packs[0]
        if not isinstance(pack, dict) or pack.get("source") != source or pack.get("id") != source or pack.get("version") != version or not isinstance(pack.get("shards"), list) or not pack["shards"]:
            raise ValueError("Source/version metadata or shard list is invalid")
        for shard in pack["shards"]:
            filename = Path(urlsplit(shard["url"]).path).name
            if not filename or filename in (".", ".."):
                raise ValueError("Invalid shard filename")
            path = manifest_path.parent / filename
            if not path.is_file():
                raise ValueError("Missing shard " + filename)
            if path.stat().st_size != shard["bytes"]:
                raise ValueError("Shard size mismatch: " + filename)
            if sha256_file(path) != shard["sha256"]:
                raise ValueError("Shard SHA-256 mismatch: " + filename)
            compression = shard.get("compression")
            if compression is not None:
                if not isinstance(compression, dict) or compression.get("format") != "gzip":
                    raise ValueError("Unsupported shard compression")
                verify_gzip(path, compression["uncompressedBytes"], compression["uncompressedSha256"])
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ValueError("Cannot reuse incomplete or invalid reference pack at %s: %s. "
                         "Keep this version immutable and prepare with a new unused --version." % (manifest_path, error)) from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="public/references")
    parser.add_argument("--cache", default="tools/reference/.cache")
    parser.add_argument("--version", required=True)
    parser.add_argument("--sources", nargs="+", default=["clinvar", "dbsnp", "gnomad", "gwas", "ensembl", "clinpgx", "cpic"])
    parser.add_argument("--full-gwas", action="store_true", help="Build all mapped curated associations; otherwise first 200 rows")
    parser.add_argument("--full-clinvar", action="store_true", help="Build the complete GRCh38 precise-location VCF; otherwise first 200 rows")
    parser.add_argument("--max-shard-mib", type=int, default=64)
    args = parser.parse_args()
    cache, output = Path(args.cache), Path(args.output)
    cache.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(Path(__file__).with_name("sources.json").read_text())
    manifests = []
    for source in args.sources:
        existing = output / source / args.version / "manifest.json"
        if existing.exists():
            validate_existing_pack(existing, source, args.version)
            manifests.append(existing)
            continue
        build = None
        urls = []
        inputs = []
        if source in ("dbsnp", "ensembl"):
            for rsid in PUBLIC_IDS:
                url = ("https://api.ncbi.nlm.nih.gov/variation/v0/refsnp/" + rsid[2:]) if source == "dbsnp" else ("https://rest.ensembl.org/vep/human/id/" + rsid + "?content-type=application/json")
                path = cache / (source + "-" + rsid + ".json")
                get_file(url, path)
                inputs.append(path)
                urls.append(url)
            fmt = "json"
            coverage = "Sample: five fixed public reference identifiers (" + ", ".join(PUBLIC_IDS) + "). Not a complete release."
        elif source in ("clinvar", "gnomad"):
            url = CLINVAR_URL if source == "clinvar" else GNOMAD_URL
            urls = [url]
            full = source == "clinvar" and args.full_clinvar
            path = cache / (source + ("-full.vcf.gz" if full else "-sample.vcf"))
            if full:
                get_file(url, path)
            else:
                vcf_prefix(url, path, 200 if source == "clinvar" else 100)
            inputs = [path]
            fmt, build = "vcf", "GRCh38"
            coverage = ("Complete supplied ClinVar GRCh38 VCF: precise-location variants only; excludes variants absent from the source VCF.") if full else ("Sample: first %s records of %s. GRCh38; not genome-wide coverage." % (200 if source == "clinvar" else 100, "ClinVar VCF" if source == "clinvar" else "gnomAD 4.1.1 exomes chromosome 22 VCF"))
        elif source == "gwas":
            archive = cache / "gwas.zip"
            get_file(GWAS_URL, archive)
            urls = [GWAS_URL]
            with zipfile.ZipFile(archive) as z:
                members = [n for n in z.namelist() if n.endswith((".tsv", ".txt")) and "__MACOSX" not in n]
            if len(members) != 1:
                raise ValueError("Expected one association table in GWAS archive: " + repr(members))
            path = cache / "gwas.tsv"
            extract_member(archive, members[0], path)
            if not args.full_gwas:
                sample = cache / "gwas-sample.tsv"
                with path.open() as incoming, sample.open("w") as outgoing:
                    for i, line in enumerate(incoming):
                        outgoing.write(line)
                        if i == 200:
                            break
                path = sample
            inputs, fmt = [path], "tsv"
            # Do not infer assembly from an unversioned endpoint. The source
            # filename eXX release can be reviewed and --assembly supplied to
            # build.py for a separately verified, pinned release.
            coverage = ("Complete supplied curated association table, records with rsIDs; " if args.full_gwas else "Sample: first 200 rows of curated association table; ") + members[0] + ". Variant context only; reported risk alleles are not assumed reference-forward. Assembly not inferred."
        elif source == "clinpgx":
            archive = cache / "clinicalAnnotations.zip"
            get_file(CLINPGX_URL, archive)
            urls = [CLINPGX_URL]
            path = cache / "clinical_annotations.tsv"
            extract_member(archive, "clinical_annotations.tsv", path)
            with zipfile.ZipFile(archive) as z:
                created = ", ".join(n for n in z.namelist() if n.startswith("CREATED_"))
                license_text = z.read("LICENSE.txt").decode()
            (cache / "clinpgx-LICENSE.txt").write_text(license_text)
            inputs, fmt = [path], "tsv"
            coverage = "Complete clinical annotation metadata table from " + created + ". Genotype-specific allele text and full evidence tables are not imported. No individual drug response inferred."
        elif source == "cpic":
            path = cache / "cpic-pairs.json"
            # Explicit paginated public endpoint; no undocumented API row cap is
            # assumed. One query page at a time, fixed gene–drug reference scope.
            rows, offset = [], 0
            while True:
                url = CPIC_URL + "&limit=500&offset=" + str(offset)
                page = cache / ("cpic-page-%d.json" % offset)
                get_file(url, page)
                current = json.loads(page.read_text())
                rows.extend(current)
                urls.append(url)
                if len(current) < 500:
                    break
                offset += 500
            path.write_text(json.dumps(rows) + "\n")
            inputs, fmt = [path], "json"
            coverage = "Complete paginated public CPIC pair_view gene–drug reference metadata at fetch time. Does not call diplotypes or apply prescribing rules."
        else:
            raise ValueError("Unknown source: " + source)

        def records():
            for path in inputs:
                yield from read_annotations(source, path, fmt, build)
        upstream_release = source_release(source, inputs, cache, urls)
        if upstream_release:
            metadata[source]["sourceRelease"] = upstream_release
        context = ordered_annotations(records(), output) if source == "gwas" else nullcontext(records())
        with context as prepared:
            result = build_pack(prepared, output, source, args.version, coverage, metadata[source], args.max_shard_mib * 1024 * 1024)
        destination = output / source / args.version
        download_metadata = []
        for receipt in cache.glob("*.download.json"):
            receipt_data = json.loads(receipt.read_text())
            if receipt_data.get("url") in urls:
                download_metadata.append(receipt_data)
        provenance = {"preparedAt": now(), "urls": urls, "coverage": coverage,
                      "sourceRelease": upstream_release,
                      "downloads": download_metadata,
                      "cacheNote": "Reused cached raw files retain their original receipt; absent receipts mean original fetch time is unavailable.",
                      "inputs": [{"name": p.name, "bytes": p.stat().st_size, "sha256": sha256_file(p)} for p in inputs]}
        (destination / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
        if source == "clinpgx":
            (destination / "LICENSE.txt").write_text(license_text)
        manifests.append(destination / "manifest.json")
        print(source, result["packs"][0]["recordCount"], "records", flush=True)
    merge_manifests(manifests, output / "manifest.json")


if __name__ == "__main__":
    main()
