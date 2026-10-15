import { describe, expect, it } from 'vitest';
import {
  Gamemode,
  ReplayCompression,
  readHeader,
  readSplits,
  REPLAY_HEADER_SIZE,
  TrackType,
} from '../src/index.js';
import { bhopEazy } from './fixtures.js';

describe('readHeader', () => {
  const header = readHeader(bhopEazy());

  it('reads the identity fields', () => {
    expect(header.formatVersion).toBe(2);
    expect(header.mapName).toBe('bhop_eazy');
    expect(header.mapHash).toMatch(/^[0-9a-fA-F]{40}$/);
    expect(header.playerName.length).toBeGreaterThan(0);
    expect(header.playerSteamId > 0n).toBe(true);
    expect(header.timestamp).toBeGreaterThan(1_500_000_000_000);
  });

  it('reads the run fields', () => {
    expect(header.gamemode).toBe(Gamemode.Bhop);
    expect(header.compression).toBe(ReplayCompression.Lzma);
    expect(header.tickInterval).toBeCloseTo(0.01, 6);
    expect(header.trackType).toBe(TrackType.Main);
    expect(header.runTime).toBeGreaterThan(0);
    expect(header.runTime).toBeLessThan(3600);
  });

  it('reads the body counter fields the official reader skips', () => {
    expect(header.frameCount).toBe(3386);
    expect(header.keyFrameCount).toBe(9);
    expect(header.baselineCount).toBe(198);
    expect(header.classCount).toBe(6);
    expect(header.tempEntClassCount).toBe(0);
    expect(header.sampleCount).toBe(3);
    expect(header.propBits).toBe(5);
    expect(header.tempEntClassBits).toBe(3);
  });

  it('is consistent: frameCount * tickInterval roughly covers runTime', () => {
    const recorded = header.frameCount * header.tickInterval;
    expect(recorded).toBeGreaterThanOrEqual(header.runTime);
  });
});

describe('readSplits', () => {
  it('parses the splits JSON and reports the body offset', () => {
    const data = bhopEazy();
    const { splits, bodyOffset } = readSplits(data);
    expect(Array.isArray(splits.segments)).toBe(true);
    expect(splits.segments.length).toBeGreaterThan(0);
    expect(splits.trackStats.jumps).toBeGreaterThan(0);
    expect(bodyOffset).toBeGreaterThan(REPLAY_HEADER_SIZE + 4);
    expect(bodyOffset).toBeLessThan(data.length);
  });
});
