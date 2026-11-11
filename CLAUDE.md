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
| Kicking physics calibration (FG % by distance, punt/kickoff depth) | `pnpm tsx tools/sim/kicks.ts` |
| Effect of each active ability / signature (armed vs not) | `pnpm tsx tools/sim/abilities.ts` (`ONLY=battering_ram,sig:RB N=70`) |
| Every play vs AI-chosen fronts/calls | `pnpm tsx tools/sim/plays.ts 60` (`ONLY=regex`, `BY=formation`) |
| Trace/probe a formation or front | add `FORM=gun_trips FRONT=nickel PERS=11` to `trace.ts` / `probe.ts` |
| Re-fit team-grade weights to what wins | `RANDOM_ROSTERS=1 FIT_OUT=/tmp/fit.jsonl pnpm sim:harness --games 10000` then `python3 tools/import/fit_grade_weights.py /tmp/fit.jsonl --write` |
| Play in the browser (dev server) | `pnpm dev:client` (copies data to `apps/client/public/game-data`, Vite on :5173) |
| Online game server | `pnpm dev:server` (watch) / `pnpm start:server` (`PORT`, default 2567; the dev client connects to `ws://<host>:2567/ws`, override with `?server=`) |
| Two-browser online check (draft + first drive) | server + dev client running, then `node tools/e2e/online_two_browsers.cjs 9 /tmp` (`RELOAD_AT=4` reloads one browser mid-game) |
| Production build of the client | `pnpm build` → `apps/client/dist` (CI builds it; Render uses `render.yaml`) |
| Gridiron Dex (legacy browser) | `pnpm dev:dex` |

Data pipeline order after a new ratings week: `data:import` → `data:fit` → `data:report` → commit
`packages/shared/data/*.json` and `config/position_weights.json`. CI fails if `pool.json` is stale.

## Layout

```
packages/shared   Zod schemas, data/ (players, teams, abilities, icons, pool, playbook/), config/ (all tuning; coach.json = AI play-calling)
packages/sim      headless core: seeded RNG, Q16.16 fixed-point maths, cards.ts (player cards), team grades,
                  rules.ts (rules engine), roster.ts, engine/play.ts (30 Hz 22-player engine), engine/special.ts
                  (30 Hz kicks + returns), engine/kicks.ts (FG distance helper, legacy rating models),
                  coach.ts (AI play calling + clock management), game.ts (full game loop + box score),
                  draft.ts (Triple Draft engine, AI drafters, spread prediction),
                  online.ts (match/draft action logs, OnlineMatch, wire rosters/inputs), net.ts (client/server messages)
apps/client       Vite + Phaser 3 + Preact: src/game/controller.ts (GameSession + 30 Hz live loop + UI state),
                  src/game/netcontroller.ts (online match: decisions -> server, rollback), src/net/client.ts (socket + replicas),
                  src/ui/Online.tsx (lobby, room, online draft, lineup, match),
                  src/render/FieldScene.ts (Bowl camera, sprites, slingshot aim, steer-to-finger), src/ui/*.tsx (menus, HUD),
                  src/ui/Draft.tsx (draft setup / board / reveal / post-draft / lineup builder)
apps/server       online game server (M8): ws rooms, timers, referee (src/room.ts), sockets/codes/quick match (src/server.ts)
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
   **Owner: "I want them working in the game"** — they are (decision 17).
7. **Team chemistry = real-life teammates:** a QB throwing to receivers from his actual NFL team,
   and offensive linemen who play together. Capped (max +2.4 overall).
8. **Netcode: deterministic rollback (planned for M8).** Both clients run the identical fixed-point
   sim at 30 Hz, exchange per-tick inputs through the server, predict the opponent's input, and on a
   late input restore a snapshot and re-simulate. The server runs the same sim as referee and
   checks state hashes; on mismatch its state wins. **Hidden info:** play calls are committed as a
   hash during the play-call phase and revealed to both sims at the snap (rollback needs full state);
   pre-snap secrecy (calls, disguises, hot routes) is preserved, but a modded client could read the
   opponent's assignments once the ball is snapped. If that matters for ranked, fall back to the
   spec's server-authoritative model + local prediction for ranked only. **Owner confirmed this
   tradeoff ("That is acceptable") — build M8 this way.**
9. **Hosting:** free Render (static client; web service for the server, which sleeps when idle —
   slow first connection accepted). SQLite on a persistent disk for v1.
10. **Data tools stay in Python** (pandas/numpy are the right tools for xlsx import and regression);
    everything that runs in the game is TypeScript.
11. **Playbook model (M4).** Offense = QB + 5 OL + five eligible roles X/Y/Z/H/RB; a formation places
    them, a personnel group (10/11/12/13/20/21/22/01/23) says which roster slot fills each, and a play
    gives routes/blocking per role, so one play works from several formations. Sub-package players
    (WR4, TE2, FB, CB3, CB4, RB2, TE3, SS2, DT3, MLB2) come from the bench (`Roster.depth`; the Quick
    Draft's auto-generated backups fill them in M7). **Defensive calls are compiled at the snap**
    against whatever front is on the field: front rushers + blitz − drop, deep zones, spy, greedy man
    matching, remaining players take the call's underneath zones left to right. Fronts are drawn for
    the offense's strength to the right and mirrored, so every call works from every front.
12. **Defense sees personnel before calling.** `GameSession.previewAiOffense()` decides the AI's call
    early; the human defense sees the personnel group, never the play. After the whistle the result
    toast reveals the other side's call.
13. **Pre-snap = parameters + a short live phase (M5).** Everything the offense/defense changes before
    the snap (audible, flip, shift, hot routes, protection, defensive looks, spy, double) is a
    `PreSnapOffense` / `PreSnapDefense` passed to `createPlay`; `GameSession.adjust()` rebuilds the play
    with the **same per-play seed**, so re-lining up never changes the luck. Only motion runs live: the
    sim waits in a pre-snap phase (motion man + any man defender following him) until `{snap: true}`
    (the AI snaps a jet as the man reaches the ball). Disguises move alignment only; assignments stay
    the call's (spy/double are explicit overrides).

14. **Special teams are live plays (M6).** `createKick` is a `PlaySim` (same snapshot shape, so the
    client renders it like any play): a 3D ball (gravity, linear drag, per-game wind, curve from the
    swipe, bounces) and 22 men (coverage lanes, return wall, jammers, rushers). Field goals are good
    only if the ball crosses y = 110 between the uprights above the crossbar. Kicker error = a uniform
    aim/power error from kick accuracy, wider under pressure; the UI draws it as the accuracy cone.
    `kickChance` integrates that error grid deterministically (cached per kicker/spot/wind) and is
    what the AI and the FG % on the call sheet use. Units come from the roster (fast/tackling bench
    players cover, blockers return, best KR returns).

15. **Triple Draft engine (M7)** lives in `packages/sim/src/draft.ts`, deterministic from (seed, settings,
    actions) so the M8 server can run the same code. Offers: tier shares from `draft.json` tierWeights
    (uniform inside a tier), players who fit an open slot x needWeight, at least one fit always, all
    fits from lateOpenSlots open slots; the two teams' offers never overlap; Elite cap; passed
    options go back into the pool (only drafted players leave). Mirror mode: same offers, a priority
    token alternates (coin flip in round 1); the loser of a double pick gets the better of his other
    two. Auto-assign = the open slot that raises the team grade most. Backups for a Quick Draft are
    real undrafted players at a lower tier (overall <= backupMaxOvr), natural at the position. The
    pool's "rarity" = talent tier (decision 4). Themed rounds use real-football themes (one NFL team,
    one division, young players) instead of the spec's types/archetypes. AI drafters: Best Available,
    Need-Based, Team Stacker (real teammates = chemistry; replaces the spec's "Type Stacker"), Chaos.
16. **Hot-seat** = `GameSession({ hotseat: true })`: the side with the ball is the user; the defending
    player calls the defense first behind a privacy screen (passed in as `defCall`); kick returns and
    defensive play are AI-run in hot-seat.
17. **Abilities in play** (`packages/sim/src/engine/abilities.ts` + hooks in `play.ts` / `special.ts`).
    Ruleset `GameSetup.abilities` (default on; menu toggle, off = ratings only). Passives are always on
    for the player who has them; an **active** is armed for one player per side per play and paid with
    momentum (ability cost in bars) only if that player was on the field (`PlayResult.activesUsed`);
    one-shot actives fire once ("the next juke"). **Signature moves** (88+ players, 3 bars): their
    "+N Rating" boosts apply for the play plus a group special (QB: coverage lag on every receiver;
    RB: first tackles miss; WR/TE: auto-catch / jump balls; OL: whole line Brick Wall; DL: block
    can't hold him long + sack bonus; LB: instant read, no PA bite; DB: picks in his zone; K: perfect
    strike to 65 yds). **Momentum** (`GameSession.momentum`, points; 3 bars x `pointsPerBar`) from
    first downs, 20+ yd plays, TDs, takeaways, sacks, FGs, stops. Engine units for every effect are in
    `tuning.json` `abilities`. The AI arms an affordable, play-relevant active (`coach.json`
    `abilities`: roles per play kind; more often on key snaps). Client: ★ ABILITY pre-snap tab, ability
    rows on kick / return / try sheets, momentum meter in the score bug, popups over the player
    (`snapshot.fx`). Big Leg does not touch kickoffs (touchback rates swing hard with kick power).
    Workhorse has no effect until there is a fatigue model.

18. **Online (M8) = one deterministic action log per draft and per match.** `OnlineMatch` (sim/online.ts) is
    a `GameSession` with both sides human, driven only by serializable `MatchAction`s (snap = both
    sides' pre-snap decisions, adjust, hardCount, delay, play = every tick's inputs, human = AI takes a
    side over / gives it back). The server orders every action and runs the referee copy; both
    browsers replay the same log (checksum after every action, resync on mismatch; a reconnect just
    replays the log). Drafts likewise: the server's `Draft` plus a `reroll` / `reveal` log. **Live
    plays:** each client sends its per-tick input (`inputDelayTicks` late), predicts the opponent
    (last run direction, no actions) and on a confirmed input that differs re-simulates the play from
    tick 0 (`LivePlay.remake`; a few hundred cheap ticks, so no snapshot/restore is needed). The server
    confirms ticks in order, paced by real time, giving a late or absent side "no input" after
    `fillMs`; it also forces a default kick / the snap for a human who stalls. **Hidden info:** the
    offense calls first and the defense only learns the personnel; both calls reach both clients at
    the line-up (the snap action) and the UI shows the other side's call only after the whistle (decision
    8's accepted tradeoff, moved from the snap to the line-up so pre-snap adjustments can be shared).
    Draft offers are computed by each client's replica from the shared log (a modded client could
    see the opponent's offers, never his pick before the reveal). **Transport: plain `ws`, not
    Colyseus** (the spec allows a custom room layer; Colyseus's state sync is the wrong model for a
    lockstep action log). Timers and netcode numbers: `config/online.json`.

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
- [x] **M4 Full play calling** — 9 personnel groups, 16 formations, 62 plays (inside/outside zone,
  power, counter, trap, iso, toss, draw, QB draw/power/sneak, zone read, inverted veer, 5 RPOs, quick
  game, 5 screens, dropback concepts, shots, Hail Mary, 7 play-action incl. bootleg), 8 fronts (4-3,
  3-4, Nickel, Dime, Quarter, 46, Bear, Goal Line), 19 calls (Cover 0/1/1-Spy/2/2-Man/Tampa 2/3 Sky/
  3 Buzz/4/6, Prevent, man/zone/edge/A-gap/corner/safety blitzes, fire zones, run stunts). Engine:
  zone combos + climbs, pullers and lead blockers, draws, read option (key crash/squeeze), RPO
  conflict reads, play-action bites (scaled by the offense's run rate), bootlegs, screens (line
  releases), stalk blocks, green-dog man defenders, QB spy. AI: personnel/formation by situation,
  front answers personnel, tendencies per situation tilt calls; Hail Mary at the end of halves.
  **Defensive control mode** (setting): steer one defender, DIVE / STRIP / SWAT / SWITCH, auto-switch
  to the man nearest the ball. Client: SUGGESTED / RUN / PASS / RPO tabs, personnel → formation
  filters, search, SCOUT tendency report, front + call picker, read-option KEEP.
  **10,000 real-team games: 18/18 metrics in range** — 22.1 pts/team, 67 plays, 59% pass, 61.4% comp,
  7.6 yds/att, 3.9 ypc, 7.0% sacks, 1.6 TO, 1.0 INT, 39% 3rd down, 357 yds. Grade weights refitted
  (QB, DE, OLB matter most); grade gap 3–5 wins 74%, 5+ 88%.
- [x] **M5 Pre-snap layer** — 10 s play clock (delay of game on expiry). Offense: motion (jet, across,
  orbit, short, return; man defenders follow it = a real man/zone read), jet sweeps (handoff on the
  run, speed boost when snapped at speed), shifts (Y other side / Y flex / Z tight), hot routes on any
  receiver (13 routes), slide protection, keep Y/RB/H in, hard count (offside chance vs DL play
  recognition, false-start risk, once per play), 5 editable audible slots + flip. Defense: line
  over/under/pinch/spread, LBs in/out, show blitz, 1-high/2-high safety disguise, press (jam = press
  vs release; a beaten press corner turns late) or bail, QB spy, double a receiver, 5 audible calls.
  AI: motion, disguises, press/bail, line shifts, checks out of deep drops vs a blitz look, hard
  counts on short yardage (`coach.json` presnap). Client: pre-snap panel with route overlay (hot
  routes red) and, on defense, your assignments (zones, man lines, rush/spy). New plays: Jet Sweep,
  Jet Fake Boot, Orbit Flat. **10,000 real-team games: 18/18 in range** — 21.6 pts, 61.3% comp,
  7.5 yds/att, 3.8 ypc (run hold base raised 4.0 → 4.45 to offset shown blitzes and line shifts), 7.0% sacks,
  1.6 TO, 37.7% 3rd down.
- [x] **M6 Special teams** — flick kicking (direction + power from the swipe, curve from the swipe's
  bend, accuracy cone from kick accuracy, pressure in the last 2 minutes), wind per game (shown on the
  kick sheets and as an arrow at the kick spot; teams change ends each quarter), field goals / PATs
  through modelled uprights, kickoffs (deep, squib, onside with a live loose-ball scramble: steer and
  DIVE), punts (AI coffin corner from the opponent's 45 in), touchbacks, out-of-bounds kicks, downed
  punts, fair catches (FAIR CATCH button; AI fair-catches with coverage close), kneels in the end
  zone, muffs, return fumbles, live returns you steer (JUKE/SPIN/BURST) behind a left/middle/right
  wall, blocked FGs/punts (rush vs protection; ALL-OUT BLOCK raises it) with scoop-and-score, fake
  punt pass/run and fake FG pass from real punt / field-goal formations (the punter throws), AI
  onside kicks when trailing late, squibs to end halves. Goal posts drawn on both end lines. **10,000 real-team games: all 27 harness metrics in range** (9 new special-teams rows) — punts 47.5 gross / 36.6 net, KR 19.9, PR 9.8, touchbacks 34%, onside 11%, FG 96/81/72% (<40 / 40s / 50+), PAT 96.6%; tackle fall-forward base +0.25 kept ypc at 4.0 (4,000-game recheck). Grade weights refitted (SS, DE, QB on top).
- [x] **M7 Triple Draft offline** — main menu modes (Triple Draft vs AI, Hot-seat draft, Exhibition).
  Setup: team name (abbr derived), 8 colour palettes, pixel logo from `icons.json`, AI personality,
  Quick (24) / Full (32, +8 bench), mirror, reveal passed, themed rounds, 30 s pick timer (warning at
  10 s, auto-pick on expiry), quarter length. Draft board: three offer cards (real team helmet, tier,
  archetype, key ratings, abilities, best-fit slot), All-22-style slot board showing what the selected
  player would rate in every open slot (green natural / yellow playable / red out of position), BEST
  FIT, 2 rerolls, live unit grades, the opponent's picks; simultaneous reveal with grade change (and
  passed options when enabled); hot-seat privacy screens between picks. Post-draft: side-by-side
  unit grades + chemistry + starters, predicted spread from 12 simulated games, full draft log.
  Lineup builder: field view, tap-tap swaps, bench-in, sub-package depth chart (WR4, TE2, CB3...),
  KR / PR choice (used by the return game), base offense (balanced / spread / pro-style / run-heavy /
  air raid: pass-rate shift + personnel preference in `coach.json` styles) and base defense (4-3/3-4),
  then kick off with the drafted rosters (hot-seat: pass-the-device play calling).
- [x] **Abilities in play** (owner: "I want them working in the game"; decision 17) — 23 passives,
  33 actives, 125 signature moves and the 3-bar momentum meter all act on the field (engine hooks in
  plays, kicks and returns); AI arms actives (~6 per team-game); client ABILITY tab, kick-sheet rows,
  score-bug meter, popups; ruleset toggle on the menu. Probe (`tools/sim/abilities.ts`) caught and
  fixed: Battering Ram trucked every tackle (+52 yds/run), Field General / QB signature only changed
  what the QB *saw* (fewer sacks, worse throws), Pancake / Hard Count left rushers unblocked, Big Leg
  swung touchbacks 9% -> 92%, Sticky Hands erased contested-catch losses. **4,000 real-team games,
  abilities on: 28/28 metrics in range** — 23.0 pts, 63.4% comp, 7.7 yds/att, 3.9 ypc, 6.2% sacks,
  1.4 TO, 40.9% 3rd down; grade gap 3–5 wins 77%, 5+ 90%. (Abilities off: 22.4 pts, 7.6 yds/att, 7.0% sacks.)
- [x] **M8 Online** (decision 18) — game server (`apps/server`, ws on `/ws`, `/health`): private rooms by
  5-letter code, quick match, room settings (format, mirror, reveal passed, themed, pick timer,
  quarter length, abilities, control defender), server-owned timers (pick, lineup, play call 25 s,
  defense 15 s, play clock, kicks), auto-picks / coach calls when a timer runs out, simultaneous
  reveal, lineup validation (only drafted players), forfeit after 90 s away, the AI plays an away
  side after 15 s, rematch = new draft, flood limit, pool-version check. Client: ONLINE menu entry,
  lobby (team name/colours/logo, quick match, create, join by code), waiting room, online draft
  board (locked-in state, opponent status, server pick clock), post-draft + lineup, online match
  (waiting bar with the server clock, the defense sees the personnel, presnap adjustments and
  abilities go through the server, rollback live play), reconnect on reload (session-stored seat
  token). Tests: two online replicas + a reconnect replay give the identical game, rollback =
  straight run, AI takeover, draft replica = server draft (mirror rerolls too); server test with
  two scripted clients over real sockets (quick match → draft → lineup → full game with a reconnect,
  checksums 0 mismatches, room codes, version mismatch). Two real browsers (Playwright,
  `tools/e2e/online_two_browsers.cjs`): draft in ~11 s, then plays in lockstep including a reload.
  Render Blueprint now has the `tdf-server` web service (the static client gets its host via `fromService`).
- [ ] M9 Pro camera + presentation · [ ] M10 Modes · [ ] M11 Franchise · [ ] M12 Polish

## Known issues / todo

- **Balance follow-ups:** re-fit grade weights whenever the engine changes meaningfully (done after M6). Tools:
  `tools/sim/matrix.ts` (pass/run play x coverage table, `KIND=run`), `probe.ts`, `trace.ts`,
  and the harness "per play call" table.
- Play balance (`tools/sim/plays.ts`): option plays (zone read 2, inverted veer 1, QB power 2 yds) and
  WR screens (bubble/smoke/tunnel 1–2 yds) are weak; PA shots (~15 ypp) and TE seams/Four Verts
  (11–13) are strong, so their AI weights are low. Jet sweep ~5.6 yds; Orbit Flat weak (~1.4).
- The human read-option window is short (0.5 s mesh): plan KEEP before the snap or tap during the mesh.
- Client bundle is 1.6 MB (Phaser); code-split later (M12). Portraits not yet in the client.
- Two-point tries pick a random non-deep play.
- Return TDs are very rare (~0 per game; NFL ~0.02/team-game): coverage pursuit wins most races.
- No penalties on kicks yet (holding on returns, running into the kicker, kick catch interference).
- Weather beyond wind (rain/snow/heat, ball security, footing) is not modelled yet; wind does not
  affect passes yet.

- Gridiron Dex on GitHub Pages showed blank portraits (headshot load or processing failed without
  falling back to the helmet). Fix when porting the portrait pipeline to the client in M3; baking
  headshots (`tools/import/bake_headshots.py`) avoids it.
- Spec wants ~40 passive abilities; we have 23 (all now work on the field, except Workhorse: no
  fatigue model yet). Retune actives with `pnpm tsx tools/sim/abilities.ts` (armed vs unarmed on the same seeds).
- **Online follow-ups:** ranked/Elo, matchmaking by rating and seasons (M10); spectators; the spec's
  limited match pauses on disconnect (now: the AI plays the away side after 15 s, forfeit at 90 s);
  rollback re-simulates the whole play (fine at ~1 ms a play; snapshot/restore if plays get heavier);
  online two-point tries and onside recoveries are human-vs-human but untested by the browser script;
  no rematch side swap; rooms live in memory (a server restart ends games; SQLite later for accounts).
- Draft extras not done: draft card share image, spectator link, daily draft (M10), drag-and-drop
  lineup (tap-tap only), stamina-based auto-sub thresholds (no fatigue model yet).
