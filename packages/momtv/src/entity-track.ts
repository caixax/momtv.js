import type { ReplayBody } from './body-sections.js';
import type { DecodedProp, Frame } from './frame-reader.js';
import { walkFrames } from './frame-walk.js';
import type { DecodeStats } from './player-track.js';

/**
 * Where the recorded entities other than the player were, tick by tick.
 *
 * A Momentum map's moving parts (rotating traps, doors, platforms, the brushes
 * a bhop map toggles) are entities the recorder follows, and a replay carries
 * their position, their angles and whether they are drawn in the same frames
 * as the player's.
 *
 * Each entity starts from its baseline, which also names the model it draws:
 * the recorder writes a model as the CRC32 of its name (lowercase, backslashes,
 * with the terminating NUL), so a brush entity's {@link EntityTrack.model} is
 * the CRC of `*N` for brush model N of the map. That is what pairs a track with
 * the map, exactly; {@link EntityTrack.classIndex} remains for replays that
 * never send a model.
 *
 * Positions are cell coded: the world coordinate of a component is
 * `cell * cellWidth - 65536 + offset`, Strata Source's world being 65536
 * units either way. A rotating brush sends a plain coordinate instead, which
 * {@link EntityTrack.absoluteOrigin} says. A component the replay never sent
 * is NaN, so a consumer can fall back to where the map puts the entity.
 */

/**
 * Values per sample: three cells, three offsets, three angles, the effect
 * flags, the alpha of the render colour (0 to 255) and the render mode.
 */
export const ENTITY_STRIDE = 12;

/** Half the span of the coordinate space, which cell coordinates count from. */
const MAX_COORD = 65536;

/** Degrees per step of the 13 bit angles entities use. */
const ANGLE_STEP = 360 / 8192;

/** The effect flag that hides an entity. */
export const EF_NODRAW = 0x20;

/** What one recorded entity did over the run. */
export interface EntityTrack {
  /** Slot the recorder gave it, which it may reuse after a removal. */
  slot: number;
  /** Class as the replay's own table names it, for example `CFuncRotating`. */
  className: string;
  /** Its position among the recorded entities of its class, in creation order. */
  classIndex: number;
  /**
   * The model the entity draws, as the CRC32 the recorder writes for it (see
   * {@link modelNameCrc}). Undefined when the replay never says.
   */
  model: number | undefined;
  /** Width of a position cell in units. */
  cellWidth: number;
  /** The origin is a plain coordinate rather than cell coded. */
  absoluteOrigin: boolean;
  /** Ticks at which something changed, ascending. */
  ticks: Uint32Array;
  /** {@link ENTITY_STRIDE} values per tick, as listed there. */
  values: Float32Array;
  /** True when the replay ever moved, turned, hid or faded it after it appeared. */
  moves: boolean;
}

/** Running state of one entity while the frames are walked. */
interface Live {
  baseline: number;
  slot: number;
  className: string;
  classIndex: number;
  model: number | undefined;
  cellWidth: number;
  absoluteOrigin: boolean;
  values: number[];
  ticks: number[];
  samples: number[];
  changed: boolean;
  moves: boolean;
}

/** Cell width the engine uses when an entity has not said otherwise. */
const DEFAULT_CELL_BITS = 5;

/** Classes whose origin is sent as a plain coordinate. */
const ABSOLUTE_ORIGIN = new Set(['CFuncRotating']);

/**
 * The CRC32 the recorder writes for a model name: the name lowercased, with
 * backslashes, including its terminating NUL.
 */
export function modelNameCrc(name: string): number {
  const text = `${name.toLowerCase().replace(/\//g, '\\')}\0`;
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i++) {
    crc = CRC_TABLE[(crc ^ text.charCodeAt(i)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Applies one decoded property to an entity's running state. */
function apply(live: Live, name: string, value: unknown): void {
  const set = (index: number, v: number): void => {
    if (live.values[index] !== v) live.changed = true;
    live.values[index] = v;
  };
  switch (name) {
    case 'm_cellbits':
      live.cellWidth = 1 << (value as number);
      return;
    case 'm_cellX':
      set(0, value as number);
      return;
    case 'm_cellY':
      set(1, value as number);
      return;
    case 'm_cellZ':
      set(2, value as number);
      return;
    case 'm_vecOrigin': {
      const [x, y, z] = value as number[];
      set(3, x!);
      set(4, y!);
      // A two component origin leaves the third alone, as the player's does.
      if (z !== undefined) set(5, z);
      return;
    }
    case 'm_vecOrigin[2]':
      set(5, value as number);
      return;
    case 'm_angRotation': {
      const angles = value as number[];
      for (let i = 0; i < 3; i++) set(6 + i, angles[i]! * ANGLE_STEP);
      return;
    }
    case 'm_angRotation[0]':
    case 'm_angRotation[1]':
    case 'm_angRotation[2]':
      set(6 + Number(name[name.length - 2]), (value as number) * ANGLE_STEP);
      return;
    case 'm_fEffects':
      set(9, value as number);
      return;
    case 'm_clrRender':
      // RGBA, alpha in the top byte; a float sample cannot hold all 32 bits
      set(10, ((value as number) >>> 24) & 0xff);
      return;
    case 'm_nRenderMode':
      set(11, value as number);
      return;
    case 'm_nModelIndex':
      live.model = (value as number) >>> 0;
      return;
    default:
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
  'm_fEffects',
  'm_clrRender',
  'm_nRenderMode',
  'm_nModelIndex',
]);

/**
 * The player has its own track, and its weapons, view model and projectiles
 * are not part of the map.
 */
const IGNORED =
  /^(CMomentum(Player|ViewModel|Pistol|Knife|Rifle|Shotgun|Machinegun|Sniper|Grenade|ConcGrenade|Concgrenade|Paintgun|RocketLauncher|StickybombLauncher|DF|TimerInstance|ZoneRegion|EmptyWeapon)|CMom(Rocket|Stickybomb|GrenadeProjectile|ConcProjectile|DF)|CSpriteTrail|CEntityDissolve)/;

/** The outcome of a walk: one track per recorded map entity. */
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

  /** Writes a sample when the entity's state changed on this tick. */
  const sample = (entity: Live, tick: number): void => {
    if (!entity.changed) return;
    entity.changed = false;
    // A first sample is where the entity starts; only later ones move it.
    if (entity.ticks.length > 0) entity.moves = true;
    if (entity.ticks.at(-1) === tick) {
      entity.samples.splice(-ENTITY_STRIDE, ENTITY_STRIDE, ...entity.values);
    } else {
      entity.ticks.push(tick);
      entity.samples.push(...entity.values);
    }
  };

  /**
   * Every recorded entity gets a track, moving or not, since a consumer pairs
   * them with the map. An entity that leaves and comes back keeps its track:
   * it is the same part of the map, and it points at the same baseline.
   */
  const register = (
    baseline: number,
    slot: number,
    className: string,
    state: readonly DecodedProp[],
  ): Live => {
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
      model: undefined,
      cellWidth: 1 << DEFAULT_CELL_BITS,
      absoluteOrigin: ABSOLUTE_ORIGIN.has(className),
      values: new Array<number>(ENTITY_STRIDE).fill(NaN),
      ticks: [],
      samples: [],
      changed: false,
      moves: false,
    };
    for (const prop of state) apply(entity, prop.name, prop.value);
    entities.set(baseline, entity);
    inSlot.set(slot, baseline);
    return entity;
  };

  const follow = (tick: number, frame: Frame): void => {
    for (const created of frame.created) {
      if (IGNORED.test(created.className)) continue;
      sample(register(created.baseline, created.slot, created.className, created.state), tick);
    }
    for (const update of frame.updates) {
      if (IGNORED.test(update.className)) continue;
      const baseline = inSlot.get(update.slot);
      // An update for a slot whose creation the walk never saw still belongs
      // to something, so it is followed under a key of its own.
      const entity =
        baseline === undefined
          ? register(-update.slot - 1, update.slot, update.className, [])
          : (entities.get(baseline) ?? register(baseline, update.slot, update.className, []));
      for (const prop of update.props) apply(entity, prop.name, prop.value);
      sample(entity, tick);
    }
    for (const slot of frame.removed) inSlot.delete(slot);
  };

  const stats = walkFrames(
    body,
    frameCount,
    propBits,
    { wanted: (className, propName) => !IGNORED.test(className) && WANTED.has(propName) },
    (tick, frame) => {
      if (frame) follow(tick, frame);
    },
    (slots, keyframe) => {
      if (keyframe) {
        follow(0, keyframe);
        return;
      }
      for (const [slot, entity] of slots) {
        if (!IGNORED.test(entity.className)) register(entity.baseline, slot, entity.className, []);
      }
    },
  );

  const tracks: EntityTrack[] = [...entities.values()].map((entity) => ({
    slot: entity.slot,
    className: entity.className,
    classIndex: entity.classIndex,
    model: entity.model,
    cellWidth: entity.cellWidth,
    absoluteOrigin: entity.absoluteOrigin,
    ticks: Uint32Array.from(entity.ticks),
    values: Float32Array.from(entity.samples),
    moves: entity.moves,
  }));
  tracks.sort((a, b) => a.className.localeCompare(b.className) || a.classIndex - b.classIndex);
  return { tracks, stats };
}

/** Where an entity was at a tick, how it was turned, and how it was drawn. */
export interface EntityState {
  /** World position, with NaN for a component the replay never sent. */
  origin: [number, number, number];
  /** Angles in degrees, with NaN for one the replay never sent. */
  angles: [number, number, number];
  /** False while the entity is hidden. */
  visible: boolean;
  /**
   * Opacity from 0 to 1. Only an entity whose render mode blends uses its
   * colour's alpha; every other one is opaque.
   */
  alpha: number;
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
    visible: true,
    alpha: 1,
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
  const stride = track.values.length / count;
  const at = low * stride;
  const v = track.values;
  const coord = (cell: number, offset: number): number => {
    if (track.absoluteOrigin) return offset;
    return Number.isNaN(cell) || Number.isNaN(offset)
      ? NaN
      : cell * track.cellWidth - MAX_COORD + offset;
  };
  const effects = stride > 9 ? v[at + 9]! : NaN;
  const alpha = stride > 10 ? v[at + 10]! : NaN;
  const renderMode = stride > 11 ? v[at + 11]! : NaN;
  // render modes past normal (0) blend by the colour's alpha
  const blends = renderMode > 0 && !Number.isNaN(alpha);
  return {
    origin: [
      coord(v[at]!, v[at + 3]!),
      coord(v[at + 1]!, v[at + 4]!),
      coord(v[at + 2]!, v[at + 5]!),
    ],
    angles: [v[at + 6]!, v[at + 7]!, v[at + 8]!],
    visible: Number.isNaN(effects) || (effects & EF_NODRAW) === 0,
    alpha: blends ? alpha / 255 : 1,
  };
}
