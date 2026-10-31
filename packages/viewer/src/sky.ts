/**
 * The sky a map paints behind everything else.
 *
 * A map names its sky and the game keeps six images for it, one per side of a
 * cube: `rt`, `lf`, `bk`, `ft`, `up` and `dn`. Which image faces which way is
 * not written down anywhere, so it was measured: the sides join seam to seam
 * in the order right, front, left, back going clockwise, and the sun painted
 * in the sky lands where the map's own `light_environment` says it should
 * when `rt` faces along +X (checked over five maps, within a few degrees).
 */
import type { DecodedTexture } from './bsp/vtf.js';
import type { MaterialResolver } from './materials.js';

/** One side of the sky: where it faces, and how its image is laid out. */
export interface SkyFace {
  /** Suffix the file uses. */
  side: string;
  /** Direction of the middle of the face. */
  normal: [number, number, number];
  /** Where the image's right edge lies, as an offset from the middle. */
  right: [number, number, number];
  /** Where the image's top edge lies. */
  up: [number, number, number];
  texture: DecodedTexture | undefined;
}

/** The six sides, in the order the engine names them. */
export const SKY_SIDES: {
  side: string;
  normal: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
}[] = [
  { side: 'rt', normal: [1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
  { side: 'ft', normal: [0, -1, 0], right: [-1, 0, 0], up: [0, 0, 1] },
  { side: 'lf', normal: [-1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
  { side: 'bk', normal: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { side: 'up', normal: [0, 0, 1], right: [0, -1, 0], up: [-1, 0, 0] },
  { side: 'dn', normal: [0, 0, -1], right: [0, -1, 0], up: [1, 0, 0] },
];

/** The sky the engine falls back to when a map's worldspawn names none. */
const DEFAULT_SKY = 'sky_urb01';

/** A loaded sky. */
export interface Sky {
  name: string;
  faces: SkyFace[];
}

/**
 * Loads the six images of a map's sky.
 *
 * @param name - the map's `skyname`
 * @param resolver - where the materials come from
 * @returns the sky, or undefined when not one side could be read
 */
export async function loadSky(
  name: string | undefined,
  resolver: MaterialResolver,
): Promise<Sky | undefined> {
  // A map that names no sky gets the engine's default.
  const base = (name || DEFAULT_SKY).toLowerCase();
  const faces: SkyFace[] = [];
  let any = false;
  for (const side of SKY_SIDES) {
    // The plain images first, as a player without HDR sees them. A sky that
    // only ships HDR images names them the way the engine looks them up: the
    // sky, then _hdr, then the side.
    const plain = await tryResolve(resolver, `skybox/${base}${side.side}`);
    const hdr = plain ? undefined : await tryResolve(resolver, `skybox/${base}_hdr${side.side}`);
    const texture = plain?.texture ?? (hdr?.texture && expandHdr(hdr.texture));
    if (texture) any = true;
    faces.push({ ...side, texture });
  }
  return any ? { name: base, faces } : undefined;
}

/**
 * Exposure that brings a compressed HDR sky to the brightness of its plain
 * twin, measured on sky_day01_01 (the plain image averages 158, the expanded
 * HDR one 195).
 */
const HDR_EXPOSURE = 0.8;

/**
 * Turns a compressed HDR image into a plain one. Valve's compressed HDR keeps
 * the colour in RGB and a brightness in alpha, the real value being
 * rgb * alpha * 16 / 255.
 */
function expandHdr(texture: DecodedTexture): DecodedTexture {
  const pixels = new Uint8Array(texture.pixels.length);
  const scale = (16 * HDR_EXPOSURE) / 255;
  for (let i = 0; i < pixels.length; i += 4) {
    const brightness = texture.pixels[i + 3]! * scale;
    pixels[i] = Math.min(255, texture.pixels[i]! * brightness);
    pixels[i + 1] = Math.min(255, texture.pixels[i + 1]! * brightness);
    pixels[i + 2] = Math.min(255, texture.pixels[i + 2]! * brightness);
    pixels[i + 3] = 255;
  }
  return { ...texture, pixels };
}

/** Resolves a material, treating anything unreadable as absent. */
async function tryResolve(
  resolver: MaterialResolver,
  path: string,
): Promise<{ texture: DecodedTexture | undefined } | undefined> {
  const material = await resolver.resolve(path).catch(() => undefined);
  return material?.texture ? material : undefined;
}
