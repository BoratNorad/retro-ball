// Gridiron Dex - Pokédex-style browser for Madden ratings with 16-bit pixel-art nflverse headshots,
// position depth charts and an original passive/active ability system with demo plays.
(function () {
  const D = window.DEX_DATA;
  const $ = (s, el = document) => el.querySelector(s);
  const byId = new Map(D.players.map((p) => [p.id, p]));
  const teamList = Object.values(D.teams).sort((a, b) => a.name.localeCompare(b.name));
  const LONG = Abilities.LONG;

  // Pokémon-style "types" per position family
  const TYPES = {
    QB: ["PASSER", "#e8742a"], RB: ["RUSHER", "#5ba446"], WR: ["RECEIVER", "#4f7ee8"],
    TE: ["HYBRID", "#98a41c"], OL: ["WALL", "#a88f3a"], DL: ["RUSH", "#c0352b"],
    LB: ["HUNTER", "#7a56a8"], DB: ["COVER", "#e0507e"], ST: ["BOOT", "#8f8f7a"],
  };
  const SIDE = { O: ["OFFENSE", "#2f5fb8"], D: ["DEFENSE", "#2d2d38"], S: ["SPECIAL", "#6c7a3a"] };

  // which stat groups matter most per position family (shown first, others collapsible)
  const FOCUS = {
    QB: ["Passing", "Physical", "Rushing"], RB: ["Rushing", "Physical", "Receiving"],
    WR: ["Receiving", "Physical", "Rushing"], TE: ["Receiving", "Blocking", "Physical"],
    OL: ["Blocking", "Physical"], DL: ["Defense", "Physical"], LB: ["Defense", "Physical"],
    DB: ["Defense", "Physical", "Receiving"], ST: ["Kicking", "Physical"],
  };
  // six "base stats" per family for the radar (Pokémon-style hexagon)
  const RADAR = {
    QB: [["ARM", ["throwPower"]], ["ACCURACY", ["throwAccuracyShort", "throwAccuracyMid", "throwAccuracyDeep"]],
      ["POCKET", ["throwUnderPressure", "breakSack"]], ["MOBILITY", ["speed", "throwOnTheRun"]],
      ["IQ", ["awareness", "playAction"]], ["BODY", ["strength", "toughness", "injury"]]],
    RB: [["SPEED", ["speed", "acceleration"]], ["ELUSIVE", ["jukeMove", "spinMove", "agility", "changeOfDirection"]],
      ["POWER", ["trucking", "stiffArm", "breakTackle", "strength"]], ["HANDS", ["catching", "carrying"]],
      ["VISION", ["bCVision", "awareness"]], ["BODY", ["stamina", "toughness", "injury"]]],
    WR: [["SPEED", ["speed", "acceleration"]], ["HANDS", ["catching", "catchInTraffic", "spectacularCatch"]],
      ["ROUTES", ["shortRouteRunning", "mediumRouteRunning", "deepRouteRunning"]], ["RELEASE", ["release", "agility"]],
      ["YAC", ["breakTackle", "jukeMove", "bCVision"]], ["JUMP", ["jumping"]]],
    TE: [["SPEED", ["speed", "acceleration"]], ["HANDS", ["catching", "catchInTraffic", "spectacularCatch"]],
      ["ROUTES", ["shortRouteRunning", "mediumRouteRunning", "deepRouteRunning"]], ["BLOCK", ["runBlock", "passBlock", "impactBlocking"]],
      ["POWER", ["strength", "trucking", "breakTackle"]], ["IQ", ["awareness"]]],
    OL: [["PASS PRO", ["passBlock", "passBlockPower", "passBlockFinesse"]], ["RUN BLK", ["runBlock", "runBlockPower", "runBlockFinesse"]],
      ["POWER", ["strength", "impactBlocking"]], ["FEET", ["agility", "acceleration"]], ["IQ", ["awareness"]],
      ["BODY", ["stamina", "toughness", "injury"]]],
    DL: [["POWER", ["powerMoves", "strength"]], ["FINESSE", ["finesseMoves", "agility"]], ["SHED", ["blockShedding"]],
      ["BURST", ["speed", "acceleration"]], ["TACKLE", ["tackle", "hitPower", "pursuit"]], ["IQ", ["playRecognition", "awareness"]]],
    LB: [["TACKLE", ["tackle", "hitPower"]], ["PURSUIT", ["pursuit", "speed"]], ["RUSH", ["powerMoves", "finesseMoves", "blockShedding"]],
      ["COVER", ["zoneCoverage", "manCoverage"]], ["IQ", ["playRecognition", "awareness"]], ["BODY", ["strength", "stamina", "toughness"]]],
    DB: [["MAN", ["manCoverage", "press"]], ["ZONE", ["zoneCoverage"]], ["SPEED", ["speed", "acceleration", "agility"]],
      ["HANDS", ["catching", "jumping"]], ["HIT", ["tackle", "hitPower", "pursuit"]], ["IQ", ["playRecognition", "awareness"]]],
    ST: [["POWER", ["kickPower"]], ["ACCURACY", ["kickAccuracy"]], ["IQ", ["awareness"]], ["SPEED", ["speed", "acceleration"]],
      ["STRENGTH", ["strength"]], ["BODY", ["stamina", "toughness", "injury"]]],
  };
  const POS_ORDER = ["QB", "HB", "FB", "WR", "TE", "LT", "LG", "C", "RG", "RT", "LEDG", "DT", "REDG",
    "SAM", "MIKE", "WILL", "CB", "FS", "SS", "K", "P", "LS"];
  const POS_NAME = Object.fromEntries(D.players.map((p) => [p.pos, p.posName]));

  // league-wide rank at each position
  const posRank = new Map();
  const posCount = {};
  for (const pos of POS_ORDER) {
    const ps = D.players.filter((p) => p.pos === pos).sort((a, b) => b.ovr - a.ovr);
    posCount[pos] = ps.length;
    ps.forEach((p, i) => posRank.set(p.id, i + 1));
  }

  const state = { team: "BUF", view: "dex", q: "", pos: "", sort: "ovr", startersOnly: false, sel: null, showAll: false, madden: false };
  try {
    const saved = JSON.parse(localStorage.getItem("gridiron-dex") || "{}");
    if (saved.view === "field") saved.view = "depth";
    Object.assign(state, saved);
  } catch (e) { /* ignore */ }
  const save = () => {
    try {
      const { team, view, pos, sort, startersOnly, sel } = state;
      localStorage.setItem("gridiron-dex", JSON.stringify({ team, view, pos, sort, startersOnly, sel }));
    } catch (e) { /* ignore */ }
  };

  const val = (p, k) => { const v = p.stats[k]; return Array.isArray(v) ? v[0] : v; };
  const diff = (p, k) => { const v = p.stats[k]; return Array.isArray(v) ? v[1] : 0; };
  const pad = (n) => String(n).padStart(4, "0");
  const teamOf = (p) => D.teams[p.team] || { c1: "#555", c2: "#aaa", c3: "#999", name: p.team, abbr: p.team, nick: p.team };
  const isNarrow = () => window.matchMedia("(max-width: 860px)").matches;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function tierColor(v) {
    if (v >= 90) return "#5a3fd1";
    if (v >= 80) return "#2f9e44";
    if (v >= 70) return "#9a9d10";
    if (v >= 60) return "#e8892a";
    return "#d13b3b";
  }

  // ---------------------------------------------------------------- team bar
  function renderTeams() {
    const nav = $("#teams");
    nav.innerHTML = "";
    const all = document.createElement("button");
    all.className = "team-chip all" + (state.team === "ALL" ? " active" : "");
    all.textContent = "ALL";
    all.onclick = () => selectTeam("ALL");
    nav.append(all);
    for (const t of teamList) {
      const b = document.createElement("button");
      b.className = "team-chip" + (state.team === t.abbr ? " active" : "");
      b.title = t.name;
      b.append(Sprites.helmetCanvas(t, 3), document.createTextNode(t.abbr));
      b.onclick = () => selectTeam(t.abbr);
      nav.append(b);
    }
    const act = nav.querySelector(".active");
    if (act) act.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function selectTeam(abbr) {
    state.team = abbr;
    state.sel = null;
    renderTeams();
    render();
  }

  // ---------------------------------------------------------------- lazy portraits
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const c = e.target;
      io.unobserve(c);
      const p = byId.get(+c.dataset.id);
      Portrait.paint(c, p, teamOf(p));
    }
  }, { root: null, rootMargin: "200px" });

  function thumb(p) {
    const c = document.createElement("canvas");
    c.width = c.height = Portrait.SIZE;
    c.dataset.id = p.id;
    c.className = "th";
    c.style.background = teamOf(p).c1;
    io.observe(c);
    return c;
  }

  function miniBadges(p, s = 1) {
    const wrap = document.createElement("span");
    wrap.className = "mini-badges";
    for (const ab of Abilities.list(p)) {
      const c = Abilities.badgeCanvas(ab, s);
      c.title = `${ab.label} (${Abilities.KIND[ab.kind]})`;
      c.onclick = (e) => { e.stopPropagation(); openAbility(ab, p); };
      wrap.append(c);
    }
    return wrap;
  }

  // ---------------------------------------------------------------- list
  function filtered() {
    let ps = D.players;
    if (state.team !== "ALL") ps = ps.filter((p) => p.team === state.team);
    if (state.pos) ps = ps.filter((p) => p.pos === state.pos || p.group === state.pos);
    if (state.startersOnly) ps = ps.filter((p) => p.starter);
    if (state.q) {
      const q = state.q.toLowerCase();
      ps = ps.filter((p) => (p.first + " " + p.last).toLowerCase().includes(q));
    }
    const cmp = {
      ovr: (a, b) => b.ovr - a.ovr || a.dex - b.dex,
      dex: (a, b) => a.dex - b.dex,
      num: (a, b) => (a.num ?? 999) - (b.num ?? 999),
      name: (a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first),
      depth: (a, b) => POS_ORDER.indexOf(a.pos) - POS_ORDER.indexOf(b.pos) || a.depth - b.depth,
    }[state.sort];
    return ps.slice().sort(cmp);
  }

  function rowEl(p) {
    const li = document.createElement("li");
    li.className = "dex-row";
    li.dataset.id = p.id;
    li.append(thumb(p));
    li.insertAdjacentHTML("beforeend", `<span class="no">No.${pad(p.dex)}</span>`);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.innerHTML = `${p.starter ? '<span class="star" title="Starter">★</span>' : ""}${esc(p.first[0])}. ${esc(p.last)}<small>${esc(p.pos)}${state.team === "ALL" ? " · " + p.team : ""}</small>`;
    const ov = document.createElement("span");
    ov.className = "ov";
    ov.textContent = p.ovr;
    li.append(nm, ov);
    li.onclick = () => {
      select(p.id, false);
      if (isNarrow()) $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    return li;
  }

  function renderList() {
    const ps = filtered();
    const ol = $("#list");
    ol.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const p of ps) frag.append(rowEl(p));
    ol.append(frag);
    $("#count").textContent = `${ps.length} PLAYER${ps.length === 1 ? "" : "S"} SEEN`;
    if (!ps.some((p) => p.id === state.sel)) state.sel = ps.length ? ps[0].id : null;
    markSel();
    renderDetail();
  }

  function markSel(scroll) {
    for (const li of document.querySelectorAll("#list .dex-row")) {
      const on = +li.dataset.id === state.sel;
      li.classList.toggle("sel", on);
      li.querySelector(".ov").style.color = on ? "#fff" : tierColor(byId.get(+li.dataset.id).ovr);
      if (on && scroll) li.scrollIntoView({ block: "nearest" });
    }
  }

  function select(id, scroll) {
    state.sel = id;
    state.showAll = false;
    markSel(scroll);
    renderDetail();
    save();
  }

  // ---------------------------------------------------------------- detail
  function flavor(p) {
    const groups = FOCUS[p.group] || ["Physical"];
    const keys = D.statGroups.filter(([g]) => groups.includes(g)).flatMap(([, s]) => s.map(([k]) => k))
      .filter((k) => !["stamina", "injury", "toughness"].includes(k));
    const top = keys.map((k) => [k, val(p, k)]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const t = teamOf(p);
    const arch = p.arch ? `${p.arch.toUpperCase()} ` : "";
    const where = p.depth === 1 ? `the ${t.nick || t.name}' No. 1 ${p.pos}` : `${p.pos}${p.depth} on the ${t.nick || t.name} depth chart`;
    const sig = Abilities.forPlayer(p).signature;
    return `The ${arch}${p.posName.toUpperCase()}. ${p.first} ${p.last} is ${where}. ` +
      `Known for ${top.map(([k, v]) => `${LONG[k]} (${v})`).join(", ").replace(/, ([^,]*)$/, " and $1")}.` +
      (sig ? ` Fill the meter and he unleashes ${sig.name.toUpperCase()}.` : "");
  }

  function statBar(v) {
    const segs = 20, on = Math.round(v / 100 * segs), col = tierColor(v);
    let h = "";
    for (let i = 0; i < segs; i++) h += `<span style="background:${i < on ? col : "transparent"}"></span>`;
    return `<div class="bar">${h}</div>`;
  }

  function groupHtml(p, name, stats) {
    const rows = stats.map(([k]) => {
      const v = val(p, k);
      if (v == null) return "";
      const d = diff(p, k);
      const di = d ? `<i class="${d > 0 ? "up" : "dn"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</i>` : "";
      return `<div class="stat"><span class="lbl">${LONG[k] || k}</span>${statBar(v)}<span class="val">${v}${di}</span></div>`;
    }).join("");
    return `<div class="group"><h4>${name.toUpperCase()}</h4>${rows}</div>`;
  }

  function radarValues(p) {
    return (RADAR[p.group] || RADAR.ST).map(([label, keys]) => {
      const vs = keys.map((k) => val(p, k)).filter((v) => v != null);
      return [label, Math.round(vs.reduce((a, b) => a + b, 0) / Math.max(1, vs.length))];
    });
  }

  /** Pixel-style hexagon radar. Logical 120x104, drawn at integer scale. */
  function drawRadar(canvas, p, color) {
    const L = 172, Hh = 124, s = 3;
    canvas.width = L * s; canvas.height = Hh * s;
    const ctx = canvas.getContext("2d");
    const cx = 86, cy = 62, R = 42;
    const vals = radarValues(p);
    const pt = (i, r) => {
      const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    };
    const px = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x) * s, Math.round(y) * s, s, s); };
    const line = (x0, y0, x1, y1, c) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= n; i++) px(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, c);
    };
    const inside = (x, y, poly) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    // rings
    for (const f of [1, 0.75, 0.5, 0.25]) {
      const ring = [0, 1, 2, 3, 4, 5].map((i) => pt(i, R * f));
      if (f === 1) {
        for (let y = 0; y < Hh; y++) for (let x = 0; x < L; x++) if (inside(x + 0.5, y + 0.5, ring)) px(x, y, "#fbfdf3");
      }
      for (let i = 0; i < 6; i++) line(...ring[i], ...ring[(i + 1) % 6], f === 1 ? "#1b1f2a" : "#c9d4ad");
    }
    for (let i = 0; i < 6; i++) line(cx, cy, ...pt(i, R), "#c9d4ad");
    // value polygon (scaled from 40..100 so differences read clearly)
    const poly = vals.map(([, v], i) => pt(i, R * Math.max(0.06, (v - 40) / 60)));
    for (let y = 0; y < Hh; y++) for (let x = 0; x < L; x++) if (inside(x + 0.5, y + 0.5, poly)) {
      ctx.fillStyle = color + ((x + y) % 2 ? "cc" : "99");
      ctx.fillRect(x * s, y * s, s, s);
    }
    for (let i = 0; i < 6; i++) line(...poly[i], ...poly[(i + 1) % 6], "#1b1f2a");
    for (const [x, y] of poly) { ctx.fillStyle = "#1b1f2a"; ctx.fillRect((Math.round(x) - 1) * s, (Math.round(y) - 1) * s, 3 * s, 3 * s); }
    // labels
    ctx.font = `${5 * s / 1.25}px "Press Start 2P", monospace`;
    ctx.textBaseline = "middle";
    vals.forEach(([label, v], i) => {
      const [x, y] = pt(i, R + 9);
      ctx.textAlign = Math.abs(x - cx) < 4 ? "center" : x < cx ? "right" : "left";
      ctx.fillStyle = "#4a5366";
      ctx.fillText(label, x * s, (y - 3) * s);
      ctx.fillStyle = tierColor(v);
      ctx.fillText(String(v), x * s, (y + 3.5) * s);
    });
  }

  function abilityCard(ab, p) {
    const card = document.createElement("button");
    card.className = `ab-card k-${ab.kind}`;
    card.style.setProperty("--ab", ab.color);
    card.style.setProperty("--ab-l", ab.light);
    const badge = Abilities.badgeCanvas(ab, 3);
    badge.className = "ab-badge";
    const pips = ab.kind === "P" ? `<span class="kind">PASSIVE · ALWAYS ON</span>` :
      `<span class="kind">${Abilities.KIND[ab.kind]} · <span class="pips">${[0, 1, 2].map((i) => `<i class="${i < ab.cost ? "on" : ""}"></i>`).join("")}</span> ${ab.cost} BAR${ab.cost > 1 ? "S" : ""}</span>`;
    card.innerHTML = `<div class="ab-text"><b>${esc(ab.label.toUpperCase())}</b>${pips}<p>${esc(ab.text)}</p><span class="watch">▶ SEE IT IN ACTION</span></div>`;
    card.prepend(badge);
    card.onclick = () => openAbility(ab, p);
    return card;
  }

  function renderDetail() {
    const el = $("#detail");
    const p = byId.get(state.sel);
    if (!p) { el.innerHTML = `<div class="empty">NO PLAYER FOUND.<br>TRY ANOTHER SEARCH.</div>`; return; }
    const t = teamOf(p);
    el.style.setProperty("--team1", t.c1);
    el.style.setProperty("--team2", t.c2);
    const [typeName, typeCol] = TYPES[p.group] || TYPES.ST;
    const [sideName, sideCol] = SIDE[p.side];
    const focus = FOCUS[p.group] || [];
    const focusGroups = D.statGroups.filter(([g]) => focus.includes(g)).sort((a, b) => focus.indexOf(a[0]) - focus.indexOf(b[0]));
    const otherGroups = D.statGroups.filter(([g]) => !focus.includes(g));
    const madden = p.abil.map((a) => D.abilities[a]).filter(Boolean);
    const rank = posRank.get(p.id), of = posCount[p.pos];
    const pct = Math.max(1, Math.round((rank / of) * 100));
    const od = p.ovrDiff ? `<i style="font-style:normal;font-size:8px;color:${p.ovrDiff > 0 ? "#1f8a3a" : "#c0262d"}">${p.ovrDiff > 0 ? "▲" : "▼"}${Math.abs(p.ovrDiff)}</i>` : "";
    const radarCol = (TYPES[p.group] || TYPES.ST)[1];

    el.innerHTML = `
      <div class="d-top">
        <div class="portrait"><canvas width="${Portrait.SIZE}" height="${Portrait.SIZE}"></canvas><span class="jersey">#${p.num ?? "--"}</span></div>
        <div class="d-head">
          <div class="ovr-orb"><b style="color:${tierColor(p.ovr)}">${p.ovr}</b><span>OVR ${od}</span></div>
          <div class="no">No.${pad(p.dex)} · ${esc(t.name.toUpperCase())}</div>
          <h2><span class="first">${esc(p.first.toUpperCase())}</span>${esc(p.last.toUpperCase())}</h2>
          <div class="badges">
            <span class="badge" style="background:${typeCol}">${typeName}</span>
            <span class="badge" style="background:${sideCol}">${sideName}</span>
            <span class="badge" style="background:${t.c1}">${p.pos}${p.depth}</span>
            <span class="badge" style="background:#14141c">#${rank} OF ${of} ${p.pos}</span>
          </div>
          <div class="head-badges" id="headBadges"></div>
        </div>
      </div>
      <dl class="info">
        <div><dt>POS</dt><dd>${esc(p.posName)}</dd></div>
        <div><dt>ARCH</dt><dd>${esc(p.arch || "-")}</dd></div>
        <div><dt>HT</dt><dd>${esc(p.ht)}</dd></div>
        <div><dt>WT</dt><dd>${p.wt} lbs</dd></div>
        <div><dt>AGE</dt><dd>${p.age}</dd></div>
        <div><dt>EXP</dt><dd>${p.yrs ? p.yrs + " yrs" : "Rookie"}</dd></div>
        <div><dt>COLLEGE</dt><dd title="${esc(p.college)}">${esc(p.college || "-")}</dd></div>
        <div><dt>DRAFT</dt><dd title="${esc(p.draft)}">${esc(p.draft || "-")}</dd></div>
        <div><dt>HAND</dt><dd>${p.hand === "L" ? "Left" : "Right"}</dd></div>
        <div><dt>BORN</dt><dd>${esc(p.bday)}</dd></div>
      </dl>
      <div class="flavor">${esc(flavor(p))}</div>

      <div class="section-title">BASE STATS</div>
      <div class="base">
        <canvas class="radar" id="radar"></canvas>
        <div class="base-side">
          <div class="rank-box"><b>#${rank}</b><span>OF ${of} ${esc((POS_NAME[p.pos] || p.pos).toUpperCase())}S</span>
            <div class="pct">${pct <= 50 ? `TOP ${pct}%` : `BOTTOM ${101 - pct}%`} IN THE LEAGUE</div></div>
          <div class="base-list">${radarValues(p).map(([l, v]) => `<div class="stat"><span class="lbl">${l}</span>${statBar(v)}<span class="val">${v}</span></div>`).join("")}</div>
        </div>
      </div>

      <div class="section-title">ABILITIES</div>
      <div class="meter-rule">
        <span class="meter-demo"><i class="on"></i><i class="on"></i><i></i></span>
        <span><b>MOMENTUM:</b> big plays (15+ yd gain, sack, takeaway, 3rd-down stop, TD) fill 1 bar, up to 3.
        Actives spend 1-2 bars mid-play. Signatures need a full meter. Passives are always on.</span>
      </div>
      <div class="ab-grid" id="abGrid"></div>

      <div class="section-title">RATINGS</div>
      <div class="groups">${focusGroups.map(([g, s]) => groupHtml(p, g, s)).join("")}</div>
      <div class="groups ${state.showAll ? "" : "hidden"}" id="otherGroups" style="margin-top:10px">${otherGroups.map(([g, s]) => groupHtml(p, g, s)).join("")}</div>
      <button class="more" id="moreBtn">${state.showAll ? "▲ HIDE OTHER RATINGS" : "▼ ALL RATINGS"}</button>

      ${madden.length ? `
      <div class="section-title">MADDEN 27 ABILITIES</div>
      <div class="moves">${madden.map((m) => `
        <div class="move"><header><b>${esc(m.name.toUpperCase())}</b><span class="t ${m.type}">${m.type === "XF" ? "X-FACTOR" : "SUPERSTAR"}</span></header><p>${esc(m.desc)}</p></div>`).join("")}</div>` : ""}
      <div class="none" style="margin-top:10px;font-size:16px">${p.runStyle ? `Running style: ${esc(p.runStyle)} · ` : ""}nflverse: ${esc(p.gsis || "not matched")}${p.espn ? " · ESPN " + p.espn : ""}</div>
    `;
    Portrait.paint($(".portrait canvas", el), p, t);
    drawRadar($("#radar", el), p, radarCol);
    const hb = $("#headBadges", el);
    for (const ab of Abilities.list(p)) {
      const b = document.createElement("button");
      b.className = "hb";
      b.title = ab.label;
      b.append(Abilities.badgeCanvas(ab, 2));
      b.onclick = () => openAbility(ab, p);
      hb.append(b);
    }
    const grid = $("#abGrid", el);
    for (const ab of Abilities.list(p)) grid.append(abilityCard(ab, p));
    $("#moreBtn", el).onclick = () => {
      state.showAll = !state.showAll;
      $("#otherGroups", el).classList.toggle("hidden", !state.showAll);
      $("#moreBtn", el).textContent = state.showAll ? "▲ HIDE OTHER RATINGS" : "▼ ALL RATINGS";
    };
    el.scrollTop = 0;
  }

  // ---------------------------------------------------------------- ability modal + demo play
  let demo = null;
  function pickOpponent(team) {
    // the most visually different team, so heroes and opponents are easy to tell apart
    const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const a = hex(team.c1);
    let best = null, bd = -1;
    for (const t of teamList) {
      if (t.abbr === team.abbr) continue;
      const b = hex(t.c1);
      const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      if (d > bd) { bd = d; best = t; }
    }
    return best;
  }

  function openAbility(ab, p) {
    const t = teamOf(p);
    const opp = pickOpponent(t);
    const m = $("#modal");
    m.classList.remove("hidden");
    m.style.setProperty("--ab", ab.color);
    m.style.setProperty("--ab-l", ab.light);
    const cost = ab.kind === "P" ? `<span class="kind">PASSIVE · ALWAYS ON</span>` :
      `<span class="kind">${Abilities.KIND[ab.kind]} · <span class="pips">${[0, 1, 2].map((i) => `<i class="${i < ab.cost ? "on" : ""}"></i>`).join("")}</span> COSTS ${ab.cost} MOMENTUM BAR${ab.cost > 1 ? "S" : ""}</span>`;
    $("#modalBody").innerHTML = `
      <div class="m-head">
        <span id="mBadge"></span>
        <div>
          <div class="m-who">${esc(p.first.toUpperCase())} ${esc(p.last.toUpperCase())} · ${p.pos} · ${t.abbr}</div>
          <h3>${esc(ab.label.toUpperCase())}</h3>
          ${cost}
          ${ab.kind !== "S" ? `<div class="tier">TIER ${"I".repeat(ab.tier)} · BASED ON HIS RATINGS (${ab.score})</div>` : `<div class="tier">UNIQUE TO ${esc(p.last.toUpperCase())}</div>`}
        </div>
      </div>
      <p class="m-desc">${esc(ab.text)}</p>
      <div class="demo-wrap"><canvas id="demo"></canvas></div>
      <div class="m-foot">
        <span>DEMO PLAY: ${esc(t.abbr)} vs ${esc(opp.abbr)} · ${ab.kind === "P" ? "the glow shows it's always on" : "watch the meter drain when it fires"}</span>
        <button class="more" id="replay">↻ REPLAY</button>
      </div>`;
    $("#mBadge").append(Abilities.badgeCanvas(ab, 4));
    if (demo) demo.stop();
    demo = Plays.mount($("#demo"), { ability: ab, player: p, team: t, opp, scale: 3 });
    $("#replay").onclick = () => demo.replay();
  }
  function closeModal() {
    $("#modal").classList.add("hidden");
    if (demo) { demo.stop(); demo = null; }
  }

  // ---------------------------------------------------------------- depth chart
  function renderDepth() {
    const wrap = $("#depth");
    wrap.innerHTML = "";
    const all = state.team === "ALL";
    const t = D.teams[state.team];
    $("#depthHead").innerHTML = all
      ? `<h2>LEAGUE RANKINGS</h2><span class="unit">TOP 12 AT EACH POSITION</span>`
      : `<canvas width="36" height="27" id="dh"></canvas><h2>${esc(t.name.toUpperCase())}</h2>
         <span class="unit">STARTERS OVR<b>${t.ovr}</b></span><span class="unit">${esc(t.div || "")}</span>`;
    if (!all) Sprites.drawHelmet($("#dh").getContext("2d"), t, 0, 0, 3);
    const sections = [["OFFENSE", POS_ORDER.slice(0, 10)], ["DEFENSE", POS_ORDER.slice(10, 19)], ["SPECIAL TEAMS", POS_ORDER.slice(19)]];
    for (const [title, poss] of sections) {
      const h = document.createElement("div");
      h.className = "section-title";
      h.textContent = title;
      wrap.append(h);
      const grid = document.createElement("div");
      grid.className = "depth-grid";
      for (const pos of poss) {
        let ps = D.players.filter((p) => p.pos === pos && (all || p.team === state.team)).sort((a, b) => b.ovr - a.ovr);
        if (all) ps = ps.slice(0, 12);
        const card = document.createElement("section");
        card.className = "depth-card";
        card.innerHTML = `<header><b>${pos}</b><span>${esc((POS_NAME[pos] || "").toUpperCase())}</span><em>${ps.length}</em></header>`;
        const ol = document.createElement("ol");
        if (!ps.length) ol.innerHTML = `<li class="none">No one listed</li>`;
        ps.forEach((p, i) => {
          const li = document.createElement("li");
          li.className = "depth-row" + (i === 0 ? " first" : "");
          li.innerHTML = `<span class="rk">${i + 1}</span>`;
          li.append(thumb(p));
          li.insertAdjacentHTML("beforeend", `<span class="nm">${esc(p.first[0])}. ${esc(p.last)}${all ? `<small>${p.team}</small>` : ""}</span>`);
          li.append(miniBadges(p, 1));
          li.insertAdjacentHTML("beforeend", `<span class="ov" style="color:${tierColor(p.ovr)}">${p.ovr}</span>`);
          li.onclick = () => openInDex(p.id);
          ol.append(li);
        });
        card.append(ol);
        grid.append(card);
      }
      wrap.append(grid);
    }
  }

  function openInDex(id) {
    const p = byId.get(id);
    state.view = "dex";
    if (state.team !== "ALL" && p.team !== state.team) { state.team = p.team; renderTeams(); }
    state.q = ""; $("#search").value = "";
    state.pos = ""; $("#posFilter").value = "";
    state.startersOnly = false; $("#startersOnly").checked = false;
    state.sel = id;
    render();
    markSel(true);
    window.scrollTo({ top: 0 });
  }

  // ---------------------------------------------------------------- shell
  function render() {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
    $("#view-dex").classList.toggle("hidden", state.view !== "dex");
    $("#view-depth").classList.toggle("hidden", state.view !== "depth");
    if (state.view === "dex") { renderList(); markSel(true); } else renderDepth();
    save();
  }

  function init() {
    $("#source").textContent = `MADDEN 27 · ${String(D.source).toUpperCase()} · ${D.players.length} PLAYERS`;
    const pf = $("#posFilter");
    pf.innerHTML = `<option value="">ALL POS</option>` +
      ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "ST"].map((g) => `<option value="${g}">${g} (group)</option>`).join("") +
      POS_ORDER.map((p) => `<option value="${p}">${p}</option>`).join("");
    if (!["dex", "depth"].includes(state.view)) state.view = "dex";
    if (state.team !== "ALL" && !D.teams[state.team]) state.team = "BUF";
    pf.value = state.pos; $("#sort").value = state.sort; $("#startersOnly").checked = state.startersOnly;

    $("#search").oninput = (e) => { state.q = e.target.value.trim(); renderList(); };
    pf.onchange = (e) => { state.pos = e.target.value; render(); };
    $("#sort").onchange = (e) => { state.sort = e.target.value; render(); };
    $("#startersOnly").onchange = (e) => { state.startersOnly = e.target.checked; render(); };
    document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { state.view = b.dataset.view; render(); }));
    $("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };
    $("#modalClose").onclick = closeModal;

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeModal(); return; }
      if (e.target.matches("input, select") || !$("#modal").classList.contains("hidden")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (state.view !== "dex") return;
        e.preventDefault();
        const ps = filtered();
        const i = ps.findIndex((p) => p.id === state.sel);
        const n = ps[Math.max(0, Math.min(ps.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (n) select(n.id, true);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const order = ["ALL", ...teamList.map((t) => t.abbr)];
        const i = order.indexOf(state.team);
        selectTeam(order[(i + (e.key === "ArrowRight" ? 1 : -1) + order.length) % order.length]);
      }
    });

    // phones: floating "back to list" button once you've scrolled down to a player page
    const back = $("#toList");
    back.onclick = () => $(".list-screen").scrollIntoView({ behavior: "smooth", block: "start" });
    const onScroll = () => {
      const d = $("#detail").getBoundingClientRect();
      back.classList.toggle("show", isNarrow() && state.view === "dex" && d.top < 80);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    renderTeams();
    render();
    if (document.fonts) document.fonts.ready.then(() => { if (state.view === "dex" && state.sel) renderDetail(); });
  }

  init();
})();
