"""Public Bloom routing: filter candidate cached shards without user requests."""

import base64
import re
import sqlite3
from contextlib import closing
from pathlib import Path

from adapters import chromosome, positive_int


def row_keys(rsid, build, chrom, position, gene):
    if rsid:
        match = re.fullmatch(r"rs0*(\d+)", str(rsid).strip(), re.I)
        if match and int(match[1]) > 0:
            yield "r:rs" + str(int(match[1]))
    chrom = chromosome(chrom)
    position = positive_int(position)
    if build in ("GRCh37", "GRCh38") and chrom and position:
        yield "l:%s:%s:%d" % (build, chrom, position)
    if gene:
        value = str(gene).strip().upper()
        yield "g:" + value
        for symbol in re.split(r"[,;|]|\s+-\s+", value):
            if symbol.strip():
                yield "g:" + symbol.strip()


def hash_pair(value):
    h1, h2 = 2166136261, 2166136261 ^ 0x9e3779b9
    for byte in value.encode("utf-8"):
        h1 = ((h1 ^ byte) * 16777619) & 0xffffffff
        h2 = ((h2 ^ byte) * 16777619) & 0xffffffff
    return h1, h2 | 1


def positions(value, bit_count):
    h1, h2 = hash_pair(value)
    for index in range(7):
        yield ((h1 + index * h2) & 0xffffffff) % bit_count


def create_routing(keys):
    keys = set(keys)
    bit_count = (max(1024, len(keys) * 20) + 7) // 8 * 8
    if bit_count // 8 > 16 * 1024 * 1024:
        raise ValueError("Shard routing would exceed 16 MiB; reduce shard size")
    bits = bytearray(bit_count // 8)
    for key in keys:
        for bit in positions(key, bit_count):
            bits[bit >> 3] |= 1 << (bit & 7)
    # Verify every input key against the finished bitset. False negatives would
    # silently omit evidence, so fail the build if the routing invariant breaks.
    for key in keys:
        if not all(bits[bit >> 3] & (1 << (bit & 7)) for bit in positions(key, bit_count)):
            raise ValueError("Bloom routing omitted an inserted key")
    return {"algorithm": "fnv1a-double-v1", "bitCount": bit_count, "hashes": 7,
            "bits": base64.b64encode(bits).decode("ascii")}


def routing_for_shard(path):
    keys = set()
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)) as database:
        for row in database.execute("SELECT rsid,assembly,chromosome,position,gene FROM annotations"):
            keys.update(row_keys(*row))
        for (alias,) in database.execute("SELECT alias FROM aliases"):
            keys.update(row_keys(alias, None, None, None, None))
    return create_routing(keys)
