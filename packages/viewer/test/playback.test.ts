import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseReplay } from '@caixax/mtv';
import {
  directorySource,
  firstPersonCamera,
  PlaybackClock,
  resolveMap,
  sha1Hex,
  thirdPersonCamera,
} from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const replay = parseReplay(new Uint8Array(readFileSync(join(root, 'fixtures', 'bhop_eazy.mtv'))));

describe('PlaybackClock', () => {
  it('advances with speed and pauses at the end', () => {
    const clock = new PlaybackClock(replay);
    expect(clock.duration).toBeCloseTo((replay.frameCount - 1) * replay.tickInterval, 6);
    clock.setSpeed(2);
    clock.play();
    clock.advance(1);
    expect(clock.time).toBeCloseTo(2, 6);
    const ends = vi.fn();
    clock.on('end', ends);
    clock.advance(1000);
    expect(clock.playing).toBe(false);
    expect(clock.time).toBeCloseTo(clock.duration, 6);
    expect(ends).toHaveBeenCalledOnce();
  });

  it('seeks, steps and emits tick states', () => {
    const clock = new PlaybackClock(replay);
    const ticks: number[] = [];
    clock.on('tick', (s) => ticks.push(s.tick));
    clock.seekTick(1500);
    expect(clock.tick).toBeCloseTo(1500, 4);
    clock.step(1);
    expect(clock.tick).toBeCloseTo(1501, 4);
    clock.step(-1);
    clock.step(-1);
    expect(clock.tick).toBeCloseTo(1499, 4);
    expect(ticks.length).toBe(4);
    expect(clock.state.origin[0]).not.toBeNaN();
  });

  it('clamps speed and seeking', () => {
    const clock = new PlaybackClock(replay);
    clock.setSpeed(1000);
    expect(clock.speed).toBe(16);
    clock.seek(-5);
    expect(clock.time).toBe(0);
    clock.seek(1e9);
    expect(clock.time).toBe(clock.duration);
  });
});

describe('cameras', () => {
  it('first person adds the view offset', () => {
    const s = replay.getPlayerState(0);
    const cam = firstPersonCamera(s);
    expect(cam.position[2]).toBeCloseTo(s.origin[2] + s.viewOffset[2], 4);
    expect(cam.angles[0]).toBe(s.eyeAngles[0]);
  });

  it('third person sits behind the eye along the view direction', () => {
    const s = replay.getPlayerState(100);
    const eye = firstPersonCamera(s).position;
    const cam = thirdPersonCamera(s, 100);
    const d = Math.hypot(
      cam.position[0] - eye[0],
      cam.position[1] - eye[1],
      cam.position[2] - eye[2],
    );
    expect(d).toBeCloseTo(100, 3);
  });
});

describe('map resolution', () => {
  it('computes sha1 with webcrypto', async () => {
    const hash = await sha1Hex(new TextEncoder().encode('abc'));
    expect(hash).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('prefers user sources and verifies hashes', async () => {
    const bsp = new TextEncoder().encode('fake bsp bytes');
    const hash = await sha1Hex(bsp);
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://mirror/maps/')) {
        return new Response(bsp.slice());
      }
      throw new Error('network blocked in test: ' + String(url));
    });
    const resolved = await resolveMap('bhop_test', hash, {
      sources: [directorySource('https://mirror/maps')],
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(resolved.exactVersion).toBe(true);
    expect(resolved.url).toBe('https://mirror/maps/bhop_test.bsp');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong hashes unless allowed', async () => {
    const bsp = new TextEncoder().encode('other bytes');
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/maps/bhop_test.bsp')) return new Response(bsp.slice());
      return new Response('{}', { status: 404 });
    });
    await expect(
      resolveMap('bhop_test', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', {
        sources: [directorySource('https://mirror/maps')],
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Could not resolve/);
  });
});
