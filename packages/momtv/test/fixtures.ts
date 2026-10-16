import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Loads a fixture replay as a Uint8Array. */
export function loadFixture(name: string): Uint8Array {
  const buf = readFileSync(join(root, 'fixtures', name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** The official Momentum Mod sample replay (bhop_eazy, MIT licensed). */
export function bhopEazy(): Uint8Array {
  return loadFixture('bhop_eazy.mtv');
}
