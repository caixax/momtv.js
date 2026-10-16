/**
 * Decoder for BC7 (BPTC) block compressed textures.
 *
 * Strata Source stores newer textures in this format: Momentum's own model
 * textures and several of its skies. A block is sixteen bytes covering four by
 * four pixels, and the format packs eight different ways of splitting those
 * sixteen pixels into one, two or three groups, each with its own pair of
 * endpoints to interpolate between.
 *
 * Written from the format's published description.
 */

/** What each of the eight modes carries. */
interface Bc7Mode {
  /** Groups the sixteen pixels are split into. */
  subsets: number;
  /** Bits naming which split is used. */
  partitionBits: number;
  /** Bits naming which channel swaps with alpha. */
  rotationBits: number;
  /** A bit saying which index set colours and which one alphas. */
  indexSelectionBits: number;
  colourBits: number;
  alphaBits: number;
  /** A rounding bit per endpoint. */
  endpointPBits: number;
  /** A rounding bit per subset, shared by both its endpoints. */
  sharedPBits: number;
  indexBits: number;
  /** Bits of the second index set, for the modes that have one. */
  indexBits2: number;
}

const MODES: Bc7Mode[] = [
  {
    subsets: 3,
    partitionBits: 4,
    rotationBits: 0,
    indexSelectionBits: 0,
    colourBits: 4,
    alphaBits: 0,
    endpointPBits: 1,
    sharedPBits: 0,
    indexBits: 3,
    indexBits2: 0,
  },
  {
    subsets: 2,
    partitionBits: 6,
    rotationBits: 0,
    indexSelectionBits: 0,
    colourBits: 6,
    alphaBits: 0,
    endpointPBits: 0,
    sharedPBits: 1,
    indexBits: 3,
    indexBits2: 0,
  },
  {
    subsets: 3,
    partitionBits: 6,
    rotationBits: 0,
    indexSelectionBits: 0,
    colourBits: 5,
    alphaBits: 0,
    endpointPBits: 0,
    sharedPBits: 0,
    indexBits: 2,
    indexBits2: 0,
  },
  {
    subsets: 2,
    partitionBits: 6,
    rotationBits: 0,
    indexSelectionBits: 0,
    colourBits: 7,
    alphaBits: 0,
    endpointPBits: 1,
    sharedPBits: 0,
    indexBits: 2,
    indexBits2: 0,
  },
  {
    subsets: 1,
    partitionBits: 0,
    rotationBits: 2,
    indexSelectionBits: 1,
    colourBits: 5,
    alphaBits: 6,
    endpointPBits: 0,
    sharedPBits: 0,
    indexBits: 2,
    indexBits2: 3,
  },
  {
    subsets: 1,
    partitionBits: 0,
    rotationBits: 2,
    indexSelectionBits: 0,
    colourBits: 7,
    alphaBits: 8,
    endpointPBits: 0,
    sharedPBits: 0,
    indexBits: 2,
    indexBits2: 2,
  },
  {
    subsets: 1,
    partitionBits: 0,
    rotationBits: 0,
    indexSelectionBits: 0,
    colourBits: 7,
    alphaBits: 7,
    endpointPBits: 1,
    sharedPBits: 0,
    indexBits: 4,
    indexBits2: 0,
  },
  {
    subsets: 2,
    partitionBits: 6,
    rotationBits: 0,
    indexSelectionBits: 0,
    colourBits: 5,
    alphaBits: 5,
    endpointPBits: 1,
    sharedPBits: 0,
    indexBits: 2,
    indexBits2: 0,
  },
];

/** How far along from one endpoint to the other each index sits, out of 64. */
const WEIGHTS_2 = [0, 21, 43, 64];
const WEIGHTS_3 = [0, 9, 18, 27, 37, 46, 55, 64];
const WEIGHTS_4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

/** Which group each of the sixteen pixels belongs to, for two groups. */
const PARTITION_2 = [
  0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0,
  1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 0, 0,
  0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0,
  1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0,
  0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0,
  1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
  0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0,
  1, 1, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0,
  0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1,
  0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
  0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0,
  0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1,
  0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 0,
  1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1,
  0, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1,
  0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1,
  0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1,
  0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1,
  0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1,
  1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1,
  0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0,
  0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1,
  1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0,
  1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1,
  1,
];

/** The same, for three groups. */
const PARTITION_3 = [
  0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 1, 2, 2, 2, 2, 0, 0, 0, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1, 0,
  0, 0, 0, 2, 0, 0, 1, 2, 2, 1, 1, 2, 2, 1, 1, 0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 1, 0, 1, 1, 1, 0, 0,
  0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 2,
  2, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 0, 0, 0, 0,
  0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1,
  1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 1, 1, 2, 0, 1,
  1, 2, 0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1, 0, 1, 1,
  2, 1, 1, 2, 2, 1, 2, 2, 2, 0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0, 2, 2, 2, 0, 0, 0, 0, 1, 0, 0, 1, 1,
  0, 1, 1, 2, 1, 1, 2, 2, 0, 1, 1, 1, 0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 1,
  1, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 2,
  2, 2, 0, 2, 2, 2, 0, 0, 0, 1, 0, 0, 0, 1, 2, 2, 2, 1, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 2,
  2, 0, 1, 2, 2, 0, 0, 0, 0, 1, 1, 0, 0, 2, 2, 1, 0, 2, 2, 1, 0, 0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1,
  0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 1, 2, 1, 1, 2, 2, 2, 2, 2, 2, 0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1, 0,
  1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1, 0, 0, 2, 2, 1, 1, 0, 2, 1, 1, 0, 2, 0, 0,
  2, 2, 0, 1, 1, 0, 0, 1, 1, 0, 2, 0, 0, 2, 2, 2, 2, 2, 0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1,
  1, 0, 0, 0, 0, 2, 0, 0, 0, 2, 2, 1, 1, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 2, 2, 2,
  0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 2, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 2, 0, 0, 2, 2, 0, 2, 2, 2, 0,
  1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 1,
  2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 0, 1, 2, 0, 2, 0, 1, 2, 1, 2, 0, 1, 0, 1, 2, 0, 0, 0, 1,
  1, 2, 2, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1,
  0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1, 0, 0, 2, 2, 1,
  1, 2, 2, 0, 0, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 1, 1, 0, 2, 2, 0, 1, 2,
  2, 1, 0, 2, 2, 0, 1, 2, 2, 1, 0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0, 1, 0, 1, 0, 0, 0, 0, 2, 1, 2,
  1, 2, 1, 2, 1, 2, 1, 2, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2, 0, 2, 2, 2, 0, 1, 1, 1,
  0, 2, 2, 2, 0, 1, 1, 1, 0, 0, 0, 2, 1, 1, 1, 2, 0, 0, 0, 2, 1, 1, 1, 2, 0, 0, 0, 0, 2, 1, 1, 2, 2,
  1, 1, 2, 2, 1, 1, 2, 0, 2, 2, 2, 0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2, 0, 0, 0, 2, 1, 1, 1, 2, 1, 1,
  1, 2, 0, 0, 0, 2, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1,
  2, 2, 1, 1, 2, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 1, 1,
  0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
  1, 1, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 2, 2, 2, 1, 2, 2, 2, 0, 2, 2, 2, 1, 2,
  2, 2, 0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 1, 1, 1, 2, 0, 1, 1, 2, 2, 0, 1, 2, 2, 2,
  0,
];

/** Where the second group's run of indices starts, for two groups. */
const ANCHOR_2 = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2,
  2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15,
  15, 15, 15, 15, 2, 2, 15,
];

/** Where the second and third groups start, for three groups. */
const ANCHOR_3_SECOND = [
  3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5,
  15, 15, 8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10,
  8, 13, 15, 12, 3, 3,
];
const ANCHOR_3_THIRD = [
  15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6,
  10, 15, 15, 10, 8, 15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15,
  15, 15, 15, 15, 15, 7, 15, 15, 15, 15,
];

/** Reads a block's bits, least significant first. */
class BlockBits {
  private at = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly start: number,
  ) {}

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const bit = this.at + i;
      const byte = this.data[this.start + (bit >> 3)] ?? 0;
      value |= ((byte >> (bit & 7)) & 1) << i;
    }
    this.at += count;
    return value;
  }
}

/** Stretches a value of `bits` bits to a full eight. */
function expand(value: number, bits: number): number {
  if (bits >= 8) return value & 0xff;
  return ((value << (8 - bits)) | (value >> (2 * bits - 8))) & 0xff;
}

/** Which group a pixel belongs to. */
function subsetOf(subsets: number, partition: number, pixel: number): number {
  if (subsets === 1) return 0;
  const table = subsets === 2 ? PARTITION_2 : PARTITION_3;
  return table[partition * 16 + pixel] ?? 0;
}

/** The pixel whose index is stored one bit short, for each group. */
function anchorOf(subsets: number, partition: number, subset: number): number {
  if (subset === 0) return 0;
  if (subsets === 2) return ANCHOR_2[partition] ?? 0;
  return (subset === 1 ? ANCHOR_3_SECOND[partition] : ANCHOR_3_THIRD[partition]) ?? 0;
}

/**
 * Decodes BC7 blocks into RGBA8.
 *
 * @param src - the block data
 * @param width - pixels across
 * @param height - pixels down
 */
export function decodeBc7(src: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  const colours = new Uint8Array(16 * 4);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const start = (by * blocksX + bx) * 16;
      if (start + 16 > src.length) break;
      decodeBlock(src, start, colours);
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) continue;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) continue;
          const from = (py * 4 + px) * 4;
          const to = (y * width + x) * 4;
          out[to] = colours[from]!;
          out[to + 1] = colours[from + 1]!;
          out[to + 2] = colours[from + 2]!;
          out[to + 3] = colours[from + 3]!;
        }
      }
    }
  }
  return out;
}

/** Decodes one block into sixteen RGBA pixels. */
function decodeBlock(src: Uint8Array, start: number, out: Uint8Array): void {
  const bits = new BlockBits(src, start);
  let mode = -1;
  for (let i = 0; i < 8; i++) {
    if (bits.read(1) === 1) {
      mode = i;
      break;
    }
  }
  // A block with no mode bit set is transparent black, as the format says.
  if (mode < 0) {
    out.fill(0);
    return;
  }
  const m = MODES[mode]!;

  const partition = m.partitionBits > 0 ? bits.read(m.partitionBits) : 0;
  const rotation = m.rotationBits > 0 ? bits.read(m.rotationBits) : 0;
  const indexSelection = m.indexSelectionBits > 0 ? bits.read(m.indexSelectionBits) : 0;

  // endpoints, one channel at a time
  const endpointCount = m.subsets * 2;
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const alpha: number[] = [];
  for (let i = 0; i < endpointCount; i++) red.push(bits.read(m.colourBits));
  for (let i = 0; i < endpointCount; i++) green.push(bits.read(m.colourBits));
  for (let i = 0; i < endpointCount; i++) blue.push(bits.read(m.colourBits));
  if (m.alphaBits > 0) {
    for (let i = 0; i < endpointCount; i++) alpha.push(bits.read(m.alphaBits));
  }

  // the rounding bits, which add one bit to every component they cover
  const pBits: number[] = [];
  if (m.endpointPBits > 0) {
    for (let i = 0; i < endpointCount; i++) pBits.push(bits.read(1));
  } else if (m.sharedPBits > 0) {
    for (let s = 0; s < m.subsets; s++) {
      const bit = bits.read(1);
      pBits.push(bit, bit);
    }
  }

  const colourBits = m.colourBits + (pBits.length > 0 ? 1 : 0);
  const alphaBits = m.alphaBits + (pBits.length > 0 && m.alphaBits > 0 ? 1 : 0);
  const ends = new Uint8Array(endpointCount * 4);
  for (let i = 0; i < endpointCount; i++) {
    const p = pBits[i] ?? 0;
    const withP = (value: number): number => (pBits.length > 0 ? (value << 1) | p : value);
    ends[i * 4] = expand(withP(red[i]!), colourBits);
    ends[i * 4 + 1] = expand(withP(green[i]!), colourBits);
    ends[i * 4 + 2] = expand(withP(blue[i]!), colourBits);
    ends[i * 4 + 3] = m.alphaBits > 0 ? expand(withP(alpha[i]!), alphaBits) : 255;
  }

  // the indices, with the anchor of each group one bit short
  const primary = new Uint8Array(16);
  for (let pixel = 0; pixel < 16; pixel++) {
    const subset = subsetOf(m.subsets, partition, pixel);
    const short = anchorOf(m.subsets, partition, subset) === pixel;
    primary[pixel] = bits.read(m.indexBits - (short ? 1 : 0));
  }
  const secondary = new Uint8Array(16);
  if (m.indexBits2 > 0) {
    for (let pixel = 0; pixel < 16; pixel++) {
      secondary[pixel] = bits.read(m.indexBits2 - (pixel === 0 ? 1 : 0));
    }
  }

  const weightsFor = (count: number): number[] =>
    count === 2 ? WEIGHTS_2 : count === 3 ? WEIGHTS_3 : WEIGHTS_4;
  const colourWeights = weightsFor(indexSelection === 1 ? m.indexBits2 : m.indexBits);
  const alphaWeights = weightsFor(
    m.indexBits2 === 0 ? m.indexBits : indexSelection === 1 ? m.indexBits : m.indexBits2,
  );

  for (let pixel = 0; pixel < 16; pixel++) {
    const subset = subsetOf(m.subsets, partition, pixel);
    const e0 = subset * 8;
    const e1 = e0 + 4;
    const colourIndex = indexSelection === 1 ? secondary[pixel]! : primary[pixel]!;
    const alphaIndex =
      m.indexBits2 === 0
        ? primary[pixel]!
        : indexSelection === 1
          ? primary[pixel]!
          : secondary[pixel]!;
    const cw = colourWeights[colourIndex] ?? 0;
    const aw = alphaWeights[alphaIndex] ?? 0;
    const mix = (a: number, b: number, w: number): number => ((64 - w) * a + w * b + 32) >> 6;
    let r = mix(ends[e0]!, ends[e1]!, cw);
    let g = mix(ends[e0 + 1]!, ends[e1 + 1]!, cw);
    let b = mix(ends[e0 + 2]!, ends[e1 + 2]!, cw);
    let a = mix(ends[e0 + 3]!, ends[e1 + 3]!, aw);
    // the rotation swaps alpha with one of the colour channels
    if (rotation === 1) [r, a] = [a, r];
    else if (rotation === 2) [g, a] = [a, g];
    else if (rotation === 3) [b, a] = [a, b];
    const at = pixel * 4;
    out[at] = r;
    out[at + 1] = g;
    out[at + 2] = b;
    out[at + 3] = a;
  }
}
