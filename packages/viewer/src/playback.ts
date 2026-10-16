import { trackStateAt, type MomtvReplay, type PlayerState } from '@caixax/momtv';

/** Camera modes supported by the playback engine. */
export type CameraMode = 'firstperson' | 'thirdperson' | 'free';

/** Events emitted by {@link PlaybackClock}. */
export interface PlaybackEvents {
  tick: (state: PlayerState) => void;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  end: () => void;
}

/**
 * Deterministic playback clock over a parsed replay. Owns time, speed and
 * looping; rendering layers subscribe to `tick`.
 *
 * The clock is driven by {@link PlaybackClock.advance} with real elapsed
 * seconds (from requestAnimationFrame or a test), so it contains no timers of
 * its own and is fully testable.
 */
export class PlaybackClock {
  private readonly replay: MomtvReplay;
  private time_ = 0;
  private speed_ = 1;
  private playing_ = false;
  private listeners: { [K in keyof PlaybackEvents]: PlaybackEvents[K][] } = {
    tick: [],
    play: [],
    pause: [],
    seek: [],
    end: [],
  };

  constructor(replay: MomtvReplay) {
    this.replay = replay;
  }

  /** Total duration in seconds (recorded ticks times the tick interval). */
  get duration(): number {
    return (this.replay.frameCount - 1) * this.replay.tickInterval;
  }

  /** Current playback position in seconds. */
  get time(): number {
    return this.time_;
  }

  /** Current playback speed multiplier. */
  get speed(): number {
    return this.speed_;
  }

  /** Whether the clock is advancing. */
  get playing(): boolean {
    return this.playing_;
  }

  /** Current tick (fractional). */
  get tick(): number {
    return this.time_ / this.replay.tickInterval;
  }

  /** The interpolated player state at the current time. */
  get state(): PlayerState {
    return this.replay.getPlayerStateAtTime(this.time_);
  }

  on<K extends keyof PlaybackEvents>(event: K, fn: PlaybackEvents[K]): () => void {
    this.listeners[event].push(fn);
    return () => {
      const list = this.listeners[event];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    };
  }

  private emit<K extends keyof PlaybackEvents>(
    event: K,
    ...args: Parameters<PlaybackEvents[K]>
  ): void {
    for (const fn of [...this.listeners[event]]) {
      (fn as (...a: Parameters<PlaybackEvents[K]>) => void)(...args);
    }
  }

  play(): void {
    if (this.playing_) return;
    if (this.time_ >= this.duration) this.time_ = 0;
    this.playing_ = true;
    this.emit('play');
  }

  pause(): void {
    if (!this.playing_) return;
    this.playing_ = false;
    this.emit('pause');
  }

  /** Sets the playback speed (clamped to 0.05x to 16x). */
  setSpeed(speed: number): void {
    this.speed_ = Math.min(16, Math.max(0.05, speed));
  }

  /** Jumps to a time in seconds (clamped to the replay duration). */
  seek(seconds: number): void {
    this.time_ = Math.min(this.duration, Math.max(0, seconds));
    this.emit('seek', this.time_);
    this.emit('tick', this.state);
  }

  /** Jumps to a tick. */
  seekTick(tick: number): void {
    this.seek(tick * this.replay.tickInterval);
  }

  /** Steps exactly one tick forward or backward and pauses. */
  step(direction: 1 | -1): void {
    this.playing_ = false;
    const t = Math.round(this.tick) + direction;
    this.seekTick(t);
  }

  /**
   * Advances the clock by `elapsedSeconds` of real time (scaled by speed) and
   * emits a tick. Call this from the render loop.
   */
  advance(elapsedSeconds: number): PlayerState {
    if (this.playing_) {
      this.time_ += elapsedSeconds * this.speed_;
      if (this.time_ >= this.duration) {
        this.time_ = this.duration;
        this.playing_ = false;
        this.emit('end');
      }
    }
    const state = this.state;
    this.emit('tick', state);
    return state;
  }
}

/** A camera pose in Source engine coordinates. */
export interface CameraPose {
  position: [number, number, number];
  /** [pitch, yaw, roll] in degrees. */
  angles: [number, number, number];
}

const DEG = Math.PI / 180;

/** First person camera: eye position = origin + view offset, replay angles. */
export function firstPersonCamera(state: PlayerState): CameraPose {
  return {
    position: [
      state.origin[0] + state.viewOffset[0],
      state.origin[1] + state.viewOffset[1],
      state.origin[2] + state.viewOffset[2],
    ],
    angles: [state.eyeAngles[0], state.eyeAngles[1], 0],
  };
}

/** Third person chase camera at `distance` units behind the view direction. */
export function thirdPersonCamera(state: PlayerState, distance = 150): CameraPose {
  const pitch = state.eyeAngles[0] * DEG;
  const yaw = state.eyeAngles[1] * DEG;
  const forward: [number, number, number] = [
    Math.cos(pitch) * Math.cos(yaw),
    Math.cos(pitch) * Math.sin(yaw),
    -Math.sin(pitch),
  ];
  const eye = firstPersonCamera(state).position;
  return {
    position: [
      eye[0] - forward[0] * distance,
      eye[1] - forward[1] * distance,
      eye[2] - forward[2] * distance,
    ],
    angles: [state.eyeAngles[0], state.eyeAngles[1], 0],
  };
}

export { trackStateAt };
