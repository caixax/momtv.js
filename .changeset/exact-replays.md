---
'@caixax/momtv': minor
'@caixax/momtv-viewer': minor
'@caixax/momtv-player': minor
'@caixax/momtv-cli': patch
---

Replays play from start to finish. The frames are now read the way the game reads them, with the recording modes and array rules taken from the engine itself, and every one of 373 replays decodes exactly: no lost frames, every keyframe anchor met, every baseline read to the bit. Before, about one frame in eight was lost and one replay in ten would not open, which is what made runs freeze and skip.

`@caixax/momtv` also opens format version 1 replays and Zstandard compressed bodies, reads the temp entity class table and revision 2 sound names, starts the player and every map entity from its baseline and the first keyframe rather than from nothing, times the stages and the finish the way the header does, and pairs each recorded map entity with its exact brush model through the model CRC the recorder writes (`EntityTrack.model`, `modelNameCrc`). Entity tracks carry visibility and fade, entity positions use Strata Source's 65536 unit world, and the Zstandard decoder now lives here.

`@caixax/momtv-viewer` reads the baked lighting of HDR compiled maps from their HDR faces, which most of Momentum's maps are, instead of painting each face with another face's light; draws the sky, which a clear between the sky and the map had always hidden; finds HDR sky images by the engine's name and falls back to its default sky; normalises material names with leading or doubled slashes; draws unlit materials at full brightness; filters textures anisotropically; and hides and fades the map entities a replay hides and fades.

`@caixax/momtv-player` labels the stages and the finish by what they are rather than by a raw event number, which on current replays called the run start the finish.
