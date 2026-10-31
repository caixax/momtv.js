import { BitReader } from './bit-reader.js';
import type { BaselineRecord, ReplayBody, ReplayClass } from './body-sections.js';
import { MomtvError } from './error.js';
import { RecordMode, recordModeOf } from './recording-spec.js';
import {
  type PropEncoding,
  type PropValue,
  readPropValue,
  resolveClassProps,
} from './prop-encoding.js';

/**
 * A frame is one tick's delta of the recorded entity set:
 *
 * 1. one flag bit, whose meaning is not yet established
 * 2. one bit saying whether entities start being recorded this tick, and when
 *    set a count and then one record of three varints each: the baseline the
 *    entity takes its state from, the slot it goes in, and a serial
 * 3. a count of the entities whose properties follow, then one slot each
 * 4. one property payload per entry, in that order
 * 5. one bit saying whether entities stop being recorded, and when set a count
 *    and that many slots
 * 6. four optional trailing sections, in this order: temp entities, sounds,
 *    user messages and entity messages. Each is a flag bit; the first two then
 *    carry one network message, the last two a count and that many
 * 7. padding to the next byte
 *
 * A property payload is a count of references, that many references, and then
 * the values in the same order. A reference is a property index, followed by
 * an element index when the property is an array. The references are not
 * sorted: they come in the order the recorder noticed the changes.
 *
 * Entities are addressed by a slot the recorder assigns and reuses, so the map
 * from slot to class is built up as the walk proceeds, starting from the
 * creations in a keyframe. An entity that only starts being recorded this tick
 * contributes nothing beyond its creation record, since its state comes from
 * its baseline.
 */

/**
 * Reads which element of an array a reference names. A network array property
 * takes just enough bits to count its elements; an array the tables flatten
 * into one property per element takes a UBitVar, since the recorder picks the
 * element among those properties.
 */
function readElement(r: BitReader, encoding: PropEncoding): number {
  if (!encoding.a) return r.readUBitVar();
  const elements = encoding.m ?? 1;
  return r.readBits(elements > 1 ? Math.floor(Math.log2(elements)) + 1 : 1);
}

/**
 * Reads one recorded value: whatever the recording mode puts in front of it,
 * then the value itself. An array reference carries one element, not the
 * whole array.
 */
function readRecorded(
  r: BitReader,
  mode: RecordMode,
  encoding: PropEncoding,
  element: number | undefined,
): PropValue {
  switch (mode) {
    case RecordMode.ModelIndex:
      return r.readBits(32);
    case RecordMode.TimeRelative:
    case RecordMode.TickRelative:
      r.readBit();
      break;
    case RecordMode.Deferred:
      r.readVarInt32();
      break;
  }
  if (encoding.k !== 'array') return readPropValue(r, encoding);
  // A vector's first property is its length; its elements follow it.
  if (encoding.l && element === 0) return r.readBits(encoding.c ?? 0);
  return readPropValue(r, encoding.e!);
}

/**
 * Counts past which a frame is called corrupt rather than parsed. Entity
 * counts are bounded by the engine's edicts, which a 13 bit handle index
 * addresses: a map that brings dozens of brushes in and out of view at once
 * creates and removes that many in a single frame.
 */
const MAX_EDICTS = 1 << 13;
const MAX_CREATIONS = MAX_EDICTS;
const MAX_DIRECTORY = MAX_EDICTS;
const MAX_REMOVALS = MAX_EDICTS;
const MAX_MESSAGES = 256;
const MAX_MESSAGE_BYTES = 1 << 20;

/** What a slot currently holds. */
interface SlotState {
  className: string;
  props: readonly PropEncoding[];
  propNames: readonly string[];
  /** How the recorder writes each property on top of its encoding. */
  modes: readonly RecordMode[];
  /** Values the class holds, counting every element of its arrays. */
  capacity: number;
}

/** An entity the walk knows about: what it is, and where it came from. */
export interface SlotEntity {
  className: string;
  baseline: number;
}

/** One decoded property of one entity. */
export interface DecodedProp {
  /** Property name as the replay's class table spells it. */
  name: string;
  /** Element index, for a property that is an array. */
  element?: number;
  value: PropValue;
}

/** An entity the recorder started following. */
export interface CreatedEntity {
  slot: number;
  className: string;
  /**
   * Baseline the entity takes its state from, which is also what identifies
   * it: an entity that leaves and comes back points at the same baseline, in
   * a slot the recorder is free to pick again.
   */
  baseline: number;
  /**
   * The state the baseline gives the entity, before anything this frame or a
   * later one changes, as far as the reader's options want it. Empty when the
   * baseline cannot be read.
   */
  state: DecodedProp[];
}

/** What one frame did to one entity. */
export interface EntityUpdate {
  slot: number;
  className: string;
  props: DecodedProp[];
}

/** Everything one frame carried. */
export interface Frame {
  /** Bit offset of the frame's first bit, relative to the frame data. */
  startBit: number;
  /** Bit offset just past the frame, including its padding. */
  endBit: number;
  /** The leading flag, whose meaning is not yet established. */
  flag: number;
  /** Entities that started being recorded this tick. */
  created: CreatedEntity[];
  /** Slots that stopped being recorded this tick. */
  removed: number[];
  updates: EntityUpdate[];
}

/** Hooks for a caller that only wants some of the properties. */
export interface FrameReaderOptions {
  /** Called for each property; return false to drop its value. */
  wanted?: (className: string, propName: string) => boolean;
}

/**
 * Walks the frame data of a body, one frame at a time.
 *
 * The walk is exact: each frame begins where the previous one ended, so a
 * misread shows up as a decode error instead of as drift.
 */
export class FrameReader {
  /** The stream being read: the frame data, or a keyframe while one is read. */
  private reader: BitReader;
  private readonly bytes: Uint8Array;
  private readonly keyframeData: { offset: number; length: number };
  private readonly byName = new Map<string, SlotState>();
  private readonly classList: readonly ReplayClass[];
  /** Class of each baseline, which is what a creation record points at. */
  private readonly baselineClass = new Map<number, string>();
  private readonly slots = new Map<number, SlotState>();
  /** Baseline each slot was created from, which identifies the entity. */
  private readonly slotBaseline = new Map<number, number>();
  /** The baseline records, by the index a creation names. */
  private readonly baselineRecords = new Map<number, BaselineRecord>();
  /** Baselines already decoded, since an entity can come and go many times. */
  private readonly baselineStates = new Map<number, DecodedProp[]>();
  private readonly propBits: number;
  private readonly wanted: (className: string, propName: string) => boolean;

  /** Bit offset of the start of the frame data within the body's bytes. */
  readonly baseBit: number;
  /** Total bits of frame data. */
  readonly totalBits: number;

  constructor(body: ReplayBody, propBits: number, options: FrameReaderOptions = {}) {
    this.reader = new BitReader(body.bytes, body.frameData.offset, body.frameData.length);
    this.bytes = body.bytes;
    this.keyframeData = body.keyframeData;
    this.baseBit = body.frameData.offset * 8;
    this.totalBits = body.frameData.length * 8;
    this.propBits = propBits;
    this.classList = body.classes;
    this.wanted = options.wanted ?? (() => true);
    const names = new Map(body.classes.map((c) => [c.classId, c.name]));
    for (const baseline of body.baselines) {
      const name = names.get(baseline.classId);
      if (name) this.baselineClass.set(baseline.entity, name);
      this.baselineRecords.set(baseline.entity, baseline);
    }
  }

  /** Bits consumed so far, relative to the start of the frame data. */
  get bitPos(): number {
    return this.reader.bitPos - this.baseBit;
  }

  /** Moves the walk to a bit offset relative to the start of the frame data. */
  seekBit(bit: number): void {
    this.reader.bitPos = this.baseBit + bit;
  }

  /** What each slot holds right now, as the walk has learnt it. */
  slotEntities(): Map<number, SlotEntity> {
    const out = new Map<number, SlotEntity>();
    for (const [slot, state] of this.slots) {
      out.set(slot, { className: state.className, baseline: this.slotBaseline.get(slot) ?? -1 });
    }
    return out;
  }

  /** Records that a slot holds a class, by name. */
  setSlotClass(slot: number, className: string): void {
    this.slots.set(slot, this.stateFor(className));
  }

  /**
   * Reads a keyframe as the whole frame it is: the creations that fill the slot
   * map, and each entity's changes from its baseline, which together are the
   * state at the keyframe's tick. The engine reads keyframes and frames with
   * one routine, and so does this. The frame walk stays where it was, and the
   * returned frame's bit offsets mean nothing.
   *
   * @param keyframeOffset - byte offset into the keyframe data, from the index
   */
  readKeyframe(keyframeOffset = 0): Frame {
    const frames = this.reader;
    const section = this.keyframeData;
    this.reader = new BitReader(
      this.bytes,
      section.offset + keyframeOffset,
      section.length - keyframeOffset,
    );
    try {
      return this.readFrame();
    } finally {
      this.reader = frames;
    }
  }

  /**
   * Fills the slot map from a keyframe's creation records, which is how
   * playback learns what the frames that follow are talking about. Only the
   * creations are read; the rest of the keyframe is left alone.
   */
  seedFromKeyframe(keyframeOffset = 0): void {
    const section = this.keyframeData;
    const r = new BitReader(
      this.bytes,
      section.offset + keyframeOffset,
      section.length - keyframeOffset,
    );
    r.readBit();
    if (!r.readBit()) return;
    const count = r.readUBitVar();
    if (count > MAX_CREATIONS) {
      throw new MomtvError('BAD_BODY', `a keyframe declares ${count} creations`);
    }
    for (let i = 0; i < count; i++) {
      const baseline = r.readVarInt32();
      const slot = r.readVarInt32();
      r.readVarInt32();
      const name = this.baselineClass.get(baseline);
      if (name) {
        this.slots.set(slot, this.stateFor(name));
        this.slotBaseline.set(slot, baseline);
      }
    }
  }

  private stateFor(className: string): SlotState {
    const cached = this.byName.get(className);
    if (cached) return cached;
    const cls = this.classList.find((c) => c.name === className);
    if (!cls) throw new MomtvError('BAD_BODY', `the replay does not record class ${className}`);
    const props = resolveClassProps(cls.name, cls.props);
    const state: SlotState = {
      className,
      props,
      propNames: cls.props,
      modes: cls.props.map((name) => recordModeOf(cls.name, name)),
      // an array's elements, plus the length a flattened array also carries
      capacity: props.reduce((sum, p) => sum + (p.k === 'array' ? (p.m ?? 1) + 1 : 1), 0),
    };
    this.byName.set(className, state);
    return state;
  }

  /** Reads one network message: its type, its length and its bytes. */
  private readMessage(): void {
    const r = this.reader;
    r.readVarInt32();
    const bytes = r.readVarInt32();
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new MomtvError('BAD_BODY', `a trailing message declares ${bytes} bytes`);
    }
    r.skipBits(bytes * 8);
  }

  /** Reads the next frame, leaving the walk just past it. */
  readFrame(): Frame {
    const r = this.reader;
    const startBit = this.bitPos;
    const flag = r.readBit();

    const created: CreatedEntity[] = [];
    if (r.readBit()) {
      const count = r.readUBitVar();
      if (count > MAX_CREATIONS) {
        throw new MomtvError('BAD_BODY', `a frame declares ${count} creations`);
      }
      for (let i = 0; i < count; i++) {
        const baseline = r.readVarInt32();
        const slot = r.readVarInt32();
        r.readVarInt32(); // serial, not needed to decode
        const name = this.baselineClass.get(baseline);
        if (!name) throw new MomtvError('BAD_BODY', `a creation names baseline ${baseline}`);
        this.slots.set(slot, this.stateFor(name));
        this.slotBaseline.set(slot, baseline);
        created.push({ slot, className: name, baseline, state: this.baselineState(baseline) });
      }
    }

    const updateCount = r.readUBitVar();
    if (updateCount > MAX_DIRECTORY) {
      throw new MomtvError('BAD_BODY', `a frame declares ${updateCount} entity updates`);
    }
    const order: number[] = [];
    for (let i = 0; i < updateCount; i++) order.push(r.readUBitVar());

    const updates: EntityUpdate[] = [];
    for (const slot of order) {
      const state = this.slots.get(slot);
      if (!state) throw new MomtvError('BAD_BODY', `slot ${slot} holds no known class`);
      updates.push({ slot, className: state.className, props: this.readPayload(state) });
    }

    const removed: number[] = [];
    if (r.readBit()) {
      const count = r.readUBitVar();
      if (count > MAX_REMOVALS) {
        throw new MomtvError('BAD_BODY', `a frame declares ${count} removals`);
      }
      for (let i = 0; i < count; i++) {
        const slot = r.readUBitVar();
        this.slots.delete(slot);
        this.slotBaseline.delete(slot);
        removed.push(slot);
      }
    }

    if (r.readBit()) this.readMessage(); // temp entities
    if (r.readBit()) this.readMessage(); // sounds
    for (const kind of ['user messages', 'entity messages']) {
      if (!r.readBit()) continue;
      const count = r.readUBitVar();
      if (count > MAX_MESSAGES) {
        throw new MomtvError('BAD_BODY', `a frame declares ${count} ${kind}`);
      }
      for (let i = 0; i < count; i++) this.readMessage();
    }

    r.alignByte();
    return { startBit, endBit: this.bitPos, flag, created, removed, updates };
  }

  /**
   * Decodes a baseline: the state an entity takes when a creation names it.
   * A baseline payload is written exactly like a frame's, which is how the
   * engine reads it too, so this gives the entity's starting position and the
   * model it draws.
   */
  /** A baseline's state, decoded once, or nothing when it cannot be read. */
  private baselineState(index: number): DecodedProp[] {
    const cached = this.baselineStates.get(index);
    if (cached) return cached;
    const record = this.baselineRecords.get(index);
    let state: DecodedProp[] = [];
    if (record && record.payloadBits > 0) {
      try {
        state = this.readBaseline(record).props;
      } catch {
        // A baseline that will not decode still leaves its entity trackable
        // from the frames; it just starts from nothing.
        state = [];
      }
    }
    this.baselineStates.set(index, state);
    return state;
  }

  readBaseline(baseline: BaselineRecord): {
    className: string;
    props: DecodedProp[];
    /** Bits the payload took, which matches the record's own length when read right. */
    bits: number;
  } {
    const className = this.baselineClass.get(baseline.entity);
    if (!className) {
      throw new MomtvError('BAD_BODY', `baseline ${baseline.entity} has no recorded class`);
    }
    const r = new BitReader(this.bytes);
    r.bitPos = baseline.payloadBitOffset;
    const props = this.readPayload(this.stateFor(className), r);
    return { className, props, bits: r.bitPos - baseline.payloadBitOffset };
  }

  private readPayload(state: SlotState, r: BitReader = this.reader): DecodedProp[] {
    const count = r.readUBitVar();
    // Each element of an array is a reference of its own, so a full state (a
    // baseline, a keyframe) can hold more references than the class has
    // properties, though never more than it has values.
    if (count === 0 || count > state.capacity) {
      throw new MomtvError(
        'BAD_BODY',
        `${state.className} claims ${count} of its ${state.capacity} values`,
      );
    }
    const refs: { index: number; element?: number }[] = [];
    for (let i = 0; i < count; i++) {
      const index = r.readBits(this.propBits);
      const encoding = state.props[index];
      if (!encoding) {
        throw new MomtvError('BAD_BODY', `${state.className} has no property ${index}`);
      }
      refs.push(encoding.k === 'array' ? { index, element: readElement(r, encoding) } : { index });
    }
    const out: DecodedProp[] = [];
    for (const ref of refs) {
      const encoding = state.props[ref.index]!;
      const name = state.propNames[ref.index]!;
      const value = readRecorded(r, state.modes[ref.index]!, encoding, ref.element);
      if (this.wanted(state.className, name)) {
        out.push(
          ref.element === undefined ? { name, value } : { name, element: ref.element, value },
        );
      }
    }
    return out;
  }
}
