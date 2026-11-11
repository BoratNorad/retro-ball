import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import Phaser from "phaser";
import type { OffensePlay } from "@tdf/shared";
import { loadClientData, type ClientData } from "../data.js";
import { Controller, ordinal, spotText, toGoText, type UiState } from "../game/controller.js";
import { FieldScene } from "../render/FieldScene.js";
import { helmetCanvas } from "../render/sprites.js";
import { BoxScore } from "./BoxScore.js";

type Screen = { kind: "loading" } | { kind: "error"; msg: string } | { kind: "menu" } | { kind: "game"; ctl: Controller };

export function App() {
  const [cd, setCd] = useState<ClientData | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  useEffect(() => {
    loadClientData().then((d) => { setCd(d); setScreen({ kind: "menu" }); }).catch((e) => setScreen({ kind: "error", msg: String(e) }));
  }, []);
  if (screen.kind === "loading") return <div class="center"><div class="title">LOADING…</div></div>;
  if (screen.kind === "error") return <div class="center"><div class="title">ERROR</div><p>{screen.msg}</p></div>;
  if (screen.kind === "menu") return <Menu cd={cd!} onStart={(u, o, q) => setScreen({ kind: "game", ctl: new Controller(cd!, u, o, q) })} />;
  return <Game ctl={screen.ctl} onExit={() => setScreen({ kind: "menu" })} />;
}

// ---------------------------------------------------------------- menu
function Helmet({ team, scale = 3 }: { team: { abbr: string; c1: string; c2: string; c3: string }; scale?: number }) {
  const src = useMemo(() => helmetCanvas(team, scale).toDataURL(), [team.abbr, scale]);
  return <img class="helmet" src={src} alt={team.abbr} />;
}

function Menu({ cd, onStart }: { cd: ClientData; onStart: (user: string, opp: string, quarterMinutes: number) => void }) {
  const teams = [...cd.data.teams.teams].sort((a, b) => a.name.localeCompare(b.name));
  const [user, setUser] = useState<string | null>(null);
  const [opp, setOpp] = useState<string | null>(null);
  const [qm, setQm] = useState(5);
  const picking = !user ? "YOUR TEAM" : "OPPONENT";
  return (
    <div class="menu">
      <h1>TRIPLE DRAFT <span>FOOTBALL</span></h1>
      <div class="sub">PICK {picking}</div>
      <div class="teams">
        {teams.map((t) => (
          <button class={`team ${user === t.abbr ? "you" : ""} ${opp === t.abbr ? "them" : ""}`} disabled={user === t.abbr}
            onClick={() => (!user ? setUser(t.abbr) : setOpp(t.abbr))}>
            <Helmet team={t} />
            <span>{t.abbr}</span>
          </button>
        ))}
      </div>
      <div class="row">
        <span class="lbl">QUARTER</span>
        {[3, 5, 8, 15].map((m) => <button class={`chip ${qm === m ? "on" : ""}`} onClick={() => setQm(m)}>{m} MIN</button>)}
      </div>
      <div class="row">
        {user && <button class="chip" onClick={() => { setUser(null); setOpp(null); }}>RESET</button>}
        <button class="big" disabled={!user || !opp} onClick={() => onStart(user!, opp!, qm)}>
          {user && opp ? `PLAY ${user} vs ${opp}` : "PICK TWO TEAMS"}
        </button>
      </div>
      <p class="hint">Real Madden 27 rosters. You control the offense: pull back and release to throw, hold a finger on the field to run.</p>
    </div>
  );
}

// ---------------------------------------------------------------- game
function useUi(ctl: Controller): UiState {
  const [ui, setUi] = useState(ctl.ui);
  useEffect(() => ctl.subscribe(() => setUi(ctl.ui)), [ctl]);
  return ui;
}

function Game({ ctl, onExit }: { ctl: Controller; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const ui = useUi(ctl);
  useEffect(() => {
    const game = new Phaser.Game({
      type: Phaser.AUTO, parent: host.current!, backgroundColor: "#12141c", pixelArt: true,
      scale: { mode: Phaser.Scale.RESIZE, width: host.current!.clientWidth, height: host.current!.clientHeight },
      input: { activePointers: 2 },
    });
    game.scene.add("field", FieldScene, true, { ctl });
    return () => game.destroy(true);
  }, [ctl]);
  useKeyboard(ctl);
  return (
    <div class="game">
      <div class="stage" ref={host} />
      <ScoreBug ctl={ctl} />
      {ui.toast && ui.mode === "result" && <div class="toast">{ui.toast}</div>}
      {ui.bigToast && <div class="bigtoast">{ui.bigToast}</div>}
      <div class="bottom">
        {ui.mode === "callOffense" && <OffenseSheet ctl={ctl} />}
        {ui.mode === "callDefense" && <DefenseSheet ctl={ctl} />}
        {ui.mode === "callTry" && <TrySheet ctl={ctl} />}
        {ui.mode === "presnap" && (
          <div class="bar">
            <span class="playname">{ctl.live?.play.name} vs {ctl.live?.call.name}</span>
            <button class="big" onClick={() => ctl.snapBall()}>SNAP ▶</button>
          </div>
        )}
        {ui.mode === "live" && ui.userOffense && <LiveControls ctl={ctl} ui={ui} />}
        {ui.mode === "live" && !ui.userOffense && (
          <div class="bar"><span class="playname">{ctl.team(ctl.live!.offSide).abbr}: {ctl.live?.play.name} · you: {ctl.live?.call.name}</span>
            <button class="chip" onClick={() => ctl.fastForward()}>SKIP ▶▶</button></div>
        )}
      </div>
      {ui.mode === "final" && (
        <div class="overlay">
          <BoxScore r={ctl.result()} />
          <button class="big" onClick={onExit}>PLAY AGAIN</button>
        </div>
      )}
    </div>
  );
}

function ScoreBug({ ctl }: { ctl: Controller }) {
  const ui = useUi(ctl);
  void ui;
  const s = ctl.state;
  const sec = Math.ceil(s.clock / ctl.session.rules.tickHz);
  const clock = s.quarter > 4 ? `OT${s.quarter - 4}` : `Q${s.quarter} ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  const t0 = ctl.team(0), t1 = ctl.team(1);
  const dd = s.phase === "play" ? `${ordinal(s.down)} & ${toGoText(s)} · ${spotText(s.ballOn)}` : s.phase === "try" ? "TRY" : s.phase === "kickoff" ? "KICKOFF" : "FINAL";
  const dot = (side: 0 | 1) => (s.possession === side && s.phase === "play" ? "●" : "");
  return (
    <div class="bug">
      <div class="side" style={{ background: t0.c1 }}><b>{t0.abbr}</b><i>{dot(0)}</i><span>{s.score[0]}</span><small>{"▮".repeat(s.timeouts[0])}</small></div>
      <div class="mid"><div>{clock}</div><div class="dd">{dd}</div></div>
      <div class="side" style={{ background: t1.c1 }}><span>{s.score[1]}</span><i>{dot(1)}</i><b>{t1.abbr}</b><small>{"▮".repeat(s.timeouts[1])}</small></div>
    </div>
  );
}

function OffenseSheet({ ctl }: { ctl: Controller }) {
  const [tab, setTab] = useState<"run" | "pass">("pass");
  const [flip, setFlip] = useState(false);
  const plays = ctl.cd.data.offense.plays.filter((p) => p.kind === tab && (p.weight > 0 || p.tags.includes("sneak")));
  const s = ctl.state;
  const fg = ctl.ui.fg;
  const twoPt = ctl.pendingTry === "twoPoint";
  const pick = (p: OffensePlay) => ctl.callOffense({ kind: "play", play: p, flip });
  return (
    <div class="sheet">
      <div class="tabs">
        <button class={`chip ${tab === "pass" ? "on" : ""}`} onClick={() => setTab("pass")}>PASS</button>
        <button class={`chip ${tab === "run" ? "on" : ""}`} onClick={() => setTab("run")}>RUN</button>
        <button class={`chip ${flip ? "on" : ""}`} onClick={() => setFlip(!flip)}>FLIP ⇆</button>
        {twoPt && <span class="tag">2-POINT TRY</span>}
      </div>
      <div class="plays">
        {plays.map((p) => <button class="play" onClick={() => pick(p)}><b>{p.name}</b><small>{p.tags.slice(0, 2).join(" · ")}</small></button>)}
      </div>
      {!twoPt && (
        <div class="tabs">
          {s.down === 4 && <button class="chip" onClick={() => ctl.callOffense({ kind: "punt" })}>PUNT</button>}
          {fg && fg.pct > 0 && <button class="chip" onClick={() => ctl.callOffense({ kind: "fieldGoal" })}>FG {fg.dist} YD · {fg.pct}%</button>}
          <button class="chip" onClick={() => ctl.callOffense({ kind: "kneel" })}>KNEEL</button>
          <button class="chip" onClick={() => ctl.callOffense({ kind: "spike" })}>SPIKE</button>
          {s.timeouts[ctl.userSide] > 0 && <button class={`chip ${ctl.timeoutQueued ? "on" : ""}`} onClick={() => ctl.callTimeout()}>TIMEOUT</button>}
        </div>
      )}
    </div>
  );
}

function DefenseSheet({ ctl }: { ctl: Controller }) {
  const s = ctl.state;
  return (
    <div class="sheet">
      <div class="tabs"><span class="tag">DEFENSE · {ctl.team(s.possession).abbr} has the ball{s.phase === "try" ? " (try)" : ""}</span></div>
      <div class="plays">
        <button class="play" onClick={() => ctl.callDefense(null)}><b>Coach's call</b><small>auto</small></button>
        {ctl.cd.data.defense.calls.map((c) => <button class="play" onClick={() => ctl.callDefense(c)}><b>{c.name}</b><small>{c.tags.join(" · ")}</small></button>)}
      </div>
      {s.timeouts[ctl.userSide] > 0 && s.phase === "play" && (
        <div class="tabs"><button class={`chip ${ctl.timeoutQueued ? "on" : ""}`} onClick={() => ctl.callTimeout()}>TIMEOUT</button></div>
      )}
    </div>
  );
}

function TrySheet({ ctl }: { ctl: Controller }) {
  return (
    <div class="sheet">
      <div class="tabs"><span class="tag">TOUCHDOWN — TRY</span></div>
      <div class="plays">
        {!ctl.ui.tryForTwo && <button class="play" onClick={() => ctl.callTry("pat")}><b>Extra point</b><small>1 pt</small></button>}
        <button class="play" onClick={() => ctl.callTry("twoPoint")}><b>Go for 2</b><small>pick a play</small></button>
      </div>
    </div>
  );
}

function LiveControls({ ctl, ui }: { ctl: Controller; ui: UiState }) {
  const act = (a: "juke" | "spin" | "burst" | "scramble") => (e: Event) => { e.preventDefault(); ctl.input.action = a; };
  if (ui.qbCanThrow) {
    return (
      <div class="bar">
        <span class="playname">PULL BACK &amp; RELEASE TO THROW</span>
        <button class="act" onPointerDown={act("scramble")}>RUN</button>
      </div>
    );
  }
  if (ui.userCarrier) {
    const cd = ui.cooldowns;
    return (
      <div class="bar acts">
        <button class={`act ${cd.juke ? "cool" : ""}`} onPointerDown={act("juke")}>JUKE</button>
        <button class={`act ${cd.spin ? "cool" : ""}`} onPointerDown={act("spin")}>SPIN</button>
        <button class={`act ${cd.burst ? "cool" : ""}`} onPointerDown={act("burst")}>BURST</button>
      </div>
    );
  }
  return <div class="bar"><span class="playname">…</span></div>;
}

function useKeyboard(ctl: Controller) {
  useEffect(() => {
    const keys = new Set<string>();
    const update = () => {
      let x = 0, y = 0;
      if (keys.has("ArrowLeft") || keys.has("a")) x -= 1;
      if (keys.has("ArrowRight") || keys.has("d")) x += 1;
      if (keys.has("ArrowUp") || keys.has("w")) y += 1;
      if (keys.has("ArrowDown") || keys.has("s")) y -= 1;
      if (x || y) ctl.input.move = { x: x * 65536, y: y * 65536 };
      else if (ctl.input.move && [...keys].length === 0) ctl.input.move = null;
    };
    const down = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === "Enter") { ctl.snapBall(); return; }
      if (k === " ") { ctl.input.action = "juke"; e.preventDefault(); return; }
      if (k === "e") { ctl.input.action = "spin"; return; }
      if (k === "Shift") { ctl.input.action = "burst"; return; }
      if (k === "r") { ctl.input.action = "scramble"; return; }
      keys.add(k); update();
    };
    const up = (e: KeyboardEvent) => { keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); update(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [ctl]);
}
