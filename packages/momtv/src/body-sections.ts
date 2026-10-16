import { BitReader } from './bit-reader.js';
import { ByteReader } from './byte-reader.js';
import { MomtvError } from './error.js';
import type { ReplayHeader } from './header.js';

/** One record of the body's event timeline (zone and timer events). */
export interface TimelineEvent {
  /** Replay tick the event happened on. */
  tick: number;
  /** Zone transition flag. Observed: 0, 1 (start), 2 (enter), 3 (exit). */
  zoneFlag: number;
  /** Track number, matches the header. */
  trackNum: number;
  /** Event type: 1 initial, 2 mid-run split, 3 finish. */
  type: number;
  /** Run timer value at the event, in seconds. */
  time: number;
  /** Segment (major checkpoint) number. */
  majorNum: number;
  /** Minor checkpoint number. */
  minorNum: number;
}

/** An entry of the networked class table. */
export interface ReplayClass {
  /** Network class id used in the bit stream (not contiguous). */
  classId: number;
  /** Class name, for example 'CMomentumPlayer'. */
  name: string;
  /** Property names in index order; indices in the bit stream refer to this list. */
  props: string[];
}

/** An entry of the sound table. */
export interface ReplaySound {
  soundIndex: number;
  path: string;
}

/** A game event definition from the protobuf event list. */
export interface GameEventDef {
  eventId: number;
  name: string;
  keys: { type: number; name: string }[];
}

/** One entity baseline record (payload left undecoded at this level). */
export interface BaselineRecord {
  /** The i32 header field, 275 for most records in the known sample. */
  tick: number;
  /** Entity ordinal (contiguous from 0). */
  entity: number;
  /** Network class id. */
  classId: number;
  /** Bit position of the property payload inside the body. */
  payloadBitOffset: number;
  /** Exact payload length in bits, as stored in the record. */
  payloadBits: number;
  /** Byte offset of the payload (the bit offset rounded down). */
  payloadOffset: number;
  /** Payload length in bytes, rounded up from the bit length. */
  payloadLength: number;
}

/** One keyframe index entry. */
export interface KeyframeIndexEntry {
  /** Tick the keyframe snapshots (these sit on timeline event ticks). */
  tick: number;
  /** Byte offset of the keyframe inside the keyframe data section. */
  keyframeOffset: number;
  /** Byte offset inside the frame data of the frame for `tick + 1`. */
  frameOffset: number;
}

/** All parsed sections of a decompressed replay body. */
export interface ReplayBody {
  /**
   * Body layout revision. Both carry formatVersion 2 in the header: revision
   * 1 is written by builds up to early 2025 (18 byte timeline records with a
   * run-timer double, explicit baseline records), revision 2 by current
   * playtest builds (compact timeline, baselines folded into the keyframes).
   */
  revision: 1 | 2;
  timeline: TimelineEvent[];
  classes: ReplayClass[];
  sounds: ReplaySound[];
  gameEvents: GameEventDef[];
  baselines: BaselineRecord[];
  keyframeIndex: KeyframeIndexEntry[];
  /** Byte range of the keyframe data inside the body. */
  keyframeData: { offset: number; length: number };
  /** Byte range of the frame data inside the body. */
  frameData: { offset: number; length: number };
  /** The decompressed body bytes the ranges refer to. */
  bytes: Uint8Array;
}

const MAX_TIMELINE_EVENTS = 100_000;
const MAX_PROTOBUF_BLOB = 16 * 1024 * 1024;

/**
 * Parses the sections of a decompressed replay body.
 *
 * The baselines are indexed but their bit-packed payloads are not decoded
 * here; see the player track decoder for the parts needed for playback.
 *
 * @throws {MomtvError} on structural problems.
 */
export function parseBody(
  body: Uint8Array,
  header: Pick<
    ReplayHeader,
    'classCount' | 'sampleCount' | 'baselineCount' | 'keyFrameCount' | 'frameCount'
  >,
): ReplayBody {
  try {
    return parseBodyRevision(body, header, 1);
  } catch (error) {
    if (!(error instanceof MomtvError)) throw error;
    return parseBodyRevision(body, header, 2);
  }
}

function parseBodyRevision(
  body: Uint8Array,
  header: Pick<
    ReplayHeader,
    'classCount' | 'sampleCount' | 'baselineCount' | 'keyFrameCount' | 'frameCount'
  >,
  revision: 1 | 2,
): ReplayBody {
  const r = new ByteReader(body);

  // 1. timeline
  const timeline: TimelineEvent[] = [];
  if (revision === 1) {
    const timelineCount = r.u32('timeline count');
    if (timelineCount > MAX_TIMELINE_EVENTS) {
      throw new MomtvError('LIMIT_EXCEEDED', `Timeline declares ${timelineCount} events`);
    }
    for (let i = 0; i < timelineCount; i++) {
      timeline.push({
        tick: r.i32('event tick'),
        zoneFlag: r.u16('event zone flag'),
        trackNum: r.u8('event track'),
        type: r.u8('event type'),
        time: r.f64('event time'),
        majorNum: r.u8('event major'),
        minorNum: r.u8('event minor'),
      });
    }
  } else {
    // revision 2: u16 count, compact records {i32 tick}{u8 flag} with two
    // extra bytes {u8 track}{u8 major} when flag is 2 (checkpoint enter)
    const timelineCount = r.u16('timeline count');
    if (timelineCount > MAX_TIMELINE_EVENTS) {
      throw new MomtvError('LIMIT_EXCEEDED', `Timeline declares ${timelineCount} events`);
    }
    for (let i = 0; i < timelineCount; i++) {
      const tick = r.i32('event tick');
      const flag = r.u8('event flag');
      let trackNum = 0;
      let majorNum = 0;
      if (flag === 2) {
        trackNum = r.u8('event track');
        majorNum = r.u8('event major');
      }
      timeline.push({
        tick,
        zoneFlag: flag,
        trackNum,
        type: flag,
        time: NaN,
        majorNum,
        minorNum: 0,
      });
    }
  }

  // 2. class table
  const classes: ReplayClass[] = [];
  for (let c = 0; c < header.classCount; c++) {
    const classId = r.u8('class id');
    const name = r.cString(256, 'class name');
    const propCount = r.u8('prop count');
    const props: string[] = [];
    for (let p = 0; p < propCount; p++) props.push(r.cString(256, 'prop name'));
    classes.push({ classId, name, props });
  }

  // 3. sound table
  const sounds: ReplaySound[] = [];
  for (let s = 0; s < header.sampleCount; s++) {
    sounds.push({ soundIndex: r.u16('sound index'), path: r.cString(1024, 'sound path') });
  }

  // 4 and 5. the game event definitions and the baselines, in the order the
  // revision puts them: revision 2 swapped the two.
  const knownClassIds = new Set(classes.map((c) => c.classId));
  const readGameEvents = (): GameEventDef[] => {
    const size = r.u32('game event list size');
    if (size > MAX_PROTOBUF_BLOB) {
      throw new MomtvError('LIMIT_EXCEEDED', `Game event list declares ${size} bytes`);
    }
    return parseGameEventList(r.raw(size, 'game event list'));
  };
  const readBaselines = (): BaselineRecord[] => {
    const size = r.u32('baseline section size');
    const end = r.pos + size;
    if (end > body.length) {
      throw new MomtvError('TRUNCATED', 'Baseline section exceeds the body');
    }
    const records =
      size > 0 ? indexBaselines(body, r.pos, end, header.baselineCount, knownClassIds) : [];
    r.seek(end);
    return records;
  };
  let gameEvents: GameEventDef[];
  let baselines: BaselineRecord[];
  if (revision === 1) {
    gameEvents = readGameEvents();
    baselines = readBaselines();
  } else {
    baselines = readBaselines();
    gameEvents = readGameEvents();
  }

  // 6. keyframe index
  const keyframeIndex: KeyframeIndexEntry[] = [];
  if (revision === 1) {
    for (let k = 0; k < header.keyFrameCount; k++) {
      keyframeIndex.push({
        tick: r.u32('keyframe tick'),
        keyframeOffset: r.u32('keyframe offset'),
        frameOffset: r.u32('keyframe frame offset'),
      });
    }
  } else {
    // revision 2: the tick 0 keyframe is implicit (8 zero bytes where its
    // tick and offset would go, no frame offset), then full 12 byte entries
    const z1 = r.u32('implicit keyframe tick');
    const z2 = r.u32('implicit keyframe offset');
    keyframeIndex.push({ tick: z1, keyframeOffset: z2, frameOffset: -1 });
    for (let k = 1; k < header.keyFrameCount; k++) {
      keyframeIndex.push({
        tick: r.u32('keyframe tick'),
        keyframeOffset: r.u32('keyframe offset'),
        frameOffset: r.u32('keyframe frame offset'),
      });
    }
  }

  // 7. keyframe data
  const kfSize = r.u32('keyframe data size');
  const keyframeData = { offset: r.pos, length: kfSize };
  r.skip(kfSize, 'keyframe data');

  // 8. frame data
  const frameSize = r.u32('frame data size');
  const frameData = { offset: r.pos, length: frameSize };
  if (r.pos + frameSize > body.length) {
    throw new MomtvError('TRUNCATED', 'Frame data section exceeds the body');
  }

  // structural validation: both sections must land exactly on the body end,
  // which is what disambiguates the two revisions reliably
  if (frameData.offset + frameData.length !== body.length) {
    throw new MomtvError('BAD_BODY', 'Frame data does not end at the body end');
  }

  return {
    revision,
    timeline,
    classes,
    sounds,
    gameEvents,
    baselines,
    keyframeIndex,
    keyframeData,
    frameData,
    bytes: body,
  };
}

/** Minimal protobuf walk of the CSVCMsg_GameEventList-like blob. */
function parseGameEventList(blob: Uint8Array): GameEventDef[] {
  const events: GameEventDef[] = [];
  const decoder = new TextDecoder();
  let pos = 0;
  const varint = (): number => {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 5 && pos < blob.length; i++) {
      const b = blob[pos++]!;
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return v >>> 0;
  };
  while (pos < blob.length) {
    const tag = blob[pos++]!;
    if (tag === 0x0a) {
      const len = varint();
      const end = Math.min(pos + len, blob.length);
      let eventId = -1;
      let name = '';
      const keys: { type: number; name: string }[] = [];
      while (pos < end) {
        const t = blob[pos++]!;
        if (t === 0x08) {
          eventId = varint();
        } else if (t === 0x12) {
          const l = varint();
          name = decoder.decode(blob.subarray(pos, Math.min(pos + l, end)));
          pos += l;
        } else if (t === 0x1a) {
          const l = varint();
          const keyEnd = Math.min(pos + l, end);
          let type = 0;
          let keyName = '';
          while (pos < keyEnd) {
            const kt = blob[pos++]!;
            if (kt === 0x08) type = varint();
            else if (kt === 0x12) {
              const kl = varint();
              keyName = decoder.decode(blob.subarray(pos, Math.min(pos + kl, keyEnd)));
              pos += kl;
            } else {
              pos = keyEnd;
            }
          }
          keys.push({ type, name: keyName });
        } else {
          pos = end;
        }
      }
      pos = end;
      events.push({ eventId, name, keys });
    } else {
      varint();
    }
  }
  return events;
}

/**
 * Reads the baseline section.
 *
 * Each record is self describing:
 * `{int32 tick}{varint entity}{UBitVar classId}{uint16 payloadBits}{payload}`,
 * padded to a byte boundary, so records chain exactly with no searching.
 */
function indexBaselines(
  body: Uint8Array,
  start: number,
  end: number,
  count: number,
  knownClassIds: Set<number>,
): BaselineRecord[] {
  if (count === 0 || end - start < 5) return [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const records: BaselineRecord[] = [];
  let pos = start;
  for (let i = 0; i < count; i++) {
    if (pos + 7 > end) {
      throw new MomtvError('BAD_BODY', `Baseline record ${i} runs past the section`);
    }
    const tick = view.getInt32(pos, true);
    pos += 4;
    let entity = 0;
    let shift = 0;
    for (let b = 0; b < 5; b++) {
      if (pos >= end)
        throw new MomtvError('BAD_BODY', `Baseline record ${i} has a truncated entity`);
      const byte = body[pos++]!;
      entity |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    const r = new BitReader(body, pos, end - pos);
    const classId = r.readUBitVar();
    if (!knownClassIds.has(classId)) {
      throw new MomtvError('BAD_BODY', `Baseline record ${i} names unknown class ${classId}`);
    }
    const payloadBits = r.readBits(16);
    const payloadBitOffset = r.bitPos;
    const next = Math.ceil((payloadBitOffset + payloadBits) / 8);
    if (next > end) {
      throw new MomtvError(
        'BAD_BODY',
        `Baseline record ${i} declares ${payloadBits} bits past the section`,
      );
    }
    records.push({
      tick,
      entity,
      classId,
      payloadBitOffset,
      payloadBits,
      payloadOffset: payloadBitOffset >> 3,
      payloadLength: next - (payloadBitOffset >> 3),
    });
    pos = next;
  }
  return records;
}
