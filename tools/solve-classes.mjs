// Solves per-class header length and ambiguous prop widths for the weapon and
// viewmodel baselines by exhaustive search, anchored on ascending 5-bit prop
// indices and exact payload ends.
import { readFileSync } from 'node:fs';
import { BitReader } from './bitreader.mjs';

const body = readFileSync(new URL('./out/body.bin', import.meta.url));

const CLS = {
  vm: {
    start: 0x852,
    end: 0x872,
    classBits: 6,
    props: [
      ['model', [13, 11]],
      ['hWeapon', [23, 21]],
      ['body', [32]],
      ['skin', [10, 11]],
      ['sequence', [8, 9, 12]],
      ['vmIndex', [2, 3]],
      ['playback', [8]],
      ['effects', [15, 11, 12]],
      ['animParity', [3]],
      ['hOwner', [23, 21]],
      ['newSeqParity', [3]],
      ['resetEvtParity', [3]],
      ['muzzleParity', [2, 3]],
      ['bIgnoreOffset', [1]],
      ['animTime', [8, 'f', 32]],
    ],
  },
  pistol: {
    start: 0x877,
    end: 0x8a5,
    classBits: 6,
    props: [
      ['bSimTick', [1]],
      ['effects', [15, 11, 12]],
      ['nextPrimary', ['f']],
      ['nextSecondary', ['f']],
      ['nextThink', [32]],
      ['idle', ['f']],
      ['model', [13, 11]],
      ['hOwnerEntity', [23, 21]],
      ['moveparent', [23, 21]],
      ['vmIdx', [13, 11]],
      ['wmIdx', [13, 11]],
      ['hOwner', [23, 21]],
      ['state', [2, 3]],
      ['clip1', [8]],
      ['burst', [1]],
    ],
  },
  knife: {
    start: 0x8aa,
    end: 0x8dc,
    classBits: 6,
    props: [
      ['bSimTick', [1]],
      ['effects', [15, 11, 12]],
      ['nextPrimary', ['f']],
      ['nextSecondary', ['f']],
      ['nextThink', [32]],
      ['idle', ['f']],
      ['model', [13, 11]],
      ['hOwnerEntity', [23, 21]],
      ['moveparent', [23, 21]],
      ['vmIdx', [13, 11]],
      ['wmIdx', [13, 11]],
      ['hOwner', [23, 21]],
      ['state', [2, 3]],
      ['clip1', [8]],
      ['smackTime', ['f']],
    ],
  },
};

for (const [name, cfg] of Object.entries(CLS)) {
  const startBit = cfg.start * 8 + cfg.classBits;
  const endBit = cfg.end * 8;
  const sols = [];
  for (let H = 0; H <= 34; H++) {
    const walk = (bitPos, last, choices) => {
      if (sols.length > 20) return;
      if (endBit - bitPos < 8) {
        let padZero = true;
        for (let b = bitPos; b < endBit; b++) if ((body[b >> 3] >> (b & 7)) & 1) padZero = false;
        if (bitPos <= endBit && padZero && choices.length)
          sols.push({ H, choices: choices.join(' ') });
        return;
      }
      const r0 = new BitReader(body, 0);
      r0.bitPos = bitPos;
      const idx = r0.readBits(5);
      if (idx <= last || idx >= cfg.props.length) return;
      for (const w of cfg.props[idx][1]) {
        const r = new BitReader(body, 0);
        r.bitPos = r0.bitPos;
        r.readBits(w === 'f' ? 32 : w);
        if (r.bitPos > endBit) continue;
        walk(r.bitPos, idx, [...choices, cfg.props[idx][0] + ':' + w]);
      }
    };
    walk(startBit + H, -1, []);
  }
  console.log(name, 'solutions:');
  for (const s of sols.slice(0, 8)) console.log('  H=' + s.H, s.choices);
  if (!sols.length) console.log('  none');
}
