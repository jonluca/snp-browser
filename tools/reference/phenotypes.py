#!/usr/bin/env python3
"""Index official HPO source rows as local gene–disease phenotype context."""

import argparse
import collections
import csv
import json
import re
import shutil
import tempfile
import urllib.request
from pathlib import Path

import build
from adapters import annotation
from compact import compact_catalog

REPOSITORY = "https://github.com/obophenotype/human-phenotype-ontology"
API = "https://api.github.com/repos/obophenotype/human-phenotype-ontology/releases/tags/"
DEFAULT_RELEASE = "v2026-09-01"
FILES = ("genes_to_disease.txt", "genes_to_phenotype.txt", "phenotype.hpoa", "hp.obo")
GENE_COLUMNS = ("ncbi_gene_id", "gene_symbol", "association_type", "disease_id", "source")
PHENOTYPE_COLUMNS = ("ncbi_gene_id", "gene_symbol", "hpo_id", "hpo_name", "frequency", "disease_id")
ANNOTATION_COLUMNS = ("database_id", "disease_name", "qualifier", "hpo_id", "reference", "evidence",
                      "onset", "frequency", "sex", "modifier", "aspect", "biocuration")
LICENSE_URL = "https://human-phenotype-ontology.github.io/license.html"
LICENSE_SOURCE = "https://raw.githubusercontent.com/TheJacksonLaboratory/hpo-web/main/src/app/static/resources/license/license.component.html"
GENE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@-]*")
DISEASE = re.compile(r"(?:OMIM|ORPHA|DECIPHER):[1-9]\d*")
HPO = re.compile(r"HP:\d{7}")


def read_table(stream, expected):
    lines = (line for line in stream if not line.startswith("#"))
    reader = csv.reader(lines, delimiter="\t")
    header = next(reader, None)
    if header != list(expected):
        raise ValueError("Unexpected HPO table header; source schema requires review")
    for row in reader:
        if not row:
            continue
        if len(row) != len(expected):
            raise ValueError("Malformed HPO source row")
        yield row


def gene_key(identifier, symbol, disease):
    identifier = identifier.removeprefix("NCBIGene:")
    if not (re.fullmatch(r"[1-9]\d*", identifier) and (symbol == "-" or GENE.fullmatch(symbol)) and DISEASE.fullmatch(disease)):
        raise ValueError("Missing or invalid HPO gene/disease identity")
    return identifier, disease


def ontology_names(stream):
    """Read labels only. Do not change ontology edges or infer ancestor terms."""
    labels = {}
    current = None
    for line in stream:
        if line.startswith("["):
            current = None
        elif line.startswith("id: HP:"):
            current = line[4:].strip()
        elif current and line.startswith("name: "):
            label = line[6:].rstrip("\r\n")
            if current in labels and labels[current] != label:
                raise ValueError("Conflicting names share an HPO identifier")
            labels[current] = label
    if not labels:
        raise ValueError("Expected HPO ontology term labels")
    return labels


def packed(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def phenotype_annotations(genes, gene_phenotypes, disease_annotations, labels, release, stats=None):
    """Group exact original rows without collapsing negation, frequency or evidence."""
    if not re.fullmatch(r"v\d{4}-\d{2}-\d{2}", release):
        raise ValueError("Expected an official dated HPO release tag")
    stats = stats if stats is not None else collections.Counter()
    mappings, phenotypes, diseases = {}, collections.defaultdict(list), collections.defaultdict(list)
    for row in read_table(genes, GENE_COLUMNS):
        key = gene_key(row[0], row[1], row[3])
        mappings.setdefault(key, []).append(row)
        stats["geneMappingSourceRows"] += 1
    for row in read_table(gene_phenotypes, PHENOTYPE_COLUMNS):
        key = gene_key(row[0], row[1], row[5])
        if not HPO.fullmatch(row[2]) or not row[3]:
            raise ValueError("Missing HPO term identity or label")
        if key not in mappings:
            raise ValueError("HPO gene phenotype row lacks its source disease mapping")
        phenotypes[key].append(row)
        stats["genePhenotypeSourceRows"] += 1
    for row in read_table(disease_annotations, ANNOTATION_COLUMNS):
        if not (DISEASE.fullmatch(row[0]) and row[1] and HPO.fullmatch(row[3])):
            raise ValueError("Missing HPO disease annotation identity")
        if row[2] not in ("", "NOT"):
            raise ValueError("Unknown HPO qualifier; do not infer presence")
        diseases[row[0]].append(row)
        stats["diseaseAnnotationSourceRows"] += 1
        if row[2] == "NOT":
            stats["sourceNegatedRows"] += 1
    matched_diseases = {key[1] for key in mappings}
    stats["diseaseRowsWithoutGeneMapping"] = sum(len(rows) for disease, rows in diseases.items() if disease not in matched_diseases)
    for (gene_id, disease), source_mappings in sorted(mappings.items()):
        rows = diseases.get(disease, [])
        gene_rows = phenotypes.get((gene_id, disease), [])
        # Separate files may use different gene symbols. Keep every supplied
        # symbol for context lookup and preserve original rows unchanged.
        symbols = list(dict.fromkeys(row[1] for row in source_mappings + gene_rows if row[1] != "-"))
        if not symbols:
            symbols = ["NCBIGene:" + gene_id]
            stats["recordsWithoutSuppliedGeneSymbol"] += 1
        names = list(dict.fromkeys(row[1] for row in rows))
        disease_name = "; ".join(names) if names else disease
        inheritance = list(dict.fromkeys(("NOT " if row[2] else "") + row[3] + " " + labels.get(row[3], "")
                                        for row in rows if row[10] == "I"))
        observations = []
        for row in rows:
            # This is a display projection. The complete source rows below are
            # authoritative and retain frequency, sex, onset, reference and NOT.
            label = ("NOT " if row[2] else "") + row[3] + " " + labels.get(row[3], "")
            label += " | evidence " + (row[5] or "unspecified")
            if row[7]:
                label += " | disease frequency " + row[7]
            observations.append(label)
        source_fields = {
            "HPO release": release, "NCBI Gene ID": gene_id, "Disease ID": disease,
            "Disease name": disease_name, "Association types": packed(list(dict.fromkeys(row[2] for row in source_mappings))),
            "Inheritance annotations": packed(inheritance), "Phenotype observations": packed(observations),
            "Gene mapping columns": packed(GENE_COLUMNS), "Source gene mapping rows": packed(source_mappings),
            "Gene phenotype columns": packed(PHENOTYPE_COLUMNS), "Source gene phenotype rows": packed(gene_rows),
            "Disease annotation columns": packed(ANNOTATION_COLUMNS), "Source disease annotation rows": packed(rows),
            "Interpretation scope": "Disease-level phenotype descriptions and gene relationships; these are not observations or predictions about the person carrying a gene variant."
        }
        pmids = list(dict.fromkeys(pmid for row in rows for pmid in re.findall(r"\bPMID:(\d+)\b", row[4])))
        stats["emittedGeneDiseaseRecords"] += 1
        stats["retainedGeneMappingRows"] += len(source_mappings)
        stats["retainedGenePhenotypeRows"] += len(gene_rows)
        stats["attachedDiseaseAnnotationRows"] += len(rows)
        stats["attachedNegatedRows"] += sum(row[2] == "NOT" for row in rows)
        if not rows:
            stats["geneDiseaseRecordsWithoutPhenotypeAnnotations"] += 1
        yield annotation("hpo", gene_id + ":" + disease, ", ".join(symbols) + ": " + disease_name,
                         REPOSITORY + "/releases/tag/" + release, gene=", ".join(symbols), scope="gene",
                         summary="HPO source context: " + str(len(rows)) + " disease annotations; clinical features are not inferred from this gene match.",
                         reviewStatus="HPO disease annotation context", fields=source_fields,
                         citations=[{"label": "PMID " + pmid, "url": "https://pubmed.ncbi.nlm.nih.gov/" + pmid + "/"} for pmid in pmids])


def fetch_inputs(cache, release):
    if not re.fullmatch(r"v\d{4}-\d{2}-\d{2}", release):
        raise ValueError("Expected an official dated HPO release tag")
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    release_path = cache / "release.json"
    if release_path.exists():
        metadata = json.loads(release_path.read_text())
    else:
        with urllib.request.urlopen(API + release, timeout=60) as response:
            metadata = json.load(response)
        release_path.write_text(json.dumps(metadata, indent=2) + "\n")
    if metadata.get("tag_name") != release:
        raise ValueError("Cached HPO release differs; use a separate release cache")
    assets = {row["name"]: row for row in metadata["assets"]}
    receipts = []
    for filename in FILES:
        asset = assets.get(filename, {})
        digest = asset.get("digest", "")
        url = asset.get("browser_download_url", "")
        if (url != REPOSITORY + "/releases/download/" + release + "/" + filename
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)):
            raise ValueError("Missing verified official HPO release asset")
        path = cache / filename
        receipt_path = path.with_name(path.name + ".download.json")
        if not path.exists():
            build.download(url, path, digest[7:])
            receipt = {"url": url, "fetchedAt": build.now(), "bytes": path.stat().st_size,
                       "sha256": build.sha256_file(path), "githubAssetDigest": digest}
            receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        if build.sha256_file(path) != digest[7:] or path.stat().st_size != asset["size"]:
            raise ValueError("Cached HPO asset differs from its published identity")
        if not receipt_path.exists():
            raise ValueError("Cached HPO asset lacks an original fetch receipt")
        receipt = json.loads(receipt_path.read_text())
        if receipt.get("url") != url or receipt.get("sha256") != digest[7:]:
            raise ValueError("HPO asset receipt differs from the release")
        receipts.append(receipt)
    return receipts


def prepare(cache, output, version, release=DEFAULT_RELEASE, output_manifest=None):
    cache, output = Path(cache), Path(output)
    manifest_path = Path(output_manifest) if output_manifest else output / "hpo-manifest.json"
    if manifest_path.resolve() == (output / "manifest.json").resolve():
        raise ValueError("The HPO builder cannot replace the main reference catalog")
    destination = output / "hpo" / (version + "-gzip-v1")
    if destination.exists():
        raise ValueError("Immutable HPO version already exists")
    receipts = fetch_inputs(cache, release)
    with (cache / "hp.obo").open() as stream:
        labels = ontology_names(stream)
    with (cache / "phenotype.hpoa").open() as stream:
        annotation_version = next((line.strip().split(":", 1)[1].strip() for line in stream if line.startswith("#version:")), None)
    if not annotation_version:
        raise ValueError("The HPOA snapshot must declare its annotation version")
    meta = {"name": "Human Phenotype Ontology", "description": "Disease-level clinical features, inheritance, frequency, negation and evidence linked through public gene–disease mappings.",
            "homepage": REPOSITORY, "license": "HPO custom license: attribution, version and unchanged source content/relationships",
            "licenseUrl": LICENSE_URL, "sourceRelease": release + "; HPOA " + annotation_version,
            "attribution": "This service/product uses the Human Phenotype Ontology (" + release + "). Human Phenotype Ontology Consortium; Köhler et al., 2014, doi:10.1093/nar/gkt1026. Find out more at https://www.human-phenotype-ontology.org. Original source rows and logical relationships are preserved; the pack is a local index, not a modified ontology."}
    coverage = "Complete supplied genes_to_disease and genes_to_phenotype tables, grouped by NCBI gene and disease ID. All phenotype.hpoa rows for those exact diseases are attached unchanged, including NOT, frequency, onset, sex, evidence and inheritance. Diseases with no source gene mapping are counted in provenance but cannot produce gene matches. No ontology ancestor expansion, MONDO merge, genomic allele inference or personal phenotype prediction."
    stats = collections.Counter()
    with tempfile.TemporaryDirectory(prefix="hpo-reference-") as temporary:
        staging = Path(temporary)
        original_sources = build.SOURCES
        try:
            build.SOURCES = tuple(dict.fromkeys((*original_sources, "hpo")))
            with (cache / FILES[0]).open() as genes, (cache / FILES[1]).open() as phenotypes, (cache / FILES[2]).open() as annotations:
                result = build.build_pack(phenotype_annotations(genes, phenotypes, annotations, labels, release, stats),
                                          staging, "hpo", version, coverage, meta)
        finally:
            build.SOURCES = original_sources
        original = staging / "hpo" / version
        provenance = {"preparedAt": build.now(), "sourceRelease": meta["sourceRelease"], "coverage": coverage,
                      "urls": [receipt["url"] for receipt in receipts], "downloads": receipts,
                      "inputs": [{"name": filename, "bytes": (cache / filename).stat().st_size, "sha256": build.sha256_file(cache / filename)} for filename in FILES],
                      "selectionStats": dict(stats), "licenseSources": [LICENSE_URL, LICENSE_SOURCE],
                      "adapter": "tools/reference/phenotypes.py", "privacy": "Fixed public release inputs only; no personal DNA or phenotype queries."}
        (original / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
        (original / "LICENSE.txt").write_text(meta["license"] + "\n" + LICENSE_URL + "\n" + LICENSE_SOURCE + "\n\n" + meta["attribution"] + "\n")
        input_manifest = staging / "input-manifest.json"
        input_manifest.write_text(json.dumps(result) + "\n")
        compressed = compact_catalog(input_manifest, level=9, jobs=2, output_manifest=staging / "compressed-manifest.json")
        if sum(shard["bytes"] for shard in compressed["packs"][0]["shards"]) > 25 * 1024 * 1024:
            raise ValueError("HPO compressed pack exceeds the 25 MiB budget")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(staging / "hpo" / (version + "-gzip-v1"), destination)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(compressed, indent=2) + "\n")
    print(json.dumps(stats, indent=2))
    return compressed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", default=DEFAULT_RELEASE)
    parser.add_argument("--version", required=True)
    parser.add_argument("--cache", default=".reference-cache/hpo")
    parser.add_argument("--output", default="public/references")
    parser.add_argument("--output-manifest")
    args = parser.parse_args()
    result = prepare(args.cache, args.output, args.version, args.release, args.output_manifest)
    pack = result["packs"][0]
    print(pack["recordCount"], "gene–disease records;", sum(s["bytes"] for s in pack["shards"]), "compressed bytes")


if __name__ == "__main__":
    main()
