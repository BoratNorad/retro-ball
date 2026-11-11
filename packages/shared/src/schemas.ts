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

// ---------------------------------------------------------------- types
export const TypeDefSchema = z.object({
  id: z.string(), name: z.string(), color: Hex, icon: z.string(),
  traits: z.record(RatingKey, z.number().positive()),
  eligible: z.array(z.string()).min(1),
  passive: z.record(z.string(), z.number()),
});
export type TypeDef = z.infer<typeof TypeDefSchema>;
export const TypesFileSchema = z.object({
  modifier: z.number().min(0).max(0.5),
  secondaryMinZ: z.number(),
  types: z.array(TypeDefSchema).min(2),
});
export type TypesFile = z.infer<typeof TypesFileSchema>;

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

export const RarityConfigSchema = z.object({
  tiers: z.array(z.object({ id: z.string(), name: z.string(), min: z.number().int(), color: Hex, draftWeight: z.number() })),
  secondAbilityMinTier: z.string(),
});
export type RarityConfig = z.infer<typeof RarityConfigSchema>;

export const BodyConfigSchema = z.object({
  rules: z.array(z.object({
    id: z.string(), name: z.string(),
    minWt: z.number().optional(), maxWt: z.number().optional(),
    minHt: z.number().optional(), maxHt: z.number().optional(),
    minBmi: z.number().optional(), maxBmi: z.number().optional(),
  })).min(1),
});
export type BodyConfig = z.infer<typeof BodyConfigSchema>;

export const BaseStatsConfigSchema = z.object({
  stats: z.record(z.string(), z.object({ name: z.string(), ratings: z.array(RatingKey).min(1), top: z.number().int().min(1) })),
});
export type BaseStatsConfig = z.infer<typeof BaseStatsConfigSchema>;

export const GradeConfigSchema = z.object({
  unitWeights: z.object({
    offense: z.record(z.string(), z.number()), defense: z.record(z.string(), z.number()), special: z.record(z.string(), z.number()),
  }),
  overallUnitWeights: z.object({ offense: z.number(), defense: z.number(), special: z.number() }),
  letters: z.array(z.tuple([z.string(), z.number()])).min(2),
  chemistry: z.object({
    typeDiversityPerType: z.number(), typeDiversityCap: z.number(),
    qbWrSharedTypeBonus: z.number(), qbWrCap: z.number(),
    olSameTeamPairBonus: z.number(), olCap: z.number(), maxTotal: z.number(),
  }),
});
export type GradeConfig = z.infer<typeof GradeConfigSchema>;

export const DraftConfigSchema = z.object({
  optionsPerRound: z.number().int().min(1),
  quick: z.object({ rounds: z.number().int(), slots: z.array(z.string()) }),
  full: z.object({ rounds: z.number().int(), benchSlots: z.number().int() }),
  mythicCapPerTeam: z.number().int(),
  rerollsPerDraft: z.number().int(),
  pickTimerSec: z.number(), pickWarningSec: z.number(),
  viability: z.object({ minOverallAtSlot: z.number(), minViablePerSlot: z.number().int(), minEpicPlusPerSlot: z.number().int() }),
});
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

// ---------------------------------------------------------------- playbook
const XY = z.tuple([z.number(), z.number()]);
export const FormationsFileSchema = z.object({
  roles: z.object({ offense: z.record(z.string(), z.string()), defense: z.record(z.string(), z.string()) }),
  offense: z.array(z.object({ id: z.string(), name: z.string(), personnel: z.string(), spots: z.record(z.string(), XY) })),
  defense: z.array(z.object({ id: z.string(), name: z.string(), spots: z.record(z.string(), XY), alignOn: z.record(z.string(), z.string()).optional() })),
});
export type FormationsFile = z.infer<typeof FormationsFileSchema>;
export const RoutesFileSchema = z.object({
  routes: z.record(z.string(), z.object({ points: z.array(XY), settle: z.boolean().optional(), block: z.boolean().optional() })),
});
export type RoutesFile = z.infer<typeof RoutesFileSchema>;
export const OffensePlaySchema = z.object({
  id: z.string(), name: z.string(), kind: z.enum(["run", "pass"]), formations: z.array(z.string()).min(1),
  weight: z.number().nonnegative(), tags: z.array(z.string()),
  carrier: z.string().optional(), aim: XY.optional(), block: z.enum(["zone", "man"]).optional(),
  drop: z.number().optional(), routes: z.record(z.string(), z.string()).optional(), read: z.array(z.string()).optional(),
});
export type OffensePlay = z.infer<typeof OffensePlaySchema>;
export const OffenseFileSchema = z.object({ plays: z.array(OffensePlaySchema).min(1) });
const Assignment = z.union([z.literal("rush"), z.literal("spy"), z.object({ man: z.string() }), z.object({ zone: z.string() })]);
export const DefenseCallSchema = z.object({
  id: z.string(), name: z.string(), formation: z.string(), weight: z.number().nonnegative(), tags: z.array(z.string()),
  roles: z.record(z.string(), Assignment),
});
export type DefenseCall = z.infer<typeof DefenseCallSchema>;
export const DefenseFileSchema = z.object({
  zones: z.record(z.string(), z.object({ at: XY, r: z.number().positive(), deep: z.boolean().optional() })),
  calls: z.array(DefenseCallSchema).min(1),
});
export type DefenseFile = z.infer<typeof DefenseFileSchema>;

// ---------------------------------------------------------------- derived pool (output of tools/report/build_pool.ts)
export const CreatureSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  team: z.string(),
  num: z.number().int().nullable(),
  maddenPos: z.string(),
  pos: z.string(),                         // game position
  group: z.string(),
  ovr: z.number().int(),                   // real overall at natural position
  rarity: z.string(),
  types: z.array(z.string()).min(1).max(2),
  body: z.string(),
  base: z.record(z.string(), z.number().int()),
  overallAt: z.record(z.string(), z.number().int()),
  natural: z.array(z.string()).min(1),
  abilities: z.array(z.object({ id: z.string(), tier: z.number().int().min(1).max(3), text: z.string() })),
  signature: z.object({ name: z.string(), text: z.string() }).nullable(),
});
export type Creature = z.infer<typeof CreatureSchema>;
export const PoolFileSchema = z.object({
  _doc: z.string(), source: z.string(), hash: z.string(),
  creatures: z.array(CreatureSchema),
});
