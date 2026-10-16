import { describe, expect, it } from 'vitest';
import { entityStateAt, ENTITY_STRIDE, type EntityTrack } from '../src/entity-track.js';

/** Builds a track from samples given as [tick, ...nine values]. */
function track(samples: number[][], cellWidth = 32): EntityTrack {
  return {
    slot: 3,
    className: 'CFuncRotating',
    classIndex: 0,
    cellWidth,
    ticks: Uint32Array.from(samples.map((s) => s[0]!)),
    values: Float32Array.from(samples.flatMap((s) => s.slice(1))),
    moves: samples.length > 0,
  };
}

const N = NaN;

describe('entityStateAt', () => {
  it('knows nothing before the first sample', () => {
    const state = entityStateAt(track([[10, 600, 600, 600, 0, 0, 0, 0, 0, 0]]), 9);
    expect(state.origin.every(Number.isNaN)).toBe(true);
    expect(state.angles.every(Number.isNaN)).toBe(true);
  });

  it('turns cells and offsets into world coordinates', () => {
    // cell 600 of 32 units, counted from the middle of the world
    const state = entityStateAt(track([[0, 600, 512, 500, 1.5, 2, 3, 0, 0, 0]]), 0);
    expect(state.origin[0]).toBeCloseTo(600 * 32 - 16384 + 1.5);
    expect(state.origin[1]).toBeCloseTo(512 * 32 - 16384 + 2);
    expect(state.origin[2]).toBeCloseTo(500 * 32 - 16384 + 3);
  });

  it('leaves a component unknown when either half is missing', () => {
    const state = entityStateAt(track([[0, N, N, N, 1, 2, 3, 10, 20, 30]]), 5);
    expect(state.origin.every(Number.isNaN)).toBe(true);
    expect(state.angles).toEqual([10, 20, 30]);
  });

  it('holds the last sample rather than interpolating', () => {
    const t = track([
      [0, N, N, N, N, N, N, 0, 0, 0],
      [10, N, N, N, N, N, N, 0, 90, 0],
      [20, N, N, N, N, N, N, 0, 180, 0],
    ]);
    expect(entityStateAt(t, 10).angles[1]).toBe(90);
    expect(entityStateAt(t, 19).angles[1]).toBe(90);
    expect(entityStateAt(t, 20).angles[1]).toBe(180);
    expect(entityStateAt(t, 9999).angles[1]).toBe(180);
  });

  it('finds the right sample in a long track', () => {
    const samples = Array.from({ length: 500 }, (_, i) => [i * 2, N, N, N, N, N, N, 0, i, 0]);
    const t = track(samples);
    expect(t.values).toHaveLength(500 * ENTITY_STRIDE);
    expect(entityStateAt(t, 0).angles[1]).toBe(0);
    expect(entityStateAt(t, 101).angles[1]).toBe(50);
    expect(entityStateAt(t, 998).angles[1]).toBe(499);
  });

  it('says nothing for a track with no samples', () => {
    const state = entityStateAt(track([]), 100);
    expect(state.origin.every(Number.isNaN)).toBe(true);
  });
});
