import type { EntityTrack } from '@caixax/mtv';
import { describe, expect, it } from 'vitest';
import type { BspMap, BspModel } from '../src/bsp/bsp-file.js';
import { linkBrushEntities } from '../src/entities.js';
import { mat4FromAngles } from '../src/gl/math.js';

function model(classname: string | undefined, origin: [number, number, number]): BspModel {
  const base: BspModel = {
    mins: [-16, -16, -16],
    maxs: [16, 16, 16],
    origin: [0, 0, 0],
    firstFace: 0,
    faceCount: 0,
    meshes: [],
  };
  if (!classname) return base;
  return {
    ...base,
    entity: { classname, model: '*1', origin: origin.join(' ') },
    placement: { origin, angles: [0, 0, 0] },
  };
}

function mapWith(models: BspModel[]): BspMap {
  return {
    version: 20,
    mapRevision: 1,
    entities: [],
    materials: [],
    world: [],
    models,
    pakfile: new Uint8Array(0),
    lightmap: undefined,
    skyName: undefined,
    playerStart: undefined,
  };
}

function entityTrack(className: string, classIndex: number): EntityTrack {
  return {
    slot: classIndex,
    className,
    classIndex,
    cellWidth: 32,
    ticks: Uint32Array.of(0),
    values: Float32Array.of(NaN, NaN, NaN, NaN, NaN, NaN, 0, 0, 0),
    moves: true,
  };
}

describe('linkBrushEntities', () => {
  it('pairs each recorded entity with the map entity of the same order', () => {
    const map = mapWith([
      model(undefined, [0, 0, 0]), // the world
      model('func_rotating', [10, 0, 0]),
      model('func_button', [20, 0, 0]),
      model('func_rotating', [30, 0, 0]),
    ]);
    const linked = linkBrushEntities(map, [
      entityTrack('CFuncRotating', 0),
      entityTrack('CFuncRotating', 1),
    ]);
    expect(linked.map((l) => l.model)).toEqual([1, 3]);
    expect(linked[0]!.origin).toEqual([10, 0, 0]);
    expect(linked[1]!.origin).toEqual([30, 0, 0]);
  });

  it('knows which classnames are networked as the same class', () => {
    const map = mapWith([
      model(undefined, [0, 0, 0]),
      model('func_water', [1, 0, 0]),
      model('func_door_rotating', [2, 0, 0]),
    ]);
    const linked = linkBrushEntities(map, [entityTrack('CBaseDoor', 0), entityTrack('CBaseDoor', 1)]);
    expect(linked.map((l) => l.model)).toEqual([1, 2]);
  });

  it('leaves a class alone when the counts disagree', () => {
    const map = mapWith([model(undefined, [0, 0, 0]), model('func_rotating', [10, 0, 0])]);
    const linked = linkBrushEntities(map, [
      entityTrack('CFuncRotating', 0),
      entityTrack('CFuncRotating', 1),
    ]);
    expect(linked).toEqual([]);
  });

  it('ignores entities the map has no brush for', () => {
    const map = mapWith([model(undefined, [0, 0, 0]), model('func_rotating', [10, 0, 0])]);
    const linked = linkBrushEntities(map, [
      entityTrack('CFuncRotating', 0),
      entityTrack('CMomentumZoneRegion', 0),
    ]);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.track.className).toBe('CFuncRotating');
  });
});

describe('mat4FromAngles', () => {
  const apply = (m: Float32Array, v: [number, number, number]): number[] =>
    [0, 1, 2].map(
      (i) => m[i]! * v[0] + m[4 + i]! * v[1] + m[8 + i]! * v[2] + m[12 + i]!,
    );

  it('moves a point by the origin when there is no turn', () => {
    const m = mat4FromAngles([0, 0, 0], [5, 6, 7]);
    expect(apply(m, [1, 2, 3]).map(Math.round)).toEqual([6, 8, 10]);
  });

  it('turns about the up axis for yaw, the engine way', () => {
    const m = mat4FromAngles([0, 90, 0], [0, 0, 0]);
    // +x goes to +y
    expect(apply(m, [1, 0, 0]).map(Math.round)).toEqual([0, 1, 0]);
  });

  it('tips forward for pitch', () => {
    const m = mat4FromAngles([90, 0, 0], [0, 0, 0]);
    // +x goes down, as a positive pitch looks down
    expect(apply(m, [1, 0, 0]).map(Math.round)).toEqual([0, 0, -1]);
  });

  it('rolls about the forward axis', () => {
    const m = mat4FromAngles([0, 0, 90], [0, 0, 0]);
    expect(apply(m, [0, 1, 0]).map(Math.round)).toEqual([0, 0, 1]);
  });
});
