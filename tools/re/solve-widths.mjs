// Derives the property widths the network table dump leaves open, by solving
// the baseline records as equations: each record declares its payload length
// in bits, and the payload is a 6 bit header plus every property of the class,
// each preceded by its index.
import { readFileSync } from 'node:fs';
import { parseReplay } from '../../packages/mtv/dist/index.js';

const META = JSON.parse(readFileSync(new URL('../out/prop-metadata.json', import.meta.url), 'utf8'));
const ALIASES = { CKnife: 'CMomentumKnife' };

/** Fixed width of a property, or null when it is one of the unknowns. */
function fixedWidth(meta, handleBits) {
  if (!meta) return null;
  const { b, t, f } = meta;
  const isHandle = f.includes('NOSCALE') && f.includes('UNSIGNED') && b === 23;
  const noscale = f.includes('NOSCALE');
  const cellCoord = f.includes('CELL_COORD');
  const coord = f.includes('COORD') && !cellCoord;
  const normal = f.includes('NORMAL');
  const floatBits = () => {
    if (cellCoord) return b + 5;
    if (coord) return null;
    if (normal) return 12;
    if (noscale || b === 0 || b === 32) return 32;
    return b;
  };
  switch (t) {
    case 'Int':
    case 'Int64':
      if (isHandle) return handleBits;
      return b === 0 ? 32 : b;
    case 'Float':
      return floatBits();
    case 'Vector': {
      const w = floatBits();
      return w === null ? null : w * 3;
    }
    case 'VectorXY': {
      const w = floatBits();
      return w === null ? null : w * 2;
    }
    default:
      return null;
  }
}

const replay = parseReplay(
  new Uint8Array(readFileSync('D:/Projects/momtv.js/fixtures/bhop_eazy.mtv')),
);
const body = replay.body;
const propBits = replay.header.propBits;
const classById = new Map(body.classes.map((c) => [c.classId, c]));

// distinct (class, payload length) pairs are the equations
const equations = [];
const seen = new Set();
for (const b of body.baselines) {
  const cls = classById.get(b.classId);
  if (!cls) continue;
  const key = `${cls.name}:${b.payloadBits}`;
  if (seen.has(key)) continue;
  seen.add(key);
  equations.push({ cls, payloadBits: b.payloadBits });
}

console.log('baseline equations:');
for (const eq of equations) {
  console.log(`  ${eq.cls.name.padEnd(22)} ${eq.cls.props.length} props, ${eq.payloadBits} bits`);
}

const HEADER = 6;
for (const handleBits of [21, 23]) {
  console.log(`\n-- handle=${handleBits}b header=${HEADER}b`);
  for (const eq of equations) {
    const meta = META[eq.cls.name] ?? META[ALIASES[eq.cls.name]] ?? {};
    let known = 0;
    const unknown = [];
    for (const prop of eq.cls.props) {
      const w = fixedWidth(meta[prop], handleBits);
      if (w === null) unknown.push(prop);
      else known += w;
    }
    const rest = eq.payloadBits - HEADER - eq.cls.props.length * propBits - known;
    console.log(
      `  ${eq.cls.name.padEnd(22)} known ${String(known).padStart(5)} | ${unknown.length} unknown ${unknown.length ? '[' + unknown.join(',') + ']' : ''} share ${rest} bits`,
    );
  }
}
