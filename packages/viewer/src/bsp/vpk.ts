/**
 * Reader for Valve Pak (VPK) directory archives, version 1 and 2.
 *
 * Maps reference materials that live in the game's VPKs rather than in the
 * map file. This reader lets a host application (a build step, a server, a
 * desktop tool) pull those files out of a local game installation so they can
 * be served to the viewer. No game asset is ever bundled with this library.
 */

const VPK_SIGNATURE = 0x55aa1234;

/** One file inside a VPK directory. */
export interface VpkEntry {
  /** Full path, lowercase with forward slashes, for example 'materials/x.vtf'. */
  path: string;
  crc: number;
  /** Bytes stored inline in the directory file. */
  preload: Uint8Array;
  /** Numbered archive holding the data, or 0x7fff for the directory itself. */
  archiveIndex: number;
  entryOffset: number;
  entryLength: number;
}

/** A parsed VPK directory. */
export interface VpkDirectory {
  version: number;
  /** Byte offset where the directory file's own data section starts. */
  dataSectionOffset: number;
  entries: Map<string, VpkEntry>;
}

/**
 * Parses a `_dir.vpk` (or a single file VPK).
 *
 * @throws {Error} when the file is not a VPK or uses an unknown version.
 */
export function parseVpkDirectory(data: Uint8Array): VpkDirectory {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 12 || view.getUint32(0, true) !== VPK_SIGNATURE) {
    throw new Error('not a VPK file');
  }
  const version = view.getUint32(4, true);
  if (version !== 1 && version !== 2) throw new Error(`unsupported VPK version ${version}`);
  const treeSize = view.getUint32(8, true);
  const headerSize = version === 1 ? 12 : 28;
  const dataSectionOffset = headerSize + treeSize;

  const decoder = new TextDecoder('latin1');
  let pos = headerSize;
  const readString = (): string => {
    const start = pos;
    while (pos < data.length && data[pos] !== 0) pos++;
    const s = decoder.decode(data.subarray(start, pos));
    pos++;
    return s;
  };

  const entries = new Map<string, VpkEntry>();
  for (;;) {
    const extension = readString();
    if (extension === '') break;
    for (;;) {
      const directory = readString();
      if (directory === '') break;
      for (;;) {
        const name = readString();
        if (name === '') break;
        const crc = view.getUint32(pos, true);
        const preloadBytes = view.getUint16(pos + 4, true);
        const archiveIndex = view.getUint16(pos + 6, true);
        const entryOffset = view.getUint32(pos + 8, true);
        const entryLength = view.getUint32(pos + 12, true);
        pos += 18; // 16 bytes of fields plus the 0xffff terminator
        const preload = data.subarray(pos, pos + preloadBytes);
        pos += preloadBytes;
        const path = (
          directory === ' ' ? `${name}.${extension}` : `${directory}/${name}.${extension}`
        ).toLowerCase();
        entries.set(path, { path, crc, preload, archiveIndex, entryOffset, entryLength });
      }
    }
  }
  return { version, dataSectionOffset, entries };
}

/**
 * Reads one entry's bytes.
 *
 * @param readArchive supplies the numbered archive files; for entries stored
 * in the directory itself it is called with the directory's own index.
 */
export async function readVpkEntry(
  dir: VpkDirectory,
  entry: VpkEntry,
  dirData: Uint8Array,
  readArchive: (index: number) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (entry.entryLength === 0) return entry.preload.slice();
  const source =
    entry.archiveIndex === 0x7fff
      ? dirData.subarray(
          dir.dataSectionOffset + entry.entryOffset,
          dir.dataSectionOffset + entry.entryOffset + entry.entryLength,
        )
      : (await readArchive(entry.archiveIndex)).subarray(
          entry.entryOffset,
          entry.entryOffset + entry.entryLength,
        );
  if (entry.preload.length === 0) return source.slice();
  const out = new Uint8Array(entry.preload.length + source.length);
  out.set(entry.preload, 0);
  out.set(source, entry.preload.length);
  return out;
}
