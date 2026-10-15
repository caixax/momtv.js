#!/usr/bin/env node
// Fails if any tracked text file contains an em dash (U+2014) or an en dash (U+2013).
// Repo rule: use commas, colons, parentheses or a plain hyphen instead.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The banned characters are built from char codes so this file never
// contains them literally (it must pass its own check).
const BANNED = [
  { char: String.fromCharCode(0x2014), name: 'em dash (U+2014)' },
  { char: String.fromCharCode(0x2013), name: 'en dash (U+2013)' },
];

const BINARY_EXTENSIONS = new Set([
  '.mtv',
  '.bsp',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.zip',
]);

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

let failures = 0;
for (const file of files) {
  const dot = file.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.slice(dot).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) continue;

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted but still listed, or unreadable: not this check's problem
  }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { char, name } of BANNED) {
      const col = lines[i].indexOf(char);
      if (col !== -1) {
        console.error(`${file}:${i + 1}:${col + 1}: banned character ${name}`);
        failures++;
      }
    }
  }
}

if (failures > 0) {
  console.error(`\nFound ${failures} banned dash(es). Use a comma, colon, parentheses or '-'.`);
  process.exit(1);
}
console.log(`check:dashes OK (${files.length} tracked files scanned)`);
