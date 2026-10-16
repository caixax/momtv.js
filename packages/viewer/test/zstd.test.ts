import { describe, expect, it } from 'vitest';
import { decompressZstd } from '../src/bsp/zstd.js';

/** Builds a frame whose blocks are written out by hand. */
function frame(blocks: Uint8Array[], options: { contentSize?: number; checksum?: boolean } = {}) {
  const parts: number[] = [0x28, 0xb5, 0x2f, 0xfd];
  // single segment, so no window descriptor, plus a one byte content size
  let descriptor = 0x20;
  if (options.checksum) descriptor |= 0x04;
  parts.push(descriptor, options.contentSize ?? 0);
  for (const block of blocks) parts.push(...block);
  if (options.checksum) parts.push(1, 2, 3, 4);
  return new Uint8Array(parts);
}

function rawBlock(bytes: number[], last: boolean): Uint8Array {
  const header = (bytes.length << 3) | (0 << 1) | (last ? 1 : 0);
  return new Uint8Array([header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff, ...bytes]);
}

function rleBlock(byte: number, count: number, last: boolean): Uint8Array {
  const header = (count << 3) | (1 << 1) | (last ? 1 : 0);
  return new Uint8Array([header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff, byte]);
}

describe('decompressZstd', () => {
  it('reads a frame of stored bytes', () => {
    const out = decompressZstd(frame([rawBlock([1, 2, 3, 4], true)], { contentSize: 4 }));
    expect([...out]).toEqual([1, 2, 3, 4]);
  });

  it('reads a run of one repeated byte', () => {
    const out = decompressZstd(frame([rleBlock(0xab, 300, true)]));
    expect(out).toHaveLength(300);
    expect(out.every((b) => b === 0xab)).toBe(true);
  });

  it('reads several blocks and a trailing checksum', () => {
    const out = decompressZstd(
      frame([rawBlock([7], false), rleBlock(9, 3, false), rawBlock([8], true)], {
        checksum: true,
      }),
    );
    expect([...out]).toEqual([7, 9, 9, 9, 8]);
  });

  it('reads frames one after another and skips skippable ones', () => {
    const first = frame([rawBlock([1, 2], true)], { contentSize: 2 });
    const skippable = new Uint8Array([0x50, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 0xff, 0xff]);
    const second = frame([rawBlock([3], true)], { contentSize: 1 });
    const joined = new Uint8Array([...first, ...skippable, ...second]);
    expect([...decompressZstd(joined)]).toEqual([1, 2, 3]);
  });

  it('refuses anything that is not a frame', () => {
    expect(() => decompressZstd(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(/not a zstd frame/);
  });

  it('refuses a block that claims more bytes than it has', () => {
    // the frame header and the block header survive, the payload does not
    expect(() => decompressZstd(frame([rawBlock([1, 2, 3], true)]).subarray(0, 10))).toThrow(
      /runs past the end/,
    );
  });

  it('refuses a reserved block type', () => {
    const header = (1 << 3) | (3 << 1) | 1;
    const block = new Uint8Array([header & 0xff, 0, 0, 0]);
    expect(() => decompressZstd(frame([block]))).toThrow(/reserved type/);
  });
});

// The compressor in Node is the reference implementation, so where it exists
// it is the strongest check this decoder can be held to.
const zlib = await import('node:zlib');
const oracle = typeof zlib.zstdCompressSync === 'function';

describe.skipIf(!oracle)('against the reference compressor', () => {
  const pack = (data: Uint8Array, level: number): Uint8Array =>
    new Uint8Array(
      zlib.zstdCompressSync(data, {
        params: { [zlib.constants.ZSTD_c_compressionLevel!]: level },
      }),
    );

  /** A deterministic pseudo random generator, so failures reproduce. */
  const sequence = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const shapes: Record<string, (n: number, rnd: () => number) => Uint8Array> = {
    noise: (n, rnd) => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256)),
    sparse: (n, rnd) => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 4)),
    pattern: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff),
    flat: (n) => new Uint8Array(n).fill(0x5a),
    text: (n) => {
      const line = 'the quick brown fox jumps over the lazy dog. ';
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = line.charCodeAt(i % line.length);
      return out;
    },
  };

  for (const [name, make] of Object.entries(shapes)) {
    it(`round trips ${name}`, () => {
      const rnd = sequence(0x5eed);
      for (const size of [1, 2, 31, 1000, 70_000, 200_000]) {
        const raw = make(size, rnd);
        for (const level of [1, 3, 9, 19]) {
          const got = decompressZstd(pack(raw, level), raw.length);
          expect({ name, size, level, bytes: got.length }).toEqual({
            name,
            size,
            level,
            bytes: raw.length,
          });
          expect(got).toEqual(raw);
        }
      }
    });
  }
});
