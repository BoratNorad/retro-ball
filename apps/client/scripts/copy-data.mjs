// Copy the shared data/config JSON into public/game-data so the browser can fetch it.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "..", "..", "..", "packages", "shared");
const out = join(here, "..", "public", "game-data");
// clear the contents, not the folder itself (a running dev server keeps serving it)
mkdirSync(out, { recursive: true });
for (const e of readdirSync(out)) rmSync(join(out, e), { recursive: true, force: true });
cpSync(join(shared, "data"), join(out, "data"), { recursive: true });
cpSync(join(shared, "config"), join(out, "config"), { recursive: true });
console.log("copied game data ->", out);
