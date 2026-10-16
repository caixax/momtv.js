import { describe, expect, it } from 'vitest';
import { decodeBc7 } from '../src/bsp/bc7.js';

/** Writes a block one field at a time, least significant bit first. */
class BlockWriter {
  readonly bytes = new Uint8Array(16);
  private at = 0;

  write(value: number, bits: number): this {
    for (let i = 0; i < bits; i++) {
      if ((value >> i) & 1) this.bytes[(this.at + i) >> 3]! |= 1 << ((this.at + i) & 7);
    }
    this.at += bits;
    return this;
  }
}

/**
 * One block of the simplest mode: a single group, seven bit endpoints with a
 * rounding bit each, and a four bit index per pixel.
 *
 * The rounding bit is shared by every channel of an endpoint, so the values
 * here are even and the bit is zero: that way an endpoint comes back exactly
 * as it went in.
 */
function mode6Block(
  from: [number, number, number, number],
  to: [number, number, number, number],
  indices: number[],
): Uint8Array {
  const w = new BlockWriter();
  w.write(0, 6).write(1, 1); // the mode, counted in zeros
  for (let channel = 0; channel < 4; channel++) {
    w.write(from[channel]! >> 1, 7);
    w.write(to[channel]! >> 1, 7);
  }
  w.write(0, 1); // the rounding bit of each endpoint
  w.write(0, 1);
  indices.forEach((index, pixel) => w.write(index, pixel === 0 ? 3 : 4));
  return w.bytes;
}

describe('decodeBc7', () => {
  it('reads a block that is all of one colour', () => {
    const block = mode6Block([254, 0, 0, 254], [254, 0, 0, 254], new Array(16).fill(0));
    const pixels = decodeBc7(block, 4, 4);
    expect(pixels).toHaveLength(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      expect([...pixels.subarray(i * 4, i * 4 + 4)]).toEqual([254, 0, 0, 254]);
    }
  });

  it('runs from one endpoint to the other across the indices', () => {
    const indices = [0, 15, 0, 15, 0, 15, 0, 15, 0, 15, 0, 15, 0, 15, 0, 15];
    const block = mode6Block([0, 0, 0, 254], [254, 254, 254, 254], indices);
    const pixels = decodeBc7(block, 4, 4);
    // the first pixel takes the first endpoint, the second the other
    expect([...pixels.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect([...pixels.subarray(4, 7)]).toEqual([254, 254, 254]);
  });

  it('places the middle indices in between', () => {
    const indices = [0, 8, ...new Array(14).fill(0)];
    const pixels = decodeBc7(mode6Block([0, 0, 0, 254], [254, 254, 254, 254], indices), 4, 4);
    const middle = pixels[4]!;
    expect(middle).toBeGreaterThan(100);
    expect(middle).toBeLessThan(160);
  });

  it('carries alpha through', () => {
    const block = mode6Block([10, 20, 30, 0], [10, 20, 30, 254], [0, 15, ...new Array(14).fill(0)]);
    const pixels = decodeBc7(block, 4, 4);
    expect(pixels[3]).toBe(0);
    expect(pixels[7]).toBeGreaterThan(250);
  });

  it('treats a block with no mode as transparent black', () => {
    const pixels = decodeBc7(new Uint8Array(16), 4, 4);
    expect([...pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it('fills a whole image of several blocks', () => {
    const red = mode6Block([254, 0, 0, 254], [254, 0, 0, 254], new Array(16).fill(0));
    const blue = mode6Block([0, 0, 254, 254], [0, 0, 254, 254], new Array(16).fill(0));
    const blocks = new Uint8Array(32);
    blocks.set(red, 0);
    blocks.set(blue, 16);
    const pixels = decodeBc7(blocks, 8, 4);
    // the left block is red and the right one blue
    expect([...pixels.subarray(0, 3)]).toEqual([254, 0, 0]);
    expect([...pixels.subarray(4 * 4, 4 * 4 + 3)]).toEqual([0, 0, 254]);
  });
});
