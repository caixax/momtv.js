/**
 * Playback engine for Momentum Mod replays.
 *
 * This package currently ships the non-rendering foundations: exact map
 * version resolution and download, the playback clock and camera math. The
 * WebGL renderer (BSP geometry, materials, lightmaps) is under development.
 *
 * @packageDocumentation
 */

export {
  directorySource,
  officialMapUrls,
  resolveMap,
  sha1Hex,
  type MapSource,
  type ResolveMapOptions,
  type ResolvedMap,
} from './map-resolver.js';
export {
  firstPersonCamera,
  thirdPersonCamera,
  PlaybackClock,
  type CameraMode,
  type CameraPose,
  type PlaybackEvents,
} from './playback.js';
export {
  parseBsp,
  parseEntitiesText,
  type BspEntity,
  type BspMap,
  type BspMaterial,
  type BspMeshGroup,
  type BspModel,
} from './bsp/bsp-file.js';
export { MapRenderer, type RenderCamera } from './gl/map-renderer.js';
export { loadMaterials, type LoadedMaterial, type LoadMaterialsOptions } from './materials.js';
export { readPakfile, readPakEntry, type PakEntry } from './bsp/pakfile.js';
export { parseVtf, parseVmtBaseTexture, type DecodedTexture } from './bsp/vtf.js';
export { createViewer, type LoadInput, type Viewer, type ViewerOptions } from './viewer.js';
