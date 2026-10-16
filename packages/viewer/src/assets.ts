/**
 * Where the viewer reads game files from.
 *
 * A map packs some of its materials in its own pakfile and leaves the rest to
 * the game, which keeps them either as loose files or inside VPK archives. A
 * source abstracts that away: the material loader asks for a path and takes
 * the first source that has it.
 *
 * Nothing is bundled. A host application points the viewer at whatever it is
 * willing to serve, and a VPK is read a few kilobytes at a time with range
 * requests rather than downloaded whole.
 */
import { readPakEntry, readPakfile, type PakEntry } from './bsp/pakfile.js';
import { parseVpkDirectory, type VpkEntry } from './bsp/vpk.js';

/** Somewhere game files can be read from, by their path under the game root. */
export interface AssetSource {
  /** A short name for diagnostics. */
  readonly name: string;
  /**
   * Reads one file, for example `materials/metal/metalwall001a.vtf`.
   *
   * Returns undefined when this source does not have it, and only throws when
   * it has it but cannot deliver it.
   */
  read(path: string): Promise<Uint8Array | undefined>;
}

const clean = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
const trimSlash = (s: string): string => s.replace(/\/+$/, '');

/** Reads from the pakfile a BSP carries. */
export function pakfileSource(pakfile: Uint8Array): AssetSource {
  const byName = new Map<string, PakEntry>();
  try {
    for (const entry of readPakfile(pakfile)) byName.set(clean(entry.name), entry);
  } catch {
    // A map with an unreadable pakfile simply has nothing to offer.
  }
  return {
    name: 'pakfile',
    async read(path) {
      const entry = byName.get(clean(path));
      if (!entry) return undefined;
      return readPakEntry(pakfile, entry);
    },
  };
}

/** Reads loose files under a base URL. */
export function looseSource(baseUrl: string, fetchImpl: typeof fetch): AssetSource {
  const base = trimSlash(baseUrl);
  return {
    name: baseUrl,
    async read(path) {
      const res = await fetchImpl(`${base}/${clean(path)}`).catch(() => undefined);
      if (!res?.ok) return undefined;
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Entry stored in the directory file itself rather than a numbered archive. */
const IN_DIRECTORY = 0x7fff;

/** Bytes read up front, enough for the header and most directory trees. */
const PROBE_BYTES = 1 << 16;

/**
 * Reads from a VPK archive set served over HTTP.
 *
 * Only the directory tree is read up front, and the data is read in the ranges
 * the entries occupy, so a multi gigabyte archive set costs a few kilobytes per
 * texture. That holds for a single file VPK too: its tree sits at the front and
 * its data is reached with the same ranged reads.
 *
 * @param dirUrl - URL of the `_dir.vpk`, whose name also locates the archives,
 * or of a single file VPK
 * @throws {Error} when the directory cannot be fetched or is not a VPK
 */
export async function vpkSource(dirUrl: string, fetchImpl: typeof fetch): Promise<AssetSource> {
  const readRange = async (url: string, offset: number, length: number): Promise<Uint8Array> => {
    const res = await fetchImpl(url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (!res.ok) throw new Error(`cannot read ${url}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A server that ignores the range header hands back the whole file, which
    // still contains what was asked for, at its absolute offset.
    return bytes.length > length ? bytes.subarray(offset, offset + length) : bytes;
  };

  const probe = await readRange(dirUrl, 0, PROBE_BYTES);
  if (probe.length < 12) throw new Error(`${dirUrl} is too small to be a VPK`);
  const probeView = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
  const version = probeView.getUint32(4, true);
  const treeSize = probeView.getUint32(8, true);
  const headerSize = version === 1 ? 12 : 28;
  // The tree is usually bigger than the probe, so read exactly it.
  const head =
    headerSize + treeSize <= probe.length
      ? probe
      : await readRange(dirUrl, 0, headerSize + treeSize);
  const dir = parseVpkDirectory(head);

  // 'pak01_dir.vpk' holds its data in 'pak01_000.vpk' and friends.
  const prefix = dirUrl.replace(/_dir\.vpk$/i, '');
  const urlFor = (index: number): string =>
    index === IN_DIRECTORY ? dirUrl : `${prefix}_${String(index).padStart(3, '0')}.vpk`;

  const assemble = async (entry: VpkEntry): Promise<Uint8Array> => {
    if (entry.entryLength === 0) return entry.preload.slice();
    const offset =
      entry.archiveIndex === IN_DIRECTORY
        ? dir.dataSectionOffset + entry.entryOffset
        : entry.entryOffset;
    const body = await readRange(urlFor(entry.archiveIndex), offset, entry.entryLength);
    if (entry.preload.length === 0) return body.slice();
    const out = new Uint8Array(entry.preload.length + body.length);
    out.set(entry.preload, 0);
    out.set(body, entry.preload.length);
    return out;
  };

  const name = dirUrl.split('/').pop() ?? dirUrl;
  return {
    name,
    async read(path) {
      const entry = dir.entries.get(clean(path));
      if (!entry) return undefined;
      return assemble(entry);
    },
  };
}

/** Directory trees already read, so switching maps does not read them again. */
const vpkSources = new Map<string, Promise<AssetSource>>();

/**
 * {@link vpkSource}, remembering the archives it has already opened.
 *
 * A directory tree does not change while a page is open, and it is the only
 * part a source reads up front, so reading it once per URL is enough.
 */
export function openVpk(dirUrl: string, fetchImpl: typeof fetch): Promise<AssetSource> {
  const cached = vpkSources.get(dirUrl);
  if (cached) return cached;
  const opening = vpkSource(dirUrl, fetchImpl);
  vpkSources.set(dirUrl, opening);
  // A failure is not worth remembering: the file may appear later.
  opening.catch(() => vpkSources.delete(dirUrl));
  return opening;
}

/** Tries each source in turn and returns the first hit. */
export function firstOf(sources: readonly AssetSource[]): AssetSource {
  return {
    name: sources.map((s) => s.name).join(' then '),
    async read(path) {
      for (const source of sources) {
        const bytes = await source.read(path).catch(() => undefined);
        if (bytes) return bytes;
      }
      return undefined;
    },
  };
}
