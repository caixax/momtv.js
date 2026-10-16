// Finds where a body keeps its baseline records. The header counts them, but a
// revision 2 body declares the section as empty, so they sit somewhere else.
// A record chains as {int32 tick}{varint entity}{UBitVar class}{uint16 bits}
// {payload}, which only lines up at the real start.
//
// Usage: node tools/re/find-baselines.mjs [replay...]
import { readFileSync } from 'node:fs';
import {
  BitReader,
  decompressBody,
  parseReplay,
  readHeader,
  readSplits,
} from '../../packages/mtv/dist/index.js';

const files = process.argv.slice(2);
const replays = files.length
  ? files
  : [
      'testbed/public/replays/agtricks.momtv',
      'testbed/public/replays/ab_baume.momtv',
      'testbed/public/replays/bhop_badwater.momtv',
    ];

/** Reads a varint from a byte position. */
function varint(bytes, at) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const byte = bytes[at + i];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: at + i + 1 };
    shift += 7;
  }
  return null;
}

/** Tries to chain `count` records from `at`, returning them or null. */
function chain(bytes, at, count, classIds) {
  const records = [];
  let pos = at;
  for (let i = 0; i < count; i++) {
    if (pos + 7 > bytes.length) return null;
    const tick =
      bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
    const entity = varint(bytes, pos + 4);
    if (!entity) return null;
    const r = new BitReader(bytes, entity.next, Math.min(8, bytes.length - entity.next));
    let classId;
    let bits;
    try {
      classId = r.readUBitVar();
      bits = r.readBits(16);
    } catch {
      return null;
    }
    if (!classIds.has(classId)) return null;
    if (bits === 0 || bits > 1 << 15) return null;
    const payloadBitStart = r.bitPos;
    const next = Math.ceil((payloadBitStart + bits) / 8);
    records.push({ tick, entity: entity.value, classId, bits, at: pos, payloadBitStart });
    pos = next;
  }
  return { records, end: pos };
}

for (const path of replays) {
  const data = new Uint8Array(readFileSync(path));
  const header = readHeader(data);
  const { bodyOffset } = readSplits(data);
  const body = decompressBody(data, header, bodyOffset);
  const replay = parseReplay(data);
  const classIds = new Set(replay.body.classes.map((c) => c.classId));
  const names = new Map(replay.body.classes.map((c) => [c.classId, c.name]));

  console.log(
    `\n${path}: body ${body.length} bytes, header counts ${header.baselineCount} baselines`,
  );
  let found = 0;
  for (let at = 0; at + 8 < body.length && found < 4; at++) {
    const got = chain(body, at, header.baselineCount, classIds);
    if (!got) continue;
    found++;
    console.log(
      `  ${header.baselineCount} records chain from byte ${at} to ${got.end} ` +
        `(${got.end - at} bytes)`,
    );
    for (const rec of got.records.slice(0, 10)) {
      console.log(
        `      entity ${String(rec.entity).padStart(3)}  ${names.get(rec.classId)}  ` +
          `${rec.bits} bits  tick ${rec.tick}`,
      );
    }
    if (got.records.length > 10) console.log(`      ... ${got.records.length - 10} more`);
  }
  if (!found) console.log('  no position chains them all');
}
