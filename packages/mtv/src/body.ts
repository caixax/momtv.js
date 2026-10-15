import { ByteReader, toBytes } from './byte-reader.js';
import { ReplayCompression } from './enums.js';
import { MtvError } from './error.js';
import type { ReplayHeader } from './header.js';
import { lzmaDecompress } from './lzma.js';

/** 'LZMA' as a little endian uint32 (Valve lzma_header_t id). */
export const VALVE_LZMA_ID = 0x414d5a4c;

/** Defensive cap on the decompressed body size (256 MiB). */
const MAX_BODY_SIZE = 256 * 1024 * 1024;

/**
 * Decompresses the replay body that follows the splits block.
 *
 * The body uses Valve's `lzma_header_t` framing:
 * `'LZMA'` id (u32), `actualSize` (u32), `lzmaSize` (u32),
 * 5 bytes of LZMA properties, then `lzmaSize` bytes of raw LZMA data.
 *
 * @param data the whole replay file.
 * @param header the parsed replay header (for the compression field).
 * @param bodyOffset absolute offset where the body starts (from `readSplits`).
 * @returns the decompressed body bytes.
 * @throws {MtvError} on truncated or malformed input.
 */
export function decompressBody(
  data: ArrayBuffer | Uint8Array,
  header: Pick<ReplayHeader, 'compression'>,
  bodyOffset: number,
): Uint8Array {
  const r = new ByteReader(toBytes(data));
  r.seek(bodyOffset);

  if (header.compression === ReplayCompression.None) {
    return r.raw(r.remaining, 'uncompressed body');
  }
  if (header.compression !== ReplayCompression.Lzma) {
    throw new MtvError(
      'UNSUPPORTED_COMPRESSION',
      `Unsupported compression type ${header.compression}`,
    );
  }

  const id = r.u32('LZMA id');
  if (id !== VALVE_LZMA_ID) {
    throw new MtvError(
      'BAD_LZMA',
      `Body does not start with the Valve LZMA id (got 0x${id.toString(16)})`,
    );
  }

  const actualSize = r.u32('actualSize');
  const lzmaSize = r.u32('lzmaSize');
  if (actualSize > MAX_BODY_SIZE) {
    throw new MtvError(
      'LIMIT_EXCEEDED',
      `Declared body size ${actualSize} exceeds the ${MAX_BODY_SIZE} byte cap`,
    );
  }

  const props = r.raw(5, 'LZMA properties');
  const compressed = r.raw(lzmaSize, 'LZMA data');

  const out = lzmaDecompress(props, compressed, actualSize);
  if (out.length !== actualSize) {
    throw new MtvError(
      'BAD_LZMA',
      `Body decompressed to ${out.length} bytes, header declared ${actualSize}`,
    );
  }
  return out;
}
