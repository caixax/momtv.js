// Walks the frame data with the exact grammar and checks it against the only
// ground truth the file carries: the keyframe index, which pins known ticks to
// known byte offsets, and the frame count in the header.
//
// Usage: node tools/re/walk-frames.mjs [replay...]
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
      'testbed/public/replays/deathrun_unique.momtv',
      'testbed/public/replays/df_waluigi_pinball.momtv',
      'fixtures/bhop_eazy.mtv',
    ];

for (const path of replays) {
  const replay = parseReplay(new Uint8Array(readFileSync(path)));
  const body = replay.body;
  const anchors = body.keyframeIndex.filter((k) => k.frameOffset >= 0);
  const byOffset = new Map(anchors.map((k) => [k.frameOffset, k.tick]));

  const reader = new FrameReader(body, replay.header.propBits);
  // Playback starts from the first keyframe, which is what names the entities.
  reader.seedFromKeyframe();

  let frames = 0;
  let hits = 0;
  let failure = null;
  while (reader.bitPos < reader.totalBits - 8 && frames < replay.frameCount) {
    const at = reader.bitPos;
    if (at % 8 === 0 && byOffset.has(at / 8)) hits++;
    try {
      reader.readFrame();
    } catch (error) {
      failure = `frame ${frames} at bit ${at}: ${error.message}`;
      break;
    }
    frames++;
  }
  console.log(
    `${path.split('/').pop().padEnd(26)} frames ${frames}/${replay.frameCount}  ` +
      `bits ${reader.bitPos}/${reader.totalBits}  anchors ${hits}/${anchors.length}` +
      (failure ? `\n    ${failure}` : '  walked clean'),
  );
}
