import { ByteReader, toBytes } from './byte-reader.js';
import { MtvError } from './error.js';
import { REPLAY_HEADER_SIZE } from './header.js';

/** A 3D vector as serialized in the splits JSON. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Stats for a whole run or a single segment. */
export interface RunStats {
  maxOverallSpeed: number;
  maxHorizontalSpeed: number;
  overallDistanceTravelled: number;
  horizontalDistanceTravelled: number;
  jumps: number;
  strafes: number;
}

/**
 * A subsegment begins at the checkpoint zone with `minorNum` and ends when
 * another checkpoint zone is activated. The very first subsegment of a run
 * has `timeReached` 0.
 */
export interface RunSubsegment {
  minorNum: number;
  timeReached: number;
  /** Velocity when triggering this checkpoint. */
  velocityWhenReached: Vec3;
  stats: RunStats;
}

/** One major segment (stage) of the run. */
export interface RunSegment {
  /** One entry for every subsegment the player reached. */
  subsegments: RunSubsegment[];
  segmentStats: RunStats;
  /** Velocity when leaving the segment's start zone. */
  effectiveStartVelocity: Vec3;
  /** Whether this segment's checkpoints have a logical order. */
  checkpointsOrdered: boolean;
}

/** The run splits JSON block stored after the fixed header. */
export interface RunSplits {
  trackStats: RunStats;
  segments: RunSegment[];
}

/** Maximum accepted size for the splits JSON block (defensive bound). */
const MAX_SPLITS_LENGTH = 4 * 1024 * 1024;

/**
 * Reads the run splits JSON block that follows the fixed header.
 *
 * Layout: `int32 length` at offset {@link REPLAY_HEADER_SIZE}, then `length`
 * bytes of JSON text whose last byte is a NUL terminator.
 *
 * @returns the parsed splits and the absolute offset where the compressed
 * body starts.
 * @throws {MtvError} `TRUNCATED` or `BAD_SPLITS` on malformed input.
 */
export function readSplits(data: ArrayBuffer | Uint8Array): {
  splits: RunSplits;
  bodyOffset: number;
} {
  const r = new ByteReader(toBytes(data));
  r.seek(REPLAY_HEADER_SIZE);

  const length = r.i32('splits length');
  if (length <= 0 || length > MAX_SPLITS_LENGTH) {
    throw new MtvError('BAD_SPLITS', `Splits block has implausible length ${length}`);
  }

  const raw = r.raw(length, 'splits JSON');
  if (raw[length - 1] !== 0) {
    throw new MtvError('BAD_SPLITS', 'Splits block is not NUL terminated');
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(0, length - 1));
  if (!text.endsWith('}')) {
    throw new MtvError('BAD_SPLITS', 'Splits JSON does not end with a closing brace');
  }

  let splits: RunSplits;
  try {
    splits = JSON.parse(text) as RunSplits;
  } catch (error) {
    throw new MtvError('BAD_SPLITS', `Splits JSON failed to parse: ${(error as Error).message}`);
  }

  return { splits, bodyOffset: r.pos };
}
