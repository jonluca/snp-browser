#!/usr/bin/env python3
"""Select official RefSNP records for identifiers in a fixed public sites VCF."""

import argparse
import io
import json
import re
from pathlib import Path

from adapters import open_text, rsids
from build import now, sha256_file


def source_stream(source_path, bz2_threads):
    if not bz2_threads:
        return open_text(source_path)
    if bz2_threads < 1 or not str(source_path).endswith(".bz2"):
        raise ValueError("--bz2-threads requires a positive count and a .bz2 source")
    try:
        import indexed_bzip2
    except ImportError as error:
        raise RuntimeError("Optional parallel decoding requires indexed_bzip2 in the selected Python environment") from error
    raw = indexed_bzip2.IndexedBzip2File(str(source_path), parallelization=bz2_threads)
    return io.TextIOWrapper(io.BufferedReader(raw, buffer_size=1024 * 1024), encoding="utf-8-sig")


def select(source_path, public_vcf, output_path, bz2_threads=0):
    output_path = Path(output_path)
    if output_path.resolve() in (Path(source_path).resolve(), Path(public_vcf).resolve()):
        raise ValueError("Selection output must not overwrite a public source file")
    identifiers = set()
    with open_text(public_vcf) as stream:
        for line in stream:
            if line.startswith("#"):
                if line.startswith("#CHROM") and len(line.rstrip().split("\t")) != 8:
                    raise ValueError("Identifier selection requires a public sites-only VCF")
                continue
            cols = line.rstrip("\r\n").split("\t")
            if len(cols) != 8:
                raise ValueError("Identifier selection requires an eight-column sites VCF")
            identifiers.update(str(int(snp[2:])) for snp in rsids(cols[2]) if int(snp[2:]) > 0)
    if not identifiers:
        raise ValueError("No explicit public rsIDs in selection VCF")
    pattern = re.compile(r'"refsnp_id"\s*:\s*"?(\d+)"?')
    found = set()
    source_rows = 0
    temporary = output_path.with_name(output_path.name + ".part")
    try:
        with source_stream(source_path, bz2_threads) as incoming, temporary.open("w") as outgoing:
            for line in incoming:
                if not line.strip():
                    continue
                source_rows += 1
                match = pattern.search(line)
                if match and str(int(match[1])) in identifiers:
                    row = json.loads(line)
                    identifier = str(int(row["refsnp_id"]))
                    if identifier in identifiers:
                        outgoing.write(line)
                        if not line.endswith("\n"):
                            outgoing.write("\n")
                        found.add(identifier)
                if source_rows % 1000000 == 0:
                    print("Scanned %s public RefSNP rows; matched %s/%s identifiers" % (source_rows, len(found), len(identifiers)), flush=True)
        temporary.replace(output_path)
        report = {"preparedAt": now(), "source": Path(source_path).name, "sourceSha256": sha256_file(source_path),
                  "publicSelection": Path(public_vcf).name, "publicSelectionSha256": sha256_file(public_vcf),
                  "sourceRows": source_rows, "requestedIdentifiers": len(identifiers), "matchedIdentifiers": len(found),
                  "decoder": "indexed_bzip2" if bz2_threads else "stdlib", "decoderThreads": bz2_threads or 1,
                  "missingIdentifiers": ["rs" + i for i in sorted(identifiers - found, key=int)],
                  "selection": "Explicit rsIDs from a fixed public sites-only VCF; no user variants or user-specific API requests."}
        output_path.with_name(output_path.name + ".selection.json").write_text(json.dumps(report, indent=2) + "\n")
        return report
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--public-vcf", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--bz2-threads", type=int, default=0, help="Optional parallel indexed_bzip2 decoder; zero uses the dependency-free stdlib")
    args = parser.parse_args()
    report = select(args.input, args.public_vcf, args.output, args.bz2_threads)
    print(json.dumps({key: value for key, value in report.items() if key != "missingIdentifiers"}, indent=2))
