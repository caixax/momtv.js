import { MtvError } from './error.js';

/**
 * LSB-first bit reader matching Source engine `bf_read` semantics, as used by
 * the bit-packed sections of the replay body.
 *
 * All reads are bounds checked and throw {@link MtvError} with code
 * `TRUNCATED` instead of reading past the end.
 */
export class BitReader {
  private readonly bytes: Uint8Array;
  /** Current position in bits from the start of the buffer. */
  bitPos: number;
  /** End of the readable range, in bits. */
  readonly bitLength: number;

  constructor(bytes: Uint8Array, startByte = 0, byteLength?: number) {
    this.bytes = bytes;
    this.bitPos = startByte * 8;
    this.bitLength = byteLength === undefined ? bytes.length * 8 : (startByte + byteLength) * 8;
  }

  /** Bits left before the end of the readable range. */
  get remainingBits(): number {
    return this.bitLength - this.bitPos;
  }

  private need(n: number): void {
    if (n < 0 || this.bitPos + n > this.bitLength) {
      throw new MtvError(
        'TRUNCATED',
        `Bit stream ended while reading ${n} bits at bit ${this.bitPos}`,
      );
    }
  }

  /** Reads a single bit. */
  readBit(): number {
    this.need(1);
    const byte = this.bytes[this.bitPos >> 3]!;
    const bit = (byte >> (this.bitPos & 7)) & 1;
    this.bitPos++;
    return bit;
  }

  /** Reads `n` bits (0 to 32) as an unsigned integer, LSB first. */
  readBits(n: number): number {
    this.need(n);
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.bitPos >> 3]!;
      value |= ((byte >> (this.bitPos & 7)) & 1) << i;
      this.bitPos++;
    }
    return value >>> 0;
  }

  /** Reads a 32-bit IEEE float. */
  readFloat32(): number {
    const raw = this.readBits(32);
    scratchView.setUint32(0, raw, true);
    return scratchView.getFloat32(0, true);
  }

  /**
   * Reads a Strata/CS:GO style UBitVar: 6 bits whose top 2 bits select a
   * 0, 4, 8 or 28 bit extension.
   */
  readUBitVar(): number {
    const six = this.readBits(6);
    switch (six & 48) {
      case 16:
        return ((six & 15) | (this.readBits(4) << 4)) >>> 0;
      case 32:
        return ((six & 15) | (this.readBits(8) << 4)) >>> 0;
      case 48:
        return ((six & 15) | (this.readBits(28) << 4)) >>> 0;
      default:
        return six;
    }
  }

  /** Aligns the position up to the next byte boundary. */
  alignByte(): void {
    this.bitPos = (this.bitPos + 7) & ~7;
  }
}

const scratchView = new DataView(new ArrayBuffer(4));
