# mtv.js

Read Momentum Mod replays (`.mtv`, MomentumTV) and play them back in the browser on top of the real map.

> Work in progress. The parser (header, splits, body decompression) works today; the frame decoder, viewer and drop-in player are under active development. This project is unofficial and not affiliated with Momentum Mod, Strata Source or Valve.

## Packages

| Package              | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| `@caixax/mtv`        | Replay parser. Zero dependencies, runs in browsers, workers and Node. |
| `@caixax/mtv-viewer` | WebGL renderer and playback engine (planned).                         |
| `mtv.js`             | Drop-in player with built-in UI (planned).                            |
| `@caixax/mtv-cli`    | Command line tools (planned).                                         |

## Quick start (parser)

```ts
import { readHeader, readSplits, decompressBody } from '@caixax/mtv';

const data = new Uint8Array(await file.arrayBuffer());
const header = readHeader(data);
console.log(header.mapName, header.playerName, header.runTime);

const { splits, bodyOffset } = readSplits(data);
const body = decompressBody(data, header, bodyOffset);
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
