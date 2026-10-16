import { decompressBody } from './body.js';
import { parseBody, type ReplayBody } from './body-sections.js';
import { readHeader, type ReplayHeader } from './header.js';
import {
  decodePlayerTrack,
  trackStateAt,
  type PlayerState,
  type PlayerTrack,
} from './player-track.js';
import { readSplits, type RunSplits } from './splits.js';
import { toBytes } from './byte-reader.js';
import { decodeEntityTracks, type EntityTrack } from './entity-track.js';

/**
 * A fully parsed replay. Create one with {@link parseReplay}.
 *
 * Header, splits and the body section tables are parsed eagerly; the per-tick
 * player track is decoded lazily on first access and cached.
 */
export class MomtvReplay {
  /** The fixed file header. */
  readonly header: ReplayHeader;
  /** The run splits block. */
  readonly splits: RunSplits;
  /** Parsed body sections (timeline, classes, sounds, events, baselines, keyframes). */
  readonly body: ReplayBody;

  private track_: PlayerTrack | undefined;
  private entities_: EntityTrack[] | undefined;

  /** @internal use {@link parseReplay} */
  constructor(header: ReplayHeader, splits: RunSplits, body: ReplayBody) {
    this.header = header;
    this.splits = splits;
    this.body = body;
  }

  /** Number of recorded delta frames (one per tick). */
  get frameCount(): number {
    return this.header.frameCount;
  }

  /** Seconds per tick. */
  get tickInterval(): number {
    return this.header.tickInterval;
  }

  /** Zone and timer events with their ticks. */
  get events(): ReplayBody['timeline'] {
    return this.body.timeline;
  }

  /** The networked class and property table. */
  get classes(): ReplayBody['classes'] {
    return this.body.classes;
  }

  /**
   * The decoded per-tick player track (struct of arrays). Decoded on first
   * access and cached; prefer this for playback and bulk export.
   */
  toTrack(): PlayerTrack {
    this.track_ ??= decodePlayerTrack(
      this.body,
      this.header.frameCount,
      this.header.tickInterval,
      this.header.propBits,
    );
    return this.track_;
  }

  /** The player state at a tick (clamped to the recorded range). */
  getPlayerState(tick: number): PlayerState {
    return trackStateAt(this.toTrack(), tick);
  }

  /**
   * The recorded entities other than the player: a map's moving parts, as the
   * recorder saw them. Decoded on first access and cached.
   *
   * Only revision 2 bodies are walked frame by frame, so older replays return
   * nothing rather than a guess.
   */
  toEntityTracks(): EntityTrack[] {
    if (this.entities_) return this.entities_;
    if (this.body.revision !== 2) {
      this.entities_ = [];
      return this.entities_;
    }
    try {
      this.entities_ = decodeEntityTracks(
        this.body,
        this.header.frameCount,
        this.header.propBits,
      ).tracks;
    } catch {
      // A body this parser cannot walk simply has no moving parts to show.
      this.entities_ = [];
    }
    return this.entities_;
  }

  /**
   * The player state at a time in seconds, linearly interpolated between the
   * two surrounding ticks (angles interpolated on the shortest arc).
   */
  getPlayerStateAtTime(seconds: number): PlayerState {
    const track = this.toTrack();
    const exact = seconds / this.header.tickInterval;
    const t0 = Math.floor(exact);
    const frac = exact - t0;
    const a = trackStateAt(track, t0);
    if (frac <= 0 || t0 + 1 >= track.frameCount) return a;
    const b = trackStateAt(track, t0 + 1);
    const lerp = (x: number, y: number): number => x + (y - x) * frac;
    const lerpAngle = (x: number, y: number): number => {
      let d = y - x;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      let v = x + d * frac;
      if (v > 180) v -= 360;
      if (v <= -180) v += 360;
      return v;
    };
    return {
      tick: a.tick,
      origin: [
        lerp(a.origin[0], b.origin[0]),
        lerp(a.origin[1], b.origin[1]),
        lerp(a.origin[2], b.origin[2]),
      ],
      eyeAngles: [
        lerpAngle(a.eyeAngles[0], b.eyeAngles[0]),
        lerpAngle(a.eyeAngles[1], b.eyeAngles[1]),
      ],
      viewOffset: [0, 0, lerp(a.viewOffset[2], b.viewOffset[2])],
      velocity: [
        lerp(a.velocity[0], b.velocity[0]),
        lerp(a.velocity[1], b.velocity[1]),
        lerp(a.velocity[2], b.velocity[2]),
      ],
      buttons: a.buttons,
      flags: a.flags,
      onGround: a.onGround,
    };
  }
}

/**
 * Parses a complete .momtv replay: header, splits, LZMA body and all body
 * sections. The per-tick player track is decoded lazily (see
 * {@link MomtvReplay.toTrack}).
 *
 * @param data the raw file contents.
 * @throws {MomtvError} on any malformed input, with a stable `code`.
 */
export function parseReplay(data: ArrayBuffer | Uint8Array): MomtvReplay {
  const bytes = toBytes(data);
  const header = readHeader(bytes);
  const { splits, bodyOffset } = readSplits(bytes);
  const bodyBytes = decompressBody(bytes, header, bodyOffset);
  const body = parseBody(bodyBytes, header);
  return new MomtvReplay(header, splits, body);
}
