import { BitReader } from './bit-reader.js';
import type { ReplayBody, ReplayClass } from './body-sections.js';
import { MtvError } from './error.js';
import {
  type PropEncoding,
  type PropValue,
  readPropValue,
  resolveClassProps,
} from './prop-encoding.js';

/**
 * A frame is one tick's delta of the recorded entity set:
 *
 * 1. one flag bit
 * 2. one bit saying whether entities start being recorded this tick, and if so
 *    a count and one `{class, slot, serial}` record of varints each
 * 3. a count of the entities whose properties follow, then one entry each: the
 *    slot, plus a serial and a class when the parser has not seen that slot
 *    before, exactly as the engine decides it
 * 4. one property payload per entry: a count, then that many references made
 *    of a property index and, for an array property, an element index, then
 *    the values in the same order
 * 5. four optional trailing sections, each a flag bit and, when set, a length
 *    and that many bytes of a network message
 *
 * Entities are addressed by a slot the recorder assigns and reuses, so the map
 * from slot to class is built up as the walk proceeds. Entities that only
 * start being recorded this tick take their state from elsewhere and so
 * contribute nothing to the frame beyond their creation record.
 */

/** Sections that close a frame, each one optional. */
const TAIL_SECTIONS = 1;

/** Bits an array element index takes. */
const ELEMENT_BITS = 6;

/** Largest property count a payload may claim, as the engine allows. */
const MAX_PAYLOAD_PROPS = 1000;

/** What a slot currently holds. */
interface SlotState {
  className: string;
  props: readonly PropEncoding[];
  propNames: readonly string[];
}

/** One decoded property of one entity. */
export interface DecodedProp {
  /** Property name as the replay's class table spells it. */
  name: string;
  /** Element index, for a property that is an array. */
  element?: number;
  value: PropValue;
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
  /** Bit offset just past the frame. */
  endBit: number;
  /** The leading flag, whose meaning is not yet established. */
  flag: number;
  /** Slots that started being recorded this tick. */
  created: number[];
  updates: EntityUpdate[];
}

/** How a reader learns which class a slot holds. */
export interface FrameReaderOptions {
  /**
   * Class of a slot, for slots whose class the stream names with an index the
   * file does not explain. Returning undefined makes the frame fail to decode
   * rather than be guessed at.
   */
  classForSlot?: (slot: number, classRef: number) => string | undefined;
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
  private readonly byName = new Map<string, SlotState>();
  private readonly classList: readonly ReplayClass[];
  /** Class of each baseline, which is what a creation record points at. */
  private readonly baselineClass = new Map<number, string>();
  private readonly slots = new Map<number, SlotState>();
  private readonly propBits: number;
  private readonly classForSlot: FrameReaderOptions['classForSlot'];
  private readonly wanted: (className: string, propName: string) => boolean;

  private readonly bytes: Uint8Array;
  private readonly keyframeData: { offset: number; length: number };

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
    this.classForSlot = options.classForSlot;
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

  /** Forgets which class each slot holds, as a seek has to. */
  resetSlots(): void {
    this.slots.clear();
  }

  /** Records that a slot holds a class, by name. */
  setSlotClass(slot: number, className: string): void {
    this.slots.set(slot, this.stateFor(className));
  }

  /**
   * Fills the slot map from a keyframe's creation records, which is how
   * playback learns what the frames that follow are talking about.
   *
   * Only the creations are read; the rest of the keyframe is left alone.
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
    r.alignByte();
    for (let i = 0; i < count; i++) {
      const baseline = r.readVarInt32();
      const slot = r.readVarInt32();
      r.readVarInt32();
      const name = this.baselineClass.get(baseline);
      if (name) this.slots.set(slot, this.stateFor(name));
    }
  }

  private stateFor(className: string): SlotState {
    const cached = this.byName.get(className);
    if (cached) return cached;
    const cls = this.classList.find((c) => c.name === className);
    if (!cls) throw new MtvError('BAD_BODY', `the replay does not record class ${className}`);
    const state: SlotState = {
      className,
      props: resolveClassProps(cls.name, cls.props),
      propNames: cls.props,
    };
    this.byName.set(className, state);
    return state;
  }

  /** Reads the next frame, leaving the walk just past it. */
  readFrame(): Frame {
    const r = this.reader;
    const startBit = this.bitPos;
    const flag = r.readBit();

    const created: number[] = [];
    if (r.readBit()) {
      const count = r.readUBitVar();
      r.alignByte(); // the records that follow are varints
      for (let i = 0; i < count; i++) {
        // The first field indexes the baselines, which is where a new entity
        // takes both its class and its initial state from.
        const baseline = r.readVarInt32();
        const slot = r.readVarInt32();
        r.readVarInt32(); // serial, not needed to decode
        created.push(slot);
        const name = this.baselineClass.get(baseline) ?? this.classForSlot?.(slot, baseline);
        if (name) this.slots.set(slot, this.stateFor(name));
        else this.slots.delete(slot);
      }
    }

    const order: number[] = [];
    const updateCount = r.readUBitVar();
    for (let i = 0; i < updateCount; i++) {
      const slot = r.readUBitVar();
      // The engine only writes the serial and the class when the entity is not
      // already in the slot, so the parser's own map decides whether to read
      // them.
      if (!this.slots.has(slot)) {
        r.readUBitVar(); // serial
        const classRef = r.readUBitVar();
        const name = this.baselineClass.get(classRef) ?? this.classForSlot?.(slot, classRef);
        if (!name) {
          throw new MtvError('BAD_BODY', `slot ${slot} holds unknown class ${classRef}`);
        }
        this.slots.set(slot, this.stateFor(name));
      }
      order.push(slot);
    }

    const updates: EntityUpdate[] = [];
    for (const slot of order) {
      const state = this.slots.get(slot)!;
      updates.push({ slot, className: state.className, props: this.readPayload(state) });
    }

    for (let i = 0; i < TAIL_SECTIONS; i++) {
      if (!r.readBit()) continue;
      r.alignByte();
      const bytes = r.readVarInt32();
      r.skipBits(bytes * 8);
    }

    return { startBit, endBit: this.bitPos, flag, created, updates };
  }

  private readPayload(state: SlotState): DecodedProp[] {
    const r = this.reader;
    const count = r.readUBitVar();
    if (count > MAX_PAYLOAD_PROPS) {
      throw new MtvError('BAD_BODY', `${state.className} payload claims ${count} properties`);
    }
    // The references come first, then the values in the same order.
    const refs: { index: number; element?: number }[] = [];
    for (let i = 0; i < count; i++) {
      const index = r.readBits(this.propBits);
      const encoding = state.props[index];
      if (!encoding) {
        throw new MtvError('BAD_BODY', `${state.className} has no property ${index}`);
      }
      refs.push(encoding.k === 'array' ? { index, element: r.readBits(ELEMENT_BITS) } : { index });
    }
    const out: DecodedProp[] = [];
    for (const ref of refs) {
      const encoding = state.props[ref.index]!;
      const name = state.propNames[ref.index]!;
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
