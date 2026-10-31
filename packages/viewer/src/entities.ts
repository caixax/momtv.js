import { modelNameCrc, type EntityTrack } from '@caixax/momtv';
import type { BspMap } from './bsp/bsp-file.js';

/**
 * Pairs the entities a replay records with the brush models of the map.
 *
 * A replay names the model each recorded entity draws, as the CRC32 of the
 * model's name, and a brush model's name is `*N` for model N of the map. So
 * the pairing is exact: no counting, no guessing.
 *
 * A replay that never sends a model (none seen so far, but the recorder only
 * sends what differs from what it assumes) falls back to the order: the
 * server creates a map's entities in the order the entity lump lists them and
 * the recorder follows suit, so the k'th recorded entity of a class is the
 * k'th brush entity of the map networked as that class. That is only used
 * when the counts agree exactly, which costs a few still traps rather than
 * moving the wrong piece of the map.
 */

/** Server class each brush entity is networked as. */
const SERVER_CLASS: Record<string, string> = {
  func_rotating: 'CFuncRotating',
  func_door: 'CBaseDoor',
  func_door_rotating: 'CBaseDoor',
  func_water: 'CBaseDoor',
  func_button: 'CBaseButton',
  func_rot_button: 'CBaseButton',
  func_brush: 'CFuncBrush',
  func_wall_toggle: 'CFuncBrush',
  func_movelinear: 'CFuncMoveLinear',
  func_tracktrain: 'CFuncTrackTrain',
  func_train: 'CFuncTrain',
  func_plat: 'CFuncPlat',
  func_platrot: 'CFuncPlatRot',
  func_breakable: 'CBreakable',
  func_physbox: 'CPhysBox',
  func_conveyor: 'CFuncConveyor',
};

/** One recorded entity and the brush model it drives. */
export interface LinkedEntity {
  track: EntityTrack;
  /** Index into the map's models. */
  model: number;
  /** Where the map puts it, which fills in whatever the replay never sent. */
  origin: [number, number, number];
  angles: [number, number, number];
}

/**
 * Works out which brush model each recorded entity moves.
 *
 * @param map - the parsed map
 * @param tracks - the replay's recorded entities
 * @returns one entry per entity that could be paired up with certainty
 */
export function linkBrushEntities(map: BspMap, tracks: readonly EntityTrack[]): LinkedEntity[] {
  const linked: LinkedEntity[] = [];
  const place = (track: EntityTrack, model: number): void => {
    const placement = map.models[model]?.placement;
    linked.push({
      track,
      model,
      origin: placement ? [...placement.origin] : [0, 0, 0],
      angles: placement ? [...placement.angles] : [0, 0, 0],
    });
  };

  // By the model each entity names: brush model N is `*N`.
  const byCrc = new Map<number, number>();
  for (let index = 1; index < map.models.length; index++) {
    byCrc.set(modelNameCrc(`*${index}`), index);
  }
  const unnamed: EntityTrack[] = [];
  for (const track of tracks) {
    const model = track.model === undefined ? undefined : byCrc.get(track.model);
    if (model !== undefined) place(track, model);
    else if (track.model === undefined) unnamed.push(track);
    // An entity whose model is a studio model is not part of the brushwork.
  }
  if (unnamed.length === 0) return linked;

  // The map's brush models, grouped by the class they are networked as, in
  // entity lump order.
  const byClass = new Map<string, number[]>();
  for (const [index, model] of map.models.entries()) {
    const classname = model.entity?.['classname'];
    if (!classname) continue;
    const serverClass = SERVER_CLASS[classname];
    if (!serverClass) continue;
    const list = byClass.get(serverClass) ?? [];
    list.push(index);
    byClass.set(serverClass, list);
  }

  const recorded = new Map<string, EntityTrack[]>();
  for (const track of unnamed) {
    const list = recorded.get(track.className) ?? [];
    list.push(track);
    recorded.set(track.className, list);
  }

  for (const [className, list] of recorded) {
    const models = byClass.get(className);
    if (!models || models.length !== list.length) continue;
    const sorted = [...list].sort((a, b) => a.classIndex - b.classIndex);
    for (const [i, track] of sorted.entries()) place(track, models[i]!);
  }
  return linked;
}
