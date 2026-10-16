// Generates packages/momtv/src/prop-table.ts from the network table dumps in
// tools/out/dt. A replay's class table names the properties it records but not
// how they are encoded, so the parser needs the widths and flags the game uses.
//
// The dumps are the game's own flattened tables: array properties appear as a
// length field followed by the elements repeated, with the element names lost,
// so those are reassembled here into a single array encoding.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const DT_DIR = 'tools/out/dt';

/** An entity handle, as every class encodes it. */
const EHANDLE = { kind: 'int', bits: 23, flags: ['UNSIGNED', 'NOSCALE'] };
const OUT = 'packages/momtv/src/prop-table.ts';

/** Property kinds, matching the dump's Type column. */
const KINDS = {
  Int: 'int',
  Float: 'float',
  Vector: 'vector',
  VectorXY: 'vectorxy',
  String: 'string',
  Array: 'array',
};

function parseCsv(text) {
  const [head, ...rest] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  return rest.map((line) => {
    // the flags column never contains a comma, so a plain split is enough
    const cells = line.split(',');
    const row = {};
    cols.forEach((c, i) => (row[c] = cells[i] ?? ''));
    return row;
  });
}

/** Collapses the flattened rows of one class into named encodings. */
function readClass(rows) {
  const props = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const length = /^lengthprop(\d+)$/.exec(row.Name);
    if (length) {
      const max = Number(length[1]);
      const after = rows.slice(i + 1);
      const first = after[0]?.Name;
      // Elements of a plain array are named by their index, one row each. An
      // array of structures repeats the structure's property names instead, so
      // its size is the distance until the first name comes round again.
      let stride = 1;
      if (first && !/^\d{3}$/.test(first)) {
        const repeat = after.findIndex((r, j) => j > 0 && r.Name === first);
        if (repeat > 0) stride = repeat;
      }
      props.push({
        name: null, // the dump drops the array's own name
        kind: 'array',
        countBits: Number(row.Bits),
        max,
        element: encodingOf(after[0]),
        structProps: stride,
      });
      i += stride * max;
      continue;
    }
    props.push({ name: row.Name, ...encodingOf(row) });
  }
  return props;
}

function encodingOf(row) {
  return {
    kind: KINDS[row.Type] ?? 'int',
    bits: Number(row.Bits),
    flags: (row.Flags ?? '').split('|').filter(Boolean),
  };
}

/** `m_hMyWeapons:000` and friends are one array property in a replay. */
function foldIndexedProps(props) {
  const out = [];
  const seen = new Map();
  for (const prop of props) {
    const indexed = prop.name && /^(.+):(\d{3})$/.exec(prop.name);
    if (!indexed) {
      out.push(prop);
      continue;
    }
    const [, base, index] = indexed;
    const at = seen.get(base);
    if (at === undefined) {
      seen.set(base, out.length);
      out.push({
        name: base,
        kind: 'array',
        countBits: 0, // filled in once the element count is known
        max: 1,
        element: { kind: prop.kind, bits: prop.bits, flags: prop.flags },
      });
    } else {
      out[at].max = Math.max(out[at].max, Number(index) + 1);
    }
  }
  for (const prop of out) {
    if (prop.kind === 'array' && prop.countBits === 0) {
      prop.countBits = Math.floor(Math.log2(prop.max)) + 1;
    }
  }
  return out;
}

/**
 * Properties the recorder writes one bit wider than the network table says.
 * Measured against exact frame boundaries: without the extra bit every frame
 * carrying one of these ends a bit early and throws the walk out of step.
 */
const EXTRA_BITS = {
  m_iLandTick: 1,
  m_iJumpTick: 1,
  m_iEarlyJumpTiming: 1,
  hasteEndTick: 1,
  damageBoostEndTick: 1,
  slickEndTick: 1,
  flightEndTick: 1,
  defragTimerEndTick: 1,
};

/**
 * Arrays the dump reports without their element encoding. The dump prints the
 * property as a bare `Array` with no length field and no elements, so the
 * encoding is filled in here.
 */
const KNOWN_ARRAYS = {
  // Two view models (the weapon and the hands), each an entity handle.
  m_hViewModel: { kind: 'array', bits: 0, countBits: 2, max: 2, element: EHANDLE },
};

const classes = {};
for (const file of readdirSync(DT_DIR)) {
  if (!file.endsWith('.csv') || file === 'ServerClassInfo.csv') continue;
  const name = basename(file, '.csv');
  const props = foldIndexedProps(readClass(parseCsv(readFileSync(join(DT_DIR, file), 'utf8'))));
  classes[name] = props.map((prop) =>
    prop.name && KNOWN_ARRAYS[prop.name] && prop.kind === 'array' && !prop.element
      ? { name: prop.name, ...KNOWN_ARRAYS[prop.name] }
      : prop,
  );
}

// Properties shared by every entity encode identically wherever they appear,
// so one table covers classes the dumps do not include.
const shared = new Map();
const conflicting = new Set();
const tally = new Map();
for (const props of Object.values(classes)) {
  for (const prop of props) {
    if (!prop.name) continue;
    const key = JSON.stringify([prop.kind, prop.bits, prop.flags, prop.countBits, prop.max]);
    const before = shared.get(prop.name);
    if (before === undefined) shared.set(prop.name, { key, prop });
    else if (before.key !== key) conflicting.add(prop.name);
    const counts = tally.get(prop.name) ?? new Map();
    const seen = counts.get(key) ?? { n: 0, prop };
    seen.n++;
    counts.set(key, seen);
    tally.set(prop.name, counts);
  }
}

const serialise = (prop) => {
  const parts = [`k:'${prop.kind}'`, `b:${prop.bits ?? 0}`];
  if (prop.name && EXTRA_BITS[prop.name]) parts.push(`x:${EXTRA_BITS[prop.name]}`);
  if (prop.flags?.length) parts.push(`f:${JSON.stringify(prop.flags)}`);
  if (prop.kind === 'array') {
    parts.push(`c:${prop.countBits}`, `m:${prop.max}`);
    if (prop.element) parts.push(`e:{${serialise(prop.element)}}`);
    if (prop.structProps > 1) parts.push(`s:${prop.structProps}`);
  }
  return parts.join(',');
};

const lines = [];
lines.push("// Generated by tools/gen-prop-table.mjs from the game's network table dumps.");
lines.push('// Do not edit by hand; rerun the generator instead.');
lines.push('');
lines.push("import type { PropEncoding } from './prop-encoding.js';");
lines.push('');
lines.push('/** Encodings for properties that every entity class shares. */');
lines.push('export const SHARED_PROPS: Record<string, PropEncoding> = {');
for (const [name, { prop }] of [...shared].sort()) {
  if (conflicting.has(name)) continue;
  lines.push(`  ${JSON.stringify(name)}: {${serialise(prop)}},`);
}
lines.push('};');
lines.push('');
lines.push('/** Per class encodings, for properties whose encoding is class specific. */');
lines.push('export const CLASS_PROPS: Record<string, Record<string, PropEncoding>> = {');
for (const [cls, props] of Object.entries(classes).sort()) {
  // A name can appear more than once in a flattened table; the first
  // occurrence is the class's own property.
  const own = new Map();
  for (const prop of props) {
    if (prop.name && conflicting.has(prop.name) && !own.has(prop.name)) own.set(prop.name, prop);
  }
  if (!own.size) continue;
  lines.push(`  ${JSON.stringify(cls)}: {`);
  for (const [name, prop] of own) {
    lines.push(`    ${JSON.stringify(name)}: {${serialise(prop)}},`);
  }
  lines.push('  },');
}
lines.push('};');
lines.push('');
lines.push('/**');
lines.push(' * Array properties the dumps leave unnamed, in the order they appear in each');
lines.push(" * class's table. A replay names them, so they are matched up by position.");
lines.push(' */');
lines.push('export const UNNAMED_ARRAYS: Record<string, PropEncoding[]> = {');
for (const [cls, props] of Object.entries(classes).sort()) {
  const arrays = props.filter((p) => !p.name && p.kind === 'array');
  if (!arrays.length) continue;
  lines.push(`  ${JSON.stringify(cls)}: [`);
  for (const prop of arrays) lines.push(`    {${serialise(prop)}},`);
  lines.push('  ],');
}
lines.push('};');
lines.push('');
lines.push('/**');
lines.push(' * Best guess for properties whose encoding differs between classes, for use');
lines.push(' * with classes the dumps do not cover. The most common encoding wins.');
lines.push(' */');
lines.push('export const FALLBACK_PROPS: Record<string, PropEncoding> = {');
for (const name of [...conflicting].sort()) {
  const counts = [...tally.get(name)].sort((a, b) => b[1].n - a[1].n);
  lines.push(`  ${JSON.stringify(name)}: {${serialise(counts[0][1].prop)}},`);
}
lines.push('};');
lines.push('');

writeFileSync(OUT, lines.join('\n'));

const named = [...shared].filter(([n]) => !conflicting.has(n)).length;
console.log(
  `${Object.keys(classes).length} classes, ${named} shared props, ${conflicting.size} class specific, ` +
    `${Object.values(classes).reduce((n, p) => n + p.filter((q) => !q.name).length, 0)} unnamed arrays`,
);
console.log(`${OUT}: ${(readFileSync(OUT).length / 1024).toFixed(1)} KB`);
