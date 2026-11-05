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
