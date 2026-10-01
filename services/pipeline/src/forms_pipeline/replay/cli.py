"""forms-replay: record a real capture from the local stack, replay it through the
real client path (user JWT, storage RLS, enqueue RPC), and compare measurements.

Local stack only: every command refuses a Supabase URL whose host is not
127.0.0.1 or localhost. Recordings are body scans (often of minors): they live
under services/pipeline/recordings/ (gitignored) and need the subject's consent.

    forms-replay record --scan <scan_id> [--out DIR | --name NAME]
    forms-replay run --bundle DIR [--leg L|R] [--wait] [--timeout 1800]
    forms-replay list
"""

from __future__ import annotations

import argparse
import json
import secrets
import shutil
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from pydantic import AliasChoices, Field, SecretStr

from forms_pipeline.config import Settings
from forms_pipeline.contract import MEASUREMENT_KEYS
from forms_pipeline.jobs.runner import owned_mesh_path, storage_owner
from forms_pipeline.replay.core import (
    CAPTURE_FILE,
    FAILED,
    MESH_FILE,
    RECORDING_FILE,
    RUNNING,
    ReplayError,
    diff_measurements,
    find_user_id,
    format_diff,
    job_outcome,
    job_signature,
    load_bundle,
    manifest_images,
    manifest_masks,
    printable_artifacts,
    recording_summary,
    replay_user_email,
    require_local,
    require_uuid,
)

BUCKET = "meshes"
RECORDINGS_ROOT = Path(__file__).resolve().parents[3] / "recordings"
POLL_INTERVAL_S = 2.0
ADMIN_USERS_PER_PAGE = 200
ADMIN_USERS_MAX_PAGES = 50

WARNING = (
    "WARNING: recordings are body scan data (often of minors). Never commit them,\n"
    "never copy them off this machine, and record only with the subject's consent."
)


class ReplaySettings(Settings):
    # The anon key is public by design (it ships in client bundles), so it is the
    # only addition here; the service role key comes from the base Settings.
    supabase_anon_key: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices(
            "SUPABASE_ANON_KEY", "EXPO_PUBLIC_SUPABASE_ANON_KEY", "ANON_KEY"
        ),
    )


def _check(resp: httpx.Response, what: str) -> httpx.Response:
    if resp.is_error:
        raise ReplayError(f"{what} failed: HTTP {resp.status_code} {resp.text[:300]}")
    return resp


def _service_client(settings: Settings) -> httpx.Client:
    key = settings.supabase_service_role_key.get_secret_value()
    if not key:
        raise ReplayError("SUPABASE_SERVICE_ROLE_KEY is not set")
    return httpx.Client(
        base_url=require_local(settings.supabase_url),
        timeout=60.0,
        headers={"Authorization": f"Bearer {key}", "apikey": key},
    )


def _latest_measurements(client: httpx.Client, scan_id: str, validated_only: bool) -> Any:
    params = {
        "scan_id": f"eq.{scan_id}",
        "select": "values,validated,schema_version,extraction_version,created_at",
        "order": "created_at.desc",
        "limit": "1",
    }
    if validated_only:
        params["validated"] = "eq.true"
    rows = _check(client.get("/rest/v1/measurements", params=params), "read measurements").json()
    return rows[0] if rows else None


def _download(client: httpx.Client, path: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with client.stream("GET", f"/storage/v1/object/{BUCKET}/{path}") as resp:
        if resp.is_error:
            resp.read()
            _check(resp, f"download {path.rsplit('/', 1)[-1]}")
        with dest.open("wb") as f:
            for chunk in resp.iter_bytes():
                f.write(chunk)


# ---------------------------------------------------------------------------
# record
# ---------------------------------------------------------------------------
def cmd_record(args: argparse.Namespace, settings: Settings) -> int:
    print(WARNING, file=sys.stderr)
    scan_id = require_uuid(args.scan, "--scan")
    out: Path = args.out or RECORDINGS_ROOT / (args.name or scan_id)
    if (out / RECORDING_FILE).exists():
        raise ReplayError(f"{out} already holds a recording")
    with _service_client(settings) as client:
        rows = _check(
            client.get(
                "/rest/v1/scans",
                params={
                    "id": f"eq.{scan_id}",
                    "select": "leg,capture_kind,storage_user_id,mesh_path",
                },
            ),
            "read scan",
        ).json()
        if not rows:
            raise ReplayError(f"scan {scan_id} not found")
        scan = rows[0]
        owner = require_uuid(storage_owner(scan["storage_user_id"]), "storage_user_id")
        prefix = f"{owner}/{scan_id}"
        created = not out.exists()
        out.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            images: list[str] = []
            if scan["capture_kind"] == "photos":
                _download(client, f"{prefix}/{CAPTURE_FILE}", out / CAPTURE_FILE)
                images = manifest_images((out / CAPTURE_FILE).read_bytes())
                for i, name in enumerate(images, 1):
                    _download(client, f"{prefix}/images/{name}", out / "images" / name)
                    print(f"\rimages {i}/{len(images)}", end="", file=sys.stderr)
                print(file=sys.stderr)
                for name in manifest_masks((out / CAPTURE_FILE).read_bytes()):
                    _download(client, f"{prefix}/masks/{name}", out / "masks" / name)
            if scan["mesh_path"]:
                _download(client, owned_mesh_path(owner, scan["mesh_path"]), out / MESH_FILE)
            measurements = _latest_measurements(client, scan_id, validated_only=True)
        except BaseException:
            # Never delete a directory this command did not create.
            if created:
                shutil.rmtree(out, ignore_errors=True)
            raise
    meta = {
        "scan_id": scan_id,
        "leg": scan["leg"],
        "capture_kind": scan["capture_kind"],
        "recorded_at": datetime.now(UTC).isoformat(),
        "image_count": len(images),
        "has_mesh": bool(scan["mesh_path"]),
        "measurements": measurements,
    }
    # Written last: its presence marks a complete recording.
    (out / RECORDING_FILE).write_text(json.dumps(meta, indent=2) + "\n")
    print(f"recorded scan {scan_id} ({scan['capture_kind']}, {len(images)} images) to {out}")
    return 0


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------
def _ensure_user(admin: httpx.Client, email: str, password: str) -> None:
    body = {"email": email, "password": password, "email_confirm": True}
    resp = admin.post("/auth/v1/admin/users", json=body)
    if not resp.is_error:
        return
    if resp.status_code not in (400, 422):
        _check(resp, "create test user")
    for page in range(1, ADMIN_USERS_MAX_PAGES + 1):
        listing = _check(
            admin.get(
                "/auth/v1/admin/users", params={"page": page, "per_page": ADMIN_USERS_PER_PAGE}
            ),
            "list users",
        ).json()
        users = listing.get("users", [])
        user_id = find_user_id(users, email)
        if user_id:
            _check(
                admin.put(f"/auth/v1/admin/users/{user_id}", json={"password": password}),
                "reset test user password",
            )
            return
        if len(users) < ADMIN_USERS_PER_PAGE:
            break
    _check(resp, "create test user")


def _sign_in(base: str, anon_key: str, email: str, password: str) -> tuple[str, str]:
    resp = httpx.post(
        f"{base}/auth/v1/token",
        params={"grant_type": "password"},
        headers={"apikey": anon_key},
        json={"email": email, "password": password},
        timeout=30.0,
    )
    session = _check(resp, "sign in").json()
    return session["access_token"], require_uuid(session["user"]["id"], "user id")


def _upload(user: httpx.Client, path: str, data: bytes, content_type: str) -> None:
    resp = user.post(
        f"/storage/v1/object/{BUCKET}/{path}",
        content=data,
        headers={"Content-Type": content_type, "x-upsert": "true"},
    )
    _check(resp, f"upload {path.rsplit('/', 1)[-1]}")


def _wait(admin: httpx.Client, job_id: str, timeout_s: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    last: tuple[Any, ...] | None = None
    while True:
        rows = _check(
            admin.get(
                "/rest/v1/pipeline_jobs",
                params={
                    "id": f"eq.{job_id}",
                    "select": "step,status,attempts,max_attempts,error,artifacts",
                },
            ),
            "read job",
        ).json()
        if not rows:
            raise ReplayError(f"job {job_id} disappeared")
        job = rows[0]
        if job_signature(job) != last:
            last = job_signature(job)
            note = f"  error: {json.dumps(job['error'])[:300]}" if job.get("error") else ""
            print(
                f"[{datetime.now():%H:%M:%S}] step={job['step']} status={job['status']} "
                f"attempt {job['attempts']}/{job['max_attempts']}{note}"
            )
        if job_outcome(job) != RUNNING:
            return job
        if time.monotonic() > deadline:
            raise ReplayError(f"timed out after {timeout_s:.0f}s waiting for job {job_id}")
        time.sleep(POLL_INTERVAL_S)


def cmd_run(args: argparse.Namespace, settings: ReplaySettings) -> int:
    bundle = load_bundle(args.bundle)
    base = require_local(settings.supabase_url)
    anon_key = args.anon_key or settings.supabase_anon_key.get_secret_value()
    if not anon_key:
        raise ReplayError(
            "no anon key: pass --anon-key or set SUPABASE_ANON_KEY "
            "(npx supabase@2.119.0 status -o env prints ANON_KEY)"
        )
    leg = args.leg or bundle.leg
    email = replay_user_email(str(bundle.meta.get("scan_id", bundle.root.name)))
    password = secrets.token_urlsafe(32)

    with _service_client(settings) as admin:
        _ensure_user(admin, email, password)
        jwt, uid = _sign_in(base, anon_key, email, password)
        scan_id, pair_id = str(uuid.uuid4()), str(uuid.uuid4())
        print(f"test user {email} ({uid}), new scan {scan_id}, leg {leg}")

        user_headers = {"Authorization": f"Bearer {jwt}", "apikey": anon_key}
        with httpx.Client(base_url=base, timeout=60.0, headers=user_headers) as user:
            mesh_path = None
            if bundle.capture_kind == "photos":
                for i, name in enumerate(bundle.images, 1):
                    data = (bundle.root / "images" / name).read_bytes()
                    _upload(user, f"{uid}/{scan_id}/images/{name}", data, "image/jpeg")
                    print(f"\ruploaded {i}/{len(bundle.images)} images", end="")
                print()
                for name in bundle.masks:
                    data = (bundle.root / "masks" / name).read_bytes()
                    _upload(user, f"{uid}/{scan_id}/masks/{name}", data, "image/png")
                # Last, as the app does: its presence implies every image landed.
                capture = (bundle.root / CAPTURE_FILE).read_bytes()
                _upload(user, f"{uid}/{scan_id}/{CAPTURE_FILE}", capture, "application/json")
            else:
                mesh_path = f"{uid}/{scan_id}.obj"
                # ponytail: whole mesh in memory, bounded by the 100MB bucket cap.
                _upload(user, mesh_path, (bundle.root / MESH_FILE).read_bytes(), "model/obj")
                print("uploaded mesh")

            row = {
                "id": scan_id,
                "user_id": uid,
                "leg": leg,
                "status": "uploaded",
                "capture_kind": bundle.capture_kind,
                "mesh_path": mesh_path,
                "pair_id": pair_id,
                "capture_meta": {"source": "forms-replay"},
            }
            _check(
                user.post(
                    "/rest/v1/scans",
                    params={"on_conflict": "id"},
                    json=row,
                    headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                ),
                "upsert scan",
            )
            job_id = require_uuid(
                _check(
                    user.post("/rest/v1/rpc/enqueue_measure_job", json={"p_scan_id": scan_id}),
                    "enqueue_measure_job",
                ).json(),
                "job id",
            )
        print(f"enqueued job {job_id}")
        if not args.wait:
            return 0

        job = _wait(admin, job_id, args.timeout)
        artifacts = printable_artifacts(job.get("artifacts"))
        if artifacts:
            print("artifacts:")
            for key, value in artifacts.items():
                print(f"  {key}: {value}")
        if job_outcome(job) == FAILED:
            print(f"FAILED at step {job['step']}", file=sys.stderr)
            return 1
        result = _latest_measurements(admin, scan_id, validated_only=False)

    if result is None:
        print("job succeeded but wrote no measurements", file=sys.stderr)
        return 1
    actual = result["values"]
    print(f"measurements (validated={result['validated']}, {result['extraction_version']}):")
    expected = bundle.expected
    rows = diff_measurements(expected or {}, actual, MEASUREMENT_KEYS)
    if expected:
        print(format_diff(rows))
    else:
        for r in rows:
            print(f"  {r.key}: {r.actual}")
    return 0 if result["validated"] else 1


# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------
def cmd_list(args: argparse.Namespace, settings: Settings) -> int:
    root: Path = args.root
    found = sorted(p for p in root.glob(f"*/{RECORDING_FILE}")) if root.is_dir() else []
    if not found:
        print(f"no recordings under {root}")
        return 0
    for meta_path in found:
        size, images = recording_summary(meta_path.parent)
        meta = json.loads(meta_path.read_text())
        print(
            f"{meta_path.parent.name:<40} {meta.get('capture_kind', '?'):<6} "
            f"leg {meta.get('leg', '?')}  {images:>3} images  {size / 1e6:8.1f} MB  "
            f"{meta.get('recorded_at', '')}"
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="forms-replay",
        description="Record a capture from the LOCAL Supabase stack and replay it through "
        "the real client path. Refuses any non-localhost Supabase URL.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    rec = sub.add_parser("record", help="download a scan's capture into a recording directory")
    rec.add_argument("--scan", required=True, help="scans.id to record")
    where = rec.add_mutually_exclusive_group()
    where.add_argument("--out", type=Path, help="recording directory")
    where.add_argument(
        "--name", help=f"recording name under {RECORDINGS_ROOT} (default: the scan id)"
    )
    rec.set_defaults(func=cmd_record)

    run = sub.add_parser("run", help="replay a recording as a local test user")
    run.add_argument("--bundle", required=True, type=Path, help="recording directory")
    run.add_argument("--leg", choices=("L", "R"), help="override the recorded leg")
    run.add_argument("--wait", action="store_true", help="poll the job until it finishes")
    run.add_argument("--timeout", type=float, default=1800.0, help="seconds to wait (1800)")
    run.add_argument("--anon-key", help="local anon key (default: SUPABASE_ANON_KEY from .env)")
    run.set_defaults(func=cmd_run)

    ls = sub.add_parser("list", help="list recordings with size and image count")
    ls.add_argument("--root", type=Path, default=RECORDINGS_ROOT, help=argparse.SUPPRESS)
    ls.set_defaults(func=cmd_list)
    return parser


def run(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args, ReplaySettings())
    except (ReplayError, httpx.HTTPError) as exc:
        print(f"forms-replay: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(run())
