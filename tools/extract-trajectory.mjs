// Extracts the full player trajectory from the fixture replay by walking all
// delta frames. Validates with the recorded velocity oracle and the keyframe
// index. Writes tools/out/trajectory.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { BitReader } from './bitreader.mjs';

const body = readFileSync(new URL('./out/body.bin', import.meta.url));
const FRAME_BASE = 0x443c;
const FRAME_LEN = 139288;
const TICK_INTERVAL = 0.01;
const FRAME_COUNT = 3386;

const dv = new DataView(new ArrayBuffer(4));
const f32 = (r) => {
  dv.setUint32(0, r.readBits(32), true);
  return dv.getFloat32(0, true);
};
const plausibleCoord = (v) => Number.isFinite(v) && Math.abs(v) <= 20000;
const plausibleVel = (v) => Number.isFinite(v) && Math.abs(v) <= 4000;

// Player prop decoders by class-table index. Returns null on implausible data.
const PLAYER = {
  0: (r) => ['bSimulatedEveryTick', r.readBits(1)],
  1: (r) => ['fEffects', r.readBits(15)],
  2: (r) => {
    const x = f32(r);
    const y = f32(r);
    return plausibleCoord(x) && plausibleCoord(y) ? ['originXY', [x, y]] : null;
  },
  3: (r) => {
    const z = f32(r);
    return plausibleCoord(z) ? ['originZ', z] : null;
  },
  4: (r) => ['mins', [f32(r), f32(r), f32(r)]],
  5: (r) => ['maxs', [f32(r), f32(r), f32(r)]],
  6: (r) => ['modelIndex', r.readBits(13)],
  7: (r) => ['body', r.readBits(32)],
  8: (r) => ['clrPrimary', r.readBits(32)],
  9: (r) => ['clrSecondary', r.readBits(32)],
  10: (r) => ['rotation', [r.readBits(13), r.readBits(13), r.readBits(13)]],
  11: (r) => ['eyePitch', r.readBits(11)],
  12: (r) => ['eyeYaw', r.readBits(11)],
  13: (r) => ['bClientSideAnimation', r.readBits(1)],
  14: (r) => ['viewOffsetX', -32 + (r.readBits(8) * 64) / 256],
  15: (r) => ['viewOffsetY', -32 + (r.readBits(8) * 64) / 256],
  16: (r) => ['viewOffsetZ', (r.readBits(10) * 128) / 1024],
  17: (r) => ['hViewModel', r.readBits(23)],
  18: (r) => {
    const v = f32(r);
    return plausibleVel(v) ? ['velX', v] : null;
  },
  19: (r) => {
    const v = f32(r);
    return plausibleVel(v) ? ['velY', v] : null;
  },
  20: (r) => {
    const v = f32(r);
    return plausibleVel(v) ? ['velZ', v] : null;
  },
  21: (r) => ['buttons', r.readBits(32)],
  22: (r) => ['btnDisabled', r.readBits(32)],
  23: (r) => ['btnForced', r.readBits(32)],
  24: (r) => ['btnToggled', r.readBits(32)],
  25: (r) => ['flags', r.readBits(11)],
};

// Parses a frame whose first entity block is the player (the common case).
function parsePlayerFrame(byteOffset) {
  const r = new BitReader(body, FRAME_BASE + byteOffset);
  const a = r.readBits(6);
  if (a === 0 || a > 40) return null;
  const ent = r.readUBitVar();
  if (ent !== 0) return null;
  const two = r.readBits(2);
  if (two === 2) return { props: {}, endBit: r.bitPos, empty: true };
  if (two !== 0) return null;
  const count = r.readUBitVar();
  if (count > 26) return null;
  const props = {};
  for (let i = 0; i < count; i++) {
    const idx = r.readBits(5);
    const dec = PLAYER[idx];
    if (!dec) return null;
    const decoded = dec(r);
    if (!decoded) return null;
    props[decoded[0]] = decoded[1];
  }
  return { props, endBit: r.bitPos };
}

// Searches a bit range for a player block (used when another entity's block
// comes first in a zone-event frame).
function findPlayerBlockWithin(startBit, endBit) {
  for (let bit = startBit; bit < endBit; bit++) {
    const r = new BitReader(body, 0);
    r.bitPos = bit;
    const ent = r.readBits(6);
    const two = r.readBits(2);
    if (ent !== 0 || two !== 0) continue;
    const count = r.readUBitVar();
    if (count === 0 || count > 26) continue;
    const props = {};
    let ok = true;
    let hasCore = false;
    for (let i = 0; i < count; i++) {
      const idx = r.readBits(5);
      const dec = PLAYER[idx];
      const decoded = dec ? dec(r) : null;
      if (!decoded) {
        ok = false;
        break;
      }
      props[decoded[0]] = decoded[1];
      if (decoded[0] === 'originXY' || decoded[0] === 'velX') hasCore = true;
    }
    if (ok && hasCore && r.bitPos <= endBit) return props;
  }
  return null;
}

// Authoritative frame offsets from the keyframe index: tick -> byte offset.
const KF_FRAME_OFFS = new Map([
  [1, 35],
  [24, 895],
  [1065, 44697],
  [1080, 45305],
  [1807, 74622],
  [1820, 75121],
  [2469, 101556],
  [2480, 101992],
]);

function scanNextFrame(fromByte) {
  for (let b = fromByte; b < fromByte + 4096 && b + 1 < FRAME_LEN; b++) {
    const b0 = body[FRAME_BASE + b];
    const b1 = body[FRAME_BASE + b + 1];
    if (b0 === 0 || (b0 & 0xc0) !== 0) continue; // 6-bit A, ent must start 00
    if ((b1 & 0x0f) !== 0) continue; // rest of ent UBitVar must be 0
    if (parsePlayerFrame(b)) return b;
  }
  return -1;
}

const frames = [];
const emptyTicks = [];
let offset = 0;
let rescued = 0;
let empties = 0;
for (let tick = 0; tick < FRAME_COUNT; tick++) {
  if (KF_FRAME_OFFS.has(tick)) offset = KF_FRAME_OFFS.get(tick);
  const parsed = parsePlayerFrame(offset);
  if (parsed) {
    if (parsed.empty) {
      empties++;
      emptyTicks.push(tick);
    }
    frames.push({ tick, offset, props: parsed.props });
    const nextKf = KF_FRAME_OFFS.get(tick + 1);
    const next =
      nextKf !== undefined ? nextKf : scanNextFrame(Math.ceil(parsed.endBit / 8) - FRAME_BASE);
    if (next === -1) {
      if (tick !== FRAME_COUNT - 1) console.error(`tick ${tick}: no next frame found`);
      break;
    }
    offset = next;
  } else {
    // zone-event frame: player block is not first; bounded search up to the
    // next authoritative offset
    const bound = KF_FRAME_OFFS.get(tick + 1);
    const boundBit =
      bound !== undefined ? (FRAME_BASE + bound) * 8 : (FRAME_BASE + offset + 600) * 8;
    const props = findPlayerBlockWithin((FRAME_BASE + offset) * 8 + 6, boundBit);
    if (props) rescued++;
    else console.error(`tick ${tick}: player block not found (offset ${offset})`);
    frames.push({ tick, offset, props: props ?? {} });
    const next = bound !== undefined ? bound : scanNextFrame(offset + 2);
    if (next === -1) {
      if (tick !== FRAME_COUNT - 1)
        console.error(`tick ${tick}: no next frame found after zone frame`);
      break;
    }
    offset = next;
  }
}

console.log(
  `parsed ${frames.length}/${FRAME_COUNT} frames, zone rescues: ${rescued}, empty frames: ${empties}`,
);

// Reconstruct absolute state per tick and run the oracles
let state = {
  x: NaN,
  y: NaN,
  z: 64.03125, // baseline origin z
  vx: 0,
  vy: 0,
  vz: 0,
  pitch: 0,
  yaw: 0,
  buttons: 0,
  flags: 256,
};
const track = [];
for (const f of frames) {
  const p = f.props;
  if (p.originXY) {
    state.x = p.originXY[0];
    state.y = p.originXY[1];
  }
  if (p.originZ !== undefined) state.z = p.originZ;
  if (p.velX !== undefined) state.vx = p.velX;
  if (p.velY !== undefined) state.vy = p.velY;
  if (p.velZ !== undefined) state.vz = p.velZ;
  if (p.eyePitch !== undefined) state.pitch = p.eyePitch;
  if (p.eyeYaw !== undefined) state.yaw = p.eyeYaw;
  if (p.buttons !== undefined) state.buttons = p.buttons;
  if (p.flags !== undefined) state.flags = p.flags;
  track.push({ tick: f.tick, ...state });
}

let oracleChecks = 0;
let oracleFails = 0;
let maxErr = 0;
const failTicks = [];
for (let i = 1; i < track.length; i++) {
  const prev = track[i - 1];
  const cur = track[i];
  const dx = cur.x - prev.x;
  const dy = cur.y - prev.y;
  if (Math.hypot(prev.vx, prev.vy) > 1) {
    const err = Math.hypot(dx - prev.vx * TICK_INTERVAL, dy - prev.vy * TICK_INTERVAL);
    oracleChecks++;
    if (err > maxErr) maxErr = err;
    if (err > 1.0) {
      oracleFails++;
      failTicks.push(cur.tick);
    }
  }
}
console.log(
  `velocity oracle: ${oracleChecks} checks, ${oracleFails} fails (>1 unit), max err ${maxErr.toFixed(4)}`,
);
{
  const emptySet = new Set(emptyTicks);
  let near = 0;
  const far = [];
  for (const t of failTicks) {
    let isNear = false;
    for (let d = -4; d <= 4; d++) if (emptySet.has(t + d)) isNear = true;
    if (isNear) near++;
    else far.push(t);
  }
  console.log('fails near an empty frame (+-4 ticks):', near, '/', failTicks.length);
  console.log('fails far from empties:', far.join(','));
}
console.log('first:', JSON.stringify(track[0]));
console.log('last:', JSON.stringify(track[track.length - 1]));

writeFileSync(new URL('./out/trajectory.json', import.meta.url), JSON.stringify(track));
console.log('wrote tools/out/trajectory.json');
