// Measures frame location quality under different candidate filters, across
// every sample available, so a change can be judged on data rather than on
// one replay.
import { readFileSync, existsSync } from 'node:fs';
import { BitReader, parseReplay } from '../../packages/mtv/dist/index.js';

const FILES = [
  'fixtures/bhop_eazy.mtv',
  'fixtures/bhop_badwater.momtv',
  'tools/out/samples/agtricks.momtv',
  'tools/out/samples/ab_baume.momtv',
  'tools/out/samples/df_cruton_Enterprise CVN-80_0m56.125s.momtv',
  'tools/out/samples/deathrun_unique_caixa_0m21.095s.momtv',
  'tools/out/samples/df_waluigi_pinball_caixa_0m18.385s.momtv',
].filter((f) => existsSync(`D:/Projects/momtv.js/${f}`));

const WIDTHS = {
  m_bSimulatedEveryTick: 1,
  m_fEffects: 15,
  m_vecOrigin: 64,
  'm_vecOrigin[2]': 32,
  m_vecMinsPreScaled: 96,
  m_vecMaxsPreScaled: 96,
  m_nModelIndex: 13,
  m_nBody: 32,
  m_clrModelPrimary: 32,
  m_clrModelSecondary: 32,
  m_angRotation: 39,
  m_fFlags: 11,
  'm_angEyeAngles[0]': 11,
  'm_angEyeAngles[1]': 11,
  m_bClientSideAnimation: 1,
  m_ubEFNoInterpParity: 2,
  'm_vecViewOffset[0]': 8,
  'm_vecViewOffset[1]': 8,
  'm_vecViewOffset[2]': 10,
  m_hViewModel: 23,
  'm_vecVelocity[0]': 32,
  'm_vecVelocity[1]': 32,
  'm_vecVelocity[2]': 32,
  m_flGroundPositionZ: 32,
  m_nPhysicalButtons: 32,
  m_afButtonDisabled: 32,
  m_afButtonForced: 32,
  m_nButtonsToggled: 32,
  m_iLandTick: 32,
  m_iJumpTick: 32,
  m_iEarlyJumpTiming: 32,
  m_hActiveWeapon: 23,
  m_hPrimaryTimer: 23,
  m_dropTeleportState: 4,
  wishVel: 64,
  'wishVel[2]': 32,
  moveStatus: 8,
  acceleration: 32,
  maxspeed: 32,
  friction: 32,
  hasteEndTick: 32,
  damageBoostEndTick: 32,
  slickEndTick: 32,
  flightEndTick: 32,
  defragTimerEndTick: 32,
  defragTimerFlags: 8,
  m_bCanAirJump: 1,
  m_bRefreshAirJumpOnLand: 1,
};

const dv = new DataView(new ArrayBuffer(4));

function analyse(path, opts) {
  const replay = parseReplay(new Uint8Array(readFileSync(path)));
  const body = replay.body;
  const bytes = body.bytes;
  const base = body.frameData.offset;
  const dataLen = body.frameData.length;
  const propBits = replay.header.propBits;
  const listThenValues = body.revision === 2;
  const playerClass = body.classes.find((c) => c.name === 'CMomentumPlayer');
  const props = playerClass.props;

  const parse = (off) => {
    if (off < 0 || off >= dataLen - 1) return null;
    const r = new BitReader(bytes, base + off, dataLen - off);
    try {
      const a = r.readBits(6);
      if (a === 0 || a > 60) return null;
      if (r.readUBitVar() !== 0) return null;
      if (r.readBits(2) !== 0) return null;
      const count = r.readUBitVar();
      if (count > props.length) return null;
      if (count < opts.minProps) return null;
      const names = [];
      const read = (name) => {
        const w = WIDTHS[name];
        if (w === undefined) throw new Error('unknown prop');
        if (w === 64) {
          for (const _ of [0, 1]) {
            dv.setUint32(0, r.readBits(32), true);
            const f = dv.getFloat32(0, true);
            if (!Number.isFinite(f) || Math.abs(f) > 65536) throw new Error('bad float');
          }
        } else if (w === 96) {
          r.readBits(32);
          r.readBits(32);
          r.readBits(32);
        } else if (w === 39) {
          r.readBits(13);
          r.readBits(13);
          r.readBits(13);
        } else if (w === 32 && (name.includes('Origin') || name.includes('Velocity'))) {
          dv.setUint32(0, r.readBits(32), true);
          const f = dv.getFloat32(0, true);
          if (!Number.isFinite(f) || Math.abs(f) > 65536) throw new Error('bad float');
        } else {
          r.readBits(w);
        }
      };
      const idxs = [];
      for (let i = 0; i < count; i++) {
        const idx = r.readBits(propBits);
        if (idx >= props.length) return null;
        idxs.push(idx);
        names.push(props[idx]);
      }
      if (listThenValues) {
        for (const n of names) read(n);
      } else {
        r.bitPos -= count * propBits;
        for (let i = 0; i < count; i++) {
          const idx = r.readBits(propBits);
          read(props[idx]);
        }
      }
      if (
        opts.requireCore &&
        !names.includes('m_vecOrigin') &&
        !names.includes('m_vecVelocity[0]')
      ) {
        return null;
      }
      return { names, end: Math.ceil(r.bitPos / 8) - base };
    } catch {
      return null;
    }
  };

  const scan = (from, limit) => {
    for (let b = from; b < Math.min(from + limit, dataLen - 1); b++) {
      if ((bytes[base + b] & 0xc0) !== 0) continue;
      if ((bytes[base + b + 1] & 0x3f) !== 0) continue;
      const p = parse(b);
      if (p) {
        if (!opts.chain) return b;
        // a real frame is followed by another one soon after
        for (let c = p.end; c < Math.min(p.end + 400, dataLen - 1); c++) {
          if ((bytes[base + c] & 0xc0) !== 0) continue;
          if ((bytes[base + c + 1] & 0x3f) !== 0) continue;
          if (parse(c)) return b;
        }
      }
    }
    return -1;
  };

  const anchors = new Map();
  for (const k of body.keyframeIndex) {
    if (k.frameOffset >= 0 && k.frameOffset < dataLen) anchors.set(k.tick + 1, k.frameOffset);
  }

  let offset = 0;
  let lost = 0;
  let anchorHits = 0;
  let anchorMiss = 0;
  const originBits = [];
  for (let tick = 0; tick < replay.frameCount; tick++) {
    const anchored = anchors.get(tick);
    if (anchored !== undefined) {
      if (anchored === offset) anchorHits++;
      else anchorMiss++;
      offset = anchored;
    }
    let p = parse(offset);
    if (!p) {
      const rescue = scan(offset + 1, 600);
      if (rescue !== -1) {
        p = parse(rescue);
        offset = rescue;
      }
    }
    if (!p) lost++;
    originBits.push(p ? p.names.includes('m_vecOrigin') : false);
    const next = anchors.get(tick + 1) ?? scan(p ? p.end : offset + 1, 600);
    if (next === -1) {
      lost += replay.frameCount - tick - 1;
      break;
    }
    offset = next;
  }
  return {
    lost,
    anchorHits,
    anchorMiss,
    total: replay.frameCount,
    withOrigin: originBits.filter(Boolean).length,
  };
}

const variants = [
  { name: 'current (minProps 0)', minProps: 0, requireCore: false, chain: false },
  { name: 'minProps 1', minProps: 1, requireCore: false, chain: false },
  { name: 'minProps 1 + chain', minProps: 1, requireCore: false, chain: true },
  { name: 'requireCore', minProps: 1, requireCore: true, chain: false },
  { name: 'requireCore + chain', minProps: 1, requireCore: true, chain: true },
];

for (const v of variants) {
  console.log(`\n-- ${v.name}`);
  for (const f of FILES) {
    const path = `D:/Projects/momtv.js/${f}`;
    try {
      const r = analyse(path, v);
      console.log(
        `   ${f.split('/').pop().slice(0, 22).padEnd(23)} lost ${String(r.lost).padStart(4)}/${r.total}  anchors ${r.anchorHits}ok/${r.anchorMiss}miss  frames with position ${((100 * r.withOrigin) / r.total).toFixed(0)}%`,
      );
    } catch (e) {
      console.log(
        `   ${f.split('/').pop().slice(0, 22).padEnd(23)} ERROR ${e.message.slice(0, 40)}`,
      );
    }
  }
}
