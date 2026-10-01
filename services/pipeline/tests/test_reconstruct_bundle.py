from __future__ import annotations

import json

import numpy as np
import pytest
from test_reconstruct_synthetic import (
    camera_ring,
    capture_bytes,
    capture_doc,
    capture_info,
    fake_jpeg,
)

from forms_pipeline.reconstruct import BundleValidationError
from forms_pipeline.reconstruct.bundle import (
    MAX_CAPTURE_JSON_BYTES,
    MAX_IMAGES,
    MAX_JPEG_BYTES,
    MAX_PNG_BYTES,
    MAX_SILHOUETTE_IMAGES,
    METHOD_PHOTOGRAMMETRY,
    METHOD_SILHOUETTE,
    MIN_IMAGES,
    MIN_SILHOUETTE_IMAGES,
    STATIONS,
    CaptureInfo,
    jpeg_dimensions,
    parse_capture,
    validate_jpeg,
    validate_mask,
)


def test_valid_bundle_parses_column_major_poses() -> None:
    cams = camera_ring(24)
    bundle = parse_capture(capture_bytes(capture_doc(cams)))
    assert len(bundle.images) == 24
    first = bundle.images[0]
    assert first.file == "000.jpg"
    assert np.allclose(first.camera_to_world, cams["000.jpg"])
    assert (first.width, first.height) == (1920, 1440)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.update(format="forms.lidar-capture"),
        lambda d: d.update(version=2),
        lambda d: d.update(version="1"),
        lambda d: d.update(version=True),
        lambda d: d.pop("device"),
        lambda d: d.update(images="nope"),
    ],
    ids=["format", "version2", "version-str", "version-bool", "device", "images-type"],
)
def test_contract_header_violations_rejected(mutate) -> None:
    doc = capture_doc(camera_ring(24))
    mutate(doc)
    with pytest.raises(BundleValidationError, match="Please rescan"):
        parse_capture(capture_bytes(doc))


@pytest.mark.parametrize("count", [MIN_IMAGES - 1, MAX_IMAGES + 1])
def test_image_count_bounds(count: int) -> None:
    with pytest.raises(BundleValidationError, match="photos"):
        parse_capture(capture_bytes(capture_doc(camera_ring(count))))


@pytest.mark.parametrize("count", [MIN_IMAGES, MAX_IMAGES])
def test_image_count_bounds_inclusive(count: int) -> None:
    assert len(parse_capture(capture_bytes(capture_doc(camera_ring(count)))).images) == count


@pytest.mark.parametrize(
    "name",
    ["../000.jpg", "000.jpg/../../x", "1.jpg", "0000.jpg", "000.jpeg", "000.JPG", "000.jpg\n"],
)
def test_bad_file_names_rejected(name: str) -> None:
    doc = capture_doc(camera_ring(24))
    doc["images"][3]["file"] = name
    with pytest.raises(BundleValidationError, match="invalid file name"):
        parse_capture(capture_bytes(doc))


def test_duplicate_file_names_rejected() -> None:
    doc = capture_doc(camera_ring(24))
    doc["images"][3]["file"] = doc["images"][2]["file"]
    with pytest.raises(BundleValidationError, match="duplicate"):
        parse_capture(capture_bytes(doc))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("camera_to_world", [0.0] * 15),
        ("camera_to_world", [float("nan")] + [0.0] * 15),
        ("camera_to_world", [1.0] * 16),
        ("intrinsics", [0.0, 1.0, 1.0, 1.0]),
        ("intrinsics", [1.0, 1.0]),
        ("width", 4096),
        ("width", 0),
        ("height", 1440.5),
        ("timestamp", None),
        ("tracking", 3),
    ],
)
def test_bad_image_fields_rejected(field: str, value) -> None:
    doc = capture_doc(camera_ring(24))
    doc["images"][0][field] = value
    with pytest.raises(BundleValidationError):
        parse_capture(json.dumps(doc).encode())


def test_oversize_or_garbled_capture_json_rejected() -> None:
    with pytest.raises(BundleValidationError, match="too large"):
        parse_capture(b" " * (MAX_CAPTURE_JSON_BYTES + 1))
    with pytest.raises(BundleValidationError, match="not valid JSON"):
        parse_capture(b"{not json")
    with pytest.raises(BundleValidationError, match="not valid JSON"):
        parse_capture(b"\xff\xfe")
    with pytest.raises(BundleValidationError, match="not an object"):
        parse_capture(b"[]")


@pytest.mark.parametrize("sof", [0xC0, 0xC1, 0xC2])
def test_jpeg_dimensions_from_sof(sof: int) -> None:
    assert jpeg_dimensions(fake_jpeg(1920, 1440, sof=sof)) == (1920, 1440)


@pytest.mark.parametrize(
    "data",
    [b"", b"\x89PNG\r\n", b"\xff\xd8", b"\xff\xd8\xff\xe0\x00\x10JF", b"\xff\xd8\xff\xda\x00\x02",
     b"\xff\xd8\x00\x00", b"\xff\xd8\xff\xe0\x00\x01"],
)  # fmt: skip
def test_garbled_jpegs_rejected(data: bytes) -> None:
    with pytest.raises(BundleValidationError, match="JPEG"):
        jpeg_dimensions(data)


def _image():
    return parse_capture(capture_bytes(capture_doc(camera_ring(24)))).images[0]


def test_validate_jpeg_accepts_matching_header() -> None:
    validate_jpeg(_image(), fake_jpeg(1920, 1440))


def test_oversize_jpeg_bytes_rejected() -> None:
    data = fake_jpeg(1920, 1440) + b"\x00" * MAX_JPEG_BYTES
    with pytest.raises(BundleValidationError, match="larger than 2MB"):
        validate_jpeg(_image(), data)


def test_jpeg_real_dimensions_override_declared() -> None:
    with pytest.raises(BundleValidationError, match="larger than 2048px"):
        validate_jpeg(_image(), fake_jpeg(4032, 3024))
    with pytest.raises(BundleValidationError, match="do not match"):
        validate_jpeg(_image(), fake_jpeg(1440, 1920))


def test_legacy_bundle_has_no_capture_info() -> None:
    assert parse_capture(capture_bytes(capture_doc(camera_ring(24)))).capture is None


@pytest.mark.parametrize("mode", ["solo", "helper"])
def test_capture_info_parses(mode: str) -> None:
    info = capture_info(mode=mode, coverage=1, finished_early=True, front_azimuth_rad=-3)
    bundle = parse_capture(capture_bytes(capture_doc(camera_ring(24), capture=info)))
    assert bundle.capture == CaptureInfo(
        mode=mode,
        anchor_world=(0.30, 0.30, -0.20),
        front_azimuth_rad=-3.0,
        coverage=1.0,
        finished_early=True,
    )


@pytest.mark.parametrize(
    "info",
    [
        None,
        [],
        "solo",
        capture_info(mode="tripod"),
        capture_info(mode=None),
        capture_info(anchor_world=[0.0, 0.0]),
        capture_info(anchor_world=[0.0, 0.0, 0.0, 0.0]),
        capture_info(anchor_world=[0.0, float("nan"), 0.0]),
        capture_info(anchor_world=[0.0, True, 0.0]),
        capture_info(anchor_world=[0.0, "1", 0.0]),
        capture_info(anchor_world={"x": 0}),
        capture_info(front_azimuth_rad=float("inf")),
        capture_info(front_azimuth_rad="0"),
        capture_info(coverage=-0.01),
        capture_info(coverage=1.01),
        capture_info(coverage=True),
        capture_info(finished_early=0),
        capture_info(finished_early="false"),
        capture_info(extra=1),
        {k: v for k, v in capture_info().items() if k != "coverage"},
    ],
    ids=[
        "null", "list", "string", "mode-unknown", "mode-null", "anchor-short", "anchor-long",
        "anchor-nan", "anchor-bool", "anchor-str", "anchor-dict", "azimuth-inf", "azimuth-str",
        "coverage-neg", "coverage-over", "coverage-bool", "early-int", "early-str",
        "unknown-key", "missing-key",
    ],
)  # fmt: skip
def test_malformed_capture_info_rejected(info) -> None:
    doc = capture_doc(camera_ring(24))
    doc["capture"] = info
    with pytest.raises(BundleValidationError, match="capture info.*Please rescan"):
        parse_capture(json.dumps(doc).encode())


# --- capture v2 (silhouette) -------------------------------------------------------------


def _v2(count: int = 5, **top) -> dict:
    doc = capture_doc(camera_ring(count), capture=capture_info())
    doc.update(version=2, method="silhouette", floor_y=-1.05)
    stations = sorted(STATIONS)
    for i, image in enumerate(doc["images"]):
        image["mask"] = image["file"].replace(".jpg", ".png")
        image["station"] = stations[i % len(stations)]
    doc.update(top)
    return doc


def _png_header_only(
    width: int = 1920, height: int = 1440, depth: int = 8, color: int = 0
) -> bytes:
    import zlib

    body = width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes([depth, color, 0, 0, 0])
    crc = zlib.crc32(b"IHDR" + body).to_bytes(4, "big")
    return b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + body + crc


def test_v2_bundle_parses() -> None:
    bundle = parse_capture(capture_bytes(_v2()))
    assert bundle.method == METHOD_SILHOUETTE
    assert bundle.floor_y == -1.05
    assert bundle.capture is not None and bundle.capture.mode == "solo"
    first = bundle.images[0]
    assert (first.file, first.mask, first.station, first.joints) == (
        "000.jpg",
        "000.png",
        sorted(STATIONS)[0],
        None,
    )


def test_v1_bundle_stays_photogrammetry() -> None:
    bundle = parse_capture(capture_bytes(capture_doc(camera_ring(24))))
    assert bundle.method == METHOD_PHOTOGRAMMETRY and bundle.floor_y is None


@pytest.mark.parametrize("count", [MIN_SILHOUETTE_IMAGES, MAX_SILHOUETTE_IMAGES])
def test_v2_image_count_bounds_inclusive(count: int) -> None:
    assert len(parse_capture(capture_bytes(_v2(count))).images) == count


@pytest.mark.parametrize("count", [MIN_SILHOUETTE_IMAGES - 1, MAX_SILHOUETTE_IMAGES + 1])
def test_v2_image_count_bounds(count: int) -> None:
    with pytest.raises(BundleValidationError, match="photos"):
        parse_capture(capture_bytes(_v2(count)))


def test_v2_floor_may_be_null() -> None:
    assert parse_capture(capture_bytes(_v2(floor_y=None))).floor_y is None


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.pop("method"),
        lambda d: d.update(method="photogrammetry"),
        lambda d: d.pop("floor_y"),
        lambda d: d.update(floor_y="0"),
        lambda d: d.update(floor_y=float("inf")),
        lambda d: d.update(floor_y=True),
        lambda d: d.pop("capture"),
        lambda d: d["capture"].pop("coverage"),
        lambda d: d.update(version=3),
    ],
    ids=["no-method", "wrong-method", "no-floor", "floor-str", "floor-inf", "floor-bool",
         "no-capture", "capture-key", "version3"],
)  # fmt: skip
def test_v2_header_violations_rejected(mutate) -> None:
    doc = _v2()
    mutate(doc)
    with pytest.raises(BundleValidationError, match="Please rescan"):
        parse_capture(json.dumps(doc).encode())


@pytest.mark.parametrize(
    ("field", "value", "match"),
    [
        ("mask", None, "mask file name"),
        ("mask", "001.png", "mask file name"),  # stem must match 000.jpg
        ("mask", "000.PNG", "mask file name"),
        ("mask", "../000.png", "mask file name"),
        ("mask", "000.jpg", "mask file name"),
        ("station", "back", "station"),
        ("station", None, "station"),
        ("joints", [], "joints"),
        ("joints", {"hip": None}, "joints"),
        ("joints", {"knee": [1.0, 2.0]}, "knee joint"),
        ("joints", {"knee": [1.0, 2.0, 1.5]}, "knee joint"),
        ("joints", {"ankle": [-1.0, 2.0, 0.9]}, "ankle joint"),
        ("joints", {"ankle": [1920.0, 2.0, 0.9]}, "ankle joint"),
        ("joints", {"ankle": [1.0, 1440.0, 0.9]}, "ankle joint"),
        ("joints", {"ankle": [1.0, float("nan"), 0.9]}, "ankle joint"),
        ("joints", {"ankle": [1.0, True, 0.9]}, "ankle joint"),
    ],
)
def test_v2_bad_image_fields_rejected(field: str, value, match: str) -> None:
    doc = _v2()
    doc["images"][0][field] = value
    with pytest.raises(BundleValidationError, match=match):
        parse_capture(json.dumps(doc).encode())


def test_v2_joints_parse_with_nulls() -> None:
    doc = _v2()
    doc["images"][0]["joints"] = {"knee": [100.0, 200.5, 0.8], "ankle": None}
    doc["images"][1]["joints"] = None
    images = parse_capture(capture_bytes(doc)).images
    assert images[0].joints == {"knee": (100.0, 200.5, 0.8), "ankle": None}
    assert images[1].joints is None


def _v2_image():
    return parse_capture(capture_bytes(_v2())).images[0]


@pytest.mark.parametrize(
    ("data", "match"),
    [
        (_png_header_only(960, 1440), "dimensions do not match"),
        (_png_header_only(color=2), "8-bit grayscale"),
        (_png_header_only(depth=16), "8-bit grayscale"),
        (b"\x89PNG\r\n\x1a\nxx", "not a valid PNG"),
        (fake_jpeg(), "not a valid PNG"),
        (_png_header_only() + b"\x00" * MAX_PNG_BYTES, "larger than 1MB"),
        (_png_header_only(), "not a valid PNG"),  # header only: no IEND
    ],
    ids=["size", "rgb", "16-bit", "garbled", "jpeg", "oversize", "truncated"],
)
def test_validate_mask_rejections(data: bytes, match: str) -> None:
    with pytest.raises(BundleValidationError, match=match):
        validate_mask(_v2_image(), data)
