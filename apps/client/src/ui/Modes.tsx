// Single-player modes (M10): the Boss Gauntlet (draft vs AI, a 17-game season vs League Bosses,
// playoffs), the Daily Draft (the same offers and opponents for everyone today), and the leaderboards.
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  bossRoster, dailyDate, newDaily, newGauntlet, nextGame, playGame, rankedSeason, record, recordResult, rosterFromWire, rosterToWire,
  runScore, runSummary, teamGrade, type Boss, type GauntletGame, type GauntletRun, type Roster, type WireRoster,
} from "@tdf/sim";
import type { ClientData } from "../data.js";
import { Controller } from "../game/controller.js";
import { account, ensureAccount, fetchBoard, fetchRanked, submitScore, type BoardRow, type RankRow } from "../net/api.js";
import { Game } from "./App.js";
import { audio } from "../audio/audio.js";
import { DraftScreen, Icon, Lineup, PALETTES, TeamEditor, type DraftConfigUi, type TeamSetup } from "./Draft.js";

type Kind = "gauntlet" | "daily";
interface SavedRun { kind: Kind; run: GauntletRun; roster: WireRoster; team: TeamSetup; submitted?: boolean; date?: string }
const runKey = (k: Kind) => `tdf.run.${k}`;
function loadRun(k: Kind, today: string): SavedRun | null {
  try {
    const r = JSON.parse(localStorage.getItem(runKey(k)) ?? "null") as SavedRun | null;
    if (!r?.run) return null;
    if (k === "daily" && r.date !== today) return null;
    return r;
  } catch { return null; }
}
function saveRun(r: SavedRun | null, k: Kind) { try { if (r) localStorage.setItem(runKey(k), JSON.stringify(r)); else localStorage.removeItem(runKey(k)); } catch { /* private */ } }

function defaultTeam(cd: ClientData): TeamSetup {
  try { const t = JSON.parse(localStorage.getItem("tdf.online.team") ?? "null"); if (t?.info?.name) return t; } catch { /* none */ }
  const icons = Object.keys(cd.data.icons.icons);
  return { info: { abbr: "YOU", name: "Your Team", nick: "Team", c1: PALETTES[0]![0], c2: PALETTES[0]![1], c3: PALETTES[0]![2] }, icon: icons[0]! };
}
const bossOf = (cd: ClientData, id: string): Boss => cd.data.bosses.bosses.find((b) => b.id === id)!;

/** The player's name for the leaderboards (a guest account on the server). */
export function NameBox({ onChange }: { onChange?: () => void }) {
  const [name, setName] = useState(account()?.name ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    try { const a = await ensureAccount(name); setMsg(`signed in as ${a.name}`); onChange?.(); } catch (e) { setMsg(String((e as Error).message)); }
  };
  return (
    <div class="row namebox">
      <span class="lbl">NAME</span>
      <input class="search" value={name} maxLength={16} placeholder="your name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      <button class="chip" disabled={name.trim().length < 2} onClick={save}>{account() ? "SAVE" : "SIGN UP"}</button>
      {msg && <small class="hint">{msg}</small>}
    </div>
  );
}

export function ModeScreen({ cd, kind, onExit }: { cd: ClientData; kind: Kind; onExit: () => void }) {
  const today = dailyDate(new Date());
  const M = cd.data.modes;
  const qm = kind === "daily" ? M.daily.quarterMinutes : M.gauntlet.quarterMinutes;
  const [saved, setSavedRaw] = useState<SavedRun | null>(() => loadRun(kind, today));
  const setSaved = (r: SavedRun | null) => { setSavedRaw(r); saveRun(r, kind); };
  const [stage, setStage] = useState<"setup" | "draft" | "lineup" | "hub" | "game" | "editLineup">(saved ? "hub" : "setup");
  const [team, setTeam] = useState<TeamSetup>(() => saved?.team ?? defaultTeam(cd));
  const [drafted, setDrafted] = useState<Roster | null>(null);
  const [ctl, setCtl] = useState<Controller | null>(null);
  const [playing, setPlaying] = useState<GauntletGame | null>(null);
  const roster = useMemo(() => (saved ? rosterFromWire(saved.roster, cd.byId) : null), [saved?.roster]);
  useEffect(() => { audio.music(stage === "draft" ? "draft" : stage === "game" ? null : "menu"); }, [stage]);
  const rival: TeamSetup = { info: { abbr: "RIV", name: kind === "daily" ? "Daily Rival" : "Rival Drafter", nick: "Rivals", c1: PALETTES[1]![0], c2: PALETTES[1]![1], c3: PALETTES[1]![2] }, icon: Object.keys(cd.data.icons.icons)[1]! };
  const cfg: DraftConfigUi = {
    mode: "ai", teams: [team, rival], ai: "need", format: "quick", mirror: false, revealPassed: true, themed: false, timer: false, quarter: qm,
    ...(kind === "daily" ? { seed: `daily:${today}` } : {}),
  };
  const opponent = (g: GauntletGame) => bossRoster(bossOf(cd, g.boss), g.strength, cd.data, cd.pool, saved!.run.seed);

  if (stage === "setup") {
    return (
      <div class="menu">
        <h1>{kind === "daily" ? <>DAILY <span>DRAFT</span></> : <>BOSS <span>GAUNTLET</span></>}</h1>
        <div class="sub">{kind === "daily"
          ? `${today} · EVERYONE GETS THE SAME DRAFT TODAY · THEN ${M.daily.dailyGames} BOSS GAMES · ONE TRY`
          : `DRAFT YOUR TEAM, THEN A ${M.gauntlet.weeks}-GAME SEASON VS THE LEAGUE BOSSES · ${M.gauntlet.playoffWins}+ WINS MAKES THE PLAYOFFS`}</div>
        <TeamEditor cd={cd} t={team} set={setTeam} label="YOUR TEAM" />
        <div class="bosslist">{cd.data.bosses.bosses.map((b) => <span class="tag" title={b.scheme}><Icon cd={cd} id={b.icon} color={b.c1} size={14} /> {b.name}</span>)}</div>
        <div class="row"><button class="chip" onClick={onExit}>BACK</button><button class="big" onClick={() => setStage("draft")}>START THE DRAFT ▶</button></div>
      </div>
    );
  }
  if (stage === "draft") return <DraftScreen cd={cd} cfg={cfg} onDone={(d) => { setDrafted(d.toRoster(0)); setStage("lineup"); }} />;
  if (stage === "lineup" && drafted) {
    return <Lineup cd={cd} roster={drafted} onDone={(r) => {
      const run = kind === "daily" ? newDaily(today, cd.data) : newGauntlet(`${Date.now().toString(36)}`, cd.data);
      setSaved({ kind, run, roster: rosterToWire(r), team, date: today });
      setStage("hub");
    }} />;
  }
  if (stage === "editLineup" && roster && saved) return <Lineup cd={cd} roster={roster} onDone={(r) => { setSaved({ ...saved, roster: rosterToWire(r) }); setStage("hub"); }} />;
  if (stage === "game" && ctl && playing && saved) {
    return <Game ctl={ctl} exitLabel={kind === "daily" ? "BACK TO THE DAILY" : "BACK TO THE SEASON"} onExit={() => {
      const s = ctl.state;
      if (s.phase === "final") setSaved({ ...saved, run: recordResult(saved.run, playing.week, s.score[0], s.score[1], false, cd.data) });
      setCtl(null); setPlaying(null); setStage("hub");
    }} />;
  }
  if (!saved || !roster) { setStage("setup"); return null; }

  const run = saved.run, next = nextGame(run), rec = record(run);
  const play = (g: GauntletGame) => {
    const c = new Controller(cd, [roster, opponent(g)], qm, { seed: `${run.seed}:w${g.week}` });
    setCtl(c); setPlaying(g); setStage("game");
  };
  const sim = (g: GauntletGame) => {
    const r = playGame({ data: cd.data, ratings: cd.ratings, teams: [roster, opponent(g)], seed: `${run.seed}:sim${g.week}`, quarterSeconds: qm * 60 });
    setSaved({ ...saved, run: recordResult(run, g.week, r.state.score[0], r.state.score[1], true, cd.data) });
  };
  const grade = teamGrade(roster.starters, cd.data).overall;
  return (
    <div class="menu hub">
      <h1>{kind === "daily" ? <>DAILY <span>{saved.date}</span></> : <>BOSS <span>GAUNTLET</span></>}</h1>
      <div class="sub"><Icon cd={cd} id={saved.team.icon} color={saved.team.info.c1} size={18} /> {saved.team.info.name} · GRADE {grade.letter} ({grade.score}) · {runSummary(run, cd.data).toUpperCase()}</div>
      {next && (() => {
        const b = bossOf(cd, next.boss);
        return (
          <div class="nextgame" style={{ borderColor: b.c1 }}>
            <div class="lbl">{next.round ? `${next.round.toUpperCase()} ROUND` : `WEEK ${next.week} OF ${run.kind === "daily" ? run.games.length : cd.data.modes.gauntlet.weeks}`}</div>
            <h2><Icon cd={cd} id={b.icon} color={b.c1} size={28} /> {b.name} <small>({next.strength} OVR)</small></h2>
            <p class="hint">{b.scheme}</p>
            <div class="row">
              <button class="big" onClick={() => play(next)}>PLAY ▶</button>
              <button class="chip" onClick={() => sim(next)}>SIM</button>
              <button class="chip" onClick={() => setStage("editLineup")}>LINEUP</button>
            </div>
          </div>
        );
      })()}
      {run.done && <RunOver cd={cd} saved={saved} onSubmitted={() => setSaved({ ...saved, submitted: true })} />}
      <table class="drives sched"><tbody>{run.games.map((g) => {
        const b = bossOf(cd, g.boss), r = g.result;
        return (
          <tr class={r ? (r.us > r.them ? "score" : "") : g === next ? "next" : ""}>
            <td>{g.round ?? `W${g.week}`}</td><td><Icon cd={cd} id={b.icon} color={b.c1} size={12} /> {b.name}</td><td>{g.strength}</td>
            <td>{r ? `${r.us > r.them ? "W" : r.us < r.them ? "L" : "T"} ${r.us}-${r.them}${r.simmed ? " (sim)" : ""}` : ""}</td>
          </tr>
        );
      })}</tbody></table>
      <div class="sub">RECORD {rec.wins}-{rec.losses}{rec.ties ? `-${rec.ties}` : ""} · PF {rec.pointsFor} · PA {rec.pointsAgainst}</div>
      <div class="row">
        <button class="chip" onClick={onExit}>MENU</button>
        {kind === "gauntlet" && <button class="chip" onClick={() => { if (run.done || confirm("Abandon this run?")) { setSaved(null); setStage("setup"); } }}>NEW RUN</button>}
      </div>
    </div>
  );
}

function RunOver({ cd, saved, onSubmitted }: { cd: ClientData; saved: SavedRun; onSubmitted: () => void }) {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [signed, setSigned] = useState(Boolean(account()));
  const key = saved.kind === "daily" ? saved.date! : "all";
  const score = runScore(saved.run, cd.data), summary = runSummary(saved.run, cd.data);
  useEffect(() => {
    if (!signed) return;
    const detail = { team: saved.team.info.name, games: saved.run.games.map((g) => ({ boss: g.boss, ...g.result })) };
    const go = saved.submitted ? fetchBoard(saved.kind, key) : submitScore(saved.kind, key, score, summary, detail).then((r) => { onSubmitted(); return r; });
    go.then((r) => setRows(r.rows)).catch((e) => setErr(String((e as Error).message)));
  }, [signed]);
  return (
    <div class="nextgame done">
      <div class="lbl">{saved.kind === "daily" ? "TODAY'S RESULT" : "RUN OVER"}</div>
      <h2>{summary.toUpperCase()}</h2>
      <div class="sub">SCORE {score}</div>
      {!signed && <><p class="hint">Pick a name to post your score on the leaderboard.</p><NameBox onChange={() => setSigned(true)} /></>}
      {err && <p class="hint">leaderboard: {err}</p>}
      {rows && <Board rows={rows} />}
    </div>
  );
}

function Board({ rows }: { rows: BoardRow[] }) {
  const me = account()?.id;
  return (
    <table class="drives"><tbody>{rows.map((r, k) => (
      <tr class={r.account === me ? "score" : ""}><td>{k + 1}</td><td>{r.name}</td><td>{r.summary}</td><td>{r.score}</td></tr>
    ))}</tbody></table>
  );
}

/** Leaderboards: today's Daily Draft, the all-time Boss Gauntlet runs, and this month's ranked ladder. */
export function Leaderboards({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<"daily" | "gauntlet" | "ranked">("daily");
  const [rows, setRows] = useState<BoardRow[] | RankRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const today = dailyDate(new Date()), season = rankedSeason(new Date());
  useEffect(() => {
    setRows(null); setErr(null);
    const p = tab === "ranked" ? fetchRanked(season) : fetchBoard(tab, tab === "daily" ? today : "all");
    p.then((r) => setRows(r.rows)).catch((e) => setErr(String((e as Error).message)));
  }, [tab]);
  const me = account()?.id;
  return (
    <div class="menu">
      <h1>LEADER<span>BOARDS</span></h1>
      <NameBox />
      <div class="tabs">
        <button class={`chip ${tab === "daily" ? "on" : ""}`} onClick={() => setTab("daily")}>DAILY · {today}</button>
        <button class={`chip ${tab === "gauntlet" ? "on" : ""}`} onClick={() => setTab("gauntlet")}>BOSS GAUNTLET</button>
        <button class={`chip ${tab === "ranked" ? "on" : ""}`} onClick={() => setTab("ranked")}>RANKED · {season}</button>
      </div>
      {err && <p class="hint">can't reach the server: {err}</p>}
      {!rows && !err && <p class="hint">loading…</p>}
      {rows && !rows.length && <p class="hint">no entries yet: be the first.</p>}
      {rows && tab !== "ranked" && <Board rows={rows as BoardRow[]} />}
      {rows && tab === "ranked" && (
        <table class="drives"><thead><tr><th>#</th><th>COACH</th><th>RATING</th><th>W-L-T</th></tr></thead><tbody>{(rows as RankRow[]).map((r, k) => (
          <tr class={r.account === me ? "score" : ""}><td>{k + 1}</td><td>{r.name}</td><td>{r.rating}</td><td>{r.wins}-{r.losses}-{r.ties}</td></tr>
        ))}</tbody></table>
      )}
      <div class="row"><button class="chip" onClick={onExit}>BACK</button></div>
    </div>
  );
}
