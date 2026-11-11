# Triple Draft Football: feature catalogue

This file describes what the game does as of M12, written for brainstorming new features.
It is meant as context for an AI or a designer, so it covers gameplay, modes, presentation,
technology and the limits that new ideas have to work within. It ends with known gaps and a
list of suggested features.

---

## 1. What the game is

A browser football game (desktop and phone) with two halves:

1. **Drafting.** In a *Triple Draft* you build a full 22-player lineup (plus kicker, punter and
   returners) by picking one of three offered real NFL players each round, usually head-to-head
   against another person or an AI.
2. **Playing.** You then play an arcade-style game with that team, in the spirit of Retro Bowl:
   you call plays, snap, throw by pulling back like a slingshot and releasing, steer the ball
   carrier, and flick to kick. All 22 players are simulated on the field.

The headline mode is **online head-to-head Triple Draft**: two people draft against each other
live and then play the game.

**Data:** the 1,941 real players come from the Madden NFL 27 ratings sheet, matched to nflverse
for ids and draft info, with real team names and colours. Every on-field outcome comes from
Madden ratings. There are no invented attributes, no fantasy types and no gacha rarity. Because
of the real players, the build is for private use only.

---

## 2. Player cards and team building

- **Player card:** a real player with his overall at *every* game position (fitted to Madden's
  own overalls, r ≈ 0.99), his natural positions, a talent tier, his Madden archetype (Field
  General, Power Rusher, Deep Threat, Man to Man…), his real height, weight and age, his abilities
  and, for 88+ overall players, a named signature move.
- **Talent tiers:** Elite 90+, Pro Bowl 80–89, Starter 70–79, Depth below 70. A team can have at
  most 3 Elite players.
- **Team grades:** grades per unit (QB, OL, skill players, DL, LB, DB, special teams) and an
  overall grade. The position weights behind them were fitted to what actually wins games in the
  engine (QB and edge rushers matter most).
- **Chemistry:** a bonus for real-life teammates, such as a QB throwing to receivers from his
  actual NFL team or offensive linemen who play together. It is capped at +2.4 overall.
- **Abilities:** 23 passives (always on), 33 actives (paid for with momentum, one armed per side
  per play) and 125 signature moves. Each signature has a group effect: a QB makes every receiver
  get open, an RB makes the first tackles miss, an OL slot turns the whole line into a Brick Wall,
  a DB picks off passes in his zone, and so on.
- **Momentum meter:** 3 bars, filled by first downs, big plays, touchdowns, takeaways, sacks, field
  goals and defensive stops, and spent on actives.

---

## 3. The Triple Draft

- Each round you see **three offer cards**: a real team helmet, tier, archetype, key ratings,
  abilities and the slot where the player fits best.
- The **slot board** is an All-22 field layout. It shows what the selected player would rate in
  every open slot: green / ✓ natural, yellow / ~ playable, red / ✗ out of position.
- **Offer rules:** tier weights, a bias toward players who fit open slots, at least one fit in
  every offer, and every offer a fit once only a few slots are left open. The two teams never see
  the same players, unless mirror mode is on.
- **Options:** Quick draft (24 picks with auto backups) or Full draft (32 picks, including an
  8-man bench); **mirror mode** (both teams get the same offers, a priority token alternates, and
  whoever loses a double pick gets the better of his other two); reveal passed players; **themed
  rounds** (one NFL team, one division, young players); 2 rerolls; 30-second pick timer with
  auto-pick; BEST FIT auto-assign.
- **Simultaneous reveal:** both picks are shown at once, with the change in team grade.
- **AI drafters:** Best Available, Need-Based, Team Stacker (chases chemistry) and Chaos.
- **Hot-seat draft:** two people on one device, with privacy screens between picks.
- **Post-draft:** unit grades side by side, chemistry, starters, a **predicted spread** from 12
  simulated games and the full draft log. Any drafted team can be **saved** for later use.
- **Lineup builder:** field view, tap-tap swaps, bringing bench players in, a sub-package depth
  chart (WR4, TE2, CB3, FB…), KR/PR choice, base offense (balanced / spread / pro-style /
  run-heavy / air raid) and base defense (4-3 / 3-4).

---

## 4. On-field gameplay

### Engine

- All 22 players are simulated at **30 Hz** with fixed-point maths and a seeded RNG. Given the
  same inputs, every game replays identically, which the online mode and replays rely on.
- Realistic blocking (zone combos, climbs, pullers, lead blockers, slide protection), route
  running, man and zone coverage compiled against the front on the field, pursuit, tackling,
  fumbles, interceptions, contested catches, penalties (false starts, offside, delay of game and
  others).
- **Balance** is checked with a 10,000-game harness against targets for 28 metrics: points
  (~22–23 per team), plays, run/pass split, completion % (~61–64), yards per attempt, yards per
  carry, sack rate, turnovers, 3rd-down rate, field goal % by distance, punts, returns,
  touchbacks, onside kicks and penalties. Every metric is currently in range. The better team
  wins about 74–90% of the time, depending on the size of the gap.

### Offense

- **Playbook:** 9 personnel groups, 16 formations and about 65 plays: inside and outside zone,
  power, counter, trap, iso, toss, draws, QB runs, zone read, inverted veer, 5 RPOs, quick game,
  5 screens, dropback concepts, shots, Hail Mary, 7 play-action plays including a bootleg, jet
  sweep, jet fake boot and orbit flat.
- **Play-call screen:** SUGGESTED / RUN / PASS / RPO tabs, personnel and formation filters,
  search, FLIP, a SCOUT report of the opponent's tendencies, punt or field goal with make %,
  kneel, spike and timeout.
- **Pre-snap** (10-second play clock): motion (jet, across, orbit, short, return; a man defender
  following the motion man gives away man coverage), shifts, hot routes on any receiver
  (13 routes), slide protection, keeping the Y / RB / H in to block, a hard count, 5 editable
  audible slots and a route overlay.
- **Controls:** tap SNAP; pull back and release to throw (a short pull lobs, a long pull fires a
  bullet); hold to steer the carrier; JUKE / SPIN / BURST / SCRAMBLE; read-option KEEP.

### Defense

- **Fronts:** 4-3, 3-4, Nickel, Dime, Quarter, 46, Bear and Goal Line. **Calls:** 19, including
  Cover 0/1/2/3/4/6, Tampa 2, 2-Man, Prevent, blitzes, fire zones and run stunts.
- You see the offense's **personnel** before you call, but never its play.
- **Pre-snap:** line shifts, linebacker depth, show blitz, 1-high / 2-high safety disguises,
  press or bail, QB spy, double a receiver, 5 audibles, and your assignments drawn on the field.
- **Defensive control mode** (a setting): steer one defender with DIVE / STRIP / SWAT / SWITCH,
  with an automatic switch to the defender nearest the ball. Otherwise the AI plays the defense
  and SKIP fast-forwards.

### Special teams

- **Flick kicking:** the swipe's direction and length set aim and power, its bend sets the curve.
  An accuracy cone comes from the kicker's rating and widens under pressure late in the game.
- **Wind** per game, shown on the kick sheet and as an arrow on the field. Teams change ends every
  quarter.
- Field goals and PATs through modelled uprights; kickoffs (deep, squib, onside with a live
  loose-ball scramble); punts with AI coffin-corner kicks; touchbacks, out-of-bounds kicks, downed
  punts, fair catches, muffs and return fumbles.
- **Live returns** that you steer behind a left, middle or right wall.
- Blocked field goals and punts (ALL-OUT BLOCK), scoop-and-score, fake punts (pass or run) and
  fake field goals.

### AI coach

- Picks personnel and formation for the situation, and a front that answers the offense's
  personnel. Its calls follow tendencies per situation plus a team style.
- Manages the clock, goes for it on 4th down, runs Hail Marys at the end of a half, kicks onside
  when trailing late, and squibs to end a half.
- Uses pre-snap motion and disguises, checks out of deep drops against a blitz look, uses hard
  counts on short yardage and arms abilities on key snaps.

---

## 5. Game modes

| Mode | What it is |
|---|---|
| **Online** | Private rooms (5-letter code), quick match, room settings (format, mirror, themed rounds, timers, quarter length, abilities, defender control), live draft and match, reconnect after a reload, rematch. |
| **Ranked** | Online matches between guest accounts, Elo rating (K 32), monthly seasons starting at 1200, pairing within a rating window that widens the longer you wait, no throw guide. |
| **Boss Gauntlet** | Draft against the AI, then play a 17-week season against 12 themed **League Bosses** (Air Raid Aces, Ground Pounders, Blitz Brigade, No Fly Zone, Iron Curtain, Speed Demons, Special Forces, Gunslingers, Monsters of the Middle, Spread Kings, The Fortress, The Dynasty), each with its own scheme and rising strength. 10+ wins = a 3-round playoff ending against The Dynasty. Play or SIM each game; the score goes to the leaderboard. |
| **Daily Draft** | The same seed for everyone that day: identical round-1 offers and 5 bosses. One try per day, posted to the daily board. |
| **Franchise** | See below. |
| **vs AI / Hot-seat** | A Triple Draft against an AI drafter, or two people on one device (pass-the-device play calling). |
| **Exhibition** | Real NFL rosters or saved drafted teams. |
| **Practice** | 6 guided drills (Passing, Running, Kicking, Reading coverage, Motion & audibles, Defense), each with steps, a fixed defensive look, a coverage-read explanation and a completion mark. |
| **Leaderboards** | Daily, Gauntlet and Ranked ladders on the server. |

### Franchise mode

- 3 save slots. You take over one of the 32 real clubs in its real division, with its real roster
  or with a saved drafted team.
- **Season:** 17 weeks (6 division games), playoffs with 7 teams per conference and a bye for the
  1 seed, 4 rounds. You play or sim your own game while the rest of the league sims in Web Workers
  (about 1.5 s a week).
- **Hub:** job security, morale and fan meters, coaching credits and the salary cap. Tabs: HOME,
  ROSTER (develop, extend, cut, trade offers, lineup), LEAGUE (standings, schedule, leaders),
  OFFICE (OC / DC / special teams coach / trainer, stadium / training / rehab facilities),
  HISTORY (champions, records book, awards, Hall of Fame) and NEWS.
- **Economy:** asking salaries based on overall, position and personality; a fixed $255M cap; dead
  cap on cuts. Credits come from wins, milestones and home crowds and buy development, staff and
  facilities, which have yearly upkeep.
- **People:** personalities (Loyal, Diva, Leader, Hothead) that trigger locker-room choice events,
  injuries per game, aging, progression and retirement.
- **Off-season:** awards, re-signing, a rookie Triple Draft (invented rookies built from real
  players' ratings plus noise), free agency against AI bids, then a new schedule. If your job
  security falls below 0 you are fired and take another job.

---

## 6. Presentation

- **Two cameras:** Bowl (top-down, you attack up the screen; the default on phones) and Pro
  (an All-22 broadcast view from the sideline with perspective, stands and a zoom on the ball
  carrier; the default on wide screens). Toggle with CAM or the V key.
- **Replays** of any play, rebuilt from the seed and your inputs: play/pause, scrub and speeds of
  0.25x, 0.5x and 1x. A highlight reel tags touchdowns, picks, fumbles, sacks, blocked kicks,
  50+ yard field goals and 20+ yard plays.
- **Halftime and final screens:** box score, drive chart and highlights.
- **Juice:** screen shake, slow-motion on clutch catches, touchdown confetti, pixel callouts
  (PICK!, SACK!, FUMBLE!) and haptics.
- **Audio:** all generated in the browser: chiptune menu and draft music, sound effects and a
  reactive crowd. Any sound can be replaced with a file through a manifest.
- **Look:** 16-bit pixel art with the Press Start 2P font and real team colours.
  Players are drawn as placeholder sprites for now.

## 7. Accessibility and settings

Camera, sound effects, music and volume; reduced motion; haptics; text size (Normal / Large /
Largest); remappable keys; colour-blind-safe draft markers; an option to control one defender.

## 8. Technology and constraints (for judging new ideas)

- **Determinism is sacred.** Anything that runs during a game must be reproducible from the
  seed and the inputs. Online play, replays and the server referee all depend on it. New gameplay
  has to go through the seeded RNG and fixed-point maths.
- **No tuning numbers in code:** every number lives in config JSON with a schema.
- **Online model:** one shared action log per draft and per match. The server orders every action
  and runs its own referee copy, and live plays use rollback.
- **Hosting:** free Render (static client plus a sleeping web service) and SQLite. The free plan
  has no persistent disk yet.
- **Real players** means the game stays private unless it gets licensing. Anything that shares
  publicly (share images, public links) should keep that in mind.
- **Mobile first:** touch controls, portrait Bowl camera, a first load of 385 KB (Phaser loads
  lazily).

## 9. Known gaps

- Weak plays: option plays and WR screens. Very strong plays: play-action shots and TE seams.
- Return touchdowns almost never happen.
- No penalties on kicks.
- Weather is only wind, and wind doesn't affect passes.
- No fatigue model, so the Workhorse ability and stamina-based substitutions do nothing.
- 23 passive abilities, where the spec wanted about 40.
- No real portraits in the client; sprites are placeholders.
- No spectators. A disconnect doesn't pause the game (the AI takes over after 15 s and the match
  is forfeited after 90 s). Rooms live in memory.
- Leaderboard scores aren't verified by replaying the game.
- Franchise: AI teams don't trade with each other, there are no draft-day trades and no
  per-player morale.
- No pre-snap matchup arrows, no draft share card, no drag-and-drop lineup.

---

## 10. Suggestions (starting points for brainstorming)

### Depth on the field

1. **Fatigue and stamina.** A per-player energy bar that drops on long drives and big plays, with
   automatic substitutions from the depth chart. This makes Workhorse work, gives the bench and
   Full drafts a reason to exist, and adds a no-huddle tempo decision.
2. **Weather and conditions.** Rain and snow (ball security, footing, slower field), heat, wind
   that affects passes, and stadium altitude. Pick it in the room settings or draw it from a
   real-stadium table in Franchise.
3. **Pre-snap matchup arrows** (from the spec): a toggle that shows the best and worst
   receiver-vs-defender matchups using real ratings. It teaches reading the defense and fits
   Practice.
4. **Hurry-up / no-huddle offense** with a shortened call sheet. The defense can't substitute, a
   real football tactic that pairs well with fatigue.
5. **A Hot Hand / In the Zone streak:** a player who keeps succeeding gets a small, visible boost
   for a few plays. Commentary and sound can play off it.

### Draft

6. **Draft strategies with consequences:** a pick that trades away a future reroll, or an
   "auction round" where both players bid momentum or credits for one marquee player.
7. **Draft challenges / constraints:** a salary-cap draft (each player has a price), "only
   players drafted after round 3", "no Elite players", "one player per NFL team". These are cheap
   to build on the existing offer engine and add variety to the Daily Draft.
8. **A draft card share image** (private-friendly): a pixel-art card of your 22 men, grades and
   predicted spread, exported as a PNG.
9. **Scouting fog:** in some modes, hide a player's exact ratings and show a range instead, which
   narrows after you play with him.

### Modes and progression

10. **Seasons for drafted teams (draft leagues):** 4–12 friends draft once into a private league
    and play a scheduled season online or asynchronously (the AI sims the games nobody plays).
11. **Asynchronous online play:** a draft where each pick has a long deadline, then an AI-simmed
    or ghost game. This works for friends in different time zones.
12. **Spectator mode and a shareable replay link**, using the existing deterministic log.
    Replaying the log also makes server-side leaderboard verification possible.
13. **Achievements / a challenge book:** "win with a 70-overall QB", "a 50-yard field goal into
    the wind", "a pick-six with control-defense", "a perfect gauntlet". Cheap, and they keep
    players coming back.
14. **Historic scenarios:** "down 10 with 4 minutes left", "4th and goal from the 1". A daily
    scenario challenge built on the practice drill setup code.
15. **More bosses with rule twists:** a boss that always goes for it on 4th down, one that never
    punts, a two-point-only boss, a boss that only blitzes.

### Franchise depth

16. **AI-to-AI trades and draft-day trades**, a trade deadline, and the value of draft picks.
17. **Player morale and playing-time arcs** tied to the personality system (a Diva unhappy about
    targets, a Leader lifting a young QB).
18. **Coaching trees and staff careers:** coordinators who get hired away when you win.
19. **Weekly game plans:** choose a focus (stop the run, attack the deep middle) that gives small
    boosts against the opponent's tendencies, informed by the SCOUT report.

### Presentation and feel

20. **Play-by-play commentary**, as on-screen pixel text and optionally text-to-speech, built from
    the box-score events and the abilities that fired.
21. **Real portraits** (the baked 16-bit headshots from Gridiron Dex) on cards, the score bug and
    the post-game star of the game.
22. **Better sprites and animations:** catches, dives, celebrations and team uniforms.
23. **Auto-replay of highlights** after the play, a "save clip" button, and a highlights
    collection kept across games.
24. **Stadium identity:** home-crowd noise that affects false starts for the visitors in big
    moments, team chants, and stadium colours.

### Learning and retention

25. **Adaptive tutorial:** watch where the player struggles (sacks, interceptions on Cover 2) and
    suggest the matching practice drill after the game.
26. **Post-game coach report:** "you threw into Cover 2 safeties 4 times", "your run game
    averaged 5.1 to the left". This uses the existing tendency data.
27. **Difficulty levels** for the AI: reaction delay, read quality and play-calling smarts, all
    kept in config files.

---

## 11. Prompt to brainstorm with

> Here is the feature catalogue of Triple Draft Football (above). Suggest new features that
> raise the game's quality and replay value. For each one give: the problem it solves or the
> fun it adds, which existing systems it builds on, how it respects the constraints in §8
> (determinism, config-driven tuning, online action logs, mobile, private real-player data), a
> rough size (S/M/L) and how we'd know it worked. Rank them by impact for effort.
