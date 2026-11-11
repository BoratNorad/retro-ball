// Audio (M9): everything is generated on the fly with WebAudio (jsfxr-style blips, noise hits, a
// whistle, a small chiptune sequencer for the menu and draft, and filtered-noise crowd ambience that
// swells on big moments). public/audio/manifest.json can map any sound id to a file to replace the
// generated placeholder: { "sfx": { "touchdown": "audio/td.ogg" }, "music": { "menu": "audio/menu.ogg" } }.
import type { GameData } from "@tdf/shared";

export type Sfx = "snap" | "hit" | "bigHit" | "catch" | "throw" | "whistle" | "kick" | "card" | "reveal" | "touchdown" | "pick" | "fumble" | "click" | "error" | "fieldGoal" | "miss";
export type Music = "menu" | "draft" | null;

export interface AudioSettings { sound: boolean; music: boolean; volume: number }

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private crowdGain: GainNode | null = null;
  private crowdSrc: AudioBufferSourceNode | null = null;
  private noise: AudioBuffer | null = null;
  private files = new Map<string, AudioBuffer>();
  private manifest: { sfx?: Record<string, string>; music?: Record<string, string> } = {};
  private cfg: GameData["presentation"]["audio"] | null = null;
  settings: AudioSettings = { sound: true, music: true, volume: 1 };
  private track: Music = null;
  private seqTimer: ReturnType<typeof setInterval> | null = null;
  private seqStep = 0;
  private seqNext = 0;
  private musicFile: AudioBufferSourceNode | null = null;
  private crowdBase = 0;

  configure(cfg: GameData["presentation"]["audio"], settings: AudioSettings) {
    this.cfg = cfg;
    this.settings = settings;
    this.applyVolumes();
    if (!settings.music) this.stopMusic(); else if (this.track) this.music(this.track, true);
  }
  /** Browsers only allow audio after a user gesture: call from any click/tap. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === "suspended") void this.ctx.resume(); return; }
    const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain(); this.sfxBus.connect(this.master);
    this.musicBus = ctx.createGain(); this.musicBus.connect(this.master);
    this.crowdGain = ctx.createGain(); this.crowdGain.gain.value = 0; this.crowdGain.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) { seed = (seed * 1103515245 + 12345) >>> 0; d[i] = (seed / 0xffffffff) * 2 - 1; }
    this.applyVolumes();
    void this.loadManifest();
    if (this.track) this.music(this.track, true);
  }
  private async loadManifest() {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}audio/manifest.json`);
      if (!r.ok) return;
      this.manifest = await r.json();
      for (const group of [this.manifest.sfx ?? {}, this.manifest.music ?? {}]) for (const [id, url] of Object.entries(group)) {
        if (!url || !this.ctx) continue;
        const buf = await (await fetch(`${import.meta.env.BASE_URL}${url}`)).arrayBuffer();
        this.files.set(id, await this.ctx.decodeAudioData(buf));
      }
    } catch { /* no manifest: generated sounds only */ }
  }
  private applyVolumes() {
    if (!this.ctx || !this.cfg) return;
    const on = (b: boolean) => (b ? 1 : 0);
    this.master!.gain.value = this.cfg.master * this.settings.volume;
    this.sfxBus!.gain.value = this.cfg.sfx * on(this.settings.sound);
    this.musicBus!.gain.value = this.cfg.music * on(this.settings.music);
  }

  // ---------------------------------------------------------------- sfx
  play(id: Sfx) {
    const ctx = this.ctx;
    if (!ctx || !this.settings.sound || !this.sfxBus) return;
    const file = this.files.get(id);
    if (file) { const s = ctx.createBufferSource(); s.buffer = file; s.connect(this.sfxBus); s.start(); return; }
    const t = ctx.currentTime;
    switch (id) {
      case "snap": this.noiseHit(t, 0.06, 900, 0.5); this.tone(t, "square", 160, 90, 0.05, 0.25); break;
      case "hit": this.noiseHit(t, 0.12, 500, 0.7); this.tone(t, "triangle", 110, 50, 0.1, 0.4); break;
      case "bigHit": this.noiseHit(t, 0.25, 350, 1); this.tone(t, "square", 90, 35, 0.22, 0.45); break;
      case "catch": this.tone(t, "square", 660, 990, 0.06, 0.25); this.tone(t + 0.05, "square", 990, 990, 0.05, 0.18); break;
      case "throw": this.noiseSweep(t, 0.25, 2500, 600, 0.35); break;
      case "kick": this.noiseHit(t, 0.08, 700, 0.8); this.tone(t, "triangle", 140, 60, 0.12, 0.6); this.noiseSweep(t + 0.04, 0.4, 3000, 800, 0.2); break;
      case "whistle": this.whistle(t); break;
      case "card": this.noiseSweep(t, 0.08, 5000, 2000, 0.25); this.tone(t + 0.04, "square", 1200, 1500, 0.04, 0.15); break;
      case "reveal": [523, 659, 784, 1047].forEach((f, k) => this.tone(t + k * 0.07, "square", f, f, 0.08, 0.22)); break;
      case "touchdown": [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, k) => this.tone(t + k * 0.09, k % 2 ? "triangle" : "square", f, f, k === 6 ? 0.4 : 0.1, 0.25)); break;
      case "fieldGoal": [659, 784, 1047].forEach((f, k) => this.tone(t + k * 0.1, "square", f, f, 0.12, 0.22)); break;
      case "pick": [988, 784, 587, 440].forEach((f, k) => this.tone(t + k * 0.07, "square", f, f, 0.08, 0.25)); break;
      case "fumble": this.tone(t, "sawtooth", 400, 120, 0.35, 0.25); break;
      case "miss": this.tone(t, "triangle", 330, 220, 0.3, 0.3); break;
      case "click": this.tone(t, "square", 880, 880, 0.025, 0.12); break;
      case "error": this.tone(t, "square", 220, 180, 0.12, 0.2); break;
    }
  }
  private env(g: GainNode, t: number, dur: number, peak: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  private tone(t: number, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, bus = this.sfxBus) {
    const ctx = this.ctx!, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    this.env(g, t, dur, vol);
    o.connect(g); g.connect(bus!);
    o.start(t); o.stop(t + dur + 0.02);
  }
  private noiseHit(t: number, dur: number, cutoff: number, vol: number) {
    const ctx = this.ctx!, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.noise; f.type = "lowpass"; f.frequency.value = cutoff;
    this.env(g, t, dur, vol);
    s.connect(f); f.connect(g); g.connect(this.sfxBus!);
    s.start(t, Math.random()); s.stop(t + dur + 0.02);
  }
  private noiseSweep(t: number, dur: number, f0: number, f1: number, vol: number) {
    const ctx = this.ctx!, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.noise; f.type = "bandpass"; f.Q.value = 1.5;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    this.env(g, t, dur, vol);
    s.connect(f); f.connect(g); g.connect(this.sfxBus!);
    s.start(t, Math.random()); s.stop(t + dur + 0.02);
  }
  private whistle(t: number) {
    const ctx = this.ctx!, o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = 2900;
    lfo.frequency.value = 28; lg.gain.value = 90; lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.setValueAtTime(0.25, t + 0.32);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g); g.connect(this.sfxBus!);
    o.start(t); lfo.start(t); o.stop(t + 0.45); lfo.stop(t + 0.45);
  }

  // ---------------------------------------------------------------- crowd
  /** Crowd ambience on (in a game) at a base level 0..1, or off. */
  crowd(level: number) {
    this.crowdBase = level;
    const ctx = this.ctx;
    if (!ctx || !this.crowdGain || !this.cfg) return;
    if (level > 0 && !this.crowdSrc) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter();
      s.buffer = this.noise; s.loop = true;
      f.type = "bandpass"; f.frequency.value = 700; f.Q.value = 0.6;
      f2.type = "lowpass"; f2.frequency.value = 1800;
      s.connect(f); f.connect(f2); f2.connect(this.crowdGain);
      s.start();
      this.crowdSrc = s;
    }
    const on = this.settings.sound ? 1 : 0;
    this.crowdGain.gain.setTargetAtTime(level * this.cfg.crowd * on, ctx.currentTime, 0.4);
    if (level <= 0 && this.crowdSrc) { const s = this.crowdSrc; this.crowdSrc = null; setTimeout(() => s.stop(), 1500); }
  }
  /** The crowd roars (touchdown, takeaway) and settles back. */
  swell(amount = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.crowdGain || !this.cfg || !this.settings.sound) return;
    const t = ctx.currentTime, base = this.crowdBase * this.cfg.crowd, peak = Math.min(1, base + amount * this.cfg.crowd * 2.2);
    const g = this.crowdGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(peak, t + 0.25);
    g.linearRampToValueAtTime(base, t + this.cfg.crowdSwellMs / 1000);
  }

  // ---------------------------------------------------------------- music
  /** Chiptune loop for the menus ("menu") or the draft ("draft"); null stops it. */
  music(track: Music, force = false) {
    if (track === this.track && !force) return;
    this.track = track;
    this.stopMusic();
    const ctx = this.ctx;
    if (!ctx || !track || !this.settings.music) return;
    const file = this.files.get(track);
    if (file) { const s = ctx.createBufferSource(); s.buffer = file; s.loop = true; s.connect(this.musicBus!); s.start(); this.musicFile = s; return; }
    const song = SONGS[track];
    const stepDur = 60 / song.bpm / 4;
    this.seqStep = 0;
    this.seqNext = ctx.currentTime + 0.05;
    this.seqTimer = setInterval(() => {
      // schedule ahead in small slices
      while (this.seqNext < ctx.currentTime + 0.2) {
        const k = this.seqStep % (song.lead.length);
        const lead = song.lead[k]!, bass = song.bass[Math.floor(k / 2) % song.bass.length]!;
        if (lead) this.tone(this.seqNext, "square", midi(lead), midi(lead), stepDur * 0.9, 0.12, this.musicBus);
        if (k % 2 === 0 && bass) this.tone(this.seqNext, "triangle", midi(bass), midi(bass), stepDur * 1.8, 0.22, this.musicBus);
        if (song.drums[k % song.drums.length] === "x") this.noiseTick(this.seqNext);
        this.seqNext += stepDur;
        this.seqStep++;
      }
    }, 50);
  }
  private noiseTick(t: number) {
    const ctx = this.ctx!, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.noise; f.type = "highpass"; f.frequency.value = 6000;
    this.env(g, t, 0.03, 0.08);
    s.connect(f); f.connect(g); g.connect(this.musicBus!);
    s.start(t, Math.random()); s.stop(t + 0.05);
  }
  private stopMusic() {
    if (this.seqTimer) clearInterval(this.seqTimer);
    this.seqTimer = null;
    if (this.musicFile) { this.musicFile.stop(); this.musicFile = null; }
  }
}

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
/** Two short original loops (MIDI note numbers per 16th, 0 = rest). */
const SONGS: Record<"menu" | "draft", { bpm: number; lead: number[]; bass: number[]; drums: string }> = {
  menu: {
    bpm: 118,
    lead: [72, 0, 76, 79, 0, 79, 77, 76, 74, 0, 74, 77, 0, 76, 74, 72, 71, 0, 74, 77, 0, 77, 76, 74, 72, 0, 76, 79, 84, 0, 0, 0],
    bass: [48, 48, 55, 55, 50, 50, 53, 53, 47, 47, 55, 55, 48, 48, 43, 43],
    drums: "x...x.x.x...x.xx",
  },
  draft: {
    bpm: 132,
    lead: [69, 0, 72, 0, 76, 0, 72, 74, 0, 71, 0, 74, 77, 0, 74, 76, 69, 0, 72, 0, 76, 0, 79, 77, 76, 0, 74, 0, 72, 71, 69, 0],
    bass: [45, 45, 45, 45, 41, 41, 43, 43, 45, 45, 45, 45, 41, 43, 44, 44],
    drums: "x.x.x.x.x.x.xxx.",
  },
};

export const audio = new AudioEngine();
