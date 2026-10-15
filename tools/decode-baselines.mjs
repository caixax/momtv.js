// Decodes every baseline record completely using the SendProp metadata from
// the game's sv_dump_class_table output, and verifies each payload parses to
// its exact end (trailing pad < 8 zero bits). This validates the per-class
// property encodings in one shot.
import { readFileSync } from 'node:fs';
import { BitReader } from './bitreader.mjs';

const body = readFileSync(new URL('./out/body.bin', import.meta.url));

// ---- knobs under test ----
const HANDLE_BITS = Number(process.argv[2] ?? 23);
// how the (simTime, animTime) header fields are encoded when flagged
const TIME_MODE = process.argv[3] ?? 'ubitvar'; // 'ubitvar' | 'u8'

const dv = new DataView(new ArrayBuffer(4));
const f32 = (r) => {
  dv.setUint32(0, r.readBits(32), true);
  return dv.getFloat32(0, true);
};

// Prop decoders built from the DT dump (type, bits, flags).
const D = {
  bool: (r) => r.readBits(1),
  int: (bits) => (r) => r.readBits(bits),
  f32,
  vec3f32: (r) => [f32(r), f32(r), f32(r)],
  vecXYf32: (r) => [f32(r), f32(r)],
  ang13x3: (r) => [r.readBits(13), r.readBits(13), r.readBits(13)],
  rangeFloat: (bits) => (r) => r.readBits(bits),
  handle: (r) => r.readBits(HANDLE_BITS),
  // CELL_COORD vector with 5 fractional-ish bits: cell-relative coordinate.
  // Source cell coord: integer part of log2(cellwidth) bits + fractional 5.
  // cellwidth = 1 << cellbits(5) = 32 -> 5 int bits + 5 frac bits per comp?
  cellVec: (r) => {
    const read1 = () => r.readBits(5) + r.readBits(5) / 32;
    return [read1(), read1(), read1()];
  },
};

// Replay class tables (prop order from the .mtv class table) with decoders
// from the DT dump.
const CLASSES = {
  0: {
    name: 'CMomentumPlayer',
    props: [
      ['m_bSimulatedEveryTick', D.bool],
      ['m_fEffects', D.int(15)],
      ['m_vecOrigin', D.vecXYf32],
      ['m_vecOrigin[2]', D.f32],
      ['m_vecMinsPreScaled', D.vec3f32],
      ['m_vecMaxsPreScaled', D.vec3f32],
      ['m_nModelIndex', D.int(13)],
      ['m_nBody', D.int(32)],
      ['m_clrModelPrimary', D.int(32)],
      ['m_clrModelSecondary', D.int(32)],
      ['m_angRotation', D.ang13x3],
      ['m_angEyeAngles[0]', D.rangeFloat(11)],
      ['m_angEyeAngles[1]', D.rangeFloat(11)],
      ['m_bClientSideAnimation', D.bool],
      ['m_vecViewOffset[0]', D.rangeFloat(8)],
      ['m_vecViewOffset[1]', D.rangeFloat(8)],
      ['m_vecViewOffset[2]', D.rangeFloat(10)],
      ['m_hViewModel', 'ARRAY_UNKNOWN'],
      ['m_vecVelocity[0]', D.f32],
      ['m_vecVelocity[1]', D.f32],
      ['m_vecVelocity[2]', D.f32],
      ['m_nPhysicalButtons', D.int(32)],
      ['m_afButtonDisabled', D.int(32)],
      ['m_afButtonForced', D.int(32)],
      ['m_nButtonsToggled', D.int(32)],
      ['m_fFlags', D.int(11)],
    ],
  },
  1: {
    name: 'CMomentumViewModel',
    props: [
      ['m_nModelIndex', D.int(13)],
      ['m_hWeapon', D.handle],
      ['m_nBody', D.int(32)],
      ['m_nSkin', D.int(10)],
      ['m_nSequence', D.int(8)],
      ['m_nViewModelIndex', D.int(2)],
      ['m_flPlaybackRate', D.rangeFloat(8)],
      ['m_fEffects', D.int(15)],
      ['m_nAnimationParity', D.int(3)],
      ['m_hOwner', D.handle],
      ['m_nNewSequenceParity', D.int(3)],
      ['m_nResetEventsParity', D.int(3)],
      ['m_nMuzzleFlashParity', D.int(2)],
      ['m_bShouldIgnoreOffsetAndAccuracy', D.bool],
      ['m_flAnimTime', D.int(8)],
    ],
  },
  2: {
    name: 'CMomentumPistol',
    props: [
      ['m_bSimulatedEveryTick', D.bool],
      ['m_fEffects', D.int(15)],
      ['m_flNextPrimaryAttack', D.f32],
      ['m_flNextSecondaryAttack', D.f32],
      ['m_nNextThinkTick', D.int(32)],
      ['m_flTimeWeaponIdle', D.f32],
      ['m_nModelIndex', D.int(13)],
      ['m_hOwnerEntity', D.handle],
      ['moveparent', D.handle],
      ['m_iViewModelIndex', D.int(13)],
      ['m_iWorldModelIndex', D.int(13)],
      ['m_hOwner', D.handle],
      ['m_iState', D.int(2)],
      ['m_iClip1', D.int(8)],
      ['m_bBurstMode', D.bool],
    ],
  },
  10: {
    name: 'CKnife',
    props: [
      ['m_bSimulatedEveryTick', D.bool],
      ['m_fEffects', D.int(15)],
      ['m_flNextPrimaryAttack', D.f32],
      ['m_flNextSecondaryAttack', D.f32],
      ['m_nNextThinkTick', D.int(32)],
      ['m_flTimeWeaponIdle', D.f32],
      ['m_nModelIndex', D.int(13)],
      ['m_hOwnerEntity', D.handle],
      ['moveparent', D.handle],
      ['m_iViewModelIndex', D.int(13)],
      ['m_iWorldModelIndex', D.int(13)],
      ['m_hOwner', D.handle],
      ['m_iState', D.int(2)],
      ['m_iClip1', D.int(8)],
      ['m_flSmackTime', D.f32],
    ],
  },
  31: {
    name: 'CMomentumZoneRegion',
    props: [
      ['m_trackIds', 'ARRAY_UNKNOWN'],
      ['m_renderMode', D.int(8)],
      ['m_bCanSwitchPrimaryTimer', D.bool],
      ['m_renderPoints', 'ARRAY_UNKNOWN'],
      ['m_flRenderBottom', D.f32],
      ['m_flRenderHeight', D.f32],
      ['m_flRenderSafeHeight', D.f32],
      ['m_vecMinsPreScaled', D.vec3f32],
      ['m_vecMaxsPreScaled', D.vec3f32],
    ],
  },
  35: {
    name: 'CFuncBrush',
    props: [
      ['m_bSimulatedEveryTick', D.bool],
      ['m_fEffects', D.int(15)],
      ['m_cellbits', D.int(5)],
      ['m_cellX', D.int(12)],
      ['m_cellY', D.int(12)],
      ['m_cellZ', D.int(12)],
      ['m_vecOrigin', D.cellVec],
      ['m_nModelIndex', D.int(13)],
      ['m_nRenderMode', D.int(8)],
      ['m_clrRender', D.int(32)],
      ['m_angRotation', D.ang13x3],
    ],
  },
};

// locate the baseline section (same walk as dump-body)
function sectionOffsets() {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let pos = 0;
  const count = view.getUint32(0, true);
  pos = 4 + count * 18;
  // class table
  for (let c = 0; c < 6; c++) {
    pos += 1;
    while (body[pos] !== 0) pos++;
    pos++;
    const propCount = body[pos++];
    for (let p = 0; p < propCount; p++) {
      while (body[pos] !== 0) pos++;
      pos++;
    }
  }
  for (let s = 0; s < 3; s++) {
    pos += 2;
    while (body[pos] !== 0) pos++;
    pos++;
  }
  const geSize = view.getUint32(pos, true);
  pos += 4 + geSize;
  const blSize = view.getUint32(pos, true);
  return { baselines: pos + 4, end: pos + 4 + blSize };
}

const { baselines: SECTION_START, end: SECTION_END } = sectionOffsets();
const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

let pos = SECTION_START;
let ok = 0;
let fail = 0;
const failsByClass = {};
for (let rec = 0; rec < 198 && pos < SECTION_END; rec++) {
  pos += 4; // i32 tick, unused here
  let ent = 0;
  let shift = 0;
  for (;;) {
    const b = body[pos++];
    ent |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const r = new BitReader(body, pos);
  const classId = r.readUBitVar();
  const cls = CLASSES[classId];
  // find payload end: next record's tick+varint header, or section end
  let next = SECTION_END;
  for (let p = pos + 1; p < SECTION_END - 5; p++) {
    const t = view.getInt32(p, true);
    if (t === 275 || t === -2468) {
      let vp = p + 4;
      let v = 0;
      let sh = 0;
      for (let i = 0; i < 5; i++) {
        const b = body[vp++];
        v |= (b & 0x7f) << sh;
        if ((b & 0x80) === 0) break;
        sh += 7;
      }
      if (v === ent + 1) {
        next = p;
        break;
      }
    }
  }
  const payloadEndBit = next * 8;

  let status = 'skip';
  if (cls) {
    // header: 2 bits flags, then flagged time fields
    const fSim = r.readBit();
    const fAnim = r.readBit();
    const times = [];
    for (const f of [fSim, fAnim]) {
      if (f) times.push(TIME_MODE === 'ubitvar' ? r.readUBitVar() : r.readBits(8));
    }
    const values = {};
    let bad = null;
    let lastIdx = -1;
    while (payloadEndBit - r.bitPos >= 8) {
      const idx = r.readBits(5);
      if (idx <= lastIdx || idx >= cls.props.length) {
        bad = `index ${idx} after ${lastIdx} at bit ${r.bitPos - 5 - pos * 8}`;
        break;
      }
      lastIdx = idx;
      const [name, dec] = cls.props[idx];
      if (dec === 'ARRAY_UNKNOWN') {
        bad = `array prop ${name}`;
        break;
      }
      values[name] = dec(r);
    }
    if (!bad) {
      const pad = payloadEndBit - r.bitPos;
      let padZero = true;
      for (let b = r.bitPos; b < payloadEndBit; b++) {
        const byte = body[b >> 3];
        if ((byte >> (b & 7)) & 1) padZero = false;
      }
      if (pad >= 0 && pad < 8 && padZero) {
        status = 'OK';
        ok++;
      } else {
        status = `BAD pad=${pad} zero=${padZero}`;
        fail++;
        failsByClass[cls.name] = (failsByClass[cls.name] ?? 0) + 1;
      }
      if (rec < 4 || (status.startsWith('BAD') && (failsByClass[cls.name] ?? 0) <= 1)) {
        console.log(
          `[${rec}] ${cls.name} flags=(${fSim},${fAnim}) times=${JSON.stringify(times)} ${status}`,
        );
        if (rec < 4) {
          for (const [k, v] of Object.entries(values).slice(0, 18)) {
            console.log(`    ${k} = ${JSON.stringify(v)}`);
          }
        }
      }
    } else {
      status = 'BAD: ' + bad;
      fail++;
      failsByClass[cls.name] = (failsByClass[cls.name] ?? 0) + 1;
      if ((failsByClass[cls.name] ?? 0) <= 2) {
        console.log(
          `[${rec}] ${cls.name} flags=(${fSim},${fAnim}) times=${JSON.stringify(times)} ${status}`,
        );
        for (const [k, v] of Object.entries(values).slice(0, 20))
          console.log(`    ${k} = ${JSON.stringify(v)}`);
      }
    }
  }
  pos = next;
}
console.log(
  `\nhandleBits=${HANDLE_BITS} timeMode=${TIME_MODE}: OK=${ok} FAIL=${fail}`,
  failsByClass,
);
