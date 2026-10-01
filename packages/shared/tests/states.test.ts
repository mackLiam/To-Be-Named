import { describe, expect, it } from 'vitest';
import { CAPTURE_KINDS, PIPELINE_STEPS, VALID_TRANSITIONS } from '../src/states.js';

describe('PIPELINE_STEPS', () => {
  it('matches the SQL step CHECK order, with reconstructing after uploaded', () => {
    expect(PIPELINE_STEPS).toEqual([
      'captured',
      'uploaded',
      'reconstructing',
      'measuring',
      'measured',
      'generating_cad',
      'stl_ready',
      'queued_for_print',
      'printing',
      'shipped',
      'failed',
    ]);
  });
});

describe('VALID_TRANSITIONS', () => {
  it('is the explicit table pinned in the plan (A3)', () => {
    expect(VALID_TRANSITIONS).toEqual({
      captured: ['uploaded', 'failed'],
      uploaded: ['reconstructing', 'measuring', 'failed'],
      reconstructing: ['measuring', 'failed'],
      measuring: ['measured', 'failed'],
      measured: ['failed'],
      generating_cad: ['stl_ready', 'failed'],
      stl_ready: ['queued_for_print', 'failed'],
      queued_for_print: ['printing', 'failed'],
      printing: ['shipped', 'failed'],
      shipped: [],
      failed: [],
    });
  });

  it('has an entry for every step and only targets known steps', () => {
    expect(Object.keys(VALID_TRANSITIONS).sort()).toEqual([...PIPELINE_STEPS].sort());
    for (const targets of Object.values(VALID_TRANSITIONS)) {
      for (const t of targets) expect(PIPELINE_STEPS).toContain(t);
    }
  });

  it('lets mesh scans skip reconstruction but not jump past measuring', () => {
    expect(VALID_TRANSITIONS.uploaded).toContain('measuring');
    expect(VALID_TRANSITIONS.uploaded).not.toContain('measured');
    expect(VALID_TRANSITIONS.reconstructing).not.toContain('measured');
  });

  it('ends a measure job at measured: no transition into CAD', () => {
    expect(VALID_TRANSITIONS.measured).not.toContain('generating_cad');
  });

  it('allows failing from every non-terminal step and nothing out of terminals', () => {
    for (const step of PIPELINE_STEPS) {
      if (step === 'failed' || step === 'shipped') {
        expect(VALID_TRANSITIONS[step]).toEqual([]);
      } else {
        expect(VALID_TRANSITIONS[step]).toContain('failed');
      }
    }
  });
});

describe('CAPTURE_KINDS', () => {
  it('matches the scans.capture_kind CHECK', () => {
    expect(CAPTURE_KINDS).toEqual(['mesh', 'photos']);
  });
});
