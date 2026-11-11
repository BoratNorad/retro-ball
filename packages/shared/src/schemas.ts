// Zod schemas for every data and config file. Everything is parsed through these at load time,
// so a bad import or a typo in a tuning file fails loudly instead of corrupting a game.
import { z } from "zod";

export const RatingKey = z.string().regex(/^[a-zA-Z]+$/);
export const Ratings = z.record(RatingKey, z.number().int().min(0).max(99));

/** A real player as imported from the Madden sheet + nflverse (tools/import/build_players.py). */
export const PlayerSchema = z.object({
  id: z.number().int(),
  first: z.string(),
  last: z.string(),
  team: z.string(),
  pos: z.string(),              // Madden position (HB, LEDG, SAM, ...)
  posName: z.string(),
  group: z.string(),
  side: z.enum(["O", "D", "S"]),
  num: z.number().int().nullable(),
  ovr: z.number().int().min(0).max(99),
  ovrDiff: z.number().int(),
  arch: z.string(),
  age: z.number().int(),
  bday: z.string(),
  htIn: z.number().int().min(60).max(90),
  wt: z.number().int().min(140).max(420),
  college: z.string(),
  yrs: z.number().int().min(0),
  hand: z.enum(["L", "R"]),
  runStyle: z.string(),
  stats: Ratings,
  statDiff: z.record(RatingKey, z.number().int()),
  abil: z.array(z.string()),
  gsis: z.string().nullable(),
  espn: z.number().int().nullable(),
  headshot: z.string().url().nullable(),
  draft: z.string(),
  depth: z.number().int().optional(),
  starter: z.string().optional(),
  dex: z.number().int(),
});
export type Player = z.infer<typeof PlayerSchema>;
export const PlayersFileSchema = z.object({ source: z.string(), players: z.array(PlayerSchema).min(1) });

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const TeamSchema = z.object({
  abbr: z.string(), name: z.string(), nick: z.string(), conf: z.string(), div: z.string(),
  c1: Hex, c2: Hex, c3: Hex,
  lineup: z.record(z.string(), z.number().int()),
  ovr: z.number(),
});
export type Team = z.infer<typeof TeamSchema>;
export const TeamsFileSchema = z.object({ teams: z.array(TeamSchema).length(32) });

export const MaddenAbilitiesFileSchema = z.object({
  abilities: z.array(z.object({ id: z.string(), name: z.string(), desc: z.string(), type: z.enum(["XF", "SS"]) })),
});

export const StatGroupsFileSchema = z.object({
  groups: z.array(z.object({ name: z.string(), stats: z.array(z.object({ key: RatingKey, short: z.string() })) })),
});

// ---------------------------------------------------------------- abilities
export const AbilityDefSchema = z.object({
  id: z.string(), name: z.string(),
  kind: z.enum(["P", "A"]),
  cost: z.number().int().min(0).max(3),
  groups: z.array(z.string()).min(1),
  positions: z.array(z.string()).nullable(),
  weights: z.record(RatingKey, z.number().positive()),
  icon: z.string(), color: Hex,
  demo: z.string(), role: z.string(), mod: z.string().nullable(), fx: z.string(),
  tiers: z.tuple([z.number(), z.number(), z.number()]),
  desc: z.string().includes("{a}"),
});
export type AbilityDef = z.infer<typeof AbilityDefSchema>;
export const AbilitiesFileSchema = z.object({
  abilities: z.array(AbilityDefSchema),
  signatures: z.object({
    minOvr: z.number().int(), cost: z.number().int(), icon: z.string(), color: Hex,
    byGroup: z.record(z.string(), z.object({
      nouns: z.array(z.string()).min(1), demo: z.string(), role: z.string(), mod: z.string().nullable(), special: z.string(),
    })),
  }),
});
export type AbilitiesFile = z.infer<typeof AbilitiesFileSchema>;
export const IconsFileSchema = z.object({ icons: z.record(z.string(), z.array(z.string().max(12)).max(12)) });

// ---------------------------------------------------------------- config
export const PositionWeightsSchema = z.object({
  positions: z.record(z.string(), z.object({
    scale: z.number().positive(), intercept: z.number(),
    weights: z.record(RatingKey, z.number().nonnegative()),
  }).passthrough()),
});
export type PositionWeights = z.infer<typeof PositionWeightsSchema>;

export const PositionsConfigSchema = z.object({
  positions: z.array(z.object({ id: z.string(), name: z.string(), group: z.string(), side: z.enum(["O", "D", "S"]) })),
  roles: z.array(z.object({ id: z.string(), name: z.string() })),
  maddenToGame: z.record(z.string(), z.string()),
  naturalPositions: z.object({ max: z.number().int().min(1), withinPoints: z.number().min(0) }),
  outOfPosition: z.object({ sameGroup: z.number(), adjacentGroup: z.number(), otherGroup: z.number() }),
  adjacentGroups: z.array(z.tuple([z.string(), z.string()])),
});
export type PositionsConfig = z.infer<typeof PositionsConfigSchema>;

export const TiersConfigSchema = z.object({
  tiers: z.array(z.object({ id: z.string(), name: z.string(), min: z.number().int(), color: Hex, draftWeight: z.number() })),
  secondAbilityMinTier: z.string(),
});
export type TiersConfig = z.infer<typeof TiersConfigSchema>;

export const GradeConfigSchema = z.object({
  unitWeights: z.object({
    offense: z.record(z.string(), z.number()), defense: z.record(z.string(), z.number()), special: z.record(z.string(), z.number()),
  }),
  overallUnitWeights: z.object({ offense: z.number(), defense: z.number(), special: z.number() }),
  letters: z.array(z.tuple([z.string(), z.number()])).min(2),
  chemistry: z.object({
    qbTargetSameTeamBonus: z.number(), qbTargetCap: z.number(),
    olSameTeamPairBonus: z.number(), olCap: z.number(), maxTotal: z.number(),
  }),
});
export type GradeConfig = z.infer<typeof GradeConfigSchema>;

export const DraftConfigSchema = z.object({
  optionsPerRound: z.number().int().min(1),
  quick: z.object({ rounds: z.number().int(), slots: z.array(z.string()) }),
  full: z.object({ rounds: z.number().int(), benchSlots: z.number().int() }),
  eliteCapPerTeam: z.number().int(),
  rerollsPerDraft: z.number().int(),
  pickTimerSec: z.number(), pickWarningSec: z.number(),
  viability: z.object({ minOverallAtSlot: z.number(), minViablePerSlot: z.number().int(), minEpicPlusPerSlot: z.number().int() }),
  tierWeights: z.record(z.string(), z.number().nonnegative()),
  needWeight: z.number(), uselessWeight: z.number(), lateOpenSlots: z.number().int(),
  themedEvery: z.number().int(), rookieMaxAge: z.number().int(), themeMinPool: z.number().int(),
  backupMaxOvr: z.number(), backupTopN: z.number().int(), spreadSims: z.number().int(),
  ai: z.object({ rerollBelow: z.number(), stackerBonus: z.number() }),
  personalities: z.array(z.string()),
  mirrorDefault: z.boolean(), revealPassedDefault: z.boolean(),
}).passthrough();
export type DraftConfig = z.infer<typeof DraftConfigSchema>;

export const RulesConfigSchema = z.object({
  tickHz: z.number().int().positive(),
  quarters: z.number().int().positive(),
  quarterSeconds: z.number().int().positive(),
  twoMinuteWarningSeconds: z.number().int().nonnegative(),
  timeoutsPerHalf: z.number().int().nonnegative(),
  downs: z.number().int().positive(),
  firstDownYards: z.number().int().positive(),
  runoffSeconds: z.object({ normal: z.number().int(), hurry: z.number().int(), milk: z.number().int() }),
  outOfBoundsStopsClock: z.object({ q2LastSeconds: z.number().int(), q4LastSeconds: z.number().int() }),
  scoring: z.object({ touchdown: z.number().int(), fieldGoal: z.number().int(), safety: z.number().int(), pat: z.number().int(), twoPoint: z.number().int(), defensiveTry: z.number().int() }),
  spots: z.object({
    kickoffFrom: z.number(), kickoffTouchback: z.number(), kickoffOutOfBounds: z.number(), turnoverTouchback: z.number(),
    safetyKickFrom: z.number(), patLine: z.number(), twoPointLine: z.number(), missedFgMinSpot: z.number(), fgSnapDepth: z.number(),
  }),
  overtime: z.object({
    mode: z.enum(["college"]), startSpot: z.number(), timeoutsPerPeriod: z.number().int(),
    mustGoForTwoFromPeriod: z.number().int(), twoPointShootoutFromPeriod: z.number().int(),
    defensiveScoreEndsGame: z.boolean(), maxPeriods: z.number().int(),
  }),
});
export type RulesConfig = z.infer<typeof RulesConfigSchema>;

// ---------------------------------------------------------------- play-engine tuning
const nums = <K extends string>(...keys: K[]) =>
  z.object(Object.fromEntries(keys.map((k) => [k, z.number()])) as { [P in K]: z.ZodNumber });
const penalty = z.object({ perMille: z.number(), yards: z.number().optional(), awarenessPer: z.number().optional(), skillPer: z.number().optional() });
export const TuningSchema = z.object({
  field: nums("width", "hashHalfGap", "maxPlaySeconds", "endZone"),
  movement: nums("speedBase", "speedPer", "accelBase", "accelPer", "carryingSpeedMult", "engagedSpeedMult", "backpedalMult", "carryingAccelMult", "receiverCarrySpeedMult"),
  blocking: nums("engageRange", "passHoldBase", "passHoldPer", "passHoldJitter", "runHoldBase", "runHoldPer", "runHoldJitter", "doubleTeamMult", "shedStun", "pushPer"),
  qb: nums("readStartAfterDrop", "readWindow", "openSepStart", "openSepEnd", "openSepDeepBonus", "pressureRange", "throwAwayAwareness", "scrambleSpeedMin", "scrambleAfter", "maxHold", "dropSpeed", "cutCost", "evadeAgilityMin", "evadeStep", "pressureReactBase", "pressureReactPerMissing", "closingFactor", "misreadBase", "misreadPerMissing", "windowPerAwareness"),
  throw: nums("ballSpeedBase", "ballSpeedPer", "errBase", "errPerMissingAcc", "errPerYard", "pressureErrMult", "onRunErrMult", "shortMax", "midMax"),
  catch: nums("reach", "contestRange", "baseCatch", "catchPer", "contestPenalty", "contestSkillPer", "intBase", "intPer", "deflectBase", "catchSpeedKeep", "deepCatchPenaltyPerYard", "deepCatchFrom", "deepIntMult", "placementPenalty"),
  coverage: nums("reactBase", "reactPerMissing", "manCushion", "zoneSwitchRange", "ballReactBase", "ballReactPerMissing", "runReadBase", "runReadPerMissing", "pursuitLead", "pursuitMaxTime", "deepCushion", "manReactBase", "manReactPerMissing", "manBailCushion", "zoneDriftStep"),
  tackle: nums("range", "base", "per", "powerPer", "gangBonus", "min", "max", "missStun", "carrierSlowOnMiss", "fumbleBase", "fumblePer", "fumbleMin", "fumbleMax", "fumbleOffenseRecover", "sackBase", "sackPer", "elusiveMaxWeight", "fallForwardPerSpeed", "fallForwardMax", "fallForwardBase", "afterContactPowerPer", "fallForwardReceiverMult"),
  carrier: nums("lookAhead", "lanePerp", "forwardWeight", "sidelineMargin", "visionNoisePerMissing", "followAimFor", "replanTicksBase", "replanPerAgility", "sharpTurnSpeedMult", "sharpTurnAgilityPer").extend({ laneAngles: z.array(z.number()).min(3) }),
  kicking: nums("kickoffBase", "kickoffPer", "kickoffJitter", "returnMeanBase", "returnPer", "returnJitter", "returnTdPerMille", "puntBase", "puntPer", "puntJitter",
    "puntReturnMean", "puntReturnJitter", "fairCatchPerMille", "fgMakeShort", "fgDropPerYardAfter35", "fgDropPerYardAfter50", "fgAccPer", "fgRangeBase", "fgRangePer",
    "patBase", "patPer", "kickSeconds", "puntSeconds", "kickoffSeconds"),
  schemes: nums("pullStep", "drawHandoff", "drawDrop", "drawRecognize", "optionMesh", "rpoMesh", "rpoConflictRange", "rpoConflictDepth",
    "keyCrashPerMille", "readMisreadBase", "readMisreadPerMissing", "comboSeconds", "screenRelease", "gapPatience", "gapPatienceMult", "keyCommit", "drawShedBase", "drawShedPerMissing", "screenThrowAfter").extend({ _doc: z.string().optional() }),
  pa: nums("fakeSeconds", "biteBase", "bitePerMissing", "cornerMult", "safetyMult", "biteStep", "bootWidth", "bootDepth").extend({ _doc: z.string().optional() }),
  userDefense: nums("diveRange", "diveBonus", "diveMissStun", "diveWhiffStun", "stripSeconds", "stripTacklePenalty", "stripFumbleMult",
    "swatRange", "swatSeconds", "swatCatchPenalty", "swatIntBonus", "actionCooldown", "manualHold").extend({ _doc: z.string().optional() }),
  presnap: nums("jogMult", "jetMult", "motionMaxSeconds", "jetSnapDistance", "jetHandoff", "jetBoost", "jetBoostSeconds", "followMult",
    "jamBase", "jamPer", "jamMax", "pressDepth", "bailDepth", "pressBeatPenalty", "showDepth", "dlShift", "lbShift", "slideBias",
    "hardCountOffsideBase", "hardCountOffsidePer", "hardCountFalseStart", "playClock").extend({ _doc: z.string().optional() }),
  special: nums("gravity", "dragFg", "dragPunt", "dragKickoff", "dragSquib", "dragOnside", "elevFg", "elevPat", "elevPunt", "elevKickoff", "elevSquib", "elevOnside", "speedBase", "speedPer", "minPower", "squibMult", "onsideMult", "aimErrBase", "aimErrPer", "powerErrBase", "powerErrPer", "pressureMult", "longFgFrom", "longFgMult", "windAccel", "windMaxMph", "windCalmPerMille", "curveAccel", "restitution", "onsideRestitution", "friction", "scatter", "rollFriction", "catchHeight", "catchRange", "catchBase", "catchPer", "catchTraffic", "fieldBase", "fieldPer", "recoverRange", "recoverBase", "recoverPer", "onsideTravel", "downRange", "fairCatchEta", "kneelDepth", "kickoffApproach", "puntSnap", "puntGetOff", "fgOperation", "blockBase", "blockPer", "blockModeMult", "safeModeMult", "puntBlockMult", "patBlockMult", "postsHalfWidth", "crossbar", "maxSeconds", "diveBonus").extend({ _doc: z.string().optional() }),
  abilities: nums("momentumMax", "pointsPerBar", "gainFirstDown", "gainBigPlay", "bigPlayYards", "gainTouchdown", "gainTakeaway", "gainSack", "gainFieldGoal", "gainStop", "coverageLagPerYd", "routeLagPerStep", "cannonSpeedPerYd", "roadGraderHoldPerYd", "bullRushPerYd", "closingSpeedMult", "perfectSnapBase", "badSnapErrMult", "dlSignatureHold", "dlSignatureSack", "hardCountFreeze", "bigLegPowerPer", "qbSignatureSepYds", "fieldGeneralLagMult", "stickyHandsMult", "jamRangeYds", "dartMaxYds", "passProHoldPer", "bullRushMinHold", "swimMinHold", "olSignatureHold", "escapeStun", "escapeSeconds", "rbSignatureMisses", "rbSignatureStun", "cycloneStun", "stiffArmStun", "ramStun", "ramSeconds", "ramMaxTrucks", "afterburnerSeconds", "lightsOutFumblePer", "missileRangeYds", "dartCatchSpeedKeep", "pickSixIntBase", "pickSixIntPer", "zoneDropRangeYds", "zoneDropIntPer", "dbSignatureInt", "shadowLagMult", "returnBreakStun", "hangTimeElev", "coffinRollMult").extend({ _doc: z.string().optional() }),
  user: nums("moveSeconds", "moveCooldown", "moveBonusBase", "moveBonusPer", "cutSideSpeed", "burstSeconds", "burstCooldown", "burstSpeedMult",
    "lobSpeedMult", "lobApex", "bulletApex").extend({ _doc: z.string().optional() }),
  penalties: z.object({
    falseStart: penalty, offside: penalty, holdingOffense: penalty, holdingDefense: penalty,
    passInterference: z.object({ onCloseIncompletePerMille: z.number() }), roughing: penalty,
  }),
});
export type Tuning = z.infer<typeof TuningSchema>;

// ---------------------------------------------------------------- playbook
const XY = z.tuple([z.number(), z.number()]);
/** Offense: QB + 5 OL are fixed; the five eligibles are X, Y, Z, H, RB, filled by the personnel group. */
export const OFF_ELIGIBLE = ["X", "Y", "Z", "H", "RB"] as const;
export const OFF_LINE = ["LT", "LG", "C", "RG", "RT"] as const;
export const DefClass = z.enum(["DL", "EDGE", "LB", "NB", "CB", "S"]);
export const FormationsFileSchema = z.object({
  _doc: z.string().optional(),
  /** personnel id -> which roster slot plays each eligible role (QB/OL always QB, LT..RT) */
  personnel: z.record(z.string(), z.object({ name: z.string() }).catchall(z.string())),
  offense: z.array(z.object({
    id: z.string(), name: z.string(), family: z.string(), personnel: z.array(z.string()).min(1),
    spots: z.record(z.string(), XY),
  })),
  /** defensive fronts, drawn for the offense's strength to the right (mirrored when it is left) */
  defense: z.array(z.object({
    id: z.string(), name: z.string(), personnel: z.string(),
    /** role -> [x, y, class, roster slot]; alignOn: "wide" (widest receiver on my side) | "slot" (next one in) */
    roles: z.record(z.string(), z.object({ at: XY, cls: DefClass, slot: z.string(), alignOn: z.enum(["wide", "slot"]).optional() })),
    rush: z.array(z.string()).min(3),
  })),
});
export type FormationsFile = z.infer<typeof FormationsFileSchema>;
export type OffFormation = FormationsFile["offense"][number];
export type DefFormation = FormationsFile["defense"][number];
export const RoutesFileSchema = z.object({
  _doc: z.string().optional(),
  routes: z.record(z.string(), z.object({
    points: z.array(XY), settle: z.boolean().optional(),
    /** block = pass protection; stalk = block the nearest defensive back (screens, runs) */
    block: z.enum(["pass", "stalk"]).optional(),
    /** seconds to wait (blocking) before releasing into the route */
    delay: z.number().optional(),
  })),
});
export type RoutesFile = z.infer<typeof RoutesFileSchema>;
export const OffensePlaySchema = z.object({
  id: z.string(), name: z.string(), kind: z.enum(["run", "pass", "rpo"]), formations: z.array(z.string()).min(1),
  /** playbook group shown in the UI (Inside run, Quick, Dropback, Play action, Screen, ...) */
  group: z.string(),
  weight: z.number().nonnegative(), tags: z.array(z.string()),
  // runs (and the run half of an RPO)
  carrier: z.string().optional(), aim: XY.optional(),
  block: z.enum(["zone", "man", "power", "counter", "toss", "draw"]).optional(),
  /** read option: the QB reads the unblocked backside end and keeps or gives */
  option: z.boolean().optional(),
  /** lead blocker through the hole (FB/H) */
  lead: z.string().optional(),
  // passes (and the pass half of an RPO)
  drop: z.number().optional(), routes: z.record(z.string(), z.string()).optional(), read: z.array(z.string()).optional(),
  /** play action: the back fakes the handoff */
  pa: z.boolean().optional(),
  /** bootleg: the QB rolls out away from the fake */
  boot: z.boolean().optional(),
  /** screen: the line lets rushers through, then releases downfield to block */
  screen: z.boolean().optional(),
  /** built-in pre-snap motion (jet sweeps): who and what kind */
  motion: z.object({ role: z.string(), kind: z.enum(["jet", "across", "orbit", "short", "return"]) }).optional(),
});
export type OffensePlay = z.infer<typeof OffensePlaySchema>;
export const OffenseFileSchema = z.object({ _doc: z.string().optional(), plays: z.array(OffensePlaySchema).min(1) });
/** Defensive call = coverage shell + pressure, compiled at the snap against whatever front is on the field.
 *  Selectors pick defenders: "FS", "MLB" (role names), or "CB:L" / "S:deep" / "LB:M" / "NB" (class:pick, where
 *  pick is L, R, M (middle), S (strong side), W (weak side), deep, low). Lists are fallbacks: first match wins. */
const Sel = z.array(z.string()).min(1);
export const DefenseCallSchema = z.object({
  id: z.string(), name: z.string(), group: z.string(), weight: z.number().nonnegative(), tags: z.array(z.string()),
  /** extra rushers beyond the front's rush (each a selector list) */
  blitz: z.array(Sel).default([]),
  /** front players who drop into coverage instead (zone blitz) */
  drop: z.array(Sel).default([]),
  /** deep zones and who plays them */
  deep: z.array(z.object({ zone: z.string(), who: Sel })).default([]),
  /** man coverage for everyone left (Cover 0/1/2-Man) */
  man: z.boolean().default(false),
  /** underneath zones in priority order (the remaining players take the first N, matched left to right) */
  under: z.array(z.string()).default([]),
  /** QB spy */
  spy: Sel.optional(),
  /** fronts this call can't be run from */
  notFrom: z.array(z.string()).default([]),
});
export type DefenseCall = z.infer<typeof DefenseCallSchema>;
export const DefenseFileSchema = z.object({
  _doc: z.string().optional(),
  zones: z.record(z.string(), z.object({ at: XY, r: z.number().positive(), deep: z.boolean().optional() })),
  calls: z.array(DefenseCallSchema).min(1),
});
export type DefenseFile = z.infer<typeof DefenseFileSchema>;

// ---------------------------------------------------------------- AI coach
const Weights = z.record(z.string(), z.number().nonnegative());
export const CoachConfigSchema = z.object({
  _doc: z.string().optional(),
  personnel: z.object({ normal: Weights, short: Weights, goalLine: Weights, passing: Weights }),
  frontFor: z.record(z.string(), z.array(z.string()).min(1)),
  baseFront: z.string(), passingDownFront: z.string(), preventFront: z.string(), goalLineFront: z.string(),
  tendency: z.object({ prior: z.number(), runBiasMax: z.number(), paBiteBase: z.number(), paBitePerRunRate: z.number() }),
  qbRun: z.object({ speedRef: z.number(), speedPer: z.number(), min: z.number(), max: z.number() }),
  hailMary: z.object({ maxSeconds: z.number(), minBallOn: z.number(), maxBallOn: z.number() }),
  /** signature defensive schemes (League Bosses): call weight multipliers by call tag */
  defStyles: z.record(z.string(), z.record(z.string(), z.number())),
  abilities: z.object({ _doc: z.string().optional(), usePerMille: z.number(), keyPerMille: z.number(),
    roles: z.object({ pass: z.array(z.string()), run: z.array(z.string()), defense: z.array(z.string()), kick: z.array(z.string()), "return": z.array(z.string()) }) }),
  styles: z.record(z.string(), z.object({ pass: z.number(), personnel: z.record(z.string(), z.number()) })),
  special: z.object({ onsideMaxDeficit: z.number(), onsideSeconds: z.number(), squibSeconds: z.number(), squibPerMille: z.number(),
    coffinFrom: z.number(), coffinTarget: z.number(), fakePuntPerMille: z.number(), fakeFgPerMille: z.number() }),
  presnap: z.object({
    motionPerMille: z.number(), showBlitzPerMille: z.number(), disguisePerMille: z.number(), pressPerMille: z.number(),
    bailPerMille: z.number(), dlShiftPerMille: z.number(), checkPerMille: z.number(), hardCountPerMille: z.number(),
    audibles: z.object({ offense: z.array(z.string()).length(5), defense: z.array(z.string()).length(5) }),
  }),
});
export type CoachConfig = z.infer<typeof CoachConfigSchema>;

// ---------------------------------------------------------------- derived pool
/** A draftable player card: a real player plus game-derived fields (built by tools/report/build_pool.ts). */
export const PlayerCardSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  team: z.string(),
  num: z.number().int().nullable(),
  maddenPos: z.string(),
  pos: z.string(),                         // game position
  group: z.string(),
  ovr: z.number().int(),                   // real Madden overall at his position
  tier: z.string(),                        // ELITE | PRO_BOWL | STARTER | DEPTH
  arch: z.string(),                        // Madden archetype (Field General, Power Rusher, ...)
  htIn: z.number().int(), wt: z.number().int(), age: z.number().int(),
  overallAt: z.record(z.string(), z.number().int()),
  natural: z.array(z.string()).min(1),
  abilities: z.array(z.object({ id: z.string(), tier: z.number().int().min(1).max(3), text: z.string() })),
  signature: z.object({ name: z.string(), text: z.string() }).nullable(),
});
export type PlayerCard = z.infer<typeof PlayerCardSchema>;
export const PoolFileSchema = z.object({
  _doc: z.string(), source: z.string(), hash: z.string(),
  players: z.array(PlayerCardSchema),
});

// ---------------------------------------------------------------- online (M8)
export const OnlineConfigSchema = z.object({
  _doc: z.string().optional(),
  callSeconds: z.number(), defenseSeconds: z.number(), resultSeconds: z.number(), lineupSeconds: z.number(), idlePickSeconds: z.number(),
  kickSeconds: z.number(), aiAfterSeconds: z.number(), forfeitSeconds: z.number(), aiPresnapSeconds: z.number(), presnapExtraSeconds: z.number(),
  inputDelayTicks: z.number().int(), maxPredictTicks: z.number().int(), fillMs: z.number(), codeLength: z.number().int(), maxMsgsPerSecond: z.number(),
});

// ---------------------------------------------------------------- presentation (M9, client only)
export const PresentationConfigSchema = z.object({
  _doc: z.string().optional(),
  bowl: z.object({ anchorUp: z.number(), anchorDown: z.number(), follow: z.number() }),
  pro: z.object({ visibleYards: z.number(), tilt: z.number(), farScale: z.number(), heightLift: z.number(), carrierZoom: z.number(), zoomEase: z.number(), follow: z.number(), playerSize: z.number(), centerY: z.number() }),
  juice: z.object({
    shakeSackMs: z.number(), shakeSack: z.number(), shakeHitMs: z.number(), shakeHit: z.number(), shakeTurnoverMs: z.number(), shakeTurnover: z.number(),
    slowmoScale: z.number(), slowmoMs: z.number(), clutchAirYards: z.number(), confetti: z.number(), popupMs: z.number(),
  }),
  audio: z.object({ master: z.number(), music: z.number(), sfx: z.number(), crowd: z.number(), crowdSwellMs: z.number() }),
});

// ---------------------------------------------------------------- modes (M10)
export const BossSchema = z.object({
  id: z.string(), name: z.string(), abbr: z.string(), nick: z.string(), c1: z.string(), c2: z.string(), c3: z.string(), icon: z.string(),
  focus: z.array(z.enum(["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "ST"])), style: z.enum(["balanced", "spread", "pro", "run", "air"]),
  defStyle: z.string(), baseFront: z.string(), scheme: z.string(), final: z.boolean().optional(),
});
export const BossesFileSchema = z.object({ _doc: z.string().optional(), bosses: z.array(BossSchema).min(4) });
export const ModesConfigSchema = z.object({
  _doc: z.string().optional(),
  gauntlet: z.object({
    weeks: z.number().int(), strengthStart: z.number(), strengthEnd: z.number(), focusBoost: z.number(), pickTop: z.number().int(), benchDrop: z.number(),
    playoffWins: z.number().int(), playoffRounds: z.array(z.string()), playoffStrength: z.number(), winPoints: z.number(), playoffPoints: z.number(),
    pointDiffCap: z.number(), quarterMinutes: z.number(),
  }),
  daily: z.object({ dailyGames: z.number().int(), dailyStrengthStart: z.number(), dailyStrengthEnd: z.number(), winPoints: z.number(), quarterMinutes: z.number() }),
  ranked: z.object({ eloK: z.number(), ratingStart: z.number(), ratingWindow: z.number(), windowGrowthPerSec: z.number(), trajectoryGuide: z.boolean(), quarterMinutes: z.number() }),
});

// ---------------------------------------------------------------- franchise (M11)
const NumList = z.array(z.number());
export const FranchiseConfigSchema = z.object({
  _doc: z.string().optional(),
  rosterMax: z.number().int(),
  salary: z.object({ min: z.number(), max: z.number(), salaryFloorOvr: z.number(), salaryExp: z.number(), maxYears: z.number().int(), cap: z.number(), openingShare: z.number(),
    deadCapShare: z.number(), posMult: z.record(z.string(), z.number()), personality: z.record(z.string(), z.number()) }),
  credits: z.object({ win: z.number(), loss: z.number(), playoffWin: z.number(), title: z.number(), milestone: z.number(), fansPer25: z.number(), start: z.number(),
    developBase: z.number(), developPer8: z.number(), developMaxPerSeason: z.number(), extendCredits: z.number(), staffCost: NumList, facilityCost: NumList, maintainPerLevel: z.number() }),
  staff: z.object({ staffRating: z.number(), trainerInjury: z.number(), trainerProg: z.number(), maxLevel: z.number().int() }),
  facilities: z.object({ maxLevel: z.number().int(), trainingProg: z.number(), rehabWeeks: z.number(), stadiumFans: z.number() }),
  morale: z.object({ start: z.number(), moraleRating: z.number(), win: z.number(), loss: z.number() }),
  fans: z.object({ start: z.number(), win: z.number(), loss: z.number(), playoff: z.number(), title: z.number() }),
  injuries: z.object({ injuryPerGame: z.number(), injuryWeeks: z.array(z.tuple([z.number(), z.number()])) }),
  progression: z.object({ bands: z.array(z.tuple([z.number(), z.number(), z.number()])) }),
  retirement: z.object({ retireAge: z.number(), retireChancePerYear: z.number(), retireOvr: z.number() }),
  draft: z.object({ draftRounds: z.number().int(), prospectsPerRound: z.number().int(), prospectNoise: z.number(), prospectAgeMin: z.number(), prospectAgeMax: z.number(),
    prospectOvrMax: z.number(), prospectYears: z.number().int() }),
  freeAgency: z.object({ aiBidMin: z.number(), aiBidMax: z.number(), teamAppeal: z.number(), maxUserBids: z.number().int() }),
  trades: z.object({ tradeMargin: z.number() }),
  security: z.object({ start: z.number(), securityWin: z.number(), securityLoss: z.number(), securityPerWin: z.number(), playoffBonus: z.number(), titleBonus: z.number() }),
  events: z.object({ eventChance: z.number(), dealMinOvr: z.number(), moraleSwing: z.number() }),
  playoffs: z.object({ perConference: z.number().int(), rounds: z.array(z.string()) }),
  awards: z.object({ mvpWeights: z.record(z.string(), z.number()), dpoyWeights: z.record(z.string(), z.number()), hofCareerScore: z.number() }),
  names: z.object({ _doc: z.string().optional(), first: z.array(z.string()).min(4), last: z.array(z.string()).min(4) }),
  news: z.record(z.string(), z.array(z.string()).min(1)),
});
