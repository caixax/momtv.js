import { describe, expect, it } from 'vitest';
import { parseReplay } from '../src/index.js';
import { bhopEazy } from './fixtures.js';

const replay = parseReplay(bhopEazy());

describe('parseReplay: body sections', () => {
  it('parses the event timeline', () => {
    const events = replay.events;
    expect(events).toHaveLength(10);
    expect(events[0]).toMatchObject({ tick: 0, type: 1 });
    const last = events.at(-1)!;
    expect(last.type).toBe(3);
    expect(last.tick).toBe(3385);
    expect(last.time).toBeCloseTo(replay.header.runTime, 9);
  });

  it('parses the class table', () => {
    const names = replay.classes.map((c) => c.name);
    expect(names).toEqual([
      'CMomentumPlayer',
      'CMomentumViewModel',
      'CMomentumPistol',
      'CKnife',
      'CMomentumZoneRegion',
      'CFuncBrush',
    ]);
    expect(replay.classes[0]!.props).toHaveLength(26);
    expect(replay.classes[0]!.props[2]).toBe('m_vecOrigin');
  });

  it('parses sounds and game events', () => {
    expect(replay.body.sounds).toHaveLength(3);
    expect(replay.body.sounds[0]!.path).toMatch(/footsteps/);
    const eventNames = replay.body.gameEvents.map((e) => e.name);
    expect(eventNames).toContain('player_jumped');
    expect(eventNames).toContain('player_landed');
    const ramp = replay.body.gameEvents.find((e) => e.name === 'ramp_board')!;
    expect(ramp.keys.map((k) => k.name)).toEqual(['x', 'y', 'z']);
  });

  it('indexes the baselines', () => {
    expect(replay.body.baselines).toHaveLength(replay.header.baselineCount);
    expect(replay.body.baselines[0]).toMatchObject({ entity: 0, classId: 0 });
    const classIds = new Set(replay.body.baselines.map((b) => b.classId));
    expect([...classIds].sort((a, b) => a - b)).toEqual([0, 1, 2, 10, 31, 35]);
  });

  it('parses the keyframe index on timeline ticks', () => {
    const kfTicks = replay.body.keyframeIndex.map((k) => k.tick);
    expect(kfTicks).toHaveLength(replay.header.keyFrameCount);
    const eventTicks = new Set(replay.events.map((e) => e.tick));
    for (const t of kfTicks) expect(eventTicks.has(t)).toBe(true);
  });

  it('frame data runs to the end of the body', () => {
    const { offset, length } = replay.body.frameData;
    expect(offset + length).toBe(replay.body.bytes.length);
  });
});

describe('player track', () => {
  const track = replay.toTrack();

  it('decodes one state per frame', () => {
    expect(track.frameCount).toBe(replay.header.frameCount);
    expect(track.data).toHaveLength(track.frameCount * 9);
    expect(track.stats.frames).toBeGreaterThanOrEqual(track.frameCount - 6);
    expect(track.stats.lostFrames).toBeLessThanOrEqual(6);
  });

  it('satisfies the velocity oracle on the vast majority of ticks', () => {
    let checks = 0;
    let fails = 0;
    let teleports = 0;
    for (let t = 1; t < track.frameCount; t++) {
      const a = replay.getPlayerState(t - 1);
      const b = replay.getPlayerState(t);
      const speed = Math.hypot(a.velocity[0], a.velocity[1]);
      if (speed < 1) continue;
      const err = Math.hypot(
        b.origin[0] - a.origin[0] - a.velocity[0] * track.tickInterval,
        b.origin[1] - a.origin[1] - a.velocity[1] * track.tickInterval,
      );
      if (err > 500) {
        // map teleport (bhop_eazy moves the player between segments)
        teleports++;
        continue;
      }
      checks++;
      if (err > 1) fails++;
    }
    expect(checks).toBeGreaterThan(3000);
    expect(teleports).toBeLessThanOrEqual(4);
    // a few ticks per run are recorded without a player snapshot; those and
    // the zone keyframe joins legitimately break the oracle locally
    expect(fails / checks).toBeLessThan(0.02);
  });

  it('keeps positions inside the map bounds and angles in range', () => {
    for (let t = 0; t < track.frameCount; t += 7) {
      const s = replay.getPlayerState(t);
      expect(Math.abs(s.origin[0])).toBeLessThan(16384);
      expect(Math.abs(s.origin[1])).toBeLessThan(16384);
      expect(Math.abs(s.origin[2])).toBeLessThan(16384);
      expect(s.eyeAngles[0]).toBeGreaterThanOrEqual(-180);
      expect(s.eyeAngles[0]).toBeLessThanOrEqual(180);
    }
  });

  it('starts on the ground in the start zone with the known state', () => {
    const s = replay.getPlayerState(0);
    expect(s.origin[0]).toBeCloseTo(-266.221, 2);
    expect(s.origin[1]).toBeCloseTo(-348.2178, 2);
    expect(s.origin[2]).toBeCloseTo(64.03125, 4);
    expect(s.onGround).toBe(true);
    expect(s.viewOffset[2]).toBe(64);
  });

  it('reports the run start tick from the timeline', () => {
    expect(track.startTick).toBe(23);
  });

  it('interpolates between ticks', () => {
    const a = replay.getPlayerState(100);
    const b = replay.getPlayerState(101);
    const mid = replay.getPlayerStateAtTime(100.5 * replay.tickInterval);
    expect(mid.origin[0]).toBeCloseTo((a.origin[0] + b.origin[0]) / 2, 3);
    expect(mid.origin[1]).toBeCloseTo((a.origin[1] + b.origin[1]) / 2, 3);
  });

  it('run time matches the covered tick span', () => {
    const span = (track.frameCount - 1 - track.startTick) * track.tickInterval;
    expect(span).toBeGreaterThanOrEqual(replay.header.runTime - 0.25);
    expect(span).toBeLessThanOrEqual(replay.header.runTime + 0.5);
  });
});
