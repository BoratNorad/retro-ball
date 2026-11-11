# Triple Draft Football — working notes for Claude

Browser football game: Retro Bowl-style hands-on play + All-22-style drafting of a full 22-player
lineup, with **online head-to-head Triple Draft** as the headline mode. Full spec:
`docs/spec.md` (the original prompt). This file records architecture, conventions, commands,
decisions and milestone status. Keep it updated.

## Commands

| What | Command |
|---|---|
| Install | `pnpm install` |
| Typecheck (strict) | `pnpm typecheck` |
| Unit tests | `pnpm test` (`pnpm test:watch`) |
| Rebuild pool + balance report | `pnpm data:report` (fails if a draft slot is short on options) |
| Re-import players from the Madden sheet + nflverse | `pnpm data:import` (Python: pandas, openpyxl; downloads nflverse CSVs) |
| Re-fit position-overall formulas | `pnpm data:fit` (Python: numpy) |
| Play one AI-vs-AI game, print box score | `pnpm sim:game BUF KC 42` (add `--pbp` for play-by-play) |
| Balance harness (all cores) | `pnpm sim:harness --games 1000` (spec target run: `--games 10000`) |
| Trace one play tick by tick | `pnpm tsx tools/sim/trace.ts four_verts cover3 7` (`ROLES=regex EVERY=n DEBUG_ROLE=FS`) |
| Summarise one play type over N reps | `pnpm tsx tools/sim/probe.ts slants cover1 300` |
| Play x coverage yardage table | `pnpm tsx tools/sim/matrix.ts 60` (`KIND=run` for runs) |
| Re-fit team-grade weights to what wins | `RANDOM_ROSTERS=1 FIT_OUT=/tmp/fit.jsonl pnpm sim:harness --games 10000` then `python3 tools/import/fit_grade_weights.py /tmp/fit.jsonl --write` |
| Play in the browser (dev server) | `pnpm dev:client` (copies data to `apps/client/public/game-data`, Vite on :5173) |
| Production build of the client | `pnpm build` → `apps/client/dist` (CI builds it; Render uses `render.yaml`) |
| Gridiron Dex (legacy browser) | `pnpm dev:dex` |

Data pipeline order after a new ratings week: `data:import` → `data:fit` → `data:report` → commit
`packages/shared/data/*.json` and `config/position_weights.json`. CI fails if `pool.json` is stale.

## Layout

```
packages/shared   Zod schemas, data/ (players, teams, abilities, icons, pool, playbook/), config/ (all tuning)
packages/sim      headless core: seeded RNG, Q16.16 fixed-point maths, cards.ts (player cards), team grades,
                  rules.ts (rules engine), roster.ts, engine/play.ts (30 Hz 22-player engine), engine/kicks.ts,
                  coach.ts (AI play calling + clock management), game.ts (full game loop + box score)
apps/client       Vite + Phaser 3 + Preact: src/game/controller.ts (GameSession + 30 Hz live loop + UI state),
                  src/render/FieldScene.ts (Bowl camera, sprites, slingshot aim, steer-to-finger), src/ui/*.tsx (menus, HUD)
apps/server       Colyseus (M8)
apps/dex          Gridiron Dex, the original static roster browser (kept working; parts get ported to client)
tools/import      Python importers (Madden xlsx + nflverse → JSON), position-weight fitter, headshot baker, icon maker
tools/report      TS build/report scripts (pool.json, distribution report)
data/raw          source spreadsheet
```

## Conventions

- TypeScript strict everywhere (`noUncheckedIndexedAccess` on). ESM, `.js` suffix on relative imports.
- **No tuning numbers in logic.** Speeds, probabilities, weights, thresholds, draft and clock rules
  live in `packages/shared/config/*.json` or `data/*.json`, validated by schemas in
  `packages/shared/src/schemas.ts`. Add a schema field before reading a new config value.
- `packages/sim` has no DOM and no Node APIs (runs in browser, server and tests). Node-only file
  loading is `@tdf/shared/node`.
- **Determinism:** anything that runs during a game (draft offers, plays, AI) must use `Rng`
  (xoshiro128**, integer-only) and `Fx` (Q16.16 integers, CORDIC trig, exact `isqrt`). No
  `Math.random`, `Math.sin/cos/exp/pow`, `Date.now()` or float accumulation inside sim ticks.
  Floats are allowed only at build time (player-card derivation) and for rendering.
- Tests live in `packages/*/test/*.test.ts` (Vitest).

## Decisions log

1. **Real players instead of original creatures (overrides spec §1 bullets 1–2, at the owner's
   request).** The draft pool is the 1,941 real players from the Madden NFL 27 ratings sheet,
   matched to nflverse for ids, headshots and draft info, with real team names and colours. All
   Gridiron Dex work carries over (ratings, abilities, badges, demo plays, 16-bit portraits).
   Consequence: this build is for private use; shipping publicly would need licensing. Keep the
   repo private.
2. **Player cards = real players + game-derived fields** (`pool.json`, built by
   `tools/report/build_pool.ts`): overall at every game position, natural positions, talent tier,
   Madden archetype, real bio (height/weight/age), abilities with tiers, signature move.
   **No invented attributes**: the spec's Pokémon-style creature layer (elemental types and a type
   chart, six "base stats", body archetypes, gacha rarity) was removed at the owner's request — this
   is a real-football game with the All-22 browser-game look. All on-field outcomes come from Madden
   ratings only.
3. **Overall at every position is fitted to Madden's own overalls** (`tools/import/fit_position_weights.py`):
   non-negative ridge regression per position over a sensible rating subset. Fits r ≈ 0.99,
   RMSE ≈ 1 overall point (LS weaker, r 0.85). A player's real position always uses his real Madden
   overall. NT/ILB/KR have no Madden equivalent and are derived (documented in the JSON).
4. **Talent tiers from real overall** (`config/tiers.json`): Elite 90+, Pro Bowl 80–89, Starter
   70–79, Depth < 70 (93 / 320 / 896 / 632). The draft's spec "rarity" rules use these tiers
   (e.g. max 3 Elite per team).
5. **Player style = Madden archetype** (Field General, Power Rusher, Deep Threat, Man to Man, ...),
   shown on cards; no other classification.
6. **Abilities:** the Gridiron Dex library (56: 23 passives, 33 actives) plus named signature moves
   for 88+ overall. Spec asks for ~40 passives; Starter-tier+ players get a second passive when they
   stand out. **Actives + momentum are kept as a ruleset (owner said yes), on by default**,
   configurable later; the spec's optional momentum meter is that same meter (3 bars, capped).
7. **Team chemistry = real-life teammates:** a QB throwing to receivers from his actual NFL team,
   and offensive linemen who play together. Capped (max +2.4 overall).
8. **Netcode: deterministic rollback (planned for M8).** Both clients run the identical fixed-point
   sim at 30 Hz, exchange per-tick inputs through the server, predict the opponent's input, and on a
   late input restore a snapshot and re-simulate. The server runs the same sim as referee and
   checks state hashes; on mismatch its state wins. **Hidden info:** play calls are committed as a
   hash during the play-call phase and revealed to both sims at the snap (rollback needs full state);
   pre-snap secrecy (calls, disguises, hot routes) is preserved, but a modded client could read the
   opponent's assignments once the ball is snapped. If that matters for ranked, fall back to the
   spec's server-authoritative model + local prediction for ranked only. **Confirm with owner before M8.**
9. **Hosting:** free Render (static client; web service for the server, which sleeps when idle —
   slow first connection accepted). SQLite on a persistent disk for v1.
10. **Data tools stay in Python** (pandas/numpy are the right tools for xlsx import and regression);
    everything that runs in the game is TypeScript.

## Balance targets (for the M2 harness)

Per team per game, arcade-realistic: 20–31 pts avg, 55–75 offensive plays, run/pass 42/58 ±8,
completion 60–70%, sack rate 5–9% of dropbacks, 1.0–2.0 turnovers, FG% 85+ inside 40 / 60–75 at
50+, 4–8 penalties. Flag outliers; also report win rate by talent edge.

## Milestone status

- [x] **M1 Skeleton** — monorepo, CI, schemas, seeded RNG, fixed-point maths, real-player pool with
  position overalls, abilities, team grades; balance report passes (its types/rarity layer was
  later removed — see decision 2).
  Stubbed: client, server (READMEs only).
- [x] **M2 Headless rules + play engine** — rules engine, rosters, playbook data, 30 Hz fixed-point
  22-player engine, kicking models, AI coach, full games + box score (`pnpm sim:game`), multi-core
  harness. **10,000-game run (seed full1): 16/18 metrics in range** — 23.6 pts/team, 64.5 plays,
  55% pass, 68.8% comp, 4.0 ypc, 8.5% sacks, 1.2 TO, 0.6 INT, 4.4 penalties, FG 98.6/86.3/67.1%,
  OT 8.9%, 360 yds/team. Slightly out: 8.6 yds/att (target 6–8), 49.6% 3rd-down (35–45).
  **Talent pass (after M2):** rating effects strengthened (blocking, tackling, catching, accuracy,
  reads, coverage reaction, speed/accel) and QB play made decisive (ball placement affects catch
  odds; high-awareness QBs throw into tighter windows). 10k real-team games: 17/18 metrics in range
  (3rd-down 46.1% vs ≤45). Better team's win %: gap 1–2 pts 59%, 2–3 66%, 3–5 73%, 5+ 86%.
  **Team grade weights are fitted** to engine outcomes on random draft-like rosters
  (`fit_grade_weights.py`): QB and edge rushers matter most; grade gap 3–5 pts wins 69%, 5+ 81%.
- [x] **M3 Playable offense vs AI (Bowl camera)** — `GameSession` (step-wise game loop; `playGame` is
  a loop over it, hash-identical) and `createPlay` (tick-by-tick play with `UserInput`: steer, throw
  at a spot with power, juke/spin/burst/scramble; tuning in `tuning.json` `user`). Client: pick two
  teams + quarter length, call plays (PASS/RUN tabs, FLIP, punt/FG with make %, kneel, spike,
  timeout), tap SNAP, pull back & release to throw (lob vs bullet by pull length), steer the carrier
  by holding a finger/arrow keys, JUKE/SPIN/BURST buttons (Space/E/Shift). On defense you pick a
  coverage (or coach's call) and watch the AI play (SKIP fast-forwards). Your team always attacks up
  the screen. Score bug, down & distance, LOS/first-down lines, result toasts, final box score.
  Verified with Playwright on desktop and iPhone 13 emulation. Render static-site Blueprint ready
  (`render.yaml`).
- [ ] M4 Full play calling · [ ] M5 Pre-snap layer · [ ] M6 Special teams · [ ] M7 Triple Draft offline
- [ ] M8 Online (rollback) · [ ] M9 Pro camera + presentation · [ ] M10 Modes · [ ] M11 Franchise · [ ] M12 Polish

## Known issues / todo

- **Balance follow-ups:** 3rd-down conversion slightly high (46%). Re-fit grade weights whenever the
  engine changes meaningfully (M4 playbook, M6 kicking). Tools:
  `tools/sim/matrix.ts` (pass/run play x coverage table, `KIND=run`), `probe.ts`, `trace.ts`,
  and the harness "per play call" table.
- Run game: backside LBs are unblocked on zone runs (no climbing/combo blocks yet) — add in M4.
- Client bundle is 1.6 MB (Phaser); code-split later (M12). Portraits not yet in the client.
- Two-point tries pick a random non-deep play; kickoffs/punts are rating models until M6.

- Gridiron Dex on GitHub Pages showed blank portraits (headshot load or processing failed without
  falling back to the helmet). Fix when porting the portrait pipeline to the client in M3; baking
  headshots (`tools/import/bake_headshots.py`) avoids it.
- Spec wants ~40 passive abilities; we have 23 — add more in M7 when the draft UI shows them.
