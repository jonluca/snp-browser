import collections
import csv
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build
from compact import compact_catalog, verify_gzip
from curated import (build_curated_pack, checked_url, clingen_csv, orphanet_xml,
                     panelapp_rows, prepare, uniprot_humsavar)

META = {key: "https://example.org/" if key in ("homepage", "licenseUrl") else "Synthetic test"
        for key in ("name", "description", "homepage", "license", "licenseUrl", "attribution")}
CLINGEN_HEADER = ["GENE SYMBOL", "GENE ID (HGNC)", "DISEASE LABEL", "DISEASE ID (MONDO)",
                  "MOI", "SOP", "CLASSIFICATION", "ONLINE REPORT", "CLASSIFICATION DATE", "GCEP"]


def clingen_input(**changes):
    row = dict(zip(CLINGEN_HEADER, ["TEST1", "HGNC:123", "Synthetic condition", "MONDO:000001", "AR",
                                  "SOP10", "Disputed", "https://search.clinicalgenome.org/kb/gene-validity/CGGV:assertion_synthetic",
                                  "2026-01-01", "Synthetic panel"]))
    row.update(changes)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["CLINGEN GENE DISEASE VALIDITY CURATIONS"])
    writer.writerow(CLINGEN_HEADER)
    writer.writerow(["++"] * len(CLINGEN_HEADER))
    writer.writerow([row[k] for k in CLINGEN_HEADER])
    return io.StringIO(output.getvalue())


def orphanet_input():
    return io.BytesIO(b'''<JDBOR><DisorderList><Disorder id="1"><OrphaCode>123</OrphaCode><Name>Synthetic disorder</Name>
    <ExpertLink>javascript:bad()</ExpertLink><DisorderGeneAssociationList><DisorderGeneAssociation>
    <SourceOfValidation>1234[PMID]; 5678[PMID]</SourceOfValidation><Gene id="456"><Symbol>TEST1</Symbol>
    <Name>Synthetic gene</Name><ExternalReferenceList><ExternalReference><Source>HGNC</Source><Reference>789</Reference></ExternalReference></ExternalReferenceList></Gene>
    <DisorderGeneAssociationType id="99"><Name>Candidate gene tested in</Name></DisorderGeneAssociationType>
    <DisorderGeneAssociationStatus><Name>Not yet assessed</Name></DisorderGeneAssociationStatus>
    </DisorderGeneAssociation></DisorderGeneAssociationList></Disorder></DisorderList></JDBOR>''')


def panelapp_input():
    return {"gene_data": {"gene_symbol": "TEST1", "hgnc_id": "HGNC:1"}, "entity_type": "gene",
            "confidence_level": "3", "mode_of_inheritance": "BIALLELIC", "mode_of_pathogenicity": "Loss-of-function variants DO NOT cause this phenotype",
            "publications": ["1234", "javascript:bad()"], "evidence": ["Expert Review Green"],
            "phenotypes": ["Synthetic condition"], "panel": {"id": 123, "name": "Synthetic panel",
            "version": "1.2", "status": "public", "version_created": "2026-01-01"}}


class CuratedTest(unittest.TestCase):
    def test_clingen_preserves_disputed_evidence_as_gene_context(self):
        record = list(clingen_csv(clingen_input()))[0]
        self.assertEqual(record["scope"], "gene")
        self.assertEqual(record["reviewStatus"], "Disputed")
        self.assertEqual(record["fields"]["MOI"], "AR")
        self.assertEqual(record["fields"]["DISEASE ID (MONDO)"], "MONDO:000001")
        self.assertNotIn("rsid", record)
        self.assertNotIn("assembly", record)

    def test_clingen_missing_ids_are_counted_and_not_fabricated(self):
        stats = collections.Counter()
        self.assertEqual(list(clingen_csv(clingen_input(**{"GENE ID (HGNC)": ""}), stats)), [])
        self.assertEqual(stats, {"sourceRows": 1, "skippedMissingIdentity": 1})

    def test_clingen_rejects_unexpected_or_unsafe_curation_urls(self):
        for url in ["http://search.clinicalgenome.org/kb/gene-validity/x", "https://example.com/x",
                    "https://search.clinicalgenome.org@evil.com/x", "javascript:bad()",
                    "https://search.clinicalgenome.org/wrong"]:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    list(clingen_csv(clingen_input(**{"ONLINE REPORT": url})))

    def test_clingen_changed_header_or_row_width_fails(self):
        with self.assertRaises(ValueError):
            list(clingen_csv(io.StringIO("wrong,header\n")))
        source = clingen_input().getvalue().replace('"', '')
        with self.assertRaises(ValueError):
            list(clingen_csv(io.StringIO(source + "bad,row\n")))

    def test_orphanet_keeps_relationship_status_and_publications(self):
        record = list(orphanet_xml(orphanet_input()))[0]
        self.assertEqual(record["scope"], "gene")
        self.assertEqual(record["reviewStatus"], "Not yet assessed")
        self.assertEqual(record["fields"]["Association type"], "Candidate gene tested in")
        self.assertEqual(record["fields"]["Gene reference: HGNC"], "789")
        self.assertEqual(record["url"], "https://www.orpha.net/en/disease/detail/123")
        self.assertEqual(len(record["citations"]), 2)
        self.assertNotIn("position", record)

    def test_orphanet_missing_ids_are_skipped(self):
        raw = orphanet_input().read().replace(b'<Gene id="456">', b'<Gene>')
        stats = collections.Counter()
        self.assertEqual(list(orphanet_xml(io.BytesIO(raw), stats)), [])
        self.assertEqual(stats["skippedMissingIdentity"], 1)

    def test_orphanet_cluster_symbols_are_retained(self):
        raw = orphanet_input().read().replace(b"TEST1", b"SNORD116@")
        self.assertEqual(list(orphanet_xml(io.BytesIO(raw)))[0]["gene"], "SNORD116@")

    def test_orphanet_dtd_entities_and_wrong_root_are_rejected(self):
        for raw in [b'<!DOCTYPE a [<!ENTITY b "x">]><JDBOR/>', b'<html/>']:
            with self.assertRaises(ValueError):
                list(orphanet_xml(io.BytesIO(raw)))

    def test_panelapp_preserves_gene_panel_inheritance_but_never_alleles(self):
        record = list(panelapp_rows([panelapp_input()]))[0]
        self.assertEqual(record["scope"], "gene")
        self.assertEqual(record["fields"]["Mode of inheritance"], "BIALLELIC")
        self.assertEqual(record["fields"]["Panel version"], "1.2")
        self.assertIn("DO NOT", record["fields"]["Mode of pathogenicity"])
        self.assertEqual(len(record["citations"]), 1)
        self.assertNotIn("assembly", record)

    def test_panelapp_filters_amber_unreleased_and_missing_ids(self):
        amber = panelapp_input(); amber["confidence_level"] = "2"
        unreleased = panelapp_input(); unreleased["panel"]["version"] = "0.98"
        missing = panelapp_input(); missing["gene_data"].pop("hgnc_id")
        stats = collections.Counter()
        self.assertEqual(list(panelapp_rows([amber, unreleased, missing], stats)), [])
        self.assertEqual(stats, {"sourceRows": 3, "skippedNotGreenGene": 1,
                                 "skippedUnreleasedPanel": 1, "skippedMissingIdentity": 1})

    def test_panelapp_origin_does_not_follow_untrusted_hosts_or_paths(self):
        for origin in ["https://evil.example", "https://panelapp-aus.org/private", "https://panelapp-aus.org?gene=private"]:
            with self.assertRaises(ValueError):
                list(panelapp_rows([panelapp_input()], origin=origin))

    def test_uniprot_is_rsid_context_with_full_protein_identity(self):
        raw = "Release: 2026_02\n_________ header\nTEST1 P12345 VAR_000001 p.Arg12Cys LP/P rs123 Synthetic condition\n"
        record = list(uniprot_humsavar(io.StringIO(raw)))[0]
        self.assertEqual((record["scope"], record["rsid"]), ("variant", "rs123"))
        self.assertEqual(record["fields"]["Protein change"], "p.Arg12Cys")
        self.assertEqual(record["fields"]["Variant category"], "LP/P")
        for key in ["ref", "alt", "position", "assembly"]:
            self.assertNotIn(key, record)

    def test_uniprot_missing_rsid_is_counted_but_missing_gene_is_allowed(self):
        raw = "_________ header\nTEST1 P12345 VAR_000001 p.Arg12Cys US - Condition\n- P12345 VAR_000002 p.Arg13Cys LB/B rs123 -\n"
        stats = collections.Counter()
        rows = list(uniprot_humsavar(io.StringIO(raw), stats))
        self.assertEqual(len(rows), 1)
        self.assertNotIn("gene", rows[0])
        self.assertEqual(stats, {"sourceRows": 2, "skippedMissingRsid": 1, "emittedAnnotations": 1})

    def test_uniprot_unknown_category_or_identity_fails(self):
        for raw in ["TEST1 P12345 VAR_000001 p.Arg12Cys UNKNOWN rs123 Disease", "TEST1 P12345 bad p.Arg12Cys US rs123 Disease"]:
            with self.assertRaises(ValueError):
                list(uniprot_humsavar(io.StringIO("_________ header\n" + raw)))

    def test_uniprot_preserves_several_diseases_for_one_protein_feature(self):
        raw = "_________ header\n" + "\n".join(
            "TEST1 P12345 VAR_000001 p.Arg12Cys LP/P rs123 " + disease for disease in ["Condition A", "Condition B"])
        records = list(uniprot_humsavar(io.StringIO(raw)))
        self.assertEqual(len(records), 2)
        self.assertNotEqual(records[0]["id"], records[1]["id"])
        self.assertEqual(records[0]["fields"]["UniProt variant ID"], records[1]["fields"]["UniProt variant ID"])

    def test_curated_builder_conflict_rejection_and_registration_restore(self):
        original = build.SOURCES
        record = list(clingen_csv(clingen_input()))[0]
        conflicting = {**record, "reviewStatus": "Definitive"}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "Conflicting"):
                build_curated_pack([record, conflicting], directory, "clingen", "v1", "Synthetic coverage", META)
        self.assertEqual(build.SOURCES, original)

    def test_curated_pack_roundtrip_and_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = list(clingen_csv(clingen_input()))
            manifest = build_curated_pack(rows + rows, root, "clingen", "v1", "Synthetic coverage", META)
            self.assertEqual(manifest["packs"][0]["recordCount"], 1)
            with closing(sqlite3.connect(root / "clingen/v1/part-00001.sqlite")) as db:
                self.assertEqual(db.execute("pragma quick_check").fetchone()[0], "ok")
                self.assertEqual(db.execute("select scope, gene from annotations").fetchone(), ("gene", "TEST1"))
            catalog = root / "curated-manifest.json"
            catalog.write_text(json.dumps(manifest))
            compressed = compact_catalog(catalog, jobs=1)
            shard = compressed["packs"][0]["shards"][0]
            verify_gzip(root / "clingen/v1-gzip-v1/part-00001.sqlite.gzip",
                        shard["compression"]["uncompressedBytes"], shard["compression"]["uncompressedSha256"])

    def test_public_preparation_rejects_unlicensed_source_and_main_catalog_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "PanelApp"):
                prepare(["panelapp"], directory, directory, "v1")
            with self.assertRaisesRegex(ValueError, "main catalog"):
                prepare(["clingen"], directory, directory, "v1", output_manifest=Path(directory) / "manifest.json")


if __name__ == "__main__":
    unittest.main()
