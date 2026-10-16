import type { ReplayBody } from './body-sections.js';
import {
  type Frame,
  FrameReader,
  type FrameReaderOptions,
  type SlotEntity,
} from './frame-reader.js';
import type { DecodeStats } from './player-track.js';

/**
 * Walks a revision 2 body tick by tick.
 *
 * Every frame is read in full, so a tick's state comes from the bits the
 * recorder wrote for it rather than from a search. The keyframe index is used
 * to resynchronise: it records, for a keyframe at tick T, where the frame for
 * T + 1 starts, and those ticks are the zone events, which is where the run
 * timer sends the properties this parser cannot size yet. So the one place a
 * walk can lose its footing is also the one place the file says where to
 * continue from.
 *
 * A tick whose frame will not decode is reported with no frame, and the count
 * of those is in the statistics rather than hidden.
 *
 * @param body - parsed body sections
 * @param frameCount - ticks the header declares
 * @param propBits - bits a property index takes, from the header
 * @param options - which properties the reader should keep
 * @param visit - called once per tick, in order
 * @param seeded - called once with what the keyframe says each slot holds,
 * before the first tick
 */
export function walkFrames(
  body: ReplayBody,
  frameCount: number,
  propBits: number,
  options: FrameReaderOptions,
  visit: (tick: number, frame: Frame | undefined) => void,
  seeded?: (slots: Map<number, SlotEntity>) => void,
): DecodeStats {
  const reader = new FrameReader(body, propBits, options);
  reader.seedFromKeyframe();
  seeded?.(reader.slotEntities());

  // For a keyframe at tick T the index records where the frame for T + 1
  // starts, since playback reads the keyframe and the next frame advances the
  // tick.
  const anchors = new Map<number, number>();
  for (const entry of body.keyframeIndex) {
    if (entry.frameOffset >= 0) anchors.set(entry.tick + 1, entry.frameOffset);
  }

  const stats: DecodeStats = { frames: 0, resyncs: 0, recovered: 0, lostFrames: 0 };
  let adrift = false;
  for (let tick = 0; tick < frameCount; tick++) {
    const anchor = anchors.get(tick);
    if (anchor !== undefined && (adrift || reader.bitPos !== anchor * 8)) {
      reader.seekBit(anchor * 8);
      if (adrift) stats.recovered++;
      else stats.resyncs++;
      adrift = false;
    }
    let frame: Frame | undefined;
    if (!adrift) {
      try {
        frame = reader.readFrame();
        stats.frames++;
      } catch {
        // The frame cannot be read, so hold until the next anchor rather than
        // guess at the bits.
        adrift = true;
      }
    }
    if (adrift) stats.lostFrames++;
    visit(tick, frame);
  }
  return stats;
}
