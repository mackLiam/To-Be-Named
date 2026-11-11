/**
 * Phase 0.5 sweep capture (SCAN-V3-PLAN.md section 13): dev builds only, and
 * only when EXPO_PUBLIC_SWEEP_CAPTURE is exactly "true". The worker must also
 * run with SWEEP_CAPTURE_ENABLED=true or it rejects sweep bundles.
 */
export function sweepCaptureEnabled(isDev: boolean, envValue: string | undefined): boolean {
  return isDev && envValue === 'true';
}

export const SWEEP_CAPTURE = sweepCaptureEnabled(
  typeof __DEV__ !== 'undefined' && __DEV__,
  process.env.EXPO_PUBLIC_SWEEP_CAPTURE,
);
