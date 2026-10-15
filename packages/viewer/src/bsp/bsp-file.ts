/**
 * Minimal VBSP (Source engine) map parser for rendering: lump table with
 * Valve LZMA lump decompression, world geometry, texture names and entities.
 *
 * Written from the publicly documented BSP format (VDC wiki) against
 * Momentum Mod maps (VBSP version 19 to 22, version 20 in practice, with
 * most lumps individually LZMA compressed).
 */
import { lzmaDecompress, VALVE_LZMA_ID } from '@caixax/mtv';

/** Lump indices used by the parser. */
const LUMP = {
  ENTITIES: 0,
  PLANES: 1,
  TEXDATA: 2,
  VERTEXES: 3,
  TEXINFO: 6,
  FACES: 7,
  LIGHTING: 8,
  EDGES: 12,
  SURFEDGES: 13,
  MODELS: 14,
  DISPINFO: 26,
  DISP_VERTS: 33,
  GAME_LUMP: 35,
  PAKFILE: 40,
  TEXDATA_STRING_DATA: 43,
  TEXDATA_STRING_TABLE: 44,
} as const;

/** Texinfo surface flags that exclude a face from rendering. */
const SURF_SKY2D = 0x2;
const SURF_SKY = 0x4;
const SURF_TRIGGER = 0x40;
const SURF_NODRAW = 0x80;
const SURF_HINT = 0x100;
const SURF_SKIP = 0x200;
const NON_RENDER_FLAGS = SURF_SKY2D | SURF_SKY | SURF_TRIGGER | SURF_NODRAW | SURF_HINT | SURF_SKIP;

/** A parsed entity from the entities lump (keyvalues as strings). */
export type BspEntity = Record<string, string>;

/** A material slot: texture name plus the texdata reflectivity fallback. */
export interface BspMaterial {
  name: string;
  /** Average texture color from texdata, usable as a flat fallback. */
  reflectivity: [number, number, number];
}

/** Triangulated geometry for one material. */
export interface BspMeshGroup {
  materialIndex: number;
  /** xyz per vertex. */
  positions: Float32Array;
  /** xyz normal per vertex. */
  normals: Float32Array;
  /** uv per vertex (texture coordinates in texel space, unnormalized). */
  uvs: Float32Array;
  indices: Uint32Array;
}

/** A brush model: model 0 is the world, others belong to brush entities. */
export interface BspModel {
  mins: [number, number, number];
  maxs: [number, number, number];
  origin: [number, number, number];
  firstFace: number;
  faceCount: number;
  /** Triangulated geometry of this model, grouped by material. */
  meshes: BspMeshGroup[];
}

/** The parsed map. */
export interface BspMap {
  version: number;
  mapRevision: number;
  entities: BspEntity[];
  materials: BspMaterial[];
  /** Mesh groups of the worldspawn model (equals models[0].meshes). */
  world: BspMeshGroup[];
  models: BspModel[];
  /** Raw pakfile bytes (a zip), for later texture extraction. */
  pakfile: Uint8Array;
  /** worldspawn's skyname, if present. */
  skyName: string | undefined;
  /** info_player_start origin, if present. */
  playerStart: [number, number, number] | undefined;
}

class Cursor {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

function err(message: string): never {
  throw new Error(`BSP: ${message}`);
}

/** Reads and decompresses a lump (Valve per-lump LZMA framing). */
function readLump(file: Cursor, index: number): Uint8Array {
  const off = 8 + index * 16;
  const fileofs = file.view.getInt32(off, true);
  const filelen = file.view.getInt32(off + 4, true);
  if (filelen <= 0) return new Uint8Array(0);
  if (fileofs < 0 || fileofs + filelen > file.bytes.length) err(`lump ${index} out of bounds`);
  const raw = file.bytes.subarray(fileofs, fileofs + filelen);
  if (raw.length >= 17) {
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (v.getUint32(0, true) === VALVE_LZMA_ID) {
      const actualSize = v.getUint32(4, true);
      const lzmaSize = v.getUint32(8, true);
      if (actualSize > 512 * 1024 * 1024) err(`lump ${index} declares ${actualSize} bytes`);
      const props = raw.subarray(12, 17);
      const data = raw.subarray(17, 17 + lzmaSize);
      return lzmaDecompress(props, data, actualSize);
    }
  }
  return raw;
}

/** Parses the entities text lump into keyvalue records. */
export function parseEntitiesText(text: string): BspEntity[] {
  const entities: BspEntity[] = [];
  let current: BspEntity | null = null;
  // keyvalues: { "key" "value" ... } blocks; Strata entity lump v1 may use
  // ESC (0x1b) instead of quotes, normalize it first
  const normalized = text.split(String.fromCharCode(0x1b)).join('"');
  const re = /\{|\}|"((?:[^"\\]|\\.)*)"/g;
  let key: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const token = m[0];
    if (token === '{') {
      current = {};
      key = null;
    } else if (token === '}') {
      if (current) entities.push(current);
      current = null;
    } else if (current) {
      const value = m[1]!;
      if (key === null) {
        key = value;
      } else {
        current[key] = value;
        key = null;
      }
    }
  }
  return entities;
}

function parseVec3(s: string | undefined): [number, number, number] | undefined {
  if (!s) return undefined;
  const parts = s.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!];
}

/**
 * Parses a VBSP map into render-ready data.
 *
 * @throws {Error} on malformed files or unsupported versions.
 */
export function parseBsp(data: ArrayBuffer | Uint8Array): BspMap {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 8 + 64 * 16 + 4) err('file too small');
  const file = new Cursor(bytes);
  const ident = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (ident !== 'VBSP') err(`not a VBSP file (ident '${ident}')`);
  const version = file.view.getInt32(4, true);
  if (version < 19 || version > 22) err(`unsupported BSP version ${version}`);
  const mapRevision = file.view.getInt32(8 + 64 * 16, true);

  // --- raw lumps ---
  const entitiesText = new TextDecoder('latin1').decode(readLump(file, LUMP.ENTITIES));
  const vertexes = readLump(file, LUMP.VERTEXES);
  const edges = readLump(file, LUMP.EDGES);
  const surfedges = readLump(file, LUMP.SURFEDGES);
  const faces = readLump(file, LUMP.FACES);
  const texinfo = readLump(file, LUMP.TEXINFO);
  const texdata = readLump(file, LUMP.TEXDATA);
  const texStringData = readLump(file, LUMP.TEXDATA_STRING_DATA);
  const texStringTable = readLump(file, LUMP.TEXDATA_STRING_TABLE);
  const planes = readLump(file, LUMP.PLANES);
  const models = readLump(file, LUMP.MODELS);
  const pakfile = readLump(file, LUMP.PAKFILE);

  const vertView = new DataView(vertexes.buffer, vertexes.byteOffset, vertexes.byteLength);
  const edgeView = new DataView(edges.buffer, edges.byteOffset, edges.byteLength);
  const seView = new DataView(surfedges.buffer, surfedges.byteOffset, surfedges.byteLength);
  const faceView = new DataView(faces.buffer, faces.byteOffset, faces.byteLength);
  const tiView = new DataView(texinfo.buffer, texinfo.byteOffset, texinfo.byteLength);
  const tdView = new DataView(texdata.buffer, texdata.byteOffset, texdata.byteLength);
  const tstView = new DataView(
    texStringTable.buffer,
    texStringTable.byteOffset,
    texStringTable.byteLength,
  );
  const planeView = new DataView(planes.buffer, planes.byteOffset, planes.byteLength);
  const modelView = new DataView(models.buffer, models.byteOffset, models.byteLength);

  // --- materials ---
  const texDecoder = new TextDecoder('latin1');
  const materialOfTexdata: number[] = [];
  const materials: BspMaterial[] = [];
  const texdataCount = Math.floor(texdata.length / 32);
  for (let i = 0; i < texdataCount; i++) {
    const o = i * 32;
    const reflectivity: [number, number, number] = [
      tdView.getFloat32(o, true),
      tdView.getFloat32(o + 4, true),
      tdView.getFloat32(o + 8, true),
    ];
    const nameId = tdView.getInt32(o + 12, true);
    let name = `texdata_${i}`;
    if (nameId >= 0 && nameId * 4 + 4 <= texStringTable.length) {
      const strOfs = tstView.getInt32(nameId * 4, true);
      if (strOfs >= 0 && strOfs < texStringData.length) {
        let end = strOfs;
        while (end < texStringData.length && texStringData[end] !== 0) end++;
        name = texDecoder.decode(texStringData.subarray(strOfs, end)).toLowerCase();
      }
    }
    materialOfTexdata.push(materials.length);
    materials.push({ name, reflectivity });
  }

  // --- geometry ---
  const FACE_SIZE = 56;
  const faceCount = Math.floor(faces.length / FACE_SIZE);
  const vertexCount = Math.floor(vertexes.length / 12);
  const modelCount = Math.floor(models.length / 48);

  const bspModels: BspModel[] = [];
  for (let i = 0; i < modelCount; i++) {
    const o = i * 48;
    bspModels.push({
      mins: [
        modelView.getFloat32(o, true),
        modelView.getFloat32(o + 4, true),
        modelView.getFloat32(o + 8, true),
      ],
      maxs: [
        modelView.getFloat32(o + 12, true),
        modelView.getFloat32(o + 16, true),
        modelView.getFloat32(o + 20, true),
      ],
      origin: [
        modelView.getFloat32(o + 24, true),
        modelView.getFloat32(o + 28, true),
        modelView.getFloat32(o + 32, true),
      ],
      firstFace: modelView.getInt32(o + 40, true),
      faceCount: modelView.getInt32(o + 44, true),
      meshes: [],
    });
  }

  // triangulate faces grouped by material, per model
  interface Group {
    positions: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
  }

  const buildModelMeshes = (firstFace: number, lastFace: number): BspMeshGroup[] => {
    const groups = new Map<number, Group>();
    for (let f = Math.max(0, firstFace); f < Math.min(faceCount, lastFace); f++) {
      const fo = f * FACE_SIZE;
      const planeNum = faceView.getUint16(fo, true);
      const side = faceView.getUint8(fo + 2);
      const firstEdge = faceView.getInt32(fo + 4, true);
      const numEdges = faceView.getInt16(fo + 8, true);
      const texinfoIdx = faceView.getInt16(fo + 10, true);
      const dispinfoIdx = faceView.getInt16(fo + 12, true);
      if (numEdges < 3) continue;
      if (dispinfoIdx !== -1) continue; // displacements: not rendered yet

      let flags = 0;
      let texdataIdx = -1;
      let tv: number[] | null = null;
      if (texinfoIdx >= 0 && (texinfoIdx + 1) * 72 <= texinfo.length) {
        const to = texinfoIdx * 72;
        flags = tiView.getInt32(to + 64, true);
        texdataIdx = tiView.getInt32(to + 68, true);
        tv = [];
        for (let i = 0; i < 8; i++) tv.push(tiView.getFloat32(to + i * 4, true));
      }
      if (flags & NON_RENDER_FLAGS) continue;

      // face normal from the plane (flipped when side is set)
      let nx = 0;
      let ny = 0;
      let nz = 1;
      if ((planeNum + 1) * 20 <= planes.length) {
        const po = planeNum * 20;
        nx = planeView.getFloat32(po, true);
        ny = planeView.getFloat32(po + 4, true);
        nz = planeView.getFloat32(po + 8, true);
        if (side) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
      }

      const materialIndex =
        texdataIdx >= 0 && texdataIdx < materialOfTexdata.length
          ? materialOfTexdata[texdataIdx]!
          : -1;
      let group = groups.get(materialIndex);
      if (!group) {
        group = { positions: [], normals: [], uvs: [], indices: [] };
        groups.set(materialIndex, group);
      }

      const baseVertex = group.positions.length / 3;
      let emitted = 0;
      for (let e = 0; e < numEdges; e++) {
        const seIdx = firstEdge + e;
        if ((seIdx + 1) * 4 > surfedges.length) break;
        const se = seView.getInt32(seIdx * 4, true);
        const edgeIdx = Math.abs(se);
        if ((edgeIdx + 1) * 4 > edges.length) break;
        // surfedge sign selects the edge direction; take the first vertex
        const vi =
          se >= 0
            ? edgeView.getUint16(edgeIdx * 4, true)
            : edgeView.getUint16(edgeIdx * 4 + 2, true);
        if (vi >= vertexCount) break;
        const vo = vi * 12;
        const x = vertView.getFloat32(vo, true);
        const y = vertView.getFloat32(vo + 4, true);
        const z = vertView.getFloat32(vo + 8, true);
        group.positions.push(x, y, z);
        group.normals.push(nx, ny, nz);
        if (tv) {
          group.uvs.push(
            x * tv[0]! + y * tv[1]! + z * tv[2]! + tv[3]!,
            x * tv[4]! + y * tv[5]! + z * tv[6]! + tv[7]!,
          );
        } else {
          group.uvs.push(0, 0);
        }
        emitted++;
      }
      for (let t = 2; t < emitted; t++) {
        group.indices.push(baseVertex, baseVertex + t - 1, baseVertex + t);
      }
    }

    const meshes: BspMeshGroup[] = [];
    for (const [materialIndex, g] of groups) {
      if (g.indices.length === 0) continue;
      meshes.push({
        materialIndex,
        positions: new Float32Array(g.positions),
        normals: new Float32Array(g.normals),
        uvs: new Float32Array(g.uvs),
        indices: new Uint32Array(g.indices),
      });
    }
    return meshes;
  };

  for (const model of bspModels) {
    model.meshes = buildModelMeshes(model.firstFace, model.firstFace + model.faceCount);
  }
  const world = bspModels[0]?.meshes ?? [];

  const entities = parseEntitiesText(entitiesText);
  const worldspawn = entities.find((e) => e['classname'] === 'worldspawn');
  const start =
    entities.find((e) => e['classname'] === 'info_player_start') ??
    entities.find((e) => e['classname'] === 'info_player_counterterrorist') ??
    entities.find((e) => e['classname'] === 'info_player_terrorist');

  return {
    version,
    mapRevision,
    entities,
    materials,
    world,
    models: bspModels,
    pakfile,
    skyName: worldspawn?.['skyname'],
    playerStart: parseVec3(start?.['origin']),
  };
}
