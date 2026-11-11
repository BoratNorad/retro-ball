// Entry point: `pnpm --filter @tdf/server start` (PORT from the environment, default 2567).
import { loadEnv } from "./env.js";
import { startServer } from "./server.js";

const env = await loadEnv();
const s = await startServer(env, Number(process.env.PORT ?? 2567));
console.log(`triple draft football server on :${s.port} (ws path /ws), pool ${env.poolHash}`);
