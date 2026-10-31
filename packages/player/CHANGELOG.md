# @caixax/momtv-player

## 0.2.0

### Minor Changes

- 45b618e: Replays play from start to finish. The frames are now read the way the game reads them, with the recording modes and array rules taken from the engine itself, and every one of 373 replays decodes exactly: no lost frames, every keyframe anchor met, every baseline read to the bit. Before, about one frame in eight was lost and one replay in ten would not open, which is what made runs freeze and skip.
  
  `@caixax/momtv` also opens format version 1 replays and Zstandard compressed bodies, reads the temp entity class table and revision 2 sound names, starts the player and every map entity from its baseline and the first keyframe rather than from nothing, times the stages and the finish the way the header does, and pairs each recorded map entity with its exact brush model through the model CRC the recorder writes (`EntityTrack.model`, `modelNameCrc`). Entity tracks carry visibility and fade, entity positions use Strata Source's 65536 unit world, and the Zstandard decoder now lives here.
  
  `@caixax/momtv-viewer` reads the baked lighting of HDR compiled maps from their HDR faces, which most of Momentum's maps are, instead of painting each face with another face's light; draws the sky, which a clear between the sky and the map had always hidden; finds HDR sky images by the engine's name and falls back to its default sky; normalises material names with leading or doubled slashes; draws unlit materials at full brightness; filters textures anisotropically; and hides and fades the map entities a replay hides and fades.
  
  `@caixax/momtv-player` labels the stages and the finish by what they are rather than by a raw event number, which on current replays called the run start the finish.

### Patch Changes

- Updated dependencies [f904f87]
  - @caixax/momtv@0.2.0
  - @caixax/momtv-viewer@0.2.0

## 0.1.1

### Patch Changes

- 77308ec: Show a dash instead of NaN for the run timer of timeline events. The compact timeline newer replays write does not carry a timer value per event, so the dump prints a dash and the player labels its seek marks with where the event sits in the playback.

## 0.1.0

### Minor Changes

- First release.
  
  `@caixax/momtv` reads a Momentum Mod replay end to end: the header, the run splits, the event timeline and every delta frame, giving the player's position, angles, velocity, buttons and flags on every tick, and the same for the entities a map moves. Zero dependencies, the same in a browser, a worker and Node.
  
  `@caixax/momtv-viewer` resolves the map the replay was recorded on, reads it and draws the run: brush geometry with its baked lighting, terrain, props, the sky, and the map's moving parts following what the replay recorded. It carries its own readers for BSP 19 to 25, VTF 7.0 to 7.6 including Strata Source's Zstandard compressed images and BC7, VMT, VPK, studio models and Valve's LZMA, and reads materials the way the engine does: the map's pakfile first, then archives over range requests, then loose files.
  
  `@caixax/momtv-player` puts a player around it: a loading screen that follows the download, playback controls with a speed slider from a twentieth of normal to four times it, and the run readout, with the timer and the stage on top, the speed under the crosshair and the keys along the bottom.
  
  `@caixax/momtv-cli` prints what a replay holds, as a summary, as JSON or as CSV.

### Patch Changes

- Updated dependencies
  - @caixax/momtv@0.1.0
  - @caixax/momtv-viewer@0.1.0
