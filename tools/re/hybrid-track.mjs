// Measures a hybrid walk: every frame's header, creations, directory and
// player payload are read exactly, and only the rest of the frame, whose
// non player payloads are not yet decodable, is skipped by looking for the
// next frame start.
//
// The test for a frame start is strong now that the shape is known: the
// header has to parse, every creation has to name a real baseline, every
// directory slot has to be one the walk knows, and the player's payload has
// to continue the trajectory.
//
// Usage: node tools/re/hybrid-track.mjs [replay...]
import { readFileSync } from 'node:fs';
import {
  BitReader,
  parseReplay,
  readPropValue,
  resolveClassProps,
} from '../../packages/mtv/dist/index.js';

const files = process.argv.slice(2);
const replays = files.length
  ? files
  : [
      'testbed/public/replays/agtricks.momtv',
      'testbed/public/replays/ab_baume.momtv',
      'testbed/public/replays/df_cruton.momtv',
      'testbed/public/replays/bhop_badwater.momtv',
      'testbed/public/replays/deathrun_unique.momtv',
      'testbed/public/replays/df_waluigi_pinball.momtv',
    ];

/** How far past a frame to look for the next one. */
const SEARCH_BITS = 4096;

for (const path of replays) {
  const replay = parseReplay(new Uint8Array(readFileSync(path)));
  const body = replay.body;
  const section = body.frameData;
  const propBits = replay.header.propBits;
  const names = new Map(body.classes.map((c) => [c.classId, c.name]));
  const baselineClass = new Map(body.baselines.map((b) => [b.entity, names.get(b.classId)]));
  const player = body.classes.find((c) => c.name === 'CMomentumPlayer');
  if (!player) {
    console.log(`${path}: records no player class`);
    continue;
  }
  const playerEnc = resolveClassProps(player.name, player.props);
  const ORIGIN = player.props.indexOf('m_vecOrigin');
  const ORIGIN_Z = player.props.indexOf('m_vecOrigin[2]');

  const reader = (bit) => {
    const r = new BitReader(body.bytes, section.offset, section.length);
    r.bitPos = section.offset * 8 + bit;
    return r;
  };

  /**
   * Reads a frame's head: everything up to and including the player's
   * payload, which is all this parser can do exactly for now.
   */
  function head(bit, slots) {
    try {
      return headUnsafe(bit, slots);
    } catch {
      return null; // a reading that runs off the stream is not a frame
    }
  }

  function headUnsafe(bit, slots) {
    const r = reader(bit);
    const rel = () => r.bitPos - section.offset * 8;
    r.readBit();
    const created = [];
    if (r.readBit()) {
      const count = r.readUBitVar();
      if (count > 256) return null;
      for (let i = 0; i < count; i++) {
        const baseline = r.readVarInt32();
        const slot = r.readVarInt32();
        r.readVarInt32();
        const name = baselineClass.get(baseline);
        if (!name) return null;
        created.push([slot, name]);
      }
    }
    const count = r.readUBitVar();
    if (count > 64) return null;
    const order = [];
    for (let i = 0; i < count; i++) order.push(r.readUBitVar());
    const known = new Map(slots);
    for (const [slot, name] of created) known.set(slot, name);
    for (const slot of order) {
      if (!known.has(slot)) return null;
    }
    // The player is read when it is in the directory, and it always comes
    // first there.
    let origin = null;
    if (order[0] === 0) {
      const n = r.readUBitVar();
      if (n === 0 || n > player.props.length) return null;
      const refs = [];
      for (let i = 0; i < n; i++) {
        const index = r.readBits(propBits);
        const encoding = playerEnc[index];
        if (!encoding) return null;
        refs.push({ index, element: encoding.k === 'array' ? r.readBits(6) : 0 });
      }
      const got = {};
      try {
        for (const ref of refs) {
          const encoding = playerEnc[ref.index];
          const value = readPropValue(r, encoding.k === 'array' ? encoding.e : encoding);
          if (ref.index === ORIGIN) got.xy = value;
          if (ref.index === ORIGIN_Z) got.z = value;
        }
      } catch {
        return null;
      }
      origin = got;
    }
    return { created, order, origin, end: rel() };
  }

  const anchors = new Map(
    body.keyframeIndex.filter((k) => k.frameOffset >= 0).map((k) => [k.tick, k.frameOffset]),
  );
  // Seed the slot map from the first keyframe, as playback does.
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

  let at = 0;
  let exact = 0;
  let searched = 0;
  let missing = 0;
  let last = null;
  const positions = [];
  for (let tick = 0; tick < replay.frameCount; tick++) {
    const anchor = anchors.get(tick);
    if (anchor !== undefined) at = anchor * 8;
    let got = head(at, slots);
    if (got) {
      exact++;
    } else {
      // Look for the next frame start.
      let found = null;
      for (let bit = at + 1; bit < Math.min(at + SEARCH_BITS, section.length * 8 - 16); bit++) {
        const probe = head(bit, slots);
        if (!probe) continue;
        const next = head(probe.end, slots);
        if (!next) continue;
        found = { bit, probe };
        break;
      }
      if (!found) {
        missing++;
        break;
      }
      searched++;
      at = found.bit;
      got = found.probe;
    }
    for (const [slot, name] of got.created) slots.set(slot, name);
    if (got.origin?.xy) {
      last = [got.origin.xy[0], got.origin.xy[1], got.origin.z ?? last?.[2] ?? 0];
    }
    positions.push(last ? [...last] : null);
    at = got.end;
  }

  // How often the position fails to advance while the player is moving.
  let moving = 0;
  let frozen = 0;
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1];
    const b = positions[i];
    if (!a || !b) continue;
    const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (step > 0.02) moving++;
    else frozen++;
  }
  console.log(
    `${path.split('/').pop().padEnd(26)} exact ${exact}/${replay.frameCount} frames, ` +
      `${searched} searches, ${missing} unresolved | still ticks ${frozen}/${frozen + moving}`,
  );
}
