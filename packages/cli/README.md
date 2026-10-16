# @caixax/mtv-cli

Command line tools for Momentum Mod replays.

Part of [mtv.js](https://github.com/caixax/mtv.js).

## Use it

```sh
npx @caixax/mtv-cli run.momtv
```

`mtv-dump` prints what a replay holds:

| Flag | What it prints |
| --- | --- |
| `--summary` | the header, the splits and the event timeline (the default) |
| `--header` | the header alone, without decompressing the body |
| `--json` | the whole decoded player track as JSON |
| `--csv` | the track as CSV: tick, position, angles, velocity, buttons, flags |

## Licence

MIT, copyright caixax. Not affiliated with Momentum Mod, Strata Source or Valve.
