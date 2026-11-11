// A small pool of game workers (one per spare core, up to 4). Falls back to the main thread.
import { runGameJob, type GameJob, type GameOutcome } from "@tdf/sim";
import type { ClientData } from "../data.js";

export class GamePool {
  private workers: Worker[] = [];
  private queue: { job: GameJob; ok: (o: GameOutcome) => void }[] = [];
  private busy = new Map<Worker, (o: GameOutcome) => void>();
  private nextId = 1;
  constructor(private cd: ClientData) {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1));
    try {
      for (let k = 0; k < n; k++) {
        const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (ev: MessageEvent<{ id: number; out: GameOutcome }>) => {
          const done = this.busy.get(w);
          this.busy.delete(w);
          done?.(ev.data.out);
          this.pump();
        };
        this.workers.push(w);
      }
    } catch { this.workers = []; }
  }
  run(job: GameJob): Promise<GameOutcome> {
    if (!this.workers.length) return new Promise((ok) => setTimeout(() => ok(runGameJob(this.cd.data, job)), 0));
    return new Promise((ok) => { this.queue.push({ job, ok }); this.pump(); });
  }
  private pump() {
    for (const w of this.workers) {
      if (this.busy.has(w) || !this.queue.length) continue;
      const { job, ok } = this.queue.shift()!;
      this.busy.set(w, ok);
      w.postMessage({ id: this.nextId++, job });
    }
  }
  dispose() { for (const w of this.workers) w.terminate(); this.workers = []; }
}
