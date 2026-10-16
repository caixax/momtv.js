/**
 * Loads the models a map places as static props.
 *
 * A prop is a model placed at a point: the map's game lump says which model
 * and where, and the model itself lives in three files next to each other.
 * They are read through the same chain as the materials (the map's pakfile
 * first, then the game's own files), so a map that packs its props needs
 * nothing else.
 *
 * Each distinct model is read once and drawn at every place the map puts it.
 */
import type { BspMap } from './bsp/bsp-file.js';
import type { StaticProp } from './bsp/static-props.js';
import { mat4FromAngles, type Mat4 } from './gl/math.js';
import type { LoadedMaterial, MaterialResolver } from './materials.js';
import { parseStudioModel, type StudioModel } from './mdl/studio.js';

/** One batch of a prop model: the triangles that share a material. */
export interface PropMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  material: LoadedMaterial;
}

/** A model, with every place the map puts it. */
export interface PropModel {
  /** Path of the model, as the map spells it. */
  path: string;
  meshes: PropMesh[];
  /** One transform per placement. */
  instances: Mat4[];
}

/** How many models are read at once. */
const CONCURRENCY = 6;

/** Props this far from everything else are left out, as the game leaves them. */
const MAX_INSTANCES = 4096;

/** Finds the three files of a model, whichever flavour of `.vtx` it ships. */
async function readModelFiles(
  resolver: MaterialResolver,
  path: string,
): Promise<{ mdl: Uint8Array; vvd: Uint8Array; vtx: Uint8Array } | undefined> {
  const base = path.replace(/\.mdl$/i, '');
  const mdl = await resolver.assets.read(`${base}.mdl`);
  if (!mdl) return undefined;
  const vvd = await resolver.assets.read(`${base}.vvd`);
  if (!vvd) return undefined;
  for (const suffix of ['.dx90.vtx', '.dx80.vtx', '.vtx', '.sw.vtx']) {
    const vtx = await resolver.assets.read(`${base}${suffix}`);
    if (vtx) return { mdl, vvd, vtx };
  }
  return undefined;
}

/**
 * Works out the material of one of a model's meshes.
 *
 * A model names its materials bare and lists the directories to look them up
 * in, so each one is tried in turn.
 */
async function resolveModelMaterial(
  resolver: MaterialResolver,
  model: StudioModel,
  index: number,
): Promise<LoadedMaterial> {
  const name = (model.materials[index] ?? '').replace(/\\/g, '/').toLowerCase();
  const paths = model.searchPaths.length > 0 ? model.searchPaths : [''];
  let first: LoadedMaterial | undefined;
  for (const raw of paths) {
    const directory = raw
      .replace(/\\/g, '/')
      .toLowerCase()
      .replace(/^\/+|\/+$/g, '');
    const full = directory ? `${directory}/${name}` : name;
    const material = await resolver.resolve(full);
    if (material.texture) return material;
    first ??= material;
  }
  return first ?? resolver.resolve(name);
}

/** Options for {@link loadStaticProps}. */
export interface LoadPropsOptions {
  /** Called as models resolve, for progress reporting. */
  onProgress?: (done: number, total: number) => void;
  /** Called once per model that could not be read. */
  onMissing?: (path: string) => void;
}

/**
 * Reads every distinct model a map places, with its placements.
 *
 * A model that cannot be found or read is reported and skipped: a missing
 * prop costs that prop, not the map.
 */
export async function loadStaticProps(
  map: BspMap,
  resolver: MaterialResolver,
  options: LoadPropsOptions = {},
): Promise<PropModel[]> {
  const byModel = new Map<string, StaticProp[]>();
  for (const prop of map.staticProps) {
    const list = byModel.get(prop.model) ?? [];
    if (list.length < MAX_INSTANCES) list.push(prop);
    byModel.set(prop.model, list);
  }

  const paths = [...byModel.keys()];
  const out: PropModel[] = [];
  let done = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const path = paths[index];
      if (path === undefined) return;
      try {
        const files = await readModelFiles(resolver, path);
        if (!files) {
          options.onMissing?.(path);
          continue;
        }
        const model = parseStudioModel(files.mdl, files.vvd, files.vtx);
        const meshes: PropMesh[] = [];
        for (const mesh of model.meshes) {
          const material = await resolveModelMaterial(resolver, model, mesh.material);
          if (!material.drawn) continue;
          meshes.push({
            positions: mesh.positions,
            normals: mesh.normals,
            uvs: mesh.uvs,
            indices: mesh.indices,
            material,
          });
        }
        if (meshes.length === 0) continue;
        const instances = (byModel.get(path) ?? []).map((prop) =>
          mat4FromAngles(prop.angles, prop.origin, prop.scale),
        );
        out.push({ path, meshes, instances });
      } catch {
        options.onMissing?.(path);
      } finally {
        options.onProgress?.(++done, paths.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker));
  return out;
}
