"""Minimal PNG reader for the silhouette masks: 8-bit grayscale, non-interlaced only.

Stdlib zlib plus numpy, no imaging dependency. The file is untrusted: every
chunk length is bounds-checked, every CRC verified, and the inflated stream is
capped at exactly the size the header implies, so a zlib bomb cannot allocate
past it. Errors are ValueError with generic text (no file contents).
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass

import numpy as np

SIGNATURE = b"\x89PNG\r\n\x1a\n"
COLOR_GRAYSCALE = 0


@dataclass(frozen=True)
class PngHeader:
    width: int
    height: int
    bit_depth: int
    color_type: int
    interlace: int


def _chunks(data: bytes):
    if data[:8] != SIGNATURE:
        raise ValueError("not a PNG")
    pos, n = 8, len(data)
    while True:
        if pos + 12 > n:
            raise ValueError("truncated PNG")
        length = int.from_bytes(data[pos : pos + 4], "big")
        kind = data[pos + 4 : pos + 8]
        end = pos + 8 + length
        if end + 4 > n:
            raise ValueError("truncated PNG")
        body = data[pos + 8 : end]
        if zlib.crc32(kind + body) != int.from_bytes(data[end : end + 4], "big"):
            raise ValueError("corrupt PNG")
        yield kind, body
        if kind == b"IEND":
            return
        pos = end + 4


def _parse_ihdr(body: bytes) -> PngHeader:
    if len(body) != 13:
        raise ValueError("corrupt PNG")
    width = int.from_bytes(body[0:4], "big")
    height = int.from_bytes(body[4:8], "big")
    if width == 0 or height == 0 or body[10] != 0 or body[11] != 0:
        raise ValueError("corrupt PNG")
    return PngHeader(width, height, bit_depth=body[8], color_type=body[9], interlace=body[12])


def png_header(data: bytes) -> PngHeader:
    """The IHDR fields; IHDR must be the first chunk."""
    kind, body = next(_chunks(data))
    if kind != b"IHDR":
        raise ValueError("corrupt PNG")
    return _parse_ihdr(body)


def decode_gray8(data: bytes) -> np.ndarray:
    """(height, width) uint8 pixels of an 8-bit grayscale, non-interlaced PNG."""
    chunks = _chunks(data)
    kind, body = next(chunks)
    if kind != b"IHDR":
        raise ValueError("corrupt PNG")
    header = _parse_ihdr(body)
    if (header.bit_depth, header.color_type, header.interlace) != (8, COLOR_GRAYSCALE, 0):
        raise ValueError("PNG is not 8-bit grayscale non-interlaced")
    idat = b"".join(body for kind, body in chunks if kind == b"IDAT")  # runs to IEND

    w, h = header.width, header.height
    expected = h * (w + 1)  # one filter-type byte per row
    inflater = zlib.decompressobj()
    try:
        raw = inflater.decompress(idat, expected)
    except zlib.error as exc:
        raise ValueError("corrupt PNG") from exc
    if len(raw) != expected or inflater.unconsumed_tail:
        raise ValueError("corrupt PNG")
    return _unfilter(np.frombuffer(raw, dtype=np.uint8).reshape(h, w + 1))


def _unfilter(rows: np.ndarray) -> np.ndarray:
    """PNG filter reconstruction (spec section 9) for one byte per pixel."""
    h, w = rows.shape[0], rows.shape[1] - 1
    out = np.empty((h, w), dtype=np.uint8)
    prev = np.zeros(w, dtype=np.uint8)
    for y in range(h):
        kind, line = int(rows[y, 0]), rows[y, 1:]
        if kind == 0:
            cur = line.copy()
        elif kind == 1:  # Sub: running sum mod 256
            cur = np.cumsum(line, dtype=np.uint8)
        elif kind == 2:  # Up
            cur = line + prev
        elif kind in (3, 4):
            # ponytail: per-pixel Python loop, about 1 s for a 1920x1440 mask filtered
            # entirely with Average/Paeth; vectorize if it shows up in job latency.
            cur = np.frombuffer(_sequential(kind, line.tolist(), prev.tolist()), dtype=np.uint8)
        else:
            raise ValueError("corrupt PNG")
        out[y] = cur
        prev = cur
    return out


def _sequential(kind: int, line: list[int], up: list[int]) -> bytes:
    cur = bytearray(len(line))
    left = up_left = 0
    for i, x in enumerate(line):
        b = up[i]
        if kind == 3:
            pred = (left + b) >> 1
        else:
            p = left + b - up_left
            pa, pb, pc = abs(p - left), abs(p - b), abs(p - up_left)
            pred = left if pa <= pb and pa <= pc else (b if pb <= pc else up_left)
        left = (x + pred) & 0xFF
        cur[i] = left
        up_left = b
    return bytes(cur)
