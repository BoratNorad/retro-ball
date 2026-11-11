// Online screens (M8): lobby (quick match, private room by code), the waiting room, the online
// Triple Draft (server-timed, simultaneous reveal), the lineup builder and the match.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { PlayerCard } from "@tdf/shared";
import { rosterFromWire, rosterToWire, slotBasePos, type RoomSettings, type RoundReveal, type Roster } from "@tdf/sim";
import type { ClientData } from "../data.js";
import { NetClient } from "../net/client.js";
import { NetController } from "../game/netcontroller.js";
import { Game } from "./App.js";
import { GradeChips, Icon, Lineup, PALETTES, PlayerCardView, PostDraft, Reveal, SlotBoard, TeamEditor, type DraftConfigUi, type TeamSetup } from "./Draft.js";

const TEAM_KEY = "tdf.online.team";
function loadTeam(cd: ClientData): TeamSetup {
  try { const t = JSON.parse(localStorage.getItem(TEAM_KEY) ?? "null"); if (t?.info?.name) return t; } catch { /* none */ }
  const icons = Object.keys(cd.data.icons.icons);
  const k = Math.floor(Math.random() * PALETTES.length);
  return { info: { abbr: "YOU", name: "Your Team", nick: "Team", c1: PALETTES[k]![0], c2: PALETTES[k]![1], c3: PALETTES[k]![2] }, icon: icons[k % icons.length]! };
}
function useNet(net: NetClient) {
  const [, set] = useState(0);
  useEffect(() => net.subscribe(() => set((x) => x + 1)), [net]);
}
/** A countdown in whole seconds to a local deadline (ms). */
function useCountdown(deadline: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id); }, []);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function OnlineScreen({ cd, onExit }: { cd: ClientData; onExit: () => void }) {
  const net = useMemo(() => new NetClient(cd), []);
  useEffect(() => () => net.close(), [net]);
  useNet(net);
  const room = net.room;
  const conn = net.status !== "open" ? (net.status === "connecting" ? "CONNECTING TO THE SERVER…" : "CONNECTION LOST · RECONNECTING…") : null;
  const leave = () => { net.leave(); onExit(); };
  if (!room) return <Lobby cd={cd} net={net} conn={conn} onBack={() => { net.leave(); onExit(); }} />;
  const opp = room.seats[1 - room.side];
  if (room.phase === "lobby") {
    return (
      <div class="menu">
        <h1>ROOM <span>{room.code}</span></h1>
        <div class="sub">SHARE THIS CODE · WAITING FOR AN OPPONENT…</div>
        <p class="hint">{settingsText(room.settings)}</p>
        {conn && <div class="sub warn">{conn}</div>}
        <div class="row"><button class="chip" onClick={leave}>LEAVE</button></div>
      </div>
    );
  }
  if (room.phase === "draft" && net.draft) return <OnlineDraft cd={cd} net={net} conn={conn} />;
  if (room.phase === "lineup" && net.rosters) return <OnlineLineup cd={cd} net={net} conn={conn} />;
  if ((room.phase === "match" || room.phase === "results") && net.match) return <OnlineMatchView cd={cd} net={net} conn={conn} onLeave={leave} />;
  return <div class="center"><div class="title">{conn ?? "LOADING…"}</div>{opp && !opp.connected && <p class="hint">opponent disconnected</p>}</div>;
}

const settingsText = (s: RoomSettings) => [s.format === "quick" ? "QUICK DRAFT (24)" : "FULL DRAFT (32)", s.mirror && "MIRROR", s.themed && "THEMED",
  s.timer ? "PICK TIMER" : "NO PICK TIMER", `${s.quarterMinutes} MIN QUARTERS`, s.abilities ? "ABILITIES ON" : "ABILITIES OFF", s.controlDefender && "CONTROL DEFENDER"].filter(Boolean).join(" · ");

function Lobby({ cd, net, conn, onBack }: { cd: ClientData; net: NetClient; conn: string | null; onBack: () => void }) {
  const [team, setTeamRaw] = useState<TeamSetup>(() => loadTeam(cd));
  const setTeam = (t: TeamSetup) => { setTeamRaw(t); try { localStorage.setItem(TEAM_KEY, JSON.stringify(t)); } catch { /* private */ } };
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [st, setSt] = useState<RoomSettings>({ format: "quick", mirror: false, revealPassed: true, themed: false, timer: true, quarterMinutes: 3, abilities: true, controlDefender: false });
  const tog = (k: keyof RoomSettings) => setSt({ ...st, [k]: !st[k] });
  const ok = net.status === "open";
  return (
    <div class="menu">
      <h1>ONLINE <span>TRIPLE DRAFT</span></h1>
      {conn && <div class="sub warn">{conn}</div>}
      {net.error && <div class="sub warn">{net.error.toUpperCase()}</div>}
      {net.info && <div class="sub">{net.info.toUpperCase()}</div>}
      <TeamEditor cd={cd} t={team} set={setTeam} label="YOUR TEAM" />
      <div class="plays modes">
        <button class="play" disabled={!ok} onClick={() => net.quick(team)}><b>QUICK MATCH</b><small>quick draft · 3 min quarters · first opponent available</small></button>
        <button class={`play ${creating ? "on" : ""}`} disabled={!ok} onClick={() => setCreating(!creating)}><b>CREATE A ROOM</b><small>pick the rules, share the code</small></button>
      </div>
      {creating && (
        <div class="teamsetup">
          <div class="row"><span class="lbl">FORMAT</span>
            <button class={`chip ${st.format === "quick" ? "on" : ""}`} onClick={() => setSt({ ...st, format: "quick" })}>QUICK · 24</button>
            <button class={`chip ${st.format === "full" ? "on" : ""}`} onClick={() => setSt({ ...st, format: "full" })}>FULL · 32</button></div>
          <div class="row"><span class="lbl">RULES</span>
            <button class={`chip ${st.mirror ? "on" : ""}`} onClick={() => tog("mirror")}>MIRROR</button>
            <button class={`chip ${st.revealPassed ? "on" : ""}`} onClick={() => tog("revealPassed")}>REVEAL PASSED</button>
            <button class={`chip ${st.themed ? "on" : ""}`} onClick={() => tog("themed")}>THEMED ROUNDS</button>
            <button class={`chip ${st.timer ? "on" : ""}`} onClick={() => tog("timer")}>PICK TIMER</button></div>
          <div class="row"><span class="lbl">GAME</span>
            {[2, 3, 5, 8].map((m) => <button class={`chip ${st.quarterMinutes === m ? "on" : ""}`} onClick={() => setSt({ ...st, quarterMinutes: m })}>{m} MIN</button>)}
            <button class={`chip ${st.abilities ? "on" : ""}`} onClick={() => tog("abilities")}>ABILITIES</button>
            <button class={`chip ${st.controlDefender ? "on" : ""}`} onClick={() => tog("controlDefender")}>CONTROL DEFENDER</button></div>
          <div class="row"><button class="big" disabled={!ok} onClick={() => net.create(st, team)}>CREATE ROOM</button></div>
        </div>
      )}
      <div class="row">
        <span class="lbl">JOIN</span>
        <input class="search code" placeholder="ROOM CODE" value={code} maxLength={cd.data.online.codeLength} onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase())} />
        <button class="big" disabled={!ok || code.length !== cd.data.online.codeLength} onClick={() => net.join(code, team)}>JOIN</button>
      </div>
      <div class="row"><button class="chip" onClick={onBack}>BACK</button></div>
      <p class="hint">Both players draft at the same time from their own three options; picks are revealed together. Then each sets a lineup and you play: offense calls first, the defense sees the personnel and answers.</p>
    </div>
  );
}

/** The offline screens' config shape, built from the room (names, icons, settings). */
function cfgOf(net: NetClient): DraftConfigUi {
  const r = net.room!, s = r.settings;
  const t = (k: 0 | 1): TeamSetup => r.seats[k]?.team ?? { info: net.draftInit!.setups[k].info, icon: "star" };
  return { mode: "hotseat", teams: [t(0), t(1)], ai: "need", format: s.format, mirror: s.mirror, revealPassed: s.revealPassed, themed: s.themed, timer: s.timer, quarter: s.quarterMinutes };
}

function OnlineDraft({ cd, net, conn }: { cd: ClientData; net: NetClient; conn: string | null }) {
  const d = net.draft!, side = net.side, opp = (1 - side) as 0 | 1;
  const cfg = cfgOf(net);
  const [sel, setSel] = useState<PlayerCard | null>(null);
  const [showOpp, setShowOpp] = useState(false);
  const [shown, setShown] = useState(d.log.length);
  const left = useCountdown(net.pickDeadline);
  const reveal: RoundReveal | null = shown < d.log.length ? d.log[shown]! : null;
  useEffect(() => { setSel(null); }, [d.round, net.draftApplied]);
  const locked = net.lockedRound[side] === d.round && !d.done;
  const oppLocked = net.lockedRound[opp] === d.round && !d.done;
  const pick = (c: PlayerCard, slot: string | null) => { net.lockedRound[side] = d.round; net.error = null; net.send({ t: "pick", cardId: c.id, slot }); setSel(null); };
  const me = cfg.teams[side];
  const team = d.teams[side];
  const opRoom = net.room!.seats[opp];
  return (
    <div class="draft">
      <div class="dhead">
        <span class="dteam"><Icon cd={cd} id={me.icon} color={me.info.c1} /> <b>{me.info.name}</b> <GradeChips d={d} side={side} /></span>
        <span class="dround">ROUND {Math.min(d.round, d.rounds)}/{d.rounds}{d.theme ? ` · ${d.theme.label.toUpperCase()}` : ""}</span>
        <span class={`clock ${left <= cd.data.draft.pickWarningSec ? "low" : ""}`}>{left}</span>
      </div>
      {conn && <div class="sub warn">{conn}</div>}
      {net.error && <div class="sub warn">{net.error.toUpperCase()}</div>}
      <div class="sub">{locked ? "LOCKED IN · " : ""}{opRoom && !opRoom.connected ? `${cfg.teams[opp].info.abbr} DISCONNECTED (THE CLOCK PICKS FOR THEM)` : oppLocked ? `${cfg.teams[opp].info.abbr} HAS PICKED` : `${cfg.teams[opp].info.abbr} IS PICKING…`}</div>
      <div class={`offers ${locked ? "locked" : ""}`}>
        {d.offers(side).map((c) => {
          const best = d.bestSlot(side, c);
          return <PlayerCardView cd={cd} c={c} ovr={d.overallIn(c, best)} slotLabel={`best fit: ${slotBasePos(best)}`} selected={sel?.id === c.id} onClick={() => !locked && setSel(sel?.id === c.id ? null : c)} />;
        })}
      </div>
      <div class="tabs">
        <button class="chip" disabled={!sel || locked} onClick={() => sel && pick(sel, null)}>{locked ? "WAITING FOR THE REVEAL…" : sel ? `DRAFT ${(sel.name.split(" ").slice(-1)[0] ?? sel.name).toUpperCase()} · BEST FIT` : "PICK A PLAYER, THEN A SLOT"}</button>
        <button class="chip" disabled={team.rerolls <= 0 || locked} onClick={() => { setSel(null); net.send({ t: "reroll" }); }}>REROLL ({team.rerolls})</button>
        <button class={`chip ${showOpp ? "on" : ""}`} onClick={() => setShowOpp(!showOpp)}>{cfg.teams[opp].info.abbr} PICKS ({d.teams[opp].picks.length})</button>
      </div>
      {showOpp && (
        <div class="opplist">
          <GradeChips d={d} side={opp} />
          {d.teams[opp].picks.slice().reverse().map((p) => <div><small>R{p.round}</small> {slotBasePos(p.slot)} <b>{p.card.name}</b> {p.overallAtSlot}</div>)}
        </div>
      )}
      <SlotBoard d={d} side={side} card={locked ? null : sel} onSlot={(k) => sel && !locked && pick(sel, k)} />
      {reveal && <Reveal cd={cd} d={d} rev={reveal} cfg={cfg} onNext={() => setShown(shown + 1)} />}
    </div>
  );
}

function OnlineLineup({ cd, net, conn }: { cd: ClientData; net: NetClient; conn: string | null }) {
  const side = net.side;
  const cfg = cfgOf(net);
  const [rosters, setRosters] = useState<[Roster, Roster]>(() => [rosterFromWire(net.rosters![0], cd.byId), rosterFromWire(net.rosters![1], cd.byId)]);
  const [editing, setEditing] = useState(false);
  const left = useCountdown(net.lineupDeadline);
  const sent = net.ready[side];
  if (editing) {
    return <Lineup cd={cd} roster={rosters[side]} onDone={(r) => { const x: [Roster, Roster] = [...rosters]; x[side] = r; setRosters(x); setEditing(false); }} />;
  }
  return (
    <div>
      <div class="netbar">{conn ?? (sent ? `READY · WAITING FOR ${cfg.teams[1 - side]!.info.abbr}` : `SET YOUR LINEUP · KICKOFF IN ${left}s`)}</div>
      <PostDraft cd={cd} d={net.draft!} cfg={{ ...cfg, mode: side === 0 ? "ai" : "hotseat" }} rosters={rosters} setRosters={setRosters}
        onLineup={(s) => { if (s === side && !sent) setEditing(true); }}
        onKickoff={() => { if (!sent) net.send({ t: "lineup", roster: rosterToWire(rosters[side]) }); }} />
    </div>
  );
}

function OnlineMatchView({ cd, net, conn, onLeave }: { cd: ClientData; net: NetClient; conn: string | null; onLeave: () => void }) {
  // a fresh controller for every match replica (start, reconnect, resync)
  const ctl = useMemo(() => new NetController(cd, net), [net.matchVersion]);
  useEffect(() => () => ctl.dispose(), [ctl]);
  const r = net.results, me = net.side;
  const opp = net.room!.seats[1 - me];
  const oppAway = opp && !opp.connected ? `${opp.team.info.abbr} DISCONNECTED · WAITING ${cd.data.online.forfeitSeconds}s (THE AI PLAYS FOR THEM)` : null;
  const forfeit = r?.forfeit != null ? (r.forfeit === me ? "YOU FORFEITED" : `${opp?.team.info.abbr ?? "OPPONENT"} FORFEITED · YOU WIN`) : null;
  return (
    <Game key={net.matchVersion} ctl={ctl} banner={forfeit ?? conn ?? oppAway ?? null} exitLabel={r?.rematch[me] ? "WAITING FOR A REMATCH…" : "REMATCH (NEW DRAFT)"}
      onExit={() => net.send({ t: "rematch" })} extra={<button class="chip" onClick={onLeave}>LEAVE</button>} />
  );
}
