import { readFileSync } from 'node:fs';
import {
  GamemodeName,
  MtvError,
  parseReplay,
  readHeader,
  StyleName,
  TrackTypeName,
  trackStateAt,
  type Gamemode,
  type Style,
  type TrackType,
} from '@caixax/mtv';

const USAGE = `Usage: mtv-dump <file.mtv> [options]

Options:
  --summary   header, splits and event summary (default)
  --json      full decoded player track as JSON
  --csv       player track as CSV (tick,x,y,z,pitch,yaw,vx,vy,vz,buttons,flags)
  --header    header only (does not decompress the body)
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const mode = args.find((a) => a.startsWith('--')) ?? '--summary';
if (!file) fail(USAGE);

let data: Uint8Array;
try {
  data = new Uint8Array(readFileSync(file));
} catch (error) {
  fail(`Cannot read ${file}: ${(error as Error).message}`);
}

const fmt = (n: number, d = 2): string => n.toFixed(d);

try {
  if (mode === '--header') {
    const header = readHeader(data);
    console.log(JSON.stringify(header, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    process.exit(0);
  }

  const replay = parseReplay(data);
  const h = replay.header;

  if (mode === '--summary') {
    console.log(`map        ${h.mapName} (${h.mapHash.toLowerCase()})`);
    console.log(`player     ${h.playerName} (${h.playerSteamId})`);
    console.log(
      `mode       ${GamemodeName[h.gamemode as Gamemode] ?? h.gamemode}, style ${StyleName[h.style as Style] ?? h.style}`,
    );
    console.log(
      `track      ${TrackTypeName[h.trackType as TrackType] ?? h.trackType} ${h.trackNum}`,
    );
    console.log(
      `time       ${fmt(h.runTime, 3)}s (${h.frameCount} ticks at ${Math.round(1 / h.tickInterval)}/s)`,
    );
    console.log(`recorded   ${new Date(h.timestamp).toISOString()}`);
    console.log(`classes    ${replay.classes.map((c) => c.name).join(', ')}`);
    console.log('events:');
    for (const e of replay.events) {
      console.log(
        `  tick ${String(e.tick).padStart(6)}  t=${fmt(e.time, 3).padStart(8)}s  type=${e.type} zone=${e.zoneFlag} segment=${e.majorNum}.${e.minorNum}`,
      );
    }
    const track = replay.toTrack();
    let top = 0;
    for (let t = 0; t < track.frameCount; t++) {
      const s = trackStateAt(track, t);
      top = Math.max(top, Math.hypot(s.velocity[0], s.velocity[1]));
    }
    console.log(`top speed  ${fmt(top, 0)} u/s`);
    console.log(
      `decode     ${track.stats.frames}/${track.frameCount} frames, ${track.stats.lostFrames} lost`,
    );
    process.exit(0);
  }

  const track = replay.toTrack();
  if (mode === '--json') {
    const out = [];
    for (let t = 0; t < track.frameCount; t++) out.push(trackStateAt(track, t));
    console.log(
      JSON.stringify({ header: { ...h, playerSteamId: h.playerSteamId.toString() }, track: out }),
    );
    process.exit(0);
  }

  if (mode === '--csv') {
    console.log('tick,x,y,z,pitch,yaw,vx,vy,vz,buttons,flags');
    for (let t = 0; t < track.frameCount; t++) {
      const s = trackStateAt(track, t);
      console.log(
        [
          s.tick,
          fmt(s.origin[0], 4),
          fmt(s.origin[1], 4),
          fmt(s.origin[2], 4),
          fmt(s.eyeAngles[0], 2),
          fmt(s.eyeAngles[1], 2),
          fmt(s.velocity[0], 2),
          fmt(s.velocity[1], 2),
          fmt(s.velocity[2], 2),
          s.buttons,
          s.flags,
        ].join(','),
      );
    }
    process.exit(0);
  }

  fail(USAGE);
} catch (error) {
  if (error instanceof MtvError) fail(`${error.code}: ${error.message}`);
  throw error;
}
