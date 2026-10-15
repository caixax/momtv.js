#!/usr/bin/env node
// Decompresses the fixture replay body into tools/out/body.bin using the
// built @caixax/mtv package (run `pnpm build` first).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decompressBody, readHeader, readSplits } from '../packages/mtv/dist/index.js';

const file = process.argv[2] ?? new URL('../fixtures/bhop_eazy.mtv', import.meta.url);
const data = new Uint8Array(readFileSync(file));
const header = readHeader(data);
const { splits, bodyOffset } = readSplits(data);
const body = decompressBody(data, header, bodyOffset);

mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL('./out/body.bin', import.meta.url), body);

console.log(JSON.stringify(header, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`splits: ${splits.segments.length} segments`);
console.log(`body: ${body.length} bytes -> tools/out/body.bin`);
