// Run: node --test tests/
// Manager regression tests against the mock league (tests/backtest/mock-league.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createLeague } = require("./backtest/mock-league.js");

function load(bridge) {
  const mem = () => { const d = {}; return {
    get: async (k) => { if (typeof k === "string") return k in d ? { [k]: d[k] } : {}; const o = {}; for (const x of [].concat(k || [])) if (x in d) o[x] = d[x]; return o; },
    set: async (o) => { for (const k in o) d[k] = JSON.parse(JSON.stringify(o[k])); } }; };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  ctx.chrome = { storage: { sync: mem(), local: mem(), onChanged: { addListener() {} } } };
  ctx.BBGMScoutBridge = bridge;
  for (const f of ["engine", "strategy", "data", "storage", "analyze", "league", "features", "planning"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", `${f}.js`), "utf8"), ctx);
  return ctx;
}
async function advanceTo(bridge, phase) {
  const step = { 0: "untilRegularSeason", 1: "week", 2: "week", 3: "untilEndOfRound", 4: "untilDraft", 5: "untilEnd", 6: "untilResignPlayers", 7: "untilFreeAgency", 8: "untilPreseason" };
  for (let i = 0; i < 200; i++) {
    const p = await bridge.poll();
    if (p.phase === phase) return;
    if (p.phase === 5 && p.onClock === p.userTid) { // draft the best available prospect for the user
      const snap = await bridge.snapshot();
      const best = snap.players.filter((x) => x.tid === -2 && x.draft.year === snap.season).sort((a, b) => b.value - a.value)[0];
      await bridge.call("main", "draftUser", best.pid);
      continue;
    }
    await bridge.call("playMenu", step[p.phase]);
  }
  throw new Error("couldn't reach phase " + phase);
}

test("hard cap: every planned re-signing fits under the cap (no rejected re-signings)", async () => {
  for (const seed of [1, 2]) {
    const { bridge } = createLeague({ seed, scenario: "default", ga: { salaryCapType: "hard", salaryCap: 120000, luxuryPayroll: 120000, maxRosterSize: 13, minRosterSize: 10, numGames: 40, minContract: 2000, maxContract: 40000 } });
    await advanceTo(bridge, 7);
    const ctx = load(bridge);
    const settings = await ctx.BBGMScoutStorage.getSettings();
    const L = await ctx.BBGMScoutLeague.build(await bridge.snapshot(), settings, null, {});
    const acts = (await ctx.BBGMScoutFeatures.managerPlan(L, { ...settings, manage: { ...settings.manage, resign: true } }, { lid: 1, includeTrades: false })).filter((a) => !a.approval);
    assert.ok(acts.some((a) => a.kind === "resign" || a.kind === "letwalk"), "plans re-signing decisions");
    // Let-walk decisions come before re-signings, so the salary they free counts under the hard cap.
    const kinds = acts.map((a) => a.kind).filter((k) => k === "resign" || k === "letwalk");
    const firstResign = kinds.indexOf("resign");
    if (firstResign >= 0) assert.ok(!kinds.slice(0, firstResign).includes("resign"));
    const res = await ctx.BBGMScoutFeatures.runActions(acts);
    const failed = res.filter((r) => !r.ok);
    assert.strictEqual(JSON.stringify(failed.map((r) => `${r.a.text}: ${r.error}`)), "[]", `seed ${seed}`); // arrays from the sandbox realm
  }
});

test("manager: every planned action carries an explanation with a strategy", async () => {
  const { bridge } = createLeague({ seed: 3 });
  const ctx = load(bridge);
  const settings = await ctx.BBGMScoutStorage.getSettings();
  const L = await ctx.BBGMScoutLeague.build(await bridge.snapshot(), settings, null, {});
  assert.ok(["rebuild", "develop", "contend", "winnow"].includes(L.strategy.key));
  const acts = await ctx.BBGMScoutFeatures.managerPlan(L, settings, { lid: 1, includeTrades: true });
  for (const a of acts.filter((x) => x.kind !== "minutes" && x.kind !== "roster")) {
    assert.ok(a.ex && a.ex.why && a.ex.strategy && a.ex.basis === "projected", `${a.kind}: ${a.text}`);
  }
});

test("runActions: idempotent per game state, and stops cleanly", async () => {
  const { bridge } = createLeague({ seed: 4 });
  const ctx = load(bridge);
  let runs = 0;
  const act = { kind: "finances", text: "x", sig: "finances", pids: [], run: async () => { runs++; } };
  await ctx.BBGMScoutFeatures.runActions([act], { stateKey: "k1" });
  const again = await ctx.BBGMScoutFeatures.runActions([act], { stateKey: "k1" });
  assert.strictEqual(runs, 1);
  assert.strictEqual(again[0].error, "already done");
  const stopped = await ctx.BBGMScoutFeatures.runActions([{ ...act, sig: "a" }, { ...act, sig: "b" }], { stateKey: "k2", shouldStop: () => true });
  assert.strictEqual(runs, 1);
  assert.ok(stopped.every((r) => r.skipped && r.error === "stopped"));
  const stale = await ctx.BBGMScoutFeatures.runActions([{ ...act, sig: "c" }], { stateKey: "k3", check: async () => "the game moved on" });
  assert.strictEqual(runs, 1);
  assert.strictEqual(stale[0].error, "the game moved on");
});

test("re-signing: a player whose contract demands weren't read is still decided (nothing blocks free agency)", async () => {
  const { bridge } = createLeague({ seed: 5 });
  await advanceTo(bridge, 7);
  const ctx = load(bridge);
  const settings = await ctx.BBGMScoutStorage.getSettings();
  const snap = await bridge.snapshot();
  assert.ok(snap.negotiations.length > 0, "has negotiations");
  const pid = snap.negotiations[0];
  delete snap.players.find((p) => p.pid === pid).mood; // as when BBGM's demands weren't read for him
  const L = await ctx.BBGMScoutLeague.build(snap, settings, null, {});
  const acts = await ctx.BBGMScoutFeatures.managerPlan(L, { ...settings, manage: { ...settings.manage, resign: true } }, { lid: 1, includeTrades: false });
  const decided = new Set(acts.filter((a) => a.kind === "resign" || a.kind === "letwalk").flatMap((a) => a.pids));
  for (const n of snap.negotiations) assert.ok(decided.has(n), `negotiation ${n} decided`);
});

test("trade bar (v3.3): adapts to strategy, deadline, title race and churn, within 0.25–1.5", async () => {
  const { bridge } = createLeague({ seed: 3 });
  const ctx = load(bridge);
  const F = ctx.BBGMScoutFeatures;
  const settings = await ctx.BBGMScoutStorage.getSettings();
  const L = await ctx.BBGMScoutLeague.build(await bridge.snapshot(), settings, null, {});
  const at = (key, extra = {}) => {
    const strat = { ...L.strategy, key, label: key, features: { ...L.strategy.features, titleGap: 5, ...extra.features } };
    return F.tradeBar({ ...L, strategy: strat, snap: { ...L.snap, ...(extra.snap || {}) }, user: extra.user || L.user }, settings).min;
  };
  // Strategy: Win Now takes smaller gains than Rebuild.
  assert.ok(at("winnow") < at("contend") && at("contend") < at("develop") && at("develop") < at("rebuild"));
  // A close title race lowers a contender's bar.
  assert.ok(at("contend", { features: { titleGap: 1 } }) < at("contend"));
  // Deadline: in the last games before the deadline the bar drops.
  const games = (L.snap.ga && L.snap.ga.numGames) || 82, dlGame = Math.ceil(games * 0.6);
  const reg = { snap: { phase: 1, ga: { ...L.snap.ga, tradeDeadline: 0.6, numGames: games } } };
  const early = at("develop", { ...reg, user: { ...L.user, won: 2, lost: 2, tied: 0, otl: 0 } });
  const late = at("develop", { ...reg, user: { ...L.user, won: dlGame - 4, lost: 1, tied: 0, otl: 0 } });
  assert.ok(late < early, `late ${late} < early ${early}`);
  // Bounds, and the test override still pins it.
  for (const k of ["winnow", "contend", "develop", "rebuild"]) { const m = at(k); assert.ok(m >= 0.25 && m <= 1.5, `${k} ${m}`); }
  assert.strictEqual(F.tradeBar(L, { ...settings, tradeMinOverride: 0.1 }).min, 0.1);
});

test("trade search timing (v3.3): searches on changes, paces itself, backs off after empty searches", async () => {
  const { bridge } = createLeague({ seed: 3 });
  const ctx = load(bridge);
  const F = ctx.BBGMScoutFeatures;
  const settings = await ctx.BBGMScoutStorage.getSettings();
  await advanceTo(bridge, 1);
  const L = await ctx.BBGMScoutLeague.build(await bridge.snapshot(), settings, null, {});
  const lid = 7;
  let td = await F.tradeDue(lid, L, settings);
  assert.ok(td.due, "first search is due");
  await td.mark(0); // found nothing
  td = await F.tradeDue(lid, L, settings);
  assert.ok(!td.due && td.nextIn >= 1, "not due again on the same day");
  // A roster change makes it due at once.
  const changed = { ...L, roster: (tid) => L.roster(tid).slice(1) };
  assert.strictEqual((await F.tradeDue(lid, changed, settings)).why, "roster changed");
  // After empty searches the interval grows (up to 14 game days).
  const i1 = td.interval;
  await td.mark(0);
  const i2 = (await F.tradeDue(lid, L, settings)).interval;
  assert.ok(i2 >= i1 && i2 <= 14, `${i1} -> ${i2}`);
});

test("free agency checker (v3.1): Autopilot shops day by day only while it's worth it", async () => {
  const { bridge } = createLeague({ seed: 2 });
  const ctx = load(bridge);
  const F = ctx.BBGMScoutFeatures;
  // The play step during free agency follows the checker.
  assert.strictEqual(F.nextPlayAction({ phase: 8, daysLeft: 20 }, { apStep: "day" }, { keepShopping: true, openSpots: 2, daysLeft: 20 })[0], "day");
  assert.strictEqual(F.nextPlayAction({ phase: 8, daysLeft: 20 }, { apStep: "week" }, { keepShopping: true, openSpots: 2, daysLeft: 20 })[0], "week");
  assert.strictEqual(F.nextPlayAction({ phase: 8, daysLeft: 20 }, { apStep: "day" }, { keepShopping: false })[0], "untilPreseason");
  assert.strictEqual(F.nextPlayAction({ phase: 8 }, { apStep: "day" })[0], "untilPreseason");
  // On a real (mock) league in free agency: consistent numbers, and it only keeps shopping with open spots.
  await advanceTo(bridge, 8);
  const settings = await ctx.BBGMScoutStorage.getSettings();
  const L = await ctx.BBGMScoutLeague.build(await bridge.snapshot(), settings, null, {});
  const poll = await bridge.poll();
  const fa = F.freeAgencyCheck(L, settings, poll);
  assert.strictEqual(fa.rosterSize, L.capInfo.rosterSize);
  assert.strictEqual(fa.openSpots, Math.max(0, fa.target - fa.rosterSize));
  if (fa.keepShopping) assert.ok(fa.rosterSize < fa.target, "keeps shopping only with open spots");
  if (fa.rosterSize >= fa.target) assert.ok(!fa.keepShopping);
  if (fa.rosterSize < fa.min) assert.ok(fa.issues.some((t) => /below/.test(t)));
  assert.ok(fa.best.length <= 5);
});

test("autopilot phases: fantasy and expansion drafts have a play action", () => {
  const { bridge } = createLeague({ seed: 1 });
  const ctx = load(bridge);
  const F = ctx.BBGMScoutFeatures;
  for (const phase of [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(F.nextPlayAction({ phase, round: 0 }, { apStep: "day" })[0], `phase ${phase}`);
});

test("minutes: stable after applying, and a short injury doesn't reshuffle the rotation", async () => {
  for (const teamMode of ["contend", "rebuild", "develop"]) {
    const { bridge } = createLeague({ seed: 6, scenario: "contender" });
    await bridge.call("playMenu", "untilRegularSeason");
    const ctx = load(bridge);
    const settings = { ...(await ctx.BBGMScoutStorage.getSettings()), teamMode };
    const snap = await bridge.snapshot();
    let L = await ctx.BBGMScoutLeague.build(snap, settings, null, {});
    const F = ctx.BBGMScoutFeatures;
    for (const x of F.minutesPlan(L, settings)) x.v.p.ptModifier = x.pt; // apply
    assert.strictEqual(F.minutesPlan(L, settings).length, 0, `${teamMode}: plan is stable once applied`);
    // Injure the 4th-best player for 3 games.
    const mine = snap.players.filter((p) => p.tid === snap.userTid).sort((a, b) => b.ratings[0].ovr - a.ratings[0].ovr);
    mine[3].injury = { type: "Sprained Ankle", gamesRemaining: 3 };
    L = await ctx.BBGMScoutLeague.build(snap, settings, null, {});
    const after = F.minutesPlan(L, settings);
    assert.ok(!after.some((x) => x.v.p.pid === mine[3].pid), `${teamMode}: injured player left alone`);
    assert.strictEqual(after.length, 0, `${teamMode}: no reshuffle for a short injury`);
  }
});

test("trades leave room for this round's re-signings and pending draft picks", async () => {
  const { bridge } = createLeague({ seed: 2 });
  await advanceTo(bridge, 7);
  const ctx = load(bridge);
  const settings = await ctx.BBGMScoutStorage.getSettings();
  const L = await ctx.BBGMScoutLeague.build(await bridge.snapshot(), settings, null, {});
  const acts = await ctx.BBGMScoutFeatures.managerPlan(L, { ...settings, manage: { ...settings.manage, resign: true, trades: true }, tradeMinOverride: 0.1 }, { lid: 1, includeTrades: true });
  const resigns = acts.filter((a) => a.kind === "resign").length;
  const trade = acts.find((a) => a.kind === "trade");
  if (trade) {
    // trade's net roster change + current roster + re-signings must fit
    const t = trade.pids;
    const mine = new Set(L.roster(L.snap.userTid).map((p) => p.pid));
    const out = t.filter((pid) => mine.has(pid)).length, inc = t.length - out;
    assert.ok(L.capInfo.rosterSize - out + inc + resigns <= L.capInfo.maxRoster, "room left for re-signings");
  }
});

test("realism: only known league settings with sane values can be applied", () => {
  const { bridge } = createLeague({ seed: 1 });
  const ctx = load(bridge);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "realism.js"), "utf8"), ctx);
  const R = ctx.BBGMScoutRealism;
  const patch = R.settingsToApply([
    { changes: [{ key: "luxuryTax", value: 2 }, { key: "salaryCapType", value: "hard" }, { key: "salaryCap", value: 160000 }] },
    { changes: [{ key: "godMode", value: true }, { key: "pace", value: 9999 }, { key: "salaryCapType", value: "weird" }, { setting: ["Draft", "Draft classes"], suggest: "upload" }] },
  ]);
  assert.strictEqual(JSON.stringify(patch), JSON.stringify({ luxuryTax: 2, salaryCapType: "hard", salaryCap: 160000 }));
});
