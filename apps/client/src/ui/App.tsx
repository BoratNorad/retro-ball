import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import Phaser from "phaser";
import type { DefenseCall, OffensePlay } from "@tdf/shared";
import { HOT_ROUTES, runRate, situation, type MotionKind, type PlayCall, type Tendencies, type UserInput } from "@tdf/sim";
type UserInputAction = NonNullable<UserInput["action"]>;
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
      <p class="hint">Real Madden 27 rosters. On offense: pull back and release to throw, hold a finger on the field to run. On defense: call a front and coverage, and (if you turn on CONTROL DEFENDER in the defense call screen) play one defender yourself.</p>
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
        {ui.mode === "presnap" && ctl.live && <Presnap ctl={ctl} ui={ui} />}
        {ui.mode === "live" && ui.userOffense && <LiveControls ctl={ctl} ui={ui} />}
        {ui.mode === "live" && !ui.userOffense && ui.userDefense && <DefenseControls ctl={ctl} />}
        {ui.mode === "live" && !ui.userOffense && !ui.userDefense && (
          <div class="bar"><span class="playname">{ctl.team(ctl.live!.offSide).abbr} offense · you: {ctl.live?.call.name}</span>
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

const formationName = (ctl: Controller, id: string) => ctl.cd.data.formations.offense.find((f) => f.id === id)?.name ?? id;
const frontName = (ctl: Controller, id: string) => ctl.cd.data.formations.defense.find((f) => f.id === id)?.name ?? id;
const persName = (ctl: Controller, id: string) => ctl.cd.data.formations.personnel[id]?.name ?? id;

type OTab = "suggested" | "run" | "pass" | "rpo";
function OffenseSheet({ ctl }: { ctl: Controller }) {
  const data = ctl.cd.data;
  const [tab, setTab] = useState<OTab>("suggested");
  const [flip, setFlip] = useState(false);
  const [pers, setPers] = useState("all");
  const [form, setForm] = useState("all");
  const [q, setQ] = useState("");
  const [scout, setScout] = useState(false);
  const s = ctl.state;
  const fg = ctl.ui.fg;
  const twoPt = ctl.pendingTry === "twoPoint";
  const forms = data.formations.offense.filter((f) => pers === "all" || f.personnel.includes(pers));
  const fits = (p: OffensePlay) => p.formations.some((fid) => (form === "all" || fid === form) && forms.some((f) => f.id === fid));
  const needle = q.trim().toLowerCase();
  const match = (p: OffensePlay) => !needle || [p.name, p.group, ...p.tags].some((t) => t.toLowerCase().includes(needle));
  let calls: PlayCall[];
  if (tab === "suggested" && !needle) calls = ctl.suggestions();
  else {
    const kinds = tab === "suggested" ? ["run", "pass", "rpo"] : [tab];
    calls = data.offense.plays
      .filter((p) => kinds.includes(p.kind) && (p.weight > 0 || p.tags.includes("sneak") || p.tags.includes("hailMary")) && fits(p) && match(p))
      .sort((x, y) => x.group.localeCompare(y.group) || x.name.localeCompare(y.name))
      .map((p) => {
        const fid = form !== "all" && p.formations.includes(form) ? form : p.formations.find((f) => forms.some((x) => x.id === f)) ?? p.formations[0]!;
        const fo = data.formations.offense.find((f) => f.id === fid)!;
        return { play: p, formation: fid, personnel: pers !== "all" && fo.personnel.includes(pers) ? pers : fo.personnel[0]!, flip: false };
      });
  }
  const pick = (c: PlayCall) => ctl.callOffense({ kind: "play", play: c.play, formation: c.formation, personnel: c.personnel, flip });
  return (
    <div class="sheet">
      <div class="tabs">
        {(["suggested", "run", "pass", "rpo"] as OTab[]).map((t) => <button class={`chip ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t === "suggested" ? "SUGGESTED" : t.toUpperCase()}</button>)}
        <button class={`chip ${flip ? "on" : ""}`} onClick={() => setFlip(!flip)}>FLIP ⇆</button>
        <input class="search" placeholder="search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        {twoPt && <span class="tag">2-POINT TRY</span>}
      </div>
      {tab !== "suggested" && (
        <>
          <div class="scroller">
            <span class="lbl">PERSONNEL</span>
            {["all", ...Object.keys(data.formations.personnel)].map((p) => (
              <button class={`chip ${pers === p ? "on" : ""}`} title={p === "all" ? "" : persName(ctl, p)} onClick={() => { setPers(p); setForm("all"); }}>{p === "all" ? "ALL" : p}</button>
            ))}
          </div>
          <div class="scroller">
            <span class="lbl">FORMATION</span>
            <button class={`chip ${form === "all" ? "on" : ""}`} onClick={() => setForm("all")}>ALL</button>
            {forms.map((f) => <button class={`chip ${form === f.id ? "on" : ""}`} onClick={() => setForm(f.id)}>{f.name}</button>)}
          </div>
        </>
      )}
      {scout && <Scout ctl={ctl} side={s.possession === 0 ? 1 : 0} mode="defense" />}
      <div class="plays">
        {calls.map((c) => (
          <button class="play" onClick={() => pick(c)}>
            <b>{c.play.name}</b>
            <small>{formationName(ctl, c.formation)} · {c.personnel}</small>
            <small class="grp">{c.play.group}</small>
          </button>
        ))}
        {!calls.length && <span class="tag">no plays match</span>}
      </div>
      {!twoPt && (
        <div class="tabs">
          {s.down === 4 && <button class="chip" onClick={() => ctl.callOffense({ kind: "punt" })}>PUNT</button>}
          {fg && fg.pct > 0 && <button class="chip" onClick={() => ctl.callOffense({ kind: "fieldGoal" })}>FG {fg.dist} YD · {fg.pct}%</button>}
          <button class="chip" onClick={() => ctl.callOffense({ kind: "kneel" })}>KNEEL</button>
          <button class="chip" onClick={() => ctl.callOffense({ kind: "spike" })}>SPIKE</button>
          {s.timeouts[ctl.userSide] > 0 && <button class={`chip ${ctl.timeoutQueued ? "on" : ""}`} onClick={() => ctl.callTimeout()}>TIMEOUT</button>}
          <button class={`chip ${scout ? "on" : ""}`} onClick={() => setScout(!scout)}>SCOUT</button>
        </div>
      )}
    </div>
  );
}

/** Scouting report: what the other side has shown this game. */
function Scout({ ctl, side, mode }: { ctl: Controller; side: 0 | 1; mode: "offense" | "defense" }) {
  const t: Tendencies = ctl.session.tend[side];
  const abbr = ctl.team(side).abbr;
  if (mode === "defense") {
    const n = t.defSnaps;
    return (
      <div class="scout">
        <b>{abbr} DEFENSE</b> {n ? `${n} snaps · blitz ${Math.round(100 * t.blitz / n)}% · man ${Math.round(100 * t.man / n)}%` : "no snaps yet"}
      </div>
    );
  }
  const total = Object.values(t.calls).reduce((a, b) => a + b.run + b.pass, 0);
  const rr = runRate(t, ctl.cd.data);
  const here = t.calls[situation(ctl.state)];
  const topF = Object.entries(t.formations).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <div class="scout">
      <b>{abbr} OFFENSE</b> {total ? `${total} plays · run ${Math.round(rr * 100)}%` : "no plays yet"}
      {here && <span> · on {situation(ctl.state)}: {here.run} run / {here.pass} pass</span>}
      {topF.length > 0 && <span> · likes {topF.map(([f, c]) => `${formationName(ctl, f)} (${c})`).join(", ")}</span>}
    </div>
  );
}

function DefenseSheet({ ctl }: { ctl: Controller }) {
  const data = ctl.cd.data;
  const s = ctl.state;
  const ui = useUi(ctl);
  const [front, setFront] = useState<string | null>(null);
  const [scout, setScout] = useState(false);
  const groups = [...new Set(data.defense.calls.map((c) => c.group))];
  const call = (c: DefenseCall | null) => ctl.callDefense(c, front);
  const off = ctl.team(s.possession).abbr;
  return (
    <div class="sheet">
      <div class="tabs">
        <span class="tag">DEFENSE · {off} {s.phase === "try" ? "try" : ui.preview ? `sends in ${persName(ctl, ui.preview.personnel)}` : "has the ball"}</span>
      </div>
      <div class="scroller">
        <span class="lbl">FRONT</span>
        <button class={`chip ${front === null ? "on" : ""}`} onClick={() => setFront(null)}>MATCH</button>
        {data.formations.defense.map((f) => <button class={`chip ${front === f.id ? "on" : ""}`} onClick={() => setFront(f.id)}>{f.name}</button>)}
      </div>
      {scout && <Scout ctl={ctl} side={s.possession} mode="offense" />}
      <div class="plays">
        <button class="play" onClick={() => call(null)}><b>Coach's call</b><small>front + coverage</small></button>
        {groups.flatMap((g) => data.defense.calls.filter((c) => c.group === g && !(front && c.notFrom.includes(front))).map((c) => (
          <button class="play" onClick={() => call(c)}><b>{c.name}</b><small>{c.tags.join(" · ")}</small><small class="grp">{g}</small></button>
        )))}
      </div>
      <div class="tabs">
        <button class={`chip ${ctl.settings.controlDefense ? "on" : ""}`} onClick={() => ctl.setControlDefense(!ctl.settings.controlDefense)}>
          CONTROL DEFENDER: {ctl.settings.controlDefense ? "ON" : "OFF"}
        </button>
        {s.timeouts[ctl.userSide] > 0 && s.phase === "play" && <button class={`chip ${ctl.timeoutQueued ? "on" : ""}`} onClick={() => ctl.callTimeout()}>TIMEOUT</button>}
        <button class={`chip ${scout ? "on" : ""}`} onClick={() => setScout(!scout)}>SCOUT</button>
      </div>
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
  if (ui.canKeep) {
    return (
      <div class="bar">
        <span class="playname">READ OPTION · TAP KEEP OR IT'S A HANDOFF</span>
        <button class="act" onPointerDown={(e) => { e.preventDefault(); ctl.input.action = "keep"; }}>KEEP</button>
      </div>
    );
  }
  if (ui.qbCanThrow) {
    const rpo = ctl.live?.play.kind === "rpo";
    return (
      <div class="bar">
        <span class="playname">{rpo ? "RPO · THROW NOW OR IT'S A HANDOFF" : "PULL BACK & RELEASE TO THROW"}</span>
        {!rpo && <button class="act" onPointerDown={act("scramble")}>RUN</button>}
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

// ---------------------------------------------------------------- pre-snap
type PTab = "motion" | "shift" | "hot" | "protect" | "audible" | "look" | "cover" | "spy" | "double" | null;
function Presnap({ ctl, ui }: { ctl: Controller; ui: UiState }) {
  const [tab, setTab] = useState<PTab>(null);
  const [who, setWho] = useState<string | null>(null);
  const live = ctl.live!;
  const data = ctl.cd.data;
  const cur = ctl.cur;
  const num = (side: "O" | "D", role: string) => cur?.actors.find((a) => a.side === side && a.role === role)?.num ?? "";
  const off = live.userOffense;
  const po = ctl.preOff, pd = ctl.preDef;
  const T = (t: PTab, label: string, on = false) => <button class={`chip ${tab === t ? "on" : on ? "set" : ""}`} onClick={() => { setTab(tab === t ? null : t); setWho(null); }}>{label}</button>;
  const ELIG = ["X", "Y", "Z", "H", "RB"];
  const routeRoles = ELIG.filter((r) => live.play.routes?.[r] && live.play.kind !== "run");
  const sub = (() => {
    switch (tab) {
      case "motion": return (
        <div class="scroller">
          {!who && <>
            <button class={`chip ${po.motion === null ? "on" : ""}`} onClick={() => ctl.setPreOff({ motion: null })}>NONE</button>
            {ELIG.map((r) => <button class="chip" onClick={() => setWho(r)}>{r} #{num("O", r)}</button>)}
          </>}
          {who && (["jet", "across", "orbit", "short", "return"] as MotionKind[]).map((k) => (
            <button class="chip" onClick={() => { ctl.setPreOff({ motion: { role: who, kind: k } }); setWho(null); setTab(null); }}>{who} {k.toUpperCase()}</button>
          ))}
        </div>);
      case "shift": return (
        <div class="scroller">
          {([[null, "NONE"], ["yOther", "Y OTHER SIDE"], ["yFlex", "Y FLEX"], ["zTight", "Z TIGHT"]] as const).map(([k, l]) => (
            <button class={`chip ${(po.shift ?? null) === k ? "on" : ""}`} onClick={() => ctl.setPreOff({ shift: k })}>{l}</button>))}
        </div>);
      case "hot": return (
        <div class="scroller">
          {!routeRoles.length && <span class="tag">run play: no hot routes</span>}
          {!who && routeRoles.map((r) => <button class={`chip ${po.hot?.[r] ? "set" : ""}`} onClick={() => setWho(r)}>{r} #{num("O", r)} · {(po.hot?.[r] ?? live.play.routes![r]!).split(":")[0]}</button>)}
          {who && HOT_ROUTES.map((rt) => (
            <button class="chip" onClick={() => { ctl.setPreOff({ hot: { ...(po.hot ?? {}), [who]: rt } }); setWho(null); }}>{rt.toUpperCase()}</button>))}
        </div>);
      case "protect": return (
        <div class="scroller">
          {([[null, "NO SLIDE"], ["L", "SLIDE LEFT"], ["R", "SLIDE RIGHT"]] as const).map(([k, l]) => (
            <button class={`chip ${(po.slide ?? null) === k ? "on" : ""}`} onClick={() => ctl.setPreOff({ slide: k })}>{l}</button>))}
          {["Y", "RB", "H"].filter((r) => routeRoles.includes(r)).map((r) => {
            const on = po.keepIn?.includes(r);
            return <button class={`chip ${on ? "on" : ""}`} onClick={() => ctl.setPreOff({ keepIn: on ? po.keepIn!.filter((x) => x !== r) : [...(po.keepIn ?? []), r] })}>KEEP {r} IN</button>;
          })}
        </div>);
      case "audible": {
        const side = off ? "off" : "def";
        const slots = ctl.audibleSlots(side);
        return (
          <div class="scroller">
            {off && <button class={`chip ${live.flip ? "on" : ""}`} onClick={() => ctl.adjust({ flip: !live.flip })}>FLIP ⇆</button>}
            {slots.map((id, k) => {
              const name = off ? data.offense.plays.find((p) => p.id === id)?.name : data.defense.calls.find((c) => c.id === id)?.name;
              return (
                <span class="slot">
                  <button class="chip" onClick={() => {
                    if (off) { const p = data.offense.plays.find((x) => x.id === id); if (p) ctl.audibleOff(p); }
                    else { const c = data.defense.calls.find((x) => x.id === id); if (c) ctl.adjust({ call: c }); }
                  }}>{k + 1}. {name ?? id}</button>
                  <select value={id} onChange={(e) => ctl.setAudibleSlot(side, k, (e.target as HTMLSelectElement).value)}>
                    {(off ? data.offense.plays.filter((p) => p.weight > 0) : data.defense.calls).map((x) => <option value={x.id}>{x.name}</option>)}
                  </select>
                </span>
              );
            })}
          </div>);
      }
      case "look": return (
        <div class="scroller">
          <span class="lbl">LINE</span>
          {([[null, "NORMAL"], ["over", "OVER"], ["under", "UNDER"], ["pinch", "PINCH"], ["spread", "SPREAD"]] as const).map(([k, l]) => (
            <button class={`chip ${(pd.dl ?? null) === k ? "on" : ""}`} onClick={() => ctl.setPreDef({ dl: k })}>{l}</button>))}
          <span class="lbl">LBS</span>
          {([[null, "NORMAL"], ["in", "IN"], ["out", "OUT"]] as const).map(([k, l]) => (
            <button class={`chip ${(pd.lb ?? null) === k ? "on" : ""}`} onClick={() => ctl.setPreDef({ lb: k })}>{l}</button>))}
          <button class={`chip ${pd.show ? "on" : ""}`} onClick={() => ctl.setPreDef({ show: !pd.show })}>SHOW BLITZ</button>
        </div>);
      case "cover": return (
        <div class="scroller">
          <span class="lbl">SAFETIES</span>
          {([[null, "AS CALLED"], ["one", "1-HIGH LOOK"], ["two", "2-HIGH LOOK"]] as const).map(([k, l]) => (
            <button class={`chip ${(pd.safeties ?? null) === k ? "on" : ""}`} onClick={() => ctl.setPreDef({ safeties: k })}>{l}</button>))}
          <span class="lbl">CORNERS</span>
          {([[null, "NORMAL"], ["press", "PRESS"], ["bail", "BAIL"]] as const).map(([k, l]) => (
            <button class={`chip ${(pd.corners ?? null) === k ? "on" : ""}`} onClick={() => ctl.setPreDef({ corners: k })}>{l}</button>))}
        </div>);
      case "spy": return (
        <div class="scroller">
          <button class={`chip ${!pd.spy ? "on" : ""}`} onClick={() => ctl.setPreDef({ spy: null })}>NO SPY</button>
          {(cur?.actors ?? []).filter((a) => a.side === "D").map((a) => (
            <button class={`chip ${pd.spy === a.role ? "on" : ""}`} onClick={() => ctl.setPreDef({ spy: a.role })}>{a.role} #{a.num ?? ""}</button>))}
        </div>);
      case "double": return (
        <div class="scroller">
          <button class={`chip ${!pd.double ? "on" : ""}`} onClick={() => ctl.setPreDef({ double: null })}>NONE</button>
          {ELIG.map((r) => <button class={`chip ${pd.double === r ? "on" : ""}`} onClick={() => ctl.setPreDef({ double: r })}>{r} #{num("O", r)}</button>)}
        </div>);
      default: return null;
    }
  })();
  const motionOn = Boolean(cur?.presnap);
  return (
    <div class="sheet presnap">
      <div class="tabs">
        <span class={`clock ${ui.playClock < 4 ? "low" : ""}`}>{Math.ceil(ui.playClock)}</span>
        <span class="playname">{off
          ? `${live.play.name} · ${formationName(ctl, live.formation)}${live.flip ? " (flip)" : ""} vs ${frontName(ctl, live.front)}`
          : `${live.call.name} (${frontName(ctl, live.front)}) vs ${live.personnel} personnel`}</span>
      </div>
      <div class="tabs">
        {off ? <>
          {T("motion", motionOn ? "MOTION ▶" : "MOTION", Boolean(po.motion))}{T("shift", "SHIFT", Boolean(po.shift))}{T("hot", "HOT ROUTE", Boolean(po.hot && Object.keys(po.hot).length))}
          {T("protect", "PROTECT", Boolean(po.slide || po.keepIn?.length))}{T("audible", "AUDIBLE")}
          {!live.hardCounted && !live.twoPoint && <button class="chip" onClick={() => ctl.hardCount()}>HARD COUNT</button>}
          {live.play.option && <button class={`chip ${ctl.optionKeep ? "on" : ""}`} onClick={() => ctl.setOptionKeep(!ctl.optionKeep)}>{ctl.optionKeep ? "QB KEEPS" : "HAND OFF"}</button>}
        </> : <>
          {T("look", "FRONT LOOK", Boolean(pd.dl || pd.lb || pd.show))}{T("cover", "SHELL", Boolean(pd.safeties || pd.corners))}{T("spy", "SPY", Boolean(pd.spy))}
          {T("double", "DOUBLE", Boolean(pd.double))}{T("audible", "AUDIBLE")}
        </>}
        <button class="big" onClick={() => ctl.snapBall()}>{off ? "SNAP ▶" : "READY ▶"}</button>
      </div>
      {sub}
    </div>
  );
}

function DefenseControls({ ctl }: { ctl: Controller }) {
  const act = (a: "dive" | "strip" | "swat" | "switch") => (e: Event) => { e.preventDefault(); ctl.input.action = a; };
  return (
    <div class="bar acts">
      <span class="playname">DRAG TO MOVE</span>
      <button class="act alt" onPointerDown={act("switch")}>SWITCH</button>
      <button class="act alt" onPointerDown={act("swat")}>SWAT</button>
      <button class="act alt" onPointerDown={act("strip")}>STRIP</button>
      <button class="act" onPointerDown={act("dive")}>DIVE</button>
    </div>
  );
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
      if (ctl.live?.userDefense) {
        // defense: Space dive, E swat, Q strip, Tab/C switch
        const m: Record<string, UserInputAction> = { " ": "dive", e: "swat", q: "strip", Tab: "switch", c: "switch" };
        if (m[k]) { ctl.input.action = m[k]; e.preventDefault(); return; }
      } else {
        if (k === " ") { ctl.input.action = ctl.ui.canKeep ? "keep" : "juke"; e.preventDefault(); return; }
        if (k === "e") { ctl.input.action = "spin"; return; }
        if (k === "Shift") { ctl.input.action = "burst"; return; }
        if (k === "r") { ctl.input.action = "scramble"; return; }
      }
      keys.add(k); update();
    };
    const up = (e: KeyboardEvent) => { keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); update(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [ctl]);
}
