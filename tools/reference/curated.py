#!/usr/bin/env python3
"""Build compact, public curated gene/variant packs; never reads personal DNA."""

import argparse
import collections
import csv
import hashlib
import json
import re
import shutil
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote, urlsplit

import build
from adapters import annotation, fields, text
from compact import compact_catalog

CURATED_SOURCES = ("clingen", "orphanet", "panelapp", "uniprot")
DEFAULT_SOURCES = ("clingen", "orphanet", "uniprot")
GENE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@-]*")
MAX_XML_BYTES = 128 * 1024 * 1024


def checked_url(value, hosts):
    """Source URLs are references, never arbitrary URLs supplied to a downloader."""
    value = text(value)
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or parsed.hostname not in hosts or parsed.username
            or parsed.password or parsed.port not in (None, 443)
            or any(ord(c) < 32 or c.isspace() for c in value)):
        raise ValueError("Unsafe or unexpected source URL")
    return value


def record_stats(stats, key, count=1):
    if stats is not None:
        stats[key] += count


def clingen_csv(stream, stats=None):
    rows = csv.reader(stream)
    header = None
    for row in rows:
        if row and row[0] == "GENE SYMBOL":
            header = row
            break
    required = {"GENE SYMBOL", "GENE ID (HGNC)", "DISEASE LABEL", "DISEASE ID (MONDO)",
                "MOI", "CLASSIFICATION", "ONLINE REPORT"}
    if header is None or not required.issubset(header):
        raise ValueError("Expected ClinGen gene validity CSV header")
    for values in rows:
        if not values or values[0].startswith("++"):
            continue
        if len(values) != len(header):
            raise ValueError("Malformed ClinGen CSV row")
        row = dict(zip(header, values))
        record_stats(stats, "sourceRows")
        gene, hgnc, mondo = (text(row[k]) for k in ("GENE SYMBOL", "GENE ID (HGNC)", "DISEASE ID (MONDO)"))
        if not (GENE.fullmatch(gene) and re.fullmatch(r"HGNC:\d+", hgnc)
                and re.fullmatch(r"MONDO:\d+", mondo) and row["DISEASE LABEL"] and row["ONLINE REPORT"]):
            record_stats(stats, "skippedMissingIdentity")
            continue
        url = checked_url(row["ONLINE REPORT"], {"search.clinicalgenome.org"})
        if not urlsplit(url).path.startswith("/kb/gene-validity/"):
            raise ValueError("Unexpected ClinGen curation URL")
        identity = urlsplit(url).path.rsplit("/", 1)[-1]
        record_stats(stats, "emittedAnnotations")
        yield annotation("clingen", identity, gene + ": " + row["DISEASE LABEL"], url,
                         gene=gene, scope="gene", reviewStatus=row["CLASSIFICATION"],
                         lastEvaluated=row.get("CLASSIFICATION DATE"), fields=fields(row),
                         summary="Gene–disease validity: " + row["CLASSIFICATION"] + ". Inheritance: " + row["MOI"] + ".")


def orphanet_xml(stream, stats=None):
    raw = stream.read(MAX_XML_BYTES + 1)
    if len(raw) > MAX_XML_BYTES:
        raise ValueError("Orphanet XML exceeds the public-table size limit")
    upper = raw.upper()
    doctype = b"<!DOCTYPE" if isinstance(raw, bytes) else "<!DOCTYPE"
    entity = b"<!ENTITY" if isinstance(raw, bytes) else "<!ENTITY"
    if doctype in upper or entity in upper:
        raise ValueError("DTD and entity declarations are not supported in source XML")
    root = ET.fromstring(raw)
    if root.tag != "JDBOR" or root.find("DisorderList") is None:
        raise ValueError("Expected Orphadata JDBOR/DisorderList XML")
    for disorder in root.findall("./DisorderList/Disorder"):
        orpha, disease = text(disorder.findtext("OrphaCode")), text(disorder.findtext("Name"))
        for relation in disorder.findall("./DisorderGeneAssociationList/DisorderGeneAssociation"):
            record_stats(stats, "sourceRows")
            gene_element = relation.find("Gene")
            kind_element = relation.find("DisorderGeneAssociationType")
            gene = text(relation.findtext("./Gene/Symbol"))
            gene_id = gene_element.get("id", "") if gene_element is not None else ""
            kind_id = kind_element.get("id", "") if kind_element is not None else ""
            if not (orpha.isdigit() and disease and GENE.fullmatch(gene) and gene_id.isdigit() and kind_id.isdigit()):
                record_stats(stats, "skippedMissingIdentity")
                continue
            kind = text(relation.findtext("./DisorderGeneAssociationType/Name"))
            status = text(relation.findtext("./DisorderGeneAssociationStatus/Name"))
            validation = text(relation.findtext("SourceOfValidation"))
            row = {"ORPHAcode": "ORPHA:" + orpha, "Disease": disease,
                   "Association type": kind, "Association status": status,
                   "Source of validation": validation, "Orphanet gene ID": gene_id,
                   "Gene name": text(relation.findtext("./Gene/Name")),
                   "Gene type": text(relation.findtext("./Gene/GeneType/Name")),
                   "Disorder group": text(disorder.findtext("./DisorderGroup/Name")),
                   "Disorder type": text(disorder.findtext("./DisorderType/Name"))}
            for ref in relation.findall("./Gene/ExternalReferenceList/ExternalReference"):
                source, value = text(ref.findtext("Source")), text(ref.findtext("Reference"))
                if source and value:
                    key = "Gene reference: " + source
                    row[key] = row[key] + "; " + value if key in row else value
            pmids = list(dict.fromkeys(re.findall(r"\b(\d+)\s*\[PMID\]", validation)))
            record_stats(stats, "emittedAnnotations")
            yield annotation("orphanet", ":".join((orpha, gene_id, kind_id)), gene + ": " + disease,
                             "https://www.orpha.net/en/disease/detail/" + orpha,
                             gene=gene, scope="gene", reviewStatus=status, fields=fields(row),
                             summary=kind + ("; " + status if status else "") + ".",
                             citations=[{"label": "PMID " + pmid, "url": "https://pubmed.ncbi.nlm.nih.gov/" + pmid + "/"} for pmid in pmids])


def panelapp_rows(rows, stats=None, origin="https://panelapp.genomicsengland.co.uk"):
    """Offline adapter for authorised exports; only green genes on v1+ panels.

    PanelApp's software license does not license its data. The preparation CLI
    deliberately does not publish a PanelApp pack under an assumed open license.
    """
    origin = checked_url(origin, {"panelapp.genomicsengland.co.uk", "panelapp-aus.org"}).rstrip("/")
    if urlsplit(origin).path or urlsplit(origin).query or urlsplit(origin).fragment:
        raise ValueError("PanelApp origin must be the official host without a path")
    for row in rows:
        record_stats(stats, "sourceRows")
        gene_data, panel = row.get("gene_data") or {}, row.get("panel") or {}
        gene = text(gene_data.get("gene_symbol"))
        hgnc, panel_id, version = text(gene_data.get("hgnc_id")), text(panel.get("id")), text(panel.get("version"))
        if row.get("entity_type") != "gene" or text(row.get("confidence_level")) not in ("3", "4"):
            record_stats(stats, "skippedNotGreenGene")
            continue
        if not re.fullmatch(r"[1-9]\d*\.\d+", version) or panel.get("status") != "public":
            record_stats(stats, "skippedUnreleasedPanel")
            continue
        if not (GENE.fullmatch(gene) and re.fullmatch(r"HGNC:\d+", hgnc) and panel_id.isdigit() and panel.get("name")):
            record_stats(stats, "skippedMissingIdentity")
            continue
        values = {"HGNC ID": hgnc, "Panel ID": panel_id, "Panel": panel["name"], "Panel version": version,
                  "Confidence level": text(row["confidence_level"]), "Evidence": row.get("evidence"),
                  "Phenotypes": row.get("phenotypes"), "Mode of inheritance": row.get("mode_of_inheritance"),
                  "Mode of pathogenicity": row.get("mode_of_pathogenicity"), "Penetrance": row.get("penetrance"),
                  "Publications": row.get("publications"), "Panel version created": panel.get("version_created")}
        pmids = list(dict.fromkeys(text(p).removeprefix("PMID:").strip() for p in row.get("publications", []) or []))
        pmids = [p for p in pmids if p.isdigit()]
        record_stats(stats, "emittedAnnotations")
        yield annotation("panelapp", ":".join((panel_id, version, hgnc)), gene + ": " + panel["name"],
                         origin + "/panels/" + panel_id + "/gene/" + quote(gene, safe="") + "/",
                         gene=gene, scope="gene", reviewStatus="Green (high evidence)", fields=fields(values),
                         lastEvaluated=panel.get("version_created"),
                         summary="Green gene on public PanelApp panel version " + version + ".",
                         citations=[{"label": "PMID " + p, "url": "https://pubmed.ncbi.nlm.nih.gov/" + p + "/"} for p in pmids])


def uniprot_humsavar(stream, stats=None):
    in_table = False
    categories = {"LP/P": "Likely pathogenic or pathogenic", "LB/B": "Likely benign or benign", "US": "Uncertain significance"}
    for line in stream:
        if line.startswith("_________"):
            in_table = True
            continue
        if not in_table or not line.strip():
            continue
        if line.startswith("----"):
            break
        record_stats(stats, "sourceRows")
        parts = line.split(None, 6)
        if len(parts) != 7:
            raise ValueError("Malformed UniProt humsavar row")
        gene, accession, feature, protein_change, category, rsid, disease = parts
        if not (re.fullmatch(r"[A-Z0-9]{6,10}", accession) and re.fullmatch(r"VAR_\d+", feature)
                and re.fullmatch(r"p\.[A-Za-z]+\d+[A-Za-z]+", protein_change) and category in categories):
            raise ValueError("Unrecognised UniProt humsavar variant identity or category")
        if not re.fullmatch(r"rs[1-9]\d*", rsid):
            record_stats(stats, "skippedMissingRsid")
            continue
        if gene != "-" and not GENE.fullmatch(gene):
            raise ValueError("Invalid UniProt gene symbol")
        values = {"UniProt accession": accession, "UniProt variant ID": feature,
                  "Protein change": protein_change, "Variant category": category,
                  "Category description": categories[category], "Disease or sample": disease.strip(),
                  "Mapping scope": "rsID context; source protein substitution is not a confirmed called genomic allele"}
        record_stats(stats, "emittedAnnotations")
        # One protein feature can name several separate diseases in humsavar.
        # Preserve each disease association, while conflicting classifications
        # for the same feature, rsID and disease retain a shared identity.
        association_id = hashlib.sha256((rsid + "\n" + disease.strip()).encode()).hexdigest()[:20]
        yield annotation("uniprot", accession + ":" + feature + ":" + association_id, (gene if gene != "-" else accession) + " " + protein_change,
                         "https://www.uniprot.org/uniprotkb/" + accession + "/entry#" + feature,
                         rsid=rsid, gene=gene if gene != "-" else None, fields=fields(values),
                         reviewStatus="Literature-curated protein variant", summary=categories[category] + " in the source protein annotation; genomic allele match has not been established.")


def build_curated_pack(records, output, source, version, coverage, metadata, **kwargs):
    # Existing build_pack has a closed source tuple. Register only for this
    # standalone, single-threaded build call and always restore the shared API.
    original = build.SOURCES
    try:
        build.SOURCES = tuple(dict.fromkeys((*original, *CURATED_SOURCES)))
        return build.build_pack(records, output, source, version, coverage, metadata, **kwargs)
    finally:
        build.SOURCES = original


def cached_download(source, cache, metadata):
    row = metadata[source]
    url = row["downloadUrl"]
    checked_url(url, {urlsplit(url).hostname})
    path = cache / row["filename"]
    receipt_path = path.with_name(path.name + ".download.json")
    if path.exists() and receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if receipt.get("url") != url:
            raise ValueError("Cached snapshot URL differs from the requested public source")
        if receipt.get("sha256") and build.sha256_file(path) != receipt["sha256"]:
            raise ValueError("Cached public snapshot hash changed")
    elif path.exists():
        raise ValueError("Cached source lacks a download receipt; remove it before fetching")
    else:
        build.download(url, path)
        receipt = {"url": url, "fetchedAt": build.now(), "bytes": path.stat().st_size,
                   "sha256": build.sha256_file(path)}
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    return path, receipt


def source_release(source, path, receipt):
    if source == "uniprot":
        with path.open() as stream:
            for line in stream:
                if line.startswith("Release:"):
                    return line.split(":", 1)[1].strip()
    elif source == "clingen":
        with path.open() as stream:
            for row in csv.reader(stream):
                if row and row[0].startswith("FILE CREATED:"):
                    return "Gene validity CSV " + row[0].split(":", 1)[1].strip()
    elif source == "orphanet":
        for _, element in ET.iterparse(path, events=("start",)):
            return "Genes XML " + element.get("date", "date unavailable")
    return "Public snapshot fetched " + receipt.get("fetchedAt", "date unavailable")


def prepare(sources, cache, output, version, base_url="/references", output_manifest=None):
    metadata = json.loads(Path(__file__).with_name("curated-sources.json").read_text())
    if not sources or len(set(sources)) != len(sources) or any(s not in DEFAULT_SOURCES for s in sources):
        raise ValueError("Choose distinct supported redistributable sources: " + ", ".join(DEFAULT_SOURCES) + ". PanelApp data terms have not been cleared for a public derived pack.")
    cache, output = Path(cache), Path(output)
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    final_manifest = Path(output_manifest) if output_manifest else output / "curated-manifest.json"
    if final_manifest.resolve() == (output / "manifest.json").resolve():
        raise ValueError("Use a separate output manifest; this tool never replaces the main catalog")
    result = {"schemaVersion": 1, "createdAt": build.now(), "packs": []}
    # Build and verify every source in isolation before publishing directories.
    with tempfile.TemporaryDirectory(prefix="curated-reference-") as temporary:
        staging = Path(temporary)
        for source in sources:
            destination = output / source / (version + "-gzip-v1")
            if destination.exists():
                raise ValueError("Immutable version already exists: " + str(destination))
            path, receipt = cached_download(source, cache, metadata)
            meta = dict(metadata[source])
            meta["sourceRelease"] = source_release(source, path, receipt)
            stats = collections.Counter()
            parser = {"clingen": clingen_csv, "orphanet": orphanet_xml, "uniprot": uniprot_humsavar}[source]
            with path.open("rb" if source == "orphanet" else "r") as stream:
                manifest = build_curated_pack(parser(stream, stats), staging, source, version,
                                              meta["coverage"], meta, base_url=base_url)
            original = staging / source / version
            provenance = {"preparedAt": build.now(), "sourceRelease": meta["sourceRelease"],
                          "coverage": meta["coverage"], "urls": [meta["downloadUrl"]], "downloads": [receipt],
                          "inputs": [{"name": path.name, "bytes": path.stat().st_size, "sha256": build.sha256_file(path)}],
                          "selectionStats": dict(stats), "adapter": "tools/reference/curated.py",
                          "privacy": "Fixed public source snapshot only. No user-file, personal identifier, or genotype query."}
            (original / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
            (original / "LICENSE.txt").write_text(meta["license"] + "\n" + meta["licenseUrl"] + "\n\n" + meta["attribution"] + "\n")
            input_manifest = staging / "input-manifest.json"
            input_manifest.write_text(json.dumps(manifest) + "\n")
            compressed = compact_catalog(input_manifest, level=9, jobs=2, output_manifest=staging / "compressed-manifest.json")
            result["packs"].extend(compressed["packs"])
            print(source, dict(stats), flush=True)
        for pack in result["packs"]:
            destination = output / pack["id"] / pack["version"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(staging / pack["id"] / pack["version"], destination)
        final_manifest.parent.mkdir(parents=True, exist_ok=True)
        final_manifest.write_text(json.dumps(result, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", nargs="+", choices=DEFAULT_SOURCES, default=list(DEFAULT_SOURCES))
    parser.add_argument("--cache", default=".reference-cache/curated")
    parser.add_argument("--output", default="public/references")
    parser.add_argument("--version", required=True)
    parser.add_argument("--base-url", default="/references")
    parser.add_argument("--output-manifest")
    args = parser.parse_args()
    result = prepare(args.sources, args.cache, args.output, args.version, args.base_url, args.output_manifest)
    for pack in result["packs"]:
        print("%s: %s records, %s compressed bytes" % (pack["id"], pack["recordCount"], sum(s["bytes"] for s in pack["shards"])))


if __name__ == "__main__":
    main()
