import { parseReplay, type MtvReplay, type PlayerState } from '@caixax/mtv';
import { parseBsp, type BspMap } from './bsp/bsp-file.js';
import { MapRenderer } from './gl/map-renderer.js';
import { resolveMap, type ResolveMapOptions } from './map-resolver.js';
import {
  firstPersonCamera,
  thirdPersonCamera,
  PlaybackClock,
  type CameraMode,
} from './playback.js';

/** Options for {@link createViewer}. */
export interface ViewerOptions extends ResolveMapOptions {
  /** Field of view in degrees. Defaults to 90. */
  fov?: number;
}

/** What to load: a replay with an optional explicit map. */
export interface LoadInput {
  /** Replay file bytes or a URL to fetch them from. */
  replay: ArrayBuffer | Uint8Array | string;
  /**
   * Map bytes or URL. When omitted, the map is resolved through the viewer's
   * map sources and the official API (note: the official API and CDN do not
   * send CORS headers for third party origins, so in-browser resolution needs
   * same-origin sources or a proxy).
   */
  map?: ArrayBuffer | Uint8Array | string;
}

/** The playback viewer. Create with {@link createViewer}. */
export interface Viewer {
  readonly clock: PlaybackClock | null;
  readonly replay: MtvReplay | null;
  readonly map: BspMap | null;
  load(input: LoadInput): Promise<void>;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setSpeed(speed: number): void;
  setCamera(mode: CameraMode): void;
  /** Subscribes to per-frame player state updates. Returns an unsubscriber. */
  onTick(fn: (state: PlayerState) => void): () => void;
  destroy(): void;
}

async function toBytes(input: ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  if (typeof input === 'string') {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`fetch ${input}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Creates a replay viewer bound to a canvas.
 *
 * Current rendering: shaded map geometry with flat material colors and a
 * player marker; textures and lightmaps are under development.
 */
export function createViewer(canvas: HTMLCanvasElement, options: ViewerOptions = {}): Viewer {
  const gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) throw new Error('WebGL2 is required');
  const renderer = new MapRenderer(gl);

  let replay: MtvReplay | null = null;
  let map: BspMap | null = null;
  let clock: PlaybackClock | null = null;
  let cameraMode: CameraMode = 'firstperson';
  let raf = 0;
  let lastTime = 0;
  let destroyed = false;
  const tickListeners = new Set<(state: PlayerState) => void>();

  // free camera state
  const free = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0 };
  const keys = new Set<string>();
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (down) keys.add(e.code);
    else keys.delete(e.code);
  };
  const keyDown = onKey(true);
  const keyUp = onKey(false);
  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== canvas || cameraMode !== 'free') return;
    free.yaw -= e.movementX * 0.2;
    free.pitch = Math.max(-89, Math.min(89, free.pitch + e.movementY * 0.2));
  };
  const onClick = () => {
    if (cameraMode === 'free') canvas.requestPointerLock();
  };
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('click', onClick);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);

  const frame = (now: number): void => {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    const dt = lastTime === 0 ? 0 : Math.min(0.25, (now - lastTime) / 1000);
    lastTime = now;
    if (!clock) return;
    const state = clock.advance(dt);
    for (const fn of tickListeners) fn(state);

    // free camera movement
    if (cameraMode === 'free') {
      const speed = (keys.has('ShiftLeft') ? 1200 : 400) * dt;
      const yawRad = (free.yaw * Math.PI) / 180;
      const pitchRad = (free.pitch * Math.PI) / 180;
      const fwd = [
        Math.cos(pitchRad) * Math.cos(yawRad),
        Math.cos(pitchRad) * Math.sin(yawRad),
        -Math.sin(pitchRad),
      ];
      const right = [Math.sin(yawRad), -Math.cos(yawRad), 0];
      const move = (v: number[], s: number) => {
        free.x += v[0]! * s;
        free.y += v[1]! * s;
        free.z += v[2]! * s;
      };
      if (keys.has('KeyW')) move(fwd, speed);
      if (keys.has('KeyS')) move(fwd, -speed);
      if (keys.has('KeyD')) move(right, speed);
      if (keys.has('KeyA')) move(right, -speed);
      if (keys.has('Space')) free.z += speed;
      if (keys.has('ControlLeft')) free.z -= speed;
    }

    const cam =
      cameraMode === 'free'
        ? {
            position: [free.x, free.y, free.z] as [number, number, number],
            pitch: free.pitch,
            yaw: free.yaw,
          }
        : cameraMode === 'thirdperson'
          ? poseToCamera(thirdPersonCamera(state))
          : poseToCamera(firstPersonCamera(state));
    renderer.render({ ...cam, fovYDegrees: options.fov ?? 90 });
  };

  const poseToCamera = (pose: {
    position: [number, number, number];
    angles: [number, number, number];
  }) => ({
    position: pose.position,
    pitch: pose.angles[0],
    yaw: pose.angles[1],
  });

  return {
    get clock() {
      return clock;
    },
    get replay() {
      return replay;
    },
    get map() {
      return map;
    },

    async load(input: LoadInput): Promise<void> {
      const replayBytes = await toBytes(input.replay);
      replay = parseReplay(replayBytes);
      let mapBytes: Uint8Array;
      if (input.map !== undefined) {
        mapBytes = await toBytes(input.map);
      } else {
        const resolved = await resolveMap(replay.header.mapName, replay.header.mapHash, options);
        mapBytes = resolved.data;
      }
      map = parseBsp(mapBytes);
      renderer.upload(map);
      clock = new PlaybackClock(replay);
      const start = replay.getPlayerState(0);
      free.x = start.origin[0];
      free.y = start.origin[1];
      free.z = start.origin[2] + 64;
      free.yaw = start.eyeAngles[1];
      free.pitch = 10;
      if (raf === 0) raf = requestAnimationFrame(frame);
    },

    play() {
      clock?.play();
    },
    pause() {
      clock?.pause();
    },
    seek(seconds: number) {
      clock?.seek(seconds);
    },
    setSpeed(speed: number) {
      clock?.setSpeed(speed);
    },
    setCamera(mode: CameraMode) {
      cameraMode = mode;
    },
    onTick(fn: (state: PlayerState) => void): () => void {
      tickListeners.add(fn);
      return () => tickListeners.delete(fn);
    },
    destroy() {
      destroyed = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      renderer.dispose();
    },
  };
}
