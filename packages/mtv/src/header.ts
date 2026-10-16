import { ByteReader, toBytes } from './byte-reader.js';
import type { Gamemode, ReplayCompression, Style, TrackType } from './enums.js';
import { MtvError } from './error.js';

/** 'MMTV' as a little endian int32. */
export const REPLAY_MAGIC = 0x56544d4d;

/** The only format version this library currently understands. */
export const SUPPORTED_FORMAT_VERSION = 2;

/** Size in bytes of the fixed replay header (packed, little endian). */
export const REPLAY_HEADER_SIZE = 195;

/**
 * The fixed 195 byte header at the start of every .momtv file.
 *
 * Layout mirrors the C++ struct (pragma pack(1), little endian). The
 * official website reader stops at `runTime` and `style`; the counter fields
 * after `runTime` were recovered from the same struct layout and are needed
 * to decode the body.
 */
export interface ReplayHeader {
  /** Always {@link REPLAY_MAGIC} ('MMTV'). */
  magic: number;
  /** Replay format version. This library supports version 2. */
  formatVersion: number;
  /** Unix time in milliseconds when the replay file was written. */
  timestamp: number;
  /** Map file name without extension, for example 'bhop_eazy'. */
  mapName: string;
  /** SHA1 hex digest of the BSP the run was recorded on. */
  mapHash: string;
  /** Gamemode the run was played in. */
  gamemode: Gamemode;
  /** Body compression: 1 means Valve LZMA framing. */
  compression: ReplayCompression;
  /** Seconds per tick, for example 0.01 for bhop (100 ticks per second). */
  tickInterval: number;
  /** Player SteamID64. */
  playerSteamId: bigint;
  /** Player display name at record time. */
  playerName: string;
  /** Track type of the run (main, stage or bonus). */
  trackType: TrackType;
  /** 1-based track number (meaningful for stages and bonuses). */
  trackNum: number;
  /** Final run time in seconds. */
  runTime: number;
  /** Number of delta frames recorded in the body. */
  frameCount: number;
  /** Number of keyframes (full snapshots) recorded in the body. */
  keyFrameCount: number;
  /** Number of entity baselines recorded in the body. */
  baselineCount: number;
  /** Number of entries in the body's networked class table. */
  classCount: number;
  /** Number of entries in the body's temp entity class table. */
  tempEntClassCount: number;
  /** Number of entries in the body's sample table. */
  sampleCount: number;
  /** Bits used to encode a property index in delta frames. */
  propBits: number;
  /** Bits used to encode a temp entity class index. */
  tempEntClassBits: number;
  /** Run style modifier. */
  style: Style;
}

/**
 * Reads the fixed header of a .momtv file.
 *
 * Cheap: looks at the first {@link REPLAY_HEADER_SIZE} bytes only, never
 * touches the compressed body. Use it to list replays without full parsing.
 *
 * @throws {MtvError} `TRUNCATED` if the buffer is too short, `BAD_MAGIC` if
 * it is not a MomentumTV file, `UNSUPPORTED_VERSION` for unknown versions.
 */
export function readHeader(data: ArrayBuffer | Uint8Array): ReplayHeader {
  const r = new ByteReader(toBytes(data));

  const magic = r.i32('magic');
  if (magic !== REPLAY_MAGIC) {
    throw new MtvError(
      'BAD_MAGIC',
      `Not a MomentumTV replay: expected magic 'MMTV', got 0x${(magic >>> 0).toString(16)}`,
    );
  }

  const formatVersion = r.i32('formatVersion');
  if (formatVersion !== SUPPORTED_FORMAT_VERSION) {
    throw new MtvError(
      'UNSUPPORTED_VERSION',
      `Unsupported replay format version ${formatVersion} (supported: ${SUPPORTED_FORMAT_VERSION})`,
    );
  }

  return {
    magic,
    formatVersion,
    timestamp: Number(r.i64('timestamp')),
    mapName: r.fixedString(64, 'mapName'),
    mapHash: r.fixedString(41, 'mapHash'),
    gamemode: r.u8('gamemode'),
    compression: r.u8('compression'),
    tickInterval: r.f32('tickInterval'),
    playerSteamId: r.u64('playerSteamID'),
    playerName: r.fixedString(32, 'playerName'),
    trackType: r.u8('trackType'),
    trackNum: r.u8('trackNum'),
    runTime: r.f64('runTime'),
    frameCount: r.i32('frameCount'),
    keyFrameCount: r.i32('keyFrameCount'),
    baselineCount: r.i32('baselineCount'),
    classCount: r.u8('classCount'),
    tempEntClassCount: r.u8('tempEntClassCount'),
    sampleCount: r.u8('sampleCount'),
    propBits: r.u8('propBits'),
    tempEntClassBits: r.u8('tempEntClassBits'),
    style: r.u8('style'),
  };
}
