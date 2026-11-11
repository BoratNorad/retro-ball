import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type GameData, type PlayerCard } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import {
  FranchiseData, capSpace, cut, develop, draftChoose, endFreeAgency, expiring, finishWeek, freeAgents, gameRoster, leaders, newFranchise, payroll,
  placeBid, proposeTrade, recordGame, resign, resolveEvent, simGame, standings, startDraft, team, teamPlayers, upgradeFacility, upgradeStaff, userGame, weekGames,
  type Franchise,
} from "../src/franchise.js";

let data: GameData;
let pool: PlayerCard[];
let fd: FranchiseData;
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
  fd = new FranchiseData(data);
});

/** Sim every game of the current week (the user's too) and finish it. */
function simWeek(f: Franchise) {
  for (const g of weekGames(f)) if (!g.score) recordGame(fd, f, g, simGame(fd, f, g), true);
  for (const e of [...f.events]) resolveEvent(fd, f, e.id, e.choices[0]!.id);
  finishWeek(fd, f);
}

describe("franchise", () => {
  it("a full season: 17 weeks, playoffs, a champion, the off-season, the next season", () => {
    const t0 = Date.now();
    const f = newFranchise(fd, pool, { name: "test", seed: "fr1", team: "BUF", quarterMinutes: 3, injuries: true });
    expect(f.teams).toHaveLength(32);
    // every team plays 17 games, 6 of them in its division
    for (const t of f.teams) {
      const gs = f.games.filter((g) => g.home === t.abbr || g.away === t.abbr);
      expect(gs).toHaveLength(17);
      expect(gs.filter((g) => team(f, g.home === t.abbr ? g.away : g.home).div === t.div)).toHaveLength(6);
      expect(teamPlayers(f, t.abbr).length).toBeLessThanOrEqual(data.franchise.rosterMax);
    }
    for (const w of new Set(f.games.map((g) => g.week))) expect(f.games.filter((g) => g.week === w)).toHaveLength(16);
    for (const t of f.teams) expect(payroll(f, t.abbr)).toBeLessThanOrEqual(f.cap);
    // credits buy staff and facilities
    f.credits = 40;
    expect(upgradeStaff(fd, f, "oc")).toBeNull();
    expect(upgradeFacility(fd, f, "training")).toBeNull();
    const star = teamPlayers(f, "BUF").sort((a, b) => fd.ovr(b) - fd.ovr(a))[5]!;
    const before = fd.ovr(star);
    expect(develop(fd, f, star.id)).toBeNull();
    expect(fd.ovr(star)).toBe(before + 1);
    let weeks = 0;
    while (f.phase === "regular" || f.phase === "playoffs") { simWeek(f); if (++weeks > 40) throw new Error("season never ended"); }
    expect(f.champions).toHaveLength(1);
    const st = standings(f);
    expect(st.reduce((a, t) => a + t.w + t.l + t.t, 0)).toBe(17 * 32);
    expect(f.awards.filter((a) => a.year === 1).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(f.records.season).length).toBeGreaterThan(4);
    expect(f.news.length).toBeGreaterThan(10);
    // off-season: re-sign, the Triple Draft rookie draft, free agency
    expect(f.phase).toBe("resign");
    for (const p of expiring(f).slice(0, 2)) resign(fd, f, p.id, 2);
    startDraft(fd, f, pool);
    let picks = 0;
    while (f.phase === "draft") { expect(f.draft!.offers).toHaveLength(3); draftChoose(fd, f, f.draft!.offers[0]!); picks++; }
    expect(picks).toBe(data.franchise.draft.draftRounds);
    expect(teamPlayers(f, "BUF").filter((p) => p.rookieYear === 2)).toHaveLength(picks);
    expect(f.phase).toBe("freeAgency");
    const fa = freeAgents(f).sort((a, b) => fd.ovr(b) - fd.ovr(a))[0]!;
    expect(placeBid(fd, f, { player: fa.id, salary: Math.min(capSpace(f, "BUF"), 400), years: 2 })).toBeNull();
    endFreeAgency(fd, f);
    expect(f.year).toBe(2);
    expect(f.phase).toBe("regular");
    expect(f.games.filter((g) => g.week === 1)).toHaveLength(16);
    // the save is plain JSON
    const json = JSON.stringify(f);
    expect(JSON.parse(json).year).toBe(2);
    console.log(`season + off-season in ${((Date.now() - t0) / 1000).toFixed(1)} s, save ${(json.length / 1024).toFixed(0)} KB`);
  }, 300_000);

  it("injured players sit, cuts cost dead cap, trades need value, leaders and the user game", () => {
    const f = newFranchise(fd, pool, { name: "t2", seed: "fr2", team: "KC", quarterMinutes: 3, injuries: true });
    const qb = gameRoster(fd, f, "KC").starters.QB!;
    f.players[qb.id]!.injury = 3;
    expect(gameRoster(fd, f, "KC").starters.QB!.id).not.toBe(qb.id);
    const cutMe = teamPlayers(f, "KC").sort((a, b) => b.salary - a.salary)[3]!;
    const space = capSpace(f, "KC");
    expect(cut(fd, f, cutMe.id)).toBeNull();
    expect(capSpace(f, "KC")).toBeGreaterThan(space);
    expect(team(f, "KC").deadCap).toBeGreaterThan(0);
    // a lopsided offer is refused; a generous one is accepted
    const target = teamPlayers(f, "BUF").sort((a, b) => fd.ovr(b) - fd.ovr(a))[0]!;
    const scrub = teamPlayers(f, "KC").sort((a, b) => fd.ovr(a) - fd.ovr(b))[0]!;
    expect(proposeTrade(fd, f, [scrub.id], target.id)).toContain("say no");
    const ug = userGame(f)!;
    expect([ug.home, ug.away]).toContain("KC");
    recordGame(fd, f, ug, simGame(fd, f, ug), true);
    expect(leaders(fd, f, "passYds", 3).length).toBeGreaterThan(0);
  }, 120_000);

  it("a drafted team takes over a club; the club's own players become free agents", () => {
    const buf = teamPlayers(newFranchise(fd, pool, { name: "x", seed: "x", team: "NYJ", quarterMinutes: 3, injuries: false }), "NYJ");
    const picks = pool.filter((c) => c.team === "KC").slice(0, 30);
    const starters = Object.fromEntries(picks.slice(0, 24).map((c, k) => [["QB", "RB", "WR1", "WR2", "WR3", "TE", "LT", "LG", "C", "RG", "RT", "DE1", "DT1", "DT2", "DE2", "OLB1", "MLB", "OLB2", "CB1", "CB2", "FS", "SS", "K", "P"][k]!, c.id]));
    const f = newFranchise(fd, pool, { name: "d", seed: "d", team: "NYJ", quarterMinutes: 3, injuries: false,
      drafted: { info: { abbr: "NYJ", name: "My Draft", nick: "Drafters", c1: "#123456", c2: "#ffffff", c3: "#000000" }, starters, bench: picks.slice(24).map((c) => c.id) } });
    expect(team(f, "NYJ").name).toBe("My Draft");
    expect(teamPlayers(f, "NYJ").map((p) => p.id).sort()).toEqual(picks.map((c) => c.id).sort());
    expect(buf.some((p) => f.players[p.id]!.team === null)).toBe(true);
  }, 60_000);
});
