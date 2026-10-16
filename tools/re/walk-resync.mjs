// Walks the frames with the exact grammar and, when a frame will not decode,
// looks for the next position that does and carries on. The point is to
// measure how much of a replay the grammar already covers and where the gaps
// are, rather than to guess at frames.
//
// Usage: node tools/re/walk-resync.mjs [replay...]
import { readFileSync } from 'node:fs';
import { FrameReader, parseReplay } from '../../packages/mtv/dist/index.js';

const files = process.argv.slice(2);
const replays = files.length
  ? files
  : [
      'testbed/public/replays/agtricks.momtv',
      'testbed/public/replays/ab_baume.momtv',
      'testbed/public/replays/df_cruton.momtv',
      'testbed/public/replays/bhop_badwater.momtv',
    ];

/** How many frames in a row have to decode for a position to be accepted. */
const CONFIRM = 3;
/** How far ahead to look for the next frame. */
const SEARCH_BITS = 8192;

for (const path of replays) {
  const replay = parseReplay(new Uint8Array(readFileSync(path)));
  const body = replay.body;
  const make = () => {
    const reader = new FrameReader(body, replay.header.propBits);
    reader.seedFromKeyframe();
    return reader;
  };
  const anchors = new Map(
    body.keyframeIndex.filter((k) => k.frameOffset >= 0).map((k) => [k.tick, k.frameOffset]),
  );

  const reader = make();
  let decoded = 0;
  let resyncs = 0;
  let lost = 0;
  let anchorsHit = 0;
  let positions = 0;

  for (let tick = 0; tick < replay.frameCount; tick++) {
    const anchor = anchors.get(tick);
    if (anchor !== undefined) {
      if (reader.bitPos === anchor * 8) anchorsHit++;
      else reader.seekBit(anchor * 8); // the index is authoritative
    }
    const at = reader.bitPos;
    try {
      reader.readFrame();
      decoded++;
      continue;
    } catch {
      /* fall through to the search */
    }
    // Look for the next position where several frames decode in a row.
    let found = -1;
    for (let bit = at + 1; bit < Math.min(at + SEARCH_BITS, reader.totalBits - 16); bit++) {
      const probe = make();
      probe.seekBit(bit);
      let ok = 0;
      try {
        for (; ok < CONFIRM; ok++) probe.readFrame();
      } catch {
        /* not a frame start */
      }
      if (ok === CONFIRM) {
        found = bit;
        break;
      }
    }
    if (found < 0) {
      lost++;
      break;
    }
    reader.seekBit(found);
    resyncs++;
    positions += found - at;
  }

  console.log(
    `${path.split('/').pop().padEnd(26)} decoded ${decoded}/${replay.frameCount} frames  ` +
      `resyncs ${resyncs}  anchors ${anchorsHit}/${anchors.size}` +
      (lost ? `  gave up after frame ${decoded}` : ''),
  );
}
