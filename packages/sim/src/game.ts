// Full game loop: coach decisions -> engine -> rules, until the final whistle. Deterministic:
// the same rosters + seed always produce the same game (and the same hash).
import type { GameData } from "@tdf/shared";
import * as F from "./fixed.js";
import { hashString, Rng } from "./rng.js";
import {
  applyOutcome, beforeSnap, newGame, other, prepareTry, tryOptions,
  type Foul, type GameEvent, type GameState, type PlayOutcome, type Side,
} from "./rules.js";
import type { Roster } from "./roster.js";
import { chooseScrimmage, chooseTry, tempoFor, timeoutFor } from "./coach.js";
import { simulatePlay, type StatEvent, type Stats } from "./engine/play.js";
import { fieldGoal, kickoff, pat, punt } from "./engine/kicks.js";

const { ONE, fx } = F;

export interface PlayLog {
  n: number; q: number; clock: number; off: Side; down: number; toGo: number; ballOn: number;
  kind: string; name: string; defense?: string; result: string; yards: number; events: GameEvent[];
}

export interface TeamBox {
  score: number; byQuarter: number[];
  plays: number; firstDowns: number; totalYds: number;
  passAtt: number; passComp: number; passYds: number; passTd: number; ints: number; sacksTaken: number; sackYds: number;
  rushAtt: number; rushYds: number; rushTd: number;
  fumblesLost: number; turnovers: number;
  penalties: number; penaltyYds: number;
  thirdAtt: number; thirdConv: number; fourthAtt: number; fourthConv: number;
  fgAtt: number; fgMade: number; fgByDist: Record<string, [number, number]>; patAtt: number; patMade: number; twoAtt: number; twoMade: number;
  punts: number; puntYds: number;
  topTicks: number; sacks: number; defInts: number;
}
export interface PlayerLine { id: number; name: string; team: Side; pos: string; [k: string]: number | string }
export interface GameResult {
  seed: number | string; state: GameState; teams: [TeamBox, TeamBox]; players: PlayerLine[];
  log: PlayLog[]; hash: string; names: [string, string];
}

const emptyBox = (): TeamBox => ({
  score: 0, byQuarter: [], plays: 0, firstDowns: 0, totalYds: 0,
  passAtt: 0, passComp: 0, passYds: 0, passTd: 0, ints: 0, sacksTaken: 0, sackYds: 0,
  rushAtt: 0, rushYds: 0, rushTd: 0, fumblesLost: 0, turnovers: 0, penalties: 0, penaltyYds: 0,
  thirdAtt: 0, thirdConv: 0, fourthAtt: 0, fourthConv: 0,
  fgAtt: 0, fgMade: 0, fgByDist: {}, patAtt: 0, patMade: 0, twoAtt: 0, twoMade: 0, punts: 0, puntYds: 0,
  topTicks: 0, sacks: 0, defInts: 0,
});

export interface GameSetup {
  data: GameData;
  ratings: (id: number) => Stats;
  teams: [Roster, Roster];
  seed: number | string;
  maxPlays?: number;
}

export function playGame(setup: GameSetup): GameResult {
  const { data, ratings, teams } = setup;
  const cfg = data.rules;
  const rng = new Rng(setup.seed);
  let s = newGame(cfg, rng.int(2) as Side);
  const box: [TeamBox, TeamBox] = [emptyBox(), emptyBox()];
  const players = new Map<number, PlayerLine>();
  const log: PlayLog[] = [];
  let ballX = fx(data.tuning.field.width / 2);
  const mid = fx(data.tuning.field.width / 2), hashGap = fx(data.tuning.field.hashHalfGap);
  const hashed = (x: F.Fx) => F.clamp(x, mid - hashGap, mid + hashGap);
  const outcomesForHash: string[] = [];

  const line = (id: number, team: Side): PlayerLine => {
    let p = players.get(id);
    if (!p) {
      const ro = teams[team];
      const c = [...Object.values(ro.starters), ...ro.bench].find((x) => x.id === id);
      p = { id, name: c?.name ?? String(id), team, pos: c?.pos ?? "?" };
      players.set(id, p);
    }
    return p;
  };
  const add = (p: PlayerLine, k: string, v: number) => { p[k] = ((p[k] as number) ?? 0) + v; };
  function recordStats(ev: StatEvent[]) {
    for (const e of ev) {
      const p = line(e.id, e.team), b = box[e.team];
      switch (e.k) {
        case "pass":
          add(p, "passAtt", e.att ?? 0); add(p, "passComp", e.comp ?? 0); add(p, "passYds", e.yds ?? 0); add(p, "passTd", e.td ?? 0);
          b.passAtt += e.att ?? 0; b.passComp += e.comp ?? 0; b.passYds += e.yds ?? 0; b.passTd += e.td ?? 0; break;
        case "rush":
          add(p, "rushAtt", e.att ?? 0); add(p, "rushYds", e.yds ?? 0); add(p, "rushTd", e.td ?? 0);
          b.rushAtt += e.att ?? 0; b.rushYds += e.yds ?? 0; b.rushTd += e.td ?? 0; break;
        case "rec": add(p, "targets", e.target ?? 0); if (e.yds != null) { add(p, "rec", 1); add(p, "recYds", e.yds); add(p, "recTd", e.td ?? 0); } break;
        case "tackle": add(p, "tackles", 1); break;
        case "sack": add(p, "sacks", 1); b.sacks += 1; break;
        case "int": add(p, "defInts", 1); b.defInts += 1; box[other(e.team)].ints += 1; break;
        case "fumbleLost": box[e.team].fumblesLost += 1; break;
        case "defended": add(p, "passesDefended", 1); break;
        default: break;
      }
    }
  }
  const scoreEvents = (events: GameEvent[]) => {
    for (const e of events) if (e.points && e.side != null) {
      const q = Math.min(s.quarter, 5) - 1;
      const bq = box[e.side].byQuarter;
      while (bq.length <= q) bq.push(0);
      bq[q]! += e.points;
    }
  };

  const maxPlays = setup.maxPlays ?? 400;
  let guard = 0;
  while (s.phase !== "final" && guard++ < maxPlays) {
    const off = s.possession, def = other(off);
    const offense = teams[off], defense = teams[def];
    const kin = { data, rng, ratings, kicking: offense, receiving: defense, kickSide: off };
    const before = s;
    let outcome: PlayOutcome;
    let stats: StatEvent[] = [];
    let name = "", defense_ = "", kind = s.phase as string, resultText = "";

    if (s.phase === "kickoff") {
      const k = kickoff(kin, s.freeKickFrom);
      outcome = k.outcome; stats = k.stats; name = "Kickoff"; resultText = k.log.join(", ");
      ballX = mid;
    } else if (s.phase === "try") {
      const choice = chooseTry(s, tryOptions(s, cfg));
      s = prepareTry(s, choice, cfg);
      if (choice === "pat") {
        const k = pat(kin, s.ballOn);
        outcome = k.outcome; name = "Extra point"; resultText = k.log.join(", ");
        box[off].patAtt++; if (outcome.good) box[off].patMade++;
      } else {
        const goal = data.offense.plays.filter((p) => p.weight > 0 && !p.tags.includes("deep"));
        const play = goal[rng.int(goal.length)]!;
        const call = data.defense.calls[rng.int(data.defense.calls.length)]!;
        const r = simulatePlay({ data, ratings, offense, defense, offSide: off, ballOn: s.ballOn, ballX: mid, toGo: s.toGo, play, call, flip: rng.int(2) === 1, rng, twoPoint: true });
        outcome = r.outcome; name = `2-pt: ${play.name}`; defense_ = call.name; resultText = outcome.good ? "converted" : "failed";
        box[off].twoAtt++; if (outcome.good) box[off].twoMade++;
      }
      ballX = mid;
    } else {
      // pre-snap: timeouts and runoff
      const pre = beforeSnap(s, { tempo: tempoFor(s, data), timeoutBy: timeoutFor(s, data) }, cfg);
      box[off].topTicks += before.clock - pre.state.clock > 0 && !pre.quarterEnded ? before.clock - pre.state.clock : 0;
      s = pre.state;
      if (pre.quarterEnded) { log.push(entry(before, "—", "", pre.events.map((e) => e.text ?? e.t).join(", "), 0, pre.events)); continue; }
      const dec = chooseScrimmage(s, offense, defense, data, ratings, rng);
      if (dec.kind === "punt") {
        const k = punt(kin, s.ballOn);
        outcome = k.outcome; name = "Punt"; resultText = k.log.join(", ");
        box[off].punts++; box[off].puntYds += Math.round(F.min(outcome.endY, fx(100)) / ONE - s.ballOn / ONE);
        ballX = mid;
      } else if (dec.kind === "fieldGoal") {
        const k = fieldGoal(kin, s.ballOn);
        outcome = k.outcome; name = `${k.dist}-yd field goal`; resultText = k.log.join(", ");
        box[off].fgAtt++; if (outcome.good) box[off].fgMade++;
        const bucket = k.dist < 30 ? "<30" : k.dist < 40 ? "30-39" : k.dist < 50 ? "40-49" : "50+";
        const fb = (box[off].fgByDist[bucket] ??= [0, 0]); fb[1]++; if (outcome.good) fb[0]++;
        ballX = mid;
      } else if (dec.kind === "kneel") {
        outcome = { play: "kneel", endY: s.ballOn - ONE, elapsedTicks: 2 * cfg.tickHz };
        name = "Kneel"; resultText = "QB kneels";
        recordStats([{ k: "rush", id: offense.starters.QB!.id, team: off, att: 1, yds: -1 }]);
      } else if (dec.kind === "spike") {
        outcome = { play: "spike", endY: s.ballOn, incomplete: true, elapsedTicks: cfg.tickHz };
        name = "Spike"; resultText = "spiked";
      } else {
        const preFoul = preSnapFoul(s, offense, defense, data, ratings, rng);
        if (preFoul) {
          outcome = { play: "scrimmage", endY: s.ballOn, elapsedTicks: 0, foul: preFoul };
          name = dec.play.name; resultText = `${preFoul.name}`;
        } else {
          const r = simulatePlay({ data, ratings, offense, defense, offSide: off, ballOn: s.ballOn, ballX, toGo: s.toGo, play: dec.play, call: dec.call, flip: dec.flip, rng });
          outcome = r.outcome; stats = r.stats; name = dec.play.name; defense_ = dec.call.name;
          resultText = r.log.slice(-2).join("; ");
          ballX = hashed(r.endX);
          box[off].plays++;
          if (s.down === 3) box[off].thirdAtt++;
          if (s.down === 4) box[off].fourthAtt++;
        }
      }
    }

    const wasDown = s.down, wasPhase = s.phase, wasBallOn = s.ballOn;
    const step = applyOutcome(s, outcome, cfg);
    if (wasPhase === "play" && outcome.play !== "kickoff") box[off].topTicks += Math.min(outcome.elapsedTicks, s.clock);
    // accepted penalties
    for (const e of step.events) if (e.t === "penalty" && outcome.foul && e.side != null) {
      const guilty = other(e.side);
      box[guilty].penalties++;
      box[guilty].penaltyYds += outcome.foul.spotY != null ? Math.max(0, Math.round((outcome.foul.spotY - wasBallOn) / ONE)) : outcome.foul.yards;
    }
    const accepted = step.events.some((e) => e.t === "penalty");
    if (!accepted || outcome.foul?.kind !== "live") recordStats(stats);
    else if (outcome.foul?.on === "D") recordStats(stats.filter((x) => x.k === "tackle")); // play stats wiped by the foul
    for (const e of step.events) {
      if (e.t === "firstDown" && e.side === off) {
        box[off].firstDowns++;
        if (wasDown === 3) box[off].thirdConv++;
        if (wasDown === 4) box[off].fourthConv++;
      }
      if (e.t === "touchdown" && e.side === off && wasPhase === "play") {
        if (wasDown === 3) box[off].thirdConv++;
        if (wasDown === 4) box[off].fourthConv++;
      }
    }
    const sack = stats.some((x) => x.k === "sack");
    if (sack && !accepted) { box[off].sacksTaken++; box[off].sackYds += Math.round((wasBallOn - outcome.endY) / ONE); }
    scoreEvents(step.events);
    outcomesForHash.push(`${outcome.play}:${outcome.endY}:${outcome.elapsedTicks}:${outcome.good ? 1 : 0}:${outcome.turnover ?? ""}`);
    const gained = outcome.incomplete || outcome.play === "kickoff" || outcome.play === "punt" ? 0 : Math.round((outcome.endY - wasBallOn) / ONE);
    log.push(entry(before, name, defense_, resultText + (step.events.length ? " [" + step.events.map((e) => e.text ?? e.t).join(", ") + "]" : ""), gained, step.events, kind));
    s = step.state;
  }

  for (const side of [0, 1] as Side[]) {
    const b = box[side];
    b.score = s.score[side];
    b.totalYds = b.passYds - b.sackYds + b.rushYds;
    b.turnovers = b.ints + b.fumblesLost;
  }
  const hash = hashString(JSON.stringify([s, outcomesForHash])).toString(16).padStart(8, "0");
  return { seed: setup.seed, state: s, teams: box, players: [...players.values()], log, hash, names: [teams[0].info.abbr, teams[1].info.abbr] };

  function entry(st: GameState, nm: string, dname: string, result: string, yards: number, events: GameEvent[], kind2 = "play"): PlayLog {
    return { n: log.length + 1, q: st.quarter, clock: st.clock, off: st.possession, down: st.down, toGo: Math.round(st.toGo / ONE),
      ballOn: Math.round(st.ballOn / ONE), kind: kind2, name: nm, defense: dname, result, yards, events };
  }
}

/** False starts / offsides, rolled before the snap from line awareness. */
function preSnapFoul(s: GameState, offense: Roster, defense: Roster, data: GameData, ratings: (id: number) => Stats, rng: Rng): Foul | null {
  const P = data.tuning.penalties;
  const avg = (ro: Roster, slots: string[]) => slots.reduce((a, sl) => a + (ratings(ro.starters[sl]!.id).awareness ?? 60), 0) / slots.length;
  const olAw = avg(offense, ["LT", "LG", "C", "RG", "RT"]);
  const dlAw = avg(defense, ["DE1", "DT1", "DT2", "DE2"]);
  const loud = s.quarter >= 4 ? 1.2 : 1;
  if (rng.int(1000) < (P.falseStart.perMille + (P.falseStart.awarenessPer ?? 0) * (70 - olAw)) * loud) return { name: "False start", on: "O", yards: P.falseStart.yards ?? 5, kind: "preSnap" };
  if (rng.int(1000) < P.offside.perMille + (P.offside.awarenessPer ?? 0) * (70 - dlAw)) return { name: "Offside", on: "D", yards: P.offside.yards ?? 5, kind: "preSnap" };
  return null;
}
