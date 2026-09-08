"""Streaming, conservative adapters for public reference data (never user DNA)."""

import csv
import bz2
import gzip
import hashlib
import io
import json
import re
from itertools import chain
from pathlib import Path
from urllib.parse import quote, unquote

SOURCES = ("clinvar", "dbsnp", "gnomad", "gwas", "ensembl", "clinpgx", "cpic")


def text(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return str(value).strip()


def first(row, *keys):
    for key in keys:
        value = row.get(key)
        if value is not None and text(value) not in ("", "-", ".", "na", "NA"):
            return value
    return None


def rsids(value):
    return list(dict.fromkeys(m.lower() for m in re.findall(r"\brs\d+\b", text(value), re.I)))


def chromosome(value):
    val = re.sub(r"^chr", "", text(value), flags=re.I).upper()
    if val == "M":
        val = "MT"
    if val in ("23", "24", "25", "26"):
        val = {"23": "X", "24": "Y", "25": "MT", "26": "MT"}[val]
    if val in ("X", "Y", "MT") or (val.isdigit() and 1 <= int(val) <= 22):
        return str(int(val)) if val.isdigit() else val
    return None


def assembly(value):
    val = text(value)
    for build in ("GRCh37", "GRCh38"):
        if val == build or val.startswith(build + "."):
            return build
    return None


def positive_int(value):
    try:
        val = int(text(value))
        return val if val > 0 else None
    except ValueError:
        return None


def fields(row):
    """Preserve source labels/values, without leaking nested objects into the contract."""
    return {str(k): v if isinstance(v, (str, int, float)) and not isinstance(v, bool)
            else text(v) for k, v in row.items() if v is not None and text(v) not in ("", ".", "-")}


def annotation(source, identity, title, url, **values):
    result = {"id": source + ":" + text(identity), "source": source,
              "scope": "variant", "title": text(title), "url": url, "fields": {}}
    result.update({k: v for k, v in values.items() if v is not None and v != "" and v != []})
    if result.get("scope") != "gene":
        complete = all(result.get(k) for k in ("assembly", "chromosome", "position", "ref", "alt"))
        literal = all(re.fullmatch("[ACGT]+", result.get(k, ""), re.I) for k in ("ref", "alt"))
        result["scope"] = "allele" if complete and literal else "variant"
    return result


def open_text(path):
    path = Path(path)
    if path.suffix == ".bz2":
        return bz2.open(path, "rt", encoding="utf-8-sig", newline="")
    return gzip.open(path, "rt", encoding="utf-8-sig", newline="") if path.suffix in (".gz", ".bgz") else path.open(encoding="utf-8-sig", newline="")


def json_records(stream):
    """Read JSON arrays, one JSON object, or JSONL with bounded record memory."""
    decoder = json.JSONDecoder()
    buffer = ""
    eof = False
    array = None
    expect_comma = False
    count = 0
    while True:
        buffer = buffer.lstrip()
        if array is None and buffer:
            array = buffer.startswith("[")
            if array:
                buffer = buffer[1:].lstrip()
        if array:
            if buffer.startswith("]"):
                if count and not expect_comma:
                    raise ValueError("Trailing comma in reference JSON array")
                rest = buffer[1:] + stream.read()
                if rest.strip():
                    raise ValueError("Unexpected data after reference JSON array")
                return
            if expect_comma and buffer:
                if not buffer.startswith(","):
                    raise ValueError("Missing comma in reference JSON array")
                buffer = buffer[1:].lstrip()
                expect_comma = False
        if not buffer and eof:
            if array:
                raise ValueError("Truncated reference JSON array")
            return
        if buffer and not expect_comma:
            try:
                value, end = decoder.raw_decode(buffer)
            except json.JSONDecodeError:
                if eof:
                    raise ValueError("Invalid or truncated reference JSON") from None
            else:
                if not isinstance(value, dict):
                    raise ValueError("Reference JSON records must be objects")
                yield value
                count += 1
                buffer = buffer[end:]
                expect_comma = bool(array)
                continue
        chunk = stream.read(65536)
        eof = not chunk
        buffer += chunk


def tsv_records(stream):
    for line in stream:
        if not line.strip() or line.startswith("##"):
            continue
        header = line.lstrip("#")
        reader = csv.DictReader(io.StringIO(header), delimiter="\t")
        names = reader.fieldnames
        if not names or len(names) < 2:
            raise ValueError("Expected a tab-delimited header")
        yield from csv.DictReader(stream, fieldnames=names, delimiter="\t")
        return


def vcf_records(stream):
    numbers = {}
    for line in stream:
        if line.startswith("##INFO="):
            match = re.search(r"ID=([^,]+),Number=([^,]+)", line)
            if match:
                numbers[match[1]] = match[2]
        if line.startswith("#") or not line.strip():
            continue
        cols = line.rstrip("\r\n").split("\t")
        if len(cols) < 8:
            raise ValueError("VCF record has fewer than eight columns")
        info = dict(part.split("=", 1) if "=" in part else (part, "true") for part in cols[7].split(";") if part != ".")
        alts = cols[4].split(",")
        for index, alt in enumerate(alts):
            values = {}
            for key, value in info.items():
                parts = value.split(",")
                if numbers.get(key) == "A":
                    value = parts[index] if index < len(parts) else ""
                elif numbers.get(key) == "R":
                    value = parts[index + 1] if index + 1 < len(parts) else ""
                values[key] = unquote(value)
            yield {"chromosome": chromosome(cols[0]), "position": positive_int(cols[1]),
                   "id": cols[2], "ref": cols[3].upper(), "alt": alt.upper(),
                   "filter": cols[6], "info": values, "altIndex": index, "altCount": len(alts)}


def vcf_annotations(source, stream, build):
    if not build:
        raise ValueError("VCF input requires --assembly GRCh37 or GRCh38; coordinates must never be guessed")
    for row in vcf_records(stream):
        info = row["info"]
        identifiers = rsids(row["id"]) or rsids("rs" + info.get("RS", ""))
        rsid = identifiers[0] if identifiers else None
        identity = ":".join(str(row[k]) for k in ("chromosome", "position", "ref", "alt"))
        loc = {k: row[k] for k in ("chromosome", "position", "ref", "alt")}
        genes = [part.split(":", 1)[0] for part in info.get("GENEINFO", "").split("|") if part]
        gene = ", ".join(dict.fromkeys(genes)) or None
        values = fields(info)
        values["FILTER"] = row["filter"]
        if source == "clinvar":
            significance = info.get("CLNSIG", "Classification not supplied").replace("_", " ")
            summary = info.get("CLNDN", "").replace("_", " ")
            # ClinVar's ID column is VariationID, never an rsID. Multi-allelic
            # records with scalar clinical annotations cannot be allele-resolved.
            result = annotation(source, build + ":" + row["id"] + ":" + identity,
                                significance, "https://www.ncbi.nlm.nih.gov/clinvar/variation/" + quote(row["id"]) + "/",
                                rsid=rsid, aliases=identifiers[1:], assembly=build, gene=gene,
                                summary=summary, fields=values,
                                reviewStatus=info.get("CLNREVSTAT", "").replace("_", " "), **loc)
            if row["altCount"] > 1:
                result["scope"] = "variant"
                result["fields"]["Allele resolution"] = "Clinical assertions on multiallelic input retained as variant context"
            yield result
        elif source == "gnomad":
            # Export primary population data only. Third-party consequence/
            # prediction annotations in some VCFs have separate license terms.
            values = {k: v for k, v in values.items() if re.match(r"^(AF|AC|AN|nhomalt|faf|grpmax|popmax)(_|$)", k, re.I) or k == "FILTER"}
            freq = info.get("AF", info.get("AF_joint", ""))
            yield annotation(source, build + ":" + identity,
                             "Population allele frequency", "https://gnomad.broadinstitute.org/variant/" + identity.replace(":", "-"),
                             rsid=rsid, assembly=build, gene=gene, fields=values,
                             summary=("Allele frequency: " + freq) if freq else "Population frequency reference", **loc)
        else:
            yield annotation(source, build + ":" + identity, rsid or identity,
                             "https://www.ncbi.nlm.nih.gov/snp/" + (rsid or ""),
                             rsid=rsid, aliases=identifiers[1:], assembly=build,
                             gene=gene, fields=values, **loc)


def clinvar_tsv(stream, build):
    for row in tsv_records(stream):
        row_build = assembly(row.get("Assembly"))
        if build and row_build != build:
            continue
        snp = text(first(row, "RS# (dbSNP)", "RS#"))
        rsid = "rs" + snp if snp.isdigit() and int(snp) > 0 else None
        identity = text(first(row, "VariationID", "AlleleID"))
        chrom = chromosome(row.get("Chromosome"))
        pos = positive_int(row.get("PositionVCF"))
        ref, alt = first(row, "ReferenceAlleleVCF"), first(row, "AlternateAlleleVCF")
        yield annotation("clinvar", ":".join(map(text, (identity, row_build, chrom, pos, ref, alt))),
                         first(row, "ClinicalSignificance", "GermlineClassification") or "Clinical classification",
                         "https://www.ncbi.nlm.nih.gov/clinvar/variation/" + quote(identity) + "/",
                         rsid=rsid, assembly=row_build, chromosome=chrom, position=pos,
                         ref=ref, alt=alt, gene=first(row, "GeneSymbol"),
                         summary=first(row, "PhenotypeList", "Name"), fields=fields(row),
                         reviewStatus=first(row, "ReviewStatus"), lastEvaluated=first(row, "LastEvaluated"))


def dbsnp_json(stream, build):
    for row in json_records(stream):
        rsid = "rs" + text(row.get("refsnp_id"))
        if not re.fullmatch(r"rs\d+", rsid):
            raise ValueError("RefSNP record missing refsnp_id")
        merges = row.get("dbsnp1_merges", [])
        aliases = ["rs" + text(m.get("merged_rsid")) for m in merges if m.get("merged_rsid")]
        snapshot = row.get("primary_snapshot_data", {})
        yielded = False
        for placement in snapshot.get("placements_with_allele", []):
            annot = placement.get("placement_annot", {})
            if annot.get("is_aln_opposite_orientation"):
                continue
            seq = placement.get("seq_id", "")
            match = re.fullmatch(r"NC_0*(\d+)\.\d+", seq)
            chrom = chromosome(match[1]) if match else None
            if seq.startswith("NC_012920."):
                chrom = "MT"
            if not chrom:
                continue
            builds = list(dict.fromkeys(assembly(t.get("assembly_name")) for t in annot.get("seq_id_traits_by_assembly", []) if t.get("is_top_level")))
            for row_build in builds:
                if not row_build or (build and build != row_build):
                    continue
                for allele in placement.get("alleles", []):
                    spdi = allele.get("allele", {}).get("spdi", {})
                    ref, alt = spdi.get("deleted_sequence", ""), spdi.get("inserted_sequence", "")
                    if ref == alt:
                        continue
                    pos = int(spdi["position"]) + 1
                    identifier = ":".join(map(text, (rsid, row_build, chrom, pos, ref, alt)))
                    yield annotation("dbsnp", identifier, rsid, "https://www.ncbi.nlm.nih.gov/snp/" + rsid,
                                     rsid=rsid, aliases=aliases, assembly=row_build,
                                     chromosome=chrom, position=pos, ref=ref, alt=alt,
                                     fields={"Variant type": snapshot.get("variant_type", ""), "Sequence": seq,
                                             "SPDI": ":".join(map(text, (seq, spdi["position"], ref, alt))),
                                             "dbSNP build": row.get("last_update_build_id", "")})
                    yielded = True
        if not yielded:
            targets = row.get("merged_snapshot_data", {}).get("merged_into", [])
            for target in targets:
                canonical = "rs" + text(target)
                yield annotation("dbsnp", rsid + ":merged:" + canonical, "Merged identifier " + rsid,
                                 "https://www.ncbi.nlm.nih.gov/snp/" + canonical,
                                 rsid=canonical, aliases=[rsid], fields={"Merged from": rsid})


def gwas_tsv(stream, build):
    for row in tsv_records(stream):
        candidates = rsids(first(row, "SNPS", "SNP_ID_CURRENT", "STRONGEST SNP-RISK ALLELE"))
        if not candidates:
            continue
        digest = hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()[:20]
        for rsid in candidates:
            pmid = text(row.get("PUBMEDID"))
            study = text(row.get("STUDY ACCESSION"))
            # Reported risk alleles are not necessarily reference-forward. Do not
            # label a GWAS finding allele matched without harmonization evidence.
            locus_unique = len(candidates) == 1
            yield annotation("gwas", digest + ":" + rsid,
                             row.get("DISEASE/TRAIT") or "Trait association",
                             "https://www.ebi.ac.uk/gwas/" + ("studies/" + quote(study) if study else "variants/" + rsid),
                             rsid=rsid, assembly=build if locus_unique else None,
                             chromosome=chromosome(row.get("CHR_ID")) if locus_unique else None,
                             position=positive_int(row.get("CHR_POS")) if locus_unique else None,
                             gene=first(row, "MAPPED_GENE", "REPORTED GENE(S)"),
                             summary=first(row, "STUDY"), fields=fields(row),
                             citations=[{"label": "PMID " + pmid, "url": "https://pubmed.ncbi.nlm.nih.gov/" + pmid + "/"}] if pmid.isdigit() else None)


def ensembl_json(stream, build):
    for row in json_records(stream):
        row_build = assembly(row.get("assembly_name")) or build
        if build and row_build != build:
            continue
        identifiers = rsids(row.get("id"))
        if not identifiers:
            identifiers = [i for var in row.get("colocated_variants", []) for i in rsids(var.get("id"))]
        rsid = identifiers[0] if identifiers else None
        ref = text(row.get("allele_string")).split("/")[0]
        for kind in ("transcript", "regulatory_feature", "motif_feature", "intergenic"):
            for consequence in row.get(kind + "_consequences", []):
                alt = consequence.get("variant_allele")
                gene = first(consequence, "gene_symbol", "gene_id")
                digest = hashlib.sha256(json.dumps([row.get("id"), row.get("start"), row_build, consequence], sort_keys=True).encode()).hexdigest()[:24]
                # VEP JSON allele_string is on the forward genomic strand for
                # strand=1 input; for strand=-1 we retain context without guessing.
                result = annotation("ensembl", digest,
                                    ", ".join(consequence.get("consequence_terms", [])),
                                    "https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=" + quote(rsid or text(row.get("id"))),
                                    rsid=rsid, assembly=row_build, chromosome=chromosome(row.get("seq_region_name")),
                                    position=positive_int(row.get("start")), ref=ref, alt=alt, gene=gene,
                                    summary=first(consequence, "hgvsp", "hgvsc"), fields=fields(consequence))
                if row.get("strand", 1) != 1:
                    result["scope"] = "variant"
                yield result


def ensembl_tsv(stream, build):
    for row in tsv_records(stream):
        extra = dict(p.split("=", 1) for p in text(row.get("Extra")).split(";") if "=" in p)
        identifiers = rsids(first(row, "Existing_variation", "Uploaded_variation"))
        rsid = identifiers[0] if identifiers else None
        loc = text(row.get("Location")).split(":")
        digest = hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()[:24]
        # VEP's Allele is an unanchored consequence allele. No genomic ref is
        # guaranteed in tab output, so retain variant context rather than invent it.
        yield annotation("ensembl", digest, row.get("Consequence") or "Sequence consequence",
                         "https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=" + quote(rsid or text(row.get("Uploaded_variation"))),
                         rsid=rsid, assembly=build, chromosome=chromosome(loc[0]),
                         position=positive_int(loc[1].split("-")[0]) if len(loc) > 1 else None,
                gene=first(row, "SYMBOL") or extra.get("SYMBOL") or first(row, "Gene"), fields=fields({**row, **extra}))


def ensembl_vcf(stream, build):
    if not build:
        raise ValueError("VEP-annotated VCF requires an explicit assembly")
    header = []
    names = None
    tag = None
    version = None
    for line in stream:
        header.append(line)
        if line.startswith("##vep_version="):
            version = line.strip().split("=", 1)[1]
        match = re.match(r'##INFO=<ID=(vep|CSQ),.*Format: ([^"\n]+)', line)
        if match:
            tag, names = match[1], match[2].split("|")
        if line.startswith("#CHROM"):
            break
    if not names:
        raise ValueError("VEP VCF requires the INFO Format header for vep or CSQ")
    for row in vcf_records(chain(header, stream)):
        info = row["info"]
        identifiers = rsids(row["id"])
        rsid = identifiers[0] if identifiers else None
        for entry in info.get(tag, "").split(","):
            values = dict(zip(names, entry.split("|")))
            if not values.get("Consequence"):
                continue
            allele_number = positive_int(values.get("ALLELE_NUM"))
            if allele_number and allele_number != row["altIndex"] + 1:
                continue
            if row["altCount"] > 1 and not allele_number and values.get("Allele") != row["alt"]:
                continue
            identity = [build, row["chromosome"], row["position"], row["ref"], row["alt"], values]
            digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
            # These two source QC fields support explicit public-corpus filters.
            values["AF"] = info.get("AF", "")
            values["FILTER"] = row["filter"]
            if version:
                values["VEP version"] = version
            yield annotation("ensembl", digest, values["Consequence"].replace("&", ", "),
                             "https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=" + quote(rsid or text(row["id"])),
                             rsid=rsid, assembly=build, gene=first(values, "SYMBOL", "Gene"),
                             chromosome=row["chromosome"], position=row["position"], ref=row["ref"], alt=row["alt"],
                             summary=first(values, "HGVSp", "HGVSc"),
                             fields=fields({k: v for k, v in values.items() if k not in ("LoF", "LoF_filter", "LoF_flags", "LoF_info")}))


def clinpgx_rows(records):
    for row in records:
        if "status" in row and "data" in row:
            if row["status"] != "success":
                raise ValueError("ClinPGx API returned an unsuccessful response")
            data = row["data"]
            yield from clinpgx_rows(data if isinstance(data, list) else [data])
            continue
        # Supports the official clinical_annotations.tsv and var_*_ann.tsv
        # labels, and public API JSON objects with equivalent explicit fields.
        variant = first(row, "Variant/Haplotypes", "Variant", "variant", "location", "Location")
        location = variant if isinstance(variant, dict) else {}
        if isinstance(variant, dict):
            variant = first(variant, "rsid", "fingerprint", "displayName", "name")
        identifiers = rsids(variant)
        gene = first(row, "Gene", "Gene(s)", "gene", "genes") or location.get("genes")
        if isinstance(gene, list):
            gene = ", ".join(text(g.get("symbol", g.get("name", ""))) if isinstance(g, dict) else text(g) for g in gene)
        if isinstance(gene, dict):
            gene = first(gene, "symbol", "name")
        if not identifiers and not gene:
            continue
        drugs = first(row, "Drug(s)", "Chemical", "Chemicals", "drug", "drugs", "relatedChemicals")
        if isinstance(drugs, list):
            drugs = ", ".join(text(d.get("name", "")) if isinstance(d, dict) else text(d) for d in drugs)
        identity = text(first(row, "Clinical Annotation ID", "Variant Annotation ID", "id"))
        if not identity:
            identity = hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()[:20]
        summary = first(row, "Annotation Text", "Sentence", "sentence", "summary", "Phenotype(s)")
        level = first(row, "Level of Evidence", "levelOfEvidence")
        if isinstance(level, dict):
            level = first(level, "term", "name")
        clinical = "Clinical Annotation ID" in row or row.get("objCls") == "ClinicalAnnotation"
        for rsid in identifiers or [None]:
            yield annotation("clinpgx", identity + (":" + rsid if rsid else ""),
                             (text(drugs) + " drug-response evidence") if drugs else "Drug-response evidence",
                             "https://www.clinpgx.org/" + ("clinicalAnnotation/" if clinical else "variantAnnotation/") + quote(identity),
                             rsid=rsid, gene=text(gene) or None, scope="variant" if rsid else "gene",
                             summary=text(summary) or None, fields=fields(row),
                             reviewStatus=text(level) or None,
                             lastEvaluated=text(first(row, "Latest History Date (YYYY-MM-DD)", "lastUpdated")) or None)


def cpic_json(stream):
    for row in json_records(stream):
        genes = first(row, "genesymbol", "gene", "genes")
        if isinstance(genes, str):
            genes = [genes]
        if not genes:
            continue
        for gene in genes:
            if isinstance(gene, dict):
                gene = first(gene, "symbol", "genesymbol")
            if not gene:
                continue
            identifier = text(first(row, "pairid", "id", "guidelineid"))
            if not identifier:
                identifier = hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()[:20]
            pmids = row.get("pmids") or []
            guideline_url = first(row, "guidelineurl", "url")
            drug = first(row, "drugname")
            title = text(gene) + (" · " + text(drug) if drug else " gene–drug evidence")
            yield annotation("cpic", identifier + ":" + text(gene),
                             title,
                             guideline_url or (("https://api.cpicpgx.org/v1/pair_view?pairid=eq." + quote(identifier)) if row.get("pairid") else "https://api.cpicpgx.org/"),
                             scope="gene", gene=text(gene), fields=fields(row),
                             summary=("Gene–drug guideline reference" if guideline_url else "Gene–drug evidence context") + "; a genotype or prescribing recommendation has not been inferred.",
                             reviewStatus=text(row.get("cpiclevel")) or None,
                             citations=[{"label": "PMID " + text(p), "url": "https://pubmed.ncbi.nlm.nih.gov/" + text(p) + "/"} for p in pmids if text(p).isdigit()])


def read_annotations(source, path, format_name, build=None):
    with open_text(path) as stream:
        if format_name == "vcf" and source in ("clinvar", "dbsnp", "gnomad"):
            yield from vcf_annotations(source, stream, build)
        elif source == "clinvar" and format_name == "tsv":
            yield from clinvar_tsv(stream, build)
        elif source == "dbsnp" and format_name == "json":
            yield from dbsnp_json(stream, build)
        elif source == "gwas" and format_name == "tsv":
            yield from gwas_tsv(stream, build)
        elif source == "ensembl" and format_name == "json":
            yield from ensembl_json(stream, build)
        elif source == "ensembl" and format_name == "tsv":
            yield from ensembl_tsv(stream, build)
        elif source == "ensembl" and format_name == "vcf":
            yield from ensembl_vcf(stream, build)
        elif source == "clinpgx" and format_name in ("tsv", "json"):
            yield from clinpgx_rows(tsv_records(stream) if format_name == "tsv" else json_records(stream))
        elif source == "cpic" and format_name == "json":
            yield from cpic_json(stream)
        else:
            raise ValueError("Unsupported source/format: " + source + "/" + format_name)
