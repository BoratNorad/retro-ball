// Saved teams (M10): drafted rosters kept in this browser for Exhibition games.
import { rosterFromWire, rosterToWire, type Roster, type WireRoster } from "@tdf/sim";
import type { ClientData } from "../data.js";

const KEY = "tdf.savedTeams";
const MAX = 12;
export interface SavedTeam { id: string; roster: WireRoster; savedAt: number }

export function savedTeams(): SavedTeam[] {
  try { const l = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(l) ? l : []; } catch { return []; }
}
function write(l: SavedTeam[]) { try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, MAX))); } catch { /* private mode */ } }
export function saveTeam(r: Roster) {
  write([{ id: `t${Date.now().toString(36)}`, roster: rosterToWire(r), savedAt: Date.now() }, ...savedTeams()]);
}
export function deleteTeam(id: string) { write(savedTeams().filter((t) => t.id !== id)); }
/** A saved team as a roster (null if its players are no longer in the pool). */
export function loadTeam(cd: ClientData, t: SavedTeam): Roster | null {
  try { return rosterFromWire(t.roster, cd.byId); } catch { return null; }
}
