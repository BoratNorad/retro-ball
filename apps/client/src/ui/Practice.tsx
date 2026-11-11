// Practice / Tutorial (M12): guided drills for passing, running, kicking, reading coverage, motion
// and audibles, and defense. Each drill is a normal game screen with an instructions panel.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ClientData } from "../data.js";
import { DrillController, drillsDone, type Drill } from "../game/drill.js";
import { Game } from "./App.js";

export function PracticeScreen({ cd, onExit }: { cd: ClientData; onExit: () => void }) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const [n, setN] = useState(0);
  const done = drillsDone();
  if (drill) return <DrillGame key={`${drill.id}:${n}`} cd={cd} drill={drill} onExit={() => setDrill(null)}
    onNext={() => { const all = cd.data.tutorial.drills, k = all.indexOf(drill); setDrill(all[(k + 1) % all.length]!); setN(n + 1); }} />;
  return (
    <div class="menu">
      <h1>PRAC<span>TICE</span></h1>
      <div class="sub">GUIDED DRILLS · {done.length}/{cd.data.tutorial.drills.length} DONE</div>
      <div class="plays modes">
        {cd.data.tutorial.drills.map((d) => (
          <button class={`play ${done.includes(d.id) ? "on" : ""}`} onClick={() => setDrill(d)}>
            <b>{done.includes(d.id) ? "✓ " : ""}{d.title.toUpperCase()}</b><small>{d.summary}</small>
          </button>
        ))}
      </div>
      <div class="row"><button class="chip" onClick={onExit}>BACK</button></div>
    </div>
  );
}

function DrillGame({ cd, drill, onExit, onNext }: { cd: ClientData; drill: Drill; onExit: () => void; onNext: () => void }) {
  const ctl = useMemo(() => new DrillController(cd, drill), []);
  const [, set] = useState(0);
  useEffect(() => { const off = ctl.subscribe(() => set((x) => x + 1)); set((x) => x + 1); return off; }, [ctl]);
  const [open, setOpen] = useState(true);
  const p = ctl.progress;
  const read = drill.hints && ctl.ui.mode === "presnap" && ctl.live && ctl.live.userOffense
    ? cd.data.tutorial.coverage[ctl.live.call.id] ?? cd.data.tutorial.coverage.default : null;
  const panel = (
    <div class={`drillpanel ${open ? "" : "shut"}`}>
      <div class="tabs">
        <span class="tag">DRILL · {drill.title.toUpperCase()}</span>
        <span class="tag gold">{p.made}/{drill.reps}{p.reps > p.made ? ` · ${p.reps} REPS` : ""}</span>
        <button class="chip" onClick={() => setOpen(!open)}>{open ? "HIDE" : "HOW TO"}</button>
        <button class="chip" onClick={onExit}>EXIT</button>
      </div>
      {open && <ol>{drill.steps.map((s) => <li>{s}</li>)}</ol>}
      {read && <div class="coverread">COVERAGE READ: {read}</div>}
      {p.last && !p.done && <div class={`verdict ${p.last.ok ? "ok" : "no"}`}>{p.last.text}</div>}
      {p.done && <div class="verdict ok">DRILL COMPLETE ✓ <button class="big" onClick={onNext}>NEXT DRILL ▶</button></div>}
    </div>
  );
  return <Game ctl={ctl} onExit={onExit} exitLabel="BACK TO PRACTICE" extra={null} overlay={panel} />;
}
