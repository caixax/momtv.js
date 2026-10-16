# @caixax/mtv-viewer

Playback engine for Momentum Mod replays: it resolves the map a replay was recorded on, reads it, and draws the run in WebGL2.

Part of [mtv.js](https://github.com/caixax/mtv.js). For a player with controls and a run readout, use [@caixax/mtv-player](../player).

## Use it

```ts
import { createViewer } from '@caixax/mtv-viewer';

const viewer = createViewer(canvas, {
  // where the game's own files are served from, for whatever a map does not pack
  assetsBaseUrl: ['/game/momentum', '/game/platform'],
  vpkUrls: ['/game/mount/hl2_dir.vpk'],
});
await viewer.load({ replay: bytes });
viewer.play();
```

## What it draws

- The map's brush geometry with its baked lighting, its materials and its terrain.
- The props the map places, each model read once and drawn at every placement.
- The sky.
- The map's moving parts, driven by what the replay recorded: rotating traps, doors, platforms.

Materials are looked up the way the engine looks them up: the map's own pakfile first, then VPK archives read over range requests, then loose files. Nothing is bundled; a host application points the viewer at whatever it is willing to serve.

It carries its own readers for everything that takes: BSP 19 to 25, VTF 7.0 to 7.6 (including Strata Source's Zstandard compressed images and BC7), VMT, VPK, studio models and Valve's LZMA.

## Licence

MIT, copyright caixax. Not affiliated with Momentum Mod, Strata Source or Valve.
