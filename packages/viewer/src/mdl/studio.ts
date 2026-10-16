/**
 * Reader for Source studio models, the props a map places.
 *
 * A model is three files that have to be read together: the `.mdl` says what
 * the model is made of and which materials it wants, the `.vvd` holds the
 * vertices, and the `.vtx` holds the triangles for each level of detail. The
 * three carry the same checksum, which is how a mismatched set is caught.
 *
 * Only what a viewer needs is read: the highest level of detail of the first
 * body part, in its rest pose. Bones, animation and flexes are skipped, since
 * a map's props do not move.
 *
 * Written from the publicly documented studio model layout.
 */

/** Bytes one vertex takes in a `.vvd`. */
const VERTEX_SIZE = 48;

/** Bytes one vertex takes in a `.vtx`. */
const VTX_VERTEX_SIZE = 9;

/** Field offsets of the `.mdl` header. */
const MDL = {
  id: 0,
  version: 4,
  checksum: 8,
  name: 12,
  textureCount: 204,
  textureOffset: 208,
  directoryCount: 212,
  directoryOffset: 216,
  bodyPartCount: 232,
  bodyPartOffset: 236,
} as const;

/** Field offsets of the `.vtx` header. */
const VTX = {
  version: 0,
  checksum: 16,
  lodCount: 20,
  bodyPartCount: 28,
  bodyPartOffset: 32,
} as const;

/** One drawable piece of a model: the triangles that share one material. */
export interface StudioMesh {
  /** Index into {@link StudioModel.materials}. */
  material: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** A parsed studio model. */
export interface StudioModel {
  /** Name the model carries, which is not always its path. */
  name: string;
  /** Materials it asks for, by bare name. */
  materials: string[];
  /** Directories under `materials/` to look those names up in. */
  searchPaths: string[];
  meshes: StudioMesh[];
}

const decoder = new TextDecoder('latin1');

/** Reads a NUL terminated string. */
function readString(bytes: Uint8Array, at: number): string {
  if (at < 0 || at >= bytes.length) return '';
  let end = at;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(at, end));
}

/** One mesh as the `.mdl` describes it. */
interface MdlMesh {
  material: number;
  /** First vertex of this mesh within its model's vertices. */
  vertexOffset: number;
  vertexCount: number;
}

/** One model (a body part's shape) as the `.mdl` describes it. */
interface MdlModel {
  /** First vertex of this model within the file's vertices. */
  vertexStart: number;
  meshes: MdlMesh[];
}

/** Reads the parts of a `.mdl` that describe geometry and materials. */
function readMdl(mdl: Uint8Array): {
  version: number;
  checksum: number;
  name: string;
  materials: string[];
  searchPaths: string[];
  bodyParts: MdlModel[][];
} {
  const view = new DataView(mdl.buffer, mdl.byteOffset, mdl.byteLength);
  if (mdl.length < 256) throw new Error('studio model is too small');
  const id = decoder.decode(mdl.subarray(0, 4));
  if (id !== 'IDST') throw new Error(`not a studio model (${id})`);
  const version = view.getInt32(MDL.version, true);
  const checksum = view.getInt32(MDL.checksum, true);
  const name = readString(mdl, MDL.name);

  const materials: string[] = [];
  const textureCount = view.getInt32(MDL.textureCount, true);
  const textureOffset = view.getInt32(MDL.textureOffset, true);
  for (let i = 0; i < textureCount; i++) {
    const at = textureOffset + i * 64;
    if (at + 64 > mdl.length) break;
    materials.push(readString(mdl, at + view.getInt32(at, true)));
  }

  const searchPaths: string[] = [];
  const directoryCount = view.getInt32(MDL.directoryCount, true);
  const directoryOffset = view.getInt32(MDL.directoryOffset, true);
  for (let i = 0; i < directoryCount; i++) {
    const at = directoryOffset + i * 4;
    if (at + 4 > mdl.length) break;
    searchPaths.push(readString(mdl, view.getInt32(at, true)));
  }

  const bodyParts: MdlModel[][] = [];
  const bodyPartCount = view.getInt32(MDL.bodyPartCount, true);
  const bodyPartOffset = view.getInt32(MDL.bodyPartOffset, true);
  for (let i = 0; i < bodyPartCount; i++) {
    const partAt = bodyPartOffset + i * 16;
    if (partAt + 16 > mdl.length) break;
    const modelCount = view.getInt32(partAt + 4, true);
    const modelOffset = view.getInt32(partAt + 12, true);
    const models: MdlModel[] = [];
    for (let m = 0; m < modelCount; m++) {
      const modelAt = partAt + modelOffset + m * 148;
      if (modelAt + 148 > mdl.length) break;
      const meshCount = view.getInt32(modelAt + 72, true);
      const meshOffset = view.getInt32(modelAt + 76, true);
      const vertexStart = Math.floor(view.getInt32(modelAt + 84, true) / VERTEX_SIZE);
      const meshes: MdlMesh[] = [];
      for (let k = 0; k < meshCount; k++) {
        const meshAt = modelAt + meshOffset + k * 116;
        if (meshAt + 116 > mdl.length) break;
        meshes.push({
          material: view.getInt32(meshAt, true),
          vertexCount: view.getInt32(meshAt + 8, true),
          vertexOffset: view.getInt32(meshAt + 12, true),
        });
      }
      models.push({ vertexStart, meshes });
    }
    bodyParts.push(models);
  }
  return { version, checksum, name, materials, searchPaths, bodyParts };
}

/** The vertices of a `.vvd`, with its fixup table already applied. */
function readVvd(vvd: Uint8Array): { checksum: number; vertices: Uint8Array; count: number } {
  const view = new DataView(vvd.buffer, vvd.byteOffset, vvd.byteLength);
  if (vvd.length < 64) throw new Error('vertex data is too small');
  const id = decoder.decode(vvd.subarray(0, 4));
  if (id !== 'IDSV') throw new Error(`not studio vertex data (${id})`);
  const checksum = view.getInt32(8, true);
  const lodVertexCount = view.getInt32(16, true); // the highest detail level
  const fixupCount = view.getInt32(48, true);
  const fixupStart = view.getInt32(52, true);
  const dataStart = view.getInt32(56, true);
  if (fixupCount === 0) {
    const bytes = lodVertexCount * VERTEX_SIZE;
    if (dataStart + bytes > vvd.length) throw new Error('vertex data is truncated');
    return { checksum, vertices: vvd.subarray(dataStart, dataStart + bytes), count: lodVertexCount };
  }
  // With fixups the vertices are stored out of order, as runs to be copied.
  const out = new Uint8Array(lodVertexCount * VERTEX_SIZE);
  let written = 0;
  for (let i = 0; i < fixupCount; i++) {
    const at = fixupStart + i * 12;
    if (at + 12 > vvd.length) break;
    const lod = view.getInt32(at, true);
    const sourceVertex = view.getInt32(at + 4, true);
    const count = view.getInt32(at + 8, true);
    if (lod < 0) continue;
    const from = dataStart + sourceVertex * VERTEX_SIZE;
    const bytes = count * VERTEX_SIZE;
    if (from + bytes > vvd.length || written + bytes > out.length) break;
    out.set(vvd.subarray(from, from + bytes), written);
    written += bytes;
  }
  return { checksum, vertices: out, count: Math.floor(written / VERTEX_SIZE) };
}

/** Triangles of one mesh, as indices into the model's vertices. */
type MeshIndices = number[][];

/**
 * Walks a `.vtx` and collects the triangles of the highest detail level.
 *
 * @returns for each body part, for each model, for each mesh, the indices
 */
function readVtx(vtx: Uint8Array, mdlVersion: number): { checksum: number; parts: MeshIndices[][] } {
  const view = new DataView(vtx.buffer, vtx.byteOffset, vtx.byteLength);
  if (vtx.length < 36) throw new Error('triangle data is too small');
  const checksum = view.getInt32(VTX.checksum, true);
  const bodyPartCount = view.getInt32(VTX.bodyPartCount, true);
  const bodyPartOffset = view.getInt32(VTX.bodyPartOffset, true);
  // Version 49 of a model adds two fields to every strip and strip group.
  const extra = mdlVersion >= 49 ? 8 : 0;
  const stripGroupSize = 25 + extra;
  const stripSize = 27 + extra;

  const parts: MeshIndices[][] = [];
  for (let b = 0; b < bodyPartCount; b++) {
    const partAt = bodyPartOffset + b * 8;
    if (partAt + 8 > vtx.length) break;
    const modelCount = view.getInt32(partAt, true);
    const modelOffset = view.getInt32(partAt + 4, true);
    const models: MeshIndices[] = [];
    for (let m = 0; m < modelCount; m++) {
      const modelAt = partAt + modelOffset + m * 8;
      if (modelAt + 8 > vtx.length) break;
      const lodCount = view.getInt32(modelAt, true);
      const lodOffset = view.getInt32(modelAt + 4, true);
      const meshes: MeshIndices = [];
      if (lodCount > 0) {
        const lodAt = modelAt + lodOffset; // the first level is the detailed one
        const meshCount = view.getInt32(lodAt, true);
        const meshOffset = view.getInt32(lodAt + 4, true);
        for (let k = 0; k < meshCount; k++) {
          const meshAt = lodAt + meshOffset + k * 9;
          if (meshAt + 9 > vtx.length) break;
          const groupCount = view.getInt32(meshAt, true);
          const groupOffset = view.getInt32(meshAt + 4, true);
          const indices: number[] = [];
          for (let g = 0; g < groupCount; g++) {
            const groupAt = meshAt + groupOffset + g * stripGroupSize;
            if (groupAt + stripGroupSize > vtx.length) break;
            const vertexCount = view.getInt32(groupAt, true);
            const vertexOffset = view.getInt32(groupAt + 4, true);
            const indexOffset = view.getInt32(groupAt + 12, true);
            const stripCount = view.getInt32(groupAt + 16, true);
            const stripOffset = view.getInt32(groupAt + 20, true);
            for (let s = 0; s < stripCount; s++) {
              const stripAt = groupAt + stripOffset + s * stripSize;
              if (stripAt + stripSize > vtx.length) break;
              const stripIndexCount = view.getInt32(stripAt, true);
              const stripIndexOffset = view.getInt32(stripAt + 4, true);
              const flags = vtx[stripAt + 18]!;
              const isStrip = (flags & 0x02) !== 0;
              const read = (i: number): number => {
                const indexAt = groupAt + indexOffset + (stripIndexOffset + i) * 2;
                if (indexAt + 2 > vtx.length) return 0;
                const local = view.getUint16(indexAt, true);
                if (local >= vertexCount) return 0;
                const vertexAt = groupAt + vertexOffset + local * VTX_VERTEX_SIZE;
                if (vertexAt + VTX_VERTEX_SIZE > vtx.length) return 0;
                return view.getUint16(vertexAt + 4, true);
              };
              if (isStrip) {
                // a triangle strip, which flips winding every other triangle
                for (let i = 0; i + 2 < stripIndexCount; i++) {
                  const a = read(i);
                  const b2 = read(i + 1);
                  const c = read(i + 2);
                  if (a === b2 || b2 === c || a === c) continue;
                  if (i % 2 === 0) indices.push(a, b2, c);
                  else indices.push(a, c, b2);
                }
              } else {
                for (let i = 0; i + 2 < stripIndexCount; i += 3) {
                  indices.push(read(i), read(i + 1), read(i + 2));
                }
              }
            }
          }
          meshes.push(indices);
        }
      }
      models.push(meshes);
    }
    parts.push(models);
  }
  return { checksum, parts };
}

/**
 * Reads a studio model from its three files.
 *
 * @param mdl - the `.mdl`
 * @param vvd - the `.vvd` holding its vertices
 * @param vtx - the `.vtx` holding its triangles
 * @throws {Error} when a file is not what it claims to be, or the three do not
 * belong together
 */
export function parseStudioModel(mdl: Uint8Array, vvd: Uint8Array, vtx: Uint8Array): StudioModel {
  const model = readMdl(mdl);
  const vertices = readVvd(vvd);
  if (vertices.checksum !== model.checksum) {
    throw new Error('the vertices belong to a different model');
  }
  const triangles = readVtx(vtx, model.version);
  if (triangles.checksum !== model.checksum) {
    throw new Error('the triangles belong to a different model');
  }

  const data = new DataView(
    vertices.vertices.buffer,
    vertices.vertices.byteOffset,
    vertices.vertices.byteLength,
  );
  const meshes: StudioMesh[] = [];
  for (const [b, part] of model.bodyParts.entries()) {
    for (const [m, sub] of part.entries()) {
      const meshIndices = triangles.parts[b]?.[m];
      if (!meshIndices) continue;
      for (const [k, mesh] of sub.meshes.entries()) {
        const indices = meshIndices[k];
        if (!indices || indices.length === 0) continue;
        const first = sub.vertexStart + mesh.vertexOffset;
        const positions = new Float32Array(mesh.vertexCount * 3);
        const normals = new Float32Array(mesh.vertexCount * 3);
        const uvs = new Float32Array(mesh.vertexCount * 2);
        let usable = true;
        for (let i = 0; i < mesh.vertexCount; i++) {
          const at = (first + i) * VERTEX_SIZE;
          if (at + VERTEX_SIZE > vertices.vertices.length) {
            usable = false;
            break;
          }
          positions[i * 3] = data.getFloat32(at + 16, true);
          positions[i * 3 + 1] = data.getFloat32(at + 20, true);
          positions[i * 3 + 2] = data.getFloat32(at + 24, true);
          normals[i * 3] = data.getFloat32(at + 28, true);
          normals[i * 3 + 1] = data.getFloat32(at + 32, true);
          normals[i * 3 + 2] = data.getFloat32(at + 36, true);
          uvs[i * 2] = data.getFloat32(at + 40, true);
          uvs[i * 2 + 1] = data.getFloat32(at + 44, true);
        }
        if (!usable) continue;
        const bounded = indices.filter((index) => index < mesh.vertexCount);
        if (bounded.length < 3) continue;
        meshes.push({
          material: mesh.material,
          positions,
          normals,
          uvs,
          indices: Uint32Array.from(bounded),
        });
      }
    }
  }

  return {
    name: model.name,
    materials: model.materials,
    searchPaths: model.searchPaths,
    meshes,
  };
}
