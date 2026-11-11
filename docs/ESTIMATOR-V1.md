# Leg estimator v1: pinned contracts (Phase 1a)

Pinned 2026-11-11 from the forms-architect review of the Phase 1 brief
(overnight session). This file is the single text both the Python estimator
(`services/pipeline/src/forms_pipeline/shape/`) and the shared TS contracts
(`packages/shared`) are built against. Change it only as a lockstep,
versioned event. Plan context: docs/SCAN-V3-PLAN.md sections 4, 6.2, 7.2.

## Scope

- **Phase 1a (now):** the pure `shape/` package, unwired, and the two
  contracts below with shared fixtures. Invisible to users. The measuring step
  still runs extraction only.
- **Phase 1b (after Phase 0 is green):** runner wiring, migrations 0018,
  0019, 0021 (numbers stay reserved), the manual payload change, the folded
  extraction_version (`est-<estimator>+p<prior>`, for example
  `est-0.1.0+p0.1.0`), the backfill, the order snapshot, DESIGN.md section 6
  rewrite. TODO(liam): migrations were deliberately deferred against the
  overnight brief; reasons in the overnight report.
- The estimator projects to schema 1.1.0 **leg measurements**. It never emits
  crest-relative values; `cad/profile.py` stays the only converter.

## 1. forms.leg-model v1

```json
{
  "format": "forms.leg-model",
  "version": 1,
  "leg": "L",
  "units": "mm",
  "frame": "x_right_y_anterior_z_up",
  "estimator_version": "0.1.0",
  "prior_version": "0.1.0",
  "leg_length_mm": 380.0,
  "rings": [
    {
      "t": 0.0,
      "center": [0.0, 0.0],
      "crest": [0.0, 34.0],
      "points": [[30.0, 0.0], [29.7, 4.4], "... exactly 48 [x, y] pairs"]
    },
    "... exactly 21 rings, t = 0.00, 0.05, ..., 1.00"
  ],
  "fit_check": "optional",
  "fit_action": { "kind": "tape", "key": "S2_OD" }
}
```

Rules (both validators, identically):

1. Top-level keys exactly: format, version, leg, units, frame,
   estimator_version, prior_version, leg_length_mm, rings, fit_check,
   fit_action. Unknown keys rejected at every level.
2. `format` == "forms.leg-model"; `version` == 1 (integer); `leg` in
   {"L", "R"}; `units` == "mm"; `frame` == "x_right_y_anterior_z_up".
3. `estimator_version`, `prior_version` match `^\d+\.\d+\.\d+$`.
4. `leg_length_mm` finite and within the measurement schema's Leg_Length
   minimum and maximum, read from the schema (TS `measurementsSchema`, Python
   `contract.py`), never restated.
5. `rings`: exactly 21 entries (LEG_MODEL_RING_COUNT); ring k has `t` within
   1e-6 of k/20 and keys exactly t, center, crest, points.
6. `center`, `crest`: [x, y], finite, abs(coordinate) <= 300.
7. `points`: exactly 48 [x, y] pairs (LEG_MODEL_RING_POINTS), finite,
   abs <= 300, each ring counter-clockwise seen from +z (shoelace signed area
   > 0).
8. Frame: one right-handed frame for both legs. Origin on the leg axis at the
   bottom of the ankle, +x toward the player's right, +y anterior, +z up the
   leg axis; ring k lies at z = t_k * leg_length_mm. Medial is derived by
   consumers from `leg`, never stored.
9. `fit_check` in FIT_CHECKS = ["none", "optional", "required"].
   `fit_action` is null if and only if fit_check is "none"; otherwise
   `{"kind": "tape", "key": K}` with K in MEASUREMENT_KEYS and K the
   leg-length key or ending in `_OW` or `_OD`, or `{"kind": "stature"}`.
   FIT_ACTION_KINDS = ["tape", "stature"].
10. Never carries sigma, provenance or raw scan data. The producer rounds
    coordinates and leg_length_mm to 0.1 mm and t to 2 decimals.
11. v1 producer (tested in the shape suite, not by the validator): each ring
    an ellipse with semi-axes OW(t)/2 on x and OD(t)/2 on y centred at
    [0, 0]; point i at angle 2*pi*i/48; crest = [0, OD(t)/2]; rings at t =
    0.2, 0.4, 0.6, 0.8 have x-extent S_k_OW and y-extent S_k_OD within 0.1
    mm; leg_length_mm equals Leg_Length within 0.05.
12. `guards` and `compare` are not in v1 (version 2, Phase 2).

Exports. TS `packages/shared/src/legModel.ts`: LEG_MODEL_FORMAT,
LEG_MODEL_VERSION, LEG_MODEL_FRAME, LEG_MODEL_RING_COUNT,
LEG_MODEL_RING_POINTS, FIT_CHECKS, FitCheck, FIT_ACTION_KINDS, FitAction,
LegModel, LegModelRing, `validateLegModel(value: unknown): string[]`,
re-exported from index.ts. Python `forms_pipeline/shape/contract.py`: frozen
pydantic models with `extra="forbid"` (cad/model.py pattern): LegModel, Ring,
FitAction; `parse_leg_model(data: dict) -> LegModel` raising
`LegModelError(ValueError)` (non-retriable) whose message names fields, never
values.

## 2. forms.measurement-quality v1 (server and admin only)

```json
{
  "format": "forms.measurement-quality",
  "version": 1,
  "values": {
    "Leg_Length": { "source": "observed", "sigma_mm": 4.2 },
    "S1_ISW": { "source": "inferred", "sigma_mm": 3.1 },
    "...": "exactly the 25 MEASUREMENT_KEYS, no more, no fewer"
  },
  "verdict": "optional",
  "worst_ratio": 0.83,
  "worst_key": "S2_OD",
  "tolerances_mm": { "Leg_Length": 15.0, "S1_OW": 6.0, "...": "one entry per fit-critical key" },
  "action": { "kind": "tape", "key": "S2_OD" }
}
```

Rules:

1. Keys exactly as shown; `format` == "forms.measurement-quality",
   `version` == 1.
2. `values` has exactly MEASUREMENT_KEYS; each `{source, sigma_mm}` with
   `source` in VALUE_SOURCES = ["observed", "inferred", "manual", "adjusted"]
   and `sigma_mm` finite, > 0, <= 1000, rounded to 0.01.
3. The enum is VALUE_SOURCES / ValueSource (per-key provenance), distinct
   from the existing `measurements.source` column (row origin, 0014).
4. `verdict` in FIT_CHECKS (no "fail": a failing gate writes no rows).
5. `worst_ratio` finite, >= 0; `worst_key` a fit-critical key, or null if and
   only if worst_ratio == 0.
6. `tolerances_mm` keys in MEASUREMENT_KEYS, values finite and > 0.
7. `action` null if and only if verdict is "none"; otherwise the FitAction
   shape from section 1.
8. Producer: "observed" when a scan source measured that quantity at that
   height (L, OW, OD); "inferred" when the model filled it (the 16 inner keys
   always in v1); "manual" or "adjusted" for typed keys passed through (shape/
   receives `adjusted: bool` explicitly).

Exports. TS `packages/shared/src/quality.ts`: VALUE_SOURCES, ValueSource,
MEASUREMENT_QUALITY_FORMAT, MeasurementQuality,
`validateMeasurementQuality(value: unknown): string[]` (FIT_CHECKS imported
from legModel.ts). Python: `MeasurementQuality`, `parse_measurement_quality`
in `shape/contract.py`.

Shared fixtures: `packages/shared/tests/fixtures/leg-model-v1/` and
`packages/shared/tests/fixtures/measurement-quality-v1/`. Every `valid-*.json`
validates on both sides, every `invalid-*.json` fails on both sides; tests
assert pass or fail only. Python reads them by repo-relative path. All
synthetic. `valid-python-output.json` (generated by legmodel.py from the prior
mean) is compared as parsed JSON and kept prettier-formatted.

## 3. Prior file: `shape/priors/prior-0.1.1.json`

```json
{
  "format": "forms.leg-prior",
  "format_version": 1,
  "prior_version": "0.1.1",
  "schema_version": "1.1.0",
  "provisional": true,
  "provenance": "Bootstrap prior, no anthropometric survey data. Means: the synthetic silhouette leg in services/pipeline/tests/test_silhouette.py (PROFILE, ANKLE_H to KNEE_H), in extraction's definitions: h_k = ANKLE_H + t_k * (KNEE_H - ANKLE_H); log_w[k] = ln(2000 * max(a, b)) and log_d[k] = ln(2000 * min(a, b)), a and b the PCHIP of PROFILE columns 1 and 2 at h_k (an elliptical section's extents along its own axes are its full axes, so OW is the larger extent and OD the smaller, as extract_measurements gives on truth_mesh()); log_L = ln(380); rounded to 6 decimals. Supersedes 0.1.0, whose OW was the mediolateral semi-axis. Level sigmas: schema 1.1.0 plausible ranges, sigma = ln(max/min)/4. Correlations and shape sigmas: placeholders. TODO(liam): replace (SCAN-V3-PLAN 4.2).",
  "grid": {
    "K": 21,
    "t": [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]
  },
  "components": ["log_L", "log_w", "log_d"],
  "mean": {
    "log_L": 5.940171,
    "log_w": ["21 numbers, see derivation"],
    "log_d": ["21 numbers, see derivation"]
  },
  "covariance": {
    "kind": "level_plus_kronecker_v1",
    "level_sigma": [0.346574, 0.498108, 0.498108],
    "level_correlation": [[1.0, 0.5, 0.5], [0.5, 1.0, 0.5], [0.5, 0.5, 1.0]],
    "shape_sigma": [0.1, 0.1],
    "shape_correlation": [[1.0, 0.5], [0.5, 1.0]],
    "kernel": { "kind": "squared_exponential", "length_scale_t": 0.25 },
    "jitter": 1e-6
  },
  "covariates": []
}
```

State layout (n = 43; `model.py` owns GRID_T = k/20, k = 0..20): index 0 =
log_L; 1..21 = log_w[k] (OW, extraction's larger full section extent);
22..42 = log_d[k] (OD, the smaller). Logs of mm. S1..S4 are k = 4, 8, 12, 16.

Mean derivation (written once, enforced by a test importing `PROFILE`,
`ANKLE_H`, `KNEE_H` from tests/test_silhouette.py): h_k = ANKLE_H + t_k *
(KNEE_H - ANKLE_H); a(h_k) and b(h_k) the PCHIP of PROFILE columns 1 and 2 as
`_profile()` there; log_w[k] = ln(2000 * max(a, b)), log_d[k] = ln(2000 *
min(a, b)); log_L = ln(380); rounded to 6 decimals, test tolerance 1e-5. An
elliptical section's extents along its own axes are its full axes, so this is
extraction's OW (larger extent) and OD (smaller) on the same leg: a second test
requires the mean's S1..S4 OD/OW to equal `extract_measurements(truth_mesh())`
within 0.02 (observed under 1e-6), and requires 0.1.0 to fail that check.

2026-11-11: 0.1.0 took OW from the anatomical mediolateral semi-axis, but
extraction's OW is the larger section extent in its PCA frame; 0.1.1 matches
extraction. Extraction's OW/OD are not anatomically oriented (KNOWN-ISSUES), so
the leg model's x/y semantics inherit that until the anatomical frame lands.
0.1.0 (log_w[k] = ln(2000 * a(h_k)), log_d[k] = ln(2000 * b(h_k)), OD/OW 1.165,
1.127, 1.117, 1.099 at S1..S4 against extraction's 0.858, 0.887, 0.895, 0.910)
stays packaged and loadable, unchanged; 0.1.1 differs from it only in
prior_version, provenance and the mean (log_w and log_d swap, since b > a at
every grid height of the synthetic leg). 0.1.1 is the default in prior.py and
harness/estimate.py.

Level sigmas: Leg_Length ln(600/150)/4 = 0.346574; OW and OD ln(220/30)/4 =
0.498108; a test re-derives them from the schema file.

Covariance (PSD by construction): J is 43 x 3 with J[0,0] = 1, J[1+k,1] = 1,
J[22+k,2] = 1. C_level = diag(level_sigma) @ level_correlation @
diag(level_sigma) (order log_L, log_w, log_d). C_shape = diag(shape_sigma) @
shape_correlation @ diag(shape_sigma) (order log_w, log_d). K[i,j] =
exp(-(t_i - t_j)^2 / (2 * length_scale_t^2)) + jitter * delta_ij. Sigma = J
C_level J^T + blockdiag(0 for the L slot, np.kron(C_shape, K)).

Covariates: supported by the format, exercised only by a test-only prior; 0.1.0
and 0.1.1 ship none. One entry: `{ "name": "stature_mm", "transform": "log",
"reference": 1700.0, "population_sigma": 0.06, "coefficients": [1.0, 0.5, 0.5]
}` (test data, never shipped). format_version 1 allows only name
"stature_mm", transform "log"; coefficients length 3 in level order. Present:
mu += J @ coefficients * (ln(z) - ln(reference)). Absent: Sigma += J @
outer(coefficients) @ J^T * population_sigma^2. A stature outside 600-2200 mm
raises a typed error.

Validation in prior.py (typed PriorError, non-retriable): exact format,
format_version 1, semver prior_version; K == 21 and t equal to GRID_T within
1e-9; components exactly as listed; arrays length K, finite; sigmas in (0, 2];
correlation matrices symmetric, unit diagonal, Cholesky-positive;
length_scale_t in (0, 2]; jitter in (0, 1e-3]; covariates as above; file at
most 1 MiB; assembled Sigma passes Cholesky; `provisional` exposed.

## 4. Observations (observe.py, versioned by ESTIMATOR_VERSION = "0.1.0")

Provisional noise, TODO(liam): calibrate from Phase 0 (plan 4.4):

| source | sigma width mm | sigma depth mm | sigma L mm | scale_log_sigma | rho_obs |
|---|---|---|---|---|---|
| mesh (photogrammetry, LiDAR, uploaded OBJ) | 1.5 | 2.0 | 5.0 | 0.02 | 0.5 |
| silhouette (lofted mesh) | 2.0 | 3.0 x clip(1 + (150 - span)/30, 1, 2); worst case if span missing | 5.0 | 0.015 | 0.5 |
| scale_free (plain video, the harness) | as silhouette | as silhouette | as silhouette | 1.0 | 0.5 |
| manual / adjusted (9 typed keys) | 3.0 | 3.0 | 5.0 | none | 0 |

Log-space observations y = ln(v), sigma_log = sigma_mm / v. Per profile block
of one capture, R_block = diag(s) [(1 - rho_obs) I + rho_obs K_obs] diag(s),
K_obs the squared-exponential kernel (length 0.25) on the observed t. Add
scale_log_sigma^2 * 1 1^T across every row of that capture, including L (the
per-capture log-scale nuisance, marginalized exactly). Manual pass-through
keys are conditioned with effective noise 0.05 mm so the projection reproduces
the typed values; their reported sigma_mm is the tape sigma above.

Evidence comes from mesh sections, never from silhouette artifacts:

```python
# shape/observe.py
SourceKind = Literal["mesh", "silhouette", "scale_free"]

@dataclass(frozen=True)
class SectionProfile:
    """One capture's leg sections at grid heights, mm, in extraction's frame."""
    source: SourceKind
    leg_length_mm: float
    t: tuple[float, ...]          # subset of GRID_T[1:20]; heights with no section are absent
    width_mm: tuple[float, ...]   # OW-definition extent at each t
    depth_mm: tuple[float, ...]   # OD-definition extent at each t
    azimuth_span_deg: float | None = None  # None means worst-case sigma

def section_profile_from_mesh(mesh: trimesh.Trimesh, source: SourceKind,
                              azimuth_span_deg: float | None = None) -> SectionProfile: ...
def observations_from_profile(profile: SectionProfile) -> Observations: ...
def observations_from_manual(values_mm: Mapping[str, float], adjusted: bool) -> Observations: ...
```

One non-behavioural change to extraction/measure.py: add
`oriented_leg_mesh(mesh) -> tuple[trimesh.Trimesh, float, bool]` (rotated mm
mesh, leg length mm, needs_scale_confirmation) and rename `_slice_dims` to
public `slice_dims(mesh_rot, z)`; `extract_measurements` uses both;
EXTRACTION_VERSION stays 0.2.0; test_measure.py and test_golden.py pass
unchanged. Sample t = 0.05..0.95 only; a slice raising MeasurementError is
dropped. Observations at k = 4, 8, 12, 16 equal extract_measurements' S_k_OW
and S_k_OD exactly.

## 5. State, fusion, gate

- v1 state is the 43 numbers above; a(t), m(t), shape harmonics, pose/axis
  nuisances, Gauss-Newton and bilateral are deferred. The v1 25-value
  projection of the inner keys is the symmetric split ISW = ICW = OW/2,
  ISD = ICD = OD, so manual-only output equals today's
  manualMeasurements.ts (pinned by a test).
- fuse.py: closed-form Gaussian conditioning (Cholesky solves, Joseph form).
  Caps: at most 4096 observation rows and 8 sources, else EstimatorError.
- `shape/errors.py`: `EstimatorError(RuntimeError)`, `PriorError`, each with
  a fixed user-facing message with no numbers and an internal `code`. Never
  log or put a value, ring or sigma in an exception.
- gate.py returns `GateResult(verdict, worst_ratio, worst_key, action,
  sigma_mm)` and never raises; "fail" becomes GateViolationError at wiring.
  r = max over fit-critical keys of 2 * sigma / T, excluding manual and
  adjusted pass-through keys. Bands: r <= 0.6 none, r <= 1.0 optional,
  r <= 2.0 required, else fail. DEFAULT_TOLERANCES (provisional): Leg_Length
  15 mm, S1..S4 OW and OD 6 mm, derived from MEASUREMENT_KEYS by suffix;
  TODO(liam): plan section 15 decision 7. One tolerance set for now; per
  product later (worst over purchasable products).
- Best next action: argmin of the resulting r, computed exactly (covariance
  does not depend on y), over tape on each fit-critical key plus stature when
  the prior has that covariate and it is missing. Ties: smaller total
  fit-critical variance, then MEASUREMENT_KEYS order, stature last.
- Prior-only (no scan, no manual) must give verdict fail (plan 4.5).
- Guard shells deferred to Phase 2.
