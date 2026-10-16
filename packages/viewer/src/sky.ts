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
  if (!name) return undefined;
  const base = name.toLowerCase();
  const faces: SkyFace[] = [];
  let any = false;
  for (const side of SKY_SIDES) {
    // HDR skies keep a second set of images beside the plain ones.
    const material =
      (await tryResolve(resolver, `skybox/${base}${side.side}_hdr`)) ??
      (await tryResolve(resolver, `skybox/${base}${side.side}`));
    if (material?.texture) any = true;
    faces.push({ ...side, texture: material?.texture });
  }
  return any ? { name: base, faces } : undefined;
}

/** Resolves a material, treating anything unreadable as absent. */
async function tryResolve(
  resolver: MaterialResolver,
  path: string,
): Promise<{ texture: DecodedTexture | undefined } | undefined> {
  const material = await resolver.resolve(path).catch(() => undefined);
  return material?.texture ? material : undefined;
}
