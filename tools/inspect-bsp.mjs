#!/usr/bin/env node
// Inspects a Source/Strata BSP header: version, lump table, compression and
// Strata-specific quirks, to compare against what noclip.website supports.
import { readFileSync } from 'node:fs';

const LUMP_NAMES = [
  'ENTITIES',
  'PLANES',
  'TEXDATA',
  'VERTEXES',
  'VISIBILITY',
  'NODES',
  'TEXINFO',
  'FACES',
  'LIGHTING',
  'OCCLUSION',
  'LEAFS',
  'FACEIDS',
  'EDGES',
  'SURFEDGES',
  'MODELS',
  'WORLDLIGHTS',
  'LEAFFACES',
  'LEAFBRUSHES',
  'BRUSHES',
  'BRUSHSIDES',
  'AREAS',
  'AREAPORTALS',
  'PROPCOLLISION',
  'PROPHULLS',
  'PROPHULLVERTS',
  'PROPTRIS',
  'DISPINFO',
  'ORIGINALFACES',
  'PHYSDISP',
  'PHYSCOLLIDE',
  'VERTNORMALS',
  'VERTNORMALINDICES',
  'DISP_LIGHTMAP_ALPHAS',
  'DISP_VERTS',
  'DISP_LIGHTMAP_SAMPLE_POSITIONS',
  'GAME_LUMP',
  'LEAFWATERDATA',
  'PRIMITIVES',
  'PRIMVERTS',
  'PRIMINDICES',
  'PAKFILE',
  'CLIPPORTALVERTS',
  'CUBEMAPS',
  'TEXDATA_STRING_DATA',
  'TEXDATA_STRING_TABLE',
  'OVERLAYS',
  'LEAFMINDISTTOWATER',
  'FACE_MACRO_TEXTURE_INFO',
  'DISP_TRIS',
  'PHYSCOLLIDESURFACE',
  'WATEROVERLAYS',
  'LEAF_AMBIENT_INDEX_HDR',
  'LEAF_AMBIENT_INDEX',
  'LIGHTING_HDR',
  'WORLDLIGHTS_HDR',
  'LEAF_AMBIENT_LIGHTING_HDR',
  'LEAF_AMBIENT_LIGHTING',
  'XZIPPAKFILE',
  'FACES_HDR',
  'MAP_FLAGS',
  'OVERLAY_FADES',
  'OVERLAY_SYSTEM_LEVELS',
  'PHYSLEVEL',
  'DISP_MULTIBLEND',
];

const file = process.argv[2] ?? new URL('./out/bhop_eazy_v3.bsp', import.meta.url);
const b = readFileSync(file);
const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

const ident = b.subarray(0, 4).toString();
const version = view.getInt32(4, true);
console.log(`ident '${ident}' version ${version} size ${b.length}`);

let lzmaLumps = 0;
for (let i = 0; i < 64; i++) {
  const off = 8 + i * 16;
  const fileofs = view.getInt32(off, true);
  const filelen = view.getInt32(off + 4, true);
  const lumpVersion = view.getInt32(off + 8, true);
  const fourCC = view.getInt32(off + 12, true);
  if (filelen === 0) continue;
  const head = b.subarray(fileofs, fileofs + 4).toString('latin1');
  const lzma = head === 'LZMA';
  if (lzma) lzmaLumps++;
  console.log(
    `  [${String(i).padStart(2)}] ${String(LUMP_NAMES[i] ?? '?').padEnd(32)} ofs ${String(fileofs).padStart(8)} len ${String(filelen).padStart(8)} v${lumpVersion}` +
      (fourCC !== 0 ? ` fourCC ${fourCC}` : '') +
      (lzma ? ' [LZMA]' : ''),
  );
}
console.log(`map revision: ${view.getInt32(8 + 64 * 16, true)}`);
console.log(`LZMA-compressed lumps: ${lzmaLumps}`);

// game lump table
const glOfs = view.getInt32(8 + 35 * 16, true);
const glCount = view.getInt32(glOfs, true);
console.log(`game lumps (${glCount}):`);
for (let i = 0; i < glCount; i++) {
  const o = glOfs + 4 + i * 16;
  const id = view.getInt32(o, true);
  const idStr = String.fromCharCode(
    (id >> 24) & 0xff,
    (id >> 16) & 0xff,
    (id >> 8) & 0xff,
    id & 0xff,
  );
  const flags = view.getUint16(o + 4, true);
  const gver = view.getUint16(o + 6, true);
  const fileofs = view.getInt32(o + 8, true);
  const filelen = view.getInt32(o + 12, true);
  console.log(`  '${idStr}' flags ${flags} v${gver} ofs ${fileofs} len ${filelen}`);
}

// entities lump: check separator style (Strata v1 entity lump uses ESC)
const entOfs = view.getInt32(8 + 0 * 16, true);
const entLen = view.getInt32(8 + 0 * 16 + 4, true);
const entVer = view.getInt32(8 + 0 * 16 + 8, true);
const entHead = b.subarray(entOfs, entOfs + Math.min(entLen, 200)).toString('latin1');
console.log(`entity lump v${entVer}, first bytes:`, JSON.stringify(entHead.slice(0, 120)));
