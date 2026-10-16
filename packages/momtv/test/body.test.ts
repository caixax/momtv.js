import { describe, expect, it } from 'vitest';
import { decompressBody, readHeader, readSplits } from '../src/index.js';
import { bhopEazy } from './fixtures.js';

describe('decompressBody', () => {
  it('decompresses the sample body to the declared size', () => {
    const data = bhopEazy();
    const header = readHeader(data);
    const { bodyOffset } = readSplits(data);
    const body = decompressBody(data, header, bodyOffset);
    expect(body.length).toBe(156756);
  });
});
