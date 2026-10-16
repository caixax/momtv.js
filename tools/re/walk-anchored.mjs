// Walks the frames exactly and uses the keyframe index to resynchronise.
//
// The index pins known ticks to known byte offsets, and those ticks are the
// zone events, which is where the run timer sends the properties this parser
// cannot size yet. So the one place the walk can lose its place is also the
// one place the file says where to continue from.
//
// Reports how many frames decode exactly and how often the player's position
// fails to advance, which is what a viewer shows as a stutter.
//
// Usage: node tools/re/walk-anchored.mjs [replay...]
import { readFileSync } from 'node:fs';
import { BitReader, parseReplay, resolveClassProps } from '../../packages/mtv/dist/index.js';

const COORD_FRACTIONAL_BITS = 5;
const COORD_INTEGER_BITS = 14;
const NORMAL_BITS = 12;
const STRING_LENGTH_BITS = 9;
const ELEMENT_BITS = 6;

/** Properties that take one bit more than the network table declares. */
const WIDENED = new Set([
  'm_iLandTick',
  'm_iJumpTick',
  'm_iEarlyJumpTiming',
  'hasteEndTick',
  'damageBoostEndTick',
  'slickEndTick',
  'flightEndTick',
  'defragTimerEndTick',
  'm_dNetworkRunTime',
]);

const has = (e, flag) => (e.f ?? []).includes(flag);

function readValue(r, e) {
  const float = () => {
    if (has(e, 'COORD')) {
      const integer = r.readBit();
      const fraction = r.readBit();
      if (!integer && !fraction) return 0;
      const negative = r.readBit();
      let value = 0;
      if (integer) value += r.readBits(COORD_INTEGER_BITS) + 1;
      if (fraction) value += r.readBits(COORD_FRACTIONAL_BITS) / 32;
      return negative ? -value : value;
    }
    if (has(e, 'NOSCALE') || e.b === 0 || e.b === 32) return r.readFloat32();
    if (has(e, 'NORMAL')) {
      const negative = r.readBit();
      const value = r.readBits(NORMAL_BITS - 1) / 2047;
      return negative ? -value : value;
    }
    if (has(e, 'CELL_COORD')) return r.readBits(e.b) + r.readBits(COORD_FRACTIONAL_BITS) / 32;
    return r.readBits(e.b);
  };
  switch (e.k) {
    case 'int':
      return r.readBits(e.b || 32);
    case 'float':
      return float();
    case 'vector': {
      const x = float();
      const y = float();
      if (has(e, 'NORMAL')) {
        r.readBit();
        return [x, y, 0];
      }
      return [x, y, float()];
    }
    case 'vectorxy':
      return [float(), float()];
    case 'string': {
      const length = r.readBits(STRING_LENGTH_BITS);
      r.skipBits(length * 8);
      return '';
    }
    case 'array': {
      const count = r.readBits(e.c);
      for (let i = 0; i < count; i++) readValue(r, e.e);
      return [];
    }
  }
}

const files = process.argv.slice(2);
const replays = files.length
  ? files
  : [
      'testbed/public/replays/agtricks.momtv',
      'testbed/public/replays/ab_baume.momtv',
      'testbed/public/replays/df_cruton.momtv',
      'testbed/public/replays/bhop_badwater.momtv',
    ];

for (const path of replays) {
  const replay = parseReplay(new Uint8Array(readFileSync(path)));
  const body = replay.body;
  const section = body.frameData;
  const propBits = replay.header.propBits;
  const names = new Map(body.classes.map((c) => [c.classId, c.name]));
  const baselineClass = new Map(body.baselines.map((b) => [b.entity, names.get(b.classId)]));
  let encodings;
  try {
    encodings = new Map(body.classes.map((c) => [c.name, resolveClassProps(c.name, c.props)]));
  } catch (error) {
    console.log(`${path.split('/').pop().padEnd(26)} ${error.message}`);
    continue;
  }
  const propNames = new Map(body.classes.map((c) => [c.name, c.props]));
  // The index records, for a keyframe at tick T, where the frame for T + 1
  // starts: playback reads the keyframe and the next frame advances the tick.
  const anchors = new Map(
    body.keyframeIndex.filter((k) => k.frameOffset >= 0).map((k) => [k.tick + 1, k.frameOffset]),
  );
  const player = body.classes.find((c) => c.name === 'CMomentumPlayer');
  const ORIGIN = player ? player.props.indexOf('m_vecOrigin') : -1;
  const ORIGIN_Z = player ? player.props.indexOf('m_vecOrigin[2]') : -1;

  const slots = new Map();
  const seedSlots = () => {
    slots.clear();
    const r = new BitReader(body.bytes, body.keyframeData.offset, body.keyframeData.length);
    r.readBit();
    if (r.readBit()) {
      const count = r.readUBitVar();
      for (let i = 0; i < count; i++) {
        const baseline = r.readVarInt32();
        const slot = r.readVarInt32();
        r.readVarInt32();
        const name = baselineClass.get(baseline);
        if (name) slots.set(slot, name);
      }
    }
  };
  seedSlots();

  const r = new BitReader(body.bytes, section.offset, section.length);
  const rel = () => r.bitPos - section.offset * 8;
  const message = () => {
    r.readVarInt32();
    const size = r.readVarInt32();
    if (size > 1 << 20) throw new Error(`message of ${size} bytes`);
    r.skipBits(size * 8);
  };

  const breaks = [];
  let exact = 0;
  let resyncs = 0;
  let lost = 0;
  const origins = [];
  let last = null;
  let broken = false;
  for (let tick = 0; tick < replay.frameCount; tick++) {
    const anchor = anchors.get(tick);
    if (anchor !== undefined) {
      if (rel() !== anchor * 8 || broken) {
        r.bitPos = section.offset * 8 + anchor * 8;
        resyncs++;
        broken = false;
      }
    }
    if (broken) {
      lost++;
      origins.push(last ? [...last] : null);
      continue;
    }
    try {
      r.readBit();
      if (r.readBit()) {
        const count = r.readUBitVar();
        if (count > 256) throw new Error('creations');
        for (let i = 0; i < count; i++) {
          const baseline = r.readVarInt32();
          const slot = r.readVarInt32();
          r.readVarInt32();
          const name = baselineClass.get(baseline);
          if (!name) throw new Error('baseline');
          slots.set(slot, name);
        }
      }
      const count = r.readUBitVar();
      if (count > 64) throw new Error('directory');
      const order = [];
      for (let i = 0; i < count; i++) order.push(r.readUBitVar());
      for (const slot of order) {
        const name = slots.get(slot);
        if (!name) throw new Error(`slot ${slot}`);
        const list = encodings.get(name);
        const own = propNames.get(name);
        const n = r.readUBitVar();
        if (n === 0 || n > list.length) throw new Error('payload');
        const refs = [];
        for (let i = 0; i < n; i++) {
          const index = r.readBits(propBits);
          if (!list[index]) throw new Error('index');
          refs.push(index);
          if (list[index].k === 'array') r.readBits(ELEMENT_BITS);
        }
        for (const index of refs) {
          const e = list[index];
          const value = readValue(r, e.k === 'array' ? e.e : e);
          if (WIDENED.has(own[index])) r.readBit();
          if (slot === 0) {
            if (index === ORIGIN) last = [value[0], value[1], last?.[2] ?? 0];
            if (index === ORIGIN_Z) last = [last?.[0] ?? 0, last?.[1] ?? 0, value];
          }
        }
      }
      if (r.readBit()) {
        const n = r.readUBitVar();
        if (n > 64) throw new Error('removals');
        for (let i = 0; i < n; i++) slots.delete(r.readUBitVar());
      }
      if (r.readBit()) message();
      if (r.readBit()) message();
      if (r.readBit()) {
        const n = r.readUBitVar();
        if (n > 64) throw new Error('user messages');
        for (let i = 0; i < n; i++) message();
      }
      if (r.readBit()) {
        const n = r.readUBitVar();
        if (n > 64) throw new Error('entity messages');
        for (let i = 0; i < n; i++) message();
      }
      r.alignByte();
      exact++;
    } catch (error) {
      if (!broken) breaks.push(`tick ${tick}: ${error.message}`);
      broken = true;
      lost++;
    }
    origins.push(last ? [...last] : null);
  }

  // How often the position stands still between ticks, which is the stutter a
  // viewer would show.
  let moving = 0;
  let still = 0;
  for (let i = 1; i < origins.length; i++) {
    const a = origins[i - 1];
    const b = origins[i];
    if (!a || !b) continue;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.02) moving++;
    else still++;
  }
  console.log(
    `${path.split('/').pop().padEnd(26)} exact ${exact}/${replay.frameCount}  ` +
      `resyncs ${resyncs}  lost ${lost}  still ${still}/${still + moving}`,
  );
  for (const line of breaks.slice(0, 6)) console.log('      ' + line);
}
