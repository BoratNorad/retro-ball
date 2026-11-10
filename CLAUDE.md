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
| Gridiron Dex (legacy browser) | `pnpm dev:dex` |

Data pipeline order after a new ratings week: `data:import` → `data:fit` → `data:report` → commit
`packages/shared/data/*.json` and `config/position_weights.json`. CI fails if `pool.json` is stale.

## Layout

```
packages/shared   Zod schemas, data/ (players, teams, types, abilities, icons, pool), config/ (all tuning)
packages/sim      headless core: seeded RNG, Q16.16 fixed-point maths, creature derivation, team grades
                  (M2+: rules engine, 30 Hz play engine + AI, draft engine, replay)
apps/client       Vite + Phaser 3 + Preact (M3)
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
  Floats are allowed only at build time (creature derivation) and for rendering.
- Tests live in `packages/*/test/*.test.ts` (Vitest).

## Decisions log

1. **Real players instead of original creatures (overrides spec §1 bullets 1–2, at the owner's
   request).** The draft pool is the 1,941 real players from the Madden NFL 27 ratings sheet,
   matched to nflverse for ids, headshots and draft info, with real team names and colours. All
   Gridiron Dex work carries over (ratings, abilities, badges, demo plays, 16-bit portraits).
   Consequence: this build is for private use; shipping publicly would need licensing. Keep the
   repo private.
2. **"Creatures" = enriched players** (`pool.json`, built by `tools/report/build_pool.ts`):
   overall at every game position, natural positions, 1–2 types, rarity, body archetype, six base
   stats (VIT/POW/GRD/FOC/RES/SPD), abilities with tiers, signature move.
3. **Overall at every position is fitted to Madden's own overalls** (`tools/import/fit_position_weights.py`):
   non-negative ridge regression per position over a sensible rating subset. Fits r ≈ 0.99,
   RMSE ≈ 1 overall point (LS weaker, r 0.85). A player's real position always uses his real Madden
   overall. NT/ILB/KR have no Madden equivalent and are derived (documented in the JSON).
4. **13 original types** (Blaze, Shadow, Grove, Venom, Tide, Volt, Titan, Gale, Quake, Mind, Storm,
   Frost, Iron) assigned from each player's ratings *relative to his position* (z-scores of type
   trait mixes), restricted to types eligible for his position group. Secondary type if the second
   z ≥ 0.75 (≈40% are dual-type). Chart is a ring (type i beats i+1 and i+3): exactly two
   strengths and two weaknesses each, ±6% on one-on-ones. Subtle weather/situation passives in data.
5. **Rarity from real overall:** Mythic 90+, Epic 80–89, Rare 70–79, Common < 70 (93 / 320 / 896 / 632).
6. **Abilities:** the Gridiron Dex library (56: 23 passives, 33 actives) plus named signature moves
   for 88+ overall. Spec asks for ~40 passives; Rare+ players get a second passive when they
   stand out. **Actives + momentum are kept as a ruleset (owner said yes), on by default**,
   configurable later; the spec's optional momentum meter is that same meter (3 bars, capped).
7. **Team chemistry with real players:** type diversity, QB↔receiver shared types, and
   **OL cohesion = linemen from the same real NFL team**. All capped (max +3 overall).
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
50+, 4–8 penalties. Flag outliers; also report win rate by type and by rarity.

## Milestone status

- [x] **M1 Skeleton** — monorepo, CI, schemas, seeded RNG, fixed-point maths, real-player pool with
  types, rarity, position overalls, abilities, team grades; balance report passes. 23 tests.
  Stubbed: client, server (READMEs only).
- [ ] M2 Headless rules + play engine (AI vs AI in terminal, box score, balance harness)
- [ ] M3 Playable offense vs AI (Bowl camera) — client deployed to Render from here
- [ ] M4 Full play calling · [ ] M5 Pre-snap layer · [ ] M6 Special teams · [ ] M7 Triple Draft offline
- [ ] M8 Online (rollback) · [ ] M9 Pro camera + presentation · [ ] M10 Modes · [ ] M11 Franchise · [ ] M12 Polish

## Known issues / todo

- Gridiron Dex on GitHub Pages showed blank portraits (headshot load or processing failed without
  falling back to the helmet). Fix when porting the portrait pipeline to the client in M3; baking
  headshots (`tools/import/bake_headshots.py`) avoids it.
- Spec wants ~40 passive abilities; we have 23 — add more in M7 when the draft UI shows them.
