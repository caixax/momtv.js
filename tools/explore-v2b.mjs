// Exploration of the revised body layout found in replays recorded by the
// current playtest build (same formatVersion 2, different section shapes).
import { readFileSync } from 'node:fs';
import { decompressBody, readHeader, readSplits } from '../packages/mtv/dist/index.js';

const file = process.argv[2];
const data = new Uint8Array(readFileSync(file));
const h = readHeader(data);
const { bodyOffset } = readSplits(data);
const body = decompressBody(data, h, bodyOffset);
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
const cstr = () => {
  let e = pos;
  while (e < body.length && body[e] !== 0) e++;
  const s = new TextDecoder().decode(body.subarray(pos, e));
  pos = e + 1;
  return s;
};

console.log('==', file.split(/[\\/]/).pop(), 'bodyLen', body.length);
console.log(
  'header counts: classes',
  h.classCount,
  'sounds',
  h.sampleCount,
  'baselines',
  h.baselineCount,
  'kf',
  h.keyFrameCount,
  'frames',
  h.frameCount,
  'propBits',
  h.propBits,
);

// timeline: u16 count, records {i32 tick}{u8 flag}[{u8 track}{u8 major} if flag==2]
const tCount = u16();
console.log('timeline count', tCount);
for (let i = 0; i < tCount; i++) {
  const tick = i32();
  const flag = u8();
  if (flag === 2) {
    const track = u8();
    const major = u8();
    console.log(`  [${i}] tick=${tick} flag=${flag} track=${track} major=${major}`);
  } else {
    console.log(`  [${i}] tick=${tick} flag=${flag}`);
  }
}

// class table
console.log('class table @', '0x' + pos.toString(16));
const classes = [];
for (let c = 0; c < h.classCount; c++) {
  const id = u8();
  const name = cstr();
  const pc = u8();
  const props = [];
  for (let p = 0; p < pc; p++) props.push(cstr());
  classes.push({ id, name, props });
  console.log(`  id=${id} ${name} (${pc})`);
}
console.log('player props:', classes.find((c) => c.name === 'CMomentumPlayer')?.props.join(','));

// sounds
console.log('sounds @', '0x' + pos.toString(16));
for (let s = 0; s < h.sampleCount; s++) console.log(`  [${u16()}] ${cstr()}`);

// game events
const geSize = u32();
console.log('game events blob', geSize, 'bytes @', '0x' + pos.toString(16));
pos += geSize;

// baselines
const blSize = u32();
console.log('baseline section', blSize, 'bytes @', '0x' + pos.toString(16));
const blStart = pos;
// first record peek
{
  const tick = view.getInt32(pos, true);
  console.log(
    '  first record i32:',
    tick,
    'next bytes:',
    [...body.subarray(pos + 4, pos + 12)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
  );
}
pos = blStart + blSize;

// keyframe index
console.log('kf index @', '0x' + pos.toString(16));
for (let k = 0; k < h.keyFrameCount; k++) {
  console.log(`  tick=${u32()} kfOff=${u32()} frameOff=${u32()}`);
}
const kfSize = u32();
console.log('kf data', kfSize, 'bytes @ 0x' + pos.toString(16));
pos += kfSize;
const frSize = u32();
console.log(
  'frame data',
  frSize,
  'bytes @ 0x' + pos.toString(16),
  '-> ends 0x' + (pos + frSize).toString(16),
  'bodyLen 0x' + body.length.toString(16),
);
console.log(
  'first frame bytes:',
  [...body.subarray(pos, pos + 10)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
);
