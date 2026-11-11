// Franchise mode (M11): save slots, a new franchise (take over a club, optionally with a drafted
// team), and the hub: this week's game (play it or sim it; the league's other games sim in Web
// Workers meanwhile), choice events, the roster (develop, extend, cut, lineup, trades), the league
// (standings, schedule, leaders), the front office (staff, facilities), history (records, awards,
// Hall of Fame) and news; the off-season (re-sign, Triple Draft rookie draft, free agency).
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  FranchiseData, GameSession, askingSalary, capSpace, cut, develop, developCost, draftChoose, draftRound, endFreeAgency, expiring, extend, finishWeek,
  franchiseRatings, freeAgents, gameJob, gameRoster, leaders, money, newFranchise, payroll, placeBid, proposeTrade, recordGame, resign, resolveEvent,
  setLineup, standings, startDraft, takeNewJob, team, teamPlayers, upgradeFacility, upgradeStaff, userGame, weekGames,
  type FacilityKind, type FGame, type FPlayer, type Franchise, type StaffKind,
} from "@tdf/sim";
import type { ClientData } from "../data.js";
import { Controller } from "../game/controller.js";
import { GamePool } from "../franchise/pool.js";
import { Game } from "./App.js";
import { Lineup } from "./Draft.js";
import { loadTeam, savedTeams } from "./saved.js";
import { audio } from "../audio/audio.js";

const SLOTS = 3;
const slotKey = (n: number) => `tdf.franchise.${n}`;
function loadSlot(n: number): Franchise | null { try { const f = JSON.parse(localStorage.getItem(slotKey(n)) ?? "null"); return f?.v === 1 ? f : null; } catch { return null; } }
function saveSlot(n: number, f: Franchise): string | null {
  try { localStorage.setItem(slotKey(n), JSON.stringify(f)); return null; } catch { return "couldn't save: browser storage is full"; }
}

export function FranchiseScreen({ cd, onExit }: { cd: ClientData; onExit: () => void }) {
  const fd = useMemo(() => new FranchiseData(cd.data), []);
  const pool = useMemo(() => new GamePool(cd), []);
  useEffect(() => () => pool.dispose(), []);
  useEffect(() => { audio.music("menu"); }, []);
  const [slot, setSlot] = useState<number | null>(null);
  const [f, setF] = useState<Franchise | null>(null);
  const [, setV] = useState(0);
  const [creating, setCreating] = useState<number | null>(null);
  const bump = () => setV((x) => x + 1);
  if (creating !== null) return <NewFranchise cd={cd} fd={fd} onBack={() => setCreating(null)} onCreate={(nf) => { saveSlot(creating, nf); setSlot(creating); setF(nf); setCreating(null); }} />;
  if (f && slot !== null) return <Hub cd={cd} fd={fd} pool={pool} f={f} save={() => { const e = saveSlot(slot, f); bump(); return e; }} onExit={() => { saveSlot(slot, f); setF(null); setSlot(null); }} />;
  return (
    <div class="menu">
      <h1>FRAN<span>CHISE</span></h1>
      <div class="sub">RUN A CLUB: SEASONS, PLAYOFFS, THE CAP, STAFF, THE DRAFT, FREE AGENCY · AUTOSAVES EVERY WEEK</div>
      <div class="plays modes">
        {Array.from({ length: SLOTS }, (_, n) => {
          const s = loadSlot(n);
          if (!s) return <button class="play" onClick={() => setCreating(n)}><b>SLOT {n + 1} · NEW FRANCHISE</b><small>take over a club</small></button>;
          const t = team(s, s.user);
          return (
            <div class="play slotrow">
              <button class="play" onClick={() => { setSlot(n); setF(s); }}><b>SLOT {n + 1} · {t.name}</b><small>season {s.year} · {s.phase === "regular" ? `week ${s.week} · ${t.w}-${t.l}${t.t ? `-${t.t}` : ""}` : s.phase}{s.fired ? " · FIRED" : ""} · {s.champions.filter((c) => c.team === s.user).length} titles</small></button>
              <button class="chip" onClick={() => { if (confirm(`Delete slot ${n + 1}?`)) { localStorage.removeItem(slotKey(n)); bump(); } }}>DELETE</button>
            </div>
          );
        })}
      </div>
      <div class="row"><button class="chip" onClick={onExit}>BACK</button></div>
    </div>
  );
}

function NewFranchise({ cd, fd, onBack, onCreate }: { cd: ClientData; fd: FranchiseData; onBack: () => void; onCreate: (f: Franchise) => void }) {
  const teams = [...cd.data.teams.teams].sort((a, b) => a.name.localeCompare(b.name));
  const [club, setClub] = useState<string | null>(null);
  const [source, setSource] = useState<string>("club");
  const [qm, setQm] = useState(3);
  const [inj, setInj] = useState(true);
  const [busy, setBusy] = useState(false);
  const saved = savedTeams();
  const create = () => {
    setBusy(true);
    setTimeout(() => {
      const st = saved.find((t) => t.id === source);
      const r = st ? loadTeam(cd, st) : null;
      const drafted = r ? { info: r.info, starters: Object.fromEntries(Object.entries(r.starters).map(([k, c]) => [k, c.id])), bench: r.bench.map((c) => c.id) } : undefined;
      onCreate(newFranchise(fd, cd.pool, { name: club!, seed: Date.now().toString(36), team: club!, quarterMinutes: qm, injuries: inj, drafted }));
    }, 30);
  };
  return (
    <div class="menu">
      <h1>NEW <span>FRANCHISE</span></h1>
      <div class="sub">PICK THE CLUB YOU TAKE OVER</div>
      <div class="teams">{teams.map((t) => <button class={`team ${club === t.abbr ? "you" : ""}`} onClick={() => setClub(t.abbr)}><span>{t.abbr}</span></button>)}</div>
      <div class="row"><span class="lbl">ROSTER</span>
        <button class={`chip ${source === "club" ? "on" : ""}`} onClick={() => setSource("club")}>THE CLUB'S REAL ROSTER</button>
        {saved.map((t) => <button class={`chip ${source === t.id ? "on" : ""}`} onClick={() => setSource(t.id)}>DRAFTED: {t.roster.info.name}</button>)}
      </div>
      {source !== "club" && <p class="hint">Your drafted players join the club; its own players become free agents.</p>}
      <div class="row"><span class="lbl">YOUR GAMES</span>{[2, 3, 5, 8, 15].map((m) => <button class={`chip ${qm === m ? "on" : ""}`} onClick={() => setQm(m)}>{m} MIN QUARTERS</button>)}</div>
      <div class="row"><span class="lbl">INJURIES</span><button class={`chip ${inj ? "on" : ""}`} onClick={() => setInj(true)}>ON</button><button class={`chip ${!inj ? "on" : ""}`} onClick={() => setInj(false)}>OFF</button></div>
      <div class="row"><button class="chip" onClick={onBack}>BACK</button><button class="big" disabled={!club || busy} onClick={create}>{busy ? "BUILDING THE LEAGUE…" : "START ▶"}</button></div>
    </div>
  );
}

type Tab = "home" | "roster" | "league" | "office" | "history" | "news";
function Hub({ cd, fd, pool, f, save, onExit }: { cd: ClientData; fd: FranchiseData; pool: GamePool; f: Franchise; save: () => string | null; onExit: () => void }) {
  const [tab, setTab] = useState<Tab>("home");
  const [msg, setMsg] = useState<string | null>(null);
  const [ctl, setCtl] = useState<Controller | null>(null);
  const [lineup, setLineupOpen] = useState(false);
  const [running, setRunning] = useState<Set<number>>(new Set());
  const [, setV] = useState(0);
  const bump = () => setV((x) => x + 1);
  const act = (e: string | null | undefined, ok?: string) => { setMsg(e ?? ok ?? null); const s = save(); if (s) setMsg(s); bump(); };
  const t = team(f, f.user);
  const ug = (f.phase === "regular" || f.phase === "playoffs") ? userGame(f) : null;
  // the rest of the week sims in the background
  const startSims = () => {
    for (const g of weekGames(f)) {
      if (g.score || running.has(g.id) || g === ug) continue;
      running.add(g.id);
      pool.run(gameJob(fd, f, g)).then((out) => { if (!g.score) recordGame(fd, f, g, out, true); running.delete(g.id); setRunning(new Set(running)); save(); });
    }
    setRunning(new Set(running));
  };
  useEffect(() => { if (f.phase === "regular" || f.phase === "playoffs") startSims(); }, [f.week, f.phase, f.year]);
  const weekDone = (f.phase === "regular" || f.phase === "playoffs") && weekGames(f).every((g) => g.score);
  const playGame = (g: FGame) => {
    const home = g.home === f.user;
    const me = gameRoster(fd, f, f.user), them = gameRoster(fd, f, home ? g.away : g.home);
    const c = new Controller(cd, [me, them], f.quarterMinutes, { seed: `${f.seed}:${f.year}:${g.id}`, ratings: franchiseRatings(fd, f) });
    setCtl(c);
  };
  const simMine = (g: FGame) => {
    if (g.score || running.has(g.id)) return; // (a double tap)
    running.add(g.id); setRunning(new Set(running));
    pool.run(gameJob(fd, f, g)).then((out) => { if (!g.score) recordGame(fd, f, g, out, true); running.delete(g.id); setRunning(new Set(running)); act(null); });
  };
  if (ctl && ug) {
    return <Game ctl={ctl} exitLabel="BACK TO THE FRANCHISE" onExit={() => {
      if (ctl.state.phase === "final" && !ug.score) {
        const r = ctl.result(), home = ug.home === f.user, s = r.state.score;
        recordGame(fd, f, ug, { state: { score: home ? [s[0], s[1]] : [s[1], s[0]] }, players: r.players }, false);
      }
      setCtl(null); act(null);
    }} />;
  }
  if (lineup) return <Lineup cd={cd} roster={gameRoster(fd, f, f.user)} onDone={(r) => { setLineup(f, r); setLineupOpen(false); act(null, "lineup saved"); }} />;

  const next = () => { finishWeek(fd, f); act(null); };
  return (
    <div class="menu hub franchise">
      <h1>{t.name.toUpperCase()}</h1>
      <div class="sub">SEASON {f.year} · {f.phase === "regular" ? `WEEK ${f.week}` : f.phase === "playoffs" ? weekGames(f)[0]?.round?.toUpperCase() ?? "PLAYOFFS" : f.phase.toUpperCase()}
        {" · "}{t.w}-{t.l}{t.t ? `-${t.t}` : ""} · CREDITS {f.credits} · CAP ${money(payroll(f, f.user))}M / ${money(f.cap)}M</div>
      <div class="meters">
        <Meter label="JOB SECURITY" v={f.security} /><Meter label="MORALE" v={t.morale} /><Meter label="FANS" v={t.fans} />
        <span class="tag">OWNER EXPECTS {f.expectedWins} WINS</span>
      </div>
      <div class="tabs">{(["home", "roster", "league", "office", "history", "news"] as Tab[]).map((k) => <button class={`chip ${tab === k ? "on" : ""}`} onClick={() => { setTab(k); setMsg(null); }}>{k.toUpperCase()}</button>)}</div>
      {msg && <div class="sub warn">{msg.toUpperCase()}</div>}
      {tab === "home" && <Home cd={cd} fd={fd} f={f} ug={ug} running={running} weekDone={weekDone} onPlay={playGame} onSim={simMine} onNext={next} act={act} />}
      {tab === "roster" && <RosterTab fd={fd} f={f} act={act} onLineup={() => setLineupOpen(true)} />}
      {tab === "league" && <LeagueTab fd={fd} f={f} />}
      {tab === "office" && <OfficeTab fd={fd} f={f} act={act} />}
      {tab === "history" && <HistoryTab f={f} />}
      {tab === "news" && <div class="newslist">{f.news.map((n) => <div class={n.user ? "mine" : ""}><small>Y{n.year} W{n.week}</small> {n.text}</div>)}</div>}
      <div class="row"><button class="chip" onClick={onExit}>SAVE & EXIT</button></div>
    </div>
  );
}
function Meter({ label, v }: { label: string; v: number }) {
  const x = Math.max(0, Math.min(100, v));
  return <span class="meter"><small>{label}</small><b><u style={{ width: `${x}%`, background: x < 25 ? "#ff6b5e" : x < 50 ? "#ffd23e" : "#7fe08f" }} /></b></span>;
}
const rec = (t: { w: number; l: number; t: number }) => `${t.w}-${t.l}${t.t ? `-${t.t}` : ""}`;

function Home({ cd, fd, f, ug, running, weekDone, onPlay, onSim, onNext, act }: {
  cd: ClientData; fd: FranchiseData; f: Franchise; ug: FGame | null; running: Set<number>; weekDone: boolean;
  onPlay: (g: FGame) => void; onSim: (g: FGame) => void; onNext: () => void; act: (e: string | null | undefined, ok?: string) => void;
}) {
  if (f.fired) {
    return (
      <div class="nextgame">
        <h2>YOU'RE FIRED</h2>
        <p class="hint">The owner has seen enough. Pick a new job: the league goes on.</p>
        <div class="teams">{f.teams.filter((t) => t.abbr !== f.user).map((t) => <button class="team" onClick={() => { takeNewJob(fd, f, t.abbr); act(null, `welcome to ${t.name}`); }}><span>{t.abbr}</span></button>)}</div>
      </div>
    );
  }
  if (f.phase === "resign") return <Resign fd={fd} f={f} act={act} pool={cd.pool} />;
  if (f.phase === "draft") return <RookieDraft fd={fd} f={f} act={act} />;
  if (f.phase === "freeAgency") return <FreeAgency fd={fd} f={f} act={act} />;
  const games = weekGames(f);
  const opp = ug ? team(f, ug.home === f.user ? ug.away : ug.home) : null;
  const left = games.filter((g) => !g.score).length;
  return (
    <div class="homecol">
      {f.events.map((e) => (
        <div class="nextgame event">
          <div class="lbl">LOCKER ROOM</div><p>{e.text}</p>
          <div class="row">{e.choices.map((c) => <button class="chip" onClick={() => { resolveEvent(fd, f, e.id, c.id); act(null); }}>{c.label}</button>)}</div>
        </div>
      ))}
      {ug && opp && !ug.score && (
        <div class="nextgame" style={{ borderColor: opp.c1 }}>
          <div class="lbl">{ug.round ? ug.round.toUpperCase() : `WEEK ${f.week}`} · {ug.home === f.user ? "HOME" : "AWAY"}</div>
          <h2>{ug.home === f.user ? "vs" : "@"} {opp.name} <small>({rec(opp)})</small></h2>
          <div class="row">
            <button class="big" disabled={running.has(ug.id)} onClick={() => onPlay(ug)}>PLAY ▶</button>
            <button class="chip" disabled={running.has(ug.id)} onClick={() => onSim(ug)}>{running.has(ug.id) ? "SIMMING…" : "SIM"}</button>
          </div>
        </div>
      )}
      {ug?.score && <div class="sub">{ug.home === f.user ? "YOU" : team(f, ug.home).abbr} {ug.score[0]} - {ug.score[1]} {ug.away === f.user ? "YOU" : team(f, ug.away).abbr}{ug.simmed ? " (sim)" : ""}</div>}
      {!ug && f.phase === "playoffs" && <div class="sub">{weekGames(f).length ? "YOU'RE NOT PLAYING THIS ROUND" : ""}</div>}
      <div class="sub">{left ? `OTHER GAMES: ${games.length - left - (ug && !ug.score ? 0 : 0)}/${games.length} FINAL…` : "ALL GAMES FINAL"}</div>
      <table class="drives"><tbody>{games.map((g) => <tr class={g === ug ? "score" : ""}><td>{g.round ?? ""}</td><td>{team(f, g.away).abbr} @ {team(f, g.home).abbr}</td><td>{g.score ? `${g.score[1]}-${g.score[0]}` : "…"}</td></tr>)}</tbody></table>
      <div class="row"><button class="big" disabled={!weekDone || f.events.length > 0} onClick={onNext}>{f.phase === "regular" && f.week === 17 ? "TO THE PLAYOFFS ▶" : "NEXT WEEK ▶"}</button></div>
      {f.events.length > 0 && <p class="hint">Settle the locker-room issue first.</p>}
      <div class="newslist">{f.news.slice(0, 6).map((n) => <div class={n.user ? "mine" : ""}>{n.text}</div>)}</div>
    </div>
  );
}

function PlayerRow({ fd, p, children }: { fd: FranchiseData; p: FPlayer; children?: preact.ComponentChildren }) {
  const c = fd.card(p);
  return (
    <tr>
      <td>{c.pos}</td><td>{c.name}{p.rookieYear ? " (R)" : ""}</td><td><b>{c.ovr}</b></td><td>{p.age}</td><td>{p.personality}</td>
      <td>${money(p.salary)}M x{p.years}</td><td>{p.injury > 0 ? `OUT ${p.injury}w` : ""}</td><td class="acts">{children}</td>
    </tr>
  );
}

function RosterTab({ fd, f, act, onLineup }: { fd: FranchiseData; f: Franchise; act: (e: string | null | undefined, ok?: string) => void; onLineup: () => void }) {
  const [trade, setTrade] = useState<number[]>([]);
  const [target, setTarget] = useState<string>("");
  const mine = teamPlayers(f, f.user).sort((a, b) => fd.ovr(b) - fd.ovr(a));
  const others = f.teams.filter((t) => t.abbr !== f.user);
  const [club, setClub] = useState(others[0]!.abbr);
  return (
    <div class="homecol">
      <div class="row"><button class="big" onClick={onLineup}>LINEUP & DEPTH CHART</button><span class="tag">{mine.length} PLAYERS · CAP SPACE ${money(capSpace(f, f.user))}M</span></div>
      <table class="drives roster"><thead><tr><th>POS</th><th>NAME</th><th>OVR</th><th>AGE</th><th>TYPE</th><th>CONTRACT</th><th></th><th></th></tr></thead>
        <tbody>{mine.map((p) => (
          <PlayerRow fd={fd} p={p}>
            <button class="chip" title={`${developCost(fd, p)} credits`} onClick={() => act(develop(fd, f, p.id), `${fd.card(p).name} improves`)}>+1 ({developCost(fd, p)})</button>
            {p.years <= 1 && <button class="chip" onClick={() => act(extend(fd, f, p.id, 3), `extended at $${money(askingSalary(fd, p))}M`)}>EXTEND ${money(askingSalary(fd, p))}M</button>}
            <button class={`chip ${trade.includes(p.id) ? "on" : ""}`} onClick={() => setTrade(trade.includes(p.id) ? trade.filter((x) => x !== p.id) : [...trade, p.id])}>OFFER</button>
            <button class="chip" onClick={() => { if (confirm(`Release ${fd.card(p).name}? (dead cap)`)) act(cut(fd, f, p.id)); }}>CUT</button>
          </PlayerRow>
        ))}</tbody></table>
      {trade.length > 0 && (
        <div class="nextgame">
          <div class="lbl">TRADE · OFFERING {trade.map((id) => fd.card(f.players[id]!).name).join(", ")}</div>
          <div class="row"><span class="lbl">FOR A PLAYER FROM</span>
            <select value={club} onChange={(e) => setClub((e.target as HTMLSelectElement).value)}>{others.map((t) => <option value={t.abbr}>{t.name}</option>)}</select>
            <select value={target} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
              <option value="">pick a player</option>
              {teamPlayers(f, club).sort((a, b) => fd.ovr(b) - fd.ovr(a)).map((p) => { const c = fd.card(p); return <option value={p.id}>{c.pos} {c.name} {c.ovr} (${money(p.salary)}M)</option>; })}
            </select>
            <button class="big" disabled={!target} onClick={() => { const e = proposeTrade(fd, f, trade, Number(target)); if (!e) { setTrade([]); setTarget(""); } act(e, "trade accepted!"); }}>PROPOSE</button>
          </div>
        </div>
      )}
    </div>
  );
}

function LeagueTab({ fd, f }: { fd: FranchiseData; f: Franchise }) {
  const [view, setView] = useState<"standings" | "schedule" | "leaders">("standings");
  const confs = [...new Set(f.teams.map((t) => t.conf))];
  return (
    <div class="homecol">
      <div class="tabs">{(["standings", "schedule", "leaders"] as const).map((k) => <button class={`chip ${view === k ? "on" : ""}`} onClick={() => setView(k)}>{k.toUpperCase()}</button>)}</div>
      {view === "standings" && confs.map((c) => (
        <table class="drives"><thead><tr><th>{c}</th><th>W-L</th><th>PF</th><th>PA</th><th>DIV</th></tr></thead>
          <tbody>{standings(f, c).map((t) => <tr class={t.abbr === f.user ? "score" : ""}><td>{t.name}</td><td>{rec(t)}</td><td>{t.pf}</td><td>{t.pa}</td><td>{t.div}</td></tr>)}</tbody></table>
      ))}
      {view === "schedule" && (
        <table class="drives"><tbody>{f.games.filter((g) => g.home === f.user || g.away === f.user).map((g) => (
          <tr class={g.week === f.week ? "next" : ""}><td>{g.round ?? `W${g.week}`}</td><td>{g.home === f.user ? "vs" : "@"} {team(f, g.home === f.user ? g.away : g.home).name}</td>
            <td>{g.score ? (() => { const us = g.home === f.user ? g.score[0] : g.score[1], them = g.home === f.user ? g.score[1] : g.score[0]; return `${us > them ? "W" : us < them ? "L" : "T"} ${us}-${them}`; })() : ""}</td></tr>
        ))}</tbody></table>
      )}
      {view === "leaders" && (
        <div class="leadgrid">{[["passYds", "PASSING YDS"], ["passTd", "PASS TD"], ["rushYds", "RUSHING YDS"], ["recYds", "RECEIVING YDS"], ["sacks", "SACKS"], ["defInts", "INTERCEPTIONS"]].map(([k, l]) => (
          <table class="drives"><thead><tr><th>{l}</th><th></th><th></th></tr></thead><tbody>{leaders(fd, f, k!, 5).map((x) => <tr class={x.team === f.user ? "score" : ""}><td>{x.name}</td><td>{x.team}</td><td>{x.value}</td></tr>)}</tbody></table>
        ))}</div>
      )}
    </div>
  );
}

function OfficeTab({ fd, f, act }: { fd: FranchiseData; f: Franchise; act: (e: string | null | undefined, ok?: string) => void }) {
  const F = fd.data.franchise;
  const staff: [StaffKind, string, string][] = [["oc", "OFFENSIVE COORDINATOR", "+offense ratings in games"], ["dc", "DEFENSIVE COORDINATOR", "+defense ratings in games"],
    ["st", "SPECIAL TEAMS COACH", "+kicking ratings in games"], ["trainer", "TRAINER", "fewer injuries, better progression"]];
  const fac: [FacilityKind, string, string][] = [["stadium", "STADIUM", "fan support, home credits"], ["training", "TRAINING", "progression"], ["rehab", "REHAB", "shorter injuries"]];
  return (
    <div class="homecol">
      <div class="sub">CREDITS {f.credits} · earned by wins, playoff wins, milestones and home crowds · facilities cost upkeep every off-season</div>
      <table class="drives"><tbody>
        {staff.map(([k, n, d]) => <tr><td>{n}</td><td>{"★".repeat(f.staff[k])}{"☆".repeat(F.staff.maxLevel - f.staff[k])}</td><td><small>{d}</small></td>
          <td>{f.staff[k] < F.staff.maxLevel && <button class="chip" onClick={() => act(upgradeStaff(fd, f, k), `${n.toLowerCase()} upgraded`)}>HIRE BETTER ({F.credits.staffCost[f.staff[k]]})</button>}</td></tr>)}
        {fac.map(([k, n, d]) => <tr><td>{n}</td><td>LEVEL {f.facilities[k]}/{F.facilities.maxLevel}</td><td><small>{d}</small></td>
          <td>{f.facilities[k] < F.facilities.maxLevel && <button class="chip" onClick={() => act(upgradeFacility(fd, f, k), `${n.toLowerCase()} upgraded`)}>UPGRADE ({F.credits.facilityCost[f.facilities[k]]})</button>}</td></tr>)}
      </tbody></table>
    </div>
  );
}

function HistoryTab({ f }: { f: Franchise }) {
  const label: Record<string, string> = { passYds: "Passing yards", passTd: "Passing TD", rushYds: "Rushing yards", rushTd: "Rushing TD", recYds: "Receiving yards", recTd: "Receiving TD", sacks: "Sacks", defInts: "Interceptions", tackles: "Tackles" };
  return (
    <div class="homecol">
      <div class="sub">CHAMPIONS</div>
      <div class="newslist">{f.champions.map((c) => <div class={c.team === f.user ? "mine" : ""}>Season {c.year}: {team(f, c.team).name}</div>)}{!f.champions.length && <div>none yet</div>}</div>
      <div class="sub">RECORDS BOOK</div>
      <table class="drives"><thead><tr><th></th><th>SINGLE GAME</th><th>SINGLE SEASON</th></tr></thead><tbody>{Object.keys(label).map((k) => {
        const g = f.records.game[k], s = f.records.season[k];
        return <tr><td>{label[k]}</td><td>{g ? `${g.value} · ${g.who} (${g.team}, Y${g.year})` : "-"}</td><td>{s ? `${s.value} · ${s.who} (${s.team}, Y${s.year})` : "-"}</td></tr>;
      })}</tbody></table>
      <div class="sub">AWARDS</div>
      <div class="newslist">{f.awards.map((a) => <div>Season {a.year} {a.award}: {a.who} ({a.team})</div>)}{!f.awards.length && <div>after the first season</div>}</div>
      <div class="sub">HALL OF FAME</div>
      <div class="newslist">{f.hof.map((h) => <div>{h.name} · {h.pos} · {h.years}</div>)}{!f.hof.length && <div>no one yet</div>}</div>
    </div>
  );
}

function Resign({ fd, f, act, pool }: { fd: FranchiseData; f: Franchise; act: (e: string | null | undefined, ok?: string) => void; pool: ClientData["pool"] }) {
  const ex = expiring(f).sort((a, b) => fd.ovr(b) - fd.ovr(a));
  return (
    <div class="homecol">
      <div class="nextgame"><div class="lbl">OFF-SEASON · RE-SIGN YOUR PLAYERS</div>
        <p class="hint">Contracts that ran out. Re-sign the ones you want (at their asking price); the rest become free agents when the draft starts. Cap space ${money(capSpace(f, f.user))}M.</p></div>
      <table class="drives roster"><tbody>{ex.map((p) => (
        <PlayerRow fd={fd} p={p}>{[1, 2, 3].map((y) => <button class="chip" onClick={() => act(resign(fd, f, p.id, y), `${fd.card(p).name} re-signed`)}>{y}Y ${money(askingSalary(fd, p))}M</button>)}</PlayerRow>
      ))}</tbody></table>
      {!ex.length && <p class="hint">No expiring contracts.</p>}
      <div class="row"><button class="big" onClick={() => { startDraft(fd, f, pool); act(null); }}>TO THE ROOKIE DRAFT ▶</button></div>
    </div>
  );
}

function RookieDraft({ fd, f, act }: { fd: FranchiseData; f: Franchise; act: (e: string | null | undefined, ok?: string) => void }) {
  const d = f.draft!;
  const mine = d.log.filter((x) => x.team === f.user);
  return (
    <div class="homecol">
      <div class="nextgame"><div class="lbl">ROOKIE DRAFT · ROUND {draftRound(fd, d)} · PICK {d.pick + 1}</div><p class="hint">Triple Draft: three prospects, pick one.</p>
        <div class="offers">{d.offers.map((id) => { const p = f.players[id]!, c = fd.card(p); return (
          <button class="card" onClick={() => { draftChoose(fd, f, id); act(null, `drafted ${c.name}`); }}>
            <div class="ctop"><span class="cpos">{c.pos}</span><span class="covr">{c.ovr}</span></div><b class="cname">{c.name}</b>
            <small class="carch">{c.arch} · age {p.age} · {p.personality}</small>
          </button>); })}</div>
      </div>
      <div class="sub">YOUR CLASS: {mine.map((x) => fd.card(f.players[x.player]!).name).join(", ") || "-"}</div>
      <div class="newslist">{d.log.slice(-12).reverse().map((x) => { const c = fd.card(f.players[x.player]!); return <div class={x.team === f.user ? "mine" : ""}>R{x.round} {x.team}: {c.pos} {c.name} ({c.ovr})</div>; })}</div>
    </div>
  );
}

function FreeAgency({ fd, f, act }: { fd: FranchiseData; f: Franchise; act: (e: string | null | undefined, ok?: string) => void }) {
  const fas = freeAgents(f).sort((a, b) => fd.ovr(b) - fd.ovr(a)).slice(0, 60);
  const [res, setRes] = useState<string[] | null>(null);
  return (
    <div class="homecol">
      <div class="nextgame"><div class="lbl">FREE AGENCY</div>
        <p class="hint">Make up to {fd.data.franchise.freeAgency.maxUserBids} offers. Players pick the best offer (fans make your club more attractive). Cap space ${money(capSpace(f, f.user))}M.</p>
        {res && <div class="newslist">{res.map((r) => <div>{r}</div>)}</div>}</div>
      <table class="drives roster"><tbody>{fas.map((p) => {
        const ask = askingSalary(fd, p), bid = f.bids.find((b) => b.player === p.id);
        return (
          <PlayerRow fd={fd} p={p}>
            {bid ? <span class="tag">OFFERED ${money(bid.salary)}M x{bid.years}</span> : <>
              <button class="chip" onClick={() => act(placeBid(fd, f, { player: p.id, salary: ask, years: 2 }), "offer made")}>OFFER ${money(ask)}M</button>
              <button class="chip" onClick={() => act(placeBid(fd, f, { player: p.id, salary: Math.round(ask * 1.2), years: 3 }), "offer made")}>+20% ${money(Math.round(ask * 1.2))}M</button></>}
          </PlayerRow>
        );
      })}</tbody></table>
      <div class="row"><button class="big" onClick={() => { const r = endFreeAgency(fd, f); setRes(r); act(null, `season ${f.year} begins`); }}>SIGNINGS & NEW SEASON ▶</button></div>
    </div>
  );
}
