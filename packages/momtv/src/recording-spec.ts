// Read from the game engine: the recorder's list of the classes it follows,
// and for each property how the replay writes it on top of the network
// encoding. Only the properties whose mode changes the bits are listed; every
// other property is written exactly as the network tables encode it.

/**
 * How the recorder writes one property, on top of its network encoding.
 *
 * - `TimeRelative`: one bit first, saying the value is relative to the time
 *   of the tick it was recorded on; then the value.
 * - `TickRelative`: one bit first, saying the value is relative to the tick it
 *   was recorded on; then the value.
 * - `Deferred`: a varint first, how many ticks back the value applies; then
 *   the value.
 * - `ModelIndex`: 32 raw bits naming the model, in place of the network
 *   encoding, since a model index means nothing outside the session that
 *   recorded it.
 */
export const RecordMode = {
  Plain: 0,
  Handle: 1,
  TimeRelative: 2,
  TickRelative: 3,
  Deferred: 4,
  ModelIndex: 5,
} as const;

export type RecordMode = (typeof RecordMode)[keyof typeof RecordMode];

/** The recording modes of the properties that have one, by class. */
export const RECORD_MODES: Record<string, Record<string, RecordMode>> = {
  CMomentumPlayer: {
    m_nModelIndex: 5,
    m_iLandTick: 3,
    m_iJumpTick: 3,
    hasteEndTick: 3,
    damageBoostEndTick: 3,
    slickEndTick: 3,
    flightEndTick: 3,
    defragTimerEndTick: 3,
  },
  CMomentumViewModel: { m_nModelIndex: 5, m_nSequence: 4 },
  CMomentumGrenade: { m_nNextThinkTick: 3, m_nModelIndex: 5, m_fThrowTime: 2 },
  CMomentumConcGrenade: {
    m_nNextThinkTick: 3,
    m_nModelIndex: 5,
    m_flThrowTime: 2,
    m_flTimer: 2,
  },
  CMomConcProjectile: { m_flDetonateTime: 2 },
  CMomentumKnife: { m_nNextThinkTick: 3, m_nModelIndex: 5, m_flSmackTime: 2 },
  CMomentumStickybombLauncher: { m_nNextThinkTick: 3, m_nModelIndex: 5, m_iChargeBeginTick: 3 },
  CMomStickybomb: { m_iCreateTick: 3 },
  CEntityDissolve: { m_nModelIndex: 5, m_flStartTime: 2 },
  CSpriteTrail: { m_nModelIndex: 5 },
  CMomentumTimerInstance: { m_dNetworkRunTime: 4 },
};

/**
 * Classes whose weapons all share the same modes: the next think tick is tick
 * relative and the model index is written raw.
 */
const WEAPONS = [
  'CMomentumPistol',
  'CMomentumShotgun',
  'CMomentumMachinegun',
  'CMomentumSniper',
  'CMomentumRocketLauncher',
  'CMomentumDFPlasmaGun',
  'CMomentumDFRocketLauncher',
  'CMomentumDFBFG',
  'CMomentumDFGrenadeLauncher',
  'CMomentumDFMachineGun',
  'CMomentumDFRailGun',
  'CMomentumDFLightningGun',
  'CMomentumDFShotgun',
  'CMomentumDFKnife',
];
for (const name of WEAPONS) RECORD_MODES[name] = { m_nNextThinkTick: 3, m_nModelIndex: 5 };

/** Map entities: only the model index is written differently. */
const MAP_ENTITIES = [
  'CMomPickup',
  'CBaseDoor',
  'CBaseButton',
  'CFuncBrush',
  'CFuncMoveLinear',
  'CFuncRotating',
  'CBaseToggle',
];
for (const name of MAP_ENTITIES) RECORD_MODES[name] = { m_nModelIndex: 5 };

/**
 * Properties whose mode does not depend on the class, for classes an older or
 * newer build records that this table does not name.
 */
const ANY_CLASS: Record<string, RecordMode> = {
  m_nModelIndex: 5,
  m_nNextThinkTick: 3,
  m_iLandTick: 3,
  m_iJumpTick: 3,
  hasteEndTick: 3,
  damageBoostEndTick: 3,
  slickEndTick: 3,
  flightEndTick: 3,
  defragTimerEndTick: 3,
  m_dNetworkRunTime: 4,
};

/** The recording mode of one property of one class. */
export function recordModeOf(className: string, propName: string): RecordMode {
  const known = RECORD_MODES[className];
  if (known) return known[propName] ?? RecordMode.Plain;
  return ANY_CLASS[propName] ?? RecordMode.Plain;
}
