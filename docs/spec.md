# Claude Code Prompt — Triple Draft Football (working title)

You are building a complete, polished, browser-based American football game. It combines the arcade feel of **Retro Bowl** (hands-on QB passing, swipe running, swipe kicking, franchise management) with the **All-22 Pro** style (drafting a full 22-player lineup of type-based creatures graded on stats, size and type, a wide "All-22" broadcast camera plus a top-down retro camera, and a gauntlet of boss teams). The headline feature is **online head-to-head Triple Draft**: two players build their teams pick-by-pick from three random options each round, see each other's picks, then play each other.

Read this whole document before writing code. Then follow the "How to work" section.

---

## 0. How to work

1. Start in plan mode. Summarize your understanding, list open questions, and propose the repo structure and milestone plan (Section 16). Wait for my approval before writing code.
2. Create a `CLAUDE.md` at the repo root that records the architecture, conventions, commands (dev, test, build), and current milestone status. Keep it updated as you go.
3. Build milestone by milestone. At the end of each milestone: run all tests, run the game, list what works, what's stubbed, and what's next. Commit with a clear message.
4. Keep all tuning numbers (speeds, probabilities, rating weights, clock rules, draft settings) in data/config files, never hard-coded in logic.
5. Prefer small, testable modules. The simulation must run headless (no rendering) so it can be unit-tested and run on the server.
6. When something in this spec is ambiguous, pick the option closest to how Retro Bowl or real football works, note the decision in `CLAUDE.md`, and keep going. Ask me only about decisions that are expensive to reverse.

---

## 1. Vision and IP rules

- Copy **mechanics and feel**, never assets. Do not use any Pokémon names, sprites, type names lifted verbatim as a set, PokéAPI data, Retro Bowl art, logos, fonts, sounds, or text. Everything — creatures, teams, names, art, audio — must be original so the game can be shipped publicly.
- The roster is made of **original creatures** ("players") with elemental types, base stats and body size. Create an original dataset of at least 300 creatures (Section 4).
- Art direction: chunky pixel art (Retro Bowl–like readability) for the top-down "Bowl" camera, and clean sprite/2.5D figures for the "Pro" All-22 camera. Start with programmatic placeholder sprites (colored silhouettes with type-colored accents and a jersey number) and build an asset pipeline so real art can be dropped in later.
- Target: desktop browsers and mobile browsers (touch-first controls, also keyboard/mouse and gamepad). 60 fps on a mid-range phone.

---

## 2. Tech stack (propose alternatives in plan mode if you have strong reasons)

- **Language:** TypeScript everywhere, strict mode. Monorepo (pnpm workspaces): `packages/sim` (headless rules + physics), `packages/shared` (types, schemas, config, data), `apps/client`, `apps/server`.
- **Client:** Phaser 3 (or PixiJS) for the field; React (or Preact) for menus, draft screens and the playbook UI, layered over the canvas. Vite for builds.
- **Server:** Node.js with Colyseus (rooms, state sync, reconnection) or Socket.IO with a custom room layer. Server-authoritative.
- **Persistence:** SQLite via Prisma for dev, Postgres-ready. Store accounts (guest + optional login), saved franchises, match history, leaderboards.
- **Validation:** Zod schemas for all network messages and data files.
- **Testing:** Vitest (unit/property tests), Playwright (two-browser end-to-end draft and match).
- **Determinism:** Seeded PRNG (e.g. a small xoshiro/mulberry implementation) owned by the sim. Every draft and every play is reproducible from a seed + input log, which also powers replays.

---

## 3. Architecture

- **Sim core (`packages/sim`):** Pure TypeScript, no DOM. Contains the rules engine (downs, distance, clock, scoring, penalties, possession), the play engine (fixed-timestep 30 Hz physics/AI for all 22 players), play-calling resolution, special teams, injuries/fatigue, and the draft engine. Input is a stream of commands; output is state snapshots and events.
- **Renderer (`apps/client`):** Reads snapshots and interpolates. Two camera modes (Section 9). Never decides outcomes in online play.
- **Network:** Server runs the sim; clients send inputs with timestamps; server broadcasts snapshots plus discrete events (catch, tackle, whistle, penalty flag). Client-side prediction only for the locally controlled player's movement, reconciled to server state.
- **Hidden information:** The server never sends an opponent's play call, routes, coverage assignments, blitzers or hot routes to the other client. Only what is visible on a real field is sent: alignment, personnel, motion, and post-snap movement.
- **Offline modes** (vs AI, local hot-seat, season) run the same sim in the client.

---

## 4. Players: data model, ratings, types, grading

**Creature record:** id, name, primary type, optional secondary type, six base stats (Vitality, Power, Guard, Focus, Resolve, Speed — original names), height, weight, rarity tier (Common, Rare, Epic, Mythic), body archetype (lanky, stocky, compact, massive, winged, serpentine…), and an original short flavor line.

**Football ratings (0–99), derived from base stats + size + archetype** via configurable formulas: Speed, Acceleration, Agility, Strength, Hands, Route Running, Ball Security, Carrying/Elusiveness, Run Block, Pass Block, Throw Power, Throw Accuracy, Awareness, Tackling, Man Coverage, Zone Coverage, Pass Rush, Block Shedding, Kick Power, Kick Accuracy, Stamina, Injury Resistance. Example: massive, high-Guard, high-Power creatures make natural linemen; light, high-Speed creatures make receivers and corners; high-Focus creatures make accurate QBs.

**Positions:** QB, RB, FB, WR, TE, OL (LT, LG, C, RG, RT), DL (DE, DT, NT), LB (MLB, OLB, ILB), CB, S (FS, SS), K, P, and returner (KR/PR) as a role. Each creature gets a computed **overall at every position**; the best 1–3 are its "natural" positions. Playing out of position applies a configurable penalty.

**Types:** Design an original set of ~12–15 elemental types with an effectiveness chart (strong/weak/neutral). On contested one-on-one interactions (block vs pass rush, WR vs CB at the catch point, ball carrier vs tackler), type advantage adds a small, configurable modifier (default ±6%). Show matchup arrows pre-snap in a toggleable "Matchup" overlay. Types also give small passive traits (e.g. a water-like type ignores rain penalties, a fire-like type gets a stamina bonus in heat) — keep these subtle and data-driven.

**Abilities:** Each creature has one passive ability from an original list of ~40 (e.g. "Sure Hands: −50% drop chance in traffic", "Hurdle: can leap tacklers", "Cannon: +10% throw power", "Ice Veins: no kick penalty in final 2 minutes"). Rare+ creatures can have a second ability.

**Team grade:** Weighted average of starter overalls with heavier weights on QB, edge pass rushers and cornerbacks (configurable). Show an A+–F letter grade per unit (Offense, Defense, Special Teams, Overall) after the draft and in the lineup screen. Also show team chemistry: bonuses for type diversity on each side and for complementary pairings (QB/WR type synergy, OL cohesion).

---

## 5. Triple Draft (the core multiplayer mode)

**Flow**
1. Two players join a room (room code, invite link, or quick match). Each sets team name, colors and a simple logo from an original icon set.
2. Pre-draft settings (host chooses, both see): draft length, pick timer, defensive base (4-3 or 3-4 decided per team during the draft), rarity caps, rerolls, pool filters, mirror mode on/off.
3. **Each round:** both players simultaneously receive three random creatures (their own private offer). Each picks one and assigns it to an open roster slot (or auto-assign to best open fit). When both have locked in — or the timer expires — both picks are **revealed simultaneously** with a short card-flip animation showing the creature, position, overall and how it changes the team grade. The other two options are discarded (setting: "Reveal passed options" shows the opponent what you passed on).
4. Repeat until both rosters are full, then go to the post-draft screen: side-by-side team comparison, unit grades, type coverage chart, and a predicted spread.
5. Lineup/depth chart editing (Section 6), playbook audible slots, then kickoff.

**Draft rules and generation**
- **Quick Draft (default):** 24 rounds = 22 starters + K + P. Backups are auto-generated at a lower tier so fatigue/injuries still work.
- **Full Draft:** 22 starters + K + P + 8 bench picks (32 rounds).
- Offer generation is weighted toward positions the player still needs, and guarantees at least one option that fits an open slot. Late in the draft, if only certain slots remain, all three options must be eligible for them.
- No duplicates: once a creature is drafted by either team it leaves the shared pool. Each team's three offers in a round never overlap with the opponent's.
- Rarity weights per tier are configurable; default cap of 3 Mythics per team.
- Each team gets 2 rerolls per draft (redraw all three options; counts toward nothing else).
- Optional **themed rounds** (setting): a round can roll a type or a body archetype constraint, All-22 style.
- **Mirror mode** (setting): both players see the same three options; if both pick the same creature, a per-round priority token (alternating, coin flip in round 1) decides who gets it and the other auto-picks their highest-rated remaining option of the two.
- Pick timer default 30 s with an audible warning at 10 s; on expiry, auto-pick the best fit for open needs.
- All offers come from the server's seeded RNG; the client never generates offers in online play.

**Robustness**
- Disconnect: hold the room for 90 s; the missing player's picks are auto-made after their timer runs out. They can reconnect and resume.
- Draft log: every offer, pick and reveal is saved; allow viewing the full draft history after the match and sharing a draft card image.
- Spectator link (read-only) for friends to watch the draft and the match.

**Other draft modes using the same engine**
- **vs AI Drafter:** AI with selectable personalities (Best Available, Need-Based, Type Stacker, Chaos).
- **Daily Draft:** everyone gets the same seeded offers that day; play a gauntlet with your team; global leaderboard.
- **Local hot-seat:** pass-and-play on one device with a privacy screen between picks.

---

## 6. Roster, lineup and depth chart

- Visual field-view lineup builder (like the All-22 builder): drag to swap positions, tap to see ratings, highlight out-of-position penalties.
- Depth chart for every position, auto-sub thresholds for fatigue, separate KR/PR selection.
- Pre-game choices: base offense (e.g. Spread, Pro-Style, Run-Heavy, Air Raid — affects AI suggestions and playbook ordering), base defense (4-3 or 3-4), 5 offensive and 5 defensive audible slots.

---

## 7. Game modes (main menu)

1. **Online Triple Draft** (ranked and unranked, room codes, quick match).
2. **Triple Draft vs AI.**
3. **Daily Draft challenge** with leaderboard.
4. **Boss Gauntlet / Undefeated Challenge:** draft vs AI, then play a 17-game season against themed boss teams (original "League Bosses," each built around one type with a signature scheme), plus playoffs. Track "17–0" runs on a leaderboard.
5. **Franchise mode** (Section 10), Retro Bowl style.
6. **Exhibition** with saved teams.
7. **Practice / Tutorial:** guided drills for passing, running, kicking, reading coverage, using motion and audibles.

---

## 8. Core gameplay

### 8.1 Rules engine
- Real football rules: 4 downs, 10 yards, first downs, touchbacks, safeties, sacks, fumbles (with recoveries), interceptions and returns, PAT kick or 2-point try, field goals, punts, kickoffs, onside kicks, fake punts/FGs.
- Game clock: configurable quarter length (default 2.5 real minutes of accelerated clock, Retro Bowl–like), play clock, clock stopping rules (incompletion, out of bounds, timeouts, scores, change of possession, two-minute warning), 3 timeouts per half, spike, kneel, hurry-up.
- Overtime: configurable (college-style alternating possessions as default, NFL-style option).
- Penalties with configurable frequency driven by ratings and situation: false start, offsides/encroachment, delay of game, holding (offense/defense), pass interference, roughing the passer, intentional grounding, illegal motion, too many men. Flag animation, accept/decline choice for the non-offending team (auto-decision toggle).
- Weather: clear, rain, snow, wind (direction + strength shown), heat; affects ball security, kicking, passing and footing. Day/night games.

### 8.2 Play calling (both players, simultaneous, hidden)
- **Play clock phase:** both players pick a play within the play clock. Offense first chooses **personnel**, then **formation**, then the **play**. Defense chooses its personnel package, formation and call. The defense sees the offense's personnel substitution on the field before finalizing (as in real football), and the server enforces an auto-match option.
- **Offensive personnel groupings:** 10, 11, 12, 13, 20, 21, 22, 01 (and Empty, Goal Line, Heavy/Jumbo). Substitutions pull from the depth chart.
- **Offensive formations:** Shotgun (many variations: Trips, Bunch, Doubles, Empty, Spread), Singleback, I-Form, Strong/Weak I, Pistol, Wing-T/Wildcat (optional), Goal Line, Jumbo.
- **Offensive play types:** inside/outside zone, power, counter, dive, toss, draw, QB sneak, QB keeper/read option, RPO, play-action, screens (RB, WR, tunnel), quick game, dropback concepts (Mesh, Smash, Flood, Four Verts, Y-Cross, Drive, Stick, Slants), deep shots, Hail Mary, kneel, spike. Aim for 60+ plays with a searchable playbook filtered by formation, plus a "Suggested" tab based on down/distance and the opponent's tendencies.
- **Defensive personnel/formations:** 4-3, 3-4, Nickel, Dime, Quarter, 46, Bear, Goal Line.
- **Defensive calls:** Cover 0, 1, 2, 2-Man, 3 (Sky/Buzz), 4/Quarters, 6, Tampa 2, man and zone blitzes, fire zones, edge blitzes, A-gap pressure, run stunts, prevent.
- **Play history:** show both players a mini tendency report (run/pass %, favorite formations) — the AI uses it too.

### 8.3 Pre-snap: motion, shifts and audibles
After both calls lock, teams break the huddle and line up. A short pre-snap window (default 10 s, shown as a play clock) allows:

**Offense**
- **Motion:** select a skill player and choose jet, orbit, across, short, or return motion. Motion is visible to the defense. If a man-coverage defender follows the motion man, that reveals man coverage (a real read the player can learn). Snapping during jet motion gives speed boosts to jet sweeps.
- **Shifts:** shift formation strength or move a TE/WR to a new alignment.
- **Audibles:** change to one of the 5 audible slots, flip the play, or call a quick run/pass check.
- **Hot routes:** change any receiver's route (go, slant, out, in, curl, comeback, post, corner, drag, fade, wheel, block).
- **Protection:** slide protection left/right, keep TE or RB in to block.
- **Hard count:** risk/reward chance to draw offsides, increased false start chance on your own line.

**Defense**
- Shift the defensive line (over/under, pinch, spread), shift linebackers, show blitz then drop (disguise), rotate safeties, press or bail with corners, change to an audible call, assign a QB spy, double-team a receiver.
- Disguise: the alignment the offense sees can differ from the real call (bounded by realistic rules).

### 8.4 Snap and live play — controls
**Offense (Retro Bowl–style feel)**
- **Passing:** after the snap, drag back from the QB (touch) or hold-and-aim (mouse/gamepad) to throw. Drag distance and release set velocity/arc: short drag = lob over defenders, long drag = bullet. Show a trajectory guide (toggle; off in ranked). Receivers run their routes; throw timing and placement matter. Throw accuracy, pressure and type matchup affect ball placement and catch success. Allow throwing the ball away and scrambling.
- **Read option / RPO:** tap to hand off, or hold to keep.
- **Running:** move the ball carrier with a virtual stick or swipes; tap actions for juke, spin, stiff-arm, hurdle (ability-gated), dive, slide (QB), and a speed burst that consumes stamina.
- **Post-catch:** control passes to the receiver automatically.

**Defense (choose in settings; online both players get the same option)**
- **Control mode (default for PvP):** control one defender (auto-switch to the nearest to the ball, or manual switch). Actions: tackle/dive, swat/jump for the ball, strip attempt, user-rush.
- **Call-only mode (Retro Bowl style):** defense plays out automatically based on the call and ratings; the defensive player watches and can only make pre-snap decisions.

**AI:** every non-controlled player has role-based AI: blocking assignments (zone, gap, pull, combo, pass sets), pass rush moves vs block matchups, man/zone coverage logic with pattern-matching for advanced zones, pursuit angles, gang tackling. Rating-driven, deterministic under the seed.

### 8.5 Special teams
- **Kicking (FG, PAT, kickoff, punt):** swipe/flick mechanic — direction and power from the swipe, curve from swipe path; wind affects flight. Accuracy meter shrinks under pressure (final 2 minutes, long distance), modified by kicker ratings and abilities.
- **Kickoffs:** deep, squib, onside (with recovery mini-battle), plus touchback rules.
- **Punts:** directional, coffin-corner, fake punt option.
- **Returns:** control the returner; fair catch option; blocking AI sets up return walls.
- **Blocked kicks** possible based on rush ratings.

### 8.6 Fatigue, injuries, momentum
- Stamina drains per play by role and effort (bursts, long runs); tired players lose ratings and auto-sub based on the depth chart. Halftime partial recovery.
- Injuries: rare, rating- and ability-driven, with severity (play, quarter, game, multiple weeks in season mode). Toggle off for casual online matches.
- Momentum meter (optional setting): big plays fill it and give small temporary boosts; capped so it never decides a game.

---

## 9. Cameras and presentation

- **Pro camera (All-22):** high, wide broadcast view showing all 22 players and route development. Smooth follow on the ball with slight zoom-in on the ball carrier after the catch.
- **Bowl camera:** top-down retro view like classic 16-bit football games.
- Toggle any time between plays; default per device (Bowl on phones, Pro on desktop).
- Pre-snap overlays: line of scrimmage, first-down line, play art for your own call only, matchup arrows (toggle), coverage-read hints in Tutorial mode.
- HUD: score bug, quarter, game clock, play clock, down & distance, timeouts, possession, weather/wind.
- Post-play: short replay with scrub, highlight auto-saves for TDs, INTs and big hits. Drive summary and box score at halftime/end. Full replay of any play from the seed + input log.
- Juice: screen shake on big hits, slow-mo on clutch catches, confetti and stadium crowd swells on TDs, chunky pixel text popups ("TOUCHDOWN!", "PICK!").

---

## 10. Franchise mode (Retro Bowl–style management)

Use your drafted team or start from a random roster.
- Seasons: 17-game schedule in an original league (divisions/conferences), playoffs, championship game.
- **Coaching credits** earned by wins and milestones, spent on: player development, contract extensions, staff hires (Offensive Coordinator, Defensive Coordinator, Special Teams, Trainer), and facility upgrades (Stadium = fan support/revenue, Training = progression, Rehab = injury recovery). Facilities degrade unless maintained.
- **Team morale and fan support**, affected by results, playing time, and contract handling; morale modifies ratings slightly. Player personalities (Loyal, Diva, Leader, Hothead) occasionally trigger choice events (e.g. a star wants a new deal).
- **Salary cap and contracts:** salaries, years, extensions, cuts, cap penalties.
- **Off-season:** player aging/progression/retirement, rookie draft (Triple Draft format vs AI teams), free agency bidding, trades with AI teams.
- **Media/news feed** with procedurally generated headlines; owner expectations and a "job security" meter (getting fired ends the save; you can take a new job).
- Stats and records: player, team and league stats; season awards; Hall of Fame; records book.
- Multiple save slots; autosave each game.

---

## 11. Multiplayer details

- Matchmaking: casual quick match, ranked with an Elo/Glicko rating and seasons, private rooms via code/link, rematch button that redrafts.
- Room lifecycle: lobby → draft → lineup → match → results. Server owns all timers.
- Latency: target playable up to ~150 ms. Interpolate other entities; predict local controlled player; buffer throw/kick inputs with timestamps so passing feels responsive.
- Reconnect at any phase within 90 s; pause the match clock on disconnect (limited pauses per game). Forfeit after timeout.
- Anti-cheat: validate every input server-side; never send hidden info; rate-limit messages.
- Emotes/quick chat (preset phrases only; no free text chat in v1).

---

## 12. UI/UX screens

Title → Main Menu → Mode select → Lobby/Room → Draft (offer cards, timer, open slots, live team grade, opponent's revealed picks as a running list) → Post-draft comparison → Lineup/Depth Chart → Playbook/Audibles setup → Match (play call screen, pre-snap, live play, replay, halftime) → Results (box score, MVP, draft card, rating change) → Franchise hub (schedule, roster, staff, facilities, finances, news) → Settings (controls, camera, difficulty, defense control mode, trajectory guide, accessibility, audio) → Profile/Leaderboards.

Accessibility: colorblind-safe type colors with icons, scalable text, remappable controls, reduced-motion option, haptics toggle on mobile.

---

## 13. Audio

Original chiptune-style music for menus and draft; crowd ambience that reacts to the game state; SFX for snap, hits, catches, whistles, kicks, draft card flips and reveals. Use placeholder generated sounds (e.g. jsfxr-style) with an asset manifest for replacement.

---

## 14. Data and persistence

- `packages/shared/data/creatures.json` (validated by schema), `types.json` (chart), `abilities.json`, `playbook/*.json` (plays defined declaratively: alignment, assignments, routes as waypoints, blocking schemes), `config/*.json` (rules, tuning, draft settings).
- A small script to generate/validate the creature dataset and to print rating distributions per position so the pool is balanced (every position must have enough viable options across rarities).
- Guest accounts by default with optional login; cloud saves for franchise and stats.

---

## 15. Testing and balancing

- Unit tests for the rules engine: downs, clock stoppage, scoring, penalties and enforcement, overtime, safeties, touchbacks.
- Draft engine tests: no duplicates, offers always fill a needed slot, rarity caps respected, timer auto-picks, reconnect behavior, deterministic offers from a seed.
- Headless sim harness: run 10,000 AI-vs-AI games and report average score, plays per game, run/pass split, completion %, sack rate, turnover rate, FG % by distance, penalty rate. Target realistic-but-arcade ranges (document targets in `CLAUDE.md`) and flag outliers. Also report win rate by type and by rarity to catch balance issues.
- Playwright: two browsers complete an online draft and play the first drive.
- Replay determinism test: replaying a recorded input log yields an identical final state hash.

---

## 16. Milestones (each ends with tests passing and a demo)

1. **Skeleton:** monorepo, tooling, CI, schemas, seeded RNG, original creature/type/ability datasets with rating derivation and position overalls. *Done when* the dataset script shows balanced distributions.
2. **Headless rules + play engine:** full game simulated AI vs AI in the terminal with box score. *Done when* the balance harness runs and produces sane numbers.
3. **Playable offense vs AI (Bowl camera):** field rendering, passing/running controls, basic playbook, clock and HUD. *Done when* a full single-player game is playable on desktop and mobile.
4. **Full play calling:** personnel, formations, 60+ plays, defensive calls, defensive control mode.
5. **Pre-snap layer:** motion, shifts, audibles, hot routes, protections, hard count, defensive adjustments and disguises.
6. **Special teams:** swipe kicking, punts, kickoffs/onsides, returns, blocks, wind.
7. **Triple Draft offline:** vs AI drafter and hot-seat, post-draft comparison, lineup builder, depth chart.
8. **Online:** server, rooms, Triple Draft online with simultaneous reveal, online match with hidden info, reconnection, quick match.
9. **Pro camera and presentation:** All-22 view, replays, highlights, juice, audio.
10. **Modes:** Boss Gauntlet/17-game challenge, Daily Draft + leaderboards, ranked.
11. **Franchise mode:** full Retro Bowl–style management loop.
12. **Polish:** tutorial, accessibility, performance pass on mobile, balance pass from harness data, bug bash.

---

## 17. Definition of done for v1

Two people on different devices can open a link, Triple Draft a full team with three-option picks and simultaneous reveals, set a lineup, and play a complete game against each other using personnel, motion, audibles and hot routes, with real football rules, kicking, and a final box score — smoothly on a phone. Single-player Gauntlet and Franchise modes are complete, and all content is original.

---

## 18. Constraints and non-goals

- No real-money purchases, loot boxes, betting or ads in v1.
- No free-text chat in v1.
- No third-party copyrighted or trademarked assets, names or data.
- Do not sacrifice determinism or server authority for convenience.
