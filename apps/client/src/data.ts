// Load and validate all game data in the browser (same schemas as Node).
import { loadGameData, PoolFileSchema, type GameData, type PlayerCard } from "@tdf/shared";
import { nflRoster, type Roster, type Stats } from "@tdf/sim";

export interface ClientData {
  data: GameData;
  pool: PlayerCard[];
  ratings: (id: number) => Stats;
  roster: (abbr: string) => Roster;
}

const BASE = `${import.meta.env.BASE_URL}game-data/`;
const getJson = async (rel: string) => {
  const r = await fetch(BASE + rel);
  if (!r.ok) throw new Error(`failed to load ${rel}: ${r.status}`);
  return r.json();
};

export async function loadClientData(): Promise<ClientData> {
  const [data, poolRaw] = await Promise.all([loadGameData(getJson), getJson("data/pool.json")]);
  const pool = PoolFileSchema.parse(poolRaw).players;
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
