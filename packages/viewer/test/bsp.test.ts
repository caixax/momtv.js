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

  it('builds a lightmap atlas with coordinates for nearly every vertex', () => {
    expect(map.lightmap).toBeDefined();
    const lm = map.lightmap!;
    expect(lm.width).toBeGreaterThan(0);
    expect(lm.height).toBeGreaterThan(0);
    expect(lm.pixels).toHaveLength(lm.width * lm.height * 4);
    let withUv = 0;
    let total = 0;
    for (const group of map.world) {
      expect(group.lightmapUvs).toHaveLength((group.positions.length / 3) * 2);
      for (let i = 0; i < group.lightmapUvs.length; i += 2) {
        total++;
        const u = group.lightmapUvs[i]!;
        const v = group.lightmapUvs[i + 1]!;
        if (u >= 0) {
          withUv++;
          expect(u).toBeLessThanOrEqual(1);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(withUv / total).toBeGreaterThan(0.95);
  });

  it('emits no triangle that leaves its face plane', () => {
    let nonPlanar = 0;
    for (const group of map.world) {
      for (let i = 0; i < group.indices.length; i += 3) {
        const p = [0, 1, 2].map((k) => {
          const vi = group.indices[i + k]! * 3;
          return [group.positions[vi]!, group.positions[vi + 1]!, group.positions[vi + 2]!];
        });
        const u = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!];
        const w = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!];
        const n = [
          u[1]! * w[2]! - u[2]! * w[1]!,
          u[2]! * w[0]! - u[0]! * w[2]!,
          u[0]! * w[1]! - u[1]! * w[0]!,
        ];
        const area = Math.hypot(n[0]!, n[1]!, n[2]!) / 2;
        if (area < 0.01) continue; // degenerate slivers are invisible
        const vi0 = group.indices[i]! * 3;
        const sn = [group.normals[vi0]!, group.normals[vi0 + 1]!, group.normals[vi0 + 2]!];
        const dot = Math.abs((n[0]! * sn[0]! + n[1]! * sn[1]! + n[2]! * sn[2]!) / (area * 2));
        if (dot < 0.9) nonPlanar++;
      }
    }
    expect(nonPlanar).toBe(0);
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
