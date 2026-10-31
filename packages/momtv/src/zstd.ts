/**
 * Zstandard decompressor, decode only.
 *
 * Strata Source stores the image data of a VTF compressed, one chunk per mip
 * level, and the compressor it uses is Zstandard. Browsers do not offer a
 * Zstandard decompressor through any stable API, so this is the format's own
 * decoder: frame and block headers, Huffman coded literals and FSE coded
 * sequences, as described by RFC 8878. Dictionaries are not supported, since
 * nothing in a game file uses them.
 *
 * Written from the specification, with no code taken from any implementation.
 */

const FRAME_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC = 0x184d2a50;
const SKIPPABLE_MASK = 0xfffffff0;

/** Literals section encodings. */
const LITERALS_RAW = 0;
const LITERALS_RLE = 1;
const LITERALS_HUFFMAN = 2;
/** Literals coded with the Huffman table of an earlier block. */
const LITERALS_REUSE = 3;

/** Block types. */
const BLOCK_RAW = 0;
const BLOCK_RLE = 1;
const BLOCK_COMPRESSED = 2;

/** How a symbol table for one sequence field is coded. */
const MODE_PREDEFINED = 0;
const MODE_RLE = 1;
const MODE_FSE = 2;
const MODE_REPEAT = 3;

const MAX_LITERAL_SYMBOL = 255;
const MAX_HUFFMAN_BITS = 11;
const MAX_LITERALS_LENGTH_SYMBOL = 35;
const MAX_MATCH_LENGTH_SYMBOL = 52;
const MAX_OFFSET_SYMBOL = 31;

const LITERALS_LENGTH_BASE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128,
  256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
];
const LITERALS_LENGTH_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16,
];
const MATCH_LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051,
  4099, 8195, 16387, 32771, 65539,
];
const MATCH_LENGTH_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];

/** Distributions the format fixes, used when a table is not sent. */
const PREDEFINED_LITERALS_LENGTH = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
  -1, -1, -1, -1,
];
const PREDEFINED_MATCH_LENGTH = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
];
const PREDEFINED_OFFSET = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
];

/** Mask of the low `n` bits. */
function mask(n: number): number {
  return n >= 32 ? 0xffffffff : (1 << n) - 1;
}

/** Index of the highest set bit. */
function highestBit(value: number): number {
  return 31 - Math.clz32(value);
}

/**
 * Reads a bit stream backwards, which is how the format writes the streams
 * that Huffman and FSE decoding consume: from the last byte towards the first,
 * most significant bit first, after a padding marker in the final byte.
 *
 * Reads past the end return zeros, as the specification's encoders rely on.
 */
class BackwardBits {
  private readonly data: Uint8Array;
  private readonly view: DataView;
  /** Bits taken, counted from the last byte's most significant bit. */
  private at: number;
  private readonly total: number;

  constructor(data: Uint8Array) {
    if (data.length === 0) throw new Error('zstd bit stream is empty');
    const last = data[data.length - 1]!;
    if (last === 0) throw new Error('zstd bit stream has no end marker');
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.total = data.length * 8;
    // The final byte ends with a one bit marking where the data stops.
    this.at = Math.clz32(last) - 24 + 1;
  }

  /** Looks at the next `n` bits, up to 16, without consuming them. */
  peek(n: number): number {
    if (n === 0) return 0;
    const index = this.data.length - 1 - (this.at >> 3);
    const skew = this.at & 7;
    // Four bytes read in stream order, the current one most significant. Past
    // either end the window is zero, which is what the format's padding is.
    let window: number;
    if (index >= 3 && index < this.data.length) {
      window = this.view.getUint32(index - 3, true);
    } else {
      window = 0;
      for (let i = 0; i < 4; i++) {
        const j = index - i;
        const byte = j >= 0 && j < this.data.length ? this.data[j]! : 0;
        window = (window | (byte << (24 - i * 8))) >>> 0;
      }
    }
    return (window >>> (32 - skew - n)) & mask(n);
  }

  /** Drops `n` bits. */
  skip(n: number): void {
    this.at += n;
  }

  read(n: number): number {
    if (n <= 16) {
      const value = this.peek(n);
      this.at += n;
      return value;
    }
    // Wider fields are read in two parts, so the window never has to hold
    // more than 16 bits plus its skew.
    const high = this.read(n - 16);
    return high * 0x10000 + this.read(16);
  }

  /**
   * True once a read has asked for bits the stream does not have, which is how
   * the format marks the end of a stream whose symbol count is not sent.
   */
  get overflowed(): boolean {
    return this.at > this.total;
  }
}

/** Reads a bit stream forwards, least significant bit first. */
class ForwardBits {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  read(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const at = this.pos + i;
      const byte = at >> 3 < this.data.length ? this.data[at >> 3]! : 0;
      value |= ((byte >> (at & 7)) & 1) << i;
    }
    this.pos += n;
    return value;
  }

  /** Bytes the reader has touched, rounded up. */
  get bytesUsed(): number {
    return (this.pos + 7) >> 3;
  }
}

/** A decoding table for one FSE coded field. */
interface FseTable {
  log: number;
  symbol: Uint8Array;
  bits: Uint8Array;
  base: Uint16Array;
}

/** Builds the decoding table of a distribution, as the format prescribes. */
function buildFseTable(counts: readonly number[], log: number): FseTable {
  const size = 1 << log;
  const symbol = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const base = new Uint16Array(size);
  const next = new Int32Array(counts.length);

  // Symbols with a probability of less than one sit at the end of the table.
  let lowest = size - 1;
  for (let s = 0; s < counts.length; s++) {
    if (counts[s]! === -1) {
      symbol[lowest--] = s;
      next[s] = 1;
    } else {
      next[s] = counts[s]!;
    }
  }

  // The rest are spread with a stride that visits every slot exactly once.
  const step = (size >> 1) + (size >> 3) + 3;
  const wrap = size - 1;
  let at = 0;
  for (let s = 0; s < counts.length; s++) {
    const count = counts[s]!;
    if (count <= 0) continue;
    for (let i = 0; i < count; i++) {
      symbol[at] = s;
      at = (at + step) & wrap;
      while (at > lowest) at = (at + step) & wrap;
    }
  }
  if (at !== 0) throw new Error('zstd distribution does not fill its table');

  for (let i = 0; i < size; i++) {
    const s = symbol[i]!;
    const state = next[s]!++;
    const width = log - highestBit(state);
    bits[i] = width;
    base[i] = (state << width) - size;
  }
  return { log, symbol, bits, base };
}

/** Reads a distribution and builds its table. Returns the bytes it used. */
function readFseTable(
  src: Uint8Array,
  maxSymbol: number,
  maxLog: number,
): { table: FseTable; used: number } {
  const reader = new ForwardBits(src);
  const log = reader.read(4) + 5;
  if (log > maxLog) throw new Error(`zstd table asks for ${log} bits of accuracy`);
  const size = 1 << log;

  const counts: number[] = [];
  let remaining = size + 1;
  let threshold = size;
  let width = log + 1;
  let zeros = false;
  while (remaining > 1 && counts.length <= maxSymbol) {
    if (zeros) {
      // Runs of unused symbols are sent as pairs of bits, 3 meaning 'more'.
      let skip = 0;
      for (;;) {
        const pair = reader.read(2);
        skip += pair;
        if (pair !== 3) break;
      }
      for (let i = 0; i < skip; i++) counts.push(0);
      zeros = false;
      continue;
    }
    const limit = 2 * threshold - 1 - remaining;
    const low = reader.read(width - 1);
    let count: number;
    if (low < limit) {
      count = low;
    } else {
      count = low | (reader.read(1) << (width - 1));
      if (count >= threshold) count -= limit;
    }
    count -= 1; // a sent value of zero means a probability of less than one
    remaining -= count < 0 ? -count : count;
    counts.push(count);
    zeros = count === 0;
    while (remaining < threshold) {
      width--;
      threshold >>= 1;
    }
  }
  if (remaining !== 1) throw new Error('zstd distribution does not add up');
  while (counts.length <= maxSymbol) counts.push(0);
  return { table: buildFseTable(counts, log), used: reader.bytesUsed };
}

/** A Huffman decoding table, indexed by the next {@link bits} bits. */
interface HuffmanTable {
  bits: number;
  symbol: Uint8Array;
  width: Uint8Array;
}

/** Builds a Huffman table from the weights the format sends. */
function buildHuffman(weights: Uint8Array, count: number): HuffmanTable {
  let total = 0;
  let maxWeight = 0;
  for (let i = 0; i < count; i++) {
    const w = weights[i]!;
    if (w > 0) total += 1 << (w - 1);
    if (w > maxWeight) maxWeight = w;
  }
  if (total === 0) throw new Error('zstd Huffman table is empty');
  const tableBits = highestBit(total) + 1;
  if (tableBits > MAX_HUFFMAN_BITS) throw new Error(`zstd Huffman table needs ${tableBits} bits`);
  // The last symbol takes whatever weight makes the table complete.
  const rest = (1 << tableBits) - total;
  if (rest === 0 || (rest & (rest - 1)) !== 0) {
    throw new Error('zstd Huffman weights do not complete a table');
  }
  const full = new Uint8Array(count + 1);
  full.set(weights.subarray(0, count));
  full[count] = highestBit(rest) + 1;
  const symbols = count + 1;
  if (full[count]! > maxWeight) maxWeight = full[count]!;

  // Shorter codes are written after longer ones, grouped by weight.
  const perWeight = new Uint32Array(maxWeight + 2);
  for (let s = 0; s < symbols; s++) {
    const w = full[s]!;
    if (w > 0) perWeight[w]!++;
  }
  const start = new Uint32Array(maxWeight + 2);
  let at = 0;
  for (let w = 1; w <= maxWeight; w++) {
    start[w] = at;
    at += perWeight[w]! << (w - 1);
  }

  const size = 1 << tableBits;
  const symbol = new Uint8Array(size);
  const width = new Uint8Array(size);
  for (let s = 0; s < symbols; s++) {
    const w = full[s]!;
    if (w === 0) continue;
    const span = 1 << (w - 1);
    const codeBits = tableBits + 1 - w;
    const from = start[w]!;
    for (let i = from; i < from + span; i++) {
      symbol[i] = s;
      width[i] = codeBits;
    }
    start[w] = from + span;
  }
  return { bits: tableBits, symbol, width };
}

/** Reads a Huffman table description. Returns the bytes it used. */
function readHuffman(src: Uint8Array): { table: HuffmanTable; used: number } {
  if (src.length === 0) throw new Error('zstd Huffman description is empty');
  const header = src[0]!;
  if (header >= 128) {
    // The weights are sent plainly, one nibble each.
    const count = header - 127;
    const bytes = (count + 1) >> 1;
    if (1 + bytes > src.length) throw new Error('zstd Huffman weights are truncated');
    const weights = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const byte = src[1 + (i >> 1)]!;
      weights[i] = i % 2 === 0 ? byte >> 4 : byte & 15;
    }
    return { table: buildHuffman(weights, count), used: 1 + bytes };
  }
  // The weights are themselves FSE coded, with two interleaved states.
  const end = 1 + header;
  if (end > src.length) throw new Error('zstd Huffman description is truncated');
  const body = src.subarray(1, end);
  const { table, used } = readFseTable(body, MAX_LITERAL_SYMBOL, 6);
  const stream = new BackwardBits(body.subarray(used));
  const weights = new Uint8Array(MAX_LITERAL_SYMBOL + 1);
  let count = 0;
  let state1 = stream.read(table.log);
  let state2 = stream.read(table.log);
  // The two states take turns, and the stream ends where it runs out of bits:
  // the state that did not overflow contributes one last weight.
  for (;;) {
    if (count + 1 > MAX_LITERAL_SYMBOL) throw new Error('zstd sends too many Huffman weights');
    weights[count++] = table.symbol[state1]!;
    state1 = table.base[state1]! + stream.read(table.bits[state1]!);
    if (stream.overflowed) {
      weights[count++] = table.symbol[state2]!;
      break;
    }
    weights[count++] = table.symbol[state2]!;
    state2 = table.base[state2]! + stream.read(table.bits[state2]!);
    if (stream.overflowed) {
      weights[count++] = table.symbol[state1]!;
      break;
    }
  }
  return { table: buildHuffman(weights, count), used: end };
}

/** Decodes `count` symbols of a Huffman stream into `out` at `at`. */
function decodeHuffman(
  stream: BackwardBits,
  table: HuffmanTable,
  out: Uint8Array,
  at: number,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const index = stream.peek(table.bits);
    out[at + i] = table.symbol[index]!;
    stream.skip(table.width[index]!);
  }
}

/** Output buffer that grows as blocks are decoded. */
class Output {
  data: Uint8Array;
  length = 0;

  constructor(capacity: number) {
    this.data = new Uint8Array(Math.max(1024, capacity));
  }

  reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < needed) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }

  push(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.data.set(bytes, this.length);
    this.length += bytes.length;
  }

  repeat(byte: number, count: number): void {
    this.reserve(count);
    this.data.fill(byte, this.length, this.length + count);
    this.length += count;
  }

  /** Copies `count` bytes from `offset` back, which may overlap the copy. */
  copyBack(offset: number, count: number): void {
    if (offset <= 0 || offset > this.length) {
      throw new Error(`zstd match points ${offset} bytes back`);
    }
    this.reserve(count);
    const data = this.data;
    let from = this.length - offset;
    let to = this.length;
    for (let i = 0; i < count; i++) data[to++] = data[from++]!;
    this.length = to;
  }
}

/** State a frame carries from block to block. */
interface FrameState {
  huffman?: HuffmanTable;
  literalsLength?: FseTable;
  matchLength?: FseTable;
  offset?: FseTable;
  repeat: [number, number, number];
}

/** Decodes the literals section. Returns the literals and the bytes used. */
function readLiterals(src: Uint8Array, state: FrameState): { literals: Uint8Array; used: number } {
  const first = src[0];
  if (first === undefined) throw new Error('zstd block has no literals section');
  const type = first & 3;
  const format = (first >> 2) & 3;

  if (type === LITERALS_RAW || type === LITERALS_RLE) {
    let size: number;
    let header: number;
    if (format === 0 || format === 2) {
      size = first >> 3;
      header = 1;
    } else if (format === 1) {
      size = (first >> 4) | (src[1]! << 4);
      header = 2;
    } else {
      size = (first >> 4) | (src[1]! << 4) | (src[2]! << 12);
      header = 3;
    }
    if (type === LITERALS_RAW) {
      if (header + size > src.length) throw new Error('zstd raw literals are truncated');
      return { literals: src.subarray(header, header + size), used: header + size };
    }
    const literals = new Uint8Array(size);
    literals.fill(src[header]!);
    return { literals, used: header + 1 };
  }

  // Huffman coded, in one stream or in four.
  let regenerated: number;
  let compressed: number;
  let header: number;
  let streams: number;
  if (format === 0 || format === 1) {
    const value = first | (src[1]! << 8) | (src[2]! << 16);
    regenerated = (value >> 4) & 0x3ff;
    compressed = (value >> 14) & 0x3ff;
    header = 3;
    streams = format === 0 ? 1 : 4;
  } else if (format === 2) {
    const value = first | (src[1]! << 8) | (src[2]! << 16) | (src[3]! << 24);
    regenerated = (value >>> 4) & 0x3fff;
    compressed = (value >>> 18) & 0x3fff;
    header = 4;
    streams = 4;
  } else {
    const value = first | (src[1]! << 8) | (src[2]! << 16) | (src[3]! << 24);
    regenerated = (value >>> 4) & 0x3ffff;
    compressed = ((value >>> 22) & 0x3ff) | (src[4]! << 10);
    header = 5;
    streams = 4;
  }
  if (header + compressed > src.length) throw new Error('zstd literals are truncated');
  let body = src.subarray(header, header + compressed);

  if (type === LITERALS_HUFFMAN) {
    const { table, used } = readHuffman(body);
    state.huffman = table;
    body = body.subarray(used);
  }
  const table = state.huffman;
  if (!table) {
    throw new Error(
      type === LITERALS_REUSE
        ? 'zstd block reuses a Huffman table that was never sent'
        : 'zstd block has no Huffman table',
    );
  }

  const literals = new Uint8Array(regenerated);
  if (streams === 1) {
    decodeHuffman(new BackwardBits(body), table, literals, 0, regenerated);
  } else {
    if (body.length < 6) throw new Error('zstd literals have no jump table');
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const sizes = [view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)];
    const last = body.length - 6 - sizes[0]! - sizes[1]! - sizes[2]!;
    if (last < 0) throw new Error('zstd literal streams do not fit their section');
    sizes.push(last);
    const segment = (regenerated + 3) >> 2;
    let from = 6;
    let at = 0;
    for (let i = 0; i < 4; i++) {
      const count = i === 3 ? regenerated - at : Math.min(segment, regenerated - at);
      const stream = body.subarray(from, from + sizes[i]!);
      decodeHuffman(new BackwardBits(stream), table, literals, at, count);
      from += sizes[i]!;
      at += count;
    }
  }
  return { literals, used: header + compressed };
}

/** Reads one of the three sequence tables, in whichever way the block says. */
function readSequenceTable(
  src: Uint8Array,
  mode: number,
  predefined: readonly number[],
  predefinedLog: number,
  maxSymbol: number,
  maxLog: number,
  previous: FseTable | undefined,
): { table: FseTable; used: number } {
  switch (mode) {
    case MODE_PREDEFINED:
      return { table: buildFseTable(predefined, predefinedLog), used: 0 };
    case MODE_RLE: {
      const symbol = src[0];
      if (symbol === undefined) throw new Error('zstd single symbol table is truncated');
      const counts = new Array<number>(maxSymbol + 1).fill(0);
      counts[symbol] = 1;
      return { table: buildFseTable(counts, 0), used: 1 };
    }
    case MODE_FSE:
      return readFseTable(src, maxSymbol, maxLog);
    case MODE_REPEAT:
      if (!previous) throw new Error('zstd block repeats a table that was never sent');
      return { table: previous, used: 0 };
    default:
      throw new Error(`zstd block uses table mode ${mode}`);
  }
}

/** Decodes a compressed block into the output. */
function decodeCompressedBlock(src: Uint8Array, out: Output, state: FrameState): void {
  const { literals, used } = readLiterals(src, state);
  let at = used;

  if (at >= src.length) throw new Error('zstd block has no sequences section');
  let count = src[at++]!;
  if (count === 0) {
    out.push(literals);
    return;
  }
  if (count < 128) {
    // one byte
  } else if (count < 255) {
    count = ((count - 128) << 8) + src[at++]!;
  } else {
    count = src[at]! + (src[at + 1]! << 8) + 0x7f00;
    at += 2;
  }

  const modes = src[at++];
  if (modes === undefined) throw new Error('zstd sequences section is truncated');
  const literalsMode = (modes >> 6) & 3;
  const offsetMode = (modes >> 4) & 3;
  const matchMode = (modes >> 2) & 3;

  const ll = readSequenceTable(
    src.subarray(at),
    literalsMode,
    PREDEFINED_LITERALS_LENGTH,
    6,
    MAX_LITERALS_LENGTH_SYMBOL,
    9,
    state.literalsLength,
  );
  at += ll.used;
  const of = readSequenceTable(
    src.subarray(at),
    offsetMode,
    PREDEFINED_OFFSET,
    5,
    MAX_OFFSET_SYMBOL,
    8,
    state.offset,
  );
  at += of.used;
  const ml = readSequenceTable(
    src.subarray(at),
    matchMode,
    PREDEFINED_MATCH_LENGTH,
    6,
    MAX_MATCH_LENGTH_SYMBOL,
    9,
    state.matchLength,
  );
  at += ml.used;
  state.literalsLength = ll.table;
  state.offset = of.table;
  state.matchLength = ml.table;

  const stream = new BackwardBits(src.subarray(at));
  let literalsState = stream.read(ll.table.log);
  let offsetState = stream.read(of.table.log);
  let matchState = stream.read(ml.table.log);

  const repeat = state.repeat;
  let taken = 0; // literals already copied
  for (let i = 0; i < count; i++) {
    const offsetCode = of.table.symbol[offsetState]!;
    const matchCode = ml.table.symbol[matchState]!;
    const literalsCode = ll.table.symbol[literalsState]!;
    if (offsetCode > MAX_OFFSET_SYMBOL) throw new Error('zstd offset code is out of range');

    // The order of these reads is part of the format.
    const offsetValue = 2 ** offsetCode + stream.read(offsetCode);
    const matchLength = MATCH_LENGTH_BASE[matchCode]! + stream.read(MATCH_LENGTH_BITS[matchCode]!);
    const literalsLength =
      LITERALS_LENGTH_BASE[literalsCode]! + stream.read(LITERALS_LENGTH_BITS[literalsCode]!);

    let offset: number;
    if (offsetValue > 3) {
      offset = offsetValue - 3;
      repeat[2] = repeat[1];
      repeat[1] = repeat[0];
      repeat[0] = offset;
    } else {
      // One of the recent offsets, shifted by one when there are no literals.
      const which = offsetValue - 1 + (literalsLength === 0 ? 1 : 0);
      if (which === 0) {
        offset = repeat[0];
      } else {
        offset = which === 3 ? repeat[0] - 1 : repeat[which]!;
        if (which >= 2) repeat[2] = repeat[1];
        repeat[1] = repeat[0];
        repeat[0] = offset;
      }
    }

    if (taken + literalsLength > literals.length) {
      throw new Error('zstd sequence asks for more literals than the block holds');
    }
    out.push(literals.subarray(taken, taken + literalsLength));
    taken += literalsLength;
    out.copyBack(offset, matchLength);

    if (i + 1 < count) {
      literalsState = ll.table.base[literalsState]! + stream.read(ll.table.bits[literalsState]!);
      matchState = ml.table.base[matchState]! + stream.read(ml.table.bits[matchState]!);
      offsetState = of.table.base[offsetState]! + stream.read(of.table.bits[offsetState]!);
    }
  }
  out.push(literals.subarray(taken));
}

/**
 * Decompresses a Zstandard stream.
 *
 * @param src - one or more frames, as a VTF stores them
 * @param hint - expected size, used to size the buffer; not required
 * @throws {Error} on anything the stream does not allow, so a corrupt file
 * cannot be mistaken for a short one
 */
export function decompressZstd(src: Uint8Array, hint = 0): Uint8Array {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const out = new Output(hint);
  let at = 0;

  while (at + 4 <= src.length) {
    const magic = view.getUint32(at, true);
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      const size = view.getUint32(at + 4, true);
      at += 8 + size;
      continue;
    }
    if (magic !== FRAME_MAGIC) throw new Error('not a zstd frame');
    at += 4;

    const descriptor = src[at++]!;
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 3;
    if (!singleSegment) at++; // window descriptor, not needed: the output is kept whole
    if (dictionaryFlag !== 0) throw new Error('zstd frame uses a dictionary');
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    if (contentSizeBytes > 0) {
      let size = 0;
      for (let i = 0; i < contentSizeBytes; i++) size += src[at + i]! * 2 ** (8 * i);
      if (contentSizeBytes === 2) size += 256;
      at += contentSizeBytes;
      out.reserve(size);
    }

    const state: FrameState = { repeat: [1, 4, 8] };
    for (;;) {
      if (at + 3 > src.length) throw new Error('zstd frame ends inside a block header');
      const header = src[at]! | (src[at + 1]! << 8) | (src[at + 2]! << 16);
      at += 3;
      const lastBlock = (header & 1) !== 0;
      const type = (header >> 1) & 3;
      const size = header >> 3;
      // A run length block says how many bytes it stands for and stores one.
      const stored = type === BLOCK_RLE ? 1 : size;
      if (at + stored > src.length) throw new Error('zstd block runs past the end of the stream');
      const body = src.subarray(at, at + stored);
      at += stored;
      if (type === BLOCK_RAW) out.push(body);
      else if (type === BLOCK_RLE) out.repeat(body[0]!, size);
      else if (type === BLOCK_COMPRESSED) decodeCompressedBlock(body, out, state);
      else throw new Error('zstd block has a reserved type');
      if (lastBlock) break;
    }
    if (hasChecksum) at += 4; // the content is checked by what reads it
  }

  return out.data.subarray(0, out.length);
}
