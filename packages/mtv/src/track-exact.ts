import type { ReplayBody } from './body-sections.js';
import { walkFrames } from './frame-walk.js';
import type { PlayerTrack } from './player-track.js';

/**
 * Builds the per-tick player track by walking the frames exactly.
 *
 * A tick whose frame will not decode keeps the previous tick's state, and the
 * count of those is reported in the statistics rather than hidden. See
 * {@link walkFrames} for how the walk keeps in step with the file.
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
  const data = new Float32Array(frameCount * STRIDE);
  const buttons = new Uint32Array(frameCount);
  const flags = new Uint16Array(frameCount);

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

  const stats = walkFrames(
    body,
    frameCount,
    propBits,
    { wanted: (className) => className === PLAYER },
    (tick, frame) => {
      for (const update of frame?.updates ?? []) {
        if (update.className !== PLAYER) continue;
        for (const prop of update.props) apply(live, prop.name, prop.value);
      }
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
    },
  );

  return { tickInterval, frameCount, startTick, data, buttons, flags, stats };
}
