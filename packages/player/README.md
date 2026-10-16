# @caixax/mtv-player

Drop-in player for Momentum Mod replays: the [viewer](../viewer) with a loading screen, playback controls and the run readout a runner expects.

Part of [mtv.js](../../README.md).

## Use it

```ts
import { createPlayer } from '@caixax/mtv-player';

const player = createPlayer(document.querySelector('#player')!, {
  replay: '/replays/run.momtv',
  // where the game's files are served from, for whatever a map does not pack
  assetsBaseUrl: ['/game/momentum', '/game/platform'],
  vpkUrls: ['/game/mount/hl2_dir.vpk'],
});
```

The container needs a size; the player fills it. Everything else it brings itself: its styles go in as one stylesheet, it fetches nothing from a third party, and it has no dependencies outside this repository.

In a plain page, the bundle puts `MTV` on the window:

```html
<div id="player" style="height: 540px"></div>
<script src="https://unpkg.com/@caixax/mtv-player/dist/mtv-player.global.js"></script>
<script>
  MTV.createPlayer(document.getElementById('player'), { replay: 'run.momtv' });
</script>
```

## What it shows

- A loading screen that follows the replay, the map download, the materials, the props and the sky.
- The run timer, counted from the tick the run starts on and frozen at the recorded time, with the last zone passed underneath.
- Speed in units per second, the tick, whether the runner is on the ground, and the keys being pressed.
- A bar with play, a seek line marked at every zone, the time, the speed multiplier, the camera and a settings flyout (field of view, run readout, props, sky, loop).

Keys: space plays and pauses, the arrows seek (hold shift for one second steps), `f` is fullscreen, `c` changes camera. In the free camera, `WASD` fly and space rises.

## Options

Everything [`createViewer`](../viewer) takes, plus:

| Option | What it does |
| --- | --- |
| `replay` | URL or bytes to load straight away |
| `map` | the map bytes, when the caller already has them |
| `autoplay` | start playing when ready (default true) |
| `loop` | start again at the end |
| `speed` | playback speed to start at |
| `camera` | `firstperson`, `thirdperson` or `free` |
| `hud` | show the run readout (default true) |
| `onError` | called when loading fails |

## Licence

MIT, copyright caixax.
