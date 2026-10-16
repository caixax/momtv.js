import type { BitReader } from './bit-reader.js';
import { MtvError } from './error.js';
import { CLASS_PROPS, FALLBACK_PROPS, SHARED_PROPS, UNNAMED_ARRAYS } from './prop-table.js';

/**
 * How one entity property is encoded on the wire.
 *
 * Field names are short because the generated table is shipped to browsers:
 * `k` kind, `b` bits, `f` flags, `c` bits holding an array's element count,
 * `m` an array's maximum elements, `e` an array's element encoding, `s` the
 * number of properties per element when an array holds structures.
 */
export interface PropEncoding {
  k: 'int' | 'float' | 'vector' | 'vectorxy' | 'string' | 'array';
  b: number;
  f?: string[];
  c?: number;
  m?: number;
  e?: PropEncoding;
  s?: number;
}

/** Fractional bits a coordinate carries. */
const COORD_FRACTIONAL_BITS = 5;
/** Integer bits a coordinate carries. */
const COORD_INTEGER_BITS = 14;
/** Resolution of one fractional step. */
const COORD_RESOLUTION = 1 / (1 << COORD_FRACTIONAL_BITS);
/** Bits holding a string's length. */
const STRING_LENGTH_BITS = 9;
/** Bits a normalised component carries, including its sign. */
const NORMAL_BITS = 12;
/** Resolution of one normal step. */
const NORMAL_RESOLUTION = 1 / ((1 << (NORMAL_BITS - 1)) - 1);

const has = (encoding: PropEncoding, flag: string): boolean => encoding.f?.includes(flag) ?? false;

/** Reads a coordinate written with the engine's variable length encoding. */
function readCoord(r: BitReader): number {
  const hasInteger = r.readBit();
  const hasFraction = r.readBit();
  if (!hasInteger && !hasFraction) return 0;
  const negative = r.readBit();
  const integer = hasInteger ? r.readBits(COORD_INTEGER_BITS) + 1 : 0;
  const fraction = hasFraction ? r.readBits(COORD_FRACTIONAL_BITS) : 0;
  const value = integer + fraction * COORD_RESOLUTION;
  return negative ? -value : value;
}

/** Reads a coordinate relative to its cell, as entity origins use. */
function readCellCoord(r: BitReader, bits: number, integral: boolean): number {
  const integer = r.readBits(bits);
  if (integral) return integer;
  return integer + r.readBits(COORD_FRACTIONAL_BITS) * COORD_RESOLUTION;
}

/** Reads a normalised component: a sign and a fraction. */
function readNormal(r: BitReader): number {
  const negative = r.readBit();
  const value = r.readBits(NORMAL_BITS - 1) * NORMAL_RESOLUTION;
  return negative ? -value : value;
}

/**
 * Reads one float, following the same order of precedence the engine uses: a
 * coordinate first, then an unscaled 32 bit float, then a normal, then a cell
 * coordinate, and a quantised value otherwise.
 */
function readFloat(r: BitReader, encoding: PropEncoding): number {
  if (has(encoding, 'COORD')) return readCoord(r);
  if (has(encoding, 'NOSCALE') || encoding.b === 0 || encoding.b === 32) return r.readFloat32();
  if (has(encoding, 'NORMAL')) return readNormal(r);
  if (has(encoding, 'CELL_COORD')) return readCellCoord(r, encoding.b, false);
  // Quantised: the value spans a range the table does not record, so the raw
  // quantised integer is returned. Callers that need the real value scale it.
  return r.readBits(encoding.b);
}

/** A decoded property value. */
export type PropValue = number | number[] | string;

/**
 * Reads one property value, advancing the reader by exactly its width.
 *
 * @throws MtvError when the encoding describes something this parser cannot
 * size, so a frame is never silently misread.
 */
export function readPropValue(r: BitReader, encoding: PropEncoding): PropValue {
  switch (encoding.k) {
    case 'int':
      // Only the width matters for walking the stream; a signed value is
      // returned sign extended.
      if (has(encoding, 'UNSIGNED')) return r.readBits(encoding.b || 32);
      return (
        (r.readBits(encoding.b || 32) << (32 - (encoding.b || 32))) >> (32 - (encoding.b || 32))
      );
    case 'float':
      return readFloat(r, encoding);
    case 'vector': {
      const x = readFloat(r, encoding);
      const y = readFloat(r, encoding);
      if (has(encoding, 'NORMAL')) {
        // The third component is derived from the other two, so only its sign
        // travels on the wire.
        const negative = r.readBit();
        const square = 1 - x * x - y * y;
        const z = square > 0 ? Math.sqrt(square) : 0;
        return [x, y, negative ? -z : z];
      }
      return [x, y, readFloat(r, encoding)];
    }
    case 'vectorxy':
      return [readFloat(r, encoding), readFloat(r, encoding)];
    case 'string': {
      const length = r.readBits(STRING_LENGTH_BITS);
      let text = '';
      for (let i = 0; i < length; i++) text += String.fromCharCode(r.readBits(8));
      return text;
    }
    case 'array': {
      if (!encoding.e || encoding.c === undefined) {
        throw new MtvError('BAD_BODY', 'array property with no element encoding');
      }
      if (encoding.s !== undefined && encoding.s > 1) {
        throw new MtvError('BAD_BODY', 'array of structures is not supported yet');
      }
      const count = r.readBits(encoding.c);
      if (encoding.m !== undefined && count > encoding.m) {
        throw new MtvError('BAD_BODY', `array holds ${count} elements, more than ${encoding.m}`);
      }
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        const value = readPropValue(r, encoding.e);
        if (typeof value === 'number') values.push(value);
        else if (Array.isArray(value)) values.push(...value);
      }
      return values;
    }
  }
}

/**
 * Resolves the encodings of the properties a class records, in the order the
 * replay lists them.
 *
 * Properties are matched by name. The game's tables flatten arrays and lose
 * their names along the way, so any name left unresolved is matched against
 * that class's arrays in order, which is how they line up.
 *
 * @throws MtvError when a property cannot be resolved, rather than guessing a
 * width and corrupting everything that follows.
 */
export function resolveClassProps(className: string, props: readonly string[]): PropEncoding[] {
  const own = CLASS_PROPS[className] ?? {};
  const arrays = UNNAMED_ARRAYS[className] ?? [];
  let nextArray = 0;
  return props.map((name) => {
    const found = own[name] ?? SHARED_PROPS[name] ?? FALLBACK_PROPS[name];
    if (found) return found;
    const array = arrays[nextArray++];
    if (array) return array;
    throw new MtvError('BAD_BODY', `no known encoding for ${className}::${name}`);
  });
}
