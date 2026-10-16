// Attempts a complete frame decode: every entity block, using the exact
// entity to class map from the baselines and the per class property
// encodings from the game's network table metadata.
//
// The test is decisive: a correctly decoded frame ends exactly where the next
// frame begins, and the keyframe index pins those offsets.
import { readFileSync } from 'node:fs';
import { BitReader } from '../bitreader.mjs';
import {
  decompressBody,
  parseBody,
  readHeader,
  readSplits,
} from '../../packages/mtv/dist/index.js';

const file = process.argv[2] ?? 'D:/Projects/momtv.js/fixtures/bhop_eazy.mtv';
const data = new Uint8Array(readFileSync(file));
const header = readHeader(data);
const { bodyOffset } = readSplits(data);
const body = parseBody(decompressBody(data, header, bodyOffset), header);
const bytes = body.bytes;
const base = body.frameData.offset;
const propBits = header.propBits;

const ALIASES = { CKnife: 'CMomentumKnife' };
const dtDir = new URL('../out/dt/', import.meta.url);
function loadDt(name) {
  try {
    const text = readFileSync(new URL(`${name}.csv`, dtDir), 'utf8');
    const map = new Map();
    for (const line of text.split('\n').slice(1)) {
      const [, n, , bits, type, flags] = line.trim().split(',');
      if (n) map.set(n, { bits: Number(bits), type, flags: flags ?? '' });
    }
    return map;
  } catch {
    return null;
  }
}
const dtByClass = new Map();
for (const c of body.classes)
  dtByClass.set(c.classId, loadDt(c.name) ?? loadDt(ALIASES[c.name] ?? ''));
const classOfEntity = new Map(body.baselines.map((b) => [b.entity, b.classId]));
const propsOfClass = new Map(body.classes.map((c) => [c.classId, c.props]));

/** Reads one property, returning the bits consumed, or null when unsupported. */
function readProp(r, meta, arrayBits) {
  if (!meta) return false;
  const { bits, type, flags } = meta;
  const noscale = flags.includes('NOSCALE');
  const coord = flags.includes('COORD') && !flags.includes('CELL_COORD');
  const cellCoord = flags.includes('CELL_COORD');
  const normal = flags.includes('NORMAL');
  const floatish = () => {
    if (cellCoord) {
      r.readBits(bits);
      r.readBits(5);
      return;
    }
    if (coord) {
      r.readBitCoord();
      return;
    }
    if (normal) {
      r.readBitNormal();
      return;
    }
    if (noscale || bits === 0 || bits === 32) {
      r.readBits(32);
      return;
    }
    r.readBits(bits);
  };
  switch (type) {
    case 'Int':
    case 'Int64':
      r.readBits(bits === 0 ? 32 : bits);
      return true;
    case 'Float':
      floatish();
      return true;
    case 'Vector':
      floatish();
      floatish();
      floatish();
      return true;
    case 'VectorXY':
      floatish();
      floatish();
      return true;
    case 'Array':
      r.readBits(arrayBits);
      return true;
    case 'String':
      return false;
    default:
      return false;
  }
}

/** Decodes a whole frame with a given block layout. */
function decodeFrame(byteOffset, opts) {
  const r = new BitReader(bytes, base + byteOffset);
  const startBit = r.bitPos;
  const blockCount = r.readBits(6);
  if (blockCount === 0 || blockCount > 63) return null;
  let entity = -1;
  const seen = [];
  for (let i = 0; i < blockCount; i++) {
    const delta = r.readUBitVar();
    entity = opts.absolute ? delta : i === 0 ? delta : entity + 1 + delta;
    const classId = classOfEntity.get(entity);
    const props = propsOfClass.get(classId);
    if (props === undefined) return null;
    const dt = dtByClass.get(classId);
    const flags = opts.flagBits ? r.readBits(opts.flagBits) : 0;
    if (flags === 0) {
      const count = r.readUBitVar();
      if (count > props.length) return null;
      const idxs = [];
      for (let k = 0; k < count; k++) {
        const idx = r.readBits(propBits);
        if (idx >= props.length) return null;
        idxs.push(idx);
      }
      if (opts.listThenValues) {
        for (const idx of idxs) if (!readProp(r, dt?.get(props[idx]), opts.arrayBits)) return null;
      } else {
        r.bitPos -= count * propBits;
        for (let k = 0; k < count; k++) {
          const idx = r.readBits(propBits);
          if (!readProp(r, dt?.get(props[idx]), opts.arrayBits)) return null;
        }
      }
    }
    seen.push(`${entity}:${classId}`);
  }
  return { endBit: r.bitPos - startBit, blockCount, seen };
}

// known single tick steps: frame at `from` must end at `to`
const anchors = body.keyframeIndex
  .filter((k) => k.frameOffset >= 0)
  .map((k) => ({ tick: k.tick + 1, off: k.frameOffset }))
  .sort((a, b) => a.tick - b.tick);
const pairs = [];
if (anchors.length && anchors[0].tick === 1) pairs.push({ from: 0, to: anchors[0].off });
for (let i = 0; i + 1 < anchors.length; i++) {
  if (anchors[i + 1].tick === anchors[i].tick + 1) {
    pairs.push({ from: anchors[i].off, to: anchors[i + 1].off });
  }
}
console.log(
  `== ${file.split(/[\\/]/).pop()} rev${body.revision}, pairs: ${pairs.map((p) => `${p.from}->${p.to}`).join(' ')}`,
);

const hits = [];
for (const absolute of [true, false]) {
  for (const flagBits of [0, 1, 2, 3]) {
    for (const listThenValues of [false, true]) {
      for (const arrayBits of [21, 23, 46, 50, 52, 55, 64]) {
        const opts = { absolute, flagBits, listThenValues, arrayBits };
        let exact = 0;
        let parsed = 0;
        for (const pair of pairs) {
          const got = decodeFrame(pair.from, opts);
          if (!got) continue;
          parsed++;
          if (pair.from + Math.ceil(got.endBit / 8) === pair.to) exact++;
        }
        if (parsed) hits.push({ opts, parsed, exact, total: pairs.length });
      }
    }
  }
}
hits.sort((a, b) => b.exact - a.exact || b.parsed - a.parsed);
for (const h of hits.slice(0, 10)) {
  const o = h.opts;
  console.log(
    `  abs=${o.absolute} flags=${o.flagBits}b listThenValues=${o.listThenValues} array=${o.arrayBits}b -> parsed ${h.parsed}/${h.total}, exact ${h.exact}`,
  );
}
if (!hits.length) console.log('  nothing parsed');

// detail for the best candidate
if (hits.length && hits[0].exact > 0) {
  const got = decodeFrame(pairs[0].from, hits[0].opts);
  console.log(
    `\nframe ${pairs[0].from}: ${got.blockCount} blocks, entities ${got.seen.join(' ')}, ends at byte ${pairs[0].from + Math.ceil(got.endBit / 8)} (target ${pairs[0].to})`,
  );
}
