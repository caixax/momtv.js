// Prints a stretch of a section read as the stream's own primitives, so the
// fields before a known value can be identified by eye.
//
// Usage: node tools/re/dump-bits.mjs <replay> <section> <startBit> <count>
import { readFileSync } from 'node:fs';
import { BitReader, parseReplay } from '../../packages/momtv/dist/index.js';

const path = process.argv[2] ?? 'testbed/public/replays/agtricks.momtv';
const which = process.argv[3] ?? 'keyframeData';
const startBit = Number(process.argv[4] ?? 0);
const stopBit = Number(process.argv[5] ?? 400);

const replay = parseReplay(new Uint8Array(readFileSync(path)));
const body = replay.body;
const section = body[which];

const at = (bit) => {
  const r = new BitReader(body.bytes, section.offset, section.length);
  r.bitPos = section.offset * 8 + bit;
  return r;
};

const bytes = body.bytes.subarray(section.offset + startBit / 8, section.offset + stopBit / 8 + 8);
console.log(
  `${which} bits ${startBit}..${stopBit}\nbytes: ` +
    [...bytes.subarray(0, 48)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
);
console.log(
  'bits : ' +
    [...bytes.subarray(0, 12)]
      .map((b) => b.toString(2).padStart(8, '0').split('').reverse().join(''))
      .join(' '),
);

console.log('\nread as a chain of UBitVars from the start:');
let r = at(startBit);
const chain = [];
while (r.bitPos - section.offset * 8 < stopBit) {
  const bit = r.bitPos - section.offset * 8;
  const value = r.readUBitVar();
  chain.push(`${bit}:${value}`);
}
console.log('  ' + chain.join(' '));

console.log('\nread as a chain of varints from the start:');
r = at(startBit);
const varints = [];
while (r.bitPos - section.offset * 8 < stopBit) {
  const bit = r.bitPos - section.offset * 8;
  const value = r.readVarInt32();
  varints.push(`${bit}:${value}`);
}
console.log('  ' + varints.join(' '));

console.log('\nvalue of each 6 bit group:');
r = at(startBit);
const groups = [];
while (r.bitPos - section.offset * 8 < stopBit) {
  const bit = r.bitPos - section.offset * 8;
  groups.push(`${bit}:${r.readBits(6)}`);
}
console.log('  ' + groups.join(' '));
