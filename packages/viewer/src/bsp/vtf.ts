/**
 * VTF (Valve Texture Format) reader, limited to what the renderer needs: the
 * largest mip level of the first frame, decoded to RGBA8.
 *
 * Written from the publicly documented VTF layout.
 */

/** Image formats this reader understands. */
const FORMAT = {
  RGBA8888: 0,
  ABGR8888: 1,
  RGB888: 2,
  BGR888: 3,
  I8: 5,
  IA88: 6,
  ARGB8888: 11,
  BGRA8888: 12,
  DXT1: 13,
  DXT3: 14,
  DXT5: 15,
  BGRX8888: 16,
  BGRA5551: 21,
  DXT1_ONEBITALPHA: 24,
} as const;

/** A decoded texture, ready for upload. */
export interface DecodedTexture {
  width: number;
  height: number;
  /** RGBA8 pixels, top row first. */
  pixels: Uint8Array;
}

function bytesForFormat(format: number, width: number, height: number): number {
  switch (format) {
    case FORMAT.DXT1:
    case FORMAT.DXT1_ONEBITALPHA:
      return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * 8;
    case FORMAT.DXT3:
    case FORMAT.DXT5:
      return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * 16;
    case FORMAT.RGB888:
    case FORMAT.BGR888:
      return width * height * 3;
    case FORMAT.I8:
      return width * height;
    case FORMAT.IA88:
    case FORMAT.BGRA5551:
      return width * height * 2;
    default:
      return width * height * 4;
  }
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
      default:
        return out;
    }
  }
  return out;
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
  const headerSize = view.getUint32(12, true);
  const width = view.getUint16(16, true);
  const height = view.getUint16(18, true);
  const frames = view.getUint16(24, true);
  const format = view.getInt32(52, true);
  const mipCount = view.getUint8(56);
  const lowResFormat = view.getInt32(57, true);
  const lowResWidth = view.getUint8(61);
  const lowResHeight = view.getUint8(62);

  if (width === 0 || height === 0) throw new Error('VTF has no image');
  if (width * height > 4096 * 4096) throw new Error(`VTF is too large (${width}x${height})`);

  let offset = headerSize;
  // the low resolution thumbnail comes first when present
  if (lowResFormat !== -1 && lowResWidth > 0 && lowResHeight > 0) {
    offset += bytesForFormat(lowResFormat, lowResWidth, lowResHeight);
  }

  // mip levels are stored smallest first; skip to the largest, which is last
  const faces = 1;
  const mips = Math.max(1, mipCount);
  for (let mip = mips - 1; mip >= 1; mip--) {
    const w = Math.max(1, width >> mip);
    const h = Math.max(1, height >> mip);
    offset += bytesForFormat(format, w, h) * frames * faces;
  }

  const size = bytesForFormat(format, width, height);
  if (offset + size > data.length) throw new Error('VTF image data is truncated');
  const src = data.subarray(offset, offset + size);

  const pixels =
    format === FORMAT.DXT1 ||
    format === FORMAT.DXT1_ONEBITALPHA ||
    format === FORMAT.DXT3 ||
    format === FORMAT.DXT5
      ? decodeDxt(src, width, height, format)
      : decodeUncompressed(src, width, height, format);

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
