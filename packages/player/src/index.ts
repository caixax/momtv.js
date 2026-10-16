/**
 * Drop-in player for Momentum Mod replays.
 *
 * It owns the whole thing: a loading screen while the replay and its map come
 * down, the viewer rendering the run, a bar to drive playback and the run
 * readout a runner expects (timer, speed, keys).
 *
 * ```ts
 * const player = createPlayer(document.querySelector('#player')!, {
 *   replay: '/replays/run.momtv',
 *   assetsBaseUrl: '/game/momentum',
 * });
 * ```
 */
import { Button, type PlayerState } from '@caixax/mtv';
import { createViewer, resolveMap, type ViewerOptions, type Viewer } from '@caixax/mtv-viewer';
import { buildUi, LOADING_STEPS } from './ui.js';

/** Options for {@link createPlayer}. */
export interface PlayerOptions extends ViewerOptions {
  /** The replay: a URL to fetch, or its bytes. */
  replay?: string | ArrayBuffer | Uint8Array;
  /** The map, when the caller has it; otherwise it is resolved and fetched. */
  map?: string | ArrayBuffer | Uint8Array;
  /** Start playing as soon as it is ready. Defaults to true. */
  autoplay?: boolean;
  /** Start again at the end. Defaults to false. */
  loop?: boolean;
  /** Playback speed to start at. Defaults to 1. */
  speed?: number;
  /** Camera to start with. Defaults to first person. */
  camera?: 'firstperson' | 'thirdperson' | 'free';
  /** Show the timer, speed and keys. Defaults to true. */
  hud?: boolean;
  /** Called when loading fails, instead of only showing it on screen. */
  onError?: (error: Error) => void;
}

/** A running player. */
export interface Player {
  /** The viewer underneath, for anything the chrome does not cover. */
  readonly viewer: Viewer;
  /** Loads another replay into the same player. */
  load(replay: string | ArrayBuffer | Uint8Array, map?: string | ArrayBuffer | Uint8Array): Promise<void>;
  play(): void;
  pause(): void;
  /** Seeks to a time in seconds. */
  seek(seconds: number): void;
  setSpeed(speed: number): void;
  destroy(): void;
}

/** Seconds as `m:ss.mmm`, the way a run time is written. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00.000';
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${sign}${minutes}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** Bytes as a short, readable size. */
function formatSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/** How long the bar stays up after the pointer stops moving. */
const IDLE_DELAY = 2600;

/**
 * Creates a player inside a container.
 *
 * The container is emptied of nothing: the player appends its own element and
 * removes it again on {@link Player.destroy}.
 */
export function createPlayer(container: HTMLElement, options: PlayerOptions = {}): Player {
  const ui = buildUi(container);
  const baseFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  // What the loading screen is waiting for, and how far along it is.
  const progress = new Map<string, number>();
  let currentStep = '';
  const setStep = (step: string, fraction: number, detail = ''): void => {
    progress.set(step, Math.max(0, Math.min(1, fraction)));
    if (step !== currentStep) {
      currentStep = step;
      for (const [name, node] of ui.loading.steps) {
        const here = LOADING_STEPS.indexOf(name as (typeof LOADING_STEPS)[number]);
        const at = LOADING_STEPS.indexOf(step as (typeof LOADING_STEPS)[number]);
        node.className = `mtvp-load-step${here < at ? ' mtvp-done' : here === at ? ' mtvp-active' : ''}`;
      }
    }
    let done = 0;
    for (const name of LOADING_STEPS) done += progress.get(name) ?? 0;
    ui.loading.fill.style.width = `${(done / LOADING_STEPS.length) * 100}%`;
    ui.loading.detail.textContent = detail;
  };

  /** Fetches, reporting how much of a large download has arrived. */
  const fetchWithProgress = async (
    input: RequestInfo | URL,
    step: string,
    label: string,
  ): Promise<Uint8Array> => {
    const res = await baseFetch(input);
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      read += value.length;
      setStep(
        step,
        total > 0 ? read / total : 0.5,
        total > 0 ? `${label} ${formatSize(read)} of ${formatSize(total)}` : `${label} ${formatSize(read)}`,
      );
    }
    const out = new Uint8Array(read);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  };

  const viewerOptions: ViewerOptions = {
    ...options,
    onLoadStatus: (stage, done, total) => {
      const fraction = total > 0 ? done / total : 1;
      const label =
        stage === 'materials'
          ? `materials ${done} of ${total}`
          : stage === 'props'
            ? `models ${done} of ${total}`
            : 'sky';
      setStep(stage, fraction, label);
      options.onLoadStatus?.(stage, done, total);
    },
  };
  const viewer = createViewer(ui.canvas, viewerOptions);

  // --- state the chrome keeps ---
  let startTick = 0;
  let endTime = 0;
  let tickInterval = 0.015625;
  let duration = 0;
  let loop = options.loop ?? false;
  let dragging = false;
  let destroyed = false;
  let idleTimer = 0;

  const resize = (): void => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    ui.canvas.width = Math.max(1, Math.round(ui.canvas.clientWidth * ratio));
    ui.canvas.height = Math.max(1, Math.round(ui.canvas.clientHeight * ratio));
  };
  const observer = new ResizeObserver(resize);
  observer.observe(ui.canvas);
  resize();

  /** Zone events in order, to show the last one the run went through. */
  let zones: { tick: number; label: string }[] = [];

  // --- the run readout ---
  const KEYS: [string, number][] = [
    ['forward', Button.Forward],
    ['back', Button.Back],
    ['left', Button.MoveLeft],
    ['right', Button.MoveRight],
    ['jump', Button.Jump],
    ['duck', Button.Duck],
  ];
  const offTick = viewer.onTick((state: PlayerState) => {
    const clock = viewer.clock;
    if (!clock) return;
    const elapsed = Math.max(0, (state.tick - startTick) * tickInterval);
    const finished = endTime > 0 && elapsed >= endTime;
    ui.hud.timer.textContent = formatTime(finished ? endTime : elapsed);
    ui.hud.timer.classList.toggle('mtvp-finished', finished);
    const speed = Math.hypot(state.velocity[0], state.velocity[1]);
    ui.hud.speed.innerHTML = `${Math.round(speed)}<span>u/s</span>`;
    ui.hud.detail.textContent =
      `tick ${state.tick}  ${state.onGround ? 'ground' : 'air'}\n` +
      `pos ${state.origin.map((v) => Math.round(v)).join(' ')}`;
    // the last zone the run went through, the way a split reads
    let passed = '';
    for (const zone of zones) {
      if (zone.tick > state.tick) break;
      passed = zone.label;
    }
    ui.hud.split.textContent = passed;
    for (const [name, bit] of KEYS) {
      ui.hud.keys.get(name)?.classList.toggle('mtvp-on', (state.buttons & bit) !== 0);
    }
    if (!dragging) {
      const fraction = duration > 0 ? clock.time / duration : 0;
      ui.seekFill.style.width = `${fraction * 100}%`;
      ui.seekHead.style.left = `${fraction * 100}%`;
      ui.time.textContent = `${formatTime(clock.time)} / ${formatTime(duration)}`;
    }
    ui.playButton.textContent = clock.playing ? '❚❚' : '▶';
    if (loop && !clock.playing && clock.time >= duration - 1e-3) {
      viewer.seek(0);
      viewer.play();
    }
  });

  // --- driving playback ---
  const togglePlay = (): void => {
    const clock = viewer.clock;
    if (!clock) return;
    if (clock.playing) viewer.pause();
    else viewer.play();
    ui.playButton.textContent = clock.playing ? '❚❚' : '▶';
  };
  ui.playButton.addEventListener('click', togglePlay);

  const seekFromPointer = (event: PointerEvent): void => {
    const box = ui.seek.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width)));
    ui.seekFill.style.width = `${fraction * 100}%`;
    ui.seekHead.style.left = `${fraction * 100}%`;
    ui.time.textContent = `${formatTime(fraction * duration)} / ${formatTime(duration)}`;
    viewer.seek(fraction * duration);
  };
  ui.seek.addEventListener('pointerdown', (event) => {
    dragging = true;
    ui.seek.classList.add('mtvp-dragging');
    ui.seek.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  });
  ui.seek.addEventListener('pointermove', (event) => {
    if (dragging) seekFromPointer(event);
  });
  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    ui.seek.classList.remove('mtvp-dragging');
    if (ui.seek.hasPointerCapture(event.pointerId)) ui.seek.releasePointerCapture(event.pointerId);
  };
  ui.seek.addEventListener('pointerup', endDrag);
  ui.seek.addEventListener('pointercancel', endDrag);

  ui.speedSelect.addEventListener('change', () => viewer.setSpeed(Number(ui.speedSelect.value)));
  ui.cameraSelect.addEventListener('change', () =>
    viewer.setCamera(ui.cameraSelect.value as 'firstperson'),
  );
  ui.settingsButton.addEventListener('click', () => ui.menu.classList.toggle('mtvp-open'));
  ui.fullscreenButton.addEventListener('click', () => {
    if (document.fullscreenElement === ui.root) void document.exitFullscreen();
    else void ui.root.requestFullscreen?.();
  });
  ui.settings.fov.addEventListener('input', () => viewer.setFov(Number(ui.settings.fov.value)));
  ui.settings.hud.addEventListener('change', () => {
    ui.hud.panel.style.display = ui.settings.hud.checked ? '' : 'none';
  });
  ui.settings.props.addEventListener('change', () =>
    viewer.setLayer('props', ui.settings.props.checked),
  );
  ui.settings.sky.addEventListener('change', () => viewer.setLayer('sky', ui.settings.sky.checked));
  ui.settings.loop.addEventListener('change', () => {
    loop = ui.settings.loop.checked;
  });

  // the bar steps aside when the pointer is still
  const wake = (): void => {
    ui.root.classList.remove('mtvp-idle');
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (viewer.clock?.playing && !ui.menu.classList.contains('mtvp-open')) {
        ui.root.classList.add('mtvp-idle');
      }
    }, IDLE_DELAY);
  };
  ui.root.addEventListener('pointermove', wake);
  ui.root.addEventListener('pointerleave', () => {
    if (viewer.clock?.playing) ui.root.classList.add('mtvp-idle');
  });

  const onKey = (event: KeyboardEvent): void => {
    if (!ui.root.isConnected) return;
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
    const clock = viewer.clock;
    if (!clock) return;
    if (event.code === 'Space') {
      event.preventDefault();
      // In the free camera space flies upwards, so playback keeps its hands off.
      if (ui.cameraSelect.value !== 'free') togglePlay();
    } else if (event.code === 'ArrowLeft') {
      viewer.seek(Math.max(0, clock.time - (event.shiftKey ? 1 : 5)));
    } else if (event.code === 'ArrowRight') {
      viewer.seek(Math.min(duration, clock.time + (event.shiftKey ? 1 : 5)));
    } else if (event.code === 'KeyF') {
      ui.fullscreenButton.click();
    } else if (event.code === 'KeyC') {
      const order = ['firstperson', 'thirdperson', 'free'];
      const next = order[(order.indexOf(ui.cameraSelect.value) + 1) % order.length]!;
      ui.cameraSelect.value = next;
      viewer.setCamera(next as 'firstperson');
    }
    wake();
  };
  window.addEventListener('keydown', onKey);

  /** Puts a mark on the seek bar for every zone the run passed. */
  const drawZones = (): void => {
    ui.seekZones.replaceChildren();
    const events = viewer.replay?.events ?? [];
    zones = events
      .filter((event) => event.type === 2 || event.type === 3)
      .map((event) => ({
        tick: event.tick,
        label:
          event.type === 3
            ? `finish ${formatTime(event.time)}`
            : `${event.minorNum > 1 ? `checkpoint ${event.minorNum}` : `stage ${event.majorNum}`} ${formatTime(event.time)}`,
      }))
      .sort((a, b) => a.tick - b.tick);
    for (const event of events) {
      if (event.type !== 2) continue;
      const at = (event.tick * tickInterval) / Math.max(0.001, duration);
      if (at <= 0 || at >= 1) continue;
      const mark = document.createElement('div');
      mark.className = 'mtvp-seek-zone';
      mark.style.left = `${at * 100}%`;
      ui.seekZones.append(mark);
    }
  };

  const fail = (error: Error): void => {
    ui.loading.panel.classList.remove('mtvp-gone');
    ui.loading.title.textContent = 'Could not load the replay';
    ui.loading.detail.textContent = '';
    const message = document.createElement('div');
    message.className = 'mtvp-error';
    message.textContent = error.message;
    ui.loading.panel.append(message);
    options.onError?.(error);
  };

  async function load(
    replay: string | ArrayBuffer | Uint8Array,
    map?: string | ArrayBuffer | Uint8Array,
  ): Promise<void> {
    ui.loading.panel.classList.remove('mtvp-gone');
    ui.loading.title.textContent = 'Loading replay';
    ui.loading.panel.querySelectorAll('.mtvp-error').forEach((node) => node.remove());
    progress.clear();
    setStep('replay', 0, '');
    try {
      const replayBytes =
        typeof replay === 'string'
          ? await fetchWithProgress(replay, 'replay', 'replay')
          : replay instanceof Uint8Array
            ? replay
            : new Uint8Array(replay);
      setStep('replay', 1, '');

      let mapBytes: Uint8Array | undefined;
      if (typeof map === 'string') {
        mapBytes = await fetchWithProgress(map, 'map', 'map');
      } else if (map) {
        mapBytes = map instanceof Uint8Array ? map : new Uint8Array(map);
      } else {
        // The map is resolved here rather than inside the viewer, so the
        // download it needs can be shown as it arrives.
        const { readHeader } = await import('@caixax/mtv');
        const header = readHeader(replayBytes);
        ui.loading.title.textContent = `Loading ${header.mapName}`;
        setStep('map', 0, 'looking up the map');
        const tracked: typeof fetch = async (input, init) => {
          const res = await baseFetch(input, init);
          const total = Number(res.headers.get('content-length') ?? 0);
          if (!res.body || total < 1_000_000) return res;
          let read = 0;
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const reader = res.body!.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                read += value.length;
                setStep('map', read / total, `map ${formatSize(read)} of ${formatSize(total)}`);
                controller.enqueue(value);
              }
              controller.close();
            },
          });
          return new Response(stream, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        };
        const resolved = await resolveMap(header.mapName, header.mapHash, {
          ...options,
          allowHashMismatch: options.allowHashMismatch ?? true,
          fetch: tracked,
        });
        mapBytes = resolved.data;
      }
      setStep('map', 1, '');

      setStep('materials', 0, '');
      await viewer.load({ replay: replayBytes, map: mapBytes });
      setStep('sky', 1, '');

      const replayFile = viewer.replay!;
      const track = replayFile.toTrack();
      tickInterval = replayFile.tickInterval;
      startTick = track.startTick;
      endTime = replayFile.header.runTime;
      duration = viewer.clock?.duration ?? 0;
      drawZones();
      viewer.setSpeed(Number(ui.speedSelect.value));
      viewer.setCamera(ui.cameraSelect.value as 'firstperson');
      ui.loading.panel.classList.add('mtvp-gone');
      wake();
      if (options.autoplay ?? true) viewer.play();
    } catch (error) {
      fail(error as Error);
    }
  }

  if (options.speed) {
    ui.speedSelect.value = String(options.speed);
    viewer.setSpeed(options.speed);
  }
  if (options.camera) ui.cameraSelect.value = options.camera;
  if (options.hud === false) {
    ui.settings.hud.checked = false;
    ui.hud.panel.style.display = 'none';
  }
  if (options.loop) ui.settings.loop.checked = true;
  if (options.fov) ui.settings.fov.value = String(options.fov);
  if (options.replay) void load(options.replay, options.map);

  return {
    viewer,
    load,
    play: () => viewer.play(),
    pause: () => viewer.pause(),
    seek: (seconds: number) => viewer.seek(seconds),
    setSpeed: (speed: number) => {
      ui.speedSelect.value = String(speed);
      viewer.setSpeed(speed);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offTick();
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(idleTimer);
      observer.disconnect();
      viewer.destroy();
      ui.root.remove();
    },
  };
}
