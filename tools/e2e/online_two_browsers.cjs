// Two-browser online check (spec §15: "two browsers complete an online draft and play the first drive").
// Needs the game server and the dev client running:
//   pnpm start:server &   pnpm dev:client &
//   node tools/e2e/online_two_browsers.cjs [plays=8] [outDir=/tmp]      (RELOAD_AT=3 reloads browser B after play 3)
// Uses the pre-installed Playwright. Prints every play result as both browsers saw it; exits 1 on a mismatch.
const { chromium } = require("playwright");
const PLAYS = Number(process.argv[2] || 8);
const OUT = process.argv[3] || "/tmp";
const URL = process.env.URL || "http://localhost:5173/";
(async () => {
  const b = await chromium.launch();
  const mk = async (name) => {
    const ctx = await b.newContext({ viewport: { width: 420, height: 860 } });
    const p = await ctx.newPage();
    p.errs = [];
    p.on("pageerror", (e) => p.errs.push(String(e)));
    p.on("console", (m) => { if (m.type() === "error" || m.text().includes("desync")) p.errs.push(m.text()); });
    await p.goto(URL);
    await p.click("button.play.online");
    await p.waitForSelector("text=QUICK MATCH");
    await p.fill(".teamsetup input.search", name);
    return p;
  };
  const A = await mk("Alpha"), B = await mk("Bravo");
  const c = (p, sel) => p.click(sel, { timeout: 800 }).catch(() => {});
  await c(A, 'button.play:has-text("QUICK MATCH")');
  await c(B, 'button.play:has-text("QUICK MATCH")');
  await A.waitForSelector(".draft", { timeout: 15000 });
  await B.waitForSelector(".draft", { timeout: 15000 });
  // the draft: first offer, best fit, every round; dismiss the reveals
  const draftStep = async (p) => {
    if (await p.locator(".postdraft").count()) return true;
    const next = p.locator(".overlay.reveal button.big");
    if (await next.count()) { await next.click({ timeout: 800 }).catch(() => {}); return false; }
    const first = await p.locator(".tabs button.chip").first().innerText({ timeout: 500 }).catch(() => "");
    if (first.includes("WAITING")) return false;
    await p.locator(".offers .card").first().click({ timeout: 800 }).catch(() => {});
    await c(p, '.tabs button.chip:has-text("DRAFT")');
    return false;
  };
  let t0 = Date.now();
  while (!(await draftStep(A)) | !(await draftStep(B))) {
    if (Date.now() - t0 > 240000) throw new Error("draft timed out");
    await A.waitForTimeout(100);
  }
  console.log(`draft done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await A.screenshot({ path: `${OUT}/online_a_postdraft.png` });
  await c(A, 'button.big:has-text("KICK OFF")');
  await c(B, 'button.big:has-text("KICK OFF")');
  await A.waitForSelector(".game", { timeout: 20000 });
  await B.waitForSelector(".game", { timeout: 20000 });
  const swipe = async (p, y0, y1) => {
    const bb = await p.locator(".stage").boundingBox();
    await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height * y0); await p.mouse.down();
    await p.mouse.move(bb.x + bb.width / 2 + 10, bb.y + bb.height * y1, { steps: 6 }); await p.mouse.up();
  };
  const gameStep = async (p) => {
    const txt = await p.locator(".bottom").innerText({ timeout: 500 }).catch(() => "");
    if (txt.includes("SNAP ▶")) return c(p, 'button.big:has-text("SNAP")');
    if (txt.includes("Deep kick")) return c(p, 'button.play:has-text("Deep kick")');
    if (txt.includes("Return middle")) return c(p, 'button.play:has-text("Return middle")');
    if (txt.includes("Extra point")) return c(p, 'button.play:has-text("Extra point")');
    if (txt.includes("FLICK UP")) return swipe(p, 0.85, 0.3);
    if (txt.includes("PULL BACK")) return swipe(p, 0.55, 0.75); // pull down = throw up the field
    const play = p.locator(".bottom .plays button.play");
    if (await play.count()) return play.first().click({ timeout: 800 }).catch(() => {});
  };
  const toast = async (p) => ((await p.locator(".toast").count()) ? p.locator(".toast").innerText({ timeout: 500 }).catch(() => "") : "");
  let results = 0, last = "", bad = 0;
  t0 = Date.now();
  while (results < PLAYS && Date.now() - t0 < 300000) {
    await Promise.all([gameStep(A), gameStep(B)]);
    const ta = await toast(A), tb = await toast(B);
    if (ta && ta !== last) {
      last = ta; results++;
      // the play result is the same for both (each sees the other side's call after it)
      if (ta.split(" · ").slice(0, -1).join() !== tb.split(" · ").slice(0, -1).join() && tb) bad++;
      console.log(`A: ${ta}\nB: ${tb}`);
      if (results === Number(process.env.RELOAD_AT || 0)) {
        await B.reload();
        await B.waitForSelector(".game", { timeout: 20000 });
        console.log("--- B reloaded and rejoined");
      }
    }
    await A.waitForTimeout(150);
  }
  const bug = (p) => p.evaluate(() => document.querySelector(".bug")?.innerText.replace(/\s+/g, " "));
  const [ba, bb] = [await bug(A), await bug(B)];
  console.log(`A: ${ba}\nB: ${bb}`);
  await A.screenshot({ path: `${OUT}/online_a_end.png` }); await B.screenshot({ path: `${OUT}/online_b_end.png` });
  const errs = [...A.errs, ...B.errs].filter((e) => !e.includes("GL Driver"));
  if (errs.length) console.log("errors:", errs.slice(0, 5));
  await b.close();
  if (ba !== bb || bad || errs.length || results < PLAYS) { console.log("FAILED"); process.exit(1); }
  console.log(`OK: ${results} plays in lockstep`);
})().catch((e) => { console.error(e); process.exit(1); });
