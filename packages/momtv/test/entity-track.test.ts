import { describe, expect, it } from 'vitest';
import {
  EF_NODRAW,
  entityStateAt,
  ENTITY_STRIDE,
  modelNameCrc,
  type EntityTrack,
} from '../src/entity-track.js';

/**
 * Builds a track from samples given as [tick, ...values], the values padded
 * out to the full stride with NaN.
 */
function track(samples: number[][], options: Partial<EntityTrack> = {}): EntityTrack {
  const pad = (values: number[]): number[] =>
    values.concat(new Array<number>(ENTITY_STRIDE - values.length).fill(NaN));
  return {
    slot: 3,
    className: 'CFuncRotating',
    classIndex: 0,
    model: undefined,
    cellWidth: 32,
    absoluteOrigin: false,
    ticks: Uint32Array.from(samples.map((s) => s[0]!)),
    values: Float32Array.from(samples.flatMap((s) => pad(s.slice(1)))),
    moves: samples.length > 1,
    ...options,
  };
}

const N = NaN;

describe('entityStateAt', () => {
  it('knows nothing before the first sample', () => {
    const state = entityStateAt(track([[10, 600, 600, 600, 0, 0, 0, 0, 0, 0]]), 9);
    expect(state.origin.every(Number.isNaN)).toBe(true);
    expect(state.angles.every(Number.isNaN)).toBe(true);
    expect(state.visible).toBe(true);
  });

  it('turns cells and offsets into world coordinates', () => {
    // Strata Source counts cells from 65536 units below the middle: a rotating
    // trap of deathrun_unique sits in cells 2071, 2073, 2083 at offsets
    // 25.7, 5.5 and 28.1, which is inside the map.
    const state = entityStateAt(track([[0, 2071, 2073, 2083, 25.71875, 5.5, 28.09375]]), 0);
    expect(state.origin[0]).toBeCloseTo(2071 * 32 - 65536 + 25.71875);
    expect(state.origin[1]).toBeCloseTo(2073 * 32 - 65536 + 5.5);
    expect(state.origin[2]).toBeCloseTo(2083 * 32 - 65536 + 28.09375);
  });

  it('takes a plain coordinate as is', () => {
    const state = entityStateAt(
      track([[0, N, N, N, -1200.5, 64, 512]], { absoluteOrigin: true }),
      0,
    );
    expect(state.origin).toEqual([-1200.5, 64, 512]);
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

  it('hides an entity while its effects say not to draw it', () => {
    const t = track([
      [0, N, N, N, N, N, N, N, N, N, 0],
      [5, N, N, N, N, N, N, N, N, N, EF_NODRAW],
    ]);
    expect(entityStateAt(t, 4).visible).toBe(true);
    expect(entityStateAt(t, 5).visible).toBe(false);
  });

  it('fades an entity only when its render mode blends', () => {
    // alpha 100 out of 255, under render mode 0 (normal) and 2 (texture)
    expect(entityStateAt(track([[0, N, N, N, N, N, N, N, N, N, 0, 100, 0]]), 0).alpha).toBe(1);
    expect(entityStateAt(track([[0, N, N, N, N, N, N, N, N, N, 0, 100, 2]]), 0).alpha).toBeCloseTo(
      100 / 255,
    );
  });

  it('says nothing for a track with no samples', () => {
    const state = entityStateAt(track([]), 100);
    expect(state.origin.every(Number.isNaN)).toBe(true);
  });
});

describe('modelNameCrc', () => {
  it('matches what the recorder writes for a brush model', () => {
    // deathrun_unique's first rotating trap is brush model 26, and its
    // baseline names the model as 1077424333
    expect(modelNameCrc('*26')).toBe(1077424333);
    expect(modelNameCrc('*30')).toBe(396426620);
  });

  it('reads a path the way the engine does', () => {
    expect(modelNameCrc('models/Props/Crate.mdl')).toBe(modelNameCrc('models\\props\\crate.mdl'));
  });
});
