import { MtvError } from './error.js';

/**
 * Bounds-checked little endian cursor over a byte buffer.
 *
 * Every read advances the cursor and throws {@link MtvError} with code
 * `TRUNCATED` instead of reading out of bounds, so parsers built on it can
 * never crash or read garbage on short input.
 */
export class ByteReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  /** Current read position, relative to the start of this reader. */
  pos = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) {
      this.bytes = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.bytes = new Uint8Array(data);
      this.view = new DataView(data);
    }
  }

  /** Total length in bytes. */
  get length(): number {
    return this.bytes.length;
  }

  /** Bytes left after the cursor. */
  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  /** Throws TRUNCATED unless `n` more bytes are available. */
  need(n: number, what: string): void {
    if (n < 0 || this.pos + n > this.bytes.length) {
      throw new MtvError(
        'TRUNCATED',
        `Unexpected end of data reading ${what} at offset ${this.pos} ` +
          `(need ${n} bytes, have ${this.bytes.length - this.pos})`,
      );
    }
  }

  u8(what = 'uint8'): number {
    this.need(1, what);
    return this.view.getUint8(this.pos++);
  }

  i8(what = 'int8'): number {
    this.need(1, what);
    return this.view.getInt8(this.pos++);
  }

  u16(what = 'uint16'): number {
    this.need(2, what);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(what = 'int16'): number {
    this.need(2, what);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(what = 'uint32'): number {
    this.need(4, what);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(what = 'int32'): number {
    this.need(4, what);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u64(what = 'uint64'): bigint {
    this.need(8, what);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  i64(what = 'int64'): bigint {
    this.need(8, what);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }

  f32(what = 'float32'): number {
    this.need(4, what);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(what = 'float64'): number {
    this.need(8, what);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** Reads `n` raw bytes as a subarray view (no copy). */
  raw(n: number, what = 'bytes'): Uint8Array {
    this.need(n, what);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /**
   * Reads a fixed-size field containing a NUL terminated UTF-8 string.
   * The cursor always advances exactly `size` bytes.
   */
  fixedString(size: number, what = 'string'): string {
    const field = this.raw(size, what);
    let end = field.indexOf(0);
    if (end === -1) end = size;
    return utf8Decoder.decode(field.subarray(0, end));
  }

  /**
   * Reads a NUL terminated UTF-8 string of unknown length, consuming the
   * terminator. `maxLength` bounds the scan so corrupt input cannot make the
   * parser walk the whole buffer.
   */
  cString(maxLength = 4096, what = 'string'): string {
    const limit = Math.min(this.bytes.length, this.pos + maxLength + 1);
    let end = this.pos;
    while (end < limit && this.bytes[end] !== 0) end++;
    if (end >= limit) {
      if (end >= this.bytes.length) {
        throw new MtvError(
          'TRUNCATED',
          `Unterminated string reading ${what} at offset ${this.pos}`,
        );
      }
      throw new MtvError(
        'LIMIT_EXCEEDED',
        `String longer than ${maxLength} bytes reading ${what} at offset ${this.pos}`,
      );
    }
    const s = utf8Decoder.decode(this.bytes.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }

  /** Moves the cursor to an absolute offset (bounds-checked). */
  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.length) {
      throw new MtvError('TRUNCATED', `Seek to ${offset} is outside the buffer`);
    }
    this.pos = offset;
  }

  /** Advances the cursor by `n` bytes (bounds-checked). */
  skip(n: number, what = 'padding'): void {
    this.need(n, what);
    this.pos += n;
  }
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/** Normalizes public API input to a Uint8Array without copying. */
export function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}
