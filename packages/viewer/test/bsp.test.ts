import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBsp, parseEntitiesText } from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Real map downloaded from the official CDN by tools; game assets are never
// committed, so these integration tests only run when the file exists locally.
const realBspPath = join(root, 'tools', 'out', 'bhop_eazy_v3.bsp');
const hasRealBsp = existsSync(realBspPath);

describe('parseEntitiesText', () => {
  it('parses keyvalue blocks', () => {
    const ents = parseEntitiesText(
      '{\n"classname" "worldspawn"\n"skyname" "sky_day01"\n}\n{\n"classname" "info_player_start"\n"origin" "1 2 3"\n}\n',
    );
    expect(ents).toHaveLength(2);
    expect(ents[0]).toMatchObject({ classname: 'worldspawn', skyname: 'sky_day01' });
    expect(ents[1]!['origin']).toBe('1 2 3');
  });

  it('accepts the Strata ESC separator variant', () => {
    const esc = '\x1b';
    const ents = parseEntitiesText(`{${esc}classname${esc} ${esc}worldspawn${esc}}`);
    expect(ents[0]).toMatchObject({ classname: 'worldspawn' });
  });
});

describe('parseBsp input validation', () => {
  it('rejects non VBSP files', () => {
    const junk = new Uint8Array(8 + 64 * 16 + 4);
    junk.set([0x41, 0x42, 0x43, 0x44]);
    expect(() => parseBsp(junk)).toThrow(/not a VBSP/);
  });

  it('rejects unsupported versions', () => {
    const junk = new Uint8Array(8 + 64 * 16 + 4);
    junk.set([0x56, 0x42, 0x53, 0x50]); // VBSP
    new DataView(junk.buffer).setInt32(4, 99, true);
    expect(() => parseBsp(junk)).toThrow(/version 99/);
  });

  it('rejects truncated files', () => {
    expect(() => parseBsp(new Uint8Array(32))).toThrow(/too small/);
  });
});

describe.skipIf(!hasRealBsp)('parseBsp on a real Momentum map (local only)', () => {
  const map = hasRealBsp ? parseBsp(readFileSync(realBspPath)) : null!;

  it('parses header and lumps', () => {
    expect(map.version).toBe(20);
    expect(map.entities.length).toBeGreaterThan(100);
    expect(map.materials.length).toBeGreaterThan(5);
    expect(map.models.length).toBeGreaterThan(1);
    expect(map.pakfile.length).toBeGreaterThan(1000);
    expect(map.skyName).toBeTruthy();
  });

  it('builds world geometry with sane bounds', () => {
    expect(map.world.length).toBeGreaterThan(0);
    let tris = 0;
    for (const g of map.world) {
      tris += g.indices.length / 3;
      expect(g.positions.length % 3).toBe(0);
      expect(g.normals.length).toBe(g.positions.length);
      for (let i = 0; i < g.positions.length; i++) {
        expect(Math.abs(g.positions[i]!)).toBeLessThanOrEqual(32768);
      }
      for (const idx of g.indices) {
        expect(idx).toBeLessThan(g.positions.length / 3);
      }
    }
    expect(tris).toBeGreaterThan(1000);
  });

  it('finds the player start where the replay says the player spawned', () => {
    // the bhop_eazy fixture replay's baseline origin is (-451, -254, 64)
    expect(map.playerStart).toBeDefined();
    expect(map.playerStart![0]).toBeCloseTo(-451, 0);
    expect(map.playerStart![1]).toBeCloseTo(-254, 0);
  });

  it('exposes the func_bhop brush entities seen in the replay baselines', () => {
    const bhops = map.entities.filter((e) => e['classname'] === 'func_bhop');
    expect(bhops.length).toBe(188);
  });
});
