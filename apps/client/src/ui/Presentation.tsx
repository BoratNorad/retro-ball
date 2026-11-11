// Presentation UI (M9): settings (camera, audio, motion, haptics), the replay viewer with a scrub
// bar, and the halftime / end-of-game summary (box score, drive chart, highlights).
import { useEffect, useState } from "preact/hooks";
import { drives } from "@tdf/sim";
import { audio } from "../audio/audio.js";
import { loadSettings, saveSettings, type Controller, type PlayRecord, type Settings } from "../game/controller.js";
import type { ClientData } from "../data.js";
import { BoxScore } from "./BoxScore.js";

/** Apply the saved audio settings (call at start and after every change). */
export function applyAudioSettings(cd: ClientData, s: Settings = loadSettings()) {
  audio.configure(cd.data.presentation.audio, { sound: s.sound !== false, music: s.music !== false, volume: s.volume ?? 1 });
}

export function SettingsPanel({ cd, ctl, onClose }: { cd: ClientData; ctl?: Controller; onClose: () => void }) {
  const [s, setS] = useState<Settings>(() => ctl?.settings ?? loadSettings());
  const put = (p: Partial<Settings>) => {
    const n = { ...s, ...p };
    setS(n);
    saveSettings(n);
    if (ctl) { ctl.settings = n; ctl.setCamera(n.camera ?? "auto"); }
    applyAudioSettings(cd, n);
    audio.play("click");
  };
  const Chip = ({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) => <button class={`chip ${on ? "on" : ""}`} onClick={onClick}>{label}</button>;
  const cam = s.camera ?? "auto";
  return (
    <div class="overlay settings" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="panel">
        <div class="title">SETTINGS</div>
        <div class="row"><span class="lbl">CAMERA</span>
          <Chip on={cam === "auto"} label="AUTO" onClick={() => put({ camera: "auto" })} />
          <Chip on={cam === "bowl"} label="BOWL (TOP-DOWN)" onClick={() => put({ camera: "bowl" })} />
          <Chip on={cam === "pro"} label="PRO (ALL-22)" onClick={() => put({ camera: "pro" })} /></div>
        <p class="hint">Auto: Bowl on phones, Pro on wide screens. You can switch between plays.</p>
        <div class="row"><span class="lbl">SOUND</span>
          <Chip on={s.sound !== false} label={s.sound !== false ? "SFX ON" : "SFX OFF"} onClick={() => put({ sound: s.sound === false })} />
          <Chip on={s.music !== false} label={s.music !== false ? "MUSIC ON" : "MUSIC OFF"} onClick={() => put({ music: s.music === false })} />
          {[0.25, 0.5, 0.75, 1].map((v) => <Chip on={(s.volume ?? 1) === v} label={`${v * 100}%`} onClick={() => put({ volume: v })} />)}</div>
        <div class="row"><span class="lbl">MOTION</span>
          <Chip on={!s.reducedMotion} label="FULL" onClick={() => put({ reducedMotion: false })} />
          <Chip on={Boolean(s.reducedMotion)} label="REDUCED (NO SHAKE / SLOW-MO / CONFETTI)" onClick={() => put({ reducedMotion: true })} /></div>
        <div class="row"><span class="lbl">HAPTICS</span>
          <Chip on={Boolean(s.haptics)} label={s.haptics ? "VIBRATE ON HITS" : "OFF"} onClick={() => put({ haptics: !s.haptics })} /></div>
        <div class="row"><button class="big" onClick={onClose}>DONE</button></div>
      </div>
    </div>
  );
}

function useTick(ctl: Controller, on: boolean) {
  const [, set] = useState(0);
  useEffect(() => { if (!on) return; const id = setInterval(() => set((x) => x + 1), 100); return () => clearInterval(id); }, [on]);
  useEffect(() => ctl.subscribe(() => set((x) => x + 1)), [ctl]);
}

/** Replay controls over the field: play/pause, scrub, speed, close. */
export function ReplayBar({ ctl }: { ctl: Controller }) {
  useTick(ctl, true);
  const r = ctl.replay;
  if (!r) return null;
  const last = r.frames.length - 1;
  return (
    <div class="replaybar">
      <div class="tabs">
        <span class="tag rp">↺ REPLAY</span>
        <span class="playname">{r.rec.label} · {r.rec.result}{r.rec.highlight ? ` · ${r.rec.highlight}` : ""}</span>
      </div>
      <div class="tabs">
        <button class="chip" onClick={() => { if (r.pos >= last) r.pos = 0; r.playing = !r.playing; ctl.seekReplay(r.pos); }}>{r.playing ? "❚❚" : "▶"}</button>
        <input class="scrub" type="range" min={0} max={last} step={1} value={Math.round(r.pos)} onInput={(e) => { r.playing = false; ctl.seekReplay(Number((e.target as HTMLInputElement).value)); }} />
        {[0.25, 0.5, 1].map((v) => <button class={`chip ${r.speed === v ? "on" : ""}`} onClick={() => { r.speed = v; ctl.seekReplay(r.pos); }}>{v}x</button>)}
        <button class="chip" onClick={() => ctl.closeReplay()}>CLOSE</button>
      </div>
    </div>
  );
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
/** Drive chart + highlights (+ the box score) for halftime and the end of the game. */
export function GameSummary({ ctl, title, onReplay }: { ctl: Controller; title: string; onReplay: (p: PlayRecord) => void }) {
  const [tab, setTab] = useState<"box" | "drives" | "hl">("box");
  const r = ctl.result();
  const d = drives(ctl.session.log, ctl.session.rules.quarterSeconds, ctl.session.rules.tickHz);
  const hl = ctl.highlights;
  return (
    <div class="summary">
      <div class="title">{title}</div>
      <div class="tabs">
        <button class={`chip ${tab === "box" ? "on" : ""}`} onClick={() => setTab("box")}>BOX SCORE</button>
        <button class={`chip ${tab === "drives" ? "on" : ""}`} onClick={() => setTab("drives")}>DRIVES ({d.length})</button>
        <button class={`chip ${tab === "hl" ? "on" : ""}`} onClick={() => setTab("hl")}>HIGHLIGHTS ({hl.length})</button>
      </div>
      {tab === "box" && <BoxScore r={r} title={null} />}
      {tab === "drives" && (
        <table class="drives"><thead><tr><th>Q</th><th>TEAM</th><th>START</th><th>PLAYS</th><th>YDS</th><th>TIME</th><th>RESULT</th></tr></thead>
          <tbody>{d.map((x) => (
            <tr class={x.result === "Touchdown" || x.result === "Field goal" ? "score" : ""}>
              <td>{x.quarter > 4 ? "OT" : x.quarter}</td><td>{ctl.team(x.side).abbr}</td>
              <td>{x.startBallOn === 50 ? "50" : x.startBallOn < 50 ? `OWN ${x.startBallOn}` : `OPP ${100 - x.startBallOn}`}</td>
              <td>{x.plays}</td><td>{x.yards}</td><td>{fmtTime(x.seconds)}</td><td>{x.result}</td>
            </tr>))}</tbody></table>
      )}
      {tab === "hl" && (
        <div class="hllist">
          {!hl.length && <p class="hint">No highlights yet.</p>}
          {hl.map((p) => <button class="play" onClick={() => onReplay(p)}><b>{p.highlight}</b><small>{p.label} · {p.result}</small></button>)}
        </div>
      )}
    </div>
  );
}
