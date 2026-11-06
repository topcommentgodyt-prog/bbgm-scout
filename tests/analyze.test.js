// Run: node --test tests/
// Outlook attribute changes (v2.7): current ratings vs last season, with fog of war applied the same way.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = vm.createContext({ console });
for (const f of ["engine", "data", "analyze"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", `${f}.js`), "utf8"), ctx);
const A = ctx.BBGMScoutAnalyze;
const KEYS = ["hgt", "stre", "spd", "jmp", "endu", "ins", "dnk", "ft", "fg", "tp", "oiq", "diq", "drb", "pss", "reb"];
const row = (season, base, fuzz = 0) => ({ season, ovr: base, pot: base + 5, fuzz, ...Object.fromEntries(KEYS.map((k) => [k, base])) });
const settings = { nSims: 200, respectFog: true, bustMode: "margin", bustMargin: 5, bustOvr: 55 };
const league = (p, userTid = 0) => ({ season: 2060, userTid, godMode: false, multiTeam: false, realPlayerDeterminism: 0, teams: new Map([[0, { tid: 0, budget: {} }], [1, { tid: 1, budget: {} }]]), players: new Map([[p.pid, p]]) });

test("attrs: current ratings and last season's, for the ▲/▼ columns", () => {
  const cur = row(2060, 50); cur.spd = 44; cur.tp = 57;
  const p = { pid: 7, tid: 0, firstName: "A", lastName: "B", born: { year: 2034 }, ratings: [row(2059, 50), cur] };
  const r = A.analyze(league(p), p, settings);
  assert.strictEqual(r.attrs.season, 2060);
  assert.strictEqual(r.attrs.prev.season, 2059);
  assert.strictEqual(r.attrs.ratings.spd - r.attrs.prev.ratings.spd, -6);
  assert.strictEqual(r.attrs.ratings.tp - r.attrs.prev.ratings.tp, 7);
  assert.strictEqual(r.attrs.ratings.hgt - r.attrs.prev.ratings.hgt, 0);
});

test("attrs: first season has no previous row", () => {
  const p = { pid: 8, tid: 0, firstName: "C", lastName: "D", born: { year: 2040 }, ratings: [row(2060, 45)] };
  assert.strictEqual(A.analyze(league(p), p, settings).attrs.prev, null);
});

test("attrs: other teams' players are shown through fog of war, like BBGM", () => {
  const p = { pid: 9, tid: 1, firstName: "E", lastName: "F", born: { year: 2036 }, ratings: [row(2059, 50, 3), row(2060, 52, -2)] };
  const a = A.analyze(league(p), p, settings).attrs;
  assert.strictEqual(a.ratings.hgt, 50); // 52 - 2
  assert.strictEqual(a.prev.ratings.hgt, 53); // 50 + 3
});
