import { describe, expect, it } from 'vitest';
import { BitReader, MomtvError } from '../src/index.js';

function writeBitsLsb(bits: number[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) out[i >> 3] = out[i >> 3]! | (1 << (i & 7));
  });
  return out;
}

function ubitvarBits(value: number): number[] {
  // encode like the game: pick the smallest case
  const put = (v: number, n: number): number[] => Array.from({ length: n }, (_, i) => (v >> i) & 1);
  if (value < 16) return put(value, 4).concat([0, 0]);
  if (value < 16 * 16) return put(value & 15, 4).concat([1, 0], put(value >> 4, 4));
  if (value < 16 * 256) return put(value & 15, 4).concat([0, 1], put(value >> 4, 8));
  return put(value & 15, 4).concat([1, 1], put(value >>> 4, 28));
}

describe('BitReader', () => {
  it('reads LSB-first bits and floats', () => {
    const bytes = new Uint8Array([0b10110010, 0x00, 0x00, 0x80, 0x3f, 0x00]);
    const r = new BitReader(bytes);
    expect(r.readBit()).toBe(0);
    expect(r.readBits(3)).toBe(0b001);
    expect(r.readBits(4)).toBe(0b1011);
    // float 1.0 = 00 00 80 3f starting at the next byte
    expect(r.readFloat32()).toBe(1.0);
  });

  it('decodes all four UBitVar cases', () => {
    for (const value of [0, 7, 15, 16, 200, 255, 4095, 65535, 70000, 123456789]) {
      const r = new BitReader(writeBitsLsb(ubitvarBits(value)));
      expect(r.readUBitVar()).toBe(value);
    }
  });

  it('throws TRUNCATED past the end', () => {
    const r = new BitReader(new Uint8Array([0xff]));
    r.readBits(8);
    expect(() => r.readBit()).toThrowError(MomtvError);
    try {
      r.readBits(4);
    } catch (error) {
      expect((error as MomtvError).code).toBe('TRUNCATED');
    }
  });

  it('respects byteLength windows and alignment', () => {
    const r = new BitReader(new Uint8Array([0xff, 0xff, 0xff]), 1, 1);
    r.readBits(3);
    r.alignByte();
    expect(r.remainingBits).toBe(0);
    expect(() => r.readBit()).toThrowError(MomtvError);
  });
});
