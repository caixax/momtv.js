import { describe, expect, it } from 'vitest';
import { parseReplay, trackStateAt } from '../src/index.js';
import { loadFixture } from './fixtures.js';

// bhop_badwater.momtv: recorded by caixax on a current playtest build and
// committed with permission; exercises body revision 2.
const replay = parseReplay(loadFixture('bhop_badwater.momtv'));

describe('body revision 2', () => {
  it('detects the revision and parses the header', () => {
    expect(replay.body.revision).toBe(2);
    expect(replay.header.mapName).toBe('bhop_badwater');
    expect(replay.header.propBits).toBe(6);
    expect(replay.classes[0]!.name).toBe('CMomentumPlayer');
    expect(replay.classes[0]!.props.length).toBe(49);
  });

  it('parses the compact timeline', () => {
    const events = replay.events;
    expect(events.length).toBeGreaterThan(2);
    expect(events[0]!.zoneFlag).toBe(3); // run start (leaving the start zone)
    expect(events.at(-1)!.tick).toBe(replay.frameCount - 1);
    // ticks ascend
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.tick).toBeGreaterThanOrEqual(events[i - 1]!.tick);
    }
  });

  it('keyframe index has an implicit tick 0 entry', () => {
    const kf = replay.body.keyframeIndex;
    expect(kf).toHaveLength(replay.header.keyFrameCount);
    expect(kf[0]).toMatchObject({ tick: 0, keyframeOffset: 0, frameOffset: -1 });
    for (let i = 2; i < kf.length; i++) {
      expect(kf[i]!.keyframeOffset).toBeGreaterThan(kf[i - 1]!.keyframeOffset);
    }
  });

  it('decodes every frame with plausible player state', () => {
    const track = replay.toTrack();
    expect(track.stats.frames).toBe(replay.frameCount);
    expect(track.stats.lostFrames).toBe(0);
    let top = 0;
    for (let t = 0; t < track.frameCount; t++) {
      const s = trackStateAt(track, t);
      expect(Number.isFinite(s.origin[0])).toBe(true);
      expect(Math.abs(s.origin[0])).toBeLessThan(20000);
      expect(Math.abs(s.origin[2])).toBeLessThan(20000);
      top = Math.max(top, Math.hypot(s.velocity[0], s.velocity[1]));
    }
    expect(top).toBeGreaterThan(300);
    expect(top).toBeLessThan(4000);
  });

  it('velocity oracle holds away from push physics', () => {
    const track = replay.toTrack();
    let checks = 0;
    let fails = 0;
    for (let t = 1; t < track.frameCount; t++) {
      const a = trackStateAt(track, t - 1);
      const b = trackStateAt(track, t);
      if (Math.hypot(a.velocity[0], a.velocity[1]) < 1) continue;
      const err = Math.hypot(
        b.origin[0] - a.origin[0] - a.velocity[0] * track.tickInterval,
        b.origin[1] - a.origin[1] - a.velocity[1] * track.tickInterval,
      );
      if (err > 500) continue; // teleports
      checks++;
      if (err > 1) fails++;
    }
    expect(checks).toBeGreaterThan(1000);
    // badwater has boost triggers; pushes legitimately defeat the oracle
    expect(fails / checks).toBeLessThan(0.15);
  });
});
