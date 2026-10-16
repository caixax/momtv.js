// Learns the two class index spaces a frame uses.
//
// A frame names a class in two ways the file does not explain: a creation
// record carries an index into the recorder's list of supported classes, and a
// directory entry for a slot the stream has not described yet carries an index
// into the engine's class table. Both are constant for a build, so they can be
// learned by search: a wrong binding throws the walk out of step within a few
// frames, and the keyframe index checks it at known byte offsets.
//
// Usage: node tools/re/learn-class-refs.mjs [replay...]
import { readFileSync } from 'node:fs';
import {
  BitReader,
  parseReplay,
  readPropValue,
  resolveClassProps,
} from '../../packages/mtv/dist/index.js';

/** How many frames a candidate binding has to survive to be accepted. */
const LOOKAHEAD = 60;

class Walk {
  constructor(replay, specs, refs) {
    this.replay = replay;
    this.body = replay.body;
    this.section = this.body.frameData;
    this.propBits = replay.header.propBits;
    this.classes = this.body.classes.map((c) => ({
      name: c.name,
      props: c.props,
      enc: resolveClassProps(c.name, c.props),
    }));
    this.byName = new Map(this.classes.map((c) => [c.name, c]));
    this.specs = specs;
    this.refs = refs;
    this.anchors = new Map(
      this.body.keyframeIndex.filter((k) => k.frameOffset >= 0).map((k) => [k.tick, k.frameOffset]),
    );
  }

  /**
   * Reads one record, which is the same grammar for a keyframe and a frame.
   * `slots` carries the slot map forward; `origin` records how each slot was
   * introduced so a missing class can be attributed to the right index space.
   */
  record(r, base, slots, origin) {
    const rel = () => r.bitPos - base;
    const align = () => {
      r.bitPos = (r.bitPos + 7) & ~7;
    };
    r.readBit();
    if (r.readBit()) {
      const count = r.readUBitVar();
      if (count > 1024) throw new Error(`creation count ${count}`);
      align(); // the records are varints, which start on a byte
      for (let i = 0; i < count; i++) {
        const spec = r.readVarInt32();
        const slot = r.readVarInt32();
        r.readVarInt32();
        origin.set(slot, { kind: 'spec', value: spec });
        const name = this.specs.get(spec);
        slots.set(slot, name ? this.byName.get(name) : null);
      }
    }
    const count = r.readUBitVar();
    if (count > 64) throw new Error(`directory count ${count}`);
    const order = [];
    for (let i = 0; i < count; i++) {
      const slot = r.readUBitVar();
      if (!slots.has(slot)) {
        r.readUBitVar();
        const ref = r.readUBitVar();
        origin.set(slot, { kind: 'ref', value: ref });
        const name = this.refs.get(ref);
        slots.set(slot, name ? this.byName.get(name) : null);
      }
      order.push(slot);
    }
    for (const slot of order) {
      const cls = slots.get(slot);
      if (!cls) {
        const from = origin.get(slot);
        if (from && !this.hasBinding(from)) return { need: from };
        throw new Error(`slot ${slot} has no class`);
      }
      const n = r.readUBitVar();
      if (n === 0 || n > cls.enc.length) throw new Error(`payload claims ${n} properties`);
      const refs = [];
      for (let i = 0; i < n; i++) {
        const index = r.readBits(this.propBits);
        const encoding = cls.enc[index];
        if (!encoding) throw new Error(`${cls.name} has no property ${index}`);
        refs.push({ index, element: encoding.k === 'array' ? r.readBits(6) : 0 });
      }
      for (const ref of refs) {
        const encoding = cls.enc[ref.index];
        readPropValue(r, encoding.k === 'array' ? encoding.e : encoding);
      }
    }
    if (r.readBit()) {
      align();
      const bytes = r.readVarInt32();
      if (bytes > 1 << 16) throw new Error(`trailing section of ${bytes} bytes`);
      r.skipBits(bytes * 8);
    }
    return { need: null, end: rel() };
  }

  hasBinding(from) {
    return (from.kind === 'spec' ? this.specs : this.refs).has(from.value);
  }

  /**
   * Walks up to `limit` frames, after seeding the slot map from the first
   * keyframe the way playback does.
   */
  run(limit) {
    const slots = new Map();
    const origin = new Map();
    // Playback starts by reading a keyframe, which is what creates the
    // entities the frames then refer to.
    // Only its creation records are needed, since they are what name the
    // entities the frames go on to refer to.
    const keyframes = this.body.keyframeData;
    const seed = new BitReader(this.body.bytes, keyframes.offset, keyframes.length);
    seed.readBit();
    if (seed.readBit()) {
      const count = seed.readUBitVar();
      seed.bitPos = (seed.bitPos + 7) & ~7;
      for (let i = 0; i < count; i++) {
        const spec = seed.readVarInt32();
        const slot = seed.readVarInt32();
        seed.readVarInt32();
        origin.set(slot, { kind: 'spec', value: spec });
        const name = this.specs.get(spec);
        slots.set(slot, name ? this.byName.get(name) : null);
      }
    }

    const r = new BitReader(this.body.bytes, this.section.offset, this.section.length);
    const base = this.section.offset * 8;
    const rel = () => r.bitPos - base;
    let frames = 0;
    let anchorsHit = 0;

    try {
      for (; frames < limit; frames++) {
        const anchor = this.anchors.get(frames);
        if (anchor !== undefined) {
          if (rel() !== anchor * 8) {
            return { frames, anchorsHit, stopped: `anchor for tick ${frames} missed`, need: null };
          }
          anchorsHit++;
        }
        const got = this.record(r, base, slots, origin);
        if (got.need) return { frames, anchorsHit, stopped: null, need: got.need };
      }
    } catch (error) {
      return { frames, anchorsHit, stopped: error.message, need: null };
    }
    return { frames, anchorsHit, stopped: null, need: null, end: rel() };
  }
}

const files = process.argv.slice(2);
const replays = files.length ? files : ['testbed/public/replays/agtricks.momtv'];

for (const path of replays) {
  const replay = parseReplay(new Uint8Array(readFileSync(path)));
  console.log(`\n${path}  (${replay.frameCount} frames)`);
  const names = replay.body.classes.map((c) => c.name);
  const specs = new Map();
  const refs = new Map();

  for (let round = 0; round < 60; round++) {
    const probe = new Walk(replay, specs, refs).run(replay.frameCount);
    if (!probe.need) {
      console.log(
        `  walk: ${probe.frames}/${replay.frameCount} frames, ${probe.anchorsHit} anchors` +
          (probe.stopped ? `, stopped: ${probe.stopped}` : ', clean to the end'),
      );
      break;
    }
    const { kind, value } = probe.need;
    // Try every class the replay records, plus leaving the slot unusable.
    const scored = [];
    for (const name of [...names, null]) {
      const trySpecs = new Map(specs);
      const tryRefs = new Map(refs);
      (kind === 'spec' ? trySpecs : tryRefs).set(value, name);
      const got = new Walk(replay, trySpecs, tryRefs).run(probe.frames + LOOKAHEAD);
      scored.push({ name, frames: got.frames, anchors: got.anchorsHit, need: got.need });
    }
    scored.sort((a, b) => b.anchors - a.anchors || b.frames - a.frames);
    const best = scored[0];
    (kind === 'spec' ? specs : refs).set(value, best.name);
    const runnerUp = scored.find((s) => s.name !== best.name);
    console.log(
      `  ${kind} ${value} -> ${best.name ?? '(not recorded)'}  ` +
        `survives ${best.frames} frames; next best ${runnerUp?.name ?? '-'} at ${runnerUp?.frames}`,
    );
  }

  console.log(
    '  recorder class indices:',
    [...specs].map(([k, v]) => `${k}=${v ?? '-'}`).join(' '),
  );
  console.log('  engine class indices:  ', [...refs].map(([k, v]) => `${k}=${v ?? '-'}`).join(' '));
}
