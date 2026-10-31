import { describe, expect, it } from 'vitest';
import { BitReader } from '../src/bit-reader.js';
import { FrameReader, parseReplay, readHeader, REPLAY_HEADER_SIZE } from '../src/index.js';
import { RecordMode, recordModeOf } from '../src/recording-spec.js';
import { loadFixture } from './fixtures.js';

// bhop_badwater.momtv: body revision 2, recorded on a current playtest build.
const bytes = loadFixture('bhop_badwater.momtv');
const replay = parseReplay(bytes);

describe('exact decoding of a revision 2 body', () => {
  it('reads every frame and lands on every keyframe anchor', () => {
    const { stats } = replay.toTrack();
    expect(stats.lostFrames).toBe(0);
    // A resync is the walk being somewhere other than where the keyframe
    // index says the next frame starts; an exact walk never needs one.
    expect(stats.resyncs).toBe(0);
    expect(stats.frames).toBe(replay.frameCount);
  });

  it('reads every baseline to exactly the bits its record declares', () => {
    const reader = new FrameReader(replay.body, replay.header.propBits);
    expect(replay.body.baselines.length).toBeGreaterThan(0);
    for (const baseline of replay.body.baselines) {
      expect(reader.readBaseline(baseline).bits).toBe(baseline.payloadBits);
    }
  });

  it('reads every keyframe whole', () => {
    const reader = new FrameReader(replay.body, replay.header.propBits);
    for (const entry of replay.body.keyframeIndex) {
      expect(() => reader.readKeyframe(entry.keyframeOffset)).not.toThrow();
    }
  });

  it('starts the player from its baseline rather than from nothing', () => {
    // the camera sits at eye height from the first tick on
    expect(replay.getPlayerState(0).viewOffset[2]).toBeGreaterThan(0);
  });

  it('times the run the way the header does', () => {
    const start = replay.events.find((event) => event.kind === 'start');
    const finish = replay.events.find((event) => event.kind === 'finish');
    expect(start).toBeDefined();
    expect(finish?.tick).toBe(replay.frameCount - 1);
    expect(finish!.time).toBeCloseTo(replay.header.runTime, 6);
    expect(replay.toTrack().startTick).toBe(start!.tick);
  });
});

describe('recording modes', () => {
  it('names the properties the recorder writes differently', () => {
    expect(recordModeOf('CMomentumPlayer', 'm_iLandTick')).toBe(RecordMode.TickRelative);
    expect(recordModeOf('CMomentumPlayer', 'm_nModelIndex')).toBe(RecordMode.ModelIndex);
    expect(recordModeOf('CMomentumTimerInstance', 'm_dNetworkRunTime')).toBe(RecordMode.Deferred);
    expect(recordModeOf('CMomentumViewModel', 'm_nSequence')).toBe(RecordMode.Deferred);
    expect(recordModeOf('CMomPickup', 'm_nSequence')).toBe(RecordMode.Plain);
    expect(recordModeOf('CMomentumPlayer', 'm_vecOrigin')).toBe(RecordMode.Plain);
  });
});

describe('older and newer containers', () => {
  it('reads a format version 1 header, which has no style byte', () => {
    // a version 1 file is a version 2 file without its last header byte
    const v1 = new Uint8Array(bytes.length - 1);
    v1.set(bytes.subarray(0, REPLAY_HEADER_SIZE - 1), 0);
    v1.set(bytes.subarray(REPLAY_HEADER_SIZE), REPLAY_HEADER_SIZE - 1);
    new DataView(v1.buffer).setInt32(4, 1, true);
    const header = readHeader(v1);
    expect(header.formatVersion).toBe(1);
    expect(header.style).toBe(0);
    expect(header.mapName).toBe('bhop_badwater');
    expect(parseReplay(v1).toTrack().stats.lostFrames).toBe(0);
  });
});

describe('BitReader', () => {
  it('reads a varint through the bit stream', () => {
    // 300 = 0b1_0010_1100: 0xac then 0x02, starting three bits in
    const raw = new Uint8Array([0xac << 3, (0xac >> 5) | (0x02 << 3), 0]);
    const r = new BitReader(raw);
    r.readBits(3);
    expect(r.readVarInt32()).toBe(300);
  });
});
