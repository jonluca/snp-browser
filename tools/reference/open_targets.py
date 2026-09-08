#!/usr/bin/env python3
"""Prepare a fixed public Open Targets fine-mapping pack; never accepts personal variants."""

import argparse
import concurrent.futures
import hashlib
import io
import json
import math
import re
import shutil
import tempfile
import threading
import urllib.request
from pathlib import Path
from urllib.parse import quote

import build
from compact import compact_catalog

RELEASE = "26.06"
BASE_URL = f"https://ftp.ebi.ac.uk/pub/databases/opentargets/platform/{RELEASE}/output"
# Independent of any uploaded DNA. Exact disease definitions are retained below.
STUDIES = (
    "FINNGEN_R12_G6_ALZHEIMER",
    "FINNGEN_R12_G6_PARKINSON",
    "FINNGEN_R12_K11_CD_STRICT2",
)
METADATA = {
    "name": "Open Targets — FinnGen neurological and Crohn disease fine-mapping",
    "description": "Public GWAS credible-set variants, posterior probabilities, study effects, and ancestry context.",
    "homepage": "https://platform.opentargets.org/",
    "license": "Creative Commons CC0 1.0",
    "licenseUrl": "https://platform-docs.opentargets.org/licence",
    "attribution": "Open Targets Platform and FinnGen R12. Converted public fine-mapping data; cite the linked source studies. Posterior inclusion probability is a model's causal-variant probability within a study, not an individual's disease probability. Studies and participants may overlap with other reference sources.",
    "sourceRelease": f"Open Targets Platform {RELEASE}; FinnGen R12",
}
CREDIBLE_COLUMNS = (
    "studyLocusId", "studyId", "variantId", "chromosome", "position", "region", "beta",
    "zScore", "pValueMantissa", "pValueExponent", "effectAlleleFrequencyFromSource", "standardError",
    "subStudyDescription", "qualityControls", "finemappingMethod", "credibleSetIndex",
    "credibleSetlog10BF", "purityMeanR2", "purityMinR2", "locusStart", "locusEnd", "sampleSize",
    "locus", "confidence", "studyType", "isTransQtl",
)


def stable_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def number(value, name, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    if minimum is not None and value < minimum or maximum is not None and value > maximum:
        raise ValueError(f"{name} is outside its valid range")
    return value


def variant_location(variant_id):
    # Official Open Targets identifiers use GRCh38, 1-based coordinates, REF, ALT.
    # Hashed OTVAR identities cannot supply sequences and are explicitly rejected.
    match = re.fullmatch(r"([1-9]|1[0-9]|2[0-2]|X|Y|MT)_([1-9][0-9]*)_([ACGT]+)_([ACGT]+)", variant_id or "")
    if not match:
        raise ValueError("Expected an explicit GRCh38 Open Targets sequence variant: " + str(variant_id))
    chromosome, position, ref, alt = match.groups()
    if ref == alt:
        raise ValueError("Reference and alternate allele cannot be identical")
    return {"assembly": "GRCh38", "chromosome": chromosome, "position": int(position), "ref": ref, "alt": alt}


def annotations_for_set(credible, study):
    """One row per unique study/credible-set/95%-member; no disease-risk inference."""
    if (credible.get("studyId") != study.get("studyId") or study.get("studyType") != "gwas"
            or credible.get("studyType") not in (None, "gwas")):
        raise ValueError("Credible set and GWAS study identity must agree")
    set_id = credible.get("studyLocusId")
    if not isinstance(set_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", set_id):
        raise ValueError("Credible set must have an explicit safe identifier")
    if not study.get("diseaseIds") or not study.get("traitFromSource"):
        raise ValueError("A mapped disease and source trait are required")
    members = credible.get("locus")
    if not isinstance(members, list) or not members:
        raise ValueError("Credible set has no supplied members")
    unique = {}
    for member in members:
        if member.get("is95CredibleSet") is not True:
            continue
        probability = number(member.get("posteriorProbability"), "posteriorProbability", 0, 1)
        variant_id = member.get("variantId")
        location = variant_location(variant_id)
        for field in ("beta", "standardError", "logBF", "r2Overall", "pValueMantissa"):
            if member.get(field) is not None:
                number(member[field], field, 0 if field in ("standardError", "r2Overall", "pValueMantissa") else None,
                       1 if field == "r2Overall" else None)
        if member.get("pValueExponent") is not None and type(member["pValueExponent"]) is not int:
            raise ValueError("pValueExponent must be an integer")
        encoded = stable_json(member)
        if variant_id in unique:
            if unique[variant_id][0] != encoded:
                raise ValueError("Conflicting fine-mapping entries for " + variant_id)
            continue
        unique[variant_id] = (encoded, location, member, probability)
    if not unique:
        raise ValueError("Credible set has no 95% members")
    # Reject an incomplete member export, but tolerate floating-point rounding.
    total = sum(value[3] for value in unique.values())
    if not 0.95 - 1e-6 <= total <= 1 + 1e-6:
        raise ValueError("95% credible-set probability total is outside [0.95, 1]")
    metadata = {key: value for key, value in credible.items() if key not in ("locus", "ldSet")}
    study_id = study["studyId"]
    title = study["traitFromSource"] + " — fine-mapped GWAS variant"
    citations = [{"label": "Open Targets study " + study_id,
                  "url": "https://platform.opentargets.org/study/" + quote(study_id, safe="")},
                 {"label": "Open Targets Platform (Buniello et al., 2025)",
                  "url": "https://academic.oup.com/nar/article/53/D1/D1467/7917960"}]
    pubmed = str(study.get("pubmedId") or "")
    if pubmed.isdigit():
        citations.append({"label": "Source study (PubMed " + pubmed + ")",
                          "url": "https://pubmed.ncbi.nlm.nih.gov/" + pubmed + "/"})
    for variant_id, (encoded, location, member, probability) in sorted(unique.items()):
        fields = {
            "studyId": study_id,
            "studyLocusId": set_id,
            "variantId": variant_id,
            "disease": study["traitFromSource"],
            "diseaseIds": stable_json(study["diseaseIds"]),
            "posteriorInclusionProbability": probability,
            "probabilityMeaning": "Fine-mapping model probability of this variant being causal for this study signal; not personal disease risk.",
            "finemappingMethod": credible.get("finemappingMethod"),
            "confidence": credible.get("confidence"),
            "reportedBeta": member.get("beta"),
            "reportedStandardError": member.get("standardError"),
            "reportedPValueMantissa": member.get("pValueMantissa"),
            "reportedPValueExponent": member.get("pValueExponent"),
            "effectInterpretation": "Source fine-mapping beta retained without an inferred effect allele, odds ratio, or personal risk direction.",
            "discoverySamples": stable_json(study.get("discoverySamples")),
            "replicationSamples": stable_json(study.get("replicationSamples")),
            "ldPopulationStructure": stable_json(study.get("ldPopulationStructure")),
            "studyMetadata": stable_json(study),
            "credibleSetMetadata": stable_json(metadata),
            "variantFineMapping": encoded,
            "upstreamRelease": RELEASE,
            "evidenceRelationship": "Derived from the named FinnGen R12 study; do not count repeated source studies or overlapping cohorts as independent evidence.",
        }
        yield {
            "id": "opentargets:" + study_id + ":" + set_id + ":" + variant_id,
            "source": "opentargets", "scope": "variant", **location,
            "title": title,
            "summary": "Member of the study's 95% credible set. The supplied posterior probability describes fine-mapping uncertainty, not disease probability or a clinical classification.",
            "url": "https://platform.opentargets.org/credible-set/" + quote(set_id, safe=""),
            "fields": fields, "citations": citations,
            **({"lastEvaluated": study["publicationDate"]} if study.get("publicationDate") else {}),
        }


class DownloadBudget:
    def __init__(self, limit):
        self.limit, self.used, self.lock = limit, 0, threading.Lock()

    def consume(self, count):
        with self.lock:
            if self.used + count > self.limit:
                raise ValueError("Public reference download budget exceeded; no partial pack will be published")
            self.used += count


class RangeFile(io.RawIOBase):
    """Verified HTTP ranges for public Parquet column projection, cached with receipts."""
    def __init__(self, url, cache, budget):
        if not url.startswith(BASE_URL + "/") or not url.endswith(".parquet"):
            raise ValueError("Range access is restricted to the pinned public Open Targets release")
        self.url, self.position, self.budget = url, 0, budget
        self.cache = Path(cache) / hashlib.sha256(url.encode()).hexdigest()
        self.cache.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=60) as response:
            self.size = int(response.headers["Content-Length"])
            self.etag = response.headers.get("ETag")
        if not self.etag or self.etag.startswith("W/"):
            raise ValueError("A strong source identity is required for ranged reads")
        self.receipt = {"url": url, "bytes": self.size, "etag": self.etag, "ranges": []}
        previous = self.cache / "identity.json"
        identity = {key: self.receipt[key] for key in ("url", "bytes", "etag")}
        if previous.exists() and json.loads(previous.read_text()) != identity:
            raise ValueError("Pinned source changed; use a new empty download cache")
        previous.write_text(stable_json(identity) + "\n")

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        if whence not in (0, 1, 2):
            raise ValueError("Invalid seek mode")
        position = offset if whence == 0 else self.position + offset if whence == 1 else self.size + offset
        if position < 0 or position > self.size:
            raise ValueError("Read outside source bounds")
        self.position = position
        return position

    def read(self, count=-1):
        count = self.size - self.position if count < 0 else min(count, self.size - self.position)
        if not count:
            return b""
        start = self.position
        path = self.cache / f"{start}-{count}.bin"
        digest_path = path.with_suffix(".sha256")
        if path.exists() and digest_path.exists():
            data = path.read_bytes()
            if len(data) != count or hashlib.sha256(data).hexdigest() != digest_path.read_text().strip():
                raise ValueError("Cached public source range failed integrity validation")
        else:
            self.budget.consume(count)
            request = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{start + count - 1}", "If-Match": self.etag})
            with urllib.request.urlopen(request, timeout=120) as response:
                expected = f"bytes {start}-{start + count - 1}/{self.size}"
                if response.status != 206 or response.headers.get("Content-Range") != expected or response.headers.get("ETag") != self.etag:
                    raise ValueError("Public source did not honor the pinned byte range")
                data = response.read(count + 1)
            if len(data) != count:
                raise ValueError("Incomplete public source byte range")
            path.write_bytes(data)
            digest_path.write_text(hashlib.sha256(data).hexdigest() + "\n")
        self.receipt["ranges"].append({"start": start, "bytes": count, "sha256": hashlib.sha256(data).hexdigest()})
        self.position += count
        return data


def public_files(dataset):
    url = BASE_URL + "/" + dataset + "/"
    with urllib.request.urlopen(url, timeout=60) as response:
        listing = response.read(1024 * 1024).decode("utf-8")
    filenames = sorted(set(re.findall(r'href="([a-zA-Z0-9._-]+\.parquet)"', listing)))
    if not filenames:
        raise ValueError("Pinned public dataset has no Parquet files: " + dataset)
    return [url + filename for filename in filenames]


def collect(cache, study_file=None, jobs=4, max_download_bytes=768 * 1024 * 1024):
    try:
        import pyarrow.parquet as pq
    except ImportError as error:
        raise RuntimeError("Install pyarrow in an isolated environment for public-data preparation") from error
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    budget = DownloadBudget(max_download_bytes)
    studies = {}
    receipts = []
    for url in public_files("study"):
        if study_file:
            file = Path(study_file)
            source = pq.ParquetFile(file)
            receipts.append({"url": url, "bytes": file.stat().st_size, "sha256": build.sha256_file(file), "localSuppliedCopy": True})
        else:
            remote = RangeFile(url, cache / "ranges", budget)
            source = pq.ParquetFile(remote)
            receipts.append(remote.receipt)
        for batch in source.iter_batches(batch_size=65536, use_threads=False):
            for row in batch.to_pylist():
                if row["studyId"] in STUDIES:
                    if row["studyId"] in studies and studies[row["studyId"]] != row:
                        raise ValueError("Conflicting source study metadata")
                    studies[row["studyId"]] = row
    if set(studies) != set(STUDIES):
        raise ValueError("Missing fixed public studies: " + str(set(STUDIES) - set(studies)))

    def process(url):
        remote = RangeFile(url, cache / "ranges", budget)
        parquet = pq.ParquetFile(remote)
        found = []
        for group in range(parquet.metadata.num_row_groups):
            ids = parquet.read_row_group(group, columns=["studyId"], use_threads=False).column(0).to_pylist()
            indexes = [index for index, study_id in enumerate(ids) if study_id in studies]
            if indexes:
                table = parquet.read_row_group(group, columns=list(CREDIBLE_COLUMNS), use_threads=False)
                found.extend(table.take(indexes).to_pylist())
        return found, remote.receipt

    credible_sets = []
    urls = public_files("credible_set")
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        for completed, (found, receipt) in enumerate(pool.map(process, urls), 1):
            credible_sets.extend(found)
            receipts.append(receipt)
            if completed % 20 == 0 or completed == len(urls):
                print(f"Scanned {completed}/{len(urls)} public partitions; {len(credible_sets)} selected sets; {budget.used:,} new bytes", flush=True)
    if not credible_sets:
        raise ValueError("No credible sets found for the fixed public studies")
    credible_sets.sort(key=lambda row: (row["studyId"], row["studyLocusId"]))
    selected = {"release": RELEASE, "studyIds": list(STUDIES), "studies": studies, "credibleSets": credible_sets}
    selected_path = cache / "selected.json"
    selected_path.write_text(stable_json(selected) + "\n")
    provenance = {"sourceRelease": RELEASE, "studyIds": list(STUDIES), "downloadedBytes": budget.used,
                  "selectedInputSha256": build.sha256_file(selected_path), "sourceFiles": receipts,
                  "selection": "Complete 95% credible-set members from all published partitions for the three fixed FinnGen R12 study IDs; no personal variant requests.",
                  "projection": "Public Parquet column projection excludes the separate ldSet linkage table. All supplied locus-member statistics, study metadata, and selected credible-set metadata are retained.",
                  "excluded": "All other studies; 99%-only members; molecular QTLs. No L2G aggregate target-disease score is imported.",
                  "preparedAt": build.now(), "pyarrowVersion": __import__("pyarrow").__version__}
    (cache / "selection-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return selected, provenance


def prepare(selected, provenance, output, version):
    if selected.get("release") != RELEASE or set(selected.get("studyIds", [])) != set(STUDIES):
        raise ValueError("Selected input does not identify the pinned release and fixed studies")
    records = []
    seen_sets = {}
    for row in selected["credibleSets"]:
        key = (row["studyId"], row["studyLocusId"])
        identity = stable_json(row)
        if key in seen_sets:
            if seen_sets[key] != identity:
                raise ValueError("Conflicting repeated credible set")
            continue
        seen_sets[key] = identity
        records.extend(annotations_for_set(row, selected["studies"][row["studyId"]]))
    if {key[0] for key in seen_sets} != set(STUDIES):
        raise ValueError("Each selected study must have credible sets")
    coverage = (f"Open Targets {RELEASE}, FinnGen R12: all published 95% credible-set members for G6_ALZHEIMER (Alzheimer disease), G6_PARKINSON (Parkinson disease), and K11_CD_STRICT2 (strict Crohn disease). "
                f"{len(seen_sets)} credible sets, {len(records)} variant-membership annotations. GRCh38 only; study variant context, not personal risk. All other studies, 99%-only members, molQTLs and LD-neighbour tables excluded.")
    # Extend the builder's allowed source set in this process only. Browser registration
    # is separate; this does not mutate the shared adapter registry or its files.
    previous_sources = build.SOURCES
    try:
        build.SOURCES = (*previous_sources, "opentargets")
        with tempfile.TemporaryDirectory(prefix="snp-opentargets-build-") as temporary:
            root = Path(temporary)
            manifest = build.build_pack(iter(records), root, "opentargets", version, coverage, METADATA, pack_id="opentargets")
            directory = root / "opentargets" / version
            enriched = {**provenance, "credibleSetCount": len(seen_sets), "annotationCount": len(records),
                        "uniqueVariantCount": len({r["fields"]["variantId"] for r in records}),
                        "probabilityInterpretation": "PIP is a model probability within a GWAS signal; never an individual's disease probability.",
                        "effectAlleleInterpretation": "No effect allele or absolute risk is inferred. Exact reference/alternate sequences describe identity only; records retain variant scope.",
                        "overlapPolicy": "One membership per study/credible-set/variant; duplicate source sets are collapsed. Evidence across studies/packs is not assumed independent."}
            (directory / "provenance.json").write_text(json.dumps(enriched, indent=2) + "\n")
            (directory / "LICENSE.txt").write_text("Open Targets Platform data: CC0 1.0\nhttps://platform-docs.opentargets.org/licence\nhttps://creativecommons.org/publicdomain/zero/1.0/\n\n" + METADATA["attribution"] + "\n")
            (root / "manifest.json").write_text(json.dumps(manifest))
            compacted = compact_catalog(root / "manifest.json", suffix="-gzip-v1", level=9, jobs=1)
            destination = Path(output) / "opentargets" / compacted["packs"][0]["version"]
            if destination.exists():
                raise ValueError("Immutable output already exists: " + str(destination))
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=".opentargets-publish-", dir=destination.parent) as publishing:
                staged = Path(publishing) / "pack"
                shutil.copytree(root / "opentargets" / compacted["packs"][0]["version"], staged)
                if destination.exists():
                    raise ValueError("Immutable output appeared during preparation: " + str(destination))
                staged.rename(destination)
            print(stable_json({"manifest": str(destination / "manifest.json"), "records": len(records),
                               "downloadBytes": sum(s["bytes"] for s in compacted["packs"][0]["shards"])}))
            return compacted
    finally:
        build.SOURCES = previous_sources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path("public/references"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--study-file", type=Path, help="Already downloaded official release study Parquet")
    parser.add_argument("--jobs", type=int, default=4, choices=range(1, 9))
    parser.add_argument("--max-download-mib", type=int, default=768)
    parser.add_argument("--reuse-selected", action="store_true", help="Rebuild the exact verified selected public snapshot without network")
    args = parser.parse_args()
    if args.reuse_selected:
        provenance = json.loads((args.cache / "selection-provenance.json").read_text())
        path = args.cache / "selected.json"
        if build.sha256_file(path) != provenance["selectedInputSha256"]:
            raise ValueError("Selected public input failed SHA-256 verification")
        selected = json.loads(path.read_text())
    else:
        selected, provenance = collect(args.cache, args.study_file, args.jobs, args.max_download_mib * 1024 * 1024)
    prepare(selected, provenance, args.output, args.version)


if __name__ == "__main__":
    main()
