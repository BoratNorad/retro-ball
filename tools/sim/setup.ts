// Shared setup for sim tools: load data, pool, ratings lookup, and real-team rosters.
import { PoolFileSchema, type PlayerCard, type GameData } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { nflRoster, type Roster, type Stats } from "@tdf/sim";

export interface SimEnv { data: GameData; pool: PlayerCard[]; ratings: (id: number) => Stats; roster: (abbr: string) => Roster }

export async function simEnv(): Promise<SimEnv> {
  const data = await nodeGameData();
  const pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
  const byId = new Map(data.players.players.map((p) => [p.id, p.stats]));
  const ratings = (id: number) => byId.get(id) ?? {};
  const cache = new Map<string, Roster>();
  const roster = (abbr: string) => {
    let r = cache.get(abbr);
    if (!r) { r = nflRoster(abbr, pool, data); cache.set(abbr, r); }
    return r;
  };
  return { data, pool, ratings, roster };
}
