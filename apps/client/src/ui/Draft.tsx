// Triple Draft screens (M7): setup, the draft board, reveals, hot-seat privacy, post-draft comparison
// with a simulated spread, and the lineup builder / depth chart.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PlayerCard } from "@tdf/shared";
import {
  Draft, benchIn, playGame, predictSpread, slotBasePos, slotOverall, slotPos, swapSlots, teamGrade,
  type DraftPick, type OffenseStyle, type Personality, type RoundReveal, type Roster, type TeamInfo,
} from "@tdf/sim";
import type { ClientData } from "../data.js";
import { helmetCanvas } from "../render/sprites.js";
import { AbilitiesToggle } from "./AbilitiesToggle.js";
import { audio } from "../audio/audio.js";

// ---------------------------------------------------------------- shared bits
export const PALETTES: [string, string, string][] = [
  ["#1d4fa0", "#ffffff", "#ffc82e"], ["#b3122e", "#ffffff", "#111111"], ["#1f6b3a", "#f2e9d0", "#d8a72c"], ["#4b2a83", "#ffffff", "#e8b62c"],
  ["#111111", "#ffb612", "#ffffff"], ["#e06a1a", "#ffffff", "#1b1b1b"], ["#0e7c86", "#ffffff", "#ff7a3d"], ["#7a1e2c", "#e6c36a", "#ffffff"],
];
const PERSONALITIES: { id: Personality; name: string; desc: string }[] = [
  { id: "best", name: "Best Available", desc: "takes the highest-rated man" },
  { id: "need", name: "Need-Based", desc: "maximises its team grade" },
  { id: "stacker", name: "Team Stacker", desc: "chases real-life teammates (chemistry)" },
  { id: "chaos", name: "Chaos", desc: "anything goes" },
];
const TIER_COLOR: Record<string, string> = { ELITE: "#ffd23e", PRO_BOWL: "#7fd6ff", STARTER: "#9be07f", DEPTH: "#9aa3b5" };
const TIER_NAME: Record<string, string> = { ELITE: "ELITE", PRO_BOWL: "PRO BOWL", STARTER: "STARTER", DEPTH: "DEPTH" };

export interface TeamSetup { info: TeamInfo; icon: string }
export function Icon({ cd, id, color, size = 24 }: { cd: ClientData; id: string; color: string; size?: number }) {
  const src = useMemo(() => {
    const rows = (cd.data.icons.icons as Record<string, string[]>)[id] ?? [];
    const c = document.createElement("canvas");
    c.width = 12; c.height = 12;
    const g = c.getContext("2d")!;
    const pal: Record<string, string> = { k: "#000000", "1": color, "2": "#ffffff", "3": "#00000088" };
    rows.forEach((r, y) => [...r].forEach((ch, x) => { if (pal[ch]) { g.fillStyle = pal[ch]!; g.fillRect(x, y, 1, 1); } }));
    return c.toDataURL();
  }, [id, color]);
  return <img src={src} width={size} height={size} style={{ imageRendering: "pixelated" }} alt="" />;
}
function Helmet({ cd, abbr }: { cd: ClientData; abbr: string }) {
  const t = cd.data.teams.teams.find((x) => x.abbr === abbr);
  const src = useMemo(() => (t ? helmetCanvas({ abbr: t.abbr, c1: t.c1, c2: t.c2, c3: t.c3 }, 3).toDataURL() : ""), [abbr]);
  return src ? <img class="helmet" src={src} alt={abbr} /> : null;
}

export function PlayerCardView({ cd, c, ovr, slotLabel, selected, onClick, small }: {
  cd: ClientData; c: PlayerCard; ovr?: number; slotLabel?: string; selected?: boolean; onClick?: () => void; small?: boolean;
}) {
  const r = cd.ratings(c.id);
  const key = c.group === "QB" ? [["THP", "throwPower"], ["ACC", "throwAccuracyMid"], ["AWR", "awareness"]]
    : ["RB", "WR", "TE"].includes(c.group) ? [["SPD", "speed"], ["CTH", "catching"], ["AGI", "agility"]]
    : c.group === "OL" ? [["PBK", "passBlock"], ["RBK", "runBlock"], ["STR", "strength"]]
    : ["K", "P"].includes(c.group) ? [["KPW", "kickPower"], ["KAC", "kickAccuracy"], ["AWR", "awareness"]]
    : ["DL", "LB"].includes(c.group) ? [["BSH", "blockShedding"], ["TAK", "tackle"], ["SPD", "speed"]]
    : [["SPD", "speed"], ["MCV", "manCoverage"], ["ZCV", "zoneCoverage"]];
  return (
    <button class={`card ${selected ? "sel" : ""} ${small ? "small" : ""}`} style={{ borderColor: TIER_COLOR[c.tier] }} onClick={onClick && (() => { audio.play("card"); onClick(); })}>
      <div class="ctop"><Helmet cd={cd} abbr={c.team} /><span class="cpos">{c.pos}</span><span class="covr">{ovr ?? c.ovr}</span></div>
      <b class="cname">{c.name}</b>
      <small class="ctier" style={{ color: TIER_COLOR[c.tier] }}>{TIER_NAME[c.tier] ?? c.tier} · {c.team} #{c.num ?? "-"}</small>
      {!small && <small class="carch">{c.arch} · {Math.floor(c.htIn / 12)}'{c.htIn % 12}" {c.wt} · {c.age}y</small>}
      {!small && <div class="crat">{key.map(([l, k]) => <span>{l} <b>{r[k!] ?? "-"}</b></span>)}</div>}
      {!small && c.abilities.length > 0 && <div class="cab">{c.abilities.slice(0, 2).map((a) => <span>{abilityName(cd, a.id)}</span>)}</div>}
      {slotLabel && <small class="cslot">{slotLabel}</small>}
    </button>
  );
}
/** Last name for tight spots (skips Jr / II / III ...). */
export const shortName = (n: string) => {
  const parts = n.split(" ");
  let last = parts.pop() ?? n;
  if (/^(Jr\.?|Sr\.?|II|III|IV|V)$/.test(last) && parts.length) last = parts.pop()!;
  return last;
};
const abilityName = (cd: ClientData, id: string) => cd.data.abilities.abilities.find((a) => a.id === id)?.name ?? id;

// ---------------------------------------------------------------- setup
export interface DraftConfigUi {
  mode: "ai" | "hotseat"; teams: [TeamSetup, TeamSetup]; ai: Personality;
  format: "quick" | "full"; mirror: boolean; revealPassed: boolean; themed: boolean; timer: boolean; quarter: number;
}
/** Team name (abbreviation derived), colours and logo. */
export function TeamEditor({ cd, t, set, label }: { cd: ClientData; t: TeamSetup; set: (t: TeamSetup) => void; label: string }) {
  const icons = Object.keys(cd.data.icons.icons);
  return (
    <div class="teamsetup">
      <div class="lbl">{label}</div>
      <div class="row">
        <Icon cd={cd} id={t.icon} color={t.info.c1} size={36} />
        <input class="search" value={t.info.name} maxLength={20} onInput={(e) => {
          const name = (e.target as HTMLInputElement).value;
          const abbr = (name.replace(/[^A-Za-z]/g, "").slice(0, 3) || "TM").toUpperCase();
          set({ ...t, info: { ...t.info, name, nick: name.split(" ").pop() || name, abbr } });
        }} />
      </div>
      <div class="row">{PALETTES.map(([a, b, c]) => <button class={`swatch ${t.info.c1 === a ? "on" : ""}`} style={{ background: a, borderColor: b }} onClick={() => set({ ...t, info: { ...t.info, c1: a, c2: b, c3: c } })} />)}</div>
      <div class="row icons">{icons.map((id) => <button class={`chip ${t.icon === id ? "on" : ""}`} onClick={() => set({ ...t, icon: id })}><Icon cd={cd} id={id} color={t.info.c1} size={18} /></button>)}</div>
    </div>
  
  );
}

export function DraftSetup({ cd, mode, onStart, onBack }: { cd: ClientData; mode: "ai" | "hotseat"; onStart: (c: DraftConfigUi) => void; onBack: () => void }) {
  const icons = Object.keys(cd.data.icons.icons);
  const [t1, setT1] = useState<TeamSetup>({ info: { abbr: "YOU", name: "Your Team", nick: "Team", c1: PALETTES[0]![0], c2: PALETTES[0]![1], c3: PALETTES[0]![2] }, icon: icons[0]! });
  const [t2, setT2] = useState<TeamSetup>({ info: { abbr: mode === "ai" ? "CPU" : "P2", name: mode === "ai" ? "Computer" : "Player 2", nick: "Team", c1: PALETTES[1]![0], c2: PALETTES[1]![1], c3: PALETTES[1]![2] }, icon: icons[1] ?? icons[0]! });
  const [ai, setAi] = useState<Personality>("need");
  const [format, setFormat] = useState<"quick" | "full">("quick");
  const [mirror, setMirror] = useState(cd.data.draft.mirrorDefault);
  const [revealPassed, setReveal] = useState(cd.data.draft.revealPassedDefault);
  const [themed, setThemed] = useState(false);
  const [timer, setTimer] = useState(true);
  const [quarter, setQuarter] = useState(5);
  const teamEditor = (t: TeamSetup, set: (t: TeamSetup) => void, label: string) => <TeamEditor cd={cd} t={t} set={set} label={label} />;
  return (
    <div class="menu">
      <h1>TRIPLE <span>DRAFT</span></h1>
      <div class="sub">{mode === "ai" ? "VS THE COMPUTER" : "HOT-SEAT · TWO PLAYERS, ONE DEVICE"}</div>
      {teamEditor(t1, setT1, mode === "ai" ? "YOUR TEAM" : "PLAYER 1")}
      {mode === "hotseat" ? teamEditor(t2, setT2, "PLAYER 2") : (
        <div class="teamsetup"><div class="lbl">AI DRAFTER</div>
          <div class="plays">{PERSONALITIES.map((p) => <button class={`play ${ai === p.id ? "on" : ""}`} onClick={() => setAi(p.id)}><b>{p.name}</b><small>{p.desc}</small></button>)}</div>
        </div>
      )}
      <div class="row"><span class="lbl">FORMAT</span>
        <button class={`chip ${format === "quick" ? "on" : ""}`} onClick={() => setFormat("quick")}>QUICK · 24</button>
        <button class={`chip ${format === "full" ? "on" : ""}`} onClick={() => setFormat("full")}>FULL · 32 (+BENCH)</button></div>
      <div class="row"><span class="lbl">RULES</span>
        <button class={`chip ${mirror ? "on" : ""}`} onClick={() => setMirror(!mirror)}>MIRROR</button>
        <button class={`chip ${revealPassed ? "on" : ""}`} onClick={() => setReveal(!revealPassed)}>REVEAL PASSED</button>
        <button class={`chip ${themed ? "on" : ""}`} onClick={() => setThemed(!themed)}>THEMED ROUNDS</button>
        <button class={`chip ${timer ? "on" : ""}`} onClick={() => setTimer(!timer)}>PICK TIMER {cd.data.draft.pickTimerSec}s</button></div>
      <div class="row"><span class="lbl">QUARTER</span>{[3, 5, 8, 15].map((m) => <button class={`chip ${quarter === m ? "on" : ""}`} onClick={() => setQuarter(m)}>{m} MIN</button>)}</div>
      <AbilitiesToggle />
      <div class="row">
        <button class="chip" onClick={onBack}>BACK</button>
        <button class="big" onClick={() => onStart({ mode, teams: [t1, mode === "ai" ? { ...t2, info: { ...t2.info, name: `CPU ${PERSONALITIES.find((p) => p.id === ai)!.name}` } } : t2], ai, format, mirror, revealPassed, themed, timer, quarter })}>START DRAFT</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the draft
const BOARD: { title: string; rows: string[][] }[] = [
  { title: "OFFENSE", rows: [["WR#1", "LT", "LG", "C", "RG", "RT", "TE", "WR#2"], ["WR#3", "QB", "RB"]] },
  { title: "DEFENSE", rows: [["DE#1", "DT#1", "DT#2", "DE#2"], ["OLB#1", "MLB", "OLB#2"], ["CB#1", "FS", "SS", "CB#2"]] },
  { title: "SPECIAL", rows: [["K", "P"]] },
];
export function SlotBoard({ d, side, card, onSlot }: { d: Draft; side: 0 | 1; card: PlayerCard | null; onSlot: (k: string) => void }) {
  const t = d.teams[side];
  const bench = d.slotKeys.filter((k) => k.startsWith("BN"));
  const cell = (k: string) => {
    const p = t.slots[k];
    const open = !p;
    const v = card && open ? d.overallIn(card, k) : null;
    const nat = card && open && !k.startsWith("BN") && card.natural.includes(slotPos(slotBasePos(k)));
    return (
      <button class={`slot ${open ? "open" : ""} ${v != null ? (nat ? "nat" : v >= cd_min(d) ? "ok" : "bad") : ""}`} disabled={!open || !card} onClick={() => onSlot(k)}>
        <small>{slotBasePos(k)}</small>
        {p ? <><b>{shortName(p.name)}</b><i>{d.overallIn(p, k)}</i></> : v != null ? <i class="pv">{v}</i> : <i>—</i>}
      </button>
    );
  };
  return (
    <div class="board">
      {BOARD.map((u) => <div class="unit"><div class="lbl">{u.title}</div>{u.rows.map((r) => <div class="brow">{r.map(cell)}</div>)}</div>)}
      {bench.length > 0 && <div class="unit"><div class="lbl">BENCH</div><div class="brow">{bench.map(cell)}</div></div>}
    </div>
  );
}
const cd_min = (d: Draft) => d.data.draft.viability.minOverallAtSlot;

export function GradeChips({ d, side }: { d: Draft; side: 0 | 1 }) {
  const g = d.grade(side);
  return (
    <span class="grades">
      {(["offense", "defense", "special", "overall"] as const).map((u) => <span class="gchip"><small>{u === "special" ? "ST" : u.slice(0, 3).toUpperCase()}</small><b>{g[u].letter}</b></span>)}
    </span>
  );
}

export function DraftScreen({ cd, cfg, onDone }: { cd: ClientData; cfg: DraftConfigUi; onDone: (d: Draft) => void }) {
  const draft = useMemo(() => new Draft(cd.data, cd.pool, [{ info: cfg.teams[0].info }, { info: cfg.teams[1].info, ai: cfg.mode === "ai" ? cfg.ai : undefined }],
    String(Date.now() % 1e9), { format: cfg.format, mirror: cfg.mirror, revealPassed: cfg.revealPassed, themed: cfg.themed }), []);
  const [, setV] = useState(0);
  const bump = () => setV((x) => x + 1);
  const [side, setSide] = useState<0 | 1>(0);
  const [privacy, setPrivacy] = useState<0 | 1 | null>(null);
  const [sel, setSel] = useState<PlayerCard | null>(null);
  const [reveal, setReveal] = useState<RoundReveal | null>(null);
  const [showOpp, setShowOpp] = useState(false);
  const [left, setLeft] = useState(cd.data.draft.pickTimerSec);
  const timerOn = cfg.timer;
  const deadline = useRef(Date.now() + cd.data.draft.pickTimerSec * 1000);
  const resetTimer = () => { deadline.current = Date.now() + cd.data.draft.pickTimerSec * 1000; setLeft(cd.data.draft.pickTimerSec); };

  const afterPick = (rev: RoundReveal | null) => {
    setSel(null);
    if (rev) { setReveal(rev); return; }
    if (cfg.mode === "ai") {
      const r = draft.autoPick(1, cfg.ai);
      if (r) setReveal(r);
    } else { setSide(1); setPrivacy(1); }
    bump();
  };
  const pick = (card: PlayerCard, slot: string | null, auto = false) => afterPick(draft.pick(side, card.id, slot, auto));
  const nextRound = () => {
    setReveal(null);
    if (draft.done) { onDone(draft); return; }
    setSide(0);
    if (cfg.mode === "hotseat") setPrivacy(0);
    resetTimer(); bump();
  };
  useEffect(() => {
    if (!timerOn || reveal || privacy !== null || draft.done) return;
    const id = setInterval(() => {
      const s = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0) { clearInterval(id); afterPick(draft.autoPick(side, "need")); }
    }, 250);
    return () => clearInterval(id);
  }, [side, reveal, privacy, draft.round]);

  if (privacy !== null) {
    const t = cfg.teams[privacy];
    return (
      <div class="center privacy" onClick={() => { setPrivacy(null); resetTimer(); }}>
        <Icon cd={cd} id={t.icon} color={t.info.c1} size={64} />
        <div class="title">PASS THE DEVICE TO</div>
        <h1>{t.info.name.toUpperCase()}</h1>
        <p class="hint">Round {draft.round} of {draft.rounds} · the other player looks away · tap when ready</p>
      </div>
    );
  }
  const me = cfg.teams[side], opp = (1 - side) as 0 | 1;
  const offers = draft.offers(side);
  const team = draft.teams[side];
  return (
    <div class="draft">
      <div class="dhead">
        <span class="dteam"><Icon cd={cd} id={me.icon} color={me.info.c1} /> <b>{me.info.name}</b> <GradeChips d={draft} side={side} /></span>
        <span class="dround">ROUND {Math.min(draft.round, draft.rounds)}/{draft.rounds}{draft.theme ? ` · ${draft.theme.label.toUpperCase()}` : ""}</span>
        {timerOn && <span class={`clock ${left <= cd.data.draft.pickWarningSec ? "low" : ""}`}>{left}</span>}
      </div>
      <div class="offers">
        {offers.map((c) => {
          const best = draft.bestSlot(side, c);
          return <PlayerCardView cd={cd} c={c} ovr={draft.overallIn(c, best)} slotLabel={`best fit: ${slotBasePos(best)}`} selected={sel?.id === c.id} onClick={() => setSel(sel?.id === c.id ? null : c)} />;
        })}
      </div>
      <div class="tabs">
        <button class="chip" disabled={!sel} onClick={() => sel && pick(sel, null)}>{sel ? `DRAFT ${(sel.name.split(" ").slice(-1)[0] ?? sel.name).toUpperCase()} · BEST FIT` : "PICK A PLAYER, THEN A SLOT"}</button>
        <button class="chip" disabled={team.rerolls <= 0} onClick={() => { if (draft.reroll(side)) { setSel(null); bump(); } }}>REROLL ({team.rerolls})</button>
        <button class={`chip ${showOpp ? "on" : ""}`} onClick={() => setShowOpp(!showOpp)}>{cfg.teams[opp].info.abbr} PICKS ({draft.teams[opp].picks.length})</button>
      </div>
      {showOpp && (
        <div class="opplist">
          <GradeChips d={draft} side={opp} />
          {draft.teams[opp].picks.slice().reverse().map((p) => <div><small>R{p.round}</small> {slotBasePos(p.slot)} <b>{p.card.name}</b> {p.overallAtSlot}</div>)}
        </div>
      )}
      <SlotBoard d={draft} side={side} card={sel} onSlot={(k) => sel && pick(sel, k)} />
      {reveal && <Reveal cd={cd} d={draft} rev={reveal} cfg={cfg} onNext={nextRound} />}
    </div>
  );
}

export function Reveal({ cd, d, rev, cfg, onNext }: { cd: ClientData; d: Draft; rev: RoundReveal; cfg: DraftConfigUi; onNext: () => void }) {
  useEffect(() => { audio.play("reveal"); }, [rev.round]);
  const one = (p: DraftPick) => {
    const t = cfg.teams[p.side];
    const delta = p.gradeAfter - p.gradeBefore;
    return (
      <div class="revpick">
        <div class="lbl"><Icon cd={cd} id={t.icon} color={t.info.c1} size={16} /> {t.info.name}</div>
        <div class="flip"><PlayerCardView cd={cd} c={p.card} ovr={p.overallAtSlot} slotLabel={`${slotBasePos(p.slot)}${p.auto ? " · auto" : ""}${p.lostTie ? " · lost the tie" : ""}`} /></div>
        <div class="tag">GRADE {p.gradeBefore.toFixed(1)} → {p.gradeAfter.toFixed(1)} ({delta >= 0 ? "+" : ""}{delta.toFixed(1)})</div>
        {d.settings.revealPassed && p.passed.length > 0 && <small class="hint">passed on: {p.passed.map((c) => `${c.name} (${c.pos} ${c.ovr})`).join(", ")}</small>}
      </div>
    );
  };
  return (
    <div class="overlay reveal">
      <div class="title">ROUND {rev.round} · REVEAL{rev.priority != null ? ` · PRIORITY: ${cfg.teams[rev.priority].info.abbr}` : ""}</div>
      <div class="revrow">{one(rev.picks[0])}{one(rev.picks[1])}</div>
      <button class="big" onClick={onNext}>{d.done ? "DRAFT COMPLETE ▶" : "NEXT ROUND ▶"}</button>
    </div>
  );
}

// ---------------------------------------------------------------- after the draft
export function PostDraft({ cd, d, cfg, rosters, setRosters, onLineup, onKickoff }: {
  cd: ClientData; d: Draft; cfg: DraftConfigUi; rosters: [Roster, Roster]; setRosters: (r: [Roster, Roster]) => void;
  onLineup: (side: 0 | 1) => void; onKickoff: () => void;
}) {
  const [spread, setSpread] = useState<{ margin: number; winPct: number } | null>(null);
  const [log, setLog] = useState(false);
  void setRosters;
  useEffect(() => {
    setSpread(null);
    const id = setTimeout(() => setSpread(predictSpread(cd.data, cd.ratings, rosters[0], rosters[1], cd.data.draft.spreadSims, "spread", playGame)), 60);
    return () => clearTimeout(id);
  }, [rosters]);
  const col = (side: 0 | 1) => {
    const ro = rosters[side], t = cfg.teams[side];
    const g = teamGrade(ro.starters, cd.data);
    const human = side === 0 || cfg.mode === "hotseat";
    return (
      <div class="pdcol">
        <h2><Icon cd={cd} id={t.icon} color={t.info.c1} size={28} /> {t.info.name}</h2>
        <div class="grades big">{(["offense", "defense", "special", "overall"] as const).map((u) => <span class="gchip"><small>{u === "special" ? "ST" : u.slice(0, 3).toUpperCase()}</small><b>{g[u].letter}</b><i>{g[u].score}</i></span>)}</div>
        <small class="hint">chemistry +{g.chemistry.total.toFixed(1)} (QB-target {g.chemistry.qbTargets.toFixed(1)}, OL {g.chemistry.olCohesion.toFixed(1)})</small>
        <div class="pdlist">{Object.entries(ro.starters).filter(([s]) => s !== "LS").map(([s, c]) => <div><small>{s}</small> <b>{c.name}</b> <i>{slotOverall(c, slotPos(s), cd.data)}</i></div>)}</div>
        {human && <button class="chip" onClick={() => onLineup(side)}>LINEUP & DEPTH CHART</button>}
      </div>
    );
  };
  const a = cfg.teams[0].info, b = cfg.teams[1].info;
  return (
    <div class="menu postdraft">
      <h1>DRAFT <span>COMPLETE</span></h1>
      <div class="sub">{spread ? (Math.abs(spread.margin) < 0.5 ? "PREDICTED: PICK 'EM" : `PREDICTED: ${(spread.margin > 0 ? a : b).abbr} BY ${Math.abs(spread.margin).toFixed(1)} · ${a.abbr} WINS ${spread.winPct.toFixed(0)}% OF ${cd.data.draft.spreadSims} SIMS`) : "SIMULATING THE MATCHUP…"}</div>
      <div class="pdcols">{col(0)}{col(1)}</div>
      <div class="row">
        <button class={`chip ${log ? "on" : ""}`} onClick={() => setLog(!log)}>DRAFT LOG</button>
        <button class="big" onClick={onKickoff}>KICK OFF ▶</button>
      </div>
      {log && <div class="pdlog">{d.log.map((r) => (
        <div><small>R{r.round}{r.theme ? ` · ${r.theme.label}` : ""}</small> {r.picks.map((p) => `${cfg.teams[p.side].info.abbr}: ${p.card.name} (${slotBasePos(p.slot)} ${p.overallAtSlot})${d.settings.revealPassed ? ` [passed ${p.passed.map((c) => c.name).join(", ")}]` : ""}`).join(" · ")}</div>
      ))}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- lineup builder / depth chart
const FIELD: string[][] = [["WR1", "LT", "LG", "C", "RG", "RT", "TE", "WR2"], ["WR3", "QB", "RB"], ["DE1", "DT1", "DT2", "DE2"], ["OLB1", "MLB", "OLB2"], ["CB1", "FS", "SS", "CB2"], ["K", "P", "LS"]];
const DEPTH = ["WR4", "TE2", "TE3", "RB2", "FB", "CB3", "CB4", "SS2", "DT3", "MLB2"];
export function Lineup({ cd, roster, onDone }: { cd: ClientData; roster: Roster; onDone: (r: Roster) => void }) {
  const [ro, setRo] = useState(roster);
  const [sel, setSel] = useState<string | null>(null);
  const [benchSel, setBenchSel] = useState<PlayerCard | null>(null);
  const who = (s: string) => ro.starters[s] ?? ro.depth[s];
  const val = (s: string, c: PlayerCard) => slotOverall(c, slotPos(s), cd.data);
  const tap = (s: string) => {
    if (benchSel) { setRo(benchIn(ro, s, benchSel)); setBenchSel(null); setSel(null); return; }
    if (!sel) { setSel(s); return; }
    if (sel !== s) setRo(swapSlots(ro, sel, s));
    setSel(null);
  };
  const cell = (s: string) => {
    const c = who(s);
    if (!c) return <button class="slot" onClick={() => tap(s)}><small>{s}</small><i>—</i></button>;
    const v = val(s, c), nat = c.natural.includes(slotPos(s));
    return (
      <button class={`slot ${sel === s ? "sel" : ""} ${nat ? "nat" : v >= cd.data.draft.viability.minOverallAtSlot ? "ok" : "bad"}`} onClick={() => tap(s)}>
        <small>{s}</small><b>{shortName(c.name)}</b><i>{v}</i>
      </button>
    );
  };
  const g = teamGrade(ro.starters, cd.data);
  const focus = sel ? who(sel) : benchSel;
  const used = new Set([...Object.values(ro.starters), ...Object.values(ro.depth)].map((c) => c.id));
  const bench = ro.bench.filter((c) => !used.has(c.id));
  const everyone = [...Object.values(ro.starters), ...Object.values(ro.depth), ...bench].filter((c) => !["K", "P", "LS"].includes(c.pos));
  const style = ro.style ?? "balanced";
  return (
    <div class="menu lineup">
      <h1>LINEUP <span>{ro.info.abbr}</span></h1>
      <div class="sub">TAP TWO SPOTS TO SWAP · TAP A BENCH PLAYER, THEN A SPOT · RED = OUT OF POSITION</div>
      <div class="grades big">{(["offense", "defense", "special", "overall"] as const).map((u) => <span class="gchip"><small>{u === "special" ? "ST" : u.slice(0, 3).toUpperCase()}</small><b>{g[u].letter}</b><i>{g[u].score}</i></span>)}</div>
      <div class="board">{FIELD.map((r) => <div class="brow">{r.map(cell)}</div>)}</div>
      <div class="lbl">DEPTH CHART (SUB PACKAGES)</div>
      <div class="board"><div class="brow wrap">{DEPTH.map(cell)}</div></div>
      <div class="lbl">BENCH</div>
      <div class="brow wrap">{bench.map((c) => <button class={`chip ${benchSel?.id === c.id ? "on" : ""}`} onClick={() => { setBenchSel(benchSel?.id === c.id ? null : c); setSel(null); }}>{c.pos} {c.name} {c.ovr}</button>)}</div>
      {focus && <div class="focus"><PlayerCardView cd={cd} c={focus} /></div>}
      <div class="row"><span class="lbl">KICK RETURNER</span>
        <select value={ro.kr ?? ""} onChange={(e) => setRo({ ...ro, kr: Number((e.target as HTMLSelectElement).value) || undefined })}>
          <option value="">auto (best)</option>{everyone.sort((a, b) => (b.overallAt.KR ?? 0) - (a.overallAt.KR ?? 0)).slice(0, 12).map((c) => <option value={c.id}>{c.name} · KR {c.overallAt.KR}</option>)}
        </select>
        <span class="lbl">PUNT RETURNER</span>
        <select value={ro.pr ?? ""} onChange={(e) => setRo({ ...ro, pr: Number((e.target as HTMLSelectElement).value) || undefined })}>
          <option value="">same as KR</option>{everyone.slice(0, 12).map((c) => <option value={c.id}>{c.name} · KR {c.overallAt.KR}</option>)}
        </select>
      </div>
      <div class="row"><span class="lbl">BASE OFFENSE</span>
        {(["balanced", "spread", "pro", "run", "air"] as OffenseStyle[]).map((s) => <button class={`chip ${style === s ? "on" : ""}`} onClick={() => setRo({ ...ro, style: s })}>{s === "air" ? "AIR RAID" : s === "pro" ? "PRO-STYLE" : s === "run" ? "RUN-HEAVY" : s.toUpperCase()}</button>)}</div>
      <div class="row"><span class="lbl">BASE DEFENSE</span>
        {[["base43", "4-3"], ["base34", "3-4"]].map(([id, l]) => <button class={`chip ${(ro.baseFront ?? "base43") === id ? "on" : ""}`} onClick={() => setRo({ ...ro, baseFront: id })}>{l}</button>)}</div>
      <div class="row"><button class="big" onClick={() => onDone(ro)}>DONE ▶</button></div>
    </div>
  );
}
