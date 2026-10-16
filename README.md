# mtv.js

Read Momentum Mod replays (`.momtv`, MomentumTV) and play them back in the browser on top of the real map.

What hlviewer.js is for GoldSrc, this is for Momentum Mod. Unofficial, and not affiliated with Momentum Mod, Strata Source or Valve.

## Packages

| Package | What it is |
| --- | --- |
| [`@caixax/mtv`](packages/mtv) | The replay reader. Zero dependencies; browsers, workers and Node. |
| [`@caixax/mtv-viewer`](packages/viewer) | The playback engine: map resolution, the WebGL2 renderer and the clock. |
| [`@caixax/mtv-player`](packages/player) | The drop-in player: loading screen, controls and the run readout. |
| [`@caixax/mtv-cli`](packages/cli) | Command line tools. |

## Play a replay

```ts
import { createPlayer } from '@caixax/mtv-player';

createPlayer(document.querySelector('#player')!, {
  replay: '/replays/run.momtv',
  // where the game's own files are served from, for whatever a map does not pack
  assetsBaseUrl: ['/game/momentum', '/game/platform'],
  vpkUrls: ['/game/mount/hl2_dir.vpk'],
});
```

Or in a plain page, with no build step:

```html
<div id="player" style="height: 540px"></div>
<script src="https://unpkg.com/@caixax/mtv-player/dist/mtv-player.global.js"></script>
<script>
  MTV.createPlayer(document.getElementById('player'), { replay: 'run.momtv' });
</script>
```

## Read a replay

```ts
import { parseReplay, readHeader } from '@caixax/mtv';

const data = new Uint8Array(await file.arrayBuffer());

// cheap: header only, no decompression (useful for listings)
const header = readHeader(data);
console.log(header.mapName, header.playerName, header.runTime);

// full parse: splits, events, classes and the per-tick player track
const replay = parseReplay(data);
console.log(replay.events); // zone and timer events
const state = replay.getPlayerState(1500); // { origin, eyeAngles, velocity, buttons, ... }
const track = replay.toTrack(); // compact typed arrays for playback
```

Or from the command line:

```sh
mtv-dump run.momtv            # header, splits, events, decode summary
mtv-dump run.momtv --csv      # per-tick trajectory for spreadsheets
mtv-dump run.momtv --json     # full decoded track as JSON
```

## What it draws

The map's brush geometry with its baked lighting, its materials, its terrain and the props it places, under the sky it asks for, with the parts the replay recorded moving as they moved: the traps of a deathrun, the flippers of a pinball map, the doors a run opens.

Nothing of the game is bundled. Materials and models are read the way the engine reads them, from the map's own pakfile first and then from whatever files a host application chooses to serve, with VPK archives read a few kilobytes at a time over range requests.

Everything that takes is read here, with no dependencies: BSP 19 to 25, VTF 7.0 to 7.6 (including Strata Source's Zstandard compressed images and BC7), VMT, VPK, studio models, and Valve's LZMA.

## Game files

A replay is not a recording of pixels: it says where the runner was, and the map does the rest. So a page needs the map, which the viewer downloads from the official CDN by itself, and whatever materials the map does not pack, which come from a Momentum installation the host serves.

A map that packs everything needs nothing else. A port of a map from another Valve game may ask for that game's materials, which only someone who owns it can serve.

## Format documentation

The `.momtv` format and what the viewer had to learn about Strata Source's map, material, texture and model files are written down in [docs/FORMAT.md](docs/FORMAT.md), with a confidence level for every field.

## Development

```sh
pnpm install
pnpm test
pnpm build
```

## Licence

MIT, see [LICENSE](LICENSE). Third party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
