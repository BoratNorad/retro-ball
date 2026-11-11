import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DefenseCall, OffensePlay } from "@tdf/shared";
import { HOT_ROUTES, runRate, situation, type MotionKind, type PlayCall, type Tendencies, type UserInput } from "@tdf/sim";
type UserInputAction = NonNullable<UserInput["action"]>;
import { loadClientData, type ClientData } from "../data.js";
import { Controller, keysOf, ordinal, spotText, toGoText, type AbilityCtx, type UiState } from "../game/controller.js";
import { helmetCanvas } from "../render/sprites.js";
import { AbilitiesToggle } from "./AbilitiesToggle.js";
import { DraftScreen, DraftSetup, Lineup, PostDraft, type DraftConfigUi } from "./Draft.js";
import { OnlineScreen } from "./Online.js";
import { Leaderboards, ModeScreen } from "./Modes.js";
import { FranchiseScreen } from "./Franchise.js";
import { PracticeScreen } from "./Practice.js";
import { deleteTeam, loadTeam, savedTeams } from "./saved.js";
import { applyAudioSettings, GameSummary, ReplayBar, SettingsPanel } from "./Presentation.js";
import { audio } from "../audio/audio.js";
import { hasOnlineSeat } from "../net/client.js";
import type { Draft, Roster } from "@tdf/sim";

type Screen = { kind: "loading" } | { kind: "error"; msg: string } | { kind: "menu" } | { kind: "game"; ctl: Controller; back?: Screen }
  | { kind: "online" } | { kind: "gauntlet" } | { kind: "daily" } | { kind: "boards" } | { kind: "franchise" } | { kind: "practice" }
  | { kind: "draftSetup"; mode: "ai" | "hotseat" } | { kind: "draft"; cfg: DraftConfigUi }
  | { kind: "postDraft"; cfg: DraftConfigUi; d: Draft; rosters: [Roster, Roster] }
  | { kind: "lineup"; cfg: DraftConfigUi; d: Draft; rosters: [Roster, Roster]; side: 0 | 1 };

export function App() {
  const [cd, setCd] = useState<ClientData | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  useEffect(() => {
    loadClientData().then((d) => { setCd(d); applyAudioSettings(d); setScreen(hasOnlineSeat() ? { kind: "online" } : { kind: "menu" }); }).catch((e) => setScreen({ kind: "error", msg: String(e) }));
  }, []);
  // music: menus and setup get the menu loop, drafts the draft loop, games the crowd
  useEffect(() => {
    const unlock = () => audio.unlock();
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    return () => { document.removeEventListener("pointerdown", unlock); document.removeEventListener("keydown", unlock); };
  }, []);
  useEffect(() => {
    if (screen.kind === "draft") audio.music("draft");
    else if (screen.kind === "game" || screen.kind === "loading") audio.music(null);
    else if (screen.kind !== "online") audio.music("menu");
  }, [screen.kind]);
  if (screen.kind === "loading") return <div class="center"><div class="title">LOADING…</div></div>;
  if (screen.kind === "error") return <div class="center"><div class="title">ERROR</div><p>{screen.msg}</p></div>;
  const c = cd!;
  if (screen.kind === "menu") return <Menu cd={c} onStart={(u, o, q) => setScreen({ kind: "game", ctl: new Controller(c, [exhibitionRoster(c, u), exhibitionRoster(c, o)], q) })}
    onDraft={(mode) => setScreen({ kind: "draftSetup", mode })} onOnline={() => setScreen({ kind: "online" })} onMode={(k) => setScreen({ kind: k })} />;
  if (screen.kind === "gauntlet" || screen.kind === "daily") return <ModeScreen cd={c} kind={screen.kind} onExit={() => setScreen({ kind: "menu" })} />;
  if (screen.kind === "boards") return <Leaderboards onExit={() => setScreen({ kind: "menu" })} />;
  if (screen.kind === "practice") return <PracticeScreen cd={c} onExit={() => setScreen({ kind: "menu" })} />;
  if (screen.kind === "franchise") return <FranchiseScreen cd={c} onExit={() => setScreen({ kind: "menu" })} />;
  if (screen.kind === "online") return <OnlineScreen cd={c} onExit={() => setScreen({ kind: "menu" })} />;
  if (screen.kind === "draftSetup") return <DraftSetup cd={c} mode={screen.mode} onBack={() => setScreen({ kind: "menu" })} onStart={(cfg) => setScreen({ kind: "draft", cfg })} />;
  if (screen.kind === "draft") return <DraftScreen cd={c} cfg={screen.cfg} onDone={(d) => setScreen({ kind: "postDraft", cfg: screen.cfg, d, rosters: [d.toRoster(0), d.toRoster(1)] })} />;
  if (screen.kind === "postDraft") {
    const sc = screen;
    return <PostDraft cd={c} d={sc.d} cfg={sc.cfg} rosters={sc.rosters} setRosters={(r) => setScreen({ ...sc, rosters: r })}
      onLineup={(side) => setScreen({ kind: "lineup", cfg: sc.cfg, d: sc.d, rosters: sc.rosters, side })}
      onKickoff={() => setScreen({ kind: "game", ctl: new Controller(c, sc.rosters, sc.cfg.quarter, { hotseat: sc.cfg.mode === "hotseat" }), back: sc })} />;
  }
  if (screen.kind === "lineup") {
    const sc = screen;
    return <Lineup cd={c} roster={sc.rosters[sc.side]} onDone={(r) => {
      const rosters: [Roster, Roster] = sc.side === 0 ? [r, sc.rosters[1]] : [sc.rosters[0], r];
      setScreen({ kind: "postDraft", cfg: sc.cfg, d: sc.d, rosters });
    }} />;
  }
  const back = screen.back;
  return <Game ctl={screen.ctl} onExit={() => setScreen(back ?? { kind: "menu" })} exitLabel={back ? "BACK TO DRAFT" : "PLAY AGAIN"} />;
}

// ---------------------------------------------------------------- menu
function Helmet({ team, scale = 3 }: { team: { abbr: string; c1: string; c2: string; c3: string }; scale?: number }) {
  const src = useMemo(() => helmetCanvas(team, scale).toDataURL(), [team.abbr, scale]);
  return <img class="helmet" src={src} alt={team.abbr} />;
}

/** An Exhibition team: an NFL abbreviation, or "saved:<id>" for a team saved after a draft. */
function exhibitionRoster(cd: ClientData, key: string) {
  if (key.startsWith("saved:")) { const t = savedTeams().find((x) => `saved:${x.id}` === key); const r = t && loadTeam(cd, t); if (r) return r; }
  return cd.roster(key.startsWith("saved:") ? cd.data.teams.teams[0]!.abbr : key);
}

function Menu({ cd, onStart, onDraft, onOnline, onMode }: { cd: ClientData; onStart: (user: string, opp: string, quarterMinutes: number) => void; onDraft: (mode: "ai" | "hotseat") => void; onOnline: () => void; onMode: (k: "gauntlet" | "daily" | "boards" | "franchise" | "practice") => void }) {
  const [settings, setSettings] = useState(false);
  const [saved, setSaved] = useState(() => savedTeams());
  const teams = [...cd.data.teams.teams].sort((a, b) => a.name.localeCompare(b.name));
  const [user, setUser] = useState<string | null>(null);
  const [opp, setOpp] = useState<string | null>(null);
  const [qm, setQm] = useState(5);
  const picking = !user ? "YOUR TEAM" : "OPPONENT";
  const label = (k: string) => (k.startsWith("saved:") ? saved.find((t) => `saved:${t.id}` === k)?.roster.info.abbr ?? "?" : k);
  return (
    <div class="menu">
      <h1>TRIPLE DRAFT <span>FOOTBALL</span></h1>
      <button class="chip gear" onClick={() => setSettings(true)}>⚙ SETTINGS</button>
      {settings && <SettingsPanel cd={cd} onClose={() => setSettings(false)} />}
      <div class="plays modes">
        <button class="play online" onClick={onOnline}><b>ONLINE TRIPLE DRAFT</b><small>quick match or a private room · draft head to head, then play</small></button>
        <button class="play" onClick={() => onMode("gauntlet")}><b>BOSS GAUNTLET</b><small>draft, then a 17-game season vs the League Bosses + playoffs</small></button>
        <button class="play" onClick={() => onMode("franchise")}><b>FRANCHISE</b><small>run a club for years: cap, staff, draft, free agency, trades</small></button>
        <button class="play" onClick={() => onMode("daily")}><b>DAILY DRAFT</b><small>today's draft is the same for everyone · 5 games · leaderboard</small></button>
        <button class="play" onClick={() => onDraft("ai")}><b>TRIPLE DRAFT vs AI</b><small>draft 24 real players, then play</small></button>
        <button class="play" onClick={() => onDraft("hotseat")}><b>HOT-SEAT DRAFT</b><small>two players, one device</small></button>
        <button class="play" onClick={() => onMode("practice")}><b>PRACTICE</b><small>guided drills: passing, running, kicking, coverage reads, motion, defense</small></button>
        <button class="play" onClick={() => onMode("boards")}><b>LEADERBOARDS</b><small>daily, gauntlet and the ranked ladder</small></button>
      </div>
      <div class="sub">OR PLAY AN EXHIBITION WITH REAL NFL ROSTERS{saved.length ? " OR YOUR SAVED TEAMS" : ""}</div>
      <div class="sub">PICK {picking}</div>
      {saved.length > 0 && (
        <div class="teams saved">
          {saved.map((t) => {
            const key = `saved:${t.id}`, i = t.roster.info;
            return (
              <button class={`team ${user === key ? "you" : ""} ${opp === key ? "them" : ""}`} disabled={user === key} title={i.name}
                onClick={() => (!user ? setUser(key) : setOpp(key))}
                onContextMenu={(e) => { e.preventDefault(); if (confirm(`Delete ${i.name}?`)) { deleteTeam(t.id); setSaved(savedTeams()); } }}>
                <Helmet team={i} />
                <span>{i.abbr}</span>
              </button>
            );
          })}
        </div>
      )}
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
      <AbilitiesToggle />
      <div class="row">
        {user && <button class="chip" onClick={() => { setUser(null); setOpp(null); }}>RESET</button>}
        <button class="big" disabled={!user || !opp} onClick={() => onStart(user!, opp!, qm)}>
          {user && opp ? `PLAY ${label(user)} vs ${label(opp)}` : "PICK TWO TEAMS"}
        </button>
      </div>
      <p class="hint">Real Madden 27 rosters. On offense: pull back and release to throw, hold a finger on the field to run. On defense: call a front and coverage, and (if you turn on CONTROL DEFENDER in the defense call screen) play one defender yourself.</p>
    </div>
  );
}


// ---------------------------------------------------------------- game
function useUi(ctl: Controller): UiState {
  const [ui, setUi] = useState(ctl.ui);
  // sync once on subscribe too: the controller may have moved on before this effect ran
  useEffect(() => { const off = ctl.subscribe(() => setUi(ctl.ui)); setUi(ctl.ui); return off; }, [ctl]);
  return ui;
}

export function Game({ ctl, onExit, exitLabel = "PLAY AGAIN", extra, banner, overlay }: {
  ctl: Controller; onExit: () => void; exitLabel?: string;
  /** more buttons on the final screen (online: leave) */ extra?: preact.ComponentChildren;
  /** a status line over the field (online: connection) */ banner?: string | null;
  /** extra panel over the field (practice drills) */ overlay?: preact.ComponentChildren;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ui = useUi(ctl);
  useEffect(() => {
    // Phaser + the field scene are a separate chunk, loaded when the first game starts (M12)
    let game: { destroy(b: boolean): void } | null = null, dead = false;
    void Promise.all([import("phaser"), import("../render/FieldScene.js")]).then(([{ default: Phaser }, { FieldScene }]) => {
      if (dead || !host.current) return;
      const g = new Phaser.Game({
        type: Phaser.AUTO, parent: host.current, backgroundColor: "#12141c", pixelArt: true,
        scale: { mode: Phaser.Scale.RESIZE, width: host.current.clientWidth, height: host.current.clientHeight },
        input: { activePointers: 2 },
      });
      g.scene.add("field", FieldScene, true, { ctl });
      game = g;
    });
    return () => { dead = true; game?.destroy(true); };
  }, [ctl]);
  useKeyboard(ctl);
  useEffect(() => { audio.crowd(0.45); return () => audio.crowd(0); }, [ctl]);
  const [settings, setSettings] = useState(false);
  const betweenPlays = !ui.replaying && !ui.halftime && ui.mode !== "live" && ui.mode !== "kick" && ui.mode !== "final";
  const cam = ctl.cameraFor(window.innerWidth, window.innerHeight);
  return (
    <div class="game">
      <div class="stage" ref={host} />
      <ScoreBug ctl={ctl} />
      {betweenPlays && (
        <div class="hudbtns">
          <button class="chip" title="camera" onClick={() => ctl.setCamera(cam === "pro" ? "bowl" : "pro")}>{cam === "pro" ? "PRO" : "BOWL"} CAM</button>
          {ctl.plays.length > 0 && <button class="chip" onClick={() => ctl.openReplay()}>↺ REPLAY</button>}
          <button class="chip" onClick={() => setSettings(true)}>⚙</button>
        </div>
      )}
      {settings && <SettingsPanel cd={ctl.cd} ctl={ctl} onClose={() => setSettings(false)} />}
      {ui.replaying && <ReplayBar ctl={ctl} />}
      {ui.halftime && !ui.replaying && ui.mode !== "final" && (
        <div class="overlay">
          <GameSummary ctl={ctl} title="HALFTIME" onReplay={(p) => ctl.openReplay(p)} />
          <button class="big" onClick={() => ctl.dismissHalftime()}>SECOND HALF ▶</button>
        </div>
      )}
      {banner && <div class="netbanner">{banner}</div>}
      {overlay}
      {ui.toast && ui.mode === "result" && <div class="toast">{ui.toast}</div>}
      {ui.bigToast && <div class="bigtoast">{ui.bigToast}</div>}
      <div class={`bottom ${ui.replaying ? "hidden" : ""}`}>
        {ui.mode === "waiting" && <div class="bar"><span class="playname">{ui.waitText ?? "WAITING…"}</span>{ui.netClock != null && <span class="clock">{Math.ceil(ui.netClock)}</span>}</div>}
        {ui.mode === "callOffense" && <OffenseSheet ctl={ctl} />}
        {ui.mode === "callDefense" && <DefenseSheet ctl={ctl} />}
        {ui.mode === "callTry" && <TrySheet ctl={ctl} />}
        {ui.mode === "pass" && ui.passTo && (
          <div class="sheet privacy" onClick={() => ctl.passed()}>
            <div class="title">PASS THE DEVICE TO {ui.passTo.team.toUpperCase()}</div>
            <p class="hint">{ui.passTo.next === "defense" ? "Call your defense — the offense looks away." : "Your offense — the defense looks away."} Tap when ready.</p>
          </div>
        )}
        {ui.mode === "callKickoff" && <KickoffSheet ctl={ctl} />}
        {ui.mode === "callReturn" && <ReturnSheet ctl={ctl} />}
        {ui.mode === "callST" && <StSheet ctl={ctl} />}
        {ui.mode === "kick" && ctl.live?.kick && (
          <div class="bar"><span class="playname">{ctl.live.kick.kind === "punt" ? "PUNT" : ctl.live.kick.kind === "fieldGoal" ? `${ctl.fgInfo().dist}-YD FIELD GOAL` : ctl.live.kick.kind === "pat" ? "EXTRA POINT" : "KICKOFF"}
            {" · "}FLICK UP TO KICK · CURVE THE SWIPE TO HOOK IT</span></div>
        )}
        {ui.mode === "live" && ctl.live?.kick && <KickControls ctl={ctl} ui={ui} />}
        {ui.mode === "presnap" && ctl.live && <Presnap ctl={ctl} ui={ui} />}
        {ui.mode === "live" && ui.userOffense && !ctl.live?.kick && <LiveControls ctl={ctl} ui={ui} />}
        {ui.mode === "live" && !ui.userOffense && ui.userDefense && <DefenseControls ctl={ctl} />}
        {ui.mode === "live" && !ui.userOffense && !ui.userDefense && !ctl.live?.kick && (
          <div class="bar"><span class="playname">{ctl.team(ctl.live!.offSide).abbr} offense · you: {ctl.live?.call.name}</span>
            {!ui.online && <button class="chip" onClick={() => ctl.fastForward()}>SKIP ▶▶</button>}</div>
        )}
      </div>
      {ui.mode === "final" && !ui.replaying && (
        <div class="overlay">
          <GameSummary ctl={ctl} title="FINAL" onReplay={(p) => ctl.openReplay(p)} />
          <button class="big" onClick={onExit}>{exitLabel}</button>
          {extra}
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
      <div class="side" style={{ background: t0.c1 }}><b>{t0.abbr}</b><i>{dot(0)}</i><span>{s.score[0]}</span><small>{"▮".repeat(s.timeouts[0])}</small><Momentum ctl={ctl} side={0} /></div>
      <div class="mid"><div>{clock}</div><div class="dd">{dd}</div></div>
      <div class="side" style={{ background: t1.c1 }}><span>{s.score[1]}</span><i>{dot(1)}</i><b>{t1.abbr}</b><small>{"▮".repeat(s.timeouts[1])}</small><Momentum ctl={ctl} side={1} /></div>
    </div>
  );
}

/** Momentum meter: 3 bars, each filling in quarters. */
function Momentum({ ctl, side }: { ctl: Controller; side: 0 | 1 }) {
  if (!ctl.session.abilities) return null;
  const { bars, max } = ctl.momentumBars(side);
  return (
    <em class={`mom ${side ? "r" : ""}`} title={`momentum ${bars.toFixed(2)} / ${max}`}>
      {Array.from({ length: max }, (_, k) => <b class={bars >= k + 1 ? "full" : ""}><u style={{ width: `${Math.max(0, Math.min(1, bars - k)) * 100}%` }} /></b>)}
    </em>
  );
}

/** Arm one active ability (paid with momentum bars) for the next snap or the play lined up now. */
function AbilityPicker({ ctl, ctx, inline = false }: { ctl: Controller; ctx: AbilityCtx; inline?: boolean }) {
  const [open, setOpen] = useState(!inline);
  if (!ctl.session.abilities) return null;
  const list = ctl.abilityChoices(ctx);
  const armed = ctl.armed();
  const { bars } = ctl.momentumBars(ctl.abilitySide(ctx));
  const armedName = armed && list.flatMap((p) => p.options.map((o) => ({ p, o }))).find((x) => x.p.player.id === armed.player && x.o.id === armed.ability);
  const head = (
    <button class={`chip ${armed ? "set" : ""}`} onClick={() => setOpen(!open)}>
      ★ {armedName ? `${armedName.o.name.toUpperCase()}` : "ABILITY"} · {Math.floor(bars)} BAR{Math.floor(bars) === 1 ? "" : "S"}
    </button>
  );
  const body = (
    <div class="scroller abil">
      {!list.length && <span class="tag">no active abilities in this unit</span>}
      {armed && <button class="chip" onClick={() => ctl.arm(null, ctx)}>NONE</button>}
      {list.flatMap(({ player, options }) => options.map((o) => {
        const on = armed?.player === player.id && armed.ability === o.id;
        return (
          <button class={`chip ${on ? "on" : ""} ${o.ok ? "" : "dim"}`} disabled={!o.ok && !on} title={o.text}
            onClick={() => ctl.arm(on ? null : { player: player.id, ability: o.id }, ctx)}>
            {player.name.split(" ").slice(-1)[0]!.toUpperCase()} · {o.name}{o.id === "signature" ? " ♛" : ""} <small>{"▮".repeat(o.cost)}</small>
          </button>
        );
      }))}
    </div>
  );
  if (inline) return <>{<div class="tabs">{head}</div>}{open && body}</>;
  return body;
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
      {!twoPt && (s.down === 4 || (fg && fg.pct > 0)) && <AbilityPicker ctl={ctl} ctx="kick" inline />}
      {!twoPt && (
        <div class="tabs">
          {s.down === 4 && <button class="chip" onClick={() => ctl.callOffense({ kind: "punt" })}>PUNT</button>}
          {s.down === 4 && (["fake_punt_pass", "fake_punt_run", "fake_fg_pass"] as const).map((id) => {
            const p = data.offense.plays.find((x) => x.id === id);
            return p && (id !== "fake_fg_pass" || (fg && fg.pct > 0)) ? <button class="chip" onClick={() => ctl.callOffense({ kind: "fake", play: p })}>{p.name.toUpperCase()}</button> : null;
          })}
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

function WindTag({ ctl }: { ctl: Controller }) {
  const w = ctl.windForUser();
  const mph = Math.round(Math.hypot(w.x, w.y) / 65536);
  if (!mph) return <span class="tag">WIND CALM</span>;
  // screen up = the way you attack
  const ang = Math.atan2(w.x, w.y) * 180 / Math.PI;
  return <span class="tag">WIND {mph} MPH <span class="arrow" style={{ transform: `rotate(${ang}deg)` }}>↑</span></span>;
}
function KickoffSheet({ ctl }: { ctl: Controller }) {
  return (
    <div class="sheet">
      <div class="tabs"><span class="tag">KICKOFF</span><WindTag ctl={ctl} /></div>
      <AbilityPicker ctl={ctl} ctx="kick" inline />
      <div class="plays">
        <button class="play" onClick={() => ctl.kickoff("kickoff")}><b>Deep kick</b><small>touchback or return</small></button>
        <button class="play" onClick={() => ctl.kickoff("squib")}><b>Squib</b><small>low, bouncing, hard to return</small></button>
        <button class="play" onClick={() => ctl.kickoff("onside")}><b>Onside</b><small>recover it after 10 yards</small></button>
      </div>
    </div>
  );
}
function ReturnSheet({ ctl }: { ctl: Controller }) {
  return (
    <div class="sheet">
      <div class="tabs"><span class="tag">KICK RETURN · {ctl.team(ctl.state.possession).abbr} kicks off</span><WindTag ctl={ctl} /></div>
      <AbilityPicker ctl={ctl} ctx="return" inline />
      <div class="plays">
        <button class="play" onClick={() => ctl.receiveKick("L")}><b>Return left</b><small>wall on the left</small></button>
        <button class="play" onClick={() => ctl.receiveKick("M")}><b>Return middle</b><small>wedge</small></button>
        <button class="play" onClick={() => ctl.receiveKick("R")}><b>Return right</b><small>wall on the right</small></button>
      </div>
    </div>
  );
}
function StSheet({ ctl }: { ctl: Controller }) {
  const punt = ctl.stKind === "punt";
  const [side, setSide] = useState<"L" | "M" | "R">("M");
  return (
    <div class="sheet">
      <div class="tabs"><span class="tag">{ctl.team(ctl.state.possession).abbr} lines up to {punt ? "PUNT" : "KICK A FIELD GOAL"}</span><WindTag ctl={ctl} /></div>
      {punt && <AbilityPicker ctl={ctl} ctx="return" inline />}
      {punt && (
        <div class="tabs"><span class="lbl">RETURN</span>
          {(["L", "M", "R"] as const).map((x) => <button class={`chip ${side === x ? "on" : ""}`} onClick={() => setSide(x)}>{x === "L" ? "LEFT" : x === "R" ? "RIGHT" : "MIDDLE"}</button>)}
        </div>
      )}
      <div class="plays">
        <button class="play" onClick={() => ctl.callST("normal", side)}><b>{punt ? "Punt return" : "Field goal block"}</b><small>{punt ? "hold up the gunners" : "standard rush"}</small></button>
        <button class="play" onClick={() => ctl.callST("block", side)}><b>All-out block</b><small>more rushers, weaker return / fake risk</small></button>
        <button class="play" onClick={() => ctl.callST("safe", side)}><b>Safe</b><small>watch for the fake</small></button>
      </div>
      {ctl.state.timeouts[ctl.userSide] > 0 && <div class="tabs"><button class={`chip ${ctl.timeoutQueued ? "on" : ""}`} onClick={() => ctl.callTimeout()}>ICE · TIMEOUT</button></div>}
    </div>
  );
}
function KickControls({ ctl, ui }: { ctl: Controller; ui: UiState }) {
  const act = (a: "fairCatch" | "kneel" | "dive" | "juke" | "spin" | "burst") => (e: Event) => { e.preventDefault(); ctl.input.action = a; };
  if (ui.canFairCatch) return <div class="bar acts"><span class="playname">BALL IN THE AIR · GET UNDER IT</span><button class="act alt" onPointerDown={act("fairCatch")}>FAIR CATCH</button></div>;
  if (ui.canKneel) return <div class="bar acts"><button class="act alt" onPointerDown={act("kneel")}>KNEEL</button><button class="act" onPointerDown={act("burst")}>BURST</button></div>;
  if (ui.scramble) return <div class="bar acts"><span class="playname">LOOSE BALL · DRAG TO MOVE</span><button class="act" onPointerDown={act("dive")}>DIVE</button></div>;
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
  return <div class="bar"><span class="playname">…</span>{!ui.online && <button class="chip" onClick={() => ctl.fastForward()}>SKIP ▶▶</button>}</div>;
}

function TrySheet({ ctl }: { ctl: Controller }) {
  return (
    <div class="sheet">
      <div class="tabs"><span class="tag">TOUCHDOWN — TRY</span></div>
      <AbilityPicker ctl={ctl} ctx="kick" inline />
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
type PTab = "motion" | "shift" | "hot" | "protect" | "audible" | "look" | "cover" | "spy" | "double" | "ability" | null;
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
      case "ability": return <AbilityPicker ctl={ctl} ctx={off ? "off" : "def"} />;
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
        {ctl.session.abilities && T("ability", ctl.armed() ? "★ ARMED" : "★ ABILITY", Boolean(ctl.armed()))}
        {(off || !ui.online) && <button class="big" onClick={() => ctl.snapBall()}>{off ? "SNAP ▶" : "READY ▶"}</button>}
        {!off && ui.online && <span class="tag">WAITING FOR THE SNAP</span>}
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
      // the Pro camera looks from the sideline: right = downfield, up = toward the far sideline
      if (ctl.cameraFor(window.innerWidth, window.innerHeight) === "pro") [x, y] = [-y, x];
      if (x || y) ctl.input.move = { x: x * 65536, y: y * 65536 };
      else if (ctl.input.move && [...keys].length === 0) ctl.input.move = null;
    };
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const K = keysOf(ctl.settings);
      if (k === K.snap) { ctl.snapBall(); return; }
      if (k === K.camera && ctl.ui.mode !== "live") { ctl.setCamera(ctl.cameraFor(window.innerWidth, window.innerHeight) === "pro" ? "bowl" : "pro"); return; }
      if (ctl.live?.userDefense) {
        const m: [string, UserInputAction][] = [[K.dive, "dive"], [K.swat, "swat"], [K.strip, "strip"], [K.switch, "switch"]];
        const hit = m.find(([key]) => key === k);
        if (hit) { ctl.input.action = hit[1]; e.preventDefault(); return; }
      } else {
        if (k === K.juke) { ctl.input.action = ctl.ui.canKeep ? "keep" : "juke"; e.preventDefault(); return; }
        if (k === K.spin) { ctl.input.action = "spin"; return; }
        if (k === K.burst) { ctl.input.action = "burst"; return; }
        if (k === K.scramble) { ctl.input.action = "scramble"; return; }
      }
      keys.add(k); update();
    };
    const up = (e: KeyboardEvent) => { keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); update(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [ctl]);
}
