import collections
import csv
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from phenotypes import (ANNOTATION_COLUMNS, DEFAULT_RELEASE, FILES, GENE_COLUMNS,
                        PHENOTYPE_COLUMNS, REPOSITORY, fetch_inputs, gene_key,
                        ontology_names, phenotype_annotations, prepare, read_table)


def table(columns, rows):
    stream = io.StringIO()
    writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
    writer.writerow(columns)
    writer.writerows(rows)
    return io.StringIO(stream.getvalue())


def records(gene_rows=None, phenotype_rows=None, disease_rows=None, stats=None):
    genes = [["NCBIGene:123", "TEST1", "MENDELIAN", "OMIM:123", "https://example.org/mapping"]]
    phenotypes = [["123", "TEST1", "HP:0000007", "Autosomal recessive inheritance", "-", "OMIM:123"]]
    diseases = [
        ["OMIM:123", "Synthetic disease", "", "HP:0000007", "PMID:1234", "TAS", "", "", "", "", "I", "HPO:test[2026-01-01]"],
        ["OMIM:123", "Synthetic disease", "NOT", "HP:0000001", "PMID:5678", "PCS", "HP:0003577", "0/10", "FEMALE", "HP:0012824", "P", "HPO:test[2026-01-01]"]]
    return list(phenotype_annotations(
        table(GENE_COLUMNS, genes if gene_rows is None else gene_rows),
        table(PHENOTYPE_COLUMNS, phenotypes if phenotype_rows is None else phenotype_rows),
        table(ANNOTATION_COLUMNS, diseases if disease_rows is None else disease_rows),
        {"HP:0000001": "Synthetic feature", "HP:0000007": "Autosomal recessive inheritance"}, DEFAULT_RELEASE, stats))


class PhenotypeReferenceTest(unittest.TestCase):
    def test_negation_frequency_evidence_onset_and_sex_survive_grouping(self):
        row = records()[0]
        self.assertEqual(row["scope"], "gene")
        self.assertEqual(row["source"], "hpo")
        source = json.loads(row["fields"]["Source disease annotation rows"])
        self.assertEqual(source[1][2:11], ["NOT", "HP:0000001", "PMID:5678", "PCS", "HP:0003577", "0/10", "FEMALE", "HP:0012824", "P"])
        display = json.loads(row["fields"]["Phenotype observations"])
        self.assertTrue(display[1].startswith("NOT HP:0000001"))
        self.assertIn("disease frequency 0/10", display[1])
        self.assertEqual(json.loads(row["fields"]["Inheritance annotations"]), ["HP:0000007 Autosomal recessive inheritance"])
        for key in ("rsid", "assembly", "chromosome", "position", "ref", "alt"):
            self.assertNotIn(key, row)

    def test_every_exact_source_row_is_retained_including_duplicate_mappings(self):
        mapping = ["NCBIGene:123", "TEST1", "MENDELIAN", "OMIM:123", "ftp://example.org/source"]
        stats = collections.Counter()
        row = records(gene_rows=[mapping, mapping], stats=stats)[0]
        self.assertEqual(json.loads(row["fields"]["Source gene mapping rows"]), [mapping, mapping])
        self.assertEqual(stats["geneMappingSourceRows"], 2)
        self.assertEqual(stats["retainedGeneMappingRows"], 2)
        self.assertEqual(stats["emittedGeneDiseaseRecords"], 1)

    def test_gene_ids_and_disease_ids_cannot_be_replaced_by_unsafe_content(self):
        for gene_id, gene, disease in [("0", "TEST1", "OMIM:123"), ("123", "x<script>", "OMIM:123"),
                                       ("123", "TEST1", "https://evil.example/")]:
            with self.assertRaises(ValueError):
                gene_key(gene_id, gene, disease)

    def test_missing_symbol_uses_exact_ncbi_identifier_without_invented_symbol(self):
        stats = collections.Counter()
        source = ["NCBIGene:123", "-", "MENDELIAN", "OMIM:123", "source"]
        row = records(gene_rows=[source], phenotype_rows=[], stats=stats)[0]
        self.assertEqual(row["gene"], "NCBIGene:123")
        self.assertEqual(json.loads(row["fields"]["Source gene mapping rows"])[0][1], "-")
        self.assertEqual(stats["recordsWithoutSuppliedGeneSymbol"], 1)

    def test_gene_mapping_without_phenotypes_stays_context(self):
        stats = collections.Counter()
        row = records(phenotype_rows=[], disease_rows=[], stats=stats)[0]
        self.assertEqual(json.loads(row["fields"]["Source disease annotation rows"]), [])
        self.assertEqual(row["title"], "TEST1: OMIM:123")
        self.assertEqual(stats["geneDiseaseRecordsWithoutPhenotypeAnnotations"], 1)

    def test_unknown_qualifier_fails_instead_of_becoming_present(self):
        invalid = ["OMIM:123", "Synthetic disease", "UNKNOWN", "HP:0000001", "PMID:1234", "PCS", "", "", "", "", "P", "curator"]
        with self.assertRaisesRegex(ValueError, "qualifier"):
            records(disease_rows=[invalid])

    def test_source_symbols_are_preserved_separately_when_tables_differ(self):
        source = ["123", "OTHER1", "HP:0000007", "Autosomal recessive inheritance", "-", "OMIM:123"]
        row = records(phenotype_rows=[source])[0]
        self.assertEqual(row["gene"], "TEST1, OTHER1")
        self.assertEqual(json.loads(row["fields"]["Source gene phenotype rows"])[0][1], "OTHER1")

    def test_unmapped_phenotype_relationship_is_never_invented(self):
        source = ["124", "OTHER1", "HP:0000007", "Autosomal recessive inheritance", "-", "OMIM:123"]
        with self.assertRaisesRegex(ValueError, "lacks its source disease mapping"):
            records(phenotype_rows=[source])

    def test_unmapped_disease_annotations_are_counted(self):
        source = ["OMIM:456", "Other disease", "NOT", "HP:0000001", "PMID:1234", "PCS", "", "", "", "", "P", "curator"]
        stats = collections.Counter()
        records(disease_rows=[source], stats=stats)
        self.assertEqual(stats["diseaseRowsWithoutGeneMapping"], 1)
        self.assertEqual(stats["sourceNegatedRows"], 1)
        self.assertEqual(stats["attachedNegatedRows"], 0)

    def test_changed_table_columns_and_malformed_rows_fail(self):
        for source in ("wrong\tcolumns\n", "\t".join(GENE_COLUMNS) + "\na\tb\n"):
            with self.assertRaises(ValueError):
                list(read_table(io.StringIO(source), GENE_COLUMNS))

    def test_ontology_names_do_not_create_ancestor_annotations(self):
        raw = "[Term]\nid: HP:0000001\nname: Root\n[Term]\nid: HP:0000002\nname: Child\nis_a: HP:0000001 ! Root\n"
        self.assertEqual(ontology_names(io.StringIO(raw)), {"HP:0000001": "Root", "HP:0000002": "Child"})
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            ontology_names(io.StringIO(raw + "[Term]\nid: HP:0000002\nname: Different\n"))

    def test_reference_links_never_follow_source_text(self):
        mapping = ["NCBIGene:123", "TEST1", "MENDELIAN", "OMIM:123", "javascript:bad()"]
        row = records(gene_rows=[mapping])[0]
        self.assertEqual(row["url"], REPOSITORY + "/releases/tag/" + DEFAULT_RELEASE)
        self.assertTrue(all(c["url"].startswith("https://pubmed.ncbi.nlm.nih.gov/") for c in row["citations"]))
        self.assertIn("javascript:bad()", row["fields"]["Source gene mapping rows"])

    def test_asset_host_and_published_hash_are_required_before_fetch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            metadata = {"tag_name": DEFAULT_RELEASE, "assets": [{"name": FILES[0], "digest": "sha256:" + "a" * 64,
                         "browser_download_url": "https://evil.example/genes_to_disease.txt", "size": 10}]}
            (path / "release.json").write_text(json.dumps(metadata))
            with patch("urllib.request.urlopen") as request:
                with self.assertRaisesRegex(ValueError, "verified official"):
                    fetch_inputs(path, DEFAULT_RELEASE)
                request.assert_not_called()

    def test_pinned_source_hash_detects_cached_file_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            expected = hashlib.sha256(b"original").hexdigest()
            metadata = {"tag_name": DEFAULT_RELEASE, "assets": [{"name": FILES[0], "digest": "sha256:" + expected,
                         "browser_download_url": REPOSITORY + "/releases/download/" + DEFAULT_RELEASE + "/" + FILES[0], "size": 8}]}
            (path / "release.json").write_text(json.dumps(metadata))
            (path / FILES[0]).write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "published identity"):
                fetch_inputs(path, DEFAULT_RELEASE)

    def test_main_catalog_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "main reference catalog"):
                prepare(directory, directory, "v1", output_manifest=Path(directory) / "manifest.json")


if __name__ == "__main__":
    unittest.main()
