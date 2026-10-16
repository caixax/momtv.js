/**
 * Enum values mirror the constants used by Momentum Mod
 * (momentum-mod/website, libs/constants, MIT).
 */

/** Momentum Mod gamemode. */
export enum Gamemode {
  Surf = 1,
  Bhop = 2,
  BhopHl1 = 3,
  ClimbMom = 4,
  ClimbKzt = 5,
  Climb16 = 6,
  RocketJump = 7,
  StickyJump = 8,
  Ahop = 9,
  Conc = 10,
  DefragCpm = 11,
  DefragVq3 = 12,
  DefragVtg = 13,
}

/** Which track of the map the run was made on. */
export enum TrackType {
  Main = 0,
  Stage = 1,
  Bonus = 2,
}

/** Run style (modifier applied to the gamemode). */
export enum Style {
  Normal = 0,
  BhopHalfSideways = 1,
  SurfHalfSideways = 2,
  Sideways = 3,
  WOnly = 4,
  AdOnly = 5,
  SOnly = 6,
  Backwards = 7,
  Pro = 8,
  Teleport = 9,
}

/** Human readable names for {@link Gamemode} values. */
export const GamemodeName: Readonly<Record<Gamemode, string>> = {
  [Gamemode.Surf]: 'Surf',
  [Gamemode.Bhop]: 'Bhop',
  [Gamemode.BhopHl1]: 'Bhop (HL1)',
  [Gamemode.ClimbMom]: 'Climb (Momentum)',
  [Gamemode.ClimbKzt]: 'Climb (KZTimer)',
  [Gamemode.Climb16]: 'Climb (1.6)',
  [Gamemode.RocketJump]: 'Rocket Jump',
  [Gamemode.StickyJump]: 'Sticky Jump',
  [Gamemode.Ahop]: 'Ahop',
  [Gamemode.Conc]: 'Conc',
  [Gamemode.DefragCpm]: 'Defrag (CPM)',
  [Gamemode.DefragVq3]: 'Defrag (VQ3)',
  [Gamemode.DefragVtg]: 'Defrag (Vintage)',
};

/** Human readable names for {@link TrackType} values. */
export const TrackTypeName: Readonly<Record<TrackType, string>> = {
  [TrackType.Main]: 'Main',
  [TrackType.Stage]: 'Stage',
  [TrackType.Bonus]: 'Bonus',
};

/** Human readable names for {@link Style} values. */
export const StyleName: Readonly<Record<Style, string>> = {
  [Style.Normal]: 'Normal',
  [Style.BhopHalfSideways]: 'Half-Sideways',
  [Style.SurfHalfSideways]: 'Half-Sideways',
  [Style.Sideways]: 'Sideways',
  [Style.WOnly]: 'W-Only',
  [Style.AdOnly]: 'A/D-Only',
  [Style.SOnly]: 'S-Only',
  [Style.Backwards]: 'Backwards',
  [Style.Pro]: 'Pro',
  [Style.Teleport]: 'Teleport',
};

/** Compression type declared in the replay header. */
export enum ReplayCompression {
  None = 0,
  Lzma = 1,
}

/**
 * Button bits of `m_nPhysicalButtons`, as the engine numbers them.
 *
 * Confirmed against recorded runs: in a bhop replay the jump bit is held or
 * tapped on 98 percent of ticks and the two strafe bits alternate at close to
 * half each, which is what bunny hopping looks like.
 */
export enum Button {
  Attack = 1 << 0,
  Jump = 1 << 1,
  Duck = 1 << 2,
  Forward = 1 << 3,
  Back = 1 << 4,
  Use = 1 << 5,
  Cancel = 1 << 6,
  Left = 1 << 7,
  Right = 1 << 8,
  MoveLeft = 1 << 9,
  MoveRight = 1 << 10,
  Attack2 = 1 << 11,
  Run = 1 << 12,
  Reload = 1 << 13,
  Alt1 = 1 << 14,
  Alt2 = 1 << 15,
  Score = 1 << 16,
  Speed = 1 << 17,
  Walk = 1 << 18,
  Zoom = 1 << 19,
}
