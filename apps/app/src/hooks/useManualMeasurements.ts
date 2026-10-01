import type { MeasurementKey, Measurements } from '@forms/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listMeasurements } from '../lib/api';
import { latestMeasurements } from '../lib/library';
import {
  DERIVED_KEYS,
  LEG_LENGTH,
  MANUAL_KEYS,
  checkField,
  deriveMeasurements,
  diffAgainstScan,
  parseMm,
  round1,
  sanitizeMmInput,
  sliceHeights,
  validateManual,
  type FieldDiff,
  type Values,
} from '../lib/manualMeasurements';
import {
  NEW_SCAN_ID,
  manualSubmitMessage,
  submitManual,
  type ManualSubmitResult,
} from '../lib/manualSubmit';
import { newScanId } from '../lib/upload';
import type { Leg } from '../lib/upload';

export type MeasureMode = 'manual' | 'adjust';

/** Guided flow: intro, the 9 measured fields in order, review. */
export type Step = 'intro' | MeasurementKey | 'review';
export const STEPS: readonly Step[] = ['intro', ...MANUAL_KEYS, 'review'];

type Texts = Partial<Record<MeasurementKey, string>>;

function toTexts(values: Values, keys: readonly MeasurementKey[]): Texts {
  return Object.fromEntries(
    keys.flatMap((key) => (values[key] === undefined ? [] : [[key, String(round1(values[key]))]])),
  );
}

function parseAll(texts: Texts, keys: readonly MeasurementKey[]): Values {
  const out: Values = {};
  for (const key of keys) {
    const value = parseMm(texts[key]);
    if (value !== null) out[key] = value;
  }
  return out;
}

export function useManualMeasurements(params: {
  scanId: string;
  mode: MeasureMode;
  leg: Leg | null;
  pairId: string | null;
}) {
  const { scanId, leg, pairId } = params;
  // Adjusting needs an existing scan; a new scan is always manual.
  const mode: MeasureMode = scanId === NEW_SCAN_ID ? 'manual' : params.mode;

  const [base, setBase] = useState<Measurements | null>(null);
  const [loading, setLoading] = useState(mode === 'adjust');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [texts, setTexts] = useState<Texts>({});
  const [overrideTexts, setOverrideTexts] = useState<Texts>({});
  const [step, setStep] = useState<Step>('intro');
  const [fromReview, setFromReview] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  // Allocated once so a retry after a failed RPC reuses the same scan row.
  const newId = useRef(newScanId());

  useEffect(() => {
    if (mode !== 'adjust') return;
    let cancelled = false;
    setLoading(true);
    listMeasurements([scanId])
      .then((rows) => {
        if (cancelled) return;
        const latest = latestMeasurements(rows).get(scanId) ?? null;
        setBase(latest);
        if (latest) {
          setTexts(toTexts(latest, MANUAL_KEYS));
          setStep('review');
        } else {
          setLoadError('This scan has no measurements yet, so there is nothing to adjust.');
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError('Could not load the measurements from this scan. Check your connection.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, scanId]);

  const entered = useMemo(() => {
    const parsed = parseAll(texts, MANUAL_KEYS);
    // Fields show one decimal; a prefilled value left as shown is the scan's exact value.
    for (const key of MANUAL_KEYS) {
      if (base && parsed[key] === round1(base[key])) parsed[key] = base[key];
    }
    return parsed;
  }, [texts, base]);
  const overrides = useMemo(() => parseAll(overrideTexts, DERIVED_KEYS), [overrideTexts]);
  const derived = useMemo(
    () => deriveMeasurements(entered, { base: base ?? undefined, overrides }),
    [entered, base, overrides],
  );
  const validation = useMemo(() => validateManual(derived.values), [derived]);
  const diffs = useMemo(() => {
    const byKey = new Map<MeasurementKey, FieldDiff>();
    if (base) {
      for (const diff of diffAgainstScan(base, derived.values)) {
        if (diff.delta !== 0) byKey.set(diff.key, diff);
      }
    }
    return byKey;
  }, [base, derived]);

  const legLength = entered[LEG_LENGTH];
  const heights = useMemo(
    () => (legLength && !checkField(LEG_LENGTH, legLength) ? sliceHeights(legLength) : null),
    [legLength],
  );

  const setText = useCallback((key: MeasurementKey, text: string) => {
    setStepError(null);
    setSubmitError(null);
    setTexts((prev) => ({ ...prev, [key]: sanitizeMmInput(text) }));
  }, []);

  /** Advanced edit of a derived value; clearing it goes back to the estimate. */
  const setOverride = useCallback((key: MeasurementKey, text: string) => {
    setSubmitError(null);
    setOverrideTexts((prev) => ({ ...prev, [key]: sanitizeMmInput(text) }));
  }, []);

  const goTo = useCallback((target: Step, returnToReview = false) => {
    setStepError(null);
    setFromReview(returnToReview);
    setStep(target);
  }, []);

  /** Leave the current step forward; a measured field must pass its range check first. */
  const next = useCallback(() => {
    if (step !== 'intro' && step !== 'review') {
      const problem = checkField(step, parseMm(texts[step]));
      if (problem) {
        setStepError(problem);
        return;
      }
    }
    const index = STEPS.indexOf(step);
    goTo(fromReview ? 'review' : (STEPS[index + 1] ?? 'review'));
  }, [step, texts, fromReview, goTo]);

  const back = useCallback(() => {
    const index = STEPS.indexOf(step);
    if (index > 0) goTo(STEPS[index - 1] as Step);
  }, [step, goTo]);

  const changed = diffs.size > 0;
  const canSubmit = validation.ok && !submitting && (mode === 'manual' || changed);

  const submit = useCallback(async (): Promise<ManualSubmitResult | null> => {
    setShowErrors(true);
    if (!validation.ok || submitting) return null;
    setSubmitting(true);
    setSubmitError(null);
    try {
      return await submitManual({
        scanId,
        leg,
        pairId,
        newScanId: newId.current,
        values: validation.measurements,
      });
    } catch (error) {
      setSubmitError(manualSubmitMessage(error));
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [validation, submitting, scanId, leg, pairId]);

  return {
    mode,
    loading: mode === 'adjust' && loading,
    loadError: mode === 'adjust' ? loadError : null,
    step,
    stepIndex: STEPS.indexOf(step),
    fromReview,
    stepError,
    goTo,
    next,
    back,
    texts,
    overrideTexts,
    setText,
    setOverride,
    values: derived.values,
    estimated: derived.estimated,
    fieldErrors: showErrors && !validation.ok ? validation.errors : {},
    base,
    diffs,
    changed,
    heights,
    advanced,
    setAdvanced,
    canSubmit,
    submit,
    submitting,
    submitError,
  };
}

export type ManualMeasurementsState = ReturnType<typeof useManualMeasurements>;
