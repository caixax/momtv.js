// Searches the frame container grammar by walking the entire frame data and
// scoring each candidate by how many keyframe anchor offsets it reproduces.
// A correct grammar hits every anchor and consumes exactly frameCount frames.
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
const dataLen = body.frameData.length;
const propBits = header.propBits;
const frameCount = header.frameCount;

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
    } else if (coord) r.readBitCoord();
    else if (normal) r.readBitNormal();
    else if (noscale || bits === 0 || bits === 32) r.readBits(32);
    else r.readBits(bits);
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
    default:
      return false;
  }
}

const anchorByTick = new Map();
for (const k of body.keyframeIndex) {
  if (k.frameOffset >= 0 && k.frameOffset < dataLen) anchorByTick.set(k.tick + 1, k.frameOffset);
}

/**
 * grammar:
 *  headerBits  bits consumed before the first block (6 for the count field)
 *  entityMode  'ubitvar' | 'delta'
 *  cmdBits     bits after the entity field
 *  updateCmd   value of the cmd field that means "properties follow"
 *  stopBits    remaining bits below which the frame is considered over
 */
function walk(g, limitTicks) {
  let offset = 0;
  let hits = 0;
  let misses = 0;
  let ticks = 0;
  for (let tick = 0; tick < limitTicks; tick++) {
    const expected = anchorByTick.get(tick);
    if (expected !== undefined) {
      if (expected === offset) hits++;
      else misses++;
    }
    const r = new BitReader(bytes, base + offset);
    const frameStart = r.bitPos;
    try {
      if (g.headerBits) r.readBits(g.headerBits);
      let entity = -1;
      for (let block = 0; block < 64; block++) {
        const left = (base + dataLen) * 8 - r.bitPos;
        if (left < g.stopBits) break;
        const mark = r.bitPos;
        const raw = r.readUBitVar();
        entity = g.entityMode === 'ubitvar' ? raw : block === 0 ? raw : entity + 1 + raw;
        const classId = classOfEntity.get(entity);
        const props = propsOfClass.get(classId);
        const cmd = g.cmdBits ? r.readBits(g.cmdBits) : 0;
        if (props === undefined) {
          r.bitPos = mark;
          break;
        }
        if (cmd !== g.updateCmd) continue;
        const count = r.readUBitVar();
        if (count > props.length) {
          r.bitPos = mark;
          break;
        }
        const dt = dtByClass.get(classId);
        let ok = true;
        for (let k = 0; k < count; k++) {
          const idx = r.readBits(propBits);
          if (idx >= props.length || !readProp(r, dt?.get(props[idx]), g.arrayBits)) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          r.bitPos = mark;
          break;
        }
      }
      const used = r.bitPos - frameStart;
      if (used <= 0) break;
      offset += Math.ceil(used / 8);
      ticks++;
      if (offset >= dataLen) break;
    } catch {
      break;
    }
  }
  return { hits, misses, ticks };
}

console.log(`== ${file.split(/[\\/]/).pop()}: ${frameCount} frames, ${anchorByTick.size} anchors`);
const results = [];
for (const headerBits of [0, 6]) {
  for (const entityMode of ['ubitvar', 'delta']) {
    for (const cmdBits of [0, 1, 2, 3]) {
      for (const updateCmd of [0, 1]) {
        for (const stopBits of [8, 12, 16]) {
          for (const arrayBits of [50, 55]) {
            if (cmdBits === 0 && updateCmd !== 0) continue;
            const g = { headerBits, entityMode, cmdBits, updateCmd, stopBits, arrayBits };
            const res = walk(g, Math.min(frameCount, 400));
            results.push({ g, ...res });
          }
        }
      }
    }
  }
}
results.sort((a, b) => b.hits - a.hits || b.ticks - a.ticks);
for (const r of results.slice(0, 8)) {
  const g = r.g;
  console.log(
    `  hdr=${g.headerBits}b ent=${g.entityMode} cmd=${g.cmdBits}b upd=${g.updateCmd} stop=${g.stopBits} arr=${g.arrayBits} -> anchors ${r.hits}, misses ${r.misses}, ticks ${r.ticks}`,
  );
}
