// Parse raw JSON (from fs in Node, fetch/import in the browser) into validated game data.
// Loading is kept separate from reading so the same code runs on client, server and in tests.
import {
  AbilitiesFileSchema, DraftConfigSchema, GradeConfigSchema,
  IconsFileSchema, MaddenAbilitiesFileSchema, PlayersFileSchema, PositionsConfigSchema, PositionWeightsSchema,
  TiersConfigSchema, RulesConfigSchema, TuningSchema, FormationsFileSchema, RoutesFileSchema, OffenseFileSchema, DefenseFileSchema, StatGroupsFileSchema, TeamsFileSchema, CoachConfigSchema, OnlineConfigSchema, PresentationConfigSchema, BossesFileSchema, ModesConfigSchema,
} from "./schemas.js";

/** File names, relative to packages/shared/. */
export const DATA_FILES = {
  players: "data/players.json",
  teams: "data/teams.json",
  maddenAbilities: "data/madden_abilities.json",
  statGroups: "data/stat_groups.json",
  abilities: "data/abilities.json",
  icons: "data/icons.json",
  positionWeights: "config/position_weights.json",
  positions: "config/positions.json",
  tiers: "config/tiers.json",
  grade: "config/grade.json",
  draft: "config/draft.json",
  rules: "config/rules.json",
  tuning: "config/tuning.json",
  coach: "config/coach.json",
  online: "config/online.json",
  presentation: "config/presentation.json",
  modes: "config/modes.json",
  bosses: "data/bosses.json",
  formations: "data/playbook/formations.json",
  routes: "data/playbook/routes.json",
  offense: "data/playbook/offense.json",
  defense: "data/playbook/defense.json",
} as const;
export type DataKey = keyof typeof DATA_FILES;

const SCHEMAS = {
  players: PlayersFileSchema, teams: TeamsFileSchema, maddenAbilities: MaddenAbilitiesFileSchema,
  statGroups: StatGroupsFileSchema, abilities: AbilitiesFileSchema, icons: IconsFileSchema,
  positionWeights: PositionWeightsSchema, positions: PositionsConfigSchema, tiers: TiersConfigSchema,
  grade: GradeConfigSchema, draft: DraftConfigSchema,
  rules: RulesConfigSchema,
  tuning: TuningSchema,
  coach: CoachConfigSchema,
  online: OnlineConfigSchema,
  presentation: PresentationConfigSchema,
  modes: ModesConfigSchema,
  bosses: BossesFileSchema,
  formations: FormationsFileSchema, routes: RoutesFileSchema, offense: OffenseFileSchema, defense: DefenseFileSchema,
} as const;

export type GameData = { [K in DataKey]: ReturnType<(typeof SCHEMAS)[K]["parse"]> };

/** Validate everything. `read` returns the parsed JSON for a relative path. */
export async function loadGameData(read: (rel: string) => unknown | Promise<unknown>): Promise<GameData> {
  const out: Partial<Record<DataKey, unknown>> = {};
  for (const key of Object.keys(DATA_FILES) as DataKey[]) {
    const raw = await read(DATA_FILES[key]);
    const res = SCHEMAS[key].safeParse(raw);
    if (!res.success) {
      throw new Error(`${DATA_FILES[key]} failed validation:\n` +
        res.error.issues.slice(0, 8).map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
    }
    out[key] = res.data;
  }
  return out as GameData;
}
