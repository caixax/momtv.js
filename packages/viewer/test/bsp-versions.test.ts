import { describe, expect, it } from 'vitest';
import { parseBsp } from '../src/index.js';

/** Lump indices this builder fills. */
const LUMP = {
  ENTITIES: 0,
  DISPINFO: 26,
  DISP_VERTS: 33,
  PLANES: 1,
  TEXDATA: 2,
  VERTEXES: 3,
  TEXINFO: 6,
  FACES: 7,
  EDGES: 12,
  SURFEDGES: 13,
  MODELS: 14,
  TEXDATA_STRING_DATA: 43,
  TEXDATA_STRING_TABLE: 44,
} as const;

/**
 * One square face, as either the original structure or the widened one.
 *
 * @param displacement - turn the face into a displacement of this power, with
 * the middle point of its grid pushed up
 */
function buildMap(wide: boolean, displacement?: number): Uint8Array {
  const lumps = new Map<number, { data: Uint8Array; version: number }>();
  const put = (index: number, data: Uint8Array, version = 0) =>
    lumps.set(index, { data, version });

  const bytes = (length: number) => {
    const data = new Uint8Array(length);
    return { data, view: new DataView(data.buffer) };
  };

  put(LUMP.ENTITIES, new TextEncoder().encode('{"classname" "worldspawn" "skyname" "sky_x"}'));

  // one plane, facing up
  const plane = bytes(20);
  plane.view.setFloat32(8, 1, true); // normal z
  put(LUMP.PLANES, plane.data);

  // four vertices of a 64 by 64 square
  const vertex = bytes(4 * 12);
  const corners = [
    [0, 0, 0],
    [64, 0, 0],
    [64, 64, 0],
    [0, 64, 0],
  ];
  corners.forEach(([x, y, z], i) => {
    vertex.view.setFloat32(i * 12, x!, true);
    vertex.view.setFloat32(i * 12 + 4, y!, true);
    vertex.view.setFloat32(i * 12 + 8, z!, true);
  });
  put(LUMP.VERTEXES, vertex.data);

  // four edges around the square, each pair of vertex indices
  const edgeSize = wide ? 8 : 4;
  const edge = bytes(4 * edgeSize);
  for (let i = 0; i < 4; i++) {
    const from = i;
    const to = (i + 1) % 4;
    if (wide) {
      edge.view.setInt32(i * 8, from, true);
      edge.view.setInt32(i * 8 + 4, to, true);
    } else {
      edge.view.setUint16(i * 4, from, true);
      edge.view.setUint16(i * 4 + 2, to, true);
    }
  }
  put(LUMP.EDGES, edge.data, wide ? 1 : 0);

  const surfedge = bytes(4 * 4);
  for (let i = 0; i < 4; i++) surfedge.view.setInt32(i * 4, i, true);
  put(LUMP.SURFEDGES, surfedge.data);

  // one texinfo pointing at texdata 0, with a plain texture projection
  const texinfo = bytes(72);
  texinfo.view.setFloat32(0, 1, true); // u along x
  texinfo.view.setFloat32(20, 1, true); // v along y
  texinfo.view.setFloat32(32, 1, true);
  texinfo.view.setFloat32(52, 1, true);
  texinfo.view.setInt32(64, 0, true); // no surface flags
  texinfo.view.setInt32(68, 0, true); // texdata 0
  put(LUMP.TEXINFO, texinfo.data);

  const texdata = bytes(32);
  texdata.view.setFloat32(0, 0.5, true);
  texdata.view.setFloat32(4, 0.25, true);
  texdata.view.setFloat32(8, 0.125, true);
  texdata.view.setInt32(12, 0, true); // name 0
  texdata.view.setInt32(16, 64, true);
  texdata.view.setInt32(20, 64, true);
  put(LUMP.TEXDATA, texdata.data);

  put(LUMP.TEXDATA_STRING_DATA, new TextEncoder().encode('brick/wall001\0'));
  const table = bytes(4);
  table.view.setInt32(0, 0, true);
  put(LUMP.TEXDATA_STRING_TABLE, table.data);

  if (displacement !== undefined) {
    const side = (1 << displacement) + 1;
    const stride = wide ? 232 : 176;
    const info = bytes(stride);
    // start at the first corner, vertices from zero, and the power
    info.view.setFloat32(0, 0, true);
    info.view.setFloat32(4, 0, true);
    info.view.setFloat32(8, 0, true);
    info.view.setInt32(12, 0, true);
    info.view.setInt32(20, displacement, true);
    put(LUMP.DISPINFO, info.data);
    const dv = bytes(side * side * 20);
    const middle = Math.floor((side * side) / 2);
    dv.view.setFloat32(middle * 20 + 8, 1, true); // straight up
    dv.view.setFloat32(middle * 20 + 12, 32, true); // by 32 units
    put(LUMP.DISP_VERTS, dv.data);
  }

  const face = bytes(wide ? 72 : 56);
  if (wide) {
    face.view.setInt32(0, 0, true); // plane
    face.view.setUint8(4, 0); // side
    face.view.setInt32(8, 0, true); // first edge
    face.view.setInt32(12, 4, true); // edge count
    face.view.setInt32(16, 0, true); // texinfo
    face.view.setInt32(20, displacement === undefined ? -1 : 0, true);
    face.view.setInt32(32, -1, true); // no lighting
  } else {
    face.view.setUint16(0, 0, true);
    face.view.setUint8(2, 0);
    face.view.setInt32(4, 0, true);
    face.view.setInt16(8, 4, true);
    face.view.setInt16(10, 0, true);
    face.view.setInt16(12, displacement === undefined ? -1 : 0, true);
    face.view.setInt32(20, -1, true);
  }
  put(LUMP.FACES, face.data, wide ? 2 : 1);

  const model = bytes(48);
  model.view.setFloat32(12, 64, true);
  model.view.setFloat32(16, 64, true);
  model.view.setInt32(40, 0, true); // first face
  model.view.setInt32(44, 1, true); // face count
  put(LUMP.MODELS, model.data);

  // header, then the lumps one after another
  const headerSize = 8 + 64 * 16 + 4;
  let total = headerSize;
  for (const { data } of lumps.values()) total += data.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x56, 0x42, 0x53, 0x50]); // 'VBSP'
  view.setInt32(4, wide ? 25 : 20, true);
  view.setInt32(8 + 64 * 16, 1, true); // map revision
  let at = headerSize;
  for (const [index, { data, version }] of lumps) {
    view.setInt32(8 + index * 16, at, true);
    view.setInt32(8 + index * 16 + 4, data.length, true);
    view.setInt32(8 + index * 16 + 8, version, true);
    out.set(data, at);
    at += data.length;
  }
  return out;
}

describe('parseBsp across BSP versions', () => {
  for (const wide of [false, true]) {
    const what = wide ? 'the widened Strata structures' : 'the original structures';
    it(`reads a map written with ${what}`, () => {
      const map = parseBsp(buildMap(wide));
      expect(map.version).toBe(wide ? 25 : 20);
      expect(map.mapRevision).toBe(1);
      expect(map.skyName).toBe('sky_x');
      expect(map.materials).toEqual([
        { name: 'brick/wall001', reflectivity: [0.5, 0.25, 0.125] },
      ]);
      // the square comes out as two triangles of the one material
      expect(map.world).toHaveLength(1);
      const group = map.world[0]!;
      expect(group.materialIndex).toBe(0);
      expect(group.positions).toHaveLength(4 * 3);
      expect([...group.indices]).toEqual([0, 1, 2, 0, 2, 3]);
      expect([...group.positions.subarray(0, 3)]).toEqual([0, 0, 0]);
      expect([...group.positions.subarray(6, 9)]).toEqual([64, 64, 0]);
      // the plane says the face points up
      expect([...group.normals.subarray(0, 3)]).toEqual([0, 0, 1]);
    });
  }

  for (const wide of [false, true]) {
    const what = wide ? 'the widened Strata structures' : 'the original structures';
    it(`builds the terrain of a displacement written with ${what}`, () => {
      const map = parseBsp(buildMap(wide, 2));
      const group = map.world[0]!;
      // a power of two gives a five by five grid and its thirty two triangles
      expect(group.positions).toHaveLength(25 * 3);
      expect(group.indices).toHaveLength(32 * 3);
      // the grid spans the face, and its middle point was pushed up
      const z = [...group.positions].filter((_, i) => i % 3 === 2);
      expect(Math.max(...z)).toBeCloseTo(32);
      expect(z.filter((v) => v === 0)).toHaveLength(24);
      const xs = [...group.positions].filter((_, i) => i % 3 === 0);
      expect(Math.min(...xs)).toBe(0);
      expect(Math.max(...xs)).toBe(64);
    });
  }

  it('leaves a displacement alone when its lumps are missing', () => {
    const map = parseBsp(buildMap(true));
    expect(map.world[0]!.positions).toHaveLength(4 * 3);
  });

  it('still refuses a version it does not know', () => {
    const map = buildMap(true);
    new DataView(map.buffer).setInt32(4, 26, true);
    expect(() => parseBsp(map)).toThrow(/version 26/);
  });
});
