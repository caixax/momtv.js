#!/usr/bin/env node
// Annotated dump of a decompressed .mtv body (tools/out/body.bin).
// Prints every section with offsets. Regenerate body.bin with:
//   node tools/dump-fixture.mjs
import { readFileSync } from 'node:fs';
import { BitReader } from './bitreader.mjs';

const body = new Uint8Array(readFileSync(new URL('./out/body.bin', import.meta.url)));
const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
let pos = 0;

const u8 = () => view.getUint8(pos++);
const u16 = () => {
  const v = view.getUint16(pos, true);
  pos += 2;
  return v;
};
const i32 = () => {
  const v = view.getInt32(pos, true);
  pos += 4;
  return v;
};
const u32 = () => {
  const v = view.getUint32(pos, true);
  pos += 4;
  return v;
};
const f64 = () => {
  const v = view.getFloat64(pos, true);
  pos += 8;
  return v;
};
const cstr = () => {
  let end = pos;
  while (end < body.length && body[end] !== 0) end++;
  const s = new TextDecoder().decode(body.subarray(pos, end));
  pos = end + 1;
  return s;
};
const varint = () => {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const b = u8();
    v |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) break;
  }
  return v >>> 0;
};
const at = () => '0x' + pos.toString(16).padStart(6, '0');

// These come from the fixture's header; pass others on the command line later
// if more fixtures are added.
const COUNTS = { classes: 6, sounds: 3, baselines: 198, keyframes: 9, frames: 3386 };

console.log(`body: ${body.length} bytes\n`);

console.log(`=== 1. event timeline @ ${at()} ===`);
const timelineCount = u32();
console.log(`count: ${timelineCount}`);
for (let i = 0; i < timelineCount; i++) {
  const tick = i32();
  const zone = u16();
  const track = u8();
  const type = u8();
  const time = f64();
  const major = u8();
  const minor = u8();
  console.log(
    `  [${i}] tick=${tick} zone=${zone} track=${track} type=${type} time=${time.toFixed(4)} major=${major} minor=${minor}`,
  );
}

console.log(`\n=== 2. class table @ ${at()} ===`);
const classes = [];
for (let c = 0; c < COUNTS.classes; c++) {
  const classId = u8();
  const name = cstr();
  const propCount = u8();
  const props = [];
  for (let p = 0; p < propCount; p++) props.push(cstr());
  classes.push({ classId, name, props });
  console.log(`  id=${classId} ${name} (${propCount} props)`);
  console.log(`    ${props.join(', ')}`);
}

console.log(`\n=== 3. sound table @ ${at()} ===`);
for (let s = 0; s < COUNTS.sounds; s++) {
  const idx = u16();
  console.log(`  [${idx}] ${cstr()}`);
}

console.log(`\n=== 4. game event definitions @ ${at()} ===`);
const geSize = u32();
console.log(`protobuf blob: ${geSize} bytes (CSVCMsg_GameEventList-like)`);
{
  // light protobuf walk: top level repeated field 1 = descriptor
  const end = pos + geSize;
  while (pos < end) {
    const tag = u8();
    if (tag === 0x0a) {
      const len = varint();
      const sub = body.subarray(pos, pos + len);
      // descriptor: field1 varint id, field2 string name
      let sp = 0;
      let id = -1;
      let name = '';
      const keys = [];
      while (sp < sub.length) {
        const t = sub[sp++];
        if (t === 0x08) {
          let v = 0;
          let sh = 0;
          while (sub[sp] & 0x80) {
            v |= (sub[sp++] & 0x7f) << sh;
            sh += 7;
          }
          v |= sub[sp++] << sh;
          id = v;
        } else if (t === 0x12) {
          const l = sub[sp++];
          name = new TextDecoder().decode(sub.subarray(sp, sp + l));
          sp += l;
        } else if (t === 0x1a) {
          const l = sub[sp++];
          const key = sub.subarray(sp, sp + l);
          sp += l;
          // key: 08 type 12 len name
          const kl = key[3];
          keys.push(new TextDecoder().decode(key.subarray(4, 4 + kl)));
        } else {
          break;
        }
      }
      console.log(`  event ${id}: ${name}${keys.length ? ' keys: ' + keys.join(',') : ''}`);
      pos += len;
    } else {
      // unknown field: skip a varint value
      varint();
    }
  }
  pos = end;
}

console.log(`\n=== 5. baselines @ ${at()} ===`);
const baselineSize = u32();
const baselineEnd = pos + baselineSize;
console.log(`section size: ${baselineSize} bytes, ${COUNTS.baselines} records`);
{
  let shown = 0;
  while (pos < baselineEnd && shown < 12) {
    const start = pos;
    const tick = i32();
    const ent = varint();
    const r = new BitReader(body, pos);
    const classId = r.readUBitVar();
    const cls = classes.find((c) => c.classId === classId);
    console.log(
      `  [${ent}] @0x${start.toString(16)} tick=${tick} class=${classId} (${cls?.name ?? '?'})`,
    );
    shown++;
    // payload length is implicit; for the dump we locate the next record by
    // scanning for its plausible header (tick field) since full per-class
    // decoding is not finished yet.
    let next = baselineEnd;
    for (let p = pos + 1; p < baselineEnd - 5; p++) {
      const t = view.getInt32(p, true);
      if (t === tick || t === -2468) {
        // candidate: varint ent must be ent+1
        let vp = p + 4;
        let v = 0;
        let sh = 0;
        let ok = true;
        for (let i = 0; i < 5; i++) {
          const b = body[vp++];
          v |= (b & 0x7f) << sh;
          sh += 7;
          if ((b & 0x80) === 0) break;
          if (i === 4) ok = false;
        }
        if (ok && v === ent + 1) {
          next = p;
          break;
        }
      }
    }
    pos = next;
  }
  console.log(`  ... (${COUNTS.baselines - shown} more)`);
  pos = baselineEnd;
}

console.log(`\n=== 6. keyframe index @ ${at()} ===`);
const kfs = [];
for (let k = 0; k < COUNTS.keyframes; k++) {
  const tick = u32();
  const kfOff = u32();
  const frameOff = u32();
  kfs.push({ tick, kfOff, frameOff });
  console.log(`  [${k}] tick=${tick} keyframeOffset=${kfOff} frameOffset(tick+1)=${frameOff}`);
}

console.log(`\n=== 7. keyframe data @ ${at()} ===`);
const kfSize = u32();
console.log(`size: ${kfSize} bytes`);
pos += kfSize;

console.log(`\n=== 8. frame data @ ${at()} ===`);
const frameSize = u32();
console.log(
  `size: ${frameSize} bytes, ${COUNTS.frames} frames (ends at 0x${(pos + frameSize).toString(16)}, body length 0x${body.length.toString(16)})`,
);
