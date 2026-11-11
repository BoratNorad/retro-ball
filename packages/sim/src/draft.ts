// Triple Draft engine (M7). Deterministic from (seed, settings, actions): every offer, reroll and AI
// pick comes from the draft's own Rng, so a draft can be replayed (and later run on a server).
//
// Each round both teams get three private offers. A team picks one and puts him in an open slot
// (or lets the engine pick the best open fit). When both have picked, both picks are revealed.
import type { GameData, PlayerCard } from "@tdf/shared";
import { slotOverall } from "./cards.js";
import { teamGrade, type Lineup, type TeamGrade } from "./grade.js";
import { Rng } from "./rng.js";
import { rosterFromLineup, slotPos, type Roster, type TeamInfo } from "./roster.js";

import type { Side } from "./rules.js";
export type Personality = "best" | "need" | "stacker" | "chaos";
export interface DraftSettings {
  format: "quick" | "full";
  /** both teams see the same three options; a priority token settles a double pick */
  mirror: boolean;
  /** show what each team passed on in the reveal and the draft log */
  revealPassed: boolean;
  /** themed rounds: one NFL team, one division, or young players */
  themed: boolean;
  eliteCap: number;
  rerolls: number;
}
export interface DraftTeamSetup { info: TeamInfo; ai?: Personality }
export interface Theme { kind: "team" | "division" | "rookie"; value: string; label: string }
export interface DraftPick {
  round: number; side: Side; card: PlayerCard; slot: string; passed: PlayerCard[];
  overallAtSlot: number; gradeBefore: number; gradeAfter: number; auto: boolean; lostTie?: boolean;
}
export interface DraftTeam {
  setup: DraftTeamSetup;
  /** draft slot key (QB, WR#1, DE#2, BN#3...) -> player */
  slots: Record<string, PlayerCard | null>;
  rerolls: number;
  elites: number;
  picks: DraftPick[];
}
export interface RoundReveal { round: number; picks: [DraftPick, DraftPick]; theme: Theme | null; priority: Side | null }

/** Draft slot keys for a format: repeated positions get #n (WR#1..WR#3), bench BN#1.. */
export function draftSlots(data: GameData, format: "quick" | "full"): string[] {
  const seen: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const s of data.draft.quick.slots) counts[s] = (counts[s] ?? 0) + 1;
  const keys = data.draft.quick.slots.map((s) => {
    if (counts[s]! === 1) return s;
    seen[s] = (seen[s] ?? 0) + 1;
    return `${s}#${seen[s]}`;
  });
  if (format === "full") for (let i = 1; i <= data.draft.full.benchSlots; i++) keys.push(`BN#${i}`);
  return keys;
}
/** The position a draft slot is played at (bench: none). */
export const slotBasePos = (key: string) => key.replace(/#\d+$/, "");
/** Draft slot -> roster slot (WR#1 -> WR1, DE#2 -> DE2, OLB#1 -> OLB1, ...). */
export function rosterSlotFor(key: string): string {
  const m = /^([A-Z]+)#(\d+)$/.exec(key);
  return m ? `${m[1]}${m[2]}` : key;
}

export const defaultDraftSettings = (data: GameData): DraftSettings => ({
  format: "quick", mirror: data.draft.mirrorDefault, revealPassed: data.draft.revealPassedDefault, themed: false,
  eliteCap: data.draft.eliteCapPerTeam, rerolls: data.draft.rerollsPerDraft,
});

export class Draft {
  readonly data: GameData;
  readonly settings: DraftSettings;
  readonly teams: [DraftTeam, DraftTeam];
  readonly slotKeys: string[];
  readonly log: RoundReveal[] = [];
  round = 1;
  /** mirror mode: who wins a double pick this round */
  priority: Side;
  theme: Theme | null = null;
  private readonly rng: Rng;
  private readonly available: Map<number, PlayerCard>;
  private offerSets: [PlayerCard[], PlayerCard[]] = [[], []];
  private pending: [{ card: PlayerCard; slot: string | null; auto: boolean } | null, { card: PlayerCard; slot: string | null; auto: boolean } | null] = [null, null];
  private readonly pool: readonly PlayerCard[];
  private readonly divOf: Map<string, string>;

  constructor(data: GameData, pool: readonly PlayerCard[], setups: [DraftTeamSetup, DraftTeamSetup], seed: number | string, settings: Partial<DraftSettings> = {}) {
    this.data = data;
    this.pool = pool;
    this.settings = { ...defaultDraftSettings(data), ...settings };
    this.rng = new Rng(seed);
    this.slotKeys = draftSlots(data, this.settings.format);
    const mkTeam = (s: DraftTeamSetup): DraftTeam => ({ setup: s, slots: Object.fromEntries(this.slotKeys.map((k) => [k, null])), rerolls: this.settings.rerolls, elites: 0, picks: [] });
    this.teams = [mkTeam(setups[0]), mkTeam(setups[1])];
    this.available = new Map(pool.filter((c) => c.ovr > 0).map((c) => [c.id, c]));
    this.divOf = new Map(data.teams.teams.map((t) => [t.abbr, (t as { div?: string }).div ?? ""]));
    this.priority = this.rng.int(2) as Side;
    this.dealRound();
  }

  get rounds() { return this.slotKeys.length; }
  get done() { return this.round > this.rounds; }
  offers(side: Side): readonly PlayerCard[] { return this.offerSets[side]; }
  hasPicked(side: Side) { return this.pending[side] !== null; }
  openSlots(side: Side): string[] { return this.slotKeys.filter((k) => !this.teams[side].slots[k]); }
  /** a team's lineup so far (roster slot names) */
  lineup(side: Side): Lineup {
    const l: Lineup = {};
    for (const [k, c] of Object.entries(this.teams[side].slots)) if (c && !k.startsWith("BN")) l[rosterSlotFor(k)] = c;
    return l;
  }
  grade(side: Side): TeamGrade { return teamGrade(this.lineup(side), this.data); }

  /** Overall a player would have in a slot (out-of-position penalty included); bench = his best. */
  overallIn(c: PlayerCard, key: string): number {
    if (key.startsWith("BN")) return c.ovr;
    return slotOverall(c, slotPos(slotBasePos(key)), this.data);
  }
  private fits(c: PlayerCard, key: string) {
    if (key.startsWith("BN")) return true;
    return this.overallIn(c, key) >= this.data.draft.viability.minOverallAtSlot;
  }
  /** The open slot where this player helps the team grade most (auto-assign). */
  bestSlot(side: Side, c: PlayerCard): string {
    const open = this.openSlots(side);
    const base = this.grade(side).overall.score;
    let best = open[0]!, bv = -1e9;
    for (const k of open) {
      let v: number;
      if (k.startsWith("BN")) v = -50 + c.ovr / 10; // the bench only when nothing fits
      else {
        const l = { ...this.lineup(side), [rosterSlotFor(k)]: c };
        v = teamGrade(l, this.data).overall.score - base + this.overallIn(c, k) / 1000;
      }
      if (v > bv) { bv = v; best = k; }
    }
    return best;
  }

  // ---------------------------------------------------------------- offers
  private pickTheme(): Theme | null {
    if (!this.settings.themed || this.round % this.data.draft.themedEvery !== 0) return null;
    const kinds: Theme["kind"][] = ["team", "division", "rookie"];
    const kind = kinds[this.rng.int(kinds.length)]!;
    if (kind === "rookie") return { kind, value: String(this.data.draft.rookieMaxAge), label: `Young guns (age ${this.data.draft.rookieMaxAge} and under)` };
    if (kind === "team") { const t = this.data.teams.teams[this.rng.int(this.data.teams.teams.length)]!; return { kind, value: t.abbr, label: `${t.name} round` }; }
    const divs = [...new Set(this.divOf.values())].filter(Boolean).sort();
    const d = divs[this.rng.int(divs.length)]!;
    return { kind, value: d, label: `${d} round` };
  }
  private inTheme(c: PlayerCard, th: Theme | null) {
    if (!th) return true;
    if (th.kind === "team") return c.team === th.value;
    if (th.kind === "division") return this.divOf.get(c.team) === th.value;
    return c.age <= Number(th.value);
  }
  private dealFor(side: Side, exclude: Set<number>): PlayerCard[] {
    const D = this.data.draft;
    const team = this.teams[side];
    const open = this.openSlots(side);
    const benchOpen = open.some((k) => k.startsWith("BN"));
    const starterOpen = open.filter((k) => !k.startsWith("BN"));
    const late = starterOpen.length <= D.lateOpenSlots && !benchOpen;
    let cands = [...this.available.values()].filter((c) => !exclude.has(c.id) && (team.elites < this.settings.eliteCap || c.tier !== "ELITE"));
    const themed = this.theme ? cands.filter((c) => this.inTheme(c, this.theme) && (benchOpen || starterOpen.some((k) => this.fits(c, k)))) : [];
    if (themed.length >= D.themeMinPool) cands = themed;
    const fitsOpen = (c: PlayerCard) => starterOpen.some((k) => this.fits(c, k));
    const tierCount: Record<string, number> = {};
    for (const c of cands) tierCount[c.tier] = (tierCount[c.tier] ?? 0) + 1;
    const weightOf = (c: PlayerCard) => {
      const tw = (D.tierWeights[c.tier] ?? 1) / Math.max(1, tierCount[c.tier] ?? 1);
      const f = fitsOpen(c) ? D.needWeight : benchOpen ? 1 : D.uselessWeight;
      return Math.max(1, Math.round(tw * f * 1e6));
    };
    const out: PlayerCard[] = [];
    const draw = (list: PlayerCard[]) => {
      const usable = list.filter((c) => !out.includes(c));
      if (!usable.length) return null;
      const w = usable.map(weightOf);
      return usable[this.rng.weighted(w)]!;
    };
    const fitting = cands.filter(fitsOpen);
    for (let k = 0; k < D.optionsPerRound; k++) {
      const c = draw(late && fitting.length ? fitting : cands);
      if (c) out.push(c);
    }
    // always at least one player who fits an open starting slot
    if (starterOpen.length && !out.some(fitsOpen) && fitting.length) {
      const c = draw(fitting);
      if (c) out[out.length - 1] = c;
    }
    return out;
  }
  private dealRound() {
    if (this.done) { this.offerSets = [[], []]; return; }
    this.theme = this.pickTheme();
    const a = this.dealFor(0, new Set());
    const b = this.settings.mirror ? a : this.dealFor(1, new Set(a.map((c) => c.id)));
    this.offerSets = [a, b];
    this.pending = [null, null];
  }

  /** Redraw all three options (counts against the team's rerolls). Mirror mode: both teams get the new set. */
  reroll(side: Side): boolean {
    const t = this.teams[side];
    if (t.rerolls <= 0 || this.pending[side]) return false;
    t.rerolls--;
    const other = (1 - side) as Side;
    const ex = new Set([...this.offerSets[side], ...(this.settings.mirror ? [] : this.offerSets[other])].map((c) => c.id));
    const fresh = this.dealFor(side, ex);
    if (this.settings.mirror) { this.offerSets = [fresh, fresh]; this.pending = [null, null]; }
    else this.offerSets[side] = fresh;
    return true;
  }

  /** Lock in a pick. slot = null: best open fit. Returns the reveal once both teams have picked. */
  pick(side: Side, cardId: number, slot: string | null = null, auto = false): RoundReveal | null {
    if (this.done) throw new Error("draft is over");
    const card = this.offerSets[side].find((c) => c.id === cardId);
    if (!card) throw new Error(`player ${cardId} is not on offer`);
    if (slot && (this.teams[side].slots[slot] !== null || !this.slotKeys.includes(slot))) throw new Error(`slot ${slot} is not open`);
    this.pending[side] = { card, slot, auto };
    if (this.pending[0] && this.pending[1]) return this.resolve();
    return null;
  }

  private resolve(): RoundReveal {
    const p = this.pending as [{ card: PlayerCard; slot: string | null; auto: boolean }, { card: PlayerCard; slot: string | null; auto: boolean }];
    let lostTie: Side | null = null;
    if (p[0].card.id === p[1].card.id) {
      // mirror mode: the priority token wins; the other team takes the better of its two remaining options
      const loser = (1 - this.priority) as Side;
      const rest = this.offerSets[loser].filter((c) => c.id !== p[0].card.id).sort((a, b) => b.ovr - a.ovr || a.id - b.id);
      p[loser] = { card: rest[0]!, slot: null, auto: true };
      lostTie = loser;
    }
    const picks = ([0, 1] as Side[]).map((side) => {
      const t = this.teams[side];
      const { card, auto } = p[side];
      const slot = p[side].slot ?? this.bestSlot(side, card);
      const before = this.grade(side).overall.score;
      t.slots[slot] = card;
      if (card.tier === "ELITE") t.elites++;
      this.available.delete(card.id);
      const after = this.grade(side).overall.score;
      const pk: DraftPick = { round: this.round, side, card, slot, passed: this.offerSets[side].filter((c) => c.id !== card.id),
        overallAtSlot: this.overallIn(card, slot), gradeBefore: before, gradeAfter: after, auto, lostTie: lostTie === side || undefined };
      t.picks.push(pk);
      return pk;
    }) as [DraftPick, DraftPick];
    const rev: RoundReveal = { round: this.round, picks, theme: this.theme, priority: this.settings.mirror ? this.priority : null };
    this.log.push(rev);
    this.round++;
    this.priority = (1 - this.priority) as Side;
    this.dealRound();
    return rev;
  }

  // ---------------------------------------------------------------- AI drafters
  /** What an AI drafter (or the pick timer) would do: maybe reroll, then a pick and a slot. */
  aiChoice(side: Side, personality: Personality, mayReroll = true): { cardId: number; slot: string | null } {
    const D = this.data.draft;
    const offers = this.offerSets[side];
    const open = this.openSlots(side);
    const base = this.grade(side).overall.score;
    const lineup = this.lineup(side);
    const score = (c: PlayerCard, k: string) => {
      if (k.startsWith("BN")) return { v: c.ovr / 20 - 3, grade: 0 };
      const g = teamGrade({ ...lineup, [rosterSlotFor(k)]: c }, this.data).overall.score - base;
      let v = personality === "best" ? this.overallIn(c, k) / 10 : g;
      if (personality === "stacker") {
        const mates = Object.values(lineup).filter((x) => x.team === c.team).length;
        v += mates * D.ai.stackerBonus;
      }
      return { v, grade: g };
    };
    if (personality === "chaos") {
      const c = offers[this.rng.int(offers.length)]!;
      const fits = open.filter((k) => this.fits(c, k));
      return { cardId: c.id, slot: fits.length ? fits[this.rng.int(fits.length)]! : null };
    }
    let best = { cardId: offers[0]!.id, slot: null as string | null, v: -1e9, ovr: 0 };
    for (const c of offers) for (const k of open) {
      const s = score(c, k);
      if (s.v > best.v) best = { cardId: c.id, slot: k, v: s.v, ovr: this.overallIn(c, k) };
    }
    if (mayReroll && best.ovr < D.ai.rerollBelow && this.teams[side].rerolls > 0 && !this.hasPicked(side) && this.reroll(side)) return this.aiChoice(side, personality, false);
    return { cardId: best.cardId, slot: best.slot };
  }
  /** Let the AI (or the expired pick timer) pick for a side. */
  autoPick(side: Side, personality: Personality = "need"): RoundReveal | null {
    const c = this.aiChoice(side, personality, personality !== "need" || this.teams[side].setup.ai !== undefined);
    return this.pick(side, c.cardId, c.slot, true);
  }

  // ---------------------------------------------------------------- after the draft
  /** Backups (Quick Draft): undrafted real players at a lower tier, natural at the position. */
  private backups(side: Side, exclude: Set<number>): PlayerCard[] {
    const D = this.data.draft;
    const need = ["QB", "RB", "RB", "FB", "WR", "WR", "TE", "TE", "LT", "LG", "C", "DE", "DT", "DT", "OLB", "MLB", "MLB", "CB", "CB", "CB", "FS", "SS", "LS"];
    const rng = new Rng(`${this.data.draft.optionsPerRound}:${side}:${this.teams[side].picks.map((p) => p.card.id).join(",")}`);
    const out: PlayerCard[] = [];
    for (const pos of need) {
      const c = this.pool.filter((x) => !exclude.has(x.id) && x.natural[0] === pos && x.ovr <= D.backupMaxOvr)
        .sort((a, b) => b.ovr - a.ovr || a.id - b.id).slice(0, D.backupTopN);
      if (!c.length) continue;
      const pick = c[rng.int(c.length)]!;
      exclude.add(pick.id);
      out.push(pick);
    }
    return out;
  }
  /** The finished team as a game roster (starters from the draft; bench picks + generated backups). */
  toRoster(side: Side): Roster {
    const t = this.teams[side];
    const starters: Record<string, PlayerCard> = {};
    const bench: PlayerCard[] = [];
    for (const [k, c] of Object.entries(t.slots)) {
      if (!c) continue;
      if (k.startsWith("BN")) bench.push(c); else starters[rosterSlotFor(k)] = c;
    }
    const exclude = new Set<number>([...this.teams[0].picks, ...this.teams[1].picks].map((p) => p.card.id));
    // the other team's backups must not overlap: derive them in side order
    if (side === 1) for (const c of this.backups(0, new Set(exclude))) exclude.add(c.id);
    bench.push(...this.backups(side, exclude));
    return rosterFromLineup(t.setup.info, starters, bench, this.data);
  }
}

/** Predicted spread: average margin (a minus b) over n quick AI-vs-AI games, home field alternating. */
export function predictSpread(data: GameData, ratings: (id: number) => import("./engine/play.js").Stats, a: Roster, b: Roster, n: number, seed: string,
  play: (setup: { data: GameData; ratings: (id: number) => import("./engine/play.js").Stats; teams: [Roster, Roster]; seed: string }) => { state: { score: [number, number] } }): { margin: number; winPct: number } {
  let m = 0, w = 0;
  for (let i = 0; i < n; i++) {
    const flip = i % 2 === 1;
    const r = play({ data, ratings, teams: flip ? [b, a] : [a, b], seed: `${seed}:${i}` });
    const d = flip ? r.state.score[1] - r.state.score[0] : r.state.score[0] - r.state.score[1];
    m += d; if (d > 0) w++; else if (d === 0) w += 0.5;
  }
  return { margin: m / Math.max(1, n), winPct: (100 * w) / Math.max(1, n) };
}
