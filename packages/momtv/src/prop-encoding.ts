import type { BitReader } from './bit-reader.js';
import { MomtvError } from './error.js';
import { CLASS_PROPS, FALLBACK_PROPS, SHARED_PROPS, UNNAMED_ARRAYS } from './prop-table.js';

/**
 * How one entity property is encoded on the wire.
 *
 * Field names are short because the generated table is shipped to browsers:
 * `k` kind, `b` bits, `f` flags, `c` bits holding an array's element count,
 * `m` an array's maximum elements, `e` an array's element encoding, `s` the
 * number of properties per element when an array holds structures, `a` set
 * when an array is one network Array property rather than one property per
 * element, `l` set when the array is a vector whose length travels as its
 * first property.
 */
export interface PropEncoding {
  k: 'int' | 'int64' | 'float' | 'vector' | 'vectorxy' | 'string' | 'array';
  b: number;
  f?: string[];
  c?: number;
  m?: number;
  e?: PropEncoding;
  s?: number;
  a?: 1;
  l?: 1;
}

/** Fractional bits a coordinate carries. */
const COORD_FRACTIONAL_BITS = 5;
/** Fractional bits of a low precision coordinate. */
const COORD_FRACTIONAL_BITS_LOW = 3;
/**
 * Integer bits a coordinate carries. Strata Source widens the world to 65536
 * units either way, two more bits than the 16384 of older engines, and its
 * coordinate readers widen with it.
 */
const COORD_INTEGER_BITS = 16;
/** Integer bits of a multiplayer coordinate inside the map bounds. */
const COORD_INTEGER_BITS_MP = 13;
/** Resolution of one fractional step. */
const COORD_RESOLUTION = 1 / (1 << COORD_FRACTIONAL_BITS);
/** Resolution of one low precision fractional step. */
const COORD_RESOLUTION_LOW = 1 / (1 << COORD_FRACTIONAL_BITS_LOW);
/** Bits holding a string's length. */
const STRING_LENGTH_BITS = 9;
/** Bits a normalised component carries, including its sign. */
const NORMAL_BITS = 12;
/** Resolution of one normal step. */
const NORMAL_RESOLUTION = 1 / ((1 << (NORMAL_BITS - 1)) - 1);

/**
 * Properties an older build spelled differently. The encoding is the same; the
 * name in the replay's class table is what changed.
 */
const RENAMED: Record<string, string> = {
  m_iViewModelIndex: 'm_nViewModelIndex',
};

/**
 * Projectiles send their rotation as three 6 bit angles rather than the 13
 * bits every other entity uses: their server table, DT_MomExplosive, excludes
 * the base entity's rotation and declares its own.
 */
const EXPLOSIVE_PROPS: Record<string, PropEncoding> = {
  m_angRotation: { k: 'vector', b: 6, f: ['CHANGES_OFTEN'] },
};

/**
 * Classes the recorder follows that the table dumps do not include, with the
 * encodings their server classes declare.
 */
const UNDUMPED_PROPS: Record<string, Record<string, PropEncoding>> = {
  CMomRocket: EXPLOSIVE_PROPS,
  CMomDFRocket: EXPLOSIVE_PROPS,
  CMomDFBFGRocket: EXPLOSIVE_PROPS,
  CMomDFPlasma: EXPLOSIVE_PROPS,
  CMomDFGrenade: EXPLOSIVE_PROPS,
  CMomStickybomb: EXPLOSIVE_PROPS,
  CMomConcProjectile: EXPLOSIVE_PROPS,
  // DT_FuncRotating replaces the base entity's cell coded origin with a plain
  // coordinate, so a rotating brush's origin is absolute.
  CFuncRotating: {
    m_vecOrigin: { k: 'vector', b: 0, f: ['COORD', 'CHANGES_OFTEN'] },
  },
  CSpriteTrail: {
    m_flLifeTime: { k: 'float', b: 0, f: ['NOSCALE'] },
    m_flStartWidth: { k: 'float', b: 0, f: ['NOSCALE'] },
    m_flEndWidth: { k: 'float', b: 0, f: ['NOSCALE'] },
  },
  CFuncMoveLinear: {
    m_strSoundStart: { k: 'string', b: 0 },
    m_strSoundStop: { k: 'string', b: 0 },
  },
};

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

/** Precision variants shared by multiplayer and cell coordinates. */
type CoordKind = 'full' | 'low' | 'integral';

/** Reads a multiplayer coordinate, which spends fewer bits inside the map. */
function readCoordMp(r: BitReader, kind: CoordKind): number {
  const inBounds = r.readBit();
  const integerBits = inBounds ? COORD_INTEGER_BITS_MP : COORD_INTEGER_BITS;
  if (kind === 'integral') {
    if (!r.readBit()) return 0;
    const negative = r.readBit();
    const value = r.readBits(integerBits) + 1;
    return negative ? -value : value;
  }
  const hasInteger = r.readBit();
  const negative = r.readBit();
  const integer = hasInteger ? r.readBits(integerBits) + 1 : 0;
  const value =
    kind === 'low'
      ? integer + r.readBits(COORD_FRACTIONAL_BITS_LOW) * COORD_RESOLUTION_LOW
      : integer + r.readBits(COORD_FRACTIONAL_BITS) * COORD_RESOLUTION;
  return negative ? -value : value;
}

/** Reads a coordinate relative to its cell, as entity origins use. */
function readCellCoord(r: BitReader, bits: number, kind: CoordKind): number {
  const integer = r.readBits(bits);
  if (kind === 'integral') return integer;
  if (kind === 'low') {
    return integer + r.readBits(COORD_FRACTIONAL_BITS_LOW) * COORD_RESOLUTION_LOW;
  }
  return integer + r.readBits(COORD_FRACTIONAL_BITS) * COORD_RESOLUTION;
}

/** Reads a normalised component: a sign and a fraction. */
function readNormal(r: BitReader): number {
  const negative = r.readBit();
  const value = r.readBits(NORMAL_BITS - 1) * NORMAL_RESOLUTION;
  return negative ? -value : value;
}

/**
 * Reads one float, following the same order of precedence the engine's
 * decoder uses: a coordinate first, then the multiplayer coordinates, an
 * unscaled 32 bit float, a normal, the cell coordinates, and a quantised value
 * otherwise.
 */
function readFloat(r: BitReader, encoding: PropEncoding): number {
  if (has(encoding, 'COORD')) return readCoord(r);
  if (has(encoding, 'COORD_MP')) return readCoordMp(r, 'full');
  if (has(encoding, 'COORD_MP_LOWPRECISION')) return readCoordMp(r, 'low');
  if (has(encoding, 'COORD_MP_INTEGRAL')) return readCoordMp(r, 'integral');
  if (has(encoding, 'NOSCALE') || encoding.b === 0 || encoding.b === 32) return r.readFloat32();
  if (has(encoding, 'NORMAL')) return readNormal(r);
  if (has(encoding, 'CELL_COORD')) return readCellCoord(r, encoding.b, 'full');
  if (has(encoding, 'CELL_COORD_LOWPRECISION')) return readCellCoord(r, encoding.b, 'low');
  if (has(encoding, 'CELL_COORD_INTEGRAL')) return readCellCoord(r, encoding.b, 'integral');
  // Quantised: the value spans a range the table does not record, so the raw
  // quantised integer is returned. Callers that need the real value scale it.
  return r.readBits(encoding.b);
}

/** A decoded property value. */
export type PropValue = number | number[] | string;

/**
 * Reads one property value, advancing the reader by exactly its width.
 *
 * @throws MomtvError when the encoding describes something this parser cannot
 * size, so a frame is never silently misread.
 */
export function readPropValue(r: BitReader, encoding: PropEncoding): PropValue {
  switch (encoding.k) {
    case 'int': {
      if (has(encoding, 'VARINT')) {
        const raw = r.readVarInt32();
        // Signed varints are zigzag encoded.
        return has(encoding, 'UNSIGNED') ? raw : (raw >>> 1) ^ -(raw & 1);
      }
      // A signed value is returned sign extended.
      const bits = encoding.b || 32;
      if (has(encoding, 'UNSIGNED')) return r.readBits(bits);
      return (r.readBits(bits) << (32 - bits)) >> (32 - bits);
    }
    case 'int64':
      return readInt64(r, encoding);
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
        throw new MomtvError('BAD_BODY', 'array property with no element encoding');
      }
      if (encoding.s !== undefined && encoding.s > 1) {
        throw new MomtvError('BAD_BODY', 'array of structures is not supported yet');
      }
      const count = r.readBits(encoding.c);
      if (encoding.m !== undefined && count > encoding.m) {
        throw new MomtvError('BAD_BODY', `array holds ${count} elements, more than ${encoding.m}`);
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
 * Reads a 64 bit integer. A signed one carries its sign first and then its
 * magnitude in the remaining bits, low word first. The value comes back as a
 * number, which is exact up to 2^53.
 */
function readInt64(r: BitReader, encoding: PropEncoding): number {
  const unsigned = has(encoding, 'UNSIGNED');
  if (has(encoding, 'VARINT')) {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const byte = r.readBits(8);
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if ((byte & 0x80) === 0) break;
    }
    if (unsigned) return value;
    // zigzag
    return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
  }
  const negative = unsigned ? 0 : r.readBit();
  const bits = (encoding.b || 64) - (unsigned ? 0 : 1);
  const low = r.readBits(Math.min(32, bits));
  const high = bits > 32 ? r.readBits(bits - 32) : 0;
  const value = high * 2 ** 32 + low;
  return negative ? -value : value;
}

/**
 * Resolves the encodings of the properties a class records, in the order the
 * replay lists them.
 *
 * Properties are matched by name. The game's tables flatten arrays and lose
 * their names along the way, so any name left unresolved is matched against
 * that class's arrays in order, which is how they line up.
 *
 * @throws MomtvError when a property cannot be resolved, rather than guessing a
 * width and corrupting everything that follows.
 */
export function resolveClassProps(className: string, props: readonly string[]): PropEncoding[] {
  const own = { ...UNDUMPED_PROPS[className], ...CLASS_PROPS[className] };
  const arrays = UNNAMED_ARRAYS[className] ?? [];
  let nextArray = 0;
  const lookUp = (name: string): PropEncoding | undefined =>
    own[name] ?? SHARED_PROPS[name] ?? FALLBACK_PROPS[name];
  return props.map((name) => {
    const direct = lookUp(name) ?? lookUp(RENAMED[name] ?? '');
    if (direct) return direct;
    // A name like m_angRotation[0] is one component of a vector, which the
    // tables describe as a whole.
    const element = /^(.+)\[\d+\]$/.exec(name);
    if (element) {
      const whole = lookUp(element[1]!) ?? lookUp(RENAMED[element[1]!] ?? '');
      if (whole && (whole.k === 'vector' || whole.k === 'vectorxy')) {
        const component: PropEncoding = { k: 'float', b: whole.b };
        if (whole.f) component.f = whole.f;
        return component;
      }
    }
    // The arrays the tables leave unnamed are vectors, whose length the
    // tables flatten into a property of its own, ahead of the elements.
    const array = arrays[nextArray++];
    if (array) return { ...array, l: 1 };
    throw new MomtvError('BAD_BODY', `no known encoding for ${className}::${name}`);
  });
}
