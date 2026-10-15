import type { BspMap } from './bsp/bsp-file.js';
import { readPakEntry, readPakfile, type PakEntry } from './bsp/pakfile.js';
import { parseVmtBaseTexture, parseVtf, type DecodedTexture } from './bsp/vtf.js';

/** A resolved material: a texture when one was found, a flat colour otherwise. */
export interface LoadedMaterial {
  name: string;
  texture: DecodedTexture | undefined;
  /** Flat colour fallback from the map's texdata reflectivity. */
  color: [number, number, number];
}

/** Options for {@link loadMaterials}. */
export interface LoadMaterialsOptions {
  /**
   * Base URL for assets the map does not pack (materials that live in the
   * game's VPK files). Looked up as `{assetsBaseUrl}/materials/{name}.vtf`.
   */
  assetsBaseUrl?: string;
  fetch?: typeof fetch;
  /** Called as materials resolve, for progress reporting. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Resolves every material of a map to a texture or a flat colour.
 *
 * Materials are looked up in the map's own pakfile first, then under
 * `assetsBaseUrl`. Anything still missing keeps its flat colour, so a map
 * always renders even with no assets available.
 */
export async function loadMaterials(
  map: BspMap,
  options: LoadMaterialsOptions = {},
): Promise<LoadedMaterial[]> {
  const fetchImpl = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  const entries = readPakfile(map.pakfile);
  const byName = new Map<string, PakEntry>();
  for (const entry of entries) byName.set(entry.name, entry);

  const out: LoadedMaterial[] = [];
  let done = 0;
  for (const material of map.materials) {
    const color: [number, number, number] = [
      Math.min(1, Math.abs(material.reflectivity[0])),
      Math.min(1, Math.abs(material.reflectivity[1])),
      Math.min(1, Math.abs(material.reflectivity[2])),
    ];
    let texture: DecodedTexture | undefined;
    try {
      texture = await resolveTexture(material.name, map.pakfile, byName, options, fetchImpl);
    } catch {
      texture = undefined; // keep the flat colour
    }
    out.push({ name: material.name, texture, color });
    options.onProgress?.(++done, map.materials.length);
  }
  return out;
}

async function resolveTexture(
  materialName: string,
  pak: Uint8Array,
  byName: Map<string, PakEntry>,
  options: LoadMaterialsOptions,
  fetchImpl: typeof fetch | undefined,
): Promise<DecodedTexture | undefined> {
  // tool materials have no useful texture
  if (materialName.startsWith('tools/')) return undefined;

  const decoder = new TextDecoder('latin1');
  // a material name from texdata is a path under materials/, without extension
  let texturePath = materialName;
  const vmtEntry = byName.get(`materials/${materialName}.vmt`);
  if (vmtEntry) {
    const vmt = decoder.decode(await readPakEntry(pak, vmtEntry));
    texturePath = parseVmtBaseTexture(vmt) ?? materialName;
  } else if (options.assetsBaseUrl && fetchImpl) {
    const vmt = await fetchText(
      `${trimSlash(options.assetsBaseUrl)}/materials/${materialName}.vmt`,
      fetchImpl,
    );
    if (vmt) texturePath = parseVmtBaseTexture(vmt) ?? materialName;
  }

  const vtfEntry = byName.get(`materials/${texturePath}.vtf`);
  if (vtfEntry) return parseVtf(await readPakEntry(pak, vtfEntry));

  if (options.assetsBaseUrl && fetchImpl) {
    const url = `${trimSlash(options.assetsBaseUrl)}/materials/${texturePath}.vtf`;
    const res = await fetchImpl(url).catch(() => undefined);
    if (res?.ok) return parseVtf(new Uint8Array(await res.arrayBuffer()));
  }
  return undefined;
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const res = await fetchImpl(url).catch(() => undefined);
  if (!res?.ok) return undefined;
  return res.text();
}

function trimSlash(s: string): string {
  return s.replace(/\/$/, '');
}
