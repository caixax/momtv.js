# @caixax/mtv

Reader for Momentum Mod replays (`.momtv`, MomentumTV). Zero dependencies, `DataView` and `Uint8Array` only, so it runs the same in a browser, a worker and Node.

Part of [mtv.js](https://github.com/caixax/mtv.js).

## Use it

```ts
import { parseReplay, readHeader } from '@caixax/mtv';

const data = new Uint8Array(await file.arrayBuffer());

// the header alone, without decompressing anything: enough for a listing
const header = readHeader(data);
console.log(header.mapName, header.playerName, header.runTime);

// the whole thing: splits, events, the class table and the per tick track
const replay = parseReplay(data);
const state = replay.getPlayerState(1500);
console.log(state.origin, state.eyeAngles, state.velocity, state.buttons);

// the map's moving parts, as the recorder saw them
for (const entity of replay.toEntityTracks()) {
  console.log(entity.className, entity.classIndex, entity.moves);
}
```

## What it reads

- The fixed header and the run splits.
- The event timeline, the networked class table, the sound table and the baselines.
- Every delta frame, walked exactly: the player's position, angles, velocity, buttons and flags on every tick, and the same for the entities the map moves.
- Valve's LZMA framing, which the body is compressed with.

The format was reverse engineered from the files themselves; what is known and how sure it is lives in [docs/FORMAT.md](https://github.com/caixax/mtv.js/blob/main/docs/FORMAT.md).

## Errors

Anything the parser cannot make sense of throws an `MtvError` carrying a stable `code`, never a silent wrong answer. Truncated files, bad magic numbers and flipped bytes all throw rather than hang.

## Licence

MIT, copyright caixax. Not affiliated with Momentum Mod, Strata Source or Valve.
