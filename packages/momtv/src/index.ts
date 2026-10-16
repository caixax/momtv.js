/**
 * Parser for Momentum Mod replay files (.momtv, MomentumTV).
 *
 * Zero dependencies. Works in browsers, workers and Node.
 *
 * @packageDocumentation
 */

export { MomtvError, type MomtvErrorCode } from './error.js';
export {
  Button,
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
export { BitReader } from './bit-reader.js';
export {
  parseBody,
  type BaselineRecord,
  type GameEventDef,
  type KeyframeIndexEntry,
  type ReplayBody,
  type ReplayClass,
  type ReplaySound,
  type TimelineEvent,
} from './body-sections.js';
export {
  decodePlayerTrack,
  trackStateAt,
  FL_ONGROUND,
  type DecodeStats,
  type PlayerState,
  type PlayerTrack,
} from './player-track.js';
export {
  FrameReader,
  type DecodedProp,
  type EntityUpdate,
  type Frame,
  type FrameReaderOptions,
} from './frame-reader.js';
export { walkFrames } from './frame-walk.js';
export {
  decodeEntityTracks,
  entityStateAt,
  ENTITY_STRIDE,
  type EntityState,
  type EntityTrack,
  type EntityTracks,
} from './entity-track.js';
export {
  readPropValue,
  resolveClassProps,
  type PropEncoding,
  type PropValue,
} from './prop-encoding.js';
export { MomtvReplay, parseReplay } from './replay.js';
