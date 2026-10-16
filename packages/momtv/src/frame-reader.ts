import { BitReader } from './bit-reader.js';
import type { ReplayBody, ReplayClass } from './body-sections.js';
import { MomtvError } from './error.js';
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

/** Bits an array element index takes. */
const ELEMENT_BITS = 6;

/** Counts past which a frame is called corrupt rather than parsed. */
const MAX_CREATIONS = 256;
const MAX_DIRECTORY = 64;
const MAX_REMOVALS = 64;
const MAX_MESSAGES = 64;
const MAX_MESSAGE_BYTES = 1 << 20;

/** What a slot currently holds. */
interface SlotState {
  className: string;
  props: readonly PropEncoding[];
  propNames: readonly string[];
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
  private readonly reader: BitReader;
  private readonly bytes: Uint8Array;
  private readonly keyframeData: { offset: number; length: number };
  private readonly byName = new Map<string, SlotState>();
  private readonly classList: readonly ReplayClass[];
  /** Class of each baseline, which is what a creation record points at. */
  private readonly baselineClass = new Map<number, string>();
  private readonly slots = new Map<number, SlotState>();
  /** Baseline each slot was created from, which identifies the entity. */
  private readonly slotBaseline = new Map<number, number>();
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
    const state: SlotState = {
      className,
      props: resolveClassProps(cls.name, cls.props),
      propNames: cls.props,
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
        created.push({ slot, className: name, baseline });
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

  private readPayload(state: SlotState): DecodedProp[] {
    const r = this.reader;
    const count = r.readUBitVar();
    if (count === 0 || count > state.props.length) {
      throw new MomtvError(
        'BAD_BODY',
        `${state.className} claims ${count} of its ${state.props.length} properties`,
      );
    }
    const refs: { index: number; element?: number }[] = [];
    for (let i = 0; i < count; i++) {
      const index = r.readBits(this.propBits);
      const encoding = state.props[index];
      if (!encoding) {
        throw new MomtvError('BAD_BODY', `${state.className} has no property ${index}`);
      }
      refs.push(encoding.k === 'array' ? { index, element: r.readBits(ELEMENT_BITS) } : { index });
    }
    const out: DecodedProp[] = [];
    for (const ref of refs) {
      const encoding = state.props[ref.index]!;
      const name = state.propNames[ref.index]!;
      // An array reference carries one element, not the whole array.
      const value = readPropValue(r, encoding.k === 'array' ? encoding.e! : encoding);
      if (this.wanted(state.className, name)) {
        out.push(
          ref.element === undefined ? { name, value } : { name, element: ref.element, value },
        );
      }
    }
    return out;
  }
}
