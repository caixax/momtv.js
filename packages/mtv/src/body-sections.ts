import { ByteReader } from './byte-reader.js';
import { MtvError } from './error.js';
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
  /** Network class id from the payload's leading UBitVar. */
  classId: number;
  /** Byte offset of the bit-packed payload inside the body. */
  payloadOffset: number;
  /** Payload length in bytes (up to the next record). */
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
 * @throws {MtvError} on structural problems.
 */
export function parseBody(
  body: Uint8Array,
  header: Pick<
    ReplayHeader,
    'classCount' | 'sampleCount' | 'baselineCount' | 'keyFrameCount' | 'frameCount'
  >,
): ReplayBody {
  const r = new ByteReader(body);

  // 1. timeline
  const timelineCount = r.u32('timeline count');
  if (timelineCount > MAX_TIMELINE_EVENTS) {
    throw new MtvError('LIMIT_EXCEEDED', `Timeline declares ${timelineCount} events`);
  }
  const timeline: TimelineEvent[] = [];
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

  // 4. game event definitions (protobuf)
  const geSize = r.u32('game event list size');
  if (geSize > MAX_PROTOBUF_BLOB) {
    throw new MtvError('LIMIT_EXCEEDED', `Game event list declares ${geSize} bytes`);
  }
  const geBlob = r.raw(geSize, 'game event list');
  const gameEvents = parseGameEventList(geBlob);

  // 5. baselines
  const baselineSize = r.u32('baseline section size');
  const baselineEnd = r.pos + baselineSize;
  if (baselineEnd > body.length) {
    throw new MtvError('TRUNCATED', 'Baseline section exceeds the body');
  }
  const knownClassIds = new Set(classes.map((c) => c.classId));
  const baselines = indexBaselines(body, r.pos, baselineEnd, header.baselineCount, knownClassIds);
  r.seek(baselineEnd);

  // 6. keyframe index
  const keyframeIndex: KeyframeIndexEntry[] = [];
  for (let k = 0; k < header.keyFrameCount; k++) {
    keyframeIndex.push({
      tick: r.u32('keyframe tick'),
      keyframeOffset: r.u32('keyframe offset'),
      frameOffset: r.u32('keyframe frame offset'),
    });
  }

  // 7. keyframe data
  const kfSize = r.u32('keyframe data size');
  const keyframeData = { offset: r.pos, length: kfSize };
  r.skip(kfSize, 'keyframe data');

  // 8. frame data
  const frameSize = r.u32('frame data size');
  const frameData = { offset: r.pos, length: frameSize };
  if (r.pos + frameSize > body.length) {
    throw new MtvError('TRUNCATED', 'Frame data section exceeds the body');
  }

  return {
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
 * Splits the baseline section into records.
 *
 * Record payloads are bit-packed with no length prefix, so boundaries are
 * recovered structurally: every position that looks like a record header
 * (`i32` matching the first record's value or negative, then a varint entity
 * ordinal, then a known class id) is collected, and the unique chain covering
 * ordinals 0..count-1 in order is selected.
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
  const firstTick = view.getInt32(start, true);

  const readVarint = (at: number): { value: number; end: number } | null => {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 5 && at < end; i++) {
      const b = body[at++]!;
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { value: v >>> 0, end: at };
      shift += 7;
    }
    return null;
  };

  // candidate header positions per entity ordinal; strict candidates reuse
  // the first record's i32 value, the relaxed pass (any i32) only fills
  // ordinals with no strict candidate (one zone record uses a different value)
  const candidates: { pos: number; tick: number; payload: number; classId: number }[][] =
    Array.from({ length: count }, () => []);
  const collect = (relaxedFor: Set<number> | null): void => {
    for (let p = start; p < end - 5; p++) {
      const tick = view.getInt32(p, true);
      if (relaxedFor === null && tick !== firstTick) continue;
      const vi = readVarint(p + 4);
      if (!vi || vi.value >= count) continue;
      if (relaxedFor !== null && !relaxedFor.has(vi.value)) continue;
      const classId = readUBitVarAt(body, vi.end * 8);
      if (!knownClassIds.has(classId)) continue;
      if (relaxedFor !== null && candidates[vi.value]!.some((c) => c.pos === p)) continue;
      candidates[vi.value]!.push({ pos: p, tick, payload: vi.end, classId });
    }
  };
  collect(null);
  const missing = new Set<number>();
  for (let k = 0; k < count; k++) if (candidates[k]!.length === 0) missing.add(k);
  if (missing.size > 0) collect(missing);
  if (!candidates[0]?.some((c) => c.pos === start)) {
    throw new MtvError('BAD_BODY', 'Baseline section does not start with entity 0');
  }

  // choose, for each ordinal, the candidate that still allows a full chain
  // (checked backwards: chainable[k][i] = candidate i of ordinal k can be
  // followed by a chainable candidate of ordinal k+1)
  const chainable: boolean[][] = candidates.map((list) => list.map(() => false));
  for (let k = count - 1; k >= 0; k--) {
    for (let i = 0; i < candidates[k]!.length; i++) {
      const c = candidates[k]![i]!;
      if (k === count - 1) {
        chainable[k]![i] = true;
        continue;
      }
      chainable[k]![i] = candidates[k + 1]!.some(
        (n, j) => n.pos > c.payload && chainable[k + 1]![j]!,
      );
    }
  }

  const records: BaselineRecord[] = [];
  let prevPayload = start;
  for (let k = 0; k < count; k++) {
    // take the latest chainable candidate: false header patterns occur inside
    // the previous record's bit-packed payload, before the real header
    let idx = -1;
    for (let i = candidates[k]!.length - 1; i >= 0; i--) {
      const c = candidates[k]![i]!;
      if ((k === 0 ? c.pos === start : c.pos > prevPayload) && chainable[k]![i]!) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      throw new MtvError('BAD_BODY', `Could not locate baseline record for entity ${k}`);
    }
    const c = candidates[k]![idx]!;
    if (records.length > 0) {
      records[records.length - 1]!.payloadLength =
        c.pos - records[records.length - 1]!.payloadOffset;
    }
    records.push({
      tick: c.tick,
      entity: k,
      classId: c.classId,
      payloadOffset: c.payload,
      payloadLength: end - c.payload, // fixed up by the next record
    });
    prevPayload = c.payload;
  }
  return records;
}

function readUBitVarAt(bytes: Uint8Array, bitPos: number): number {
  const bit = (p: number): number => ((bytes[p >> 3] ?? 0) >> (p & 7)) & 1;
  let six = 0;
  for (let i = 0; i < 6; i++) six |= bit(bitPos + i) << i;
  const extBits = { 0: 0, 16: 4, 32: 8, 48: 28 }[six & 48]!;
  if (extBits === 0) return six;
  let ext = 0;
  for (let i = 0; i < extBits; i++) ext |= bit(bitPos + 6 + i) << i;
  return ((six & 15) | (ext << 4)) >>> 0;
}
