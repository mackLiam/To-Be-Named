"""The minimal PNG reader behind the silhouette masks: filters, header, hostile input."""

from __future__ import annotations

import zlib

import numpy as np
import pytest

from forms_pipeline.reconstruct.png import SIGNATURE, decode_gray8, png_header


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)


def _filter_row(kind: int, row: list[int], prev: list[int]) -> list[int]:
    """Forward PNG filter (the encoder side), written independently of the decoder."""
    out = []
    for i, x in enumerate(row):
        a = row[i - 1] if i else 0
        b = prev[i]
        c = prev[i - 1] if i else 0
        pred = [0, a, b, (a + b) // 2, _paeth(a, b, c)][kind]
        out.append((x - pred) % 256)
    return out


def _chunk(kind: bytes, body: bytes, crc: int | None = None) -> bytes:
    crc = zlib.crc32(kind + body) if crc is None else crc
    return len(body).to_bytes(4, "big") + kind + body + crc.to_bytes(4, "big")


def _ihdr(w: int, h: int, depth: int = 8, color: int = 0, interlace: int = 0) -> bytes:
    return _chunk(
        b"IHDR",
        w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([depth, color, 0, 0, interlace]),
    )


def encode(pixels: np.ndarray, filters: list[int], split_idat: int = 1, **ihdr) -> bytes:
    h, w = pixels.shape
    raw = bytearray()
    prev = [0] * w
    for y in range(h):
        row = pixels[y].tolist()
        raw.append(filters[y % len(filters)])
        raw.extend(_filter_row(filters[y % len(filters)], row, prev))
        prev = row
    data = zlib.compress(bytes(raw))
    step = -(-len(data) // split_idat)
    idats = b"".join(_chunk(b"IDAT", data[i : i + step]) for i in range(0, len(data), step))
    return SIGNATURE + _ihdr(w, h, **ihdr) + idats + _chunk(b"IEND", b"")


@pytest.fixture
def pixels() -> np.ndarray:
    return np.random.default_rng(0).integers(0, 256, (9, 13), dtype=np.uint8)


@pytest.mark.parametrize("kind", [0, 1, 2, 3, 4], ids=["none", "sub", "up", "average", "paeth"])
def test_each_filter_type_round_trips(pixels: np.ndarray, kind: int) -> None:
    assert np.array_equal(decode_gray8(encode(pixels, [kind])), pixels)


def test_mixed_filters_and_split_idat_round_trip(pixels: np.ndarray) -> None:
    data = encode(pixels, [4, 0, 3, 1, 2], split_idat=3)
    assert np.array_equal(decode_gray8(data), pixels)


def test_binary_mask_round_trips() -> None:
    mask = np.zeros((40, 60), dtype=np.uint8)
    mask[5:30, 10:50] = 255
    assert np.array_equal(decode_gray8(encode(mask, [1, 2, 3, 4])), mask)


def test_header_reports_ihdr_fields() -> None:
    data = encode(np.zeros((3, 5), dtype=np.uint8), [0])
    header = png_header(data)
    assert (header.width, header.height, header.bit_depth, header.color_type) == (5, 3, 8, 0)


def _with_body(pixels: np.ndarray, raw: bytes, **ihdr) -> bytes:
    h, w = pixels.shape
    return (
        SIGNATURE + _ihdr(w, h, **ihdr) + _chunk(b"IDAT", zlib.compress(raw)) + _chunk(b"IEND", b"")
    )


@pytest.mark.parametrize(
    "ihdr",
    [{"color": 2}, {"depth": 16}, {"interlace": 1}],
    ids=["rgb", "16-bit", "interlaced"],
)
def test_unsupported_formats_are_rejected(pixels: np.ndarray, ihdr: dict) -> None:
    raw = b"".join(b"\x00" + bytes(r) for r in pixels.tolist())
    with pytest.raises(ValueError, match="grayscale"):
        decode_gray8(_with_body(pixels, raw, **ihdr))


def test_unknown_filter_type_is_rejected(pixels: np.ndarray) -> None:
    raw = b"".join(b"\x05" + bytes(r) for r in pixels.tolist())
    with pytest.raises(ValueError):
        decode_gray8(_with_body(pixels, raw))


def test_inflated_size_must_match_header_exactly(pixels: np.ndarray) -> None:
    raw = b"".join(b"\x00" + bytes(r) for r in pixels.tolist())
    with pytest.raises(ValueError):
        decode_gray8(_with_body(pixels, raw[:-1]))  # short
    with pytest.raises(ValueError):
        decode_gray8(_with_body(pixels, raw + b"\x00" * 10_000_000))  # bomb: stops at the cap


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: b"GIF89a" + d[6:],
        lambda d: d[:-6],
        lambda d: d[:20] + bytes([d[20] ^ 0xFF]) + d[21:],  # IHDR body byte, CRC now wrong
        lambda d: SIGNATURE + _chunk(b"IEND", b""),
        lambda d: SIGNATURE + _chunk(b"IHDR", b"\x00" * 13) + _chunk(b"IEND", b""),
    ],
    ids=["signature", "truncated", "crc", "no-ihdr", "zero-size"],
)
def test_corrupt_files_are_rejected(pixels: np.ndarray, mutate) -> None:
    with pytest.raises(ValueError):
        decode_gray8(mutate(encode(pixels, [0])))
