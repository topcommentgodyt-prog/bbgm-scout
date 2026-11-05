// Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const E = require("../src/engine.js");

const flat = (v, over = {}) => ({ ...Object.fromEntries(E.RATING_KEYS.map((k) => [k, v])), ...over });

test("OVR formula: average ratings land near BBGM's midpoint", () => {
  const r = { hgt: 47.5, stre: 50.2, spd: 50.8, jmp: 48.7, endu: 39.9, ins: 42.4, dnk: 49.5, ft: 47, tp: 47.1, oiq: 46.8, diq: 46.7, drb: 54.8, pss: 51.3, fg: 47, reb: 51.4 };
  assert.strictEqual(E.ovr(r), 51); // 48.5 + fudge(48.5) = 48.5 + 2.3125 -> 51
  assert.ok(E.ovr(flat(100)) === 100 && E.ovr(flat(0)) === 0);
});

test("forecast is deterministic for a given seed", () => {
  const o = { ratings: flat(45, { hgt: 55 }), age: 19, nSims: 300, seed: 7, bustThreshold: 60 };
  assert.deepStrictEqual(E.forecast(o), E.forecast(o));
});

test("young prospect: peak in mid-20s, upside, breakout likely", () => {
  const fc = E.forecast({ ratings: flat(42, { hgt: 55, oiq: 35, diq: 35 }), age: 19, nSims: 2000, seed: 1, bustThreshold: 0 });
  assert.ok(fc.peakAge >= 24 && fc.peakAge <= 29, `peakAge ${fc.peakAge}`);
  assert.ok(fc.ceiling > fc.peakOvr && fc.peakOvr > fc.startOvr, JSON.stringify(fc));
  assert.ok(fc.breakout > 0.3, `breakout ${fc.breakout}`);
  assert.ok(fc.decline < 0.05, `decline ${fc.decline}`);
});

test("veteran: already at peak, decline risk dominates breakout", () => {
  const fc = E.forecast({ ratings: flat(60, { hgt: 50 }), age: 32, nSims: 2000, seed: 2, bustThreshold: 0 });
  assert.strictEqual(fc.peakAge, 32);
  assert.ok(fc.decline > fc.breakout, JSON.stringify({ d: fc.decline, b: fc.breakout }));
  assert.ok(fc.expectedNextDelta < 0);
});

test("locked ratings never change", () => {
  const fc = E.forecast({ ratings: flat(50), age: 20, nSims: 100, seed: 3, locked: true });
  assert.strictEqual(fc.peakOvr, fc.startOvr);
  assert.strictEqual(fc.breakout, 0);
});

test("good coaching raises expected development", () => {
  const r = flat(45, { hgt: 50 });
  const bad = E.expectedDelta(r, 21, 1, 4000, 9);
  const good = E.expectedDelta(r, 21, 100, 4000, 9);
  assert.ok(good > bad, `${good} vs ${bad}`);
});

test("scouting fog widens the outcome range", () => {
  const base = { ratings: flat(45, { hgt: 55 }), age: 21, nSims: 2000, seed: 4 };
  const clear = E.forecast(base);
  const foggy = E.forecast({ ...base, fog: E.scoutingFuzz(1) });
  assert.ok(foggy.ceiling - foggy.peakOvrLow >= clear.ceiling - clear.peakOvrLow);
});

test("trend: needs history, then compares actual vs expected", () => {
  assert.strictEqual(E.trend([{ season: 2025, ...flat(45) }], 2005, 34, 1).label, "Not enough history");
  const t = E.trend([{ season: 2025, ...flat(45) }, { season: 2026, ...flat(52) }], 2005, 34, 1);
  assert.strictEqual(t.label, "Above expected");
  assert.strictEqual(t.seasons.length, 1);
});

test("confidence drops with fog and limited history", () => {
  const fc = E.forecast({ ratings: flat(45, { hgt: 55 }), age: 19, nSims: 500, seed: 5 });
  const hi = E.confidence({ fc, fog: null, historySeasons: 4, realPlayerDeterminism: 0 });
  const lo = E.confidence({ fc, fog: E.scoutingFuzz(1), historySeasons: 0, realPlayerDeterminism: 0 });
  assert.ok(lo.score < hi.score);
  assert.ok(["High", "Medium", "Low"].includes(lo.label));
});

test("performance: 1000 sims of a 19-year-old under 250ms", () => {
  const t0 = Date.now();
  E.forecast({ ratings: flat(45), age: 19, nSims: 1000, seed: 6 });
  assert.ok(Date.now() - t0 < 250, `${Date.now() - t0}ms`);
});

test("team rating (BBGM MOV formula): better players raise it, 11th man doesn't count", () => {
  global.BBGMScoutAnalyze = {};
  const LG = (() => { require("../src/league.js"); return globalThis.BBGMScoutLeague; })();
  const base = [60, 58, 55, 52, 50, 48, 47, 46, 45, 44];
  assert.ok(LG.teamMov(base.map((x) => x + 5)) > LG.teamMov(base));
  assert.strictEqual(LG.teamMov([...base, 40]), LG.teamMov(base));
  // A league-average team (~top-10 average of 50) should be close to 0 MOV.
  assert.ok(Math.abs(LG.teamMov([62, 58, 55, 53, 51, 49, 47, 46, 45, 44])) < 8);
});
