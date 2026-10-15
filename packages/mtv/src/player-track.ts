import { BitReader } from './bit-reader.js';
import type { ReplayBody } from './body-sections.js';
import { MtvError } from './error.js';

/**
 * Decoded per-tick player state. Angles are degrees, positions and
 * velocities in map units (and units per second).
 */
export interface PlayerState {
  tick: number;
  origin: [number, number, number];
  /** Eye angles: [pitch, yaw], degrees, normalized to (-180, 180]. */
  eyeAngles: [number, number];
  viewOffset: [number, number, number];
  velocity: [number, number, number];
  /** IN_* button bits (m_nPhysicalButtons). */
  buttons: number;
  /** FL_* flag bits (m_fFlags). */
  flags: number;
  /** Convenience: FL_ONGROUND bit of flags. */
  onGround: boolean;
}

/** Statistics from the frame decoding pass, useful for diagnostics. */
export interface DecodeStats {
  /** Frames decoded (should equal the header frameCount). */
  frames: number;
  /** Ticks where the walker position disagreed with a keyframe anchor. */
  resyncs: number;
  /** Ticks recovered by scanning after a frame failed to parse in place. */
  recovered: number;
  /** Ticks where no player data could be recovered (state carried over). */
  lostFrames: number;
}

/** Compact playback track (struct of arrays, one entry per tick). */
export interface PlayerTrack {
  tickInterval: number;
  frameCount: number;
  /** Tick of the run start (type 2 timeline event with zoneFlag 3), or 0. */
  startTick: number;
  /** x,y,z,pitch,yaw,vx,vy,vz,viewOffsetZ per tick (stride 9). */
  data: Float32Array;
  buttons: Uint32Array;
  flags: Uint16Array;
  stats: DecodeStats;
}

const STRIDE = 9;

/** Field widths and shapes for the player properties, keyed by name. */
type PropDecoder = (r: BitReader, s: MutableState) => void;

interface MutableState {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  vox: number;
  voy: number;
  voz: number;
  buttons: number;
  flags: number;
}

const angle11 = (raw: number): number => {
  let deg = (raw * 360) / 2048;
  if (deg > 180) deg -= 360;
  return deg;
};

const plausibleCoord = (v: number): boolean => Number.isFinite(v) && Math.abs(v) <= 65536;
const plausibleVel = (v: number): boolean => Number.isFinite(v) && Math.abs(v) <= 20000;

function bad(message: string): never {
  throw new MtvError('BAD_BODY', message);
}

/**
 * Decoders for CMomentumPlayer properties, by property name as stored in the
 * replay's class table. Unknown names make the frame parser fall back to
 * resynchronization, so new properties in future game builds degrade
 * gracefully instead of corrupting the whole decode.
 */
const PLAYER_PROP_DECODERS: Record<string, PropDecoder> = {
  m_bSimulatedEveryTick: (r) => void r.readBits(1),
  m_fEffects: (r) => void r.readBits(15),
  m_vecOrigin: (r, s) => {
    const x = r.readFloat32();
    const y = r.readFloat32();
    if (!plausibleCoord(x) || !plausibleCoord(y)) bad('implausible origin');
    s.x = x;
    s.y = y;
  },
  'm_vecOrigin[2]': (r, s) => {
    const z = r.readFloat32();
    if (!plausibleCoord(z)) bad('implausible origin z');
    s.z = z;
  },
  m_vecMinsPreScaled: (r) => {
    r.readFloat32();
    r.readFloat32();
    r.readFloat32();
  },
  m_vecMaxsPreScaled: (r) => {
    r.readFloat32();
    r.readFloat32();
    r.readFloat32();
  },
  m_nModelIndex: (r) => void r.readBits(13),
  m_nBody: (r) => void r.readBits(32),
  m_clrModelPrimary: (r) => void r.readBits(32),
  m_clrModelSecondary: (r) => void r.readBits(32),
  m_angRotation: (r) => {
    r.readBits(13);
    r.readBits(13);
    r.readBits(13);
  },
  'm_angEyeAngles[0]': (r, s) => {
    s.pitch = angle11(r.readBits(11));
  },
  'm_angEyeAngles[1]': (r, s) => {
    s.yaw = angle11(r.readBits(11));
  },
  m_bClientSideAnimation: (r) => void r.readBits(1),
  'm_vecViewOffset[0]': (r, s) => {
    s.vox = -32 + (r.readBits(8) * 64) / 256;
  },
  'm_vecViewOffset[1]': (r, s) => {
    s.voy = -32 + (r.readBits(8) * 64) / 256;
  },
  'm_vecViewOffset[2]': (r, s) => {
    s.voz = (r.readBits(10) * 128) / 1024;
  },
  m_hViewModel: (r) => void r.readBits(23),
  'm_vecVelocity[0]': (r, s) => {
    const v = r.readFloat32();
    if (!plausibleVel(v)) bad('implausible velocity');
    s.vx = v;
  },
  'm_vecVelocity[1]': (r, s) => {
    const v = r.readFloat32();
    if (!plausibleVel(v)) bad('implausible velocity');
    s.vy = v;
  },
  'm_vecVelocity[2]': (r, s) => {
    const v = r.readFloat32();
    if (!plausibleVel(v)) bad('implausible velocity');
    s.vz = v;
  },
  m_nPhysicalButtons: (r, s) => {
    s.buttons = r.readBits(32);
  },
  m_afButtonDisabled: (r) => void r.readBits(32),
  m_afButtonForced: (r) => void r.readBits(32),
  m_nButtonsToggled: (r) => void r.readBits(32),
  m_fFlags: (r, s) => {
    s.flags = r.readBits(11);
  },
};

/** The class name the player entity uses in the replay class table. */
const PLAYER_CLASS = 'CMomentumPlayer';

/**
 * Decodes the per-tick player track from the body's frame data.
 *
 * Uses the keyframe index for authoritative resynchronization (keyframes sit
 * exactly on zone-event ticks where frames start with a zone entity block
 * instead of the player).
 */
export function decodePlayerTrack(
  body: ReplayBody,
  frameCount: number,
  tickInterval: number,
): PlayerTrack {
  const playerClass = body.classes.find((c) => c.name === PLAYER_CLASS);
  if (!playerClass) {
    throw new MtvError('BAD_BODY', `Replay has no ${PLAYER_CLASS} class`);
  }
  const decoders: (PropDecoder | undefined)[] = playerClass.props.map(
    (name) => PLAYER_PROP_DECODERS[name],
  );

  const bytes = body.bytes;
  const base = body.frameData.offset;
  const dataLen = body.frameData.length;

  // authoritative tick -> frame byte offset map from the keyframe index
  const anchors = new Map<number, number>();
  for (const kf of body.keyframeIndex) {
    if (kf.frameOffset < dataLen) anchors.set(kf.tick + 1, kf.frameOffset);
  }

  const state: MutableState = {
    x: NaN,
    y: NaN,
    z: NaN,
    pitch: 0,
    yaw: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    vox: 0,
    voy: 0,
    voz: 64,
    buttons: 0,
    flags: 0,
  };

  // Seed the initial state from the player's baseline record. The baseline
  // holds every property with ascending indices; decoding stops cleanly at
  // the first property with an unknown encoding (m_hViewModel is an array
  // whose baseline layout is not mapped yet), which still covers origin,
  // angles and view offset.
  const playerBaseline = body.baselines.find((b) => b.classId === playerClass.classId);
  if (playerBaseline) {
    try {
      const r = new BitReader(bytes, playerBaseline.payloadOffset, playerBaseline.payloadLength);
      r.readUBitVar(); // class id
      const f1 = r.readBit();
      const f2 = r.readBit();
      if (f1) r.readUBitVar(); // simulation time delta
      if (f2) r.readUBitVar(); // animation time delta
      let last = -1;
      while (r.remainingBits >= 8) {
        const idx = r.readBits(5);
        if (idx <= last || idx >= playerClass.props.length) break;
        last = idx;
        const dec = decoders[idx];
        if (!dec) break;
        dec(r, state);
      }
    } catch (error) {
      if (!(error instanceof MtvError)) throw error;
      // partial seed is fine; frames fill in the rest
    }
  }

  // Every tick has exactly one frame record; frames always start with the
  // player entity block (entity 0, flag bits 0). The leading 6-bit block
  // count is constant for a replay (4 in the sample: player, viewmodel and
  // both weapons) except on ticks where extra entities update, where it grows
  // by the number of extra blocks. Frame starts are validated by parsing plus
  // a successor check.
  let learnedA = -1;

  // Parses a frame at a byte offset. Returns the end bit position of the
  // player block, or null if the bytes do not form a frame.
  const parsePlayerFrame = (
    byteOffset: number,
  ): { endBit: number; scratch: MutableState } | null => {
    try {
      const r = new BitReader(bytes, base + byteOffset, dataLen - byteOffset);
      const blockCount = r.readBits(6);
      if (learnedA === -1) {
        if (blockCount === 0 || blockCount > 48) return null;
      } else if (blockCount < learnedA || blockCount > learnedA + 2) {
        return null;
      }
      if (r.readUBitVar() !== 0) return null;
      if (r.readBits(2) !== 0) return null;
      const propCount = r.readUBitVar();
      if (propCount > playerClass.props.length) return null;
      const scratch = { ...state };
      for (let i = 0; i < propCount; i++) {
        const idx = r.readBits(5);
        const dec = decoders[idx];
        if (!dec) return null;
        dec(r, scratch);
      }
      if (learnedA === -1) learnedA = blockCount;
      return { endBit: r.bitPos, scratch };
    } catch (error) {
      if (error instanceof MtvError) return null;
      throw error;
    }
  };

  // Scans forward for the next byte offset that parses as a frame. A real
  // frame must be followed by another frame (or the end of the data) within a
  // short distance, which filters out frame-shaped bits inside the interleaved
  // sound and game event records.
  const scanCandidate = (fromByte: number, limitBytes: number): number => {
    const limit = Math.min(fromByte + limitBytes, dataLen - 1);
    for (let b = fromByte; b < limit; b++) {
      const b0 = bytes[base + b]!;
      if (learnedA !== -1 ? b0 < learnedA || b0 > learnedA + 2 : b0 === 0 || (b0 & 0xc0) !== 0)
        continue;
      const b1 = bytes[base + b + 1]!;
      if ((b1 & 0x3f) !== 0) continue;
      if (parsePlayerFrame(b)) return b;
    }
    return -1;
  };

  const NEAR = 512;
  const scanNextFrame = (fromByte: number): number => {
    let from = fromByte;
    for (let tries = 0; tries < 8; tries++) {
      const b = scanCandidate(from, 4096);
      if (b === -1) return -1;
      const parsed = parsePlayerFrame(b)!;
      const after = Math.ceil(parsed.endBit / 8) - base;
      if (after >= dataLen - 8) return b; // last frame of the data
      if (scanCandidate(after, NEAR) !== -1) return b;
      from = b + 1; // frame-shaped garbage: skip it
    }
    return -1;
  };

  // Keyframes snapshot extra properties (buttons, flags) that delta frames
  // rarely carry. Their player block uses ascending property indices with no
  // count; it is located by search inside each keyframe's byte range and
  // applied on top of the frame state at that tick.
  const kfRanges = new Map<number, { from: number; to: number }>();
  for (let i = 0; i < body.keyframeIndex.length; i++) {
    const kf = body.keyframeIndex[i]!;
    const next = body.keyframeIndex[i + 1];
    kfRanges.set(kf.tick, {
      from: body.keyframeData.offset + kf.keyframeOffset,
      to: body.keyframeData.offset + (next ? next.keyframeOffset : body.keyframeData.length),
    });
  }

  const applyKeyframeBlock = (range: { from: number; to: number }): boolean => {
    const endBit = Math.min(range.to, body.keyframeData.offset + body.keyframeData.length) * 8;
    let best: MutableState | null = null;
    let bestProps = 0;
    for (let bit = range.from * 8; bit < endBit; bit++) {
      try {
        const r = new BitReader(bytes, 0, bytes.length);
        r.bitPos = bit;
        if (r.readBits(6) !== 0) continue;
        if (r.readBits(2) !== 0) continue;
        const scratch = { ...state };
        let last = -1;
        let props = 0;
        let core = false;
        while (r.bitPos + 5 <= endBit) {
          const peek = r.bitPos;
          const idx = r.readBits(5);
          const dec = decoders[idx];
          if (idx <= last || !dec) {
            r.bitPos = peek;
            break;
          }
          dec(r, scratch);
          last = idx;
          props++;
          const name = playerClass.props[idx]!;
          if (name === 'm_vecOrigin' || name === 'm_vecVelocity[0]') core = true;
        }
        if (props >= 3 && core && props > bestProps) {
          bestProps = props;
          best = scratch;
        }
      } catch {
        // scan on
      }
    }
    if (best) {
      Object.assign(state, best);
      return true;
    }
    return false;
  };

  const data = new Float32Array(frameCount * STRIDE);
  const buttons = new Uint32Array(frameCount);
  const flags = new Uint16Array(frameCount);
  const stats: DecodeStats = { frames: 0, resyncs: 0, recovered: 0, lostFrames: 0 };

  // A decoded frame whose position leaps far beyond what the current
  // velocity allows is treated as suspect (unless anchored).
  const continuityBreak = (next: MutableState): boolean => {
    if (!Number.isFinite(state.x)) return false;
    const dt = tickInterval;
    const speed = Math.hypot(state.vx, state.vy, state.vz);
    const limit = Math.max(300, speed * dt * 10);
    const dx = next.x - (state.x + state.vx * dt);
    const dy = next.y - (state.y + state.vy * dt);
    const dz = next.z - (state.z + state.vz * dt);
    return Math.hypot(dx, dy, dz) > limit;
  };

  let offset = 0;
  for (let tick = 0; tick < frameCount; tick++) {
    const anchored = anchors.get(tick);
    if (anchored !== undefined) {
      if (tick > 0 && offset !== anchored) stats.resyncs++;
      offset = anchored;
    }

    let parsed = parsePlayerFrame(offset);
    if (!parsed) {
      // unexpected bytes in place of the frame: scan forward a little
      const rescue = scanNextFrame(offset + 1);
      if (rescue !== -1) {
        parsed = parsePlayerFrame(rescue);
        if (parsed) {
          stats.recovered++;
          offset = rescue;
        }
      }
      if (!parsed) stats.lostFrames++;
    } else if (anchored === undefined && continuityBreak(parsed.scratch)) {
      // a frame-shaped region inside an interleaved record can decode with a
      // wild position jump; prefer a nearby candidate that stays continuous
      const alt = scanNextFrame(offset + 1);
      if (alt !== -1) {
        const altParsed = parsePlayerFrame(alt);
        if (altParsed && !continuityBreak(altParsed.scratch)) {
          parsed = altParsed;
          offset = alt;
          stats.recovered++;
        }
      }
    }
    if (parsed) Object.assign(state, parsed.scratch);
    let next = -1;
    {
      const nextAnchor = anchors.get(tick + 1);
      next =
        nextAnchor !== undefined
          ? nextAnchor
          : scanNextFrame(parsed ? Math.ceil(parsed.endBit / 8) - base : offset + 2);
    }

    const kfRange = kfRanges.get(tick);
    if (kfRange) applyKeyframeBlock(kfRange);

    const o = tick * STRIDE;
    data[o] = state.x;
    data[o + 1] = state.y;
    data[o + 2] = state.z;
    data[o + 3] = state.pitch;
    data[o + 4] = state.yaw;
    data[o + 5] = state.vx;
    data[o + 6] = state.vy;
    data[o + 7] = state.vz;
    data[o + 8] = state.voz;
    buttons[tick] = state.buttons;
    flags[tick] = state.flags;
    stats.frames++;

    if (next === -1) {
      if (tick < frameCount - 1) {
        // cannot find the next frame: stop here, remaining ticks keep the
        // last state (recorded in stats as lost)
        stats.lostFrames += frameCount - 1 - tick;
        for (let t = tick + 1; t < frameCount; t++) {
          data.copyWithin(t * STRIDE, o, o + STRIDE);
          buttons[t] = state.buttons;
          flags[t] = state.flags;
        }
      }
      break;
    }
    offset = next;
  }

  const runStart = body.timeline.find((e) => e.type === 2 && e.zoneFlag === 3);
  return {
    tickInterval,
    frameCount,
    startTick: runStart?.tick ?? 0,
    data,
    buttons,
    flags,
    stats,
  };
}

/** FL_ONGROUND bit in m_fFlags. */
export const FL_ONGROUND = 1 << 0;

/** Reads one tick's state out of a decoded track. */
export function trackStateAt(track: PlayerTrack, tick: number): PlayerState {
  const t = Math.max(0, Math.min(track.frameCount - 1, Math.floor(tick)));
  const o = t * STRIDE;
  const d = track.data;
  const flags = track.flags[t]!;
  return {
    tick: t,
    origin: [d[o]!, d[o + 1]!, d[o + 2]!],
    eyeAngles: [d[o + 3]!, d[o + 4]!],
    viewOffset: [0, 0, d[o + 8]!],
    velocity: [d[o + 5]!, d[o + 6]!, d[o + 7]!],
    buttons: track.buttons[t]!,
    flags,
    onGround: (flags & FL_ONGROUND) !== 0,
  };
}
