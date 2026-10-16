import { describe, expect, it } from 'vitest';
import { parseStudioModel } from '../src/mdl/studio.js';

const CHECKSUM = 0x1234abcd | 0;

/**
 * Builds the three files of a model with one mesh: a square of two triangles.
 *
 * @param options.listChecksum - a checksum for the vertices that disagrees
 */
function buildModel(options: { vvdChecksum?: number; vtxChecksum?: number } = {}) {
  // --- the model itself ---
  const materialAt = 1024;
  const directoryAt = 1152;
  const bodyPartAt = 1280;
  const modelAt = 1400;
  const meshAt = 1600;
  const stringsAt = 1800;
  const mdl = new Uint8Array(2048);
  const mv = new DataView(mdl.buffer);
  const encoder = new TextEncoder();
  mdl.set(encoder.encode('IDST'));
  mv.setInt32(4, 48, true); // version
  mv.setInt32(8, CHECKSUM, true);
  mdl.set(encoder.encode('square\0'), 12);
  mv.setInt32(204, 1, true); // one material
  mv.setInt32(208, materialAt, true);
  mv.setInt32(212, 1, true); // one search path
  mv.setInt32(216, directoryAt, true);
  mv.setInt32(232, 1, true); // one body part
  mv.setInt32(236, bodyPartAt, true);
  // the material: a name offset relative to its own record
  mdl.set(encoder.encode('stone\0'), stringsAt);
  mv.setInt32(materialAt, stringsAt - materialAt, true);
  // the search path, an absolute offset
  mdl.set(encoder.encode('models/test/\0'), stringsAt + 16);
  mv.setInt32(directoryAt, stringsAt + 16, true);
  // the body part: one model
  mv.setInt32(bodyPartAt + 4, 1, true);
  mv.setInt32(bodyPartAt + 12, modelAt - bodyPartAt, true);
  // the model: one mesh, vertices from the start
  mv.setInt32(modelAt + 72, 1, true);
  mv.setInt32(modelAt + 76, meshAt - modelAt, true);
  mv.setInt32(modelAt + 84, 0, true); // byte offset of its first vertex
  // the mesh: material zero, four vertices
  mv.setInt32(meshAt, 0, true);
  mv.setInt32(meshAt + 8, 4, true);
  mv.setInt32(meshAt + 12, 0, true);

  // --- the vertices ---
  const vvd = new Uint8Array(64 + 4 * 48);
  const vv = new DataView(vvd.buffer);
  vvd.set(encoder.encode('IDSV'));
  vv.setInt32(4, 4, true);
  vv.setInt32(8, options.vvdChecksum ?? CHECKSUM, true);
  vv.setInt32(12, 1, true); // one level of detail
  vv.setInt32(16, 4, true); // holding four vertices
  vv.setInt32(48, 0, true); // no fixups
  vv.setInt32(56, 64, true); // where the vertices start
  const corners = [
    [0, 0, 0],
    [16, 0, 0],
    [16, 16, 0],
    [0, 16, 0],
  ];
  corners.forEach(([x, y, z], i) => {
    const at = 64 + i * 48;
    vv.setFloat32(at + 16, x!, true);
    vv.setFloat32(at + 20, y!, true);
    vv.setFloat32(at + 24, z!, true);
    vv.setFloat32(at + 32, 1, true); // normal up
    vv.setFloat32(at + 40, i / 4, true);
    vv.setFloat32(at + 44, 1 - i / 4, true);
  });

  // --- the triangles ---
  const bodyPartOffset = 64;
  const modelOffset = 8;
  const lodOffset = 8;
  const meshOffset = 12;
  const groupOffset = 16;
  const vtx = new Uint8Array(512);
  const tv = new DataView(vtx.buffer);
  tv.setInt32(0, 7, true); // version
  tv.setInt32(16, options.vtxChecksum ?? CHECKSUM, true);
  tv.setInt32(20, 1, true); // one level of detail
  tv.setInt32(28, 1, true); // one body part
  tv.setInt32(32, bodyPartOffset, true);
  const partAt = bodyPartOffset;
  tv.setInt32(partAt, 1, true); // one model
  tv.setInt32(partAt + 4, modelOffset, true);
  const modelAtVtx = partAt + modelOffset;
  tv.setInt32(modelAtVtx, 1, true); // one level of detail
  tv.setInt32(modelAtVtx + 4, lodOffset, true);
  const lodAt = modelAtVtx + lodOffset;
  tv.setInt32(lodAt, 1, true); // one mesh
  tv.setInt32(lodAt + 4, meshOffset, true);
  const meshAtVtx = lodAt + meshOffset;
  tv.setInt32(meshAtVtx, 1, true); // one strip group
  tv.setInt32(meshAtVtx + 4, groupOffset, true);
  const groupAt = meshAtVtx + groupOffset;
  const groupVertexOffset = 64;
  const groupIndexOffset = 128;
  const groupStripOffset = 160;
  tv.setInt32(groupAt, 4, true); // four vertices
  tv.setInt32(groupAt + 4, groupVertexOffset, true);
  tv.setInt32(groupAt + 8, 6, true); // six indices
  tv.setInt32(groupAt + 12, groupIndexOffset, true);
  tv.setInt32(groupAt + 16, 1, true); // one strip
  tv.setInt32(groupAt + 20, groupStripOffset, true);
  for (let i = 0; i < 4; i++) {
    // each vertex says which of the mesh's vertices it is
    tv.setUint16(groupAt + groupVertexOffset + i * 9 + 4, i, true);
  }
  [0, 1, 2, 0, 2, 3].forEach((index, i) => {
    tv.setUint16(groupAt + groupIndexOffset + i * 2, index, true);
  });
  const stripAt = groupAt + groupStripOffset;
  tv.setInt32(stripAt, 6, true); // six indices
  tv.setInt32(stripAt + 4, 0, true);
  tv.setInt32(stripAt + 8, 4, true); // four vertices
  tv.setInt32(stripAt + 12, 0, true);
  vtx[stripAt + 18] = 0x01; // a list of triangles rather than a strip

  return { mdl, vvd, vtx };
}

describe('parseStudioModel', () => {
  it('reads a model, its materials and its triangles', () => {
    const { mdl, vvd, vtx } = buildModel();
    const model = parseStudioModel(mdl, vvd, vtx);
    expect(model.name).toBe('square');
    expect(model.materials).toEqual(['stone']);
    expect(model.searchPaths).toEqual(['models/test/']);
    expect(model.meshes).toHaveLength(1);
    const mesh = model.meshes[0]!;
    expect(mesh.material).toBe(0);
    expect(mesh.positions).toHaveLength(4 * 3);
    expect([...mesh.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    expect([...mesh.positions.subarray(3, 6)]).toEqual([16, 0, 0]);
    expect([...mesh.normals.subarray(0, 3)]).toEqual([0, 1, 0]);
  });

  it('refuses files that belong to different models', () => {
    expect(() => parseStudioModel(...Object.values(buildModel({ vvdChecksum: 1 })) as [Uint8Array, Uint8Array, Uint8Array])).toThrow(
      /vertices belong to a different model/,
    );
    const { mdl, vvd, vtx } = buildModel({ vtxChecksum: 2 });
    expect(() => parseStudioModel(mdl, vvd, vtx)).toThrow(/triangles belong to a different model/);
  });

  it('refuses something that is not a model at all', () => {
    expect(() => parseStudioModel(new Uint8Array(300), new Uint8Array(64), new Uint8Array(64))).toThrow(
      /not a studio model/,
    );
  });
});
