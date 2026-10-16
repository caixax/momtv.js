# MomentumTV replay format (.mtv)

Reverse engineered specification of the Momentum Mod replay format, version 2, as written by Momentum Mod 0.10.x (Strata Source).

Every field is annotated with a confidence level:

- **[verified]**: confirmed against the official reader, or validated by an independent oracle (for example, decoded velocity matching per-tick position deltas across thousands of frames).
- **[strong]**: consistent with all observed data, no oracle contradicts it.
- **[hypothesis]**: plausible interpretation, needs more samples or game knowledge to confirm.
- **[unknown]**: structure or meaning not yet understood.

Primary sources: the official header/splits reader in momentum-mod/website (`libs/formats/replay`, MIT), the official sample replay (bhop_eazy), and byte and bit level analysis of that sample. Everything below the splits block was reverse engineered from data; nothing here is derived from game code.

## File layout

| Section         | Size                            |
| --------------- | ------------------------------- |
| Fixed header    | 195 bytes                       |
| Run splits      | 4 bytes length + JSON           |
| Compressed body | Valve LZMA frame to end of file |

All integers little endian. The C++ struct is packed (`#pragma pack(1)`).

## Fixed header (195 bytes) [verified]

| Offset | Type     | Field             | Notes                                     |
| ------ | -------- | ----------------- | ----------------------------------------- |
| 0      | int32    | magic             | `'MMTV'` = 0x56544D4D                     |
| 4      | int32    | formatVersion     | 2                                         |
| 8      | int64    | timestamp         | Unix ms when the file was written         |
| 16     | char[64] | mapName           | NUL terminated                            |
| 80     | char[41] | mapHash           | SHA1 hex of the BSP                       |
| 121    | uint8    | gamemode          | see Gamemode enum                         |
| 122    | uint8    | compression       | 0 = none, 1 = Valve LZMA                  |
| 123    | float    | tickInterval      | seconds per tick                          |
| 127    | uint64   | playerSteamID     | SteamID64                                 |
| 135    | char[32] | playerName        | NUL terminated                            |
| 167    | uint8    | trackType         | 0 main, 1 stage, 2 bonus                  |
| 168    | uint8    | trackNum          | 1-based                                   |
| 169    | double   | runTime           | final time in seconds                     |
| 177    | int32    | frameCount        | delta frames in the body                  |
| 181    | int32    | keyFrameCount     | keyframes in the body                     |
| 185    | int32    | baselineCount     | entity baselines in the body              |
| 189    | uint8    | classCount        | entries in the class table                |
| 190    | uint8    | tempEntClassCount | entries in the temp entity class table    |
| 191    | uint8    | sampleCount       | entries in the sound table                |
| 192    | uint8    | propBits          | bits per property index (5 in the sample) |
| 193    | uint8    | tempEntClassBits  | bits per temp entity class index          |
| 194    | uint8    | style             | see Style enum                            |

The official reader stops at `style` and leaves the counter fields commented out; their meaning here was confirmed by using them to parse the body (every counter matches the decoded structure exactly). [verified]

## Run splits [verified]

At offset 195: `int32 length`, then `length` bytes holding UTF-8 JSON whose final byte is a NUL terminator. The JSON is `{trackStats, segments[]}` as modeled by momentum-mod/website (`RunSplits`).

## Compressed body [verified]

Immediately after the splits: Valve `lzma_header_t` framing:

| Offset | Type            | Field                                       |
| ------ | --------------- | ------------------------------------------- |
| 0      | uint32          | id, `'LZMA'` = 0x414D5A4C                   |
| 4      | uint32          | actualSize (decompressed)                   |
| 8      | uint32          | lzmaSize (compressed payload size)          |
| 12     | uint8[5]        | LZMA properties (lc/lp/pb byte + dict size) |
| 17     | uint8[lzmaSize] | raw LZMA stream                             |

The sample decompresses to exactly `actualSize` = 156756 bytes. [verified]

## Decompressed body

Sections in order:

1. Event timeline
2. Networked class table
3. Sound table
4. Game event definitions (protobuf)
5. Baselines (byte size prefixed)
6. Keyframe index
7. Keyframe data (byte size prefixed)
8. Frame data (byte size prefixed)

### Bit stream conventions [verified]

Bit-packed data uses Source engine `bf_read`/`bf_write` semantics: little endian, LSB-first within each byte. `UBitVar` is the CS:GO/Strata variant: 6 bits are read, the top 2 of those 6 select an extension:

- `(six & 48) == 0`: value = six (0..15)
- `== 16`: value = (six & 15) | readBits(4) << 4
- `== 32`: value = (six & 15) | readBits(8) << 4
- `== 48`: value = (six & 15) | readBits(28) << 4

### 1. Event timeline [strong]

`uint32 count`, then `count` records of 18 bytes:

| Offset | Type   | Field    | Notes                                                                                             |
| ------ | ------ | -------- | ------------------------------------------------------------------------------------------------- |
| 0      | int32  | tick     | replay tick of the event                                                                          |
| 4      | uint16 | zoneFlag | observed 0..3; 2 appears to be zone enter, 3 zone exit [hypothesis]                               |
| 6      | uint8  | trackNum | matches header trackNum                                                                           |
| 7      | uint8  | type     | 1 once at tick 0, 2 for mid-run events, 3 once at the final tick [hypothesis: start/split/finish] |
| 8      | double | time     | run timer at the event; equals (tick - startTick + 0.5) * tickInterval                            |
| 16     | uint8  | majorNum | segment number                                                                                    |
| 17     | uint8  | minorNum | checkpoint number                                                                                 |

In the sample the final record's `time` equals the header `runTime` exactly, and the event ticks match the keyframe index ticks one to one. [verified]

### 2. Class table [verified]

`classCount` records, each:

- `uint8 classId`: network class id (not contiguous: 0, 1, 2, 10, 31, 35 in the sample)
- `char[] className` NUL terminated
- `uint8 propCount`
- `propCount` NUL terminated property names

Property order in this table defines the property index used in all bit-packed entity data. Property value encodings are not stored; they are implied by the game's network tables (see "Property encodings").

### 3. Sound table [strong]

`sampleCount` records, each `uint16 soundIndex` + NUL terminated path.

### 4. Game event definitions [verified]

`uint32 size`, then `size` bytes of protobuf resembling `CSVCMsg_GameEventList`: repeated descriptors `{ varint eventId; string name; repeated { varint type; string key } }`. The sample defines player_jumped, player_landed, ramp_board, ramp_leave, slide_started, slide_ended, player_explosive_hit.

### 5. Baselines [verified]

`uint32 sectionSize`, then `baselineCount` records. Each record is self describing and they chain exactly, with no searching:

| Field       | Type             | Notes                                       |
| ----------- | ---------------- | ------------------------------------------- |
| tick        | int32            | 275 for every record in the sample          |
| entity      | varint           | recording ordinal, contiguous from 0        |
| classId     | UBitVar          | matches the class table                     |
| payloadBits | uint16           | exact length of the payload in bits         |
| payload     | payloadBits bits | properties, then padding to a byte boundary |

The layout was recovered from the engine's record reader (a 32 bit field, a varint, a UBitVar and a 16 bit length whose `(bits + 7) / 8` becomes the byte size) and confirmed on the sample: all 198 records chain byte for byte, with contiguous entity ordinals and class ids that all appear in the class table.

The payload is a 10 bit record header followed by every property of the class in ascending index order, each as `{propBits index}{value}`. For the player this consumes the declared 931 bits exactly, with no padding left over, decoding all 26 properties. `m_hViewModel` (an array property) occupies 55 bits there.

### 6. Keyframe index [verified]

`keyFrameCount` records of 12 bytes: `{ uint32 tick, uint32 keyframeDataOffset, uint32 frameDataOffset }`.

- `tick`: keyframes are written at every timeline event tick.
- `keyframeDataOffset`: byte offset of this keyframe inside section 7.
- `frameDataOffset`: byte offset inside section 8 of the frame for `tick + 1` (resume point when seeking to this keyframe).

### 7. Keyframe data [strong]

`uint32 size`, then the keyframes back to back. A keyframe is a delta against the baselines: a leading 6-bit count-like value [hypothesis], then entity blocks. Non-player blocks are not fully mapped. The player block is:

- 6 bits entity field (0 for the player)
- 2 bits flags (observed 0)
- properties until the block ends, each `{5-bit index, value}`; only properties that differ from the baseline are present.

### 8. Frame data [verified for the player block]

`uint32 size`, then exactly one frame per tick (`frameCount` frames), byte aligned and stored back to back with no gaps. [verified: walking player blocks start to start covers the whole section and matches every keyframe anchor]

Frame:

- 6 bits: number of entity blocks in the frame. Constant for a replay (4 in the sample: player, viewmodel and the two weapons) except on ticks where extra entities update, where it grows accordingly (5 and 6 observed). [verified]
- entity blocks. The first block is always the player:
  - `UBitVar entity` (0)
  - 2 bits flags (0 in every player frame block)
  - `UBitVar propCount`
  - `propCount` properties, each `{5-bit property index, value}`. Indices are absolute (class table order) but not emitted in sorted order (changes-often properties first). [verified]
- the remaining blocks (viewmodel, weapons, occasionally zones) follow the player block; their property encodings are partially mapped, so this parser walks frame to frame by locating the next player block instead of decoding them. Some frames embed an event or sound message (a protobuf blob with a leading `0x11` byte and a length) in this trailing region. [hypothesis]

The decoded trajectory contains three teleport-scale discontinuities in the sample; these are real (bhop_eazy teleports the player between segments) and line up with the zone events. A handful of isolated ticks (about 1%) decode with a one tick position jump, still under investigation.

## Property encodings (CMomentumPlayer) [verified by oracle]

Validated by decoding all 3386 frames: the recorded `m_vecVelocity` matches `(origin[t+1] - origin[t]) / tickInterval` within noise for 92% of ticks (remaining mismatches cluster at empty frames and one teleport-like event).

| Index | Property               | Encoding                                                                            |
| ----- | ---------------------- | ----------------------------------------------------------------------------------- |
| 0     | m_bSimulatedEveryTick  | 1 bit                                                                               |
| 1     | m_fEffects             | 15-bit uint (confirmed by network table dump)                                       |
| 2     | m_vecOrigin            | 2x float32 (x, y) raw                                                               |
| 3     | m_vecOrigin[2]         | float32 raw                                                                         |
| 4     | m_vecMinsPreScaled     | 3x float32                                                                          |
| 5     | m_vecMaxsPreScaled     | 3x float32                                                                          |
| 6     | m_nModelIndex          | 13-bit uint                                                                         |
| 7     | m_nBody                | 32-bit int                                                                          |
| 8     | m_clrModelPrimary      | 32-bit uint (RGBA)                                                                  |
| 9     | m_clrModelSecondary    | 32-bit uint (RGBA)                                                                  |
| 10    | m_angRotation          | 3x 13-bit fixed point angle, degrees = v * 360 / 8192                               |
| 11    | m_angEyeAngles[0]      | 11-bit scaled float (range encoding) [strong]                                       |
| 12    | m_angEyeAngles[1]      | 11-bit scaled float, degrees = v * 360 / 2048 [strong]                              |
| 13    | m_bClientSideAnimation | 1 bit                                                                               |
| 14    | m_vecViewOffset[0]     | 8-bit scaled float, -32 + v * 64 / 256                                              |
| 15    | m_vecViewOffset[1]     | 8-bit scaled float, -32 + v * 64 / 256                                              |
| 16    | m_vecViewOffset[2]     | 10-bit scaled float, v * 128 / 1024 (64.0 standing)                                 |
| 17    | m_hViewModel           | frames: 23-bit entity handle (13-bit index + serial); baselines: array, layout open |
| 18    | m_vecVelocity[0]       | float32 raw                                                                         |
| 19    | m_vecVelocity[1]       | float32 raw                                                                         |
| 20    | m_vecVelocity[2]       | float32 raw                                                                         |
| 21    | m_nPhysicalButtons     | 32-bit uint (IN_* bits)                                                             |
| 22    | m_afButtonDisabled     | 32-bit uint                                                                         |
| 23    | m_afButtonForced       | 32-bit uint                                                                         |
| 24    | m_nButtonsToggled      | 32-bit uint                                                                         |
| 25    | m_fFlags               | 11-bit uint (FL_ONGROUND = 1, FL_CLIENT = 256)                                      |

Eye pitch interpretation (raw 11-bit to degrees, likely range [-90, 90]) still needs confirmation against known camera angles. [hypothesis]

## Cross-check against the game's network tables [verified]

The widths above were cross-checked against the server class tables dumped by the game itself (`sv_dump_class_table` in the 0.10 playtest build). Every empirically derived width matches the game's SendProp metadata: m_fEffects 15 bits, m_nModelIndex 13, m_angRotation QAngle 13, m_angEyeAngles 11-bit range floats, m_vecViewOffset 8/8/10-bit range floats, m_fFlags 11 bits, velocities and origin NOSCALE float32, entity handles 23 bits (13-bit edict index), m_cellX/Y/Z 12 bits, m_cellbits 5, m_flSimulationTime and m_flAnimTime 8-bit ints encoded against the tick count, m_hViewModel an array prop.

Note that the current build renames some classes (the sample replay's `CKnife` is `CMomentumKnife` today). Parsers must match classes and properties by the names stored in the replay, exactly like the game does (its own loader warns "Replay uses unknown prop" on mismatches).

CFuncBrush baselines fully decode with these widths: a 22-bit record header after the class id, then all 11 properties with ascending 5-bit indices and cell-coordinate origin (3x 10 bits) landing exactly on the payload end for all 188 instances. [verified]

## Empty frames [strong]

About 3.7% of ticks carry a 4-byte frame: header 1, entity 0, flags `(0,1)` and no properties. Around each one the decoded position jumps by exactly one tick of velocity, so these are ticks recorded without a player snapshot (probably the recorder's update rate). Players should extrapolate or interpolate across them.

## Body revision 2 (current playtest builds) [verified]

Replays written by current 0.10.x playtest builds keep formatVersion 2 in the header but revise the body layout. A parser distinguishes the revisions structurally (revision 1 parses to the exact body end or it is revision 2). Differences:

- Timeline: `uint16 count`, then compact records `{int32 tick}{uint8 flag}` with two extra bytes `{uint8 track}{uint8 major}` when flag is 2 (checkpoint enter). Flags observed: 3 run start, 0 unknown, 2 checkpoint, 1 final tick. No run-timer double anymore.
- The player class now has 49 properties (propBits 7 would overflow 6 bits; the header says 6 and frames use 6-bit property indices). New properties include wishVel, moveStatus, acceleration, maxspeed, friction, several EndTick fields, m_flGroundPositionZ, m_iLandTick/m_iJumpTick, m_hActiveWeapon and m_hPrimaryTimer; widths confirmed against the game's own class table dump.
- The baseline section size is 0: initial entity state lives in the tick 0 keyframe instead.
- Keyframe index: the tick 0 entry is implicit (8 zero bytes, no frame offset), followed by keyFrameCount - 1 full 12 byte entries with the same {tick, keyframeOffset, frameOffset} layout as revision 1.
- Frames keep the same container ({6-bit block count}{entity blocks}, player first) but each block now writes all property indices first and then the values in that order (classic Source field list), instead of interleaving index and value.
- Frame data may start with a prologue before the first frame in some gamemodes (observed in defrag and deathrun replays); the frame walker skips it.

Oracle note: on maps with push physics (boosters, bumpers, conveyors) the recorded m_vecVelocity legitimately disagrees with per-tick position deltas while the push is acting, since base velocity is not part of the recorded property set. Plain bhop runs validate at over 99%.

## Frame location and its limits [verified by measurement]

Only the leading player block of a frame is decoded; the trailing entity blocks (viewmodel, weapons, zones, map entities) are not mapped, so a frame's true end is unknown and the next frame has to be located rather than computed.

What makes locating one reliable: a frame that carries neither the position nor a velocity component is almost always a run of bits inside another entity's block. Requiring one of those properties raises the share of ticks that receive real movement data from 88 to 98 percent across the sample replays, and cuts the ticks where the player freezes while moving by four to twenty times.

Current quality, measured as the share of moving ticks whose position does not advance (what a viewer shows as a stutter):

| Replay                 | Frozen ticks |
| ---------------------- | ------------ |
| ab_baume               | 0.2%         |
| df_cruton              | 0.1%         |
| bhop_badwater          | 1.0%         |
| bhop_eazy (revision 1) | 0.7%         |
| agtricks               | 2.6%         |

The remaining stutter is concentrated, not spread out: on agtricks all but five of the frozen ticks fall in four runs, and each run begins on a timeline zone event. The frame that follows such an event updates many entities at once and does not start with the player block (an entity count of 14 instead of the usual 4), so the walker loses the thread until the next keyframe anchor. Candidate scoring by motion continuity was measured and does not help; what closes this is decoding the non-player blocks, which needs the entity to class mapping and the per class property encodings.

## Body revision 2 (current playtest builds) [verified]

Replays written by current 0.10.x playtest builds keep formatVersion 2 in the header but revise the body layout. A parser distinguishes the revisions structurally (revision 1 parses to the exact body end or it is revision 2). Differences:

- Timeline: `uint16 count`, then compact records `{int32 tick}{uint8 flag}` with two extra bytes `{uint8 track}{uint8 major}` when flag is 2 (checkpoint enter). Flags observed: 3 run start, 0 unknown, 2 checkpoint, 1 final tick. No run-timer double anymore.
- The player class now has 49 properties (propBits 7 would overflow 6 bits; the header says 6 and frames use 6-bit property indices). New properties include wishVel, moveStatus, acceleration, maxspeed, friction, several EndTick fields, m_flGroundPositionZ, m_iLandTick/m_iJumpTick, m_hActiveWeapon and m_hPrimaryTimer; widths confirmed against the game's own class table dump.
- The baseline section size is 0: initial entity state lives in the tick 0 keyframe instead.
- Keyframe index: the tick 0 entry is implicit (8 zero bytes, no frame offset), followed by keyFrameCount - 1 full 12 byte entries with the same {tick, keyframeOffset, frameOffset} layout as revision 1.
- Frames keep the same container ({6-bit block count}{entity blocks}, player first) but each block now writes all property indices first and then the values in that order (classic Source field list), instead of interleaving index and value.
- Frame data may start with a prologue before the first frame in some gamemodes (observed in defrag and deathrun replays); the frame walker skips it.

Oracle note: on maps with push physics (boosters, bumpers, conveyors) the recorded m_vecVelocity legitimately disagrees with per-tick position deltas while the push is acting, since base velocity is not part of the recorded property set. Plain bhop runs validate at over 99%.

## Frame location and its limits [verified by measurement]

Only the leading player block of a frame is decoded; the trailing entity blocks (viewmodel, weapons, zones, map entities) are not mapped, so a frame's true end is unknown and the next frame has to be located rather than computed. Two measurements bound how well that can work:

- Candidate density: in the first 4000 bytes of bhop_badwater there are 203 byte offsets that parse as a valid player block, for about 100 real frames. Roughly half of the candidates are frame-shaped runs of bits inside the trailing blocks.
- The position is the discriminator: of those 203 candidates only 80 carry `m_vecOrigin`, which matches the real frame count closely. Walking a span taking only position-bearing candidates reproduces the known spans almost exactly (a 15 tick span between two keyframe anchors places exactly 15 frames and ends on the anchor byte; a 1041 tick span places 1026).

Two facts make the frame count checkable: the keyframe index pins known ticks to known byte offsets, so between two anchors both the tick count and the byte range are exact.

What remains before playback can be bit exact: the entity to class mapping (in revision 1 it comes from the baselines, in revision 2 it is folded into the tick 0 keyframe, which is not parsed yet) and the per class property encodings for the non-player classes. With those, every block of a frame can be decoded and frames become exactly contiguous, removing the need to locate them. Replays where the player is not the first recorded entity (observed on entity-heavy maps such as a defrag pinball map) cannot be decoded at all until then.

## Open questions

- Baseline `tick` field semantics (275 vs -2468 in the sample).
- Record header after the class id in baselines: the player's is 26 bits (2 flag bits `(1,1)` then two UBitVar-shaped fields, values 56 and 27, consistent with simulation and animation time deltas), CFuncBrush uses a 22-bit header starting `(0,0)`. The general rule is not yet pinned down.
- The baseline layout of array props (m_hViewModel: 55 bits observed; m_renderPoints and m_trackIds on zone regions).
- Exact per-prop widths for CMomentumViewModel, CMomentumPistol and CKnife in the sample's (older) build: today's table dump does not fully match, so a replay recorded by the current build is needed to validate.
- The leading 6-bit frame field (4 in normal frames, 1 in empty ones) and the end-of-frame terminator (observed `UBitVar 0` + 2 bits + padding).
- One isolated misread in the sample (tick 1140: a velocity component decodes as -0.0 while the position clearly keeps moving), pointing at a rare prop this parser does not size correctly yet.
- Revision 2: the structure of the keyframe payloads (per-entity mini records), the frame data prologue, and deathrun replays decode poorly (moving platforms and doors interact badly with the current frame walker).

## Map assets

A BSP packs some of its materials in the pakfile lump (a zip, compressed with LZMA, method 14). The rest live in the game's VPK archives, which the viewer never bundles: a host application extracts them from a local installation and serves them, and the viewer looks them up under its `assetsBaseUrl`.

VPK directory files (version 1 and 2) are a tree of NUL terminated strings grouped by extension, then directory, then file name, each entry carrying a CRC, a preload size, an archive index, an offset and a length. Entries with archive index 0x7fff keep their data in the directory file itself, after the tree; the rest live in the numbered archives beside it.
