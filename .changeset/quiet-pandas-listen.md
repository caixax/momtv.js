---
'@caixax/momtv-cli': patch
'@caixax/momtv-player': patch
---

Show a dash instead of NaN for the run timer of timeline events. The compact timeline newer replays write does not carry a timer value per event, so the dump prints a dash and the player labels its seek marks with where the event sits in the playback.
