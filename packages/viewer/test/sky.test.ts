import { describe, expect, it } from 'vitest';
import { SKY_SIDES } from '../src/sky.js';

type Vec = [number, number, number];

const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (v: Vec, k: number): Vec => [v[0] * k, v[1] * k, v[2] * k];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const key = (v: Vec): string => v.map((c) => (Math.abs(c) < 1e-9 ? 0 : Math.round(c))).join(',');

/** The direction of a point on a face, with s across and t down. */
const direction = (face: (typeof SKY_SIDES)[number], s: number, t: number): Vec =>
  add(
    add(face.normal as Vec, scale(face.right as Vec, 2 * s - 1)),
    scale(face.up as Vec, 1 - 2 * t),
  );

describe('the sky faces', () => {
  it('cover the six directions once each', () => {
    const normals = SKY_SIDES.map((f) => key(f.normal as Vec));
    expect(new Set(normals).size).toBe(6);
    expect(new Set(normals)).toEqual(
      new Set(['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1']),
    );
  });

  it('are square and square to each other', () => {
    for (const face of SKY_SIDES) {
      const n = face.normal as Vec;
      const r = face.right as Vec;
      const u = face.up as Vec;
      expect(dot(n, n)).toBeCloseTo(1);
      expect(dot(r, r)).toBeCloseTo(1);
      expect(dot(u, u)).toBeCloseTo(1);
      expect(dot(n, r)).toBeCloseTo(0);
      expect(dot(n, u)).toBeCloseTo(0);
      expect(dot(r, u)).toBeCloseTo(0);
    }
  });

  it('meet along their edges, so the images join up', () => {
    // every corner of the cube is reached by exactly three faces, and every
    // edge by two: counting the corners each face produces proves it.
    const corners = new Map<string, number>();
    for (const face of SKY_SIDES) {
      for (const [s, t] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const at = key(direction(face, s!, t!));
        corners.set(at, (corners.get(at) ?? 0) + 1);
      }
    }
    expect(corners.size).toBe(8);
    for (const count of corners.values()) expect(count).toBe(3);
  });

  it('puts the sides around the horizon in the order the seams need', () => {
    // right, front, left, back, turning clockwise seen from above
    const order = ['rt', 'ft', 'lf', 'bk'];
    const yaw = (face: (typeof SKY_SIDES)[number]): number =>
      (Math.round((Math.atan2(face.normal[1]!, face.normal[0]!) * 180) / Math.PI) + 360) % 360;
    const sides = order.map((side) => SKY_SIDES.find((f) => f.side === side)!);
    expect(sides.map(yaw)).toEqual([0, 270, 180, 90]);
    // the right edge of one is the left edge of the next
    for (let i = 0; i < 4; i++) {
      const here = direction(sides[i]!, 1, 0);
      const next = direction(sides[(i + 1) % 4]!, 0, 0);
      expect(key(here)).toBe(key(next));
    }
  });

  it('joins the top face to the top of the sides', () => {
    const up = SKY_SIDES.find((f) => f.side === 'up')!;
    const rt = SKY_SIDES.find((f) => f.side === 'rt')!;
    // the bottom edge of the top image runs along the top edge of the right one
    expect(key(direction(up, 0, 1))).toBe(key(direction(rt, 0, 0)));
    expect(key(direction(up, 1, 1))).toBe(key(direction(rt, 1, 0)));
  });

  it('joins the bottom face to the bottom of the sides', () => {
    const dn = SKY_SIDES.find((f) => f.side === 'dn')!;
    const rt = SKY_SIDES.find((f) => f.side === 'rt')!;
    expect(key(direction(dn, 0, 0))).toBe(key(direction(rt, 0, 1)));
    expect(key(direction(dn, 1, 0))).toBe(key(direction(rt, 1, 1)));
  });
});
