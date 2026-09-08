import hashlib
import gzip
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters import (annotation, clinvar_tsv, cpic_json, dbsnp_json, ensembl_json,
                      ensembl_tsv, gwas_tsv, json_records, clinpgx_rows, vcf_annotations)
from adapters import ensembl_vcf
from build import build_pack, merge_manifests, ordered_annotations, refresh_routing
from compact import compact_catalog, verify_gzip
from routing import create_routing, hash_pair, positions, row_keys
from select_public_vcf import select as select_vcf
from select_refsnp import select as select_refsnp
from prepare_public import vcf_prefix, main as prepare_public_main, validate_existing_pack

META = {key: "https://example.org/" if key in ("homepage", "licenseUrl") else "Test"
        for key in ("name", "description", "homepage", "license", "licenseUrl", "attribution")}


class AdaptersTest(unittest.TestCase):
    def test_short_public_download_never_becomes_a_cached_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.vcf"
            raw = b'#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n22\t1\trs2\tA\tC\t.\tPASS\tAF=0.1\n'
            with patch("urllib.request.urlopen", return_value=io.BytesIO(gzip.compress(raw))):
                with self.assertRaisesRegex(ValueError, "sample size"):
                    vcf_prefix("https://example.org/public.vcf.gz", path, 2)
            self.assertFalse(path.exists())
            self.assertFalse(path.with_name("sample.vcf.part").exists())

    def test_multiallelic_frequency_uses_header_number(self):
        raw = "##INFO=<ID=AF,Number=A,Type=Float>\n##INFO=<ID=AN,Number=1,Type=Integer>\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\nchr22\t20\trs12\tA\tC,G\t.\tPASS\tAF=0.1,0.2;AN=100;SpliceAI=third-party\n"
        rows = list(vcf_annotations("gnomad", io.StringIO(raw), "GRCh38"))
        self.assertEqual([r["fields"]["AF"] for r in rows], ["0.1", "0.2"])
        self.assertEqual([r["alt"] for r in rows], ["C", "G"])
        self.assertNotIn("SpliceAI", rows[0]["fields"])
        self.assertEqual(rows[0]["scope"], "allele")

    def test_vcf_never_guesses_assembly(self):
        with self.assertRaisesRegex(ValueError, "requires --assembly"):
            list(vcf_annotations("clinvar", io.StringIO(""), None))

    def test_clinvar_id_is_not_rsid_and_multiallelic_is_context(self):
        raw = "1\t20\t123\tA\tC,G\t.\t.\tCLNSIG=Benign;RS=456;CLNREVSTAT=criteria_provided;GENEINFO=GENE1:1|GENE2:2\n"
        rows = list(vcf_annotations("clinvar", io.StringIO(raw), "GRCh37"))
        self.assertEqual(rows[0]["rsid"], "rs456")
        self.assertEqual(rows[0]["scope"], "variant")
        self.assertEqual(rows[0]["gene"], "GENE1, GENE2")
        self.assertIn("/variation/123/", rows[0]["url"])

    def test_clinvar_tsv_uses_vcf_position_not_hgvs_start(self):
        raw = "#AlleleID\tVariationID\tAssembly\tChromosome\tStart\tPositionVCF\tReferenceAlleleVCF\tAlternateAlleleVCF\tRS# (dbSNP)\tClinicalSignificance\n1\t2\tGRCh38\t1\t101\t100\tAT\tA\t3\tBenign\n"
        row = list(clinvar_tsv(io.StringIO(raw), "GRCh38"))[0]
        self.assertEqual(row["position"], 100)
        self.assertEqual(row["ref"], "AT")
        self.assertEqual(row["rsid"], "rs3")

    def test_refsnp_spdi_position_and_aliases(self):
        raw = {"refsnp_id": "123", "dbsnp1_merges": [{"merged_rsid": "12"}], "primary_snapshot_data": {"placements_with_allele": [{"seq_id": "NC_000001.11", "placement_annot": {"seq_id_traits_by_assembly": [{"assembly_name": "GRCh38.p14", "is_top_level": True}]}, "alleles": [{"allele": {"spdi": {"position": 99, "deleted_sequence": "A", "inserted_sequence": "C"}}}]}]}}
        row = list(dbsnp_json(io.StringIO(json.dumps(raw)), None))[0]
        self.assertEqual((row["position"], row["assembly"], row["aliases"]), (100, "GRCh38", ["rs12"]))

    def test_refsnp_merges_have_alias_without_invented_coordinates(self):
        raw = {"refsnp_id": "1", "merged_snapshot_data": {"merged_into": [2]}}
        row = list(dbsnp_json(io.StringIO(json.dumps(raw)), None))[0]
        self.assertEqual((row["rsid"], row["aliases"], row["scope"]), ("rs2", ["rs1"], "variant"))

    def test_gwas_does_not_promote_reported_risk_allele_to_personal_match(self):
        raw = "SNPS\tSTRONGEST SNP-RISK ALLELE\tCHR_ID\tCHR_POS\tDISEASE/TRAIT\tOR or BETA\nrs3\trs3-T\t1\t5\tA trait\t1.2\n"
        row = list(gwas_tsv(io.StringIO(raw), "GRCh38"))[0]
        self.assertEqual(row["scope"], "variant")
        self.assertNotIn("alt", row)
        self.assertEqual(row["fields"]["OR or BETA"], "1.2")

    def test_vep_preserves_each_transcript(self):
        raw = [{"id": "rs4", "assembly_name": "GRCh38", "seq_region_name": "1", "start": 20, "allele_string": "A/C", "transcript_consequences": [{"transcript_id": name, "gene_symbol": "GENE", "variant_allele": "C", "consequence_terms": ["missense_variant"]} for name in ["t1", "t2"]]}]
        rows = list(ensembl_json(io.StringIO(json.dumps(raw)), None))
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0]["id"], rows[1]["id"])
        self.assertEqual(rows[0]["scope"], "allele")

    def test_vep_tab_without_reference_allele_is_context(self):
        raw = "#Uploaded_variation\tLocation\tAllele\tGene\tConsequence\tExisting_variation\tExtra\nrs4\t1:20\tC\tENSG1\tmissense_variant\trs4\tSYMBOL=GENE;IMPACT=MODERATE\n"
        row = list(ensembl_tsv(io.StringIO(raw), "GRCh38"))[0]
        self.assertEqual((row["scope"], row["gene"]), ("variant", "GENE"))

    def test_clinpgx_and_cpic_never_infer_diplotype(self):
        clin = list(clinpgx_rows([{"Clinical Annotation ID": "1", "Variant/Haplotypes": "rs4", "Gene": "CYP2C19", "Drug(s)": "clopidogrel", "Level of Evidence": "1A"}]))[0]
        cpic = list(cpic_json(io.StringIO('[{"pairid":1,"genesymbol":"CYP2C19","drugname":"clopidogrel","cpiclevel":"A"}]')))[0]
        self.assertEqual((clin["scope"], cpic["scope"]), ("variant", "gene"))
        self.assertNotIn("alt", clin)
        self.assertNotIn("rsid", cpic)

    def test_cpic_pair_without_guideline_is_evidence_context(self):
        row = list(cpic_json(io.StringIO('[{"pairid":123,"genesymbol":"APOE","drugname":"atorvastatin","cpiclevel":"D","pmids":null,"guidelineurl":null,"usedforrecommendation":"No"}]')))[0]
        self.assertEqual(row["title"], "APOE · atorvastatin")
        self.assertTrue(row["summary"].startswith("Gene–drug evidence context"))
        self.assertEqual(row["url"], "https://api.cpicpgx.org/v1/pair_view?pairid=eq.123")
        self.assertEqual(row["reviewStatus"], "D")

    def test_json_stream_handles_array_jsonl_and_truncation(self):
        for raw in ['[{"x":1},{"x":2}]', '{"x":1}\n{"x":2}\n']:
            self.assertEqual(list(json_records(io.StringIO(raw))), [{"x": 1}, {"x": 2}])
        for raw in ['{"x":', '[{"x":1}', '[{"x":1},]', '[{"x":1} {"x":2}]']:
            with self.assertRaises(ValueError):
                list(json_records(io.StringIO(raw)))

    def test_clinpgx_public_api_envelope_and_nested_location(self):
        raw = {"status": "success", "data": [{"id": 123, "objCls": "VariantDrugAnnotation", "location": {"rsid": "rs4", "genes": [{"name": "CYP2C19"}]}, "relatedChemicals": [{"name": "clopidogrel"}], "sentence": "Source annotation text"}]}
        row = list(clinpgx_rows([raw]))[0]
        self.assertEqual((row["rsid"], row["gene"], row["scope"]), ("rs4", "CYP2C19", "variant"))
        self.assertEqual(row["title"], "clopidogrel drug-response evidence")

    def test_vep_vcf_preserves_source_version_and_allele_number(self):
        raw = '##INFO=<ID=AF,Number=A,Type=Float>\n##INFO=<ID=vep,Number=.,Type=String,Description="Format: Allele|Consequence|SYMBOL|Feature|ALLELE_NUM|CANONICAL|LoF">\n##vep_version=v105\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n22\t20\trs4\tA\tC,G\t.\tPASS\tAF=0.01,0.2;vep=C|missense_variant|GENE|t1|1|YES|HC,G|intron_variant|GENE|t2|2|YES|\n'
        rows = list(ensembl_vcf(io.StringIO(raw), "GRCh38"))
        self.assertEqual([(r["alt"], r["fields"]["Feature"], r["fields"]["AF"]) for r in rows], [("C", "t1", "0.01"), ("G", "t2", "0.2")])
        self.assertEqual(rows[0]["fields"]["VEP version"], "v105")
        self.assertNotIn("LoF", rows[0]["fields"])

    def test_population_selection_uses_only_public_sites_and_qc(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.vcf"
            output = Path(directory) / "selected.vcf"
            source.write_text('#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n22\t1\trs1\tA\tC\t.\tPASS\tAF=0.1\n22\t2\trs2\tA\tC\t.\tFAIL\tAF=0.1\n22\t3\trs3\tA\tC\t.\tPASS\tAF=0.0001\n')
            report = select_vcf(source, output)
            self.assertEqual((report["sourceRows"], report["selectedRows"]), (3, 1))
            self.assertIn("rs1", output.read_text())
            self.assertNotIn("rs2", output.read_text())
            source.write_text('#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE\n')
            with self.assertRaisesRegex(ValueError, "sites-only"):
                select_vcf(source, output)

    def test_official_refsnp_subset_preserves_raw_selected_records(self):
        with tempfile.TemporaryDirectory() as directory:
            vcf = Path(directory) / "public.vcf"
            source = Path(directory) / "refsnp.jsonl"
            output = Path(directory) / "selected.jsonl"
            vcf.write_text('#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n22\t1\trs2\tA\tC\t.\tPASS\tAF=0.1\n')
            rows = [{"refsnp_id": str(i), "dbsnp1_merges": [{"merged_rsid": "99"}]} for i in (1, 2)]
            source.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
            report = select_refsnp(source, vcf, output)
            self.assertEqual((report["sourceRows"], report["matchedIdentifiers"]), (2, 1))
            self.assertEqual(json.loads(output.read_text()), rows[1])


class PackTest(unittest.TestCase):
    def make_record(self, i):
        return annotation("dbsnp", str(i), "Reference " + str(i), "https://example.org/" + str(i),
                          rsid="rs" + str(i), aliases=["rs" + str(10000 + i)], fields={"large": "x" * 1200})

    def test_shard_bounds_checksums_aliases_global_dedupe(self):
        with tempfile.TemporaryDirectory() as directory:
            records = [self.make_record(i) for i in range(100)]
            metadata = {**META, "sourceRelease": "Verified upstream release"}
            result = build_pack(iter(records + records[:1]), directory, "dbsnp", "test", "Synthetic test", metadata, max_bytes=65536)
            pack = result["packs"][0]
            self.assertEqual(pack["sourceRelease"], "Verified upstream release")
            self.assertEqual(pack["recordCount"], 100)
            self.assertGreater(len(pack["shards"]), 1)
            total = 0
            for shard in pack["shards"]:
                path = Path(directory) / shard["url"].removeprefix("/references/")
                self.assertLessEqual(path.stat().st_size, 65536)
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), shard["sha256"])
                with closing(sqlite3.connect(path)) as db:
                    self.assertEqual(db.execute("PRAGMA quick_check").fetchone()[0], "ok")
                    self.assertEqual(db.execute("SELECT count(*) FROM aliases").fetchone()[0], shard["records"])
                    total += db.execute("SELECT count(*) FROM annotations").fetchone()[0]
            self.assertEqual(total, 100)

    def test_pack_paths_reject_dot_segments(self):
        with tempfile.TemporaryDirectory() as directory:
            for value in (".", "..", "../outside"):
                with self.assertRaisesRegex(ValueError, "version"):
                    build_pack([self.make_record(1)], directory, "dbsnp", value, "Test", META)
                with self.assertRaisesRegex(ValueError, "pack id"):
                    build_pack([self.make_record(1)], directory, "dbsnp", "valid", "Test", META, pack_id=value)
            self.assertFalse(list(Path(directory).iterdir()))

    def test_lossless_catalog_compaction_and_compressed_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata = {**META, "sourceRelease": "Original source release"}
            original = build_pack([self.make_record(i) for i in range(40)], root, "dbsnp", "test", "Test", metadata, max_bytes=65536)
            raw_directory = root / "dbsnp/test"
            (raw_directory / "LICENSE.txt").write_text("Original source terms")
            (raw_directory / "provenance.json").write_text('{"upstream":"original"}\n')
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps(original))
            original_bytes = {path.name: path.read_bytes() for path in raw_directory.iterdir()}
            compressed = compact_catalog(manifest, level=9, jobs=2)
            pack = compressed["packs"][0]
            self.assertEqual(pack["recordCount"], 40)
            self.assertEqual(pack["sourceRelease"], "Original source release")
            new_directory = root / "dbsnp/test-gzip-v1"
            self.assertEqual((new_directory / "LICENSE.txt").read_text(), "Original source terms")
            self.assertEqual(json.loads((new_directory / "provenance.json").read_text())["upstream"], "original")
            for old, new in zip(original["packs"][0]["shards"], pack["shards"]):
                self.assertTrue(new["url"].endswith(".sqlite.gzip"))
                data = (root / new["url"].removeprefix("/references/")).read_bytes()
                self.assertEqual(gzip.decompress(data), original_bytes[old["url"].rsplit("/", 1)[-1]])
                self.assertEqual((data[3], data[4:8]), (0, b"\0" * 4))
                self.assertEqual((new["compression"]["uncompressedBytes"], new["compression"]["uncompressedSha256"]), (old["bytes"], old["sha256"]))
                self.assertEqual(new["routing"], old["routing"])
                self.assertEqual(hashlib.sha256(data).hexdigest(), new["sha256"])
            self.assertEqual({path.name: path.read_bytes() for path in raw_directory.iterdir()}, original_bytes)
            validate_existing_pack(new_directory / "manifest.json", "dbsnp", "test-gzip-v1")
            raw_catalog = root / "original-manifest.json"
            raw_catalog.write_text(json.dumps(original))
            with self.assertRaisesRegex(ValueError, "Immutable version already exists"):
                compact_catalog(raw_catalog)
            second = compact_catalog(raw_catalog, suffix="-gzip-v2", level=9, jobs=2,
                                     output_manifest=root / "second-manifest.json")
            self.assertEqual([s["sha256"] for s in pack["shards"]],
                             [s["sha256"] for s in second["packs"][0]["shards"]])
            with self.assertRaisesRegex(ValueError, "Compressed shards"):
                refresh_routing(new_directory / "manifest.json")
            with self.assertRaisesRegex(ValueError, "already contains compressed"):
                compact_catalog(manifest)
            bad = json.loads((new_directory / "manifest.json").read_text())
            bad["packs"][0]["shards"][0]["compression"]["uncompressedSha256"] = "0" * 64
            (new_directory / "manifest.json").write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, "Decoded shard SHA-256 mismatch.*new unused --version"):
                validate_existing_pack(new_directory / "manifest.json", "dbsnp", "test-gzip-v1")

    def test_compaction_corruption_does_not_publish_or_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = build_pack([self.make_record(i) for i in range(40)], root, "dbsnp", "test", "Test", META, max_bytes=65536)
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps(original))
            catalog_bytes = manifest.read_bytes()
            last = root / original["packs"][0]["shards"][-1]["url"].removeprefix("/references/")
            corrupted = b"X" + last.read_bytes()[1:]
            last.write_bytes(corrupted)
            with self.assertRaisesRegex(ValueError, "Original shard SHA-256"):
                compact_catalog(manifest, jobs=2)
            self.assertEqual(manifest.read_bytes(), catalog_bytes)
            self.assertEqual(last.read_bytes(), corrupted)
            self.assertFalse((root / "dbsnp/test-gzip-v1").exists())
            self.assertFalse(list(root.glob(".reference-compress-*")))

    def test_gzip_verification_rejects_truncation_extra_members_and_size_overrun(self):
        data = b"reference bytes" * 10000
        digest = hashlib.sha256(data).hexdigest()
        compressed = gzip.compress(data, mtime=0)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "shard.sqlite.gzip"
            for name, value in (("truncated", compressed[:-8]), ("concatenated", compressed * 2), ("trailing", compressed + b"extra")):
                with self.subTest(name=name):
                    path.write_bytes(value)
                    with self.assertRaises(ValueError):
                        verify_gzip(path, len(data), digest)
            path.write_bytes(compressed)
            with self.assertRaisesRegex(ValueError, "exceeds its declared size"):
                verify_gzip(path, 1, digest)
            verify_gzip(path, len(data), digest)

    def test_prepare_reuses_only_complete_checksum_verified_packs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_pack([self.make_record(1)], root, "dbsnp", "test", "Test", META)
            manifest = root / "dbsnp/test/manifest.json"
            shard = manifest.parent / "part-00001.sqlite"
            original_shard = shard.read_bytes()
            original_manifest = manifest.read_bytes()
            argv = ["prepare_public.py", "--output", str(root), "--cache", str(root / "cache"), "--version", "test", "--sources", "dbsnp"]
            with patch.object(sys, "argv", argv), patch("prepare_public.get_file") as download:
                prepare_public_main()
                download.assert_not_called()
            catalog = (root / "manifest.json").read_bytes()
            self.assertEqual(json.loads(catalog)["packs"][0]["recordCount"], 1)
            for state, contents, reason in (("missing", None, "Missing shard"),
                                             ("truncated", original_shard[:-1], "size mismatch"),
                                             ("same-size corruption", b"X" + original_shard[1:], "SHA-256 mismatch")):
                with self.subTest(state=state):
                    shard.unlink(missing_ok=True)
                    if contents is not None:
                        shard.write_bytes(contents)
                    with patch.object(sys, "argv", argv), patch("prepare_public.get_file") as download:
                        with self.assertRaisesRegex(ValueError, reason + ".*new unused --version"):
                            prepare_public_main()
                        download.assert_not_called()
                    self.assertEqual(manifest.read_bytes(), original_manifest)
                    self.assertEqual((root / "manifest.json").read_bytes(), catalog)
                    self.assertEqual(shard.read_bytes() if shard.exists() else None, contents)

    def test_failed_build_does_not_publish_partial_version(self):
        with tempfile.TemporaryDirectory() as directory:
            other = self.make_record(1)
            other["title"] = "conflict"
            with self.assertRaisesRegex(ValueError, "Conflicting"):
                build_pack([self.make_record(1), other], directory, "dbsnp", "test", "Test", META)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_manifest_merge_rejects_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            path.write_text(json.dumps({"schemaVersion": 1, "packs": [{"id": "dbsnp"}]}))
            with self.assertRaisesRegex(ValueError, "Duplicate pack"):
                merge_manifests([path, path], Path(directory) / "out.json")

    def test_routing_normalizes_identifiers_coordinates_and_genes(self):
        keys = set(row_keys("RS000123", "GRCh38", "chrM", "20", "CYP2C19; HLA-B, APOE - TOMM40"))
        self.assertTrue({"r:rs123", "l:GRCh38:MT:20", "g:CYP2C19", "g:HLA-B", "g:APOE", "g:TOMM40"}.issubset(keys))
        self.assertEqual(list(row_keys("rs0", None, None, 0, None)), [])

    def test_routing_has_no_false_negatives(self):
        import base64
        keys = ["r:rs" + str(i) for i in range(1, 500)]
        result = create_routing(keys)
        bits = base64.b64decode(result["bits"])
        self.assertEqual(result["hashes"], 7)
        self.assertEqual(len(bits) * 8, result["bitCount"])
        for key in keys:
            self.assertTrue(all(bits[bit >> 3] & (1 << (bit & 7)) for bit in positions(key, result["bitCount"])))

    def test_routing_matches_browser_golden_fixture(self):
        import base64
        fixture = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/reference-routing-golden.json").read_text())
        bit_count = fixture["routing"]["bitCount"]
        bits = bytearray(bit_count // 8)
        for entry in fixture["entries"]:
            self.assertEqual(hash_pair(entry["key"]), (entry["h1"], entry["h2"]))
            self.assertEqual(list(positions(entry["key"], bit_count)), entry["positions"])
            for bit in positions(entry["key"], bit_count):
                bits[bit >> 3] |= 1 << (bit & 7)
        self.assertEqual(base64.b64encode(bits).decode(), fixture["routing"]["bits"])

    def test_variant_grouping_preserves_records_and_reduces_shard_scatter(self):
        with tempfile.TemporaryDirectory() as directory:
            records = [self.make_record(i) for i in range(60)]
            for i, record in enumerate(records):
                record["rsid"] = "rs1" if i % 2 else "rs2"
            with ordered_annotations(records, directory) as ordered:
                result = list(ordered)
            self.assertEqual({r["id"] for r in result}, {r["id"] for r in records})
            self.assertEqual([r["rsid"] for r in result], ["rs1"] * 30 + ["rs2"] * 30)
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
