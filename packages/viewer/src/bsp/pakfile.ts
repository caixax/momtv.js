/**
 * Minimal reader for the zip archive embedded in a BSP's pakfile lump.
 *
 * Supports stored, deflated and LZMA entries. Valve's packer writes LZMA
 * (method 14), which is what Momentum maps use; deflate uses the platform
 * DecompressionStream, so no inflate implementation is bundled.
 */
import { lzmaDecompress } from '@caixax/momtv';

/** One entry of the embedded archive. */
export interface PakEntry {
  /** Lowercased path with forward slashes, for example 'materials/x/y.vtf'. */
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the entry's data inside the pakfile bytes. */
  dataOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/**
 * Lists the entries of a pakfile by reading its central directory.
 *
 * Returns an empty list when the lump holds no usable archive, since a map
 * without packed content is perfectly normal.
 */
export function readPakfile(pak: Uint8Array): PakEntry[] {
  if (pak.length < 22) return [];
  const view = new DataView(pak.buffer, pak.byteOffset, pak.byteLength);

  // the end of central directory record sits in the last 64 KiB
  let eocd = -1;
  const searchStart = Math.max(0, pak.length - 65_557);
  for (let p = pak.length - 22; p >= searchStart; p--) {
    if (view.getUint32(p, true) === EOCD_SIGNATURE) {
      eocd = p;
      break;
    }
  }
  if (eocd === -1) return [];

  const entryCount = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const entries: PakEntry[] = [];
  const decoder = new TextDecoder('latin1');
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > pak.length || view.getUint32(pos, true) !== CENTRAL_SIGNATURE) break;
    const compressionMethod = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const name = decoder
      .decode(pak.subarray(pos + 46, pos + 46 + nameLength))
      .replace(/\\/g, '/')
      .toLowerCase();
    // the local header repeats the name and extra fields before the data
    if (localHeaderOffset + 30 <= pak.length) {
      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      entries.push({
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        dataOffset: localHeaderOffset + 30 + localNameLength + localExtraLength,
      });
    }
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Reads one entry's bytes, inflating it when needed.
 *
 * @throws {Error} when the entry uses an unsupported compression method.
 */
export async function readPakEntry(pak: Uint8Array, entry: PakEntry): Promise<Uint8Array> {
  const raw = pak.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.compressionMethod === 0) return raw;

  if (entry.compressionMethod === 14) {
    // zip LZMA: 2 bytes SDK version, 2 bytes properties size, then that many
    // property bytes, then the raw stream. The size comes from the directory
    // because the stream carries no length of its own.
    if (raw.length < 9) throw new Error(`pakfile entry ${entry.name} is truncated`);
    const propsSize = raw[2]! | (raw[3]! << 8);
    const props = raw.subarray(4, 4 + propsSize);
    const data = raw.subarray(4 + propsSize);
    return lzmaDecompress(props, data, entry.uncompressedSize);
  }

  if (entry.compressionMethod === 8) {
    const stream = new Blob([raw as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  throw new Error(`pakfile entry ${entry.name} uses compression method ${entry.compressionMethod}`);
}
