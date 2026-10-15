/**
 * Resolves and downloads the exact map version a replay was recorded on.
 *
 * Resolution order:
 * 1. `maps` sources (user hosted directories or custom mirrors), tried first
 *    so a local mirror beats the network.
 * 2. The official Momentum Mod API: the version whose `bspHash` matches the
 *    replay's `mapHash` is selected. Old versions are frequently deleted from
 *    the official CDN, so a 404 falls through to the next source or, with
 *    `allowHashMismatch`, to the current version.
 */

/** A function that turns a map name + hash into candidate URLs. */
export type MapSource = (mapName: string, mapHash: string) => string[] | Promise<string[]>;

/** Options for {@link resolveMap}. */
export interface ResolveMapOptions {
  /** Extra sources tried before the official API (local mirrors, archives). */
  sources?: MapSource[];
  /** Base URL of the Momentum Mod API. */
  apiBaseUrl?: string;
  /**
   * If no source provides the exact version, fall back to the current
   * version of the map even though its hash differs (geometry may not match
   * the run). Defaults to false.
   */
  allowHashMismatch?: boolean;
  /** fetch implementation override (tests, Node without global fetch). */
  fetch?: typeof fetch;
}

/** The outcome of a successful map resolution. */
export interface ResolvedMap {
  /** The bytes of the BSP file. */
  data: Uint8Array;
  /** The URL the map was downloaded from. */
  url: string;
  /** SHA1 of the downloaded bytes (lowercase hex). */
  sha1: string;
  /** True when the hash matches the replay's mapHash. */
  exactVersion: boolean;
}

const OFFICIAL_API = 'https://api.momentum-mod.org/v1';

interface ApiMapVersion {
  versionNum?: number;
  bspHash?: string;
  downloadUrl?: string;
  downloadURL?: string;
}

/** Computes SHA1 using WebCrypto (browser, worker and Node 20+). */
export async function sha1Hex(data: Uint8Array): Promise<string> {
  const src =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
  const digest = await crypto.subtle.digest('SHA-1', src as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Builds the candidate URL list from the official API for a map name. */
export async function officialMapUrls(
  mapName: string,
  mapHash: string,
  apiBaseUrl: string,
  fetchImpl: typeof fetch,
  allowHashMismatch: boolean,
): Promise<string[]> {
  const res = await fetchImpl(
    `${apiBaseUrl.replace(/\/$/, '')}/maps/${encodeURIComponent(mapName)}?expand=currentVersion,versions`,
  );
  if (!res.ok) return [];
  const map = (await res.json()) as {
    currentVersion?: ApiMapVersion;
    versions?: ApiMapVersion[];
  };
  const all: ApiMapVersion[] = [
    ...(map.versions ?? []),
    ...(map.currentVersion ? [map.currentVersion] : []),
  ];
  const urls: string[] = [];
  const wanted = mapHash.toLowerCase();
  for (const v of all) {
    const url = v.downloadUrl ?? v.downloadURL;
    if (url && v.bspHash?.toLowerCase() === wanted) urls.push(url);
  }
  if (allowHashMismatch) {
    const current = map.currentVersion?.downloadUrl ?? map.currentVersion?.downloadURL;
    if (current && !urls.includes(current)) urls.push(current);
  }
  return [...new Set(urls)];
}

/**
 * Downloads the BSP for a replay's `mapName` + `mapHash`.
 *
 * @throws {Error} when no source can provide the map.
 */
export async function resolveMap(
  mapName: string,
  mapHash: string,
  options: ResolveMapOptions = {},
): Promise<ResolvedMap> {
  const fetchImpl = options.fetch ?? fetch;
  const wanted = mapHash.toLowerCase();
  const allowMismatch = options.allowHashMismatch ?? false;
  let lastError = 'no map sources produced a URL';

  const tryUrl = async (url: string): Promise<ResolvedMap | null> => {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        lastError = `${url}: HTTP ${res.status}`;
        return null;
      }
      const data = new Uint8Array(await res.arrayBuffer());
      const sha1 = await sha1Hex(data);
      const exactVersion = sha1 === wanted;
      if (!exactVersion && !allowMismatch) {
        lastError = `${url}: hash ${sha1} does not match ${wanted}`;
        return null;
      }
      return { data, url, sha1, exactVersion };
    } catch (error) {
      lastError = `${url}: ${(error as Error).message}`;
      return null;
    }
  };

  // user sources first; the official API is only consulted if they all fail
  for (const source of options.sources ?? []) {
    for (const url of await source(mapName, mapHash)) {
      const hit = await tryUrl(url);
      if (hit) return hit;
    }
  }
  const officialUrls = await officialMapUrls(
    mapName,
    mapHash,
    options.apiBaseUrl ?? OFFICIAL_API,
    fetchImpl,
    allowMismatch,
  ).catch((error: Error) => {
    lastError = `official API: ${error.message}`;
    return [] as string[];
  });
  for (const url of officialUrls) {
    const hit = await tryUrl(url);
    if (hit) return hit;
  }
  throw new Error(`Could not resolve map '${mapName}' (${wanted}): ${lastError}`);
}

/**
 * Convenience source for a user hosted directory of maps, tried as
 * `{baseUrl}/{mapName}.bsp`.
 */
export function directorySource(baseUrl: string): MapSource {
  const base = baseUrl.replace(/\/$/, '');
  return (mapName) => [`${base}/${encodeURIComponent(mapName)}.bsp`];
}
