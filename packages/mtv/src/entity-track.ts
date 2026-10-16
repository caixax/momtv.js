import type { ReplayBody } from './body-sections.js';
import { walkFrames } from './frame-walk.js';
import type { DecodeStats } from './player-track.js';

/**
 * Where the recorded entities other than the player were, tick by tick.
 *
 * A Momentum map's moving parts (rotating traps, doors, platforms, the brushes
 * a bhop map toggles) are entities the recorder follows, and a replay carries
 * their position and their angles in the same frames as the player's. What it
 * does not carry is which brush model each one is: the recorder and playback
 * both get that from the map, so a consumer has to pair them up, which
 * {@link EntityTrack.classIndex} is for.
 *
 * Positions are cell coded: the world coordinate of a component is
 * `cell * cellWidth - 16384 + offset`. A component the replay never sent is
 * left as NaN, so a consumer can fall back to what the map says, which is
 * where the entity starts.
 */

/** Values per sample: three cells, three offsets, three angles. */
export const ENTITY_STRIDE = 9;

/** Half the span of the coordinate space, which cell coordinates count from. */
const MAX_COORD = 16384;

/** Degrees per step of the 13 bit angles entities use. */
const ANGLE_STEP = 360 / 8192;

/** What one recorded entity did over the run. */
export interface EntityTrack {
  /** Slot the recorder gave it, which it may reuse after a removal. */
  slot: number;
  /** Class as the replay's own table names it, for example `CFuncRotating`. */
  className: string;
  /** Its position among the recorded entities of its class, in creation order. */
  classIndex: number;
  /** Width of a position cell in units. */
  cellWidth: number;
  /** Ticks at which something changed, ascending. */
  ticks: Uint32Array;
  /** {@link ENTITY_STRIDE} values per tick: cells, offsets, angles. */
  values: Float32Array;
  /** True when the replay ever moved or turned it. */
  moves: boolean;
}

/** Running state of one entity while the frames are walked. */
interface Live {
  baseline: number;
  slot: number;
  className: string;
  classIndex: number;
  cellWidth: number;
  values: number[];
  ticks: number[];
  samples: number[];
  changed: boolean;
  moves: boolean;
}

/** Cell width the engine uses when an entity has not said otherwise. */
const DEFAULT_CELL_BITS = 5;

/** Applies one decoded property to an entity's running state. */
function apply(live: Live, name: string, element: number | undefined, value: unknown): void {
  switch (name) {
    case 'm_cellbits':
      live.cellWidth = 1 << (value as number);
      return;
    case 'm_cellX':
      live.values[0] = value as number;
      live.changed = true;
      live.moves = true;
      return;
    case 'm_cellY':
      live.values[1] = value as number;
      live.changed = true;
      live.moves = true;
      return;
    case 'm_cellZ':
      live.values[2] = value as number;
      live.changed = true;
      live.moves = true;
      return;
    case 'm_vecOrigin': {
      const [x, y, z] = value as number[];
      live.values[3] = x!;
      live.values[4] = y!;
      // A two component origin leaves the third alone, as the player's does.
      if (z !== undefined) live.values[5] = z;
      live.changed = true;
      live.moves = true;
      return;
    }
    case 'm_vecOrigin[2]':
      live.values[5] = value as number;
      live.changed = true;
      live.moves = true;
      return;
    case 'm_angRotation': {
      const angles = value as number[];
      for (let i = 0; i < 3; i++) live.values[6 + i] = angles[i]! * ANGLE_STEP;
      live.changed = true;
      live.moves = true;
      return;
    }
    case 'm_angRotation[0]':
    case 'm_angRotation[1]':
    case 'm_angRotation[2]': {
      const index = Number(name[name.length - 2]);
      live.values[6 + index] = (value as number) * ANGLE_STEP;
      live.changed = true;
      live.moves = true;
      return;
    }
    default:
      // Arrays and the rest of an entity's state say nothing about where it is.
      void element;
      return;
  }
}

/** Properties worth following; everything else is skipped before it is read. */
const WANTED = new Set([
  'm_cellbits',
  'm_cellX',
  'm_cellY',
  'm_cellZ',
  'm_vecOrigin',
  'm_vecOrigin[2]',
  'm_angRotation',
  'm_angRotation[0]',
  'm_angRotation[1]',
  'm_angRotation[2]',
]);

/** The player has its own track, and its weapons do not exist in the map. */
const IGNORED = /^CMomentum(Player|ViewModel|Pistol|Knife|Rifle|Shotgun|Machinegun|Sniper|Grenade|Concgrenade|Paintgun|Rocket|Stickybomb|Knife)/;

/** The outcome of a walk: one track per recorded entity that ever moved. */
export interface EntityTracks {
  tracks: EntityTrack[];
  stats: DecodeStats;
}

/**
 * Decodes the per-tick state of every recorded entity other than the player.
 *
 * @param body - parsed body sections
 * @param frameCount - ticks the header declares
 * @param propBits - bits a property index takes, from the header
 */
export function decodeEntityTracks(
  body: ReplayBody,
  frameCount: number,
  propBits: number,
): EntityTracks {
  /** One entry per entity, keyed by the baseline that identifies it. */
  const entities = new Map<number, Live>();
  /** What each slot currently holds, since slots are handed out again. */
  const inSlot = new Map<number, number>();
  const classCount = new Map<string, number>();

  /**
   * Every recorded entity gets a track, moving or not: what pairs them with
   * the map is their order within their class, so one that never moves still
   * has to be counted. An entity that leaves and comes back keeps its track,
   * since it is the same part of the map.
   */
  const register = (baseline: number, slot: number, className: string): Live => {
    const existing = entities.get(baseline);
    if (existing && existing.className === className) {
      existing.slot = slot;
      inSlot.set(slot, baseline);
      return existing;
    }
    const index = classCount.get(className) ?? 0;
    classCount.set(className, index + 1);
    const entity: Live = {
      baseline,
      slot,
      className,
      classIndex: index,
      cellWidth: 1 << DEFAULT_CELL_BITS,
      values: [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN],
      ticks: [],
      samples: [],
      changed: false,
      moves: false,
    };
    entities.set(baseline, entity);
    inSlot.set(slot, baseline);
    return entity;
  };

  const stats = walkFrames(
    body,
    frameCount,
    propBits,
    { wanted: (className, propName) => !IGNORED.test(className) && WANTED.has(propName) },
    (tick, frame) => {
      if (!frame) return;
      for (const created of frame.created) {
        if (IGNORED.test(created.className)) continue;
        register(created.baseline, created.slot, created.className);
      }
      for (const update of frame.updates) {
        if (IGNORED.test(update.className)) continue;
        const baseline = inSlot.get(update.slot);
        // An update for a slot whose creation the walk never saw still belongs
        // to something, so it is followed under a key of its own.
        const entity =
          baseline === undefined
            ? register(-update.slot - 1, update.slot, update.className)
            : (entities.get(baseline) ?? register(baseline, update.slot, update.className));
        entity.changed = false;
        for (const prop of update.props) apply(entity, prop.name, prop.element, prop.value);
        if (entity.changed) {
          entity.ticks.push(tick);
          entity.samples.push(...entity.values);
        }
      }
      for (const slot of frame.removed) inSlot.delete(slot);
    },
    (slots) => {
      for (const [slot, entity] of slots) {
        if (!IGNORED.test(entity.className)) register(entity.baseline, slot, entity.className);
      }
    },
  );

  const tracks: EntityTrack[] = [...entities.values()].map((entity) => ({
    slot: entity.slot,
    className: entity.className,
    classIndex: entity.classIndex,
    cellWidth: entity.cellWidth,
    ticks: Uint32Array.from(entity.ticks),
    values: Float32Array.from(entity.samples),
    moves: entity.moves,
  }));
  tracks.sort((a, b) => a.className.localeCompare(b.className) || a.classIndex - b.classIndex);
  return { tracks, stats };
}

/** Where an entity was at a tick, and how it was turned. */
export interface EntityState {
  /** World position, with NaN for a component the replay never sent. */
  origin: [number, number, number];
  /** Angles in degrees, with NaN for one the replay never sent. */
  angles: [number, number, number];
}

/**
 * Samples a track: the last state at or before a tick.
 *
 * Entities hold still between the ticks the recorder wrote, so this steps
 * rather than interpolates, which is also what the recorder saw.
 */
export function entityStateAt(track: EntityTrack, tick: number): EntityState {
  const nothing: EntityState = {
    origin: [NaN, NaN, NaN],
    angles: [NaN, NaN, NaN],
  };
  const count = track.ticks.length;
  if (count === 0 || tick < track.ticks[0]!) return nothing;
  // The last sample at or before the tick.
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (track.ticks[middle]! <= tick) low = middle;
    else high = middle - 1;
  }
  const at = low * ENTITY_STRIDE;
  const v = track.values;
  const coord = (cell: number, offset: number): number =>
    Number.isNaN(cell) || Number.isNaN(offset) ? NaN : cell * track.cellWidth - MAX_COORD + offset;
  return {
    origin: [
      coord(v[at]!, v[at + 3]!),
      coord(v[at + 1]!, v[at + 4]!),
      coord(v[at + 2]!, v[at + 5]!),
    ],
    angles: [v[at + 6]!, v[at + 7]!, v[at + 8]!],
  };
}
