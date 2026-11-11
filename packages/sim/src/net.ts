// Online protocol (M8): the JSON messages between the browser and the game server. Types only.
// Room lifecycle: lobby -> draft -> lineup -> match -> results. The server owns every timer, orders
// every action, and sends each client only what it may see (its own draft offers come from the
// shared draft log, an opponent's pick only at the reveal, the opponent's play call only at the
// line-up, see CLAUDE.md decision 8).
import type { UserInput } from "./engine/play.js";
import type { TeamInfo } from "./roster.js";
import type { Side } from "./rules.js";
import type { DefensePart, DraftAction, DraftInit, MatchAction, MatchInit, OffensePart, WireAdjust, WireRoster } from "./online.js";

export interface RoomSettings {
  format: "quick" | "full"; mirror: boolean; revealPassed: boolean; themed: boolean;
  /** draft pick timer on (off: a long idle timer still auto-picks for a player who is away) */
  timer: boolean;
  quarterMinutes: number; abilities: boolean; controlDefender: boolean;
}
export interface TeamSetupWire { info: TeamInfo; icon: string }
export type RoomPhase = "lobby" | "draft" | "lineup" | "match" | "results";
export interface SeatInfo { team: TeamSetupWire; connected: boolean; ready: boolean }

/** What the match is waiting for (sent to both; `personnel` only to the defense, after the offense calls). */
export interface MatchWait {
  step: "offense" | "defense" | "presnap" | "live" | "result" | "final";
  /** whose decision it is (offense / defense step) */
  side?: Side;
  /** the offense's personnel group or kick unit, shown to the defense before it calls */
  personnel?: string;
  /** milliseconds left on this step's timer */
  ms?: number;
  /** index of the live play (= the number of actions applied when it went live) */
  play?: number;
}

export type ClientMsg =
  | { t: "hello"; poolHash: string; token?: string }
  | { t: "create"; settings: RoomSettings; team: TeamSetupWire }
  | { t: "join"; code: string; team: TeamSetupWire }
  | { t: "quick"; team: TeamSetupWire }
  /** ranked queue (M10): a guest account from POST /api/account */
  | { t: "ranked"; team: TeamSetupWire; account: { id: string; secret: string } }
  | { t: "leave" }
  | { t: "pick"; cardId: number; slot: string | null }
  | { t: "reroll" }
  | { t: "lineup"; roster: WireRoster }
  | { t: "off"; part: OffensePart }
  | { t: "def"; part: DefensePart }
  | { t: "adjust"; ch: WireAdjust }
  | { t: "hardCount" }
  /** offense: snap the ball (start the live play) */
  | { t: "go" }
  /** my inputs for live play `play`, ticks from .. from + n - 1 */
  | { t: "in"; play: number; from: number; inputs: (UserInput | null)[] }
  | { t: "resync" }
  | { t: "rematch" }
  | { t: "ping"; at: number };

export type ServerMsg =
  | { t: "welcome"; token: string }
  | { t: "error"; msg: string }
  | { t: "room"; code: string; side: Side; phase: RoomPhase; settings: RoomSettings; seats: [SeatInfo | null, SeatInfo | null]; quick: boolean; ranked: boolean }
  /** draft log entries from action `from` on; reset = this is the whole log (start, reconnect, resync) */
  | { t: "draft"; init: DraftInit; from: number; actions: DraftAction[]; reset: boolean }
  /** the draft's pick timer */
  | { t: "pickTimer"; ms: number }
  /** a side has locked in its pick (the pick itself comes at the reveal) */
  | { t: "picked"; side: Side }
  | { t: "pickRejected"; msg: string }
  /** lineup phase: both drafted rosters, and who has confirmed */
  | { t: "rosters"; rosters: [WireRoster, WireRoster]; ready: [boolean, boolean]; ms: number }
  /** match log entries from action `from` on; reset = this is the whole log */
  | { t: "match"; init: MatchInit; from: number; actions: MatchAction[]; reset: boolean }
  | { t: "wait"; wait: MatchWait }
  /** confirmed inputs of live play `play`, ticks from .. */
  | { t: "ticks"; play: number; from: number; inputs: [UserInput | null, UserInput | null][] }
  /** state checksum after `at` match actions */
  | { t: "sum"; at: number; sum: string }
  | { t: "results"; forfeit: Side | null; rematch: [boolean, boolean] }
  | { t: "pong"; at: number }
  /** ranked: the rating change after the game (season = YYYY-MM) */
  | { t: "rating"; season: string; before: number; after: number; opponent: string };
