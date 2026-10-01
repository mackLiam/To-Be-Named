/**
 * Submit manual (or adjusted) measurements. Pure core submitManualWith(deps,
 * params) with injected I/O, same shape as uploadScanWith in upload.ts;
 * submitManual() is the real-deps / fake-mode wrapper.
 *
 * The client's checks are a fast fail only: submit_manual_measurements
 * re-validates server-side and only the worker marks the result validated.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CaptureKind, Measurements, ScanStatus } from '@forms/shared';

import { validateManual } from './manualMeasurements';
import { getSupabaseClient, hasSupabaseConfig } from './supabase';
import { newScanId, type Leg } from './upload';

/** Route sentinel: no scan row exists yet, so one is created first. */
export const NEW_SCAN_ID = 'new';

const UPLOADED_STATUS: ScanStatus = 'uploaded';
const MANUAL_CAPTURE_KIND: CaptureKind = 'manual';

export type ManualSubmitErrorCode =
  | 'ERR_MANUAL_INVALID'
  | 'ERR_MANUAL_NO_LEG'
  | 'ERR_MANUAL_NO_SESSION'
  | 'ERR_MANUAL_SCAN_DB'
  | 'ERR_MANUAL_IN_PROGRESS'
  | 'ERR_MANUAL_RPC';

export const MANUAL_SUBMIT_MESSAGES: Record<ManualSubmitErrorCode, string> = {
  ERR_MANUAL_INVALID: 'Some values are missing or out of range. Check the ones marked below.',
  ERR_MANUAL_NO_LEG: 'We could not tell which leg this is. Go back and start again.',
  ERR_MANUAL_NO_SESSION: 'You need to be signed in to save measurements. Sign in and try again.',
  ERR_MANUAL_SCAN_DB: 'Your measurements could not be saved. Check your connection and try again.',
  ERR_MANUAL_IN_PROGRESS: 'A measurement is already in progress for this scan.',
  ERR_MANUAL_RPC: 'Your measurements could not be sent. Check your connection and try again.',
};

export class ManualSubmitError extends Error {
  readonly code: ManualSubmitErrorCode;
  readonly cause?: unknown;

  constructor(code: ManualSubmitErrorCode, cause?: unknown) {
    super(MANUAL_SUBMIT_MESSAGES[code]);
    this.name = 'ManualSubmitError';
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** User-facing message for anything submit throws. */
export function manualSubmitMessage(error: unknown): string {
  return error instanceof ManualSubmitError ? error.message : MANUAL_SUBMIT_MESSAGES.ERR_MANUAL_RPC;
}

export interface ManualSubmitParams {
  /** Existing scan id, or NEW_SCAN_ID to create the scan row first. */
  scanId: string;
  /** Required with NEW_SCAN_ID. */
  leg?: Leg | null;
  pairId?: string | null;
  /** Id for the new scan row. Allocate once and reuse on retry so a retry
   * after a failed RPC updates the same row instead of making another. */
  newScanId?: string;
  values: Partial<Measurements>;
}

export interface ManualSubmitResult {
  scanId: string;
  /** Returned by the RPC; null in fake mode. */
  measurementId: string | null;
  fake: boolean;
}

export interface ManualSubmitDeps {
  client: Pick<SupabaseClient, 'from' | 'rpc'>;
  getUserId(): Promise<string>;
  newScanId(): string;
}

/** Where the screen goes after success: the session when paired, else the scan. */
export function resultRouteKey(params: { pairId?: string | null }, scanId: string): string {
  return params.pairId || scanId;
}

/** Validate locally, create the scan row when needed, then call the RPC. */
export async function submitManualWith(
  deps: ManualSubmitDeps,
  params: ManualSubmitParams,
): Promise<ManualSubmitResult> {
  const checked = validateManual(params.values);
  if (!checked.ok) {
    throw new ManualSubmitError('ERR_MANUAL_INVALID', checked.errors);
  }

  let scanId = params.scanId;
  if (scanId === NEW_SCAN_ID) {
    if (params.leg !== 'L' && params.leg !== 'R') {
      throw new ManualSubmitError('ERR_MANUAL_NO_LEG');
    }
    let userId: string;
    try {
      userId = await deps.getUserId();
    } catch (error) {
      throw new ManualSubmitError('ERR_MANUAL_NO_SESSION', error);
    }
    if (!userId) throw new ManualSubmitError('ERR_MANUAL_NO_SESSION');

    scanId = params.newScanId ?? deps.newScanId();
    // Upsert on id: a retry re-runs this in place. RLS "scans: insert own"
    // and the 0013 status guard enforce owner and status server-side.
    const inserted = await deps.client
      .from('scans')
      .upsert(
        {
          id: scanId,
          user_id: userId,
          leg: params.leg,
          status: UPLOADED_STATUS,
          capture_kind: MANUAL_CAPTURE_KIND,
          mesh_path: null,
          pair_id: params.pairId ?? null,
        },
        { onConflict: 'id' },
      )
      .select('id')
      .single();
    if (inserted.error) {
      throw new ManualSubmitError('ERR_MANUAL_SCAN_DB', inserted.error);
    }
  }

  const submitted = await deps.client.rpc('submit_manual_measurements', {
    p_scan_id: scanId,
    p_values: checked.measurements,
  });
  if (submitted.error) {
    const code = (submitted.error as { code?: unknown }).code;
    throw new ManualSubmitError(
      code === '55P03' ? 'ERR_MANUAL_IN_PROGRESS' : 'ERR_MANUAL_RPC',
      submitted.error,
    );
  }
  return {
    scanId,
    measurementId: typeof submitted.data === 'string' ? submitted.data : null,
    fake: false,
  };
}

function defaultDeps(): ManualSubmitDeps {
  const client = getSupabaseClient();
  return {
    client,
    async getUserId() {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) throw new ManualSubmitError('ERR_MANUAL_NO_SESSION', error);
      return data.user.id;
    },
    newScanId,
  };
}

/** FAKE MODE (no EXPO_PUBLIC_SUPABASE_*): validate, then simulate success like upload.ts. */
async function simulateSubmit(params: ManualSubmitParams): Promise<ManualSubmitResult> {
  const checked = validateManual(params.values);
  if (!checked.ok) throw new ManualSubmitError('ERR_MANUAL_INVALID', checked.errors);
  const scanId = params.scanId === NEW_SCAN_ID ? (params.newScanId ?? newScanId()) : params.scanId;
  return { scanId, measurementId: null, fake: true };
}

export async function submitManual(params: ManualSubmitParams): Promise<ManualSubmitResult> {
  if (!hasSupabaseConfig()) {
    return simulateSubmit(params);
  }
  return submitManualWith(defaultDeps(), params);
}
