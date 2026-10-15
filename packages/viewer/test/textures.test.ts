import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  loadMaterials,
  parseBsp,
  parseVmtBaseTexture,
  parseVtf,
  readPakfile,
} from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// a real map downloaded by tools; game assets are never committed, so these
// integration tests only run when the file is present locally
const realBspPath = join(root, 'tools', 'out', 'bhop_eazy_v3.bsp');
const hasRealBsp = existsSync(realBspPath);

describe('parseVmtBaseTexture', () => {
  it('reads $basetexture regardless of quoting and case', () => {
    expect(parseVmtBaseTexture('"LightmappedGeneric"\n{\n\t"$basetexture" "a/b/c"\n}')).toBe(
      'a/b/c',
    );
    expect(parseVmtBaseTexture('LightmappedGeneric { $BaseTexture Foo\\Bar }')).toBe('foo/bar');
    expect(parseVmtBaseTexture('"UnlitGeneric" { "$surfaceprop" "metal" }')).toBeUndefined();
  });
});

describe('parseVtf', () => {
  it('rejects files that are not VTFs', () => {
    expect(() => parseVtf(new Uint8Array(64))).toThrow(/not a VTF/);
    expect(() => parseVtf(new Uint8Array(8))).toThrow(/too small/);
  });
});

describe.skipIf(!hasRealBsp)('textures from a real map pakfile (local only)', () => {
  const map = hasRealBsp ? parseBsp(readFileSync(realBspPath)) : null!;

  it('lists the packed materials', () => {
    const entries = readPakfile(map.pakfile);
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.some((e) => e.name.endsWith('.vtf'))).toBe(true);
    expect(entries.some((e) => e.name.endsWith('.vmt'))).toBe(true);
    // Valve's packer uses LZMA (method 14) rather than deflate
    expect(entries.some((e) => e.compressionMethod === 14)).toBe(true);
  });

  it('decodes the map textures to RGBA', async () => {
    const materials = await loadMaterials(map);
    expect(materials).toHaveLength(map.materials.length);
    const textured = materials.filter((m) => m.texture);
    expect(textured.length).toBeGreaterThanOrEqual(map.materials.length - 6);
    for (const material of textured) {
      const texture = material.texture!;
      expect(texture.width).toBeGreaterThan(0);
      expect(texture.height).toBeGreaterThan(0);
      expect(texture.pixels).toHaveLength(texture.width * texture.height * 4);
    }
    // tool materials carry no texture and fall back to their flat colour
    const nodraw = materials.find((m) => m.name.includes('toolsnodraw'));
    expect(nodraw?.texture).toBeUndefined();
  });

  it('decodes real image content, not a flat block', async () => {
    const materials = await loadMaterials(map);
    const brick = materials.find((m) => m.name.includes('brick') && m.texture)!;
    const pixels = brick.texture!.pixels;
    const distinct = new Set<string>();
    for (let i = 0; i < Math.min(pixels.length, 40_000); i += 4) {
      distinct.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    }
    expect(distinct.size).toBeGreaterThan(50);
  });
});
