/**
 * Parser for Momentum Mod replay files (.mtv, MomentumTV).
 *
 * Zero dependencies. Works in browsers, workers and Node.
 *
 * @packageDocumentation
 */

export { MtvError, type MtvErrorCode } from './error.js';
export {
  Gamemode,
  GamemodeName,
  ReplayCompression,
  Style,
  StyleName,
  TrackType,
  TrackTypeName,
} from './enums.js';
export {
  readHeader,
  REPLAY_HEADER_SIZE,
  REPLAY_MAGIC,
  SUPPORTED_FORMAT_VERSION,
  type ReplayHeader,
} from './header.js';
export {
  readSplits,
  type RunSegment,
  type RunSplits,
  type RunStats,
  type RunSubsegment,
  type Vec3,
} from './splits.js';
export { decompressBody, VALVE_LZMA_ID } from './body.js';
export { lzmaDecompress, decodeLzmaProperties, type LzmaProperties } from './lzma.js';
export { ByteReader } from './byte-reader.js';
