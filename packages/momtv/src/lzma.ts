/*
LZMA decoder. TypeScript port of js-lzma for in-memory decompression with a
known output size, specialized for this package (typed arrays, bounds checks,
MomtvError on malformed streams).

Based on js-lzma by Juan Mellado, https://github.com/jcmellado/js-lzma

Copyright (c) 2011 Juan Mellado

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

References:
- "LZMA SDK" by Igor Pavlov, http://www.7-zip.org/sdk.html
- "The .lzma File Format" from the xz documentation
*/

import { MomtvError } from './error.js';

/** Decoded LZMA properties byte plus dictionary size. */
export interface LzmaProperties {
  lc: number;
  lp: number;
  pb: number;
  dictionarySize: number;
}

/** Decodes the standard 5 byte LZMA properties blob (1 props byte + u32 dict size). */
export function decodeLzmaProperties(props: Uint8Array): LzmaProperties {
  if (props.length < 5) {
    throw new MomtvError('BAD_LZMA', 'LZMA properties blob is shorter than 5 bytes');
  }
  let d = props[0]!;
  if (d >= 9 * 5 * 5) {
    throw new MomtvError('BAD_LZMA', `Invalid LZMA properties byte ${d}`);
  }
  const lc = d % 9;
  d = ~~(d / 9);
  const lp = d % 5;
  const pb = ~~(d / 5);
  const dictionarySize = (props[1]! | (props[2]! << 8) | (props[3]! << 16)) + props[4]! * 0x1000000;
  return { lc, lp, pb, dictionarySize };
}

function bad(message: string): never {
  throw new MomtvError('BAD_LZMA', message);
}

class RangeDecoder {
  private readonly src: Uint8Array;
  private pos: number;
  private code = 0;
  private range = -1;

  constructor(src: Uint8Array, pos: number) {
    this.src = src;
    this.pos = pos;
    for (let i = 0; i < 5; i++) this.code = (this.code << 8) | this.readByte();
  }

  private readByte(): number {
    if (this.pos >= this.src.length) bad('LZMA stream ended unexpectedly');
    return this.src[this.pos++]!;
  }

  decodeDirectBits(numTotalBits: number): number {
    let result = 0;
    for (let i = numTotalBits; i > 0; i--) {
      this.range >>>= 1;
      const t = (this.code - this.range) >>> 31;
      this.code -= this.range & (t - 1);
      result = (result << 1) | (1 - t);
      if ((this.range & 0xff000000) === 0) {
        this.code = (this.code << 8) | this.readByte();
        this.range <<= 8;
      }
    }
    return result;
  }

  decodeBit(probs: Uint16Array, index: number): number {
    const prob = probs[index]!;
    const newBound = (this.range >>> 11) * prob;
    if ((this.code ^ 0x80000000) < (newBound ^ 0x80000000)) {
      this.range = newBound;
      probs[index] = prob + ((2048 - prob) >>> 5);
      if ((this.range & 0xff000000) === 0) {
        this.code = (this.code << 8) | this.readByte();
        this.range <<= 8;
      }
      return 0;
    }
    this.range -= newBound;
    this.code -= newBound;
    probs[index] = prob - (prob >>> 5);
    if ((this.range & 0xff000000) === 0) {
      this.code = (this.code << 8) | this.readByte();
      this.range <<= 8;
    }
    return 1;
  }
}

function newProbs(len: number): Uint16Array {
  return new Uint16Array(len).fill(1024);
}

class BitTreeDecoder {
  readonly probs: Uint16Array;
  readonly numBitLevels: number;

  constructor(numBitLevels: number) {
    this.numBitLevels = numBitLevels;
    this.probs = newProbs(1 << numBitLevels);
  }

  decode(rc: RangeDecoder): number {
    let m = 1;
    for (let i = this.numBitLevels; i > 0; i--) m = (m << 1) | rc.decodeBit(this.probs, m);
    return m - (1 << this.numBitLevels);
  }

  reverseDecode(rc: RangeDecoder): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < this.numBitLevels; i++) {
      const bit = rc.decodeBit(this.probs, m);
      m = (m << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }
}

function reverseDecode(
  probs: Uint16Array,
  startIndex: number,
  rc: RangeDecoder,
  numBitLevels: number,
): number {
  let m = 1;
  let symbol = 0;
  for (let i = 0; i < numBitLevels; i++) {
    const bit = rc.decodeBit(probs, startIndex + m);
    m = (m << 1) | bit;
    symbol |= bit << i;
  }
  return symbol;
}

class LenDecoder {
  private readonly choice = newProbs(2);
  private readonly lowCoder: BitTreeDecoder[] = [];
  private readonly midCoder: BitTreeDecoder[] = [];
  private readonly highCoder = new BitTreeDecoder(8);

  constructor(numPosStates: number) {
    for (let i = 0; i < numPosStates; i++) {
      this.lowCoder.push(new BitTreeDecoder(3));
      this.midCoder.push(new BitTreeDecoder(3));
    }
  }

  decode(rc: RangeDecoder, posState: number): number {
    if (rc.decodeBit(this.choice, 0) === 0) return this.lowCoder[posState]!.decode(rc);
    if (rc.decodeBit(this.choice, 1) === 0) return 8 + this.midCoder[posState]!.decode(rc);
    return 16 + this.highCoder.decode(rc);
  }
}

class LiteralDecoder {
  private readonly coders: Uint16Array[] = [];
  private readonly numPrevBits: number;
  private readonly posMask: number;

  constructor(numPosBits: number, numPrevBits: number) {
    this.numPrevBits = numPrevBits;
    this.posMask = (1 << numPosBits) - 1;
    const n = 1 << (numPrevBits + numPosBits);
    for (let i = 0; i < n; i++) this.coders.push(newProbs(0x300));
  }

  private getCoder(pos: number, prevByte: number): Uint16Array {
    return this.coders[
      ((pos & this.posMask) << this.numPrevBits) + ((prevByte & 0xff) >>> (8 - this.numPrevBits))
    ]!;
  }

  decodeNormal(rc: RangeDecoder, pos: number, prevByte: number): number {
    const probs = this.getCoder(pos, prevByte);
    let symbol = 1;
    do {
      symbol = (symbol << 1) | rc.decodeBit(probs, symbol);
    } while (symbol < 0x100);
    return symbol & 0xff;
  }

  decodeWithMatchByte(rc: RangeDecoder, pos: number, prevByte: number, matchByte: number): number {
    const probs = this.getCoder(pos, prevByte);
    let symbol = 1;
    do {
      const matchBit = (matchByte >> 7) & 1;
      matchByte <<= 1;
      const bit = rc.decodeBit(probs, ((1 + matchBit) << 8) + symbol);
      symbol = (symbol << 1) | bit;
      if (matchBit !== bit) {
        while (symbol < 0x100) symbol = (symbol << 1) | rc.decodeBit(probs, symbol);
        break;
      }
    } while (symbol < 0x100);
    return symbol & 0xff;
  }
}

/**
 * Decompresses a raw LZMA stream (no container framing) into a new buffer of
 * exactly `outSize` bytes.
 *
 * @param props the 5 byte LZMA properties blob.
 * @param src the compressed bytes, starting right after the properties.
 * @param outSize the exact decompressed size.
 * @throws {MomtvError} `BAD_LZMA` on any malformed stream.
 */
export function lzmaDecompress(props: Uint8Array, src: Uint8Array, outSize: number): Uint8Array {
  const { lc, lp, pb, dictionarySize } = decodeLzmaProperties(props);
  if (lc > 8 || lp > 4 || pb > 4) bad(`Invalid LZMA lc/lp/pb: ${lc}/${lp}/${pb}`);
  if (dictionarySize < 0) bad('Invalid LZMA dictionary size');
  if (outSize < 0) bad(`Invalid output size ${outSize}`);

  const out = new Uint8Array(outSize);
  // The output buffer doubles as the LZMA dictionary window: with a known
  // output size there is no need for the circular streaming window, because
  // match distances are validated against the bytes already produced.
  const dictionarySizeCheck = Math.max(dictionarySize, 1);

  const rc = new RangeDecoder(src, 0);
  const literalDecoder = new LiteralDecoder(lp, lc);
  const lenDecoder = new LenDecoder(1 << pb);
  const repLenDecoder = new LenDecoder(1 << pb);
  const posSlotDecoder = [
    new BitTreeDecoder(6),
    new BitTreeDecoder(6),
    new BitTreeDecoder(6),
    new BitTreeDecoder(6),
  ];
  const posAlignDecoder = new BitTreeDecoder(4);
  const isMatch = newProbs(192);
  const isRep0Long = newProbs(192);
  const isRep = newProbs(12);
  const isRepG0 = newProbs(12);
  const isRepG1 = newProbs(12);
  const isRepG2 = newProbs(12);
  const posDecoders = newProbs(114);
  const posStateMask = (1 << pb) - 1;

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let outPos = 0;
  let prevByte = 0;

  while (outPos < outSize) {
    const posState = outPos & posStateMask;

    if (rc.decodeBit(isMatch, (state << 4) + posState) === 0) {
      if (state >= 7) {
        prevByte = literalDecoder.decodeWithMatchByte(
          rc,
          outPos,
          prevByte,
          out[outPos - rep0 - 1]!,
        );
      } else {
        prevByte = literalDecoder.decodeNormal(rc, outPos, prevByte);
      }
      out[outPos++] = prevByte;
      state = state < 4 ? 0 : state - (state < 10 ? 3 : 6);
      continue;
    }

    let len: number;
    if (rc.decodeBit(isRep, state) === 1) {
      len = 0;
      if (rc.decodeBit(isRepG0, state) === 0) {
        if (rc.decodeBit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          len = 1;
        }
      } else {
        let distance: number;
        if (rc.decodeBit(isRepG1, state) === 0) {
          distance = rep1;
        } else {
          if (rc.decodeBit(isRepG2, state) === 0) {
            distance = rep2;
          } else {
            distance = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = distance;
      }
      if (len === 0) {
        len = 2 + repLenDecoder.decode(rc, posState);
        state = state < 7 ? 8 : 11;
      }
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = 2 + lenDecoder.decode(rc, posState);
      state = state < 7 ? 7 : 10;

      const posSlot = posSlotDecoder[len <= 5 ? len - 2 : 3]!.decode(rc);
      if (posSlot >= 4) {
        const numDirectBits = (posSlot >> 1) - 1;
        rep0 = (2 | (posSlot & 1)) << numDirectBits;
        if (posSlot < 14) {
          rep0 += reverseDecode(posDecoders, rep0 - posSlot - 1, rc, numDirectBits);
        } else {
          rep0 += rc.decodeDirectBits(numDirectBits - 4) << 4;
          rep0 += posAlignDecoder.reverseDecode(rc);
          if (rep0 < 0) {
            if (rep0 === -1) break; // end of stream marker
            bad('Invalid LZMA match distance');
          }
        }
      } else {
        rep0 = posSlot;
      }
    }

    if (rep0 >= outPos || rep0 >= dictionarySizeCheck) {
      bad('LZMA match distance points before the start of the output');
    }
    if (outPos + len > outSize) {
      bad('LZMA stream produces more data than the declared output size');
    }

    let srcPos = outPos - rep0 - 1;
    for (let i = 0; i < len; i++) out[outPos++] = out[srcPos++]!;
    prevByte = out[outPos - 1]!;
  }

  return out;
}
