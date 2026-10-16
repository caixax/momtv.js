import type { ReplayBody } from './body-sections.js';
import { FrameReader } from './frame-reader.js';
import type { DecodeStats, PlayerTrack } from './player-track.js';

/**
 * Builds the per-tick player track by walking the frames exactly.
 *
 * Every frame is read in full, so a tick's state comes from the bits the
 * recorder wrote for it rather than from a search. The keyframe index is used
 * to resynchronise: it records, for a keyframe at tick T, where the frame for
 * T + 1 starts, and those ticks are the zone events, which is where the run
 * timer sends the properties this parser cannot size yet. So the one place a
 * walk can lose its footing is also the one place the file says where to
 * continue from.
 *
 * A tick whose frame will not decode keeps the previous tick's state, and the
 * count of those is reported in the statistics rather than hidden.
 */

/** x, y, z, pitch, yaw, vx, vy, vz, viewOffsetZ per tick. */
const STRIDE = 9;

/** Degrees per step of an 11 bit angle. */
const ANGLE_STEP = 360 / 2048;

const angle11 = (raw: number): number => {
  const degrees = raw * ANGLE_STEP;
  return degrees > 180 ? degrees - 360 : degrees;
};

/** Running player state, carried from tick to tick. */
interface Live {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  viewOffsetZ: number;
  buttons: number;
  flags: number;
}

const PLAYER = 'CMomentumPlayer';

/** Applies one decoded property to the running state. */
function apply(live: Live, name: string, value: unknown): void {
  switch (name) {
    case 'm_vecOrigin': {
      const [x, y] = value as number[];
      live.x = x!;
      live.y = y!;
      return;
    }
    case 'm_vecOrigin[2]':
      live.z = value as number;
      return;
    case 'm_vecVelocity[0]':
      live.vx = value as number;
      return;
    case 'm_vecVelocity[1]':
      live.vy = value as number;
      return;
    case 'm_vecVelocity[2]':
      live.vz = value as number;
      return;
    case 'm_angEyeAngles[0]':
      live.pitch = angle11(value as number);
      return;
    case 'm_angEyeAngles[1]':
      live.yaw = angle11(value as number);
      return;
    case 'm_vecViewOffset[2]':
      // Quantised over the 0 to 128 unit range the table declares.
      live.viewOffsetZ = ((value as number) * 128) / 1024;
      return;
    case 'm_nPhysicalButtons':
      live.buttons = (value as number) >>> 0;
      return;
    case 'm_fFlags':
      live.flags = (value as number) >>> 0;
      return;
    default:
      return;
  }
}

/**
 * Decodes the track of a revision 2 body by walking its frames.
 *
 * @param body - parsed body sections
 * @param frameCount - ticks the header declares
 * @param tickInterval - seconds per tick
 * @param propBits - bits a property index takes, from the header
 * @param startTick - tick the run starts on, for the returned track
 */
export function decodeTrackExact(
  body: ReplayBody,
  frameCount: number,
  tickInterval: number,
  propBits: number,
  startTick: number,
): PlayerTrack {
  const reader = new FrameReader(body, propBits, {
    wanted: (className) => className === PLAYER,
  });
  reader.seedFromKeyframe();

  // For a keyframe at tick T the index records where the frame for T + 1
  // starts, since playback reads the keyframe and the next frame advances the
  // tick.
  const anchors = new Map<number, number>();
  for (const entry of body.keyframeIndex) {
    if (entry.frameOffset >= 0) anchors.set(entry.tick + 1, entry.frameOffset);
  }

  const data = new Float32Array(frameCount * STRIDE);
  const buttons = new Uint32Array(frameCount);
  const flags = new Uint16Array(frameCount);
  const stats: DecodeStats = { frames: 0, resyncs: 0, recovered: 0, lostFrames: 0 };

  const live: Live = {
    x: 0,
    y: 0,
    z: 0,
    pitch: 0,
    yaw: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    viewOffsetZ: 0,
    buttons: 0,
    flags: 0,
  };
  let adrift = false;

  for (let tick = 0; tick < frameCount; tick++) {
    const anchor = anchors.get(tick);
    if (anchor !== undefined && (adrift || reader.bitPos !== anchor * 8)) {
      reader.seekBit(anchor * 8);
      if (adrift) stats.recovered++;
      else stats.resyncs++;
      adrift = false;
    }
    if (!adrift) {
      try {
        const frame = reader.readFrame();
        for (const update of frame.updates) {
          if (update.className !== PLAYER) continue;
          for (const prop of update.props) apply(live, prop.name, prop.value);
        }
        stats.frames++;
      } catch {
        // The frame cannot be read, so hold the state until the next anchor
        // rather than guess at the bits.
        adrift = true;
      }
    }
    if (adrift) stats.lostFrames++;

    const at = tick * STRIDE;
    data[at] = live.x;
    data[at + 1] = live.y;
    data[at + 2] = live.z;
    data[at + 3] = live.pitch;
    data[at + 4] = live.yaw;
    data[at + 5] = live.vx;
    data[at + 6] = live.vy;
    data[at + 7] = live.vz;
    data[at + 8] = live.viewOffsetZ;
    buttons[tick] = live.buttons;
    flags[tick] = live.flags & 0xffff;
  }

  return { tickInterval, frameCount, startTick, data, buttons, flags, stats };
}
