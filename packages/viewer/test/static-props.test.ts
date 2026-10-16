import { describe, expect, it } from 'vitest';
import { readStaticProps } from '../src/bsp/static-props.js';

/** Builds a game lump holding one static prop lump. */
function buildGameLump(options: {
  version: number;
  models: string[];
  leafCount: number;
  leafSize: 2 | 4;
  stride: number;
  props: { model: number; origin: [number, number, number]; angles: [number, number, number]; scale?: [number, number, number] }[];
}): { gameLump: Uint8Array; file: Uint8Array } {
  const { version, models, leafCount, leafSize, stride, props } = options;
  const bodySize = 4 + models.length * 128 + 4 + leafCount * leafSize + 4 + props.length * stride;
  const body = new Uint8Array(bodySize);
  const view = new DataView(body.buffer);
  view.setInt32(0, models.length, true);
  const encoder = new TextEncoder();
  models.forEach((name, i) => body.set(encoder.encode(name), 4 + i * 128));
  let at = 4 + models.length * 128;
  view.setInt32(at, leafCount, true);
  at += 4 + leafCount * leafSize;
  view.setInt32(at, props.length, true);
  at += 4;
  props.forEach((prop, i) => {
    const o = at + i * stride;
    prop.origin.forEach((v, k) => view.setFloat32(o + k * 4, v, true));
    prop.angles.forEach((v, k) => view.setFloat32(o + 12 + k * 4, v, true));
    view.setUint16(o + 24, prop.model, true);
    view.setInt32(o + 32, 0, true);
    if (prop.scale) prop.scale.forEach((v, k) => view.setFloat32(o + stride - 12 + k * 4, v, true));
  });

  // the game lump: a count, one entry, and the body it points at
  const header = 4 + 16;
  const gameLump = new Uint8Array(header);
  const gv = new DataView(gameLump.buffer);
  gv.setInt32(0, 1, true);
  gv.setInt32(4, 0x73707270, true); // 'sprp'
  gv.setUint16(8, 0, true);
  gv.setUint16(10, version, true);
  gv.setInt32(12, 1000, true); // where the body sits in the file
  gv.setInt32(16, body.length, true);
  const file = new Uint8Array(1000 + body.length);
  file.set(body, 1000);
  return { gameLump, file };
}

describe('readStaticProps', () => {
  it('reads the older layout, with sixteen bit leaves', () => {
    const { gameLump, file } = buildGameLump({
      version: 10,
      models: ['models/props/barrel.mdl', 'models/props/CRATE.mdl'],
      leafCount: 3,
      leafSize: 2,
      stride: 72,
      props: [
        { model: 0, origin: [10, 20, 30], angles: [0, 90, 0] },
        { model: 1, origin: [-5, 0, 7], angles: [0, 0, 0] },
      ],
    });
    const result = readStaticProps(gameLump, file);
    expect(result?.version).toBe(10);
    expect(result?.models).toEqual(['models/props/barrel.mdl', 'models/props/crate.mdl']);
    expect(result?.props).toHaveLength(2);
    expect(result?.props[0]).toMatchObject({
      model: 'models/props/barrel.mdl',
      origin: [10, 20, 30],
      angles: [0, 90, 0],
      scale: [1, 1, 1],
    });
    expect(result?.props[1]!.model).toBe('models/props/crate.mdl');
  });

  it('reads the Strata layout, with its wider leaves and a scale', () => {
    const { gameLump, file } = buildGameLump({
      version: 13,
      models: ['models/custom/statue.mdl'],
      leafCount: 5,
      leafSize: 4,
      stride: 88,
      props: [
        { model: 0, origin: [1, 2, 3], angles: [0, 45, 0], scale: [2, 2, 0.5] },
        { model: 0, origin: [4, 5, 6], angles: [0, 0, 0], scale: [1, 1, 1] },
      ],
    });
    const result = readStaticProps(gameLump, file);
    expect(result?.props).toHaveLength(2);
    expect(result?.props[0]!.scale).toEqual([2, 2, 0.5]);
    expect(result?.props[1]!.origin).toEqual([4, 5, 6]);
  });

  it('says nothing when the map places no props', () => {
    expect(readStaticProps(new Uint8Array(0), new Uint8Array(0))).toBeUndefined();
    const empty = new Uint8Array(4 + 16);
    new DataView(empty.buffer).setInt32(0, 0, true);
    expect(readStaticProps(empty, new Uint8Array(100))).toBeUndefined();
  });

  it('refuses a prop that names a model the lump does not have', () => {
    const { gameLump, file } = buildGameLump({
      version: 10,
      models: ['models/props/barrel.mdl'],
      leafCount: 1,
      leafSize: 2,
      stride: 72,
      props: [{ model: 7, origin: [0, 0, 0], angles: [0, 0, 0] }],
    });
    expect(readStaticProps(gameLump, file)).toBeUndefined();
  });
});
