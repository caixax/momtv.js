#!/usr/bin/env node
// Extracts the materials a map needs from a local game installation, so they
// can be served to the viewer through its assetsBaseUrl option.
//
// Game assets are never committed: this writes into a local, ignored folder
// and is meant to be run by whoever owns the game.
//
//   node tools/extract-map-assets.mjs <map.bsp> <outDir> [gameDir]
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  parseBsp,
  parseVpkDirectory,
  readPakfile,
  readVpkEntry,
} from '../packages/viewer/dist/index.js';

const DEFAULT_GAME = 'C:/Program Files (x86)/Steam/steamapps/common/Momentum Mod Playtest';

const [bspPath, outDir, gameDir = DEFAULT_GAME] = process.argv.slice(2);
if (!bspPath || !outDir) {
  console.error('usage: node tools/extract-map-assets.mjs <map.bsp> <outDir> [gameDir]');
  process.exit(1);
}

const map = parseBsp(readFileSync(bspPath));
const packed = new Set(readPakfile(map.pakfile).map((e) => e.name));
const wanted = map.materials
  .map((m) => m.name)
  .filter((name) => !name.startsWith('tools/'))
  .filter((name) => !packed.has(`materials/${name}.vmt`));
console.log(`${map.materials.length} materials, ${wanted.length} not packed in the map`);
if (wanted.length === 0) process.exit(0);

// every VPK directory the install offers, plus loose files under each game dir
const searchRoots = [join(gameDir, 'momentum'), join(gameDir, 'mount'), join(gameDir, 'platform')];
const vpks = [];
for (const root of searchRoots) {
  if (!existsSync(root)) continue;
  for (const file of readdirSync(root)) {
    if (!file.endsWith('.vpk')) continue;
    if (/_\d{3}\.vpk$/.test(file)) continue; // numbered archives, loaded on demand
    const full = join(root, file);
    try {
      const data = readFileSync(full);
      const dir = parseVpkDirectory(data);
      vpks.push({ name: file, full, data, dir });
    } catch {
      // not a directory VPK, skip
    }
  }
}
console.log(`searching ${vpks.length} VPKs: ${vpks.map((v) => v.name).join(', ')}`);

const archiveCache = new Map();
const readArchive = (vpk) => async (index) => {
  const key = `${vpk.full}:${index}`;
  let data = archiveCache.get(key);
  if (!data) {
    const numbered = vpk.full.replace(/_dir\.vpk$/, `_${String(index).padStart(3, '0')}.vpk`);
    data = readFileSync(numbered);
    archiveCache.set(key, data);
  }
  return data;
};

/** Finds a file across the install: loose first, then the VPKs. */
async function find(path) {
  for (const root of searchRoots) {
    const loose = join(root, path);
    if (existsSync(loose)) return readFileSync(loose);
  }
  for (const vpk of vpks) {
    const entry = vpk.dir.entries.get(path);
    if (entry) return Buffer.from(await readVpkEntry(vpk.dir, entry, vpk.data, readArchive(vpk)));
  }
  return null;
}

const baseTextureOf = (vmt) => {
  const m = /\$basetexture"?\s*(?:"([^"\r\n]+)"|([^"\s}]+))/i.exec(vmt);
  const v = m?.[1] ?? m?.[2];
  return v ? v.trim().replace(/\\/g, '/').toLowerCase() : undefined;
};

let written = 0;
let missing = 0;
for (const name of wanted) {
  const vmtPath = `materials/${name}.vmt`;
  const vmt = await find(vmtPath);
  let texture = name;
  if (vmt) {
    write(vmtPath, vmt);
    texture = baseTextureOf(vmt.toString('latin1')) ?? name;
  }
  const vtfPath = `materials/${texture}.vtf`;
  const vtf = await find(vtfPath);
  if (vtf) {
    write(vtfPath, vtf);
    written++;
  } else {
    missing++;
    console.log(`  missing: ${name}`);
  }
}

function write(relative, data) {
  const target = join(outDir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}

console.log(`extracted ${written} materials to ${outDir}, ${missing} not found`);
