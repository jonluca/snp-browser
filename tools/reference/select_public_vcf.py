#!/usr/bin/env python3
"""Select a documented public population subset from a sites-only VCF."""

import argparse
import json
import math
from pathlib import Path

from adapters import open_text
from build import now, sha256_file


def select(input_path, output_path, minimum_af=0.001, pass_only=True):
    if not 0 <= minimum_af <= 1:
        raise ValueError("AF threshold must be between zero and one")
    source_rows = selected_rows = 0
    output_path = Path(output_path)
    if output_path.resolve() == Path(input_path).resolve():
        raise ValueError("Selection output must not overwrite the original public release")
    temporary = output_path.with_name(output_path.name + ".part")
    try:
        with open_text(input_path) as source, temporary.open("w") as target:
            for line in source:
                if line.startswith("#"):
                    if line.startswith("#CHROM") and len(line.rstrip().split("\t")) != 8:
                        raise ValueError("This command accepts public sites-only VCFs without individual sample columns")
                    target.write(line)
                    continue
                cols = line.rstrip("\r\n").split("\t")
                if len(cols) != 8:
                    raise ValueError("Expected eight-column sites-only VCF")
                source_rows += 1
                if pass_only and cols[6] != "PASS":
                    continue
                raw_af = next((part[3:] for part in cols[7].split(";") if part.startswith("AF=")), None)
                if not raw_af:
                    continue
                try:
                    frequencies = [float(value) for value in raw_af.split(",")]
                except ValueError:
                    continue
                if not any(math.isfinite(value) and value >= minimum_af for value in frequencies):
                    continue
                target.write(line)
                selected_rows += 1
        temporary.replace(output_path)
        report = {"preparedAt": now(), "input": Path(input_path).name, "inputSha256": sha256_file(input_path),
                  "sourceRows": source_rows, "selectedRows": selected_rows,
                  "minimumAF": minimum_af, "passOnly": pass_only,
                  "selection": "Public source rows with at least one ALT meeting AF threshold; apply the same per-allele threshold during pack build for multiallelic rows."}
        output_path.with_name(output_path.name + ".selection.json").write_text(json.dumps(report, indent=2) + "\n")
        return report
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--min-af", type=float, default=0.001)
    parser.add_argument("--include-filtered", action="store_true")
    args = parser.parse_args()
    print(json.dumps(select(args.input, args.output, args.min_af, not args.include_filtered), indent=2))
