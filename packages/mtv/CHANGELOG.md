# @caixax/mtv

## 0.1.0

### Minor Changes

- First release.
  
  `@caixax/mtv` reads a Momentum Mod replay end to end: the header, the run splits, the event timeline and every delta frame, giving the player's position, angles, velocity, buttons and flags on every tick, and the same for the entities a map moves. Zero dependencies, the same in a browser, a worker and Node.
  
  `@caixax/mtv-viewer` resolves the map the replay was recorded on, reads it and draws the run: brush geometry with its baked lighting, terrain, props, the sky, and the map's moving parts following what the replay recorded. It carries its own readers for BSP 19 to 25, VTF 7.0 to 7.6 including Strata Source's Zstandard compressed images and BC7, VMT, VPK, studio models and Valve's LZMA, and reads materials the way the engine does: the map's pakfile first, then archives over range requests, then loose files.
  
  `@caixax/mtv-player` puts a player around it: a loading screen that follows the download, playback controls with a speed slider from a twentieth of normal to four times it, and the run readout, with the timer and the stage on top, the speed under the crosshair and the keys along the bottom.
  
  `@caixax/mtv-cli` prints what a replay holds, as a summary, as JSON or as CSV.
