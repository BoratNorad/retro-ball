// Load the game data, pool and ratings for the server (Node only).
import { randomBytes } from "node:crypto";
import { PoolFileSchema } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import type { ServerEnv } from "./room.js";

export async function loadEnv(): Promise<ServerEnv> {
  const data = await nodeGameData();
  const poolFile = PoolFileSchema.parse(readShared("data/pool.json"));
  const pool = poolFile.players;
  const cards = new Map(pool.map((c) => [c.id, c]));
  const stats = new Map(data.players.players.map((p) => [p.id, p.stats]));
  return {
    data, pool, byId: (id) => cards.get(id), ratings: (id) => stats.get(id) ?? {}, poolHash: poolFile.hash,
    seed: () => randomBytes(8).toString("hex"), now: () => Date.now(),
  };
}
