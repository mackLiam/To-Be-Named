"""forms-replay: pure core plus the thin IO helpers over httpx.MockTransport (no network)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from forms_pipeline.contract import MEASUREMENT_KEYS
from forms_pipeline.replay import cli
from forms_pipeline.replay.core import (
    FAILED,
    RUNNING,
    SUCCEEDED,
    ReplayError,
    diff_measurements,
    find_user_id,
    format_diff,
    job_outcome,
    load_bundle,
    manifest_images,
    printable_artifacts,
    recording_summary,
    replay_user_email,
    require_local,
    require_uuid,
)

SCAN = "11111111-1111-4111-8111-111111111111"


def _capture(names: list[str]) -> bytes:
    return json.dumps({"format": "forms.photo-capture", "images": [{"file": n} for n in names]})


def _write_bundle(root: Path, kind: str = "photos", images: int = 3, **meta: object) -> Path:
    root.mkdir(parents=True)
    names = [f"{i:03d}.jpg" for i in range(images)]
    if kind == "photos":
        (root / "capture.json").write_text(_capture(names))
        (root / "images").mkdir()
        for n in names:
            (root / "images" / n).write_bytes(b"\xff\xd8jpeg")
    else:
        (root / "mesh.obj").write_text("v 0 0 0\n")
    body = {"scan_id": SCAN, "leg": "L", "capture_kind": kind, **meta}
    (root / "recording.json").write_text(json.dumps(body))
    return root


# -- host guard ---------------------------------------------------------------
@pytest.mark.parametrize(
    "url", ["http://127.0.0.1:54321", "http://localhost:54321/", "https://localhost"]
)
def test_require_local_accepts_loopback(url: str) -> None:
    assert require_local(url) == url.rstrip("/")


@pytest.mark.parametrize(
    "url",
    [
        "https://abc.supabase.co",
        "http://127.0.0.1.evil.example",
        "http://localhost.example.com",
        "http://user@evil.example/127.0.0.1",
        "",
    ],
)
def test_require_local_refuses_everything_else(url: str) -> None:
    with pytest.raises(ReplayError, match="non-local"):
        require_local(url)


def test_run_refuses_hosted_url_before_any_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle = _write_bundle(tmp_path / "rec")
    monkeypatch.setenv("SUPABASE_URL", "https://abc.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-secret")
    monkeypatch.setattr(
        cli.ReplaySettings, "model_config", {**cli.ReplaySettings.model_config, "env_file": None}
    )

    def boom(*args: object, **kwargs: object) -> None:
        raise AssertionError("network touched")

    monkeypatch.setattr(httpx.Client, "send", boom)
    monkeypatch.setattr(httpx, "post", boom)
    code = cli.run(["run", "--bundle", str(bundle), "--anon-key", "anon"])
    assert code == 1
    err = capsys.readouterr().err
    assert "non-local" in err
    assert "service-secret" not in err


def test_require_uuid() -> None:
    assert require_uuid(SCAN.upper(), "x") == SCAN
    with pytest.raises(ReplayError):
        require_uuid("../other-user", "x")


# -- capture.json names ---------------------------------------------------------
def test_manifest_images_lists_names_in_order() -> None:
    assert manifest_images(_capture(["000.jpg", "001.jpg"])) == ["000.jpg", "001.jpg"]


@pytest.mark.parametrize(
    "names",
    [["../x.jpg"], ["0001.jpg"], ["001.JPG"], ["001.jpg\n"], ["a/001.jpg"], ["000.jpg", "000.jpg"]],
)
def test_manifest_images_rejects_bad_names(names: list[str]) -> None:
    with pytest.raises(ReplayError):
        manifest_images(_capture(names))


@pytest.mark.parametrize("raw", [b"not json", b"[]", b'{"images": []}', b"x" * (1024 * 1024 + 1)])
def test_manifest_images_rejects_bad_manifests(raw: bytes) -> None:
    with pytest.raises(ReplayError):
        manifest_images(raw)


def test_manifest_images_caps_count() -> None:
    with pytest.raises(ReplayError, match="more than"):
        manifest_images(_capture([f"{i:03d}.jpg" for i in range(121)]))


# -- bundle discovery -----------------------------------------------------------
def test_load_photo_bundle(tmp_path: Path) -> None:
    b = load_bundle(_write_bundle(tmp_path / "rec", measurements={"values": {"Leg_Length": 1}}))
    assert (b.capture_kind, b.leg, b.images) == ("photos", "L", ("000.jpg", "001.jpg", "002.jpg"))
    assert b.expected == {"Leg_Length": 1}


def test_load_mesh_bundle_without_measurements(tmp_path: Path) -> None:
    b = load_bundle(_write_bundle(tmp_path / "rec", kind="mesh", measurements=None))
    assert b.images == ()
    assert b.expected is None


def test_load_bundle_missing_image(tmp_path: Path) -> None:
    root = _write_bundle(tmp_path / "rec")
    (root / "images" / "001.jpg").unlink()
    with pytest.raises(ReplayError, match="missing 1 image"):
        load_bundle(root)


def test_load_bundle_missing_mesh(tmp_path: Path) -> None:
    root = _write_bundle(tmp_path / "rec", kind="mesh")
    (root / "mesh.obj").unlink()
    with pytest.raises(ReplayError, match="mesh.obj"):
        load_bundle(root)


@pytest.mark.parametrize("meta", [{"capture_kind": "video"}, {"leg": "X"}])
def test_load_bundle_rejects_bad_meta(tmp_path: Path, meta: dict[str, str]) -> None:
    with pytest.raises(ReplayError):
        load_bundle(_write_bundle(tmp_path / "rec", **meta))


def test_load_bundle_requires_recording_json(tmp_path: Path) -> None:
    with pytest.raises(ReplayError, match="recording.json"):
        load_bundle(tmp_path)


def test_recording_summary_and_list(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = _write_bundle(tmp_path / "rec")
    (root / "images" / "notes.txt").write_text("ignored")
    size, count = recording_summary(root)
    assert count == 3
    assert size == sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
    assert cli.run(["list", "--root", str(tmp_path)]) == 0
    assert "rec" in capsys.readouterr().out


# -- test user ----------------------------------------------------------------------
def test_replay_user_email_is_stable_and_local() -> None:
    email = replay_user_email(SCAN)
    assert email == replay_user_email(SCAN) != replay_user_email("other")
    assert email.startswith("replay+") and email.endswith("@forms.test")


def test_find_user_id_is_case_insensitive() -> None:
    users = [{"id": "a", "email": "x@forms.test"}, {"id": "b", "email": "Replay+1@forms.test"}]
    assert find_user_id(users, "replay+1@forms.test") == "b"
    assert find_user_id(users, "nobody@forms.test") is None


def _mock_client(handler) -> httpx.Client:  # noqa: ANN001
    return httpx.Client(base_url="http://127.0.0.1:54321", transport=httpx.MockTransport(handler))


def test_ensure_user_creates_new() -> None:
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(f"{req.method} {req.url.path}")
        assert json.loads(req.content)["email_confirm"] is True
        return httpx.Response(200, json={"id": "u1"})

    cli._ensure_user(_mock_client(handler), "replay+1@forms.test", "pw")
    assert calls == ["POST /auth/v1/admin/users"]


def test_ensure_user_reuses_existing_and_resets_password() -> None:
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(f"{req.method} {req.url.path}")
        if req.method == "POST":
            return httpx.Response(422, json={"error_code": "email_exists"})
        if req.method == "GET":
            return httpx.Response(
                200, json={"users": [{"id": "u9", "email": "replay+1@forms.test"}]}
            )
        assert json.loads(req.content) == {"password": "pw"}
        return httpx.Response(200, json={})

    cli._ensure_user(_mock_client(handler), "replay+1@forms.test", "pw")
    assert calls == [
        "POST /auth/v1/admin/users",
        "GET /auth/v1/admin/users",
        "PUT /auth/v1/admin/users/u9",
    ]


def test_ensure_user_surfaces_other_errors() -> None:
    client = _mock_client(lambda req: httpx.Response(500, text="boom"))
    with pytest.raises(ReplayError, match="HTTP 500"):
        cli._ensure_user(client, "replay+1@forms.test", "pw")


# -- poll state --------------------------------------------------------------------
@pytest.mark.parametrize(
    ("job", "outcome"),
    [
        ({"status": "pending", "attempts": 0, "max_attempts": 3}, RUNNING),
        ({"status": "running", "attempts": 1, "max_attempts": 3}, RUNNING),
        ({"status": "pending", "attempts": 1, "max_attempts": 3, "error": {"m": "x"}}, RUNNING),
        ({"status": "succeeded", "attempts": 1, "max_attempts": 3}, SUCCEEDED),
        ({"status": "dead_letter", "attempts": 1, "max_attempts": 3}, FAILED),
        ({"status": "failed", "attempts": 3, "max_attempts": 3}, FAILED),
        ({"status": "failed", "attempts": 1, "max_attempts": 3}, RUNNING),
    ],
)
def test_job_outcome(job: dict[str, object], outcome: str) -> None:
    assert job_outcome(job) == outcome


def test_wait_prints_transitions_until_terminal(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    states = iter(
        [
            {"step": "reconstructing", "status": "pending", "attempts": 0},
            {"step": "reconstructing", "status": "pending", "attempts": 0},
            {"step": "measuring", "status": "running", "attempts": 1},
            {"step": "measured", "status": "succeeded", "attempts": 1},
        ]
    )

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/v1/pipeline_jobs"
        return httpx.Response(200, json=[{**next(states), "max_attempts": 3, "error": None}])

    monkeypatch.setattr(cli.time, "sleep", lambda s: None)
    job = cli._wait(_mock_client(handler), "j1", timeout_s=60)
    assert job["status"] == "succeeded"
    assert capsys.readouterr().out.count("step=") == 3


def test_wait_times_out(monkeypatch: pytest.MonkeyPatch) -> None:
    handler = lambda req: httpx.Response(  # noqa: E731
        200, json=[{"step": "measuring", "status": "running", "attempts": 1, "max_attempts": 3}]
    )
    monkeypatch.setattr(cli.time, "sleep", lambda s: None)
    with pytest.raises(ReplayError, match="timed out"):
        cli._wait(_mock_client(handler), "j1", timeout_s=-1)


def test_printable_artifacts_drops_nested_values() -> None:
    raw = {"registered": 40, "scale": 1.01, "axis_source": "pca", "low": False, "poses": [[1]]}
    assert printable_artifacts(raw) == {
        "registered": 40,
        "scale": 1.01,
        "axis_source": "pca",
        "low": False,
    }
    assert printable_artifacts(None) == {}


# -- diff ----------------------------------------------------------------------------
def test_diff_measurements_mm_and_percent() -> None:
    expected = dict.fromkeys(MEASUREMENT_KEYS, 100.0)
    actual = {**expected, "Leg_Length": 110.0}
    del actual[MEASUREMENT_KEYS[-1]]
    rows = diff_measurements(expected, actual, MEASUREMENT_KEYS)
    assert [r.key for r in rows] == list(MEASUREMENT_KEYS)
    leg = rows[MEASUREMENT_KEYS.index("Leg_Length")]
    assert leg.delta_mm == pytest.approx(10.0)
    assert leg.delta_pct == pytest.approx(10.0)
    assert rows[-1].actual is None and rows[-1].delta_mm is None
    table = format_diff(rows)
    assert "+10.00" in table
    assert len(table.splitlines()) == len(MEASUREMENT_KEYS) + 1


def test_diff_zero_expected_has_no_percent() -> None:
    (row,) = diff_measurements({"k": 0.0}, {"k": 5.0}, ("k",))
    assert row.delta_mm == 5.0 and row.delta_pct is None


# -- CLI surface ---------------------------------------------------------------------
@pytest.mark.parametrize(
    "argv", [["--help"], ["record", "--help"], ["run", "--help"], ["list", "--help"]]
)
def test_help(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        cli.build_parser().parse_args(argv)
    assert exc.value.code == 0


def test_manifest_masks_lists_v2_masks_and_ignores_v1() -> None:
    from forms_pipeline.replay.core import manifest_masks

    v2 = json.dumps(
        {"images": [{"file": "000.jpg", "mask": "000.png"}, {"file": "001.jpg", "mask": "001.png"}]}
    )
    assert manifest_masks(v2.encode()) == ["000.png", "001.png"]
    assert manifest_masks(json.dumps({"images": [{"file": "000.jpg"}]}).encode()) == []


@pytest.mark.parametrize("mask", ["../x.png", "000.jpg", "0000.png", 7])
def test_manifest_masks_rejects_bad_names(mask: object) -> None:
    from forms_pipeline.replay.core import ReplayError, manifest_masks

    with pytest.raises(ReplayError):
        manifest_masks(json.dumps({"images": [{"file": "000.jpg", "mask": mask}]}).encode())


def test_manifest_masks_rejects_stem_mismatch() -> None:
    from forms_pipeline.replay.core import ReplayError, manifest_masks

    with pytest.raises(ReplayError):
        manifest_masks(json.dumps({"images": [{"file": "000.jpg", "mask": "001.png"}]}).encode())
