import { describe, expect, it } from 'vitest';
import { decompressBody, MomtvError, readHeader, readSplits } from '../src/index.js';
import { bhopEazy } from './fixtures.js';

function expectMomtvError(fn: () => unknown, code?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MomtvError);
    if (code) expect((error as MomtvError).code).toBe(code);
    return;
  }
  expect.fail('expected an MomtvError to be thrown');
}

describe('robustness', () => {
  it('rejects an empty buffer', () => {
    expectMomtvError(() => readHeader(new Uint8Array(0)), 'TRUNCATED');
  });

  it('rejects a wrong magic', () => {
    const data = bhopEazy().slice();
    data[0] = 0x58;
    expectMomtvError(() => readHeader(data), 'BAD_MAGIC');
  });

  it('rejects an unknown format version', () => {
    const data = bhopEazy().slice();
    data[4] = 99;
    expectMomtvError(() => readHeader(data), 'UNSUPPORTED_VERSION');
  });

  it('rejects a truncated header', () => {
    for (const len of [1, 4, 8, 100, 194]) {
      expectMomtvError(() => readHeader(bhopEazy().subarray(0, len)), 'TRUNCATED');
    }
  });

  it('rejects truncated splits', () => {
    expectMomtvError(() => readSplits(bhopEazy().subarray(0, 197)), 'TRUNCATED');
    expectMomtvError(() => readSplits(bhopEazy().subarray(0, 240)), 'TRUNCATED');
  });

  it('rejects splits with an implausible length', () => {
    const data = bhopEazy().slice();
    const view = new DataView(data.buffer, data.byteOffset);
    view.setInt32(195, -5, true);
    expectMomtvError(() => readSplits(data), 'BAD_SPLITS');
    view.setInt32(195, 0x7fffffff, true);
    expectMomtvError(() => readSplits(data), 'BAD_SPLITS');
  });

  it('rejects a truncated body', () => {
    const data = bhopEazy();
    const header = readHeader(data);
    const { bodyOffset } = readSplits(data);
    expectMomtvError(() => decompressBody(data.subarray(0, bodyOffset + 10), header, bodyOffset));
  });

  it('never hangs or crashes on random single byte flips', () => {
    const base = bhopEazy();
    // Deterministic pseudo-random flips so failures are reproducible.
    let seed = 0x12345678;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 50; i++) {
      const data = base.slice();
      const pos = rand() % data.length;
      data[pos] = rand() & 0xff;
      try {
        const header = readHeader(data);
        const { bodyOffset } = readSplits(data);
        decompressBody(data, header, bodyOffset);
      } catch (error) {
        expect(error).toBeInstanceOf(MomtvError);
      }
    }
  });
});
