/**
 * Reader for the static prop list a map carries in its game lump.
 *
 * The lump names the models the map uses and then places them: an origin, a
 * set of angles, which model, and from Strata Source also a scale. Its layout
 * grew over the years, so the stride of one placement is taken from the lump
 * itself (the count is written down, and the records fill what remains) rather
 * than from a table of versions.
 */
import { lzmaDecompress, VALVE_LZMA_ID } from '@caixax/mtv';

/** The game lump that holds the static props, as four characters. */
const SPRP = 0x73707270;

/** Bytes one model path takes in the lump's dictionary. */
const NAME_SIZE = 128;

/** One placed prop. */
export interface StaticProp {
  /** Path of the model, as the map spells it. */
  model: string;
  origin: [number, number, number];
  /** Pitch, yaw and roll, in degrees. */
  angles: [number, number, number];
  /** Per axis scale; 1 for the versions that cannot scale a prop. */
  scale: [number, number, number];
  /** Skin to use of the model's skin families. */
  skin: number;
}

/** What the game lump holds, when it holds props. */
export interface StaticProps {
  version: number;
  /** Every model the map places, whether used or not. */
  models: string[];
  props: StaticProp[];
}

const decoder = new TextDecoder('latin1');

/** Undoes the compression the game lump may be stored with. */
function inflate(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 17) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== VALVE_LZMA_ID) return bytes;
  const actual = view.getUint32(4, true);
  if (actual > 256 * 1024 * 1024) throw new Error(`a game lump declares ${actual} bytes`);
  return lzmaDecompress(bytes.subarray(12, 17), bytes.subarray(17), actual);
}

/**
 * Reads the static props of a map.
 *
 * @param gameLump - the whole game lump of the file
 * @param fileBytes - the file itself, since the game lump's entries point into
 * it with absolute offsets
 * @returns the props, or undefined when the map places none
 */
export function readStaticProps(
  gameLump: Uint8Array,
  fileBytes: Uint8Array,
): StaticProps | undefined {
  if (gameLump.length < 4) return undefined;
  const view = new DataView(gameLump.buffer, gameLump.byteOffset, gameLump.byteLength);
  const count = view.getInt32(0, true);
  if (count < 0 || count > 64 || 4 + count * 16 > gameLump.length) return undefined;

  for (let i = 0; i < count; i++) {
    const at = 4 + i * 16;
    if (view.getInt32(at, true) !== SPRP) continue;
    const version = view.getUint16(at + 6, true);
    const offset = view.getInt32(at + 8, true);
    const length = view.getInt32(at + 12, true);
    if (length <= 8 || offset < 0 || offset + length > fileBytes.length) return undefined;
    const body = inflate(fileBytes.subarray(offset, offset + length));
    return readSprp(body, version);
  }
  return undefined;
}

/** Reads the static prop lump itself, once it is whole. */
function readSprp(body: Uint8Array, version: number): StaticProps | undefined {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const modelCount = view.getInt32(0, true);
  if (modelCount < 0 || 4 + modelCount * NAME_SIZE + 8 > body.length) return undefined;
  const models: string[] = [];
  for (let i = 0; i < modelCount; i++) {
    const at = 4 + i * NAME_SIZE;
    const raw = decoder.decode(body.subarray(at, at + NAME_SIZE));
    const end = raw.indexOf('\0');
    models.push((end >= 0 ? raw.slice(0, end) : raw).replace(/\\/g, '/').toLowerCase());
  }

  const leafAt = 4 + modelCount * NAME_SIZE;
  const leafCount = view.getInt32(leafAt, true);
  if (leafCount < 0) return undefined;

  // The leaf list is sixteen bits a time in the older versions and thirty two
  // in Strata Source's, so take whichever leaves records that fit exactly.
  for (const leafSize of [2, 4]) {
    const countAt = leafAt + 4 + leafCount * leafSize;
    if (countAt + 4 > body.length) continue;
    const propCount = view.getInt32(countAt, true);
    if (propCount <= 0 || propCount > 200000) continue;
    const rest = body.length - countAt - 4;
    if (rest % propCount !== 0) continue;
    const stride = rest / propCount;
    if (stride < 56 || stride > 256) continue;
    const props = readProps(view, countAt + 4, propCount, stride, models, version);
    if (props) return { version, models, props };
  }
  return undefined;
}

/** Reads the placements, checking that they make sense before accepting them. */
function readProps(
  view: DataView,
  at: number,
  count: number,
  stride: number,
  models: readonly string[],
  version: number,
): StaticProp[] | undefined {
  const props: StaticProp[] = [];
  for (let i = 0; i < count; i++) {
    const o = at + i * stride;
    const origin: [number, number, number] = [
      view.getFloat32(o, true),
      view.getFloat32(o + 4, true),
      view.getFloat32(o + 8, true),
    ];
    const angles: [number, number, number] = [
      view.getFloat32(o + 12, true),
      view.getFloat32(o + 16, true),
      view.getFloat32(o + 20, true),
    ];
    const type = view.getUint16(o + 24, true);
    if (type >= models.length) return undefined;
    if (![...origin, ...angles].every((v) => Number.isFinite(v))) return undefined;
    if (angles.some((v) => Math.abs(v) > 3600)) return undefined;
    // Strata Source added a scale per axis at the end of the record.
    let scale: [number, number, number] = [1, 1, 1];
    if (version >= 13 && stride >= 88) {
      const read = [
        view.getFloat32(o + stride - 12, true),
        view.getFloat32(o + stride - 8, true),
        view.getFloat32(o + stride - 4, true),
      ];
      if (read.every((v) => Number.isFinite(v) && v > 0.0001 && v < 1000)) {
        scale = [read[0]!, read[1]!, read[2]!];
      }
    }
    props.push({
      model: models[type]!,
      origin,
      angles,
      scale,
      skin: stride >= 36 ? view.getInt32(o + 32, true) : 0,
    });
  }
  return props;
}
