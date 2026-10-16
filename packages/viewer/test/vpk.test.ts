import { describe, expect, it } from 'vitest';
import { parseVpkDirectory, readVpkEntry } from '../src/index.js';

/** Builds a minimal version 2 VPK directory holding the given files. */
function buildVpk(files: { ext: string; dir: string; name: string; data: Uint8Array }[]): {
  vpk: Uint8Array;
  archive: Uint8Array;
} {
  const encoder = new TextEncoder();
  const tree: number[] = [];
  const pushString = (s: string): void => {
    for (const b of encoder.encode(s)) tree.push(b);
    tree.push(0);
  };
  const archiveParts: Uint8Array[] = [];
  let archiveOffset = 0;

  const byExt = new Map<string, Map<string, { name: string; data: Uint8Array }[]>>();
  for (const f of files) {
    const dirs = byExt.get(f.ext) ?? new Map();
    const list = dirs.get(f.dir) ?? [];
    list.push({ name: f.name, data: f.data });
    dirs.set(f.dir, list);
    byExt.set(f.ext, dirs);
  }

  for (const [ext, dirs] of byExt) {
    pushString(ext);
    for (const [dir, list] of dirs) {
      pushString(dir);
      for (const file of list) {
        pushString(file.name);
        const header = new Uint8Array(18);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x1234, true); // crc
        view.setUint16(4, 0, true); // preload bytes
        view.setUint16(6, 1, true); // archive index
        view.setUint32(8, archiveOffset, true);
        view.setUint32(12, file.data.length, true);
        view.setUint16(16, 0xffff, true);
        for (const b of header) tree.push(b);
        archiveParts.push(file.data);
        archiveOffset += file.data.length;
      }
      pushString('');
    }
    pushString('');
  }
  pushString('');

  const vpk = new Uint8Array(28 + tree.length);
  const view = new DataView(vpk.buffer);
  view.setUint32(0, 0x55aa1234, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, tree.length, true);
  vpk.set(tree, 28);

  const archive = new Uint8Array(archiveOffset);
  let at = 0;
  for (const part of archiveParts) {
    archive.set(part, at);
    at += part.length;
  }
  return { vpk, archive };
}

describe('parseVpkDirectory', () => {
  it('rejects files that are not VPKs', () => {
    expect(() => parseVpkDirectory(new Uint8Array(32))).toThrow(/not a VPK/);
  });

  it('rejects unknown versions', () => {
    const data = new Uint8Array(32);
    const view = new DataView(data.buffer);
    view.setUint32(0, 0x55aa1234, true);
    view.setUint32(4, 9, true);
    expect(() => parseVpkDirectory(data)).toThrow(/version 9/);
  });

  it('lists entries with full lowercased paths', () => {
    const { vpk } = buildVpk([
      { ext: 'vtf', dir: 'materials/Brick', name: 'Wall01', data: new Uint8Array([1, 2, 3]) },
      { ext: 'vmt', dir: 'materials/Brick', name: 'Wall01', data: new Uint8Array([4, 5]) },
    ]);
    const dir = parseVpkDirectory(vpk);
    expect(dir.version).toBe(2);
    expect([...dir.entries.keys()].sort()).toEqual([
      'materials/brick/wall01.vmt',
      'materials/brick/wall01.vtf',
    ]);
  });

  it('reads entry data from a numbered archive', async () => {
    const payload = new Uint8Array([9, 8, 7, 6]);
    const { vpk, archive } = buildVpk([
      { ext: 'vtf', dir: 'materials/x', name: 'y', data: payload },
    ]);
    const dir = parseVpkDirectory(vpk);
    const entry = dir.entries.get('materials/x/y.vtf')!;
    expect(entry.archiveIndex).toBe(1);
    const bytes = await readVpkEntry(dir, entry, vpk, async () => archive);
    expect([...bytes]).toEqual([...payload]);
  });
});
