# mtv.js

Read Momentum Mod replays (`.mtv`, MomentumTV) and play them back in the browser on top of the real map.

> Work in progress. The parser works today (header, splits, events and the full per-tick player trajectory); the viewer and the drop-in player are under active development. This project is unofficial and not affiliated with Momentum Mod, Strata Source or Valve.

## Packages

| Package              | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| `@caixax/mtv`        | Replay parser. Zero dependencies, runs in browsers, workers and Node. |
| `@caixax/mtv-viewer` | WebGL renderer and playback engine (planned).                         |
| `mtv.js`             | Drop-in player with built-in UI (planned).                            |
| `@caixax/mtv-cli`    | Command line tools (planned).                                         |

## Quick start (parser)

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
mtv-dump run.mtv            # header, splits, events, decode summary
mtv-dump run.mtv --csv      # per-tick trajectory for spreadsheets
mtv-dump run.mtv --json     # full decoded track as JSON
```

## Format documentation

The `.mtv` format is being reverse engineered and documented in [docs/FORMAT.md](docs/FORMAT.md), with a confidence level for every field.

## Development

```sh
pnpm install
pnpm test
pnpm build
```

## License

MIT, see [LICENSE](LICENSE). Third party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
