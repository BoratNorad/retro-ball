// Web Worker: plays franchise games (AI vs AI, or a simmed game of yours) off the main thread.
import { runGameJob, type GameJob } from "@tdf/sim";
import { loadClientData, type ClientData } from "../data.js";

let cd: Promise<ClientData> | null = null;
self.onmessage = async (ev: MessageEvent<{ id: number; job: GameJob }>) => {
  cd ??= loadClientData();
  const data = (await cd).data;
  const out = runGameJob(data, ev.data.job);
  (self as unknown as Worker).postMessage({ id: ev.data.id, out });
};
