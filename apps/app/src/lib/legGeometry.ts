// The bundle-safe subpath: the package root re-exports validate.js, which reads
// the schema with node:fs and cannot be bundled for React Native.
import {
  LEG_MODEL_RING_COUNT,
  LEG_MODEL_RING_POINTS,
  validateLegModel,
  type LegModel,
  type LegModelRing,
} from '@forms/shared/legModel';

import type { GuardTemplate } from './fitPreview';

/**
 * forms.leg-model v1 rings to indexed triangle data for the 3D viewer
 * (SCAN-V3-PLAN.md 7.2 and 7.6). No three.js here: the viewer wraps these
 * arrays in a BufferGeometry and does the only mm to scene-unit scaling.
 *
 * Everything is mm in the leg-model frame (ESTIMATOR-V1.md section 1, rule
 * 8): x toward the player's right, y anterior, z up from the bottom of the
 * ankle, ring k at z = t_k * leg_length_mm. Ring points are absolute frame
 * coordinates, counter-clockwise seen from +z (enforced by the validator).
 */

export interface TriangleMesh {
  /** xyz per vertex, mm. */
  positions: Float32Array;
  /** Unit outward normal per vertex. */
  normals: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint16Array;
}

export interface CoverageBand {
  bottomMm: number;
  topMm: number;
  heightMm: number;
}

export type LegGeometryResult =
  { ok: true; model: LegModel; leg: TriangleMesh } | { ok: false; errors: string[] };

// Side vertices are not shared with the caps so the caps stay flat-shaded
// and the side stays smooth-shaded.
export const SIDE_VERTEX_COUNT = LEG_MODEL_RING_COUNT * LEG_MODEL_RING_POINTS;
export const CAP_VERTEX_COUNT = LEG_MODEL_RING_POINTS + 1;
export const LEG_VERTEX_COUNT = SIDE_VERTEX_COUNT + 2 * CAP_VERTEX_COUNT;
export const LEG_TRIANGLE_COUNT =
  (LEG_MODEL_RING_COUNT - 1) * LEG_MODEL_RING_POINTS * 2 + 2 * LEG_MODEL_RING_POINTS;

const RING_EPSILON_MM = 1e-3;

type Ring3 = { center: [number, number]; z: number; points: [number, number][] };

/**
 * Validates first: an invalid model yields its violations and no geometry.
 * The violations name fields, never values (leg geometry is body data).
 */
export function buildLegGeometry(value: unknown): LegGeometryResult {
  const errors = validateLegModel(value);
  if (errors.length > 0) return { ok: false, errors };
  const model = value as LegModel;
  return { ok: true, model, leg: legMesh(model) };
}

function ringsOf(model: LegModel): Ring3[] {
  return model.rings.map((r: LegModelRing) => ({
    center: r.center,
    z: r.t * model.leg_length_mm,
    points: r.points,
  }));
}

function legMesh(model: LegModel): TriangleMesh {
  const rings = ringsOf(model);
  const n = LEG_MODEL_RING_POINTS;
  const positions = new Float32Array(LEG_VERTEX_COUNT * 3);
  const normals = new Float32Array(LEG_VERTEX_COUNT * 3);
  const indices = new Uint16Array(LEG_TRIANGLE_COUNT * 3);

  writeRings(rings, positions, 0);
  let tri = writeTube(rings.length, n, 0, indices, 0);
  smoothNormals(positions, indices, 0, tri, normals);

  const first = rings[0] as Ring3;
  const last = rings[rings.length - 1] as Ring3;
  let vertex = SIDE_VERTEX_COUNT;
  tri = writeCap(first, -1, positions, normals, indices, vertex, tri);
  vertex += CAP_VERTEX_COUNT;
  writeCap(last, 1, positions, normals, indices, vertex, tri);

  return { positions, normals, indices };
}

/** Band height comes from the template fractions alone (fitPreview.ts GUARD_TEMPLATES). */
export function coverageBand(
  legLengthMm: number,
  template: Pick<GuardTemplate, 'bottom' | 'top'>,
): CoverageBand {
  const bottomMm = template.bottom * legLengthMm;
  const topMm = template.top * legLengthMm;
  return { bottomMm, topMm, heightMm: topMm - bottomMm };
}

/**
 * The leg's side surface between the template's bottom and top fractions, as
 * an open tube. Boundary rings are linear interpolations between neighbouring
 * model rings, so the band's z range is exactly the coverage band. `liftMm`
 * pushes it outward in xy only (render aid against z-fighting), so z is
 * unchanged.
 */
export function bandMesh(
  model: LegModel,
  template: Pick<GuardTemplate, 'bottom' | 'top'>,
  liftMm = 0,
): TriangleMesh {
  if (!(template.bottom >= 0 && template.top <= 1 && template.bottom < template.top)) {
    throw new RangeError('coverage band fractions must satisfy 0 <= bottom < top <= 1');
  }
  const rings = ringsOf(model);
  const band = coverageBand(model.leg_length_mm, template);
  // The epsilon keeps a model ring that sits on a boundary from producing a
  // zero-height strip next to its interpolated copy.
  const inside = rings.filter(
    (r) => r.z > band.bottomMm + RING_EPSILON_MM && r.z < band.topMm - RING_EPSILON_MM,
  );
  const bandRings = [ringAt(rings, band.bottomMm), ...inside, ringAt(rings, band.topMm)].map((r) =>
    lifted(r, liftMm),
  );

  const n = LEG_MODEL_RING_POINTS;
  const vertexCount = bandRings.length * n;
  const triangleCount = (bandRings.length - 1) * n * 2;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint16Array(triangleCount * 3);
  writeRings(bandRings, positions, 0);
  writeTube(bandRings.length, n, 0, indices, 0);
  smoothNormals(positions, indices, 0, triangleCount, normals);
  return { positions, normals, indices };
}

// Rings are evenly spaced in z, so the bracketing pair is found by index.
function ringAt(rings: Ring3[], z: number): Ring3 {
  const top = rings[rings.length - 1] as Ring3;
  const step = top.z / (rings.length - 1);
  const k = Math.min(Math.max(Math.floor(z / step), 0), rings.length - 2);
  const a = rings[k] as Ring3;
  const b = rings[k + 1] as Ring3;
  const s = (z - a.z) / (b.z - a.z);
  const mix = (p: [number, number], q: [number, number]): [number, number] => [
    p[0] + (q[0] - p[0]) * s,
    p[1] + (q[1] - p[1]) * s,
  ];
  return {
    center: mix(a.center, b.center),
    z,
    points: a.points.map((p, i) => mix(p, b.points[i] as [number, number])),
  };
}

function lifted(ring: Ring3, liftMm: number): Ring3 {
  if (liftMm === 0) return ring;
  const [cx, cy] = ring.center;
  return {
    ...ring,
    points: ring.points.map(([x, y]) => {
      const dx = x - cx;
      const dy = y - cy;
      const len = Math.hypot(dx, dy);
      return len === 0 ? [x, y] : [x + (dx / len) * liftMm, y + (dy / len) * liftMm];
    }),
  };
}

function writeRings(rings: Ring3[], positions: Float32Array, firstVertex: number): void {
  let o = firstVertex * 3;
  for (const ring of rings) {
    for (const [x, y] of ring.points) {
      positions[o++] = x;
      positions[o++] = y;
      positions[o++] = ring.z;
    }
  }
}

/**
 * Quads between consecutive rings. With the ring counter-clockwise from +z
 * and z increasing, (a, b, c) and (a, c, d) face outward.
 */
function writeTube(
  ringCount: number,
  n: number,
  firstVertex: number,
  indices: Uint16Array,
  firstTriangle: number,
): number {
  let o = firstTriangle * 3;
  for (let k = 0; k < ringCount - 1; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = firstVertex + k * n + i;
      const b = firstVertex + k * n + j;
      const c = firstVertex + (k + 1) * n + j;
      const d = firstVertex + (k + 1) * n + i;
      indices.set([a, b, c, a, c, d], o);
      o += 6;
    }
  }
  return o / 3;
}

/** Fan from the ring centre; direction -1 is the ankle cap (faces -z), +1 the knee cap. */
function writeCap(
  ring: Ring3,
  direction: 1 | -1,
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint16Array,
  firstVertex: number,
  firstTriangle: number,
): number {
  const n = ring.points.length;
  const centerIndex = firstVertex + n;
  writeRings([ring], positions, firstVertex);
  positions.set([ring.center[0], ring.center[1], ring.z], centerIndex * 3);
  for (let v = firstVertex; v <= centerIndex; v++) normals.set([0, 0, direction], v * 3);

  let o = firstTriangle * 3;
  for (let i = 0; i < n; i++) {
    const p = firstVertex + i;
    const q = firstVertex + ((i + 1) % n);
    indices.set(direction === 1 ? [centerIndex, p, q] : [centerIndex, q, p], o);
    o += 3;
  }
  return o / 3;
}

/** Area-weighted average of face normals over the given triangles. */
function smoothNormals(
  positions: Float32Array,
  indices: Uint16Array,
  firstTriangle: number,
  endTriangle: number,
  normals: Float32Array,
): void {
  const touched = new Set<number>();
  for (let t = firstTriangle; t < endTriangle; t++) {
    const ia = indices[t * 3] as number;
    const ib = indices[t * 3 + 1] as number;
    const ic = indices[t * 3 + 2] as number;
    const [nx, ny, nz] = faceNormal(positions, ia, ib, ic);
    for (const v of [ia, ib, ic]) {
      normals[v * 3] = (normals[v * 3] as number) + nx;
      normals[v * 3 + 1] = (normals[v * 3 + 1] as number) + ny;
      normals[v * 3 + 2] = (normals[v * 3 + 2] as number) + nz;
      touched.add(v);
    }
  }
  for (const v of touched) {
    const x = normals[v * 3] as number;
    const y = normals[v * 3 + 1] as number;
    const z = normals[v * 3 + 2] as number;
    const len = Math.hypot(x, y, z) || 1;
    normals.set([x / len, y / len, z / len], v * 3);
  }
}

/** Unnormalised (b - a) x (c - a): its length is twice the triangle area. */
export function faceNormal(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
): [number, number, number] {
  const p = (i: number, axis: number) => positions[i * 3 + axis] as number;
  const ux = p(b, 0) - p(a, 0);
  const uy = p(b, 1) - p(a, 1);
  const uz = p(b, 2) - p(a, 2);
  const vx = p(c, 0) - p(a, 0);
  const vy = p(c, 1) - p(a, 1);
  const vz = p(c, 2) - p(a, 2);
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** VoiceOver text for the viewer, stating what the 3D view shows in words. */
export function legViewerLabel(
  template: Pick<GuardTemplate, 'name' | 'bottom' | 'top'>,
  legLengthMm: number,
): string {
  const band = coverageBand(legLengthMm, template);
  const percent = Math.round((template.top - template.bottom) * 100);
  return (
    `3D model of your leg with the ${template.name} guard coverage band, ` +
    `${percent}% of your leg length, ${Math.round(band.heightMm)} mm tall`
  );
}
