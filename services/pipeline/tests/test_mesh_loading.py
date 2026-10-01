from __future__ import annotations

from pathlib import Path
from unittest import mock

import pytest
import trimesh
import trimesh.resolvers

from forms_pipeline.config import Settings
from forms_pipeline.extraction.mesh_loading import MeshValidationError, load_mesh


def test_valid_synthetic_mesh_loads(frustum_obj_path: Path) -> None:
    mesh = load_mesh(frustum_obj_path)
    # 2 * sides ring vertices + 2 cap centers, matching conftest's frustum construction.
    assert len(mesh.vertices) > 0
    assert len(mesh.faces) > 0


def test_bad_extension_rejected(tmp_path: Path) -> None:
    bad_path = tmp_path / "scan.txt"
    bad_path.write_text("not a mesh")
    with pytest.raises(MeshValidationError, match="Unsupported file type"):
        load_mesh(bad_path)


def test_size_cap_enforced(tmp_path: Path) -> None:
    oversized_path = tmp_path / "big.obj"
    # Content doesn't need to be a valid mesh: the size check runs before parsing.
    oversized_path.write_bytes(b"o\n" + b"v 0 0 0\n" * 200_000)
    tiny_cap_settings = Settings(max_mesh_mb=1)
    assert oversized_path.stat().st_size > tiny_cap_settings.max_mesh_bytes
    with pytest.raises(MeshValidationError, match="exceeds"):
        load_mesh(oversized_path, settings=tiny_cap_settings)


def test_empty_file_rejected(tmp_path: Path) -> None:
    empty_path = tmp_path / "empty.obj"
    empty_path.write_bytes(b"")
    with pytest.raises(MeshValidationError, match="empty"):
        load_mesh(empty_path)


def test_degenerate_mesh_rejected(degenerate_obj_path: Path) -> None:
    with pytest.raises(MeshValidationError):
        load_mesh(degenerate_obj_path)


def test_vertex_count_cap_enforced(frustum_obj_path: Path) -> None:
    # Mock the cap via a tiny max_vertices rather than allocating a 2M-vertex mesh.
    tiny_vertex_cap_settings = Settings(max_vertices=5)
    with pytest.raises(MeshValidationError, match="vertices"):
        load_mesh(frustum_obj_path, settings=tiny_vertex_cap_settings)


def test_unparseable_content_rejected(tmp_path: Path) -> None:
    garbage_path = tmp_path / "garbage.obj"
    garbage_path.write_bytes(b"\x00\x01\x02not a wavefront obj at all\xff\xfe")
    with pytest.raises(MeshValidationError):
        load_mesh(garbage_path)


def test_face_count_cap_enforced(tmp_path: Path) -> None:
    # Four vertices reused by twenty faces: under the vertex cap, over the
    # face cap (twice the vertex cap).
    path = tmp_path / "dense.obj"
    path.write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\n" + "f 1 2 3\nf 1 2 4\n" * 10)
    with pytest.raises(MeshValidationError, match="faces"):
        load_mesh(path, settings=Settings(max_vertices=4))


def test_external_references_are_not_resolved(tmp_path: Path) -> None:
    # A hostile OBJ pointing its material library outside the temp dir must
    # not make the worker open that file.
    upload = tmp_path / "upload"
    upload.mkdir()
    (tmp_path / "outside.mtl").write_text("newmtl leak\nKd 1 0 0\n")
    obj = upload / "scan.obj"
    obj.write_text(
        "mtllib ../outside.mtl\nusemtl leak\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\n"
        "f 1 2 3\nf 1 2 4\nf 1 3 4\nf 2 3 4\n"
    )

    # Record rather than raise: trimesh swallows errors from material loading.
    requested: list[str] = []

    def record(self: object, name: str) -> bytes:
        requested.append(name)
        return b""

    with mock.patch.object(trimesh.resolvers.FilePathResolver, "get", record):
        load_mesh(obj)
    assert requested == []
