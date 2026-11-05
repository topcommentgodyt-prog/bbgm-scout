// Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const SG = require("../src/strategy.js");

const f = (o = {}) => ({ rankNow: 0.5, rankFuture: 0.5, winPct: null, gp: 0, numGames: 82, coreAge: 27, capRoomPct: 0.1, firsts: 2, youngCore: 1, ...o });

test("strategy: clear cases pick the expected strategy", () => {
  assert.strictEqual(SG.choose(f({ rankNow: 0.05, rankFuture: 0.1 })).key, "rebuild");
  assert.strictEqual(SG.choose(f({ rankNow: 0.45, rankFuture: 0.5 })).key, "develop");
  assert.strictEqual(SG.choose(f({ rankNow: 0.65, rankFuture: 0.6 })).key, "contend");
  assert.strictEqual(SG.choose(f({ rankNow: 0.95, rankFuture: 0.9, coreAge: 26 })).key, "contend");
  assert.strictEqual(SG.choose(f({ rankNow: 0.95, rankFuture: 0.6, coreAge: 31 })).key, "winnow");
});

test("strategy: a rising young team develops instead of rebuilding", () => {
  assert.strictEqual(SG.choose(f({ rankNow: 0.1, rankFuture: 0.7, youngCore: 3 })).key, "develop");
});

test("strategy: hysteresis keeps the current strategy near a boundary", () => {
  // Strength just above the develop/contend cutoff: a fresh decision says contend...
  const near = f({ rankNow: 0.565, rankFuture: 0.55 });
  assert.ok(Math.abs(SG.strength(near) - 0.55) < 0.03);
  assert.strictEqual(SG.choose(near).key, "contend");
  // ...but a team that was developing stays there until it clears the margin.
  assert.strictEqual(SG.choose(near, "develop").key, "develop");
  // And a contender dipping just below the cutoff keeps contending.
  const dip = f({ rankNow: 0.53, rankFuture: 0.53 });
  assert.strictEqual(SG.choose(dip).key, "develop");
  assert.strictEqual(SG.choose(dip, "contend").key, "contend");
});

test("strategy: a short streak early in the season can't flip the plan", () => {
  const base = f({ rankNow: 0.7, rankFuture: 0.65 });
  const cold = { ...base, winPct: 0.1, gp: 10 };
  assert.strictEqual(SG.choose(base).key, SG.choose(cold, SG.choose(base).key).key);
});

test("strategy: only re-evaluated when the checkpoint changes; manual choice wins", () => {
  const cp = SG.checkpoint(2026, 1, 10, 82);
  assert.strictEqual(cp, "2026:start");
  assert.strictEqual(SG.checkpoint(2026, 1, 41, 82), "2026:mid");
  assert.strictEqual(SG.checkpoint(2026, 5, 82, 82), "2026:off");
  const stored = { key: "contend", cp };
  const r = SG.resolve("auto", f({ rankNow: 0.05, rankFuture: 0.05 }), cp, stored);
  assert.strictEqual(r.key, "contend"); // same checkpoint: no change even though the team looks bad
  const r2 = SG.resolve("auto", f({ rankNow: 0.05, rankFuture: 0.05 }), "2026:mid", stored);
  assert.strictEqual(r2.key, "rebuild");
  assert.ok(r2.changed);
  assert.strictEqual(SG.resolve("winnow", f(), cp, stored).key, "winnow");
  assert.strictEqual(SG.resolve("balanced", f(), cp, null).key, "develop"); // legacy setting
});

test("trade score: rebuild penalizes giving up youth and picks; win now prices aging", () => {
  const p = { now: 1, future: 1, value: 0, youthNet: 0, picksNet: 0, agingNet: 0, overflow: 0, payrollOver: 0 };
  const youth = { ...p, youthNet: 100 };
  assert.ok(SG.tradeScore("rebuild", youth).score < SG.tradeScore("winnow", youth).score);
  const picks = { ...p, picksNet: 100 };
  assert.ok(SG.tradeScore("rebuild", picks).score < SG.tradeScore("contend", picks).score);
  const old = { ...p, agingNet: 10 };
  assert.ok(SG.tradeScore("winnow", old).score < SG.tradeScore("winnow", p).score);
  assert.ok(SG.tradeScore("contend", { ...p, overflow: 1 }).score < SG.tradeScore("contend", p).score - 1);
});

test("trade ok: thresholds per strategy and never over the roster limit", () => {
  const im = { score: 1, now: 1, future: 1, value: 10, overflow: 0 };
  for (const k of SG.ORDER) assert.ok(SG.tradeOk(k, im, 0.5), k);
  assert.ok(!SG.tradeOk("contend", { ...im, overflow: 1 }, 0.5));
  assert.ok(!SG.tradeOk("rebuild", { ...im, value: -5 }, 0.5)); // rebuild needs long-term value
  assert.ok(!SG.tradeOk("winnow", { ...im, now: 0.2 }, 0.5)); // win now needs help now
  assert.ok(!SG.tradeOk("develop", { ...im, score: 0.3 }, 0.5));
});

test("pick value: uncertainty spreads value across slots and stays within the curve", () => {
  const curve = (o) => 100 * Math.exp(-o / 8);
  const sharp = SG.expectedPickValue({ projSlot: 1, sd: 0.3, round: 1, numTeams: 30, curve });
  const fuzzy = SG.expectedPickValue({ projSlot: 1, sd: 6, round: 1, numTeams: 30, curve });
  assert.ok(Math.abs(sharp - curve(1)) < 1);
  assert.ok(fuzzy < sharp && fuzzy > curve(10)); // a projected #1 isn't guaranteed #1
  const mid = SG.expectedPickValue({ projSlot: 15, sd: 6, round: 1, numTeams: 30, curve });
  assert.ok(mid > curve(15)); // convex curve: uncertainty raises the expected value of a mid pick
  const second = SG.expectedPickValue({ projSlot: 15, sd: 6, round: 2, numTeams: 30, curve });
  assert.ok(second < mid);
});

test("memory: cooldown, no reversals, no retrying rejected deals, big-opportunity exception", () => {
  const mem = SG.emptyMemory();
  const teams = [{ tid: 1, pids: [10], dpids: [] }, { tid: 2, pids: [20], dpids: [] }];
  const t0 = SG.gameClock(2026, 1, 10);
  SG.recordTrade(mem, teams, t0);
  // Trading the newly acquired player (20) again soon is blocked...
  const flip = [{ tid: 1, pids: [20], dpids: [] }, { tid: 3, pids: [30], dpids: [] }];
  assert.match(SG.tradeBlocked(mem, flip, t0 + 5, { cooldown: 30, score: 0.6, min: 0.5 }), /cooldown/);
  // ...unless the gain is big,
  assert.strictEqual(SG.tradeBlocked(mem, flip, t0 + 5, { cooldown: 30, score: 2, min: 0.5 }), null);
  // ...but he never goes straight back to his old team, even for a big gain.
  const back = [{ tid: 1, pids: [20], dpids: [] }, { tid: 2, pids: [21], dpids: [] }];
  assert.match(SG.tradeBlocked(mem, back, t0 + 5, { cooldown: 30, score: 5, min: 0.5 }), /old team/);
  // Getting back the player we just sent away is blocked.
  const regain = [{ tid: 1, pids: [11], dpids: [] }, { tid: 2, pids: [10], dpids: [] }];
  assert.match(SG.tradeBlocked(mem, regain, t0 + 5, { cooldown: 30 }), /traded away/);
  // After the cooldown everything is allowed again.
  assert.strictEqual(SG.tradeBlocked(mem, flip, t0 + 40, { cooldown: 30, score: 0.6, min: 0.5 }), null);
  // Rejected deals aren't retried during the cooldown.
  const deal = [{ tid: 1, pids: [12], dpids: [3] }, { tid: 4, pids: [40], dpids: [] }];
  SG.recordRejected(mem, deal, t0);
  assert.match(SG.tradeBlocked(mem, deal, t0 + 1, { cooldown: 30 }), /rejected/);
  // Same deal with assets listed in a different order has the same signature.
  assert.strictEqual(SG.sigOf(deal), SG.sigOf([{ tid: 1, pids: [12], dpids: [3] }, { tid: 4, pids: [40], dpids: [] }]));
});

test("memory: failures counted, old entries pruned", () => {
  const mem = SG.emptyMemory();
  const t = SG.gameClock(2026, 1, 5);
  assert.strictEqual(SG.recordFail(mem, "sign:5", t), 1);
  assert.strictEqual(SG.recordFail(mem, "sign:5", t + 1), 2);
  assert.strictEqual(SG.recordFail(mem, "sign:5", t + 100), 1); // a long gap resets the count
  SG.recordTrade(mem, [{ tid: 1, pids: [1], dpids: [] }, { tid: 2, pids: [2], dpids: [] }], t);
  SG.pruneMemory(mem, t + 1000);
  assert.deepStrictEqual(Object.keys(mem.acq), []);
  assert.deepStrictEqual(Object.keys(mem.fails), []);
});

test("game clock increases through phases and seasons", () => {
  const seq = [[2026, 0, 0], [2026, 1, 40], [2026, 3, 82], [2026, 5, 82], [2026, 8, 82], [2027, 0, 0]].map(([s, p, g]) => SG.gameClock(s, p, g));
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1], JSON.stringify(seq));
});

test("run summary: observed records, titles, payroll per win, no undone moves", () => {
  const rows = [
    { tid: 0, season: 2026, won: 60, lost: 22, prw: 4, salary: 150000 },
    { tid: 0, season: 2027, won: 30, lost: 52, prw: -1, salary: 120000 },
    { tid: 1, season: 2026, won: 22, lost: 60, prw: -1, salary: 90000 },
    { tid: 1, season: 2027, won: 52, lost: 30, prw: 2, salary: 100000 },
  ];
  const log = [
    { kind: "trade", text: "Traded A", ex: { num: { now: 1, future: 0.5 } } },
    { kind: "trade", text: "Traded B", undone: true, ex: { num: { now: 2, future: 2 } } },
    { kind: "draft", text: "Drafted C" }, { kind: "sign", text: "Signed D" }, { kind: "strategy", text: "Strategy (Auto): Contend → Rebuild" },
  ];
  const sm = SG.summarizeRun({ rows, userTid: 0, nr: 4, from: 2026, to: 2027, log, strategies: { 2026: ["Contend"], 2027: ["Contend", "Rebuild"] }, rosterStart: [1, 2, 3], rosterEnd: [2, 3, 4] });
  assert.strictEqual(sm.titles, 1);
  assert.strictEqual(sm.playoffApps, 1);
  assert.strictEqual(sm.seasons[0].playoffs, "Champion");
  assert.strictEqual(sm.seasons[1].playoffs, "Missed playoffs");
  assert.ok(Math.abs(sm.winPct - 90 / 164) < 1e-9);
  assert.strictEqual(sm.trades.count, 1); // undone trade excluded
  assert.strictEqual(sm.trades.projectedNow, 1);
  assert.strictEqual(sm.payrollPerWin, 270000 / 90);
  assert.strictEqual(sm.leaguePayrollPerWin, 460000 / 164);
  assert.strictEqual(sm.turnover, 1);
  assert.strictEqual(sm.seasons[1].strategy, "Contend → Rebuild");
  assert.deepStrictEqual(sm.strategyChanges, ["Strategy (Auto): Contend → Rebuild"]);
});
