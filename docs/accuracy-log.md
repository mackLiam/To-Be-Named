# Accuracy Log

Ground-truth comparison of pipeline-extracted measurements vs hand tape-measure,
one entry per scanned leg (ROADMAP.md weeks 3 and 9). This file is also the
provenance record for every golden-file fixture checked into
`services/pipeline/tests/fixtures/`.

Conventions:

- All values in millimeters.
- Delta percent = (pipeline - tape) / tape * 100, one row per variable worth
  recording (record at least Leg_Length and the OW/OD pairs; full 25 when the
  scan becomes a golden fixture).
- Month 1 targets (ROADMAP.md week 3): within ~5% on widths/depths, ~2% on
  length.
- Consent: every logged scan needs the subject's (or guardian's) explicit OK,
  noted in the entry. Meshes checked into `tests/fixtures/` must be small,
  anonymized, and consented for repo storage specifically.
- EXTRACTION_VERSION at time of measurement is required (re-runs after
  algorithm changes are not comparable otherwise).

Slice convention (schema 1.0.0): Leg_Length is bottom of ankle to knee; S1-S4
sit at 20/40/60/80% of Leg_Length measured up from the bottom of the ankle.
Tape-measure at the same heights: mark the leg at 0.2/0.4/0.6/0.8 of the
measured ankle-to-knee length before measuring widths/depths.

---

## Entry template

```
### YYYY-MM-DD - subject NN (age band, leg L/R)

- Capture: device, app/module version, lighting/setup notes
- Mesh: format, file size, vertex count, scale flag
  (needs_scale_confirmation true/false)
- EXTRACTION_VERSION: x.y.z
- Consent: yes/no, fixture-eligible yes/no
- Gates: passed / failed (which)

| Variable | Tape (mm) | Pipeline (mm) | Delta (%) |
|---|---|---|---|
| Leg_Length | | | |
| S1_OW | | | |
| S1_OD | | | |
| S2_OW | | | |
| S2_OD | | | |
| S3_OW | | | |
| S3_OD | | | |
| S4_OW | | | |
| S4_OD | | | |

Notes: what looked wrong, suspected cause (capture / extraction / model),
follow-up action.
```

---

## Entries

### 2026-11-10 - first printed guard (fit check, not an accuracy entry)

- Capture: none. Values set by hand in Onshape and the STL exported by hand
  (not through the pipeline).
- Fit: Liam reports it fit well all over on the leg it was made for.
- Tape measurements of that leg: none yet.
- Open: record the exact variable values used for the print. The pipeline's
  template copy still holds the placeholder values (Leg_Length 200, S1_OW 30,
  S2_OD 13 mm), far below real leg dimensions. Whether the good fit came from
  real-sized OW/OD or from placeholder-scale values decides what OW/OD mean in
  the model (DESIGN.md 12.2). Tape-measuring that leg at 20/40/60/80% turns
  this print into the first ground-truth entry.
- Evidence (read-only Onshape API, 2026-11-10): the template copy holds the
  printed STL as an imported part, extents 95.6 x 23.7 x 149.0 mm. The
  parametric "MVP 1" part studio at its current placeholder values measures
  103.0 x 121.5 x 31.0 mm (a different orientation; sorted, 31 / 103 / 121.5
  against 23.7 / 95.6 / 149). So the print was not generated from the
  template's current values: it came from other values or another document,
  and those values are still unrecorded.
