import { useState } from "preact/hooks";
import { loadSettings, saveSettings } from "../game/controller.js";

/** Ruleset toggle for abilities + momentum (saved in settings, read when a game starts). */
export function AbilitiesToggle() {
  const [on, setOn] = useState(loadSettings().abilities !== false);
  return (
    <div class="row">
      <span class="lbl">ABILITIES</span>
      {[true, false].map((v) => <button class={`chip ${on === v ? "on" : ""}`} onClick={() => { saveSettings({ ...loadSettings(), abilities: v }); setOn(v); }}>{v ? "ON · MOMENTUM" : "OFF · RATINGS ONLY"}</button>)}
    </div>
  );
}

