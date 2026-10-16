import { describe, expect, it } from 'vitest';
import { parseVtf } from '../src/bsp/vtf.js';

/**
 * Builds a VTF by hand, since the game's own textures are not committed.
 *
 * @param options.minor - version after the 7, which decides whether the file
 * carries a resource directory
 * @param options.compressed - store the image the way Strata Source does, one
 * compressed chunk per mip level
 */
function buildVtf(options: {
  minor: number;
  width: number;
  height: number;
  format: number;
  mips: number;
  image: Uint8Array[];
  compressed?: boolean;
  flags?: number;
}): Uint8Array {
  const { minor, width, height, format, mips, image } = options;
  const hasDirectory = minor >= 3;
  // real files pad the header, which is why the size is stored rather than fixed
  const headerSize = hasDirectory ? 80 + (options.compressed ? 2 : 1) * 8 : 80;
  const header = new Uint8Array(headerSize);
  const view = new DataView(header.buffer);
  header.set([0x56, 0x54, 0x46, 0x00]); // 'VTF\0'
  view.setUint32(4, 7, true);
  view.setUint32(8, minor, true);
  view.setUint32(12, headerSize, true);
  view.setUint16(16, width, true);
  view.setUint16(18, height, true);
  view.setUint32(20, options.flags ?? 0, true);
  view.setUint16(24, 1, true); // one frame
  view.setInt32(52, format, true);
  view.setUint8(56, mips);
  view.setInt32(57, -1, true); // no thumbnail
  view.setUint16(63, 1, true); // one slice

  // Every chunk of a compressed file is a zstd frame holding stored bytes.
  const chunks = options.compressed
    ? image.map((mip) => {
        const blockHeader = (mip.length << 3) | 1;
        return new Uint8Array([
          0x28,
          0xb5,
          0x2f,
          0xfd,
          0x20,
          mip.length & 0xff,
          blockHeader & 0xff,
          (blockHeader >> 8) & 0xff,
          (blockHeader >> 16) & 0xff,
          ...mip,
        ]);
      })
    : image;

  const table: number[] = [];
  if (options.compressed) {
    // size of the block, a version word, then one size per chunk
    const size = 4 + chunks.length * 4;
    const bytes = new DataView(new ArrayBuffer(4 + size));
    bytes.setUint32(0, size, true);
    bytes.setUint32(4, 0x005d0016, true);
    chunks.forEach((chunk, i) => bytes.setUint32(8 + i * 4, chunk.length, true));
    table.push(...new Uint8Array(bytes.buffer));
  }

  if (hasDirectory) {
    const resources = options.compressed ? 2 : 1;
    view.setUint32(68, resources, true);
    let at = 80;
    if (options.compressed) {
      header.set([0x41, 0x58, 0x43, 0], at); // 'AXC'
      view.setUint32(at + 4, headerSize, true);
      at += 8;
    }
    header.set([0x30, 0, 0, 0], at); // the image data
    view.setUint32(at + 4, headerSize + table.length, true);
  }

  const body: number[] = [...table];
  for (const chunk of chunks) body.push(...chunk);
  return new Uint8Array([...header, ...body]);
}

/** One mip level of a DXT1 image: a single block of a flat colour. */
function dxt1Block(): Uint8Array {
  // both endpoints red, every pixel taking the first endpoint
  return new Uint8Array([0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0]);
}

describe('parseVtf', () => {
  it('rejects files that are not VTFs', () => {
    expect(() => parseVtf(new Uint8Array(64))).toThrow(/not a VTF/);
    expect(() => parseVtf(new Uint8Array(8))).toThrow(/too small/);
  });

  it('reads an image that follows the header, as the old versions store it', () => {
    const texture = parseVtf(
      buildVtf({ minor: 2, width: 4, height: 4, format: 13, mips: 1, image: [dxt1Block()] }),
    );
    expect(texture.width).toBe(4);
    expect(texture.height).toBe(4);
    expect(texture.pixels).toHaveLength(4 * 4 * 4);
    expect([...texture.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it('follows the resource directory to the image data', () => {
    const texture = parseVtf(
      buildVtf({ minor: 4, width: 4, height: 4, format: 13, mips: 1, image: [dxt1Block()] }),
    );
    expect([...texture.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it('takes the largest mip level, which is stored last', () => {
    // a 8x8 image: one 4x4 block for the small level, four for the large one
    const small = dxt1Block();
    const large = new Uint8Array(4 * 8);
    for (let i = 0; i < 4; i++) large.set([0x1f, 0x00, 0x1f, 0x00, 0, 0, 0, 0], i * 8);
    const texture = parseVtf(
      buildVtf({ minor: 4, width: 8, height: 8, format: 13, mips: 2, image: [small, large] }),
    );
    expect(texture.width).toBe(8);
    // blue, so the large level was the one read
    expect([...texture.pixels.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
  });

  it('decompresses the mip level of a Strata Source texture', () => {
    const small = dxt1Block();
    const large = new Uint8Array(4 * 8);
    for (let i = 0; i < 4; i++) large.set([0xe0, 0x07, 0xe0, 0x07, 0, 0, 0, 0], i * 8);
    const texture = parseVtf(
      buildVtf({
        minor: 6,
        width: 8,
        height: 8,
        format: 13,
        mips: 2,
        image: [small, large],
        compressed: true,
      }),
    );
    expect(texture.width).toBe(8);
    expect([...texture.pixels.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  });

  it('refuses an image format it cannot size', () => {
    expect(() =>
      parseVtf(
        buildVtf({ minor: 4, width: 4, height: 4, format: 999, mips: 1, image: [dxt1Block()] }),
      ),
    ).toThrow(/image format 999/);
  });

  it('refuses a truncated image', () => {
    const data = buildVtf({
      minor: 4,
      width: 16,
      height: 16,
      format: 13,
      mips: 1,
      image: [dxt1Block()],
    });
    expect(() => parseVtf(data)).toThrow(/truncated/);
  });
});
