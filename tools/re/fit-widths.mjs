// Fits the property widths the network table dump does not pin down.
//
// The walk is self checking: a frame that reads one bit too many or too few
// throws the next frame out of step, and the keyframe index catches any drift
// at known byte offsets. So a correction can be found by hill climbing: when
// the walk stops, try one more bit on each property the last frames carried,
// keep whichever gets furthest, and go again.
//
// Usage: node tools/re/fit-widths.mjs [replay...]
import { readFileSync } from 'node:fs';
import { BitReader, parseReplay, resolveClassProps } from '../../packages/mtv/dist/index.js';

const COORD_FRACTIONAL_BITS = 5;
const COORD_INTEGER_BITS = 14;
const NORMAL_BITS = 12;
const STRING_LENGTH_BITS = 9;
const ELEMENT_BITS = 6;

const has = (e, flag) => (e.f ?? []).includes(flag);

function readValue(r, e) {
  const float = () => {
    if (has(e, 'COORD')) {
      const integer = r.readBit();
      const fraction = r.readBit();
      if (!integer && !fraction) return;
      r.readBit();
      if (integer) r.readBits(COORD_INTEGER_BITS);
      if (fraction) r.readBits(COORD_FRACTIONAL_BITS);
      return;
    }
    if (has(e, 'NOSCALE') || e.b === 0 || e.b === 32) return void r.readFloat32();
    if (has(e, 'NORMAL')) {
      r.readBit();
      return void r.readBits(NORMAL_BITS - 1);
    }
    if (has(e, 'CELL_COORD')) {
      r.readBits(e.b);
      return void r.readBits(COORD_FRACTIONAL_BITS);
    }
    return void r.readBits(e.b);
  };
  switch (e.k) {
    case 'int':
      return void r.readBits(e.b || 32);
    case 'float':
      return float();
    case 'vector':
      float();
      float();
      if (has(e, 'NORMAL')) return void r.readBit();
      return float();
    case 'vectorxy':
      float();
      return float();
    case 'string': {
      const length = r.readBits(STRING_LENGTH_BITS);
      for (let i = 0; i < length; i++) r.readBits(8);
      return;
    }
    case 'array': {
      const count = r.readBits(e.c);
      for (let i = 0; i < count; i++) readValue(r, e.e);
      return;
    }
  }
}

/**
 * Walks with a set of extra bits applied to named properties.
 *
 * Returns how far it got and which properties the last frames carried, which
 * is the set worth trying a correction on.
 */
function walk(replay, extra) {
  const body = replay.body;
  const section = body.frameData;
  const propBits = replay.header.propBits;
  const names = new Map(body.classes.map((c) => [c.classId, c.name]));
  const baselineClass = new Map(body.baselines.map((b) => [b.entity, names.get(b.classId)]));
  const encodings = new Map(body.classes.map((c) => [c.name, resolveClassProps(c.name, c.props)]));
  const propNames = new Map(body.classes.map((c) => [c.name, c.props]));
  // A keyframe at tick T records where the frame for T + 1 starts.
  const anchors = new Map(
    body.keyframeIndex.filter((k) => k.frameOffset >= 0).map((k) => [k.tick + 1, k.frameOffset]),
  );

  const slots = new Map();
  {
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
  }

  const r = new BitReader(body.bytes, section.offset, section.length);
  const rel = () => r.bitPos - section.offset * 8;
  const message = () => {
    r.readVarInt32();
    const size = r.readVarInt32();
    if (size > 1 << 20) throw new Error(`message of ${size} bytes`);
    r.skipBits(size * 8);
  };

  let frames = 0;
  let hit = 0;
  let missed = 0;
  let failure = null;
  let recent = [];
  try {
    for (; frames < replay.frameCount; frames++) {
      const anchor = anchors.get(frames);
      if (anchor !== undefined) {
        if (rel() === anchor * 8) hit++;
        else {
          // The index is authoritative, so carry on from there and count the
          // frame as one this reading could not place.
          r.bitPos = section.offset * 8 + anchor * 8;
          missed++;
        }
      }
      const carried = [];
      r.readBit();
      if (r.readBit()) {
        const count = r.readUBitVar();
        if (count > 256) throw new Error(`${count} creations`);
        for (let i = 0; i < count; i++) {
          const baseline = r.readVarInt32();
          const slot = r.readVarInt32();
          r.readVarInt32();
          const name = baselineClass.get(baseline);
          if (!name) throw new Error(`creation names baseline ${baseline}`);
          slots.set(slot, name);
        }
      }
      const count = r.readUBitVar();
      if (count > 64) throw new Error(`${count} directory entries`);
      const order = [];
      for (let i = 0; i < count; i++) order.push(r.readUBitVar());
      for (const slot of order) {
        const name = slots.get(slot);
        if (!name) throw new Error(`slot ${slot} has no class`);
        const list = encodings.get(name);
        const own = propNames.get(name);
        const n = r.readUBitVar();
        if (n === 0 || n > list.length) throw new Error(`${name} claims ${n} properties`);
        const refs = [];
        for (let i = 0; i < n; i++) {
          const index = r.readBits(propBits);
          if (!list[index]) throw new Error(`${name} has no property ${index}`);
          refs.push(index);
          if (list[index].k === 'array') r.readBits(ELEMENT_BITS);
        }
        for (const index of refs) {
          const e = list[index];
          readValue(r, e.k === 'array' ? e.e : e);
          const bits = extra.get(own[index]);
          if (bits) r.skipBits(bits);
          carried.push(own[index]);
        }
      }
      if (r.readBit()) {
        const n = r.readUBitVar();
        if (n > 64) throw new Error(`${n} removals`);
        for (let i = 0; i < n; i++) slots.delete(r.readUBitVar());
      }
      if (r.readBit()) message();
      if (r.readBit()) message();
      if (r.readBit()) {
        const n = r.readUBitVar();
        if (n > 64) throw new Error(`${n} user messages`);
        for (let i = 0; i < n; i++) message();
      }
      if (r.readBit()) {
        const n = r.readUBitVar();
        if (n > 64) throw new Error(`${n} entity messages`);
        for (let i = 0; i < n; i++) message();
      }
      r.alignByte();
      recent.push(carried);
      if (recent.length > 2) recent.shift();
    }
  } catch (error) {
    failure = error.message;
  }
  // What to maximise: frames read in place, less the resynchronisations the
  // reading needed.
  return {
    frames,
    hit,
    missed,
    score: frames - missed * 50,
    failure,
    candidates: [...new Set(recent.flat())],
  };
}

const files = process.argv.slice(2);
const replays = (
  files.length
    ? files
    : [
        'testbed/public/replays/agtricks.momtv',
        'testbed/public/replays/ab_baume.momtv',
        'testbed/public/replays/df_cruton.momtv',
        'testbed/public/replays/bhop_badwater.momtv',
      ]
).map((path) => ({ path, replay: parseReplay(new Uint8Array(readFileSync(path))) }));

/** Climbs the corrections for one replay on its own. */
function fit(replay, seed) {
  const extra = new Map(seed);
  let best = walk(replay, extra);
  for (let round = 0; round < 20; round++) {
    const tries = new Set([...extra.keys(), ...best.candidates]);
    let winner = null;
    for (const name of tries) {
      for (const bits of [1, 2, -1, -2]) {
        const now = extra.get(name) ?? 0;
        if (now + bits < 0) continue;
        const candidate = new Map(extra);
        if (now + bits === 0) candidate.delete(name);
        else candidate.set(name, now + bits);
        const got = walk(replay, candidate);
        const better =
          got.frames > (winner?.got.frames ?? best.frames) ||
          (got.frames === (winner?.got.frames ?? best.frames) &&
            got.hit > (winner?.got.hit ?? best.hit));
        if (better) winner = { name, bits, got };
      }
    }
    if (!winner) break;
    const now = extra.get(winner.name) ?? 0;
    if (now + winner.bits === 0) extra.delete(winner.name);
    else extra.set(winner.name, now + winner.bits);
    best = winner.got;
  }
  return { extra, best };
}

// The corrections already established live in the generated property table,
// so the climb starts from nothing.
const SEED = [];

for (const { path, replay } of replays) {
  const { extra, best } = fit(replay, SEED);
  console.log(`${path.split('/').pop()}`);
  console.log(
    `  ${best.frames}/${replay.frameCount} frames, ${best.hit} anchors hit, ` +
      `${best.missed} missed` +
      (best.failure ? ` | ${best.failure}` : ' | clean'),
  );
  console.log('  corrections: ' + ([...extra].map(([n, b]) => `${n} +${b}`).join(', ') || 'none'));
}
