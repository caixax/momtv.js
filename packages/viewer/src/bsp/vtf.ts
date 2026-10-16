/**
 * VTF (Valve Texture Format) reader, limited to what the renderer needs: the
 * largest mip level of the first frame, decoded to RGBA8.
 *
 * Versions 7.0 to 7.6 are read. From 7.3 the file carries a directory of
 * resources and the image data is wherever that says, and Strata Source's 7.6
 * adds an auxiliary compression resource: each mip level is then stored
 * compressed, which is how the game ships most of its textures.
 *
 * Written from the publicly documented VTF layout.
 */
import { lzmaDecompress } from '@caixax/momtv';
import { decodeBc7 } from './bc7.js';
import { decompressZstd } from './zstd.js';

/** Image formats, numbered as the engine numbers them. */
const FORMAT = {
  RGBA8888: 0,
  ABGR8888: 1,
  RGB888: 2,
  BGR888: 3,
  RGB565: 4,
  I8: 5,
  IA88: 6,
  P8: 7,
  A8: 8,
  RGB888_BLUESCREEN: 9,
  BGR888_BLUESCREEN: 10,
  ARGB8888: 11,
  BGRA8888: 12,
  DXT1: 13,
  DXT3: 14,
  DXT5: 15,
  BGRX8888: 16,
  BGR565: 17,
  BGRX5551: 18,
  BGRA4444: 19,
  DXT1_ONEBITALPHA: 20,
  BGRA5551: 21,
  UV88: 22,
  UVWQ8888: 23,
  RGBA16161616F: 24,
  RGBA16161616: 25,
  UVLX8888: 26,
  /** Strata Source's block compressed format, used by model textures. */
  BC7: 70,
} as const;

/** Bytes each pixel of an uncompressed format takes. */
const PIXEL_BYTES = new Map<number, number>([
  [FORMAT.RGBA8888, 4],
  [FORMAT.ABGR8888, 4],
  [FORMAT.RGB888, 3],
  [FORMAT.BGR888, 3],
  [FORMAT.RGB565, 2],
  [FORMAT.I8, 1],
  [FORMAT.IA88, 2],
  [FORMAT.P8, 1],
  [FORMAT.A8, 1],
  [FORMAT.RGB888_BLUESCREEN, 3],
  [FORMAT.BGR888_BLUESCREEN, 3],
  [FORMAT.ARGB8888, 4],
  [FORMAT.BGRA8888, 4],
  [FORMAT.BGRX8888, 4],
  [FORMAT.BGR565, 2],
  [FORMAT.BGRX5551, 2],
  [FORMAT.BGRA4444, 2],
  [FORMAT.BGRA5551, 2],
  [FORMAT.UV88, 2],
  [FORMAT.UVWQ8888, 4],
  [FORMAT.RGBA16161616F, 8],
  [FORMAT.RGBA16161616, 8],
  [FORMAT.UVLX8888, 4],
]);

/** Bytes a 4x4 block takes, for the block compressed formats. */
const BLOCK_BYTES = new Map<number, number>([
  [FORMAT.DXT1, 8],
  [FORMAT.DXT1_ONEBITALPHA, 8],
  [FORMAT.DXT3, 16],
  [FORMAT.DXT5, 16],
  [FORMAT.BC7, 16],
]);

/** A decoded texture, ready for upload. */
export interface DecodedTexture {
  width: number;
  height: number;
  /** RGBA8 pixels, top row first. */
  pixels: Uint8Array;
}

/**
 * Bytes one image of a format takes.
 *
 * @throws {Error} for a format this reader does not know, since guessing a
 * size would put every following mip level at the wrong offset.
 */
function bytesForFormat(format: number, width: number, height: number): number {
  const block = BLOCK_BYTES.get(format);
  if (block !== undefined) {
    return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * block;
  }
  const pixel = PIXEL_BYTES.get(format);
  if (pixel === undefined) throw new Error(`VTF uses image format ${format}`);
  return width * height * pixel;
}

/** Turns a 16 bit half float into a number. */
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** Expands a 5/6/5 colour to 8 bit RGB. */
function rgb565(c: number, out: Uint8Array, at: number): void {
  const r = (c >> 11) & 0x1f;
  const g = (c >> 5) & 0x3f;
  const b = c & 0x1f;
  out[at] = (r << 3) | (r >> 2);
  out[at + 1] = (g << 2) | (g >> 4);
  out[at + 2] = (b << 3) | (b >> 2);
}

/** Decodes DXT1/DXT3/DXT5 blocks into RGBA8. */
function decodeDxt(src: Uint8Array, width: number, height: number, format: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  const blockBytes = format === FORMAT.DXT1 || format === FORMAT.DXT1_ONEBITALPHA ? 8 : 16;
  const colour = new Uint8Array(16); // 4 colours x RGBA
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const block = (by * blocksX + bx) * blockBytes;
      if (block + blockBytes > src.length) break;
      let alphaOffset = -1;
      let colourOffset = block;
      if (blockBytes === 16) {
        alphaOffset = block;
        colourOffset = block + 8;
      }

      const c0 = view.getUint16(colourOffset, true);
      const c1 = view.getUint16(colourOffset + 2, true);
      rgb565(c0, colour, 0);
      rgb565(c1, colour, 4);
      colour[3] = 255;
      colour[7] = 255;
      const opaque = c0 > c1 || blockBytes === 16;
      for (let i = 0; i < 3; i++) {
        if (opaque) {
          colour[8 + i] = (2 * colour[i]! + colour[4 + i]!) / 3;
          colour[12 + i] = (colour[i]! + 2 * colour[4 + i]!) / 3;
        } else {
          colour[8 + i] = (colour[i]! + colour[4 + i]!) / 2;
          colour[12 + i] = 0;
        }
      }
      colour[11] = 255;
      colour[15] = opaque ? 255 : 0;

      const bits = view.getUint32(colourOffset + 4, true);
      // DXT5 alpha: two endpoints plus 3 bit indices
      let a0 = 255;
      let a1 = 255;
      let alphaBitsLo = 0;
      let alphaBitsHi = 0;
      if (format === FORMAT.DXT5 && alphaOffset >= 0) {
        a0 = src[alphaOffset]!;
        a1 = src[alphaOffset + 1]!;
        alphaBitsLo =
          src[alphaOffset + 2]! | (src[alphaOffset + 3]! << 8) | (src[alphaOffset + 4]! << 16);
        alphaBitsHi =
          src[alphaOffset + 5]! | (src[alphaOffset + 6]! << 8) | (src[alphaOffset + 7]! << 16);
      }

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const pixelIndex = py * 4 + px;
          const code = (bits >>> (pixelIndex * 2)) & 3;
          const dst = (y * width + x) * 4;
          out[dst] = colour[code * 4]!;
          out[dst + 1] = colour[code * 4 + 1]!;
          out[dst + 2] = colour[code * 4 + 2]!;
          let alpha = colour[code * 4 + 3]!;
          if (format === FORMAT.DXT5) {
            const shift = (pixelIndex % 8) * 3;
            const chunk = pixelIndex < 8 ? alphaBitsLo : alphaBitsHi;
            const ai = (chunk >>> shift) & 7;
            if (ai === 0) alpha = a0;
            else if (ai === 1) alpha = a1;
            else if (a0 > a1) alpha = ((8 - ai) * a0 + (ai - 1) * a1) / 7;
            else if (ai === 6) alpha = 0;
            else if (ai === 7) alpha = 255;
            else alpha = ((6 - ai) * a0 + (ai - 1) * a1) / 5;
          } else if (format === FORMAT.DXT3 && alphaOffset >= 0) {
            const nibble = src[alphaOffset + (pixelIndex >> 1)]!;
            alpha = ((pixelIndex & 1 ? nibble >> 4 : nibble & 15) * 255) / 15;
          }
          out[dst + 3] = alpha;
        }
      }
    }
  }
  return out;
}

/** Decodes an uncompressed format into RGBA8. */
function decodeUncompressed(
  src: Uint8Array,
  width: number,
  height: number,
  format: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const pixels = width * height;
  for (let i = 0; i < pixels; i++) {
    const d = i * 4;
    switch (format) {
      case FORMAT.RGBA8888:
        out[d] = src[i * 4]!;
        out[d + 1] = src[i * 4 + 1]!;
        out[d + 2] = src[i * 4 + 2]!;
        out[d + 3] = src[i * 4 + 3]!;
        break;
      case FORMAT.BGRA8888:
      case FORMAT.BGRX8888:
        out[d] = src[i * 4 + 2]!;
        out[d + 1] = src[i * 4 + 1]!;
        out[d + 2] = src[i * 4]!;
        out[d + 3] = format === FORMAT.BGRX8888 ? 255 : src[i * 4 + 3]!;
        break;
      case FORMAT.ARGB8888:
        out[d] = src[i * 4 + 1]!;
        out[d + 1] = src[i * 4 + 2]!;
        out[d + 2] = src[i * 4 + 3]!;
        out[d + 3] = src[i * 4]!;
        break;
      case FORMAT.ABGR8888:
        out[d] = src[i * 4 + 3]!;
        out[d + 1] = src[i * 4 + 2]!;
        out[d + 2] = src[i * 4 + 1]!;
        out[d + 3] = src[i * 4]!;
        break;
      case FORMAT.RGB888:
        out[d] = src[i * 3]!;
        out[d + 1] = src[i * 3 + 1]!;
        out[d + 2] = src[i * 3 + 2]!;
        out[d + 3] = 255;
        break;
      case FORMAT.BGR888:
        out[d] = src[i * 3 + 2]!;
        out[d + 1] = src[i * 3 + 1]!;
        out[d + 2] = src[i * 3]!;
        out[d + 3] = 255;
        break;
      case FORMAT.I8:
        out[d] = out[d + 1] = out[d + 2] = src[i]!;
        out[d + 3] = 255;
        break;
      case FORMAT.IA88:
        out[d] = out[d + 1] = out[d + 2] = src[i * 2]!;
        out[d + 3] = src[i * 2 + 1]!;
        break;
      case FORMAT.A8:
        out[d] = out[d + 1] = out[d + 2] = 255;
        out[d + 3] = src[i]!;
        break;
      case FORMAT.P8:
        // No palette is stored, so the index reads as a grey level.
        out[d] = out[d + 1] = out[d + 2] = src[i]!;
        out[d + 3] = 255;
        break;
      case FORMAT.RGB888_BLUESCREEN:
      case FORMAT.BGR888_BLUESCREEN: {
        // Pure blue means transparent in these two.
        const r = format === FORMAT.RGB888_BLUESCREEN ? src[i * 3]! : src[i * 3 + 2]!;
        const g = src[i * 3 + 1]!;
        const b = format === FORMAT.RGB888_BLUESCREEN ? src[i * 3 + 2]! : src[i * 3]!;
        out[d] = r;
        out[d + 1] = g;
        out[d + 2] = b;
        out[d + 3] = r === 0 && g === 0 && b === 255 ? 0 : 255;
        break;
      }
      case FORMAT.RGB565:
      case FORMAT.BGR565: {
        const c = src[i * 2]! | (src[i * 2 + 1]! << 8);
        rgb565(c, out, d);
        if (format === FORMAT.BGR565) {
          const r = out[d]!;
          out[d] = out[d + 2]!;
          out[d + 2] = r;
        }
        out[d + 3] = 255;
        break;
      }
      case FORMAT.BGRX5551:
      case FORMAT.BGRA5551: {
        const c = src[i * 2]! | (src[i * 2 + 1]! << 8);
        const b5 = c & 0x1f;
        const g5 = (c >> 5) & 0x1f;
        const r5 = (c >> 10) & 0x1f;
        out[d] = (r5 << 3) | (r5 >> 2);
        out[d + 1] = (g5 << 3) | (g5 >> 2);
        out[d + 2] = (b5 << 3) | (b5 >> 2);
        out[d + 3] = format === FORMAT.BGRX5551 || (c & 0x8000) !== 0 ? 255 : 0;
        break;
      }
      case FORMAT.BGRA4444: {
        const c = src[i * 2]! | (src[i * 2 + 1]! << 8);
        const b4 = c & 15;
        const g4 = (c >> 4) & 15;
        const r4 = (c >> 8) & 15;
        const a4 = (c >> 12) & 15;
        out[d] = (r4 << 4) | r4;
        out[d + 1] = (g4 << 4) | g4;
        out[d + 2] = (b4 << 4) | b4;
        out[d + 3] = (a4 << 4) | a4;
        break;
      }
      case FORMAT.UV88:
        out[d] = src[i * 2]!;
        out[d + 1] = src[i * 2 + 1]!;
        out[d + 2] = 255;
        out[d + 3] = 255;
        break;
      case FORMAT.UVWQ8888:
      case FORMAT.UVLX8888:
        out[d] = src[i * 4]!;
        out[d + 1] = src[i * 4 + 1]!;
        out[d + 2] = src[i * 4 + 2]!;
        out[d + 3] = 255;
        break;
      case FORMAT.RGBA16161616:
        // Sixteen bit channels, of which the top eight are enough here.
        out[d] = src[i * 8 + 1]!;
        out[d + 1] = src[i * 8 + 3]!;
        out[d + 2] = src[i * 8 + 5]!;
        out[d + 3] = src[i * 8 + 7]!;
        break;
      case FORMAT.RGBA16161616F: {
        // A high range image, brought into range with the engine's own gamma.
        for (let c = 0; c < 4; c++) {
          const value = halfToFloat(src[i * 8 + c * 2]! | (src[i * 8 + c * 2 + 1]! << 8));
          const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
          out[d + c] = Math.round((c === 3 ? clamped : clamped ** (1 / 2.2)) * 255);
        }
        break;
      }
      default:
        throw new Error(`VTF uses image format ${format}`);
    }
  }
  return out;
}

/** Resource tags a VTF of version 7.3 or later can carry. */
const RESOURCE_IMAGE = 0x30;
/** Strata Source's auxiliary compression table, written as the text 'AXC'. */
const RESOURCE_COMPRESSION = 0x435841;
/** The resource stores its value in place of an offset. */
const RESOURCE_NO_DATA = 0x02;

/** Texture is a cube map, so every mip level holds several faces. */
const FLAG_ENVMAP = 0x4000;

/** Undoes whatever Strata Source compressed a mip level with. */
function decompressChunk(chunk: Uint8Array, size: number): Uint8Array {
  if (chunk.length >= 4 && chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f) {
    return decompressZstd(chunk, size);
  }
  // Valve's LZMA, with its own five byte properties block and a size field.
  if (chunk.length >= 17 && chunk[0] === 0x4c && chunk[1] === 0x5a && chunk[2] === 0x4d) {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const actual = view.getUint32(4, true);
    return lzmaDecompress(chunk.subarray(12, 17), chunk.subarray(17), actual);
  }
  if (chunk.length === size) return chunk;
  throw new Error('VTF mip level uses an unknown compression');
}

/**
 * Decodes the largest mip level of a VTF to RGBA8.
 *
 * @throws {Error} on a malformed file or an unsupported image format.
 */
export function parseVtf(data: Uint8Array): DecodedTexture {
  if (data.length < 64) throw new Error('VTF too small');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 0x00465456) throw new Error('not a VTF file'); // 'VTF\0'
  const minor = view.getUint32(8, true);
  const headerSize = view.getUint32(12, true);
  const width = view.getUint16(16, true);
  const height = view.getUint16(18, true);
  const flags = view.getUint32(20, true);
  const frames = Math.max(1, view.getUint16(24, true));
  const format = view.getInt32(52, true);
  const mipCount = view.getUint8(56);
  const lowResFormat = view.getInt32(57, true);
  const lowResWidth = view.getUint8(61);
  const lowResHeight = view.getUint8(62);
  const depth = minor >= 2 ? Math.max(1, view.getUint16(63, true)) : 1;

  if (width === 0 || height === 0) throw new Error('VTF has no image');
  if (width * height > 4096 * 4096) throw new Error(`VTF is too large (${width}x${height})`);

  // A cube map keeps six faces per mip level, and before 7.5 a seventh one
  // holding a sphere map.
  const faces = (flags & FLAG_ENVMAP) === 0 ? 1 : minor >= 5 || minor === 0 ? 6 : 7;
  const mips = Math.max(1, mipCount);
  const chunksPerMip = frames * faces * depth;

  let imageOffset = -1;
  let compression: Uint8Array | undefined;
  if (minor >= 3) {
    const count = view.getUint32(68, true);
    if (80 + count * 8 > data.length) throw new Error('VTF resource directory is truncated');
    for (let i = 0; i < count; i++) {
      const at = 80 + i * 8;
      const tag = data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16);
      const inPlace = (data[at + 3]! & RESOURCE_NO_DATA) !== 0;
      const value = view.getUint32(at + 4, true);
      if (inPlace) continue;
      if (tag === RESOURCE_IMAGE) imageOffset = value;
      else if (tag === RESOURCE_COMPRESSION) {
        const size = view.getUint32(value, true);
        if (value + 4 + size > data.length) throw new Error('VTF compression table is truncated');
        compression = data.subarray(value + 4, value + 4 + size);
      }
    }
  }
  if (imageOffset < 0) {
    // Before the directory existed the image followed the header, after the
    // thumbnail when there is one.
    imageOffset = headerSize;
    if (lowResFormat !== -1 && lowResWidth > 0 && lowResHeight > 0) {
      imageOffset += bytesForFormat(lowResFormat, lowResWidth, lowResHeight);
    }
  }

  const size = bytesForFormat(format, width, height);
  let src: Uint8Array;
  if (compression) {
    // Every chunk is stored compressed and the table gives their sizes, in the
    // same order as the data: smallest mip level first.
    const table = new DataView(compression.buffer, compression.byteOffset, compression.byteLength);
    const entries = (compression.byteLength - 4) / 4;
    if (entries < mips * chunksPerMip) {
      throw new Error(`VTF compression table holds ${entries} of ${mips * chunksPerMip} chunks`);
    }
    let at = imageOffset;
    // The largest mip level is last, and within it the wanted face is first.
    for (let i = 0; i < (mips - 1) * chunksPerMip; i++) at += table.getUint32(4 + i * 4, true);
    const chunk = table.getUint32(4 + (mips - 1) * chunksPerMip * 4, true);
    if (at + chunk > data.length) throw new Error('VTF image data is truncated');
    src = decompressChunk(data.subarray(at, at + chunk), size);
    if (src.length < size) throw new Error('VTF mip level decompressed short');
  } else {
    let at = imageOffset;
    for (let mip = mips - 1; mip >= 1; mip--) {
      const w = Math.max(1, width >> mip);
      const h = Math.max(1, height >> mip);
      at += bytesForFormat(format, w, h) * chunksPerMip;
    }
    if (at + size > data.length) throw new Error('VTF image data is truncated');
    src = data.subarray(at, at + size);
  }

  let pixels: Uint8Array;
  if (format === FORMAT.BC7) {
    pixels = decodeBc7(src, width, height);
  } else if (
    format === FORMAT.DXT1 ||
    format === FORMAT.DXT1_ONEBITALPHA ||
    format === FORMAT.DXT3 ||
    format === FORMAT.DXT5
  ) {
    pixels = decodeDxt(src, width, height, format);
  } else {
    pixels = decodeUncompressed(src, width, height, format);
  }

  return { width, height, pixels };
}

/**
 * Pulls `$basetexture` out of a VMT material definition.
 *
 * Returns undefined for materials without one (tool textures, patches that
 * only reference other materials).
 */
export function parseVmtBaseTexture(text: string): string | undefined {
  // keyvalues, case insensitive. A quoted value runs to the closing quote and
  // may contain spaces (map texture paths often do); an unquoted one ends at
  // the next whitespace or closing brace.
  const match = /\$basetexture"?\s*(?:"([^"\r\n]+)"|([^"\s}]+))/i.exec(text);
  if (!match) return undefined;
  const value = match[1] ?? match[2];
  if (value === undefined) return undefined;
  return value.trim().replace(/\\/g, '/').toLowerCase();
}
