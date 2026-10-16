// Prints the first fields of the frame data under the exact grammar, so the
// meaning of each one can be checked against what the replay declares.
//
// Usage: node tools/re/trace-frame.mjs <replay> [frames]
import { readFileSync } from 'node:fs';
import { BitReader, parseReplay } from '../../packages/momtv/dist/index.js';

const path = process.argv[2] ?? 'testbed/public/replays/agtricks.momtv';
const want = Number(process.argv[3] ?? 3);
const replay = parseReplay(new Uint8Array(readFileSync(path)));
const body = replay.body;

console.log(`${path}  revision ${body.revision}  propBits ${replay.header.propBits}`);
console.log('classes:');
for (const [i, c] of body.classes.entries()) {
  console.log(`  index ${i}  id ${c.classId}  ${c.name}  ${c.props.length} props`);
}
console.log(`keyframe anchors (byte offset -> tick):`);
for (const k of body.keyframeIndex.slice(0, 6)) {
  console.log(`  ${k.frameOffset} -> ${k.tick}`);
}

const r = new BitReader(body.bytes, body.frameData.offset, body.frameData.length);
const first = body.bytes.subarray(body.frameData.offset, body.frameData.offset + 24);
console.log('first bytes:', [...first].map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log(
  'first bits :',
  [...first.subarray(0, 8)]
    .map((b) => b.toString(2).padStart(8, '0').split('').reverse().join(''))
    .join(' '),
);

for (let f = 0; f < want; f++) {
  console.log(`\n-- reading at bit ${r.bitPos - body.frameData.offset * 8}`);
  const flag = r.readBit();
  const hasCreations = r.readBit();
  console.log(`  flag=${flag} hasCreations=${hasCreations}`);
  if (hasCreations) {
    const count = r.readUBitVar();
    console.log(`  creation count=${count}`);
    for (let i = 0; i < Math.min(count, 48); i++) {
      const a = r.readVarInt32();
      const b = r.readVarInt32();
      const c = r.readVarInt32();
      console.log(`    create {${a}, ${b}, ${c}}`);
    }
    if (count > 48) break;
  }
  const updates = r.readUBitVar();
  console.log(`  update count=${updates}`);
  for (let i = 0; i < Math.min(updates, 48); i++) {
    const a = r.readUBitVar();
    const b = r.readUBitVar();
    const c = r.readUBitVar();
    console.log(`    update {${a}, ${b}, ${c}}`);
  }
  break;
}
