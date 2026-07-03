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

(none yet: first real captures are ROADMAP.md week 2-3)
