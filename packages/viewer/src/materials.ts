import { firstOf, looseSource, openVpk, pakfileSource, type AssetSource } from './assets.js';
import type { BspMap } from './bsp/bsp-file.js';
import { applyPatch, isToolMaterial, parseVmt, type Vmt } from './bsp/vmt.js';
import { parseVtf, type DecodedTexture } from './bsp/vtf.js';

/** A resolved material: a texture when one was found, a flat colour otherwise. */
export interface LoadedMaterial {
  name: string;
  texture: DecodedTexture | undefined;
  /** Flat colour fallback from the map's texdata reflectivity. */
  color: [number, number, number];
  /** False for tool brushes, which the game never draws. */
  drawn: boolean;
  /** Cut the surface away where the texture is transparent, as foliage needs. */
  alphaTest: boolean;
  /** Threshold for that cut. */
  alphaTestReference: number;
  /** Blend the surface with what is behind it, as glass needs. */
  translucent: boolean;
  /** Constant opacity on top of the texture's alpha. */
  alpha: number;
}

/** Options for {@link loadMaterials}. */
export interface LoadMaterialsOptions {
  /**
   * Base URL for loose game files, looked up as `{assetsBaseUrl}/materials/x.vtf`.
   * Serve the game's own directory here and the viewer finds the materials a
   * map does not pack.
   *
   * A game has more than one content root (Momentum keeps engine materials
   * under `platform` and its own under `momentum`), so several may be given,
   * and they are searched in order.
   */
  assetsBaseUrl?: string | readonly string[];
  /**
   * URLs of `_dir.vpk` files to read materials from, in order of preference.
   * Each is read with range requests, so pointing at a multi gigabyte archive
   * set costs only the bytes the map actually uses.
   */
  vpkUrls?: readonly string[];
  /** Extra asset sources, tried after the map's own pakfile. */
  assetSources?: readonly AssetSource[];
  fetch?: typeof fetch;
  /** Called as materials resolve, for progress reporting. */
  onProgress?: (done: number, total: number) => void;
  /** Called once per material that could not be resolved. */
  onMissing?: (name: string) => void;
}

/** How many materials are resolved at once. */
const CONCURRENCY = 8;

/**
 * Resolves every material of a map to a texture or a flat colour.
 *
 * The map's own pakfile comes first, then whatever sources the caller supplies,
 * then loose files under `assetsBaseUrl`. Anything still missing keeps its flat
 * colour, so a map always renders even with no assets available.
 */
export async function loadMaterials(
  map: BspMap,
  options: LoadMaterialsOptions = {},
): Promise<LoadedMaterial[]> {
  const resolver = await createMaterialResolver(map, options);
  return loadMapMaterials(map, resolver, options);
}

/** Resolves materials by name, remembering what it has already read. */
export interface MaterialResolver {
  /** Where the files come from, in the order they are searched. */
  readonly assets: AssetSource;
  /**
   * Resolves one material.
   *
   * @param name - path under `materials/`, without the extension
   * @param fallbackColour - what to paint the surface when nothing is found
   */
  resolve(name: string, fallbackColour?: [number, number, number]): Promise<LoadedMaterial>;
}

/**
 * Opens the places a map's materials can come from and returns a resolver
 * over them, so the map and its props share one set of caches.
 */
export async function createMaterialResolver(
  map: BspMap,
  options: LoadMaterialsOptions = {},
): Promise<MaterialResolver> {
  const fetchImpl = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  const sources: AssetSource[] = [pakfileSource(map.pakfile)];
  if (options.assetSources) sources.push(...options.assetSources);
  if (fetchImpl) {
    for (const url of options.vpkUrls ?? []) {
      // A VPK that will not open is simply one fewer place to look.
      const source = await openVpk(url, fetchImpl).catch(() => undefined);
      if (source) sources.push(source);
    }
    const roots =
      typeof options.assetsBaseUrl === 'string' ? [options.assetsBaseUrl] : options.assetsBaseUrl;
    for (const root of roots ?? []) sources.push(looseSource(root, fetchImpl));
  }
  const assets = firstOf(sources);

  const decoder = new TextDecoder('latin1');
  const vmtCache = new Map<string, Vmt | undefined>();
  const readVmt = async (path: string, depth = 0): Promise<Vmt | undefined> => {
    const key = path.toLowerCase();
    if (vmtCache.has(key)) return vmtCache.get(key);
    const bytes = await assets.read(`materials/${key}.vmt`);
    let vmt = bytes ? parseVmt(decoder.decode(bytes)) : undefined;
    // A patch only overrides keys of the material it includes.
    if (vmt?.include && depth < 4) {
      const included = await readVmt(vmt.include, depth + 1);
      if (included) vmt = applyPatch(vmt, included);
    }
    vmtCache.set(key, vmt);
    return vmt;
  };

  const textureCache = new Map<string, DecodedTexture | undefined>();
  const readTexture = async (path: string): Promise<DecodedTexture | undefined> => {
    const key = path.toLowerCase();
    if (textureCache.has(key)) return textureCache.get(key);
    const bytes = await assets.read(`materials/${key}.vtf`);
    let decoded: DecodedTexture | undefined;
    if (bytes) {
      try {
        decoded = parseVtf(bytes);
      } catch {
        decoded = undefined; // a texture this cannot decode keeps the flat colour
      }
    }
    textureCache.set(key, decoded);
    return decoded;
  };

  const resolved = new Map<string, Promise<LoadedMaterial>>();
  const resolveOne = async (
    name: string,
    colour: [number, number, number],
  ): Promise<LoadedMaterial> => {
    const loaded: LoadedMaterial = {
      name,
      texture: undefined,
      color: colour,
      drawn: !isToolMaterial(name),
      alphaTest: false,
      alphaTestReference: 0.5,
      translucent: false,
      alpha: 1,
    };
    if (!loaded.drawn) return loaded;
    const vmt = await readVmt(name).catch(() => undefined);
    if (vmt) {
      loaded.alphaTest = vmt.alphaTest;
      loaded.alphaTestReference = vmt.alphaTestReference;
      loaded.translucent = vmt.translucent;
      loaded.alpha = vmt.alpha;
      if (vmt.invisible) loaded.drawn = false;
    }
    if (!loaded.drawn) return loaded;
    // A material without a definition still often has a texture of the same
    // name, which is how many map textures are shipped.
    loaded.texture = await readTexture(vmt?.baseTexture ?? name).catch(() => undefined);
    if (!loaded.texture && vmt?.baseTexture && vmt.baseTexture !== name) {
      loaded.texture = await readTexture(name).catch(() => undefined);
    }
    if (!loaded.texture) options.onMissing?.(name);
    return loaded;
  };

  return {
    assets,
    resolve(name, fallbackColour) {
      const key = name.replace(/\\/g, '/').toLowerCase();
      let pending = resolved.get(key);
      if (!pending) {
        pending = resolveOne(key, fallbackColour ?? [0.6, 0.6, 0.6]);
        resolved.set(key, pending);
      }
      return pending;
    },
  };
}

/** Resolves every material a map's surfaces use. */
async function loadMapMaterials(
  map: BspMap,
  resolver: MaterialResolver,
  options: LoadMaterialsOptions,
): Promise<LoadedMaterial[]> {
  const out: LoadedMaterial[] = new Array(map.materials.length);
  let done = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const material = map.materials[index];
      if (!material) return;
      // the map's own average colour, for a material that resolves to nothing
      const colour: [number, number, number] = [
        Math.min(1, Math.abs(material.reflectivity[0])),
        Math.min(1, Math.abs(material.reflectivity[1])),
        Math.min(1, Math.abs(material.reflectivity[2])),
      ];
      out[index] = await resolver.resolve(material.name, colour);
      options.onProgress?.(++done, map.materials.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, map.materials.length) }, worker));
  return out;
}
