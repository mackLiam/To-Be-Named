import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LEG_MODEL_RING_COUNT, LEG_MODEL_RING_POINTS, type LegModel } from '@forms/shared';
import { describe, expect, it } from 'vitest';

import { GUARD_TEMPLATES } from './fitPreview';
import {
  LEG_TRIANGLE_COUNT,
  LEG_VERTEX_COUNT,
  SIDE_VERTEX_COUNT,
  bandMesh,
  buildLegGeometry,
  coverageBand,
  faceNormal,
  legViewerLabel,
  type TriangleMesh,
} from './legGeometry';

const FIXTURES = join(__dirname, '../../../../packages/shared/tests/fixtures/leg-model-v1');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function validModel(): LegModel {
  const result = buildLegGeometry(fixture('valid-python-output.json'));
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.model;
}

function validLeg(): TriangleMesh {
  const result = buildLegGeometry(fixture('valid-python-output.json'));
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.leg;
}

function vec(arr: Float32Array, i: number): [number, number, number] {
  return [arr[i * 3] as number, arr[i * 3 + 1] as number, arr[i * 3 + 2] as number];
}

function zRange(mesh: TriangleMesh): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) {
    min = Math.min(min, mesh.positions[i] as number);
    max = Math.max(max, mesh.positions[i] as number);
  }
  return { min, max };
}

/** Welds vertices by position, so the separate cap vertices join the side. */
function directedEdges(mesh: TriangleMesh): Map<string, number> {
  const ids = new Map<string, number>();
  const weld = (v: number) => {
    const key = vec(mesh.positions, v)
      .map((c) => c.toFixed(3))
      .join(',');
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key) as number;
  };
  const edges = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [0, 1, 2].map((k) => weld(mesh.indices[t + k] as number));
    for (let k = 0; k < 3; k++) {
      const key = `${tri[k]}>${tri[(k + 1) % 3]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return edges;
}

describe('buildLegGeometry', () => {
  it('produces 21 rings x 48 points plus two cap fans', () => {
    const leg = validLeg();
    expect(SIDE_VERTEX_COUNT).toBe(21 * 48);
    expect(LEG_VERTEX_COUNT).toBe(21 * 48 + 2 * 49);
    expect(LEG_TRIANGLE_COUNT).toBe(20 * 48 * 2 + 2 * 48);
    expect(leg.positions.length).toBe(LEG_VERTEX_COUNT * 3);
    expect(leg.normals.length).toBe(LEG_VERTEX_COUNT * 3);
    expect(leg.indices.length).toBe(LEG_TRIANGLE_COUNT * 3);
    expect(Math.max(...leg.indices)).toBe(LEG_VERTEX_COUNT - 1);
  });

  it('places ring k at z = t_k * leg_length_mm with the ring points unchanged', () => {
    const model = validModel();
    const leg = validLeg();
    for (let k = 0; k < LEG_MODEL_RING_COUNT; k++) {
      const ring = model.rings[k]!;
      for (let i = 0; i < LEG_MODEL_RING_POINTS; i++) {
        const [x, y, z] = vec(leg.positions, k * LEG_MODEL_RING_POINTS + i);
        expect(x).toBeCloseTo(ring.points[i]![0], 3);
        expect(y).toBeCloseTo(ring.points[i]![1], 3);
        expect(z).toBeCloseTo(ring.t * model.leg_length_mm, 3);
      }
    }
  });

  it('has no NaN and unit-length normals', () => {
    const leg = validLeg();
    expect(leg.positions.every(Number.isFinite)).toBe(true);
    for (let v = 0; v < LEG_VERTEX_COUNT; v++) {
      expect(Math.hypot(...vec(leg.normals, v))).toBeCloseTo(1, 5);
    }
  });

  it('is closed with consistent winding: every edge is shared once in each direction', () => {
    const edges = directedEdges(validLeg());
    for (const [key, count] of edges) {
      expect(count, key).toBe(1);
      const [a, b] = key.split('>');
      expect(edges.get(`${b}>${a}`), key).toBe(1);
    }
  });

  it('points side normals and side faces away from the ring centre', () => {
    const model = validModel();
    const leg = validLeg();
    for (let v = 0; v < SIDE_VERTEX_COUNT; v++) {
      const ring = model.rings[Math.floor(v / LEG_MODEL_RING_POINTS)]!;
      const [x, y] = vec(leg.positions, v);
      const [nx, ny] = vec(leg.normals, v);
      expect(nx * (x - ring.center[0]) + ny * (y - ring.center[1])).toBeGreaterThan(0);
    }
    const sideTriangles = (LEG_MODEL_RING_COUNT - 1) * LEG_MODEL_RING_POINTS * 2;
    for (let t = 0; t < sideTriangles; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => leg.indices[t * 3 + k] as number) as [
        number,
        number,
        number,
      ];
      const [nx, ny] = faceNormal(leg.positions, a, b, c);
      const cx = ((leg.positions[a * 3] as number) + (leg.positions[b * 3] as number)) / 2;
      const cy = ((leg.positions[a * 3 + 1] as number) + (leg.positions[b * 3 + 1] as number)) / 2;
      expect(nx * cx + ny * cy).toBeGreaterThan(0);
    }
  });

  it('caps face down at the ankle and up at the knee', () => {
    const leg = validLeg();
    const capTriangles = LEG_MODEL_RING_POINTS;
    const first = LEG_TRIANGLE_COUNT - 2 * capTriangles;
    for (let t = first; t < LEG_TRIANGLE_COUNT; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => leg.indices[t * 3 + k] as number) as [
        number,
        number,
        number,
      ];
      const nz = faceNormal(leg.positions, a, b, c)[2];
      const z = leg.positions[a * 3 + 2] as number;
      if (t < first + capTriangles) {
        expect(z).toBe(0);
        expect(nz).toBeLessThan(0);
      } else {
        expect(z).toBeGreaterThan(0);
        expect(nz).toBeGreaterThan(0);
      }
    }
    for (let v = SIDE_VERTEX_COUNT; v < LEG_VERTEX_COUNT; v++) {
      const nz = vec(leg.normals, v)[2];
      expect(Math.abs(nz)).toBe(1);
    }
  });

  it('encloses a positive volume (outward orientation overall)', () => {
    const leg = validLeg();
    let sixVolume = 0;
    for (let t = 0; t < leg.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => vec(leg.positions, leg.indices[t + k] as number));
      sixVolume +=
        a![0] * (b![1] * c![2] - b![2] * c![1]) -
        a![1] * (b![0] * c![2] - b![2] * c![0]) +
        a![2] * (b![0] * c![1] - b![1] * c![0]);
    }
    expect(sixVolume / 6).toBeGreaterThan(0);
  });

  it('rejects every invalid fixture with violations and no geometry', () => {
    const invalid = readdirSync(FIXTURES).filter((f) => f.startsWith('invalid-'));
    expect(invalid.length).toBeGreaterThan(0);
    for (const name of invalid) {
      const result = buildLegGeometry(fixture(name));
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.errors.length, name).toBeGreaterThan(0);
      expect('leg' in result, name).toBe(false);
    }
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 42, 'leg', []]) {
      expect(buildLegGeometry(value).ok).toBe(false);
    }
  });

  it('accepts every valid fixture', () => {
    const valid = readdirSync(FIXTURES).filter((f) => f.startsWith('valid-'));
    for (const name of valid) expect(buildLegGeometry(fixture(name)).ok, name).toBe(true);
  });
});

describe('coverage band', () => {
  it('equals the template fractions times leg_length_mm', () => {
    const band = coverageBand(380, GUARD_TEMPLATES.club);
    expect(band.bottomMm).toBeCloseTo(0.2 * 380, 9);
    expect(band.topMm).toBeCloseTo(0.8 * 380, 9);
    expect(band.heightMm).toBeCloseTo(0.6 * 380, 9);
  });

  it.each(Object.values(GUARD_TEMPLATES))('band mesh z range matches $name', (template) => {
    const model = validModel();
    for (const lift of [0, 0.4]) {
      const mesh = bandMesh(model, template, lift);
      const { min, max } = zRange(mesh);
      expect(min).toBeCloseTo(template.bottom * model.leg_length_mm, 3);
      expect(max).toBeCloseTo(template.top * model.leg_length_mm, 3);
      expect(mesh.positions.every(Number.isFinite)).toBe(true);
      expect(mesh.indices.length % 3).toBe(0);
      expect(Math.max(...mesh.indices)).toBe(mesh.positions.length / 3 - 1);
    }
  });

  it('band normals point outward', () => {
    const model = validModel();
    const mesh = bandMesh(model, GUARD_TEMPLATES.pro);
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const [x, y] = vec(mesh.positions, v);
      const [nx, ny] = vec(mesh.normals, v);
      expect(nx * x + ny * y).toBeGreaterThan(0);
    }
  });

  it('lift moves the band outward in xy only', () => {
    const model = validModel();
    const flat = bandMesh(model, GUARD_TEMPLATES.club, 0);
    const lifted = bandMesh(model, GUARD_TEMPLATES.club, 0.4);
    for (let v = 0; v < flat.positions.length / 3; v++) {
      const [x0, y0, z0] = vec(flat.positions, v);
      const [x1, y1, z1] = vec(lifted.positions, v);
      expect(z1).toBe(z0);
      expect(Math.hypot(x1, y1) - Math.hypot(x0, y0)).toBeCloseTo(0.4, 3);
    }
  });

  it('spans a full model ring range when fractions sit on rings (club: rings 4 to 16)', () => {
    const mesh = bandMesh(validModel(), GUARD_TEMPLATES.club);
    expect(mesh.positions.length / 3).toBe(13 * LEG_MODEL_RING_POINTS);
  });

  it('rejects fractions outside 0 <= bottom < top <= 1', () => {
    const model = validModel();
    expect(() => bandMesh(model, { bottom: 0.5, top: 0.5 })).toThrow(RangeError);
    expect(() => bandMesh(model, { bottom: -0.1, top: 0.5 })).toThrow(RangeError);
    expect(() => bandMesh(model, { bottom: 0.2, top: 1.1 })).toThrow(RangeError);
    expect(() => bandMesh(model, { bottom: Number.NaN, top: 0.5 })).toThrow(RangeError);
  });

  it('handles the full leg (0 to 1) without leaving the ring range', () => {
    const model = validModel();
    const { min, max } = zRange(bandMesh(model, { bottom: 0, top: 1 }));
    expect(min).toBeCloseTo(0, 6);
    expect(max).toBeCloseTo(model.leg_length_mm, 3);
  });
});

describe('legViewerLabel', () => {
  it('states the template, coverage percent and height', () => {
    expect(legViewerLabel(GUARD_TEMPLATES.club, 380)).toBe(
      '3D model of your leg with the Club guard coverage band, 60% of your leg length, 228 mm tall',
    );
  });
});
