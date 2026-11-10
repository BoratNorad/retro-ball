// Gridiron Dex ability system.
//
// Every player gets:
//   1 PASSIVE    always on
//   1-2 ACTIVES  triggered during a play by spending MOMENTUM (1-2 bars)
//   SIGNATURE    players rated 88+ get a unique named move that needs a full 3-bar meter
//
// Momentum: big plays (15+ yd gain, sack, takeaway, 3rd/4th-down stop, TD) fill 1 bar.
// The meter holds 3 bars. Abilities and their tier (I / II / III) are picked from the
// player's actual ratings, and the effect sizes scale with tier.
(function () {
  const LONG = {
    speed: "Speed", acceleration: "Acceleration", agility: "Agility", changeOfDirection: "Change of Dir.",
    strength: "Strength", jumping: "Jumping", stamina: "Stamina", toughness: "Toughness", injury: "Injury",
    awareness: "Awareness", throwPower: "Throw Power", throwAccuracyShort: "Short Accuracy",
    throwAccuracyMid: "Medium Accuracy", throwAccuracyDeep: "Deep Accuracy", throwOnTheRun: "Throw on Run",
    throwUnderPressure: "Under Pressure", playAction: "Play Action", breakSack: "Break Sack",
    carrying: "Carrying", bCVision: "BC Vision", breakTackle: "Break Tackle", trucking: "Trucking",
    stiffArm: "Stiff Arm", jukeMove: "Juke Move", spinMove: "Spin Move", catching: "Catching",
    catchInTraffic: "Catch in Traffic", spectacularCatch: "Spectacular Catch",
    shortRouteRunning: "Short Routes", mediumRouteRunning: "Medium Routes", deepRouteRunning: "Deep Routes",
    release: "Release", kickReturn: "Kick Return", passBlock: "Pass Block", passBlockPower: "Pass Blk Power",
    passBlockFinesse: "Pass Blk Finesse", runBlock: "Run Block", runBlockPower: "Run Blk Power",
    runBlockFinesse: "Run Blk Finesse", leadBlock: "Lead Block", impactBlocking: "Impact Block",
    tackle: "Tackle", hitPower: "Hit Power", pursuit: "Pursuit", playRecognition: "Play Recognition",
    blockShedding: "Block Shedding", powerMoves: "Power Moves", finesseMoves: "Finesse Moves",
    manCoverage: "Man Coverage", zoneCoverage: "Zone Coverage", press: "Press",
    kickPower: "Kick Power", kickAccuracy: "Kick Accuracy",
  };

  // ------------------------------------------------------------------ icons (12x12)
  // k = outline, 1 = main colour, 2 = light, 3 = dark
  const ICONS = {
    football: ["....kkkk....", "..kk1111kk..", ".k11111111k.", "k1112222111k", "k1121212111k",
      "k1112222111k", ".k11111111k.", "..kk1111kk..", "....kkkk...."],
    bolt: ["......kkkk..", ".....k11k...", "....k12k....", "...k12k.....", "..k1111kkk..",
      "..kkk1111k..", "....k21k....", "...k11k.....", "..k1k.......", "..kk........"],
    flame: [".....k......", "....k1k.....", "....k11k....", "...k1121k...", "..k112211k..",
      "..k122221k..", ".k12222221k.", ".k12233221k.", ".k12333321k.", "..k123321k..", "...kkkkkk..."],
    shield: [".kkkkkkkkkk.", ".k11111111k.", ".k12222221k.", ".k12111121k.", ".k12111121k.",
      ".k12111121k.", "..k121121k..", "..k112211k..", "...k1111k...", "....k11k....", ".....kk....."],
    target: ["...kkkkkk...", "..k111111k..", ".k11kkkk11k.", "k11k2222k11k", "k1k22kk22k1k",
      "k1k2k11k2k1k", "k1k2k11k2k1k", "k1k22kk22k1k", "k11k2222k11k", ".k11kkkk11k.", "..k111111k..", "...kkkkkk..."],
    wind: ["............", "..kkkkkkk...", ".k1111111k..", "..kkkkk11k..", ".......k1k..",
      "kkkkkkkk1k..", "k11111111k..", ".kkkkkkkk...", "...kkkkkkkk.", "..k22222222k", "...kkkkkkkk."],
    fist: ["..kkkkkkkk..", ".k1k1k1k11k.", ".k2k2k2k11k.", ".k1k1k1k11k.", ".kkkkkkk11k.",
      ".k11111k11k.", ".k1111111k..", "..k111111k..", "..k333333k..", "...kkkkkk..."],
    spiral: ["...kkkkkk...", "..k111111k..", ".k1kkkkkk1k.", ".k1k2222k1k.", ".k1k2kk2k1k.",
      ".k1k2k1k1k..", ".k1k2k1k....", ".k1k22k.....", "..k1kk......", "...k........"],
    hammer: ["kkkkkkkkk...", "k1111111k...", "k1222211k...", "k1111111k...", "kkkk33kkk...",
      "...k33k.....", "...k33k.....", "...k33k.....", "...k33k.....", "...kkkk....."],
    wall: ["kkkkkkkkkkkk", "k111k111k11k", "k122k122k12k", "kkkkkkkkkkkk", "k1k111k111kk",
      "k1k122k122kk", "kkkkkkkkkkkk", "k111k111k11k", "k133k133k13k", "kkkkkkkkkkkk"],
    glove: ["...k.k.k....", "..k1k1k1k...", "..k1k1k1k.k.", "..k1k1k1kk1k", "..k1111111k.",
      "..k111111k..", "..k22222k...", "..k22222k...", "...kkkkk...."],
    lock: ["....kkkk....", "...k1111k...", "..k1kkkk1k..", "..k1k..k1k..", ".kkkkkkkkkk.",
      ".k22222222k.", ".k222kk222k.", ".k222kk222k.", ".k2222k222k.", ".k22222222k.", ".kkkkkkkkkk."],
    heart: [".kkk...kkk.", "k122k.k111k", "k1211k1111k", "k111111111k", ".k1111111k.",
      "..k11111k..", "...k111k...", "....k1k....", ".....k....."],
    arrow: [".....kk.....", "....k11k....", "...k1221k...", "..k111111k..", ".kkkk11kkkk.",
      "....k11k....", "....k11k....", "..kkkkkkkk..", "..k333333k..", "..kkkkkkkk.."],
    magnet: ["kkkk....kkkk", "k22k....k22k", "kkkk....kkkk", "k11k....k11k", "k11k....k11k",
      "k11k....k11k", "k111kkkk111k", ".k11111111k.", "..kk1111kk..", "....kkkk...."],
    boot: ["...kkkk.....", "...k11k.....", "...k11k.....", "...k11k.....", "...k11k.....",
      "...k111kkk..", "...k111111k.", "...k2222222k", "...kkkkkkkk."],
    star: [".....kk.....", "....k11k....", "....k12k....", "kkkkk11kkkkk", "k1111221111k",
      ".k11122111k.", "..k111111k..", "..k11kk11k..", ".k11k..k11k.", ".kkk....kkk."],
    crown: ["k....kk....k", "kk..k11k..kk", "k1kk1221kk1k", "k1111111111k", "k1131131131k",
      "k1111111111k", "kkkkkkkkkkkk", "k2222222222k", "kkkkkkkkkkkk"],
    snow: [".....kk.....", "..k..k2k.k..", "...k.k2kk...", "....kk2k....", "kkkkk22kkkkk",
      "k2222112222k", "kkkkk22kkkkk", "....k2kk....", "...kk2k.k...", "..k..k2k..k.", ".....kk....."],
    zigzag: ["kk..........", "k1k.........", ".k1k....kk..", "..k1k..k1k..", "...k1kk1k1k.",
      "....k11k.k1k", ".....kk...k1", "..........kk"],
    wave: ["............", ".kk....kk...", "k11k..k11k..", "k1k1kk1k1k.k", ".k.k11k..k1k",
      "....kk....k.", ".kk....kk...", "k22k..k22k..", "k2k2kk2k2k.k", ".k.k22k..k2k", "....kk....k."],
    eye: ["............", "............", "...kkkkkk...", "..k111111k..", ".k112kk211k.",
      "k1112kk2111k", ".k112kk211k.", "..k111111k..", "...kkkkkk...", "............"],
  };

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
      Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f)));
    return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  }

  // ------------------------------------------------------------------ library
  // w: stat weights. a/b: effect sizes for tiers I/II/III. demo/role: which pretend play shows it.
  const LIB = [];
  const def = (o) => LIB.push(o);

  // QB
  def({ id: "field_general", name: "Field General", kind: "P", g: ["QB"], w: { awareness: 2, throwAccuracyShort: 1 },
    icon: "eye", color: "#3d7be0", demo: "quick_pass", role: "qb", fx: "READ!",
    a: [2, 3, 5], desc: "Pre-snap reads are instant. The first read on every pass play is open by +{a} yds." });
  def({ id: "pocket_poise", name: "Pocket Poise", kind: "P", g: ["QB"], w: { throwUnderPressure: 2, breakSack: 1 },
    icon: "shield", color: "#5c6bd6", demo: "pass_pro", role: "qb", fx: "POISE",
    a: [25, 40, 60], desc: "Ignores {a}% of the accuracy penalty for throwing with a defender in his face." });
  def({ id: "cannon", name: "Cannon Arm", kind: "P", g: ["QB"], w: { throwPower: 3 },
    icon: "bolt", color: "#e0a019", demo: "deep_pass", role: "qb", fx: "ZIP!",
    a: [3, 5, 8], desc: "Max throw distance +{a} yds, and bullets get to receivers faster." });
  def({ id: "moonshot", name: "Moonshot", kind: "A", cost: 2, g: ["QB"], w: { throwPower: 1, throwAccuracyDeep: 2 },
    icon: "arrow", color: "#e05a2a", demo: "deep_pass", role: "qb", fx: "MOONSHOT!",
    a: [8, 12, 16], desc: "The next pass becomes a perfect spiral: +{a} Deep Accuracy, and it can't be tipped or batted." });
  def({ id: "dart", name: "Dart Throw", kind: "A", cost: 1, g: ["QB"], w: { throwAccuracyShort: 2, throwAccuracyMid: 1 },
    icon: "target", color: "#d63c3c", demo: "quick_pass", role: "qb", fx: "DART!",
    a: [6, 9, 12], desc: "The next pass under 20 yds hits the receiver in stride: +{a} Short/Med Accuracy and a YAC head start." });
  def({ id: "escape", name: "Escape Artist", kind: "A", cost: 1, g: ["QB"], w: { speed: 1, agility: 1, throwOnTheRun: 2 },
    icon: "wind", color: "#2aa889", demo: "scramble", role: "qb", fx: "ESCAPE!",
    a: [6, 9, 12], desc: "Automatically slips the next sack attempt and rolls out, with +{a} Throw on Run for 3 sec." });
  def({ id: "hard_count", name: "Hard Count", kind: "A", cost: 1, g: ["QB"], w: { awareness: 2, playAction: 1 },
    icon: "eye", color: "#8a5cd6", demo: "pass_pro", role: "qb", fx: "HUT-HUT!",
    a: [30, 45, 60], desc: "At the snap, the defensive line jumps offside ({a}% chance) or freezes for half a second." });

  // RB / FB
  def({ id: "vision", name: "Cutback Vision", kind: "P", g: ["RB"], w: { bCVision: 3 },
    icon: "eye", color: "#2f9e44", demo: "speed_burst", role: "rb", fx: "LANE!",
    a: [3, 5, 8], desc: "Running lanes light up a step early: +{a} BC Vision on every carry." });
  def({ id: "ball_security", name: "Ball Security", kind: "P", g: ["RB", "WR", "TE"], w: { carrying: 3 },
    icon: "lock", color: "#7a6a52", demo: "truck", role: "rb", fx: "SECURE",
    a: [30, 50, 75], desc: "Fumble chance on big hits -{a}%." });
  def({ id: "workhorse", name: "Workhorse", kind: "P", g: ["RB", "OL", "DL"], w: { stamina: 2, toughness: 2 },
    icon: "heart", color: "#d6455b", demo: "truck", role: "rb", fx: "WORKHORSE",
    a: [8, 12, 16], desc: "No fatigue penalty for his first {a} snaps or touches of each half." });
  def({ id: "ankle_breaker", name: "Ankle Breaker", kind: "A", cost: 1, g: ["RB", "WR"], w: { jukeMove: 2, agility: 1, changeOfDirection: 1 },
    icon: "zigzag", color: "#e0a019", demo: "juke", role: "rb", fx: "JUKE!",
    a: [0.5, 0.8, 1.2], desc: "The next juke always works. The defender stumbles for {a} sec." });
  def({ id: "cyclone", name: "Cyclone", kind: "A", cost: 1, g: ["RB", "WR"], w: { spinMove: 2, agility: 1 },
    icon: "spiral", color: "#3fa7d6", demo: "spin", role: "rb", fx: "SPIN!",
    a: [10, 15, 20], desc: "A 360° spin that can't be stopped by arm tackles, and keeps {a}% more speed out of the spin." });
  def({ id: "battering_ram", name: "Battering Ram", kind: "A", cost: 2, g: ["RB", "TE"], w: { trucking: 2, strength: 1, breakTackle: 1 },
    icon: "hammer", color: "#b0482c", demo: "truck", role: "rb", fx: "TRUCK!",
    a: [70, 80, 90], desc: "For 3 sec every collision is a truck. Defenders under {a} Strength get flattened." });
  def({ id: "stiff_arm", name: "Iron Stiff Arm", kind: "A", cost: 1, g: ["RB", "WR", "TE", "QB"], w: { stiffArm: 2, strength: 1 },
    icon: "fist", color: "#8f5a2e", demo: "stiff_arm", role: "rb", fx: "SHOVE!",
    a: [2, 3, 4], desc: "The next stiff arm puts the tackler on the ground, and the carrier gains {a} extra yds of space." });
  def({ id: "afterburner", name: "Afterburner", kind: "A", cost: 2, g: ["RB", "WR", "QB"], w: { speed: 2, acceleration: 1 },
    icon: "flame", color: "#e5532d", demo: "speed_burst", role: "rb", fx: "BURNER!",
    a: [3, 5, 7], desc: "Once past the line: +{a} Speed for 4 sec, and pursuit angles are misjudged." });
  def({ id: "lead_block", name: "Lead Blocker", kind: "A", cost: 1, g: ["RB"], pos: ["FB"], w: { leadBlock: 2, impactBlocking: 1 },
    icon: "wall", color: "#a88f3a", demo: "block_pancake", role: "ol", fx: "LEAD!",
    a: [1, 1.5, 2], desc: "Explodes through the hole and takes out the first linebacker for {a} sec." });

  // WR / TE
  def({ id: "sticky_hands", name: "Sticky Hands", kind: "P", g: ["WR", "TE", "RB"], w: { catching: 3 },
    icon: "glove", color: "#e6b422", demo: "quick_pass", role: "wr", fx: "SECURED",
    a: [30, 50, 70], desc: "Drop chance -{a}% on every catchable ball." });
  def({ id: "route_tech", name: "Route Technician", kind: "P", g: ["WR", "TE"], w: { shortRouteRunning: 1, mediumRouteRunning: 1, deepRouteRunning: 1 },
    icon: "zigzag", color: "#3d7be0", demo: "quick_pass", role: "wr", fx: "OPEN!",
    a: [1, 2, 3], desc: "Gets +{a} yds of separation out of every break." });
  def({ id: "deep_threat", name: "Deep Threat", kind: "P", g: ["WR", "TE"], w: { speed: 2, deepRouteRunning: 1 },
    icon: "arrow", color: "#5c6bd6", demo: "deep_pass", role: "wr", fx: "TOO FAST",
    a: [2, 4, 6], desc: "Safeties respect his speed and play {a} yds deeper, which opens the underneath routes." });
  def({ id: "safety_valve", name: "Safety Valve", kind: "P", g: ["TE", "RB"], w: { catching: 1, awareness: 1, shortRouteRunning: 1 },
    icon: "shield", color: "#2aa889", demo: "quick_pass", role: "wr", fx: "CHECKDOWN",
    a: [10, 20, 30], desc: "Always comes open when the QB is under pressure. Checkdown throws are {a}% more accurate." });
  def({ id: "skywalker", name: "Skywalker", kind: "A", cost: 2, g: ["WR", "TE"], w: { spectacularCatch: 2, jumping: 1 },
    icon: "arrow", color: "#8a5cd6", demo: "catch_contested", role: "wr", fx: "SKYWALK!",
    a: [10, 15, 20], desc: "Wins the next contested jump ball: +{a} Spectacular Catch and a higher leap." });
  def({ id: "shake_loose", name: "Shake Loose", kind: "A", cost: 1, g: ["WR", "TE"], w: { release: 2, shortRouteRunning: 1 },
    icon: "wind", color: "#3fa7d6", demo: "quick_pass", role: "wr", fx: "RELEASE!",
    a: [2, 3, 4], desc: "Beats press coverage at the line instantly and starts the route +{a} yds open." });
  def({ id: "toe_tap", name: "Toe Tap", kind: "A", cost: 1, g: ["WR", "TE"], w: { catchInTraffic: 2, awareness: 1 },
    icon: "glove", color: "#2f9e44", demo: "catch_contested", role: "wr", fx: "TOE TAP!",
    a: [8, 12, 16], desc: "The next catch in traffic or on the sideline is secured, with +{a} Catch in Traffic." });
  def({ id: "go_route", name: "Go Route", kind: "A", cost: 1, g: ["WR"], w: { speed: 1, deepRouteRunning: 2 },
    icon: "flame", color: "#e5532d", demo: "deep_pass", role: "wr", fx: "GONE!",
    a: [1, 2, 3], desc: "Reaches top speed instantly on a vertical route. The corner loses {a} step(s)." });
  def({ id: "seal_edge", name: "Seal the Edge", kind: "A", cost: 1, g: ["TE"], w: { runBlock: 2, impactBlocking: 1 },
    icon: "wall", color: "#a88f3a", demo: "block_pancake", role: "ol", fx: "SEALED!",
    a: [1, 1.5, 2], desc: "Pins the edge defender inside for {a} sec, so outside runs break free." });
  def({ id: "return_man", name: "Return Man", kind: "A", cost: 1, g: ["WR", "RB", "DB"], w: { kickReturn: 3, speed: 1 },
    icon: "football", color: "#e0a019", demo: "return", role: "kr", fx: "TO THE HOUSE",
    a: [3, 5, 8], desc: "On the next return, blockers hold {a}% longer and the first tackler always misses." });

  // OL
  def({ id: "anchor", name: "Anchor", kind: "P", g: ["OL"], w: { passBlockPower: 2, strength: 1 },
    icon: "wall", color: "#7a6a52", demo: "pass_pro", role: "ol", fx: "ANCHORED",
    a: [25, 40, 60], desc: "Bull rushes against him lose {a}% of their push." });
  def({ id: "mirror", name: "Mirror Feet", kind: "P", g: ["OL"], w: { passBlockFinesse: 2, agility: 1 },
    icon: "shield", color: "#5c6bd6", demo: "pass_pro", role: "ol", fx: "MIRROR",
    a: [20, 35, 50], desc: "Swim, spin and speed moves against him take {a}% longer to finish." });
  def({ id: "road_grader", name: "Road Grader", kind: "P", g: ["OL"], w: { runBlockPower: 2, impactBlocking: 1 },
    icon: "hammer", color: "#b0482c", demo: "block_pancake", role: "ol", fx: "PUSH",
    a: [1, 2, 3], desc: "Run blocks drive defenders back +{a} yds, so holes open wider." });
  def({ id: "pancake", name: "Pancake", kind: "A", cost: 1, g: ["OL", "TE"], w: { runBlock: 1, impactBlocking: 2, strength: 1 },
    icon: "hammer", color: "#e0a019", demo: "block_pancake", role: "ol", fx: "PANCAKE!",
    a: [1, 1.5, 2], desc: "The next block flattens the defender, who stays down for {a} sec." });
  def({ id: "brick_wall", name: "Brick Wall", kind: "A", cost: 2, g: ["OL"], w: { passBlock: 2, awareness: 1 },
    icon: "wall", color: "#d6455b", demo: "pass_pro", role: "ol", fx: "BRICK WALL!",
    a: [2, 3, 4], desc: "His side of the pocket can't be beaten for {a} sec, by any rush move." });
  def({ id: "pull_lead", name: "Pull & Kick", kind: "A", cost: 1, g: ["OL"], w: { runBlockFinesse: 2, speed: 1, agility: 1 },
    icon: "arrow", color: "#2aa889", demo: "block_pancake", role: "ol", fx: "PULL!",
    a: [10, 20, 30], desc: "Pulls on the next run at +{a}% speed and kicks out the edge defender." });

  // DL
  def({ id: "relentless", name: "Relentless", kind: "P", g: ["DL", "LB"], w: { pursuit: 2, stamina: 1 },
    icon: "flame", color: "#e5532d", demo: "sack", role: "dl", fx: "RELENTLESS",
    a: [10, 20, 30], desc: "Never stops on a play: second-effort pass rush moves are {a}% faster." });
  def({ id: "run_plug", name: "Run Plug", kind: "P", g: ["DL"], w: { blockShedding: 2, strength: 1 },
    icon: "wall", color: "#7a6a52", demo: "tackle_hit", role: "lb", fx: "PLUGGED",
    a: [15, 25, 35], desc: "Sheds blocks {a}% faster on run plays." });
  def({ id: "bull_rush", name: "Bull Rush", kind: "A", cost: 1, g: ["DL", "LB"], w: { powerMoves: 2, strength: 1 },
    icon: "fist", color: "#b0482c", demo: "sack", role: "dl", fx: "BULL RUSH!",
    a: [2, 3, 4], desc: "Drives the blocker {a} yds straight back into the QB's lap." });
  def({ id: "swim", name: "Swim Move", kind: "A", cost: 1, g: ["DL", "LB"], w: { finesseMoves: 2, agility: 1 },
    icon: "wave", color: "#3fa7d6", demo: "sack", role: "dl", fx: "SWIM!",
    a: [0.3, 0.5, 0.7], desc: "Swims past the blocker {a} sec faster than any normal move." });
  def({ id: "strip_sack", name: "Strip Sack", kind: "A", cost: 2, g: ["DL", "LB"], w: { hitPower: 1, powerMoves: 1, finesseMoves: 1 },
    icon: "football", color: "#d63c3c", demo: "sack", role: "dl", mod: "fumble", fx: "STRIP SACK!",
    a: [50, 70, 90], desc: "The next sack knocks the ball loose ({a}% chance)." });

  // LB
  def({ id: "radar", name: "Field Radar", kind: "P", g: ["LB", "DB"], w: { playRecognition: 2, awareness: 1 },
    icon: "target", color: "#8a5cd6", demo: "tackle_hit", role: "lb", fx: "READ IT",
    a: [0.2, 0.35, 0.5], desc: "Reads run or pass {a} sec sooner than anyone else on defense." });
  def({ id: "sure_tackler", name: "Sure Tackler", kind: "P", g: ["LB", "DB", "DL"], w: { tackle: 3 },
    icon: "lock", color: "#2f9e44", demo: "tackle_hit", role: "lb", fx: "WRAPPED",
    a: [25, 40, 60], desc: "Ball carriers break his tackles {a}% less often." });
  def({ id: "blitz", name: "A-Gap Blitz", kind: "A", cost: 1, g: ["LB"], w: { speed: 1, powerMoves: 1, finesseMoves: 1 },
    icon: "bolt", color: "#e0a019", demo: "sack", role: "dl", fx: "BLITZ!",
    a: [0.5, 0.8, 1], desc: "Times the snap and shoots the gap unblocked for {a} sec." });
  def({ id: "lights_out", name: "Lights Out", kind: "A", cost: 2, g: ["LB", "DB"], w: { hitPower: 2, strength: 1 },
    icon: "star", color: "#d63c3c", demo: "tackle_hit", role: "lb", mod: "fumble", fx: "LIGHTS OUT!",
    a: [40, 60, 80], desc: "The next tackle is a knockout hit with a {a}% chance to force a fumble." });
  def({ id: "zone_drop", name: "Zone Drop", kind: "A", cost: 1, g: ["LB"], w: { zoneCoverage: 2, playRecognition: 1 },
    icon: "eye", color: "#3d7be0", demo: "interception", role: "db", fx: "BAITED!",
    a: [10, 20, 30], desc: "Pretends to blitz, then drops into the passing lane. {a}% pick chance on throws over the middle." });

  // DB
  def({ id: "ball_hawk", name: "Ball Hawk", kind: "P", g: ["DB"], w: { catching: 1, zoneCoverage: 2 },
    icon: "magnet", color: "#d63c3c", demo: "interception", role: "db", fx: "HAWK",
    a: [10, 20, 30], desc: "+{a}% interception chance on any contested throw." });
  def({ id: "shadow", name: "Shadow", kind: "P", g: ["DB"], w: { manCoverage: 2, speed: 1 },
    icon: "eye", color: "#2d2d38", demo: "lockdown", role: "db", fx: "SHADOW",
    a: [1.5, 1, 0.5], desc: "In man coverage he never trails his receiver by more than {a} yds." });
  def({ id: "closing_speed", name: "Closing Speed", kind: "P", g: ["DB", "LB"], w: { speed: 1, pursuit: 2 },
    icon: "wind", color: "#2aa889", demo: "tackle_hit", role: "lb", fx: "CLOSING",
    a: [1, 2, 3], desc: "Takes perfect pursuit angles and gains +{a} Speed when closing on the ball." });
  def({ id: "lockdown", name: "Lockdown", kind: "A", cost: 2, g: ["DB"], w: { manCoverage: 2, press: 1 },
    icon: "lock", color: "#5c6bd6", demo: "lockdown", role: "db", fx: "LOCKDOWN!",
    a: [80, 90, 99], desc: "Erases his receiver for the play. {a}% of throws his way are broken up." });
  def({ id: "pick_six", name: "Pick Six", kind: "A", cost: 2, g: ["DB"], w: { zoneCoverage: 1, catching: 1, speed: 1 },
    icon: "magnet", color: "#e0a019", demo: "interception", role: "db", fx: "PICK!",
    a: [10, 20, 30], desc: "Jumps the route on the next throw his way, and gets +{a}% speed on the return." });
  def({ id: "jam", name: "Jam", kind: "A", cost: 1, g: ["DB"], w: { press: 2, strength: 1 },
    icon: "fist", color: "#b0482c", demo: "lockdown", role: "db", fx: "JAMMED!",
    a: [0.5, 0.8, 1.1], desc: "Reroutes the receiver at the line, throwing off his route timing by {a} sec." });
  def({ id: "missile", name: "Heat Seeker", kind: "A", cost: 1, g: ["DB"], w: { hitPower: 1, speed: 1, pursuit: 1 },
    icon: "bolt", color: "#e5532d", demo: "lockdown", role: "db", fx: "BOOM!",
    a: [20, 35, 50], desc: "Arrives with the ball: +{a}% chance to jar it loose on a catch in front of him." });

  // K / P / LS
  def({ id: "ice_veins", name: "Ice Veins", kind: "P", g: ["ST"], pos: ["K", "P"], w: { kickAccuracy: 2, awareness: 1 },
    icon: "snow", color: "#3fa7d6", demo: "kick", role: "k", fx: "ICE",
    a: [50, 75, 100], desc: "Ignores {a}% of the clutch-pressure penalty on game-winning kicks." });
  def({ id: "big_leg", name: "Big Leg", kind: "P", g: ["ST"], pos: ["K", "P"], w: { kickPower: 3 },
    icon: "boot", color: "#b0482c", demo: "kick", role: "k", fx: "BOOM",
    a: [3, 5, 8], desc: "Max kick distance +{a} yds." });
  def({ id: "laser_leg", name: "Laser Leg", kind: "A", cost: 1, g: ["ST"], pos: ["K"], w: { kickPower: 1, kickAccuracy: 2 },
    icon: "target", color: "#e0a019", demo: "kick", role: "k", fx: "SPLIT 'EM!",
    a: [20, 35, 50], desc: "The kick meter slows by {a}% for the next field goal or extra point." });
  def({ id: "coffin_corner", name: "Coffin Corner", kind: "A", cost: 1, g: ["ST"], pos: ["P"], w: { kickAccuracy: 3 },
    icon: "target", color: "#5c6bd6", demo: "punt", role: "k", fx: "PINNED!",
    a: [10, 5, 2], desc: "The next punt dies inside the {a}-yard line." });
  def({ id: "hang_time", name: "Hang Time", kind: "A", cost: 1, g: ["ST"], pos: ["P"], w: { kickPower: 3 },
    icon: "arrow", color: "#2aa889", demo: "punt", role: "k", fx: "HANG TIME",
    a: [0.5, 0.8, 1.2], desc: "+{a} sec of hang time on the next punt. The returner has to fair catch." });
  def({ id: "perfect_snap", name: "Perfect Snap", kind: "P", g: ["ST"], pos: ["LS"], w: { awareness: 2, strength: 1 },
    icon: "football", color: "#7a6a52", demo: "kick", role: "ls", fx: "PERFECT",
    a: [90, 95, 99], desc: "{a}% of his snaps land laces-out, so the kicker loses no accuracy." });
  def({ id: "gunner", name: "Gunner", kind: "A", cost: 1, g: ["ST", "DB", "WR"], pos: ["LS", "CB", "FS", "SS", "WR"], w: { speed: 2, tackle: 1 },
    icon: "flame", color: "#d63c3c", demo: "punt", role: "gunner", fx: "DOWNED!",
    a: [10, 20, 30], desc: "Beats the double team on the next punt and downs the ball {a}% faster." });

  // ------------------------------------------------------------------ signatures (OVR 88+)
  const SIG = {
    QB: { nouns: ["Airstrike", "Showtime", "Two-Minute Drill", "Hail Mary", "Air Raid"], demo: "deep_pass", role: "qb",
      special: "every receiver gets +3 yds of separation" },
    RB: { nouns: ["Stampede", "Express", "Avalanche", "Juggernaut", "Highlight Reel"], demo: "speed_burst", role: "rb",
      special: "the first two tackle attempts automatically miss" },
    WR: { nouns: ["Spotlight", "Mossed", "Supernova", "Burn Notice", "Showcase"], demo: "catch_contested", role: "wr",
      special: "any ball within reach is an automatic catch" },
    TE: { nouns: ["Mismatch", "Seam Buster", "Monster Truck", "Red Zone Rex"], demo: "catch_contested", role: "wr",
      special: "always wins jump balls over defenders under 6'2\"" },
    OL: { nouns: ["Fortress", "Iron Curtain", "Bulldozer", "Great Wall"], demo: "pass_pro", role: "ol",
      special: "the whole offensive line becomes a Brick Wall" },
    DL: { nouns: ["Wrecking Ball", "Sack Attack", "Earthquake", "Havoc"], demo: "sack", role: "dl", mod: "fumble",
      special: "reaches the QB in 2.5 sec no matter who blocks him" },
    LB: { nouns: ["Thunderclap", "Headhunter", "Command Center", "Guillotine"], demo: "tackle_hit", role: "lb", mod: "fumble",
      special: "always knows who has the ball" },
    DB: { nouns: ["No Fly Zone", "Island", "Interceptor", "Blackout"], demo: "interception", role: "db",
      special: "any throw into his zone has a 50% pick chance" },
    ST: { nouns: ["Money Leg", "Automatic", "Golden Boot"], demo: "kick", role: "k",
      special: "the next kick up to 65 yds is automatically good" },
  };

  // ------------------------------------------------------------------ assignment
  const val = (p, k) => { const v = p.stats[k]; return Array.isArray(v) ? v[0] : (v ?? 0); };
  function score(p, w) {
    let s = 0, t = 0;
    for (const k in w) { s += val(p, k) * w[k]; t += w[k]; }
    return s / t;
  }
  const tierOf = (s) => (s >= 89 ? 3 : s >= 78 ? 2 : 1);
  const ROMAN = ["", "I", "II", "III"];
  function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); return (n ^ (n >>> 15)) >>> 0; }
  const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace(/\.0$/, ""));

  function instance(a, p, s) {
    const tier = tierOf(s);
    const v = a.a[tier - 1];
    return {
      ...a, tier, score: Math.round(s), label: `${a.name} ${ROMAN[tier]}`,
      text: a.desc.replace("{a}", fmt(v)),
      light: shade(a.color, 0.45), dark: shade(a.color, -0.35),
    };
  }

  function signature(p) {
    const sg = SIG[p.group];
    if (!sg || p.ovr < 88) return null;
    // the two best stats among the player's focus weights
    const keys = Object.keys(p.stats).filter((k) => !["stamina", "injury", "toughness", "overall"].includes(k));
    const relevant = new Set(LIB.filter((a) => a.g.includes(p.group) && (!a.pos || a.pos.includes(p.pos)))
      .flatMap((a) => Object.keys(a.w)));
    const best = keys.filter((k) => relevant.has(k)).sort((a, b) => val(p, b) - val(p, a)).slice(0, 2);
    const boost = 3 + Math.floor((p.ovr - 88) / 3);
    const noun = sg.nouns[hash(p.id) % sg.nouns.length];
    return {
      id: "sig_" + p.id, kind: "S", cost: 3, tier: 3, icon: "crown", color: "#e0a019",
      light: "#fff1a8", dark: "#8a5a00", demo: sg.demo, role: sg.role, mod: sg.mod,
      name: `${p.last} ${noun}`, label: `${p.last} ${noun}`, fx: noun.toUpperCase() + "!",
      text: `Signature move. For the rest of the play: +${boost} ${LONG[best[0]]}, +${boost} ${LONG[best[1]]}, and ${sg.special}.`,
    };
  }

  // Abilities are picked by what a player is good at *relative to his position*
  // (z-score vs. everyone at the same position), so not every RB ends up a "Workhorse".
  // Tier (I/II/III) still comes from the absolute rating.
  const norms = new Map(); // pos|abilityId -> [mean, sd]
  function norm(pos, a) {
    const k = pos + "|" + a.id;
    if (!norms.has(k)) {
      const ps = (window.DEX_DATA ? window.DEX_DATA.players : []).filter((q) => q.pos === pos);
      const xs = ps.map((q) => score(q, a.w));
      const m = xs.reduce((x, y) => x + y, 0) / Math.max(1, xs.length);
      const sd = Math.sqrt(xs.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, xs.length)) || 1;
      norms.set(k, [m, Math.max(sd, 3)]);
    }
    return norms.get(k);
  }

  const memo = new Map();
  /** -> { passive, actives: [..], signature|null } */
  function forPlayer(p) {
    if (memo.has(p.id)) return memo.get(p.id);
    const pool = LIB.filter((a) => a.g.includes(p.group) && (!a.pos || a.pos.includes(p.pos)))
      .map((a) => { const s = score(p, a.w), [m, sd] = norm(p.pos, a); return { a, s, z: (s - m) / sd + s / 400 }; })
      .sort((x, y) => y.z - x.z);
    const passives = pool.filter((x) => x.a.kind === "P");
    const actives = pool.filter((x) => x.a.kind === "A");
    const out = {
      passive: passives.length ? instance(passives[0].a, p, passives[0].s) : null,
      actives: [],
      signature: signature(p),
    };
    if (actives[0]) out.actives.push(instance(actives[0].a, p, actives[0].s));
    if (actives[1] && p.ovr >= 72 && actives[1].s >= 70 && actives[1].z > 0) out.actives.push(instance(actives[1].a, p, actives[1].s));
    memo.set(p.id, out);
    return out;
  }
  const list = (p) => { const r = forPlayer(p); return [r.signature, r.passive, ...r.actives].filter(Boolean); };

  // ------------------------------------------------------------------ badge drawing
  // Badge = 20x20 logical px. Passive: rounded square. Active: hexagon. Signature: gold starburst.
  function drawBadge(ctx, ab, x, y, s) {
    const pal = { k: "#14141c", 1: ab.dark, 2: ab.color, 3: shade(ab.color, -0.55), f: ab.light, g: "#ffffff" };
    const px = (cx, cy, c) => { ctx.fillStyle = c; ctx.fillRect(x + cx * s, y + cy * s, s, s); };
    const N = 20;
    // body
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const dx = c - 9.5, dy = r - 9.5;
      let inside, edge;
      if (ab.kind === "P") {         // rounded square
        const m = Math.max(Math.abs(dx), Math.abs(dy)), corner = Math.abs(dx) + Math.abs(dy);
        inside = m <= 9.5 && corner <= 16.5; edge = m > 8.5 || corner > 15.5;
      } else if (ab.kind === "A") {  // hexagon
        const ax = Math.abs(dx), ay = Math.abs(dy);
        inside = ay <= 9.5 && ax <= 9.5 && ax * 0.55 + ay <= 11; edge = ay > 8.5 || ax > 8.5 || ax * 0.55 + ay > 10;
      } else {                       // starburst circle
        const ang = Math.atan2(dy, dx), rad = Math.hypot(dx, dy), lim = 8.6 + Math.cos(ang * 8) * 1.2;
        inside = rad <= lim; edge = rad > lim - 1.1;
      }
      if (!inside) continue;
      let col = edge ? pal.k : (r < 9 ? pal.f : r < 15 ? pal[2] : pal[1]);
      if (!edge && ab.kind === "S" && (r + c) % 7 === 0 && r < 9) col = "#ffffff";
      px(c, r, col);
    }
    // icon (12x12) centered
    const icon = ICONS[ab.icon] || ICONS.star;
    const ipal = { k: "#14141c", 1: ab.kind === "S" ? "#fff6d0" : "#ffffff", 2: ab.light, 3: ab.dark };
    const oy = 4 + Math.floor((12 - icon.length) / 2);
    for (let r = 0; r < icon.length; r++) for (let c = 0; c < Math.min(12, icon[r].length); c++) {
      const ch = icon[r][c];
      if (ch === ".") continue;
      px(4 + c, oy + r, ipal[ch]);
    }
  }
  function badgeCanvas(ab, s = 3) {
    const c = document.createElement("canvas");
    c.width = c.height = 20 * s;
    drawBadge(c.getContext("2d"), ab, 0, 0, s);
    return c;
  }

  window.Abilities = { forPlayer, list, badgeCanvas, drawBadge, ICONS, LONG, LIB, KIND: { P: "PASSIVE", A: "ACTIVE", S: "SIGNATURE" } };
})();
