// Node-only loader (tools, tests, server). Browser code uses loadGameData with fetch instead.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGameData, type GameData } from "./load.js";

/** packages/shared/ on disk */
export const SHARED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export function readShared(rel: string): unknown {
  return JSON.parse(readFileSync(join(SHARED_DIR, rel), "utf8"));
}

let cached: Promise<GameData> | null = null;
export function nodeGameData(): Promise<GameData> {
  cached ??= loadGameData(readShared);
  return cached;
}
