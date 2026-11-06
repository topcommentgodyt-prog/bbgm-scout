#!/usr/bin/env node
/*
 * BBGM Scout backtest: runs the Manager + Autopilot loop of two versions of the extension on the same
 * simplified mock league (tests/backtest/mock-league.js), from identical starting states, over several
 * seeds and scenarios, and records outcomes.
 *
 *   node tests/backtest/run.js                       # default: v2.3.0 (git tag/commit) vs working tree
 *   node tests/backtest/run.js --seasons 3 --seeds 3 --scenarios default,contender
 *   node tests/backtest/run.js --base 4c20e5d --out backtest-results.json
 *
 * Each module is loaded into its own sandbox, with an in-memory chrome.storage and the mock in place of
 * BBGM. The loop mirrors content.js's Autopilot: plan → act (with the version's own safeguards) → draft →
 * advance, stopping if the game can't advance (as Autopilot does). The mock isn't BBGM: compare versions
 * with each other, not with real leagues.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execSync } = require("child_process");
const { createLeague } = require("./mock-league.js");

const ROOT = path.join(__dirname, "..", "..");
const FILES = ["engine", "strategy", "data", "storage", "analyze", "league", "features", "planning"];
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? [...a, [x.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : a), []));
const SEASONS = Number(args.seasons || 3);
const SEEDS = Number(args.seeds || 3);
const BASE = args.base || "4c20e5d"; // v2.3.0
const SCENARIOS = (args.scenarios || "default,rebuilding,contender,aging,injuries,custom").split(",");
const LONG = Number(args.long || 0); // extra long run (seasons) on the default scenario, seed 1

function sources(rev) {
  const out = {};
  for (const f of FILES) {
    try {
      out[f] = rev === "work" ? fs.readFileSync(path.join(ROOT, "src", `${f}.js`), "utf8") : execSync(`git show ${rev}:src/${f}.js`, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString();
    } catch (e) { /* file doesn't exist in that version (e.g. strategy.js before v2.4) */ }
  }
  return out;
}

function sandbox(src, bridge) {
  const mem = () => { const d = {}; return {
    get: async (k) => { if (k == null) return { ...d }; if (typeof k === "string") return k in d ? { [k]: d[k] } : {}; const o = {}; for (const x of [].concat(k)) if (x in d) o[x] = d[x]; return o; },
    set: async (o) => { for (const k in o) d[k] = JSON.parse(JSON.stringify(o[k])); }, remove: async (k) => { for (const x of [].concat(k)) delete d[x]; },
    getBytesInUse: async () => JSON.stringify(d).length }; };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval });
  ctx.chrome = { storage: { sync: mem(), local: mem(), onChanged: { addListener() {} } }, runtime: { id: "backtest" } };
  ctx.BBGMScoutBridge = bridge;
  for (const f of FILES) if (src[f]) vm.runInContext(src[f], ctx, { filename: `${f}.js` });
  return ctx;
}

const progressKey = (p) => `${p.season}:${p.phase}:${p.gp}:${p.onClock}:${p.prog}:${p.sched}:${p.daysLeft}:${p.round}`;

async function runOne({ label, src, scenario, seed, seasons }) {
  const ga = scenario === "custom" ? { salaryCapType: "hard", salaryCap: 120000, luxuryPayroll: 120000, maxRosterSize: 13, minRosterSize: 10, numGames: 40, minContract: 2000, maxContract: 40000 } : {};
  const { bridge, truth } = createLeague({ seed, scenario, ga, injuryMult: scenario === "injuries" ? 4 : 1 });
  const ctx = sandbox(src, bridge);
  const LG = ctx.BBGMScoutLeague, F = ctx.BBGMScoutFeatures, S = ctx.BBGMScoutStorage;
  const base = await S.getSettings();
  const settings = { ...base, features: { ...base.features, manager: true, autopilot: true, drafter: true }, managerMode: "auto", teamMode: "auto",
    apStep: "week", apSeasons: seasons, manage: { ...base.manage, resign: true, releases: true, signings: true } };
  await S.saveSettings(settings);
  const t0 = Date.now();
  const m = { actions: 0, failed: 0, skipped: 0, stalls: 0, stoppedEarly: null, strategies: {}, kinds: {} };
  let startSeason = null, stored = null, stuck = 0, rounds = 0, roundsKey = "", idle = 0, idleKey = "";
  for (let guard = 0; guard < 4000; guard++) {
    const poll = await bridge.poll();
    if (startSeason == null) startSeason = poll.season;
    if (poll.season - startSeason >= seasons && poll.phase <= 1) break;
    const pk = progressKey(poll);
    idle = idleKey === pk ? idle + 1 : 0; idleKey = pk;
    if (process.env.BT_DEBUG && idle >= 2) console.error("idle", idle, pk, m.lastError || "");
    if (idle >= 8) { m.stoppedEarly = "loop guard"; m.stalls++; break; }
    const snap = await bridge.snapshot();
    const L = await LG.build(snap, settings, null, { strategyStored: stored });
    if (L.strategy && L.strategy.auto && L.strategy.decision) stored = L.strategy.decision;
    const strat = L.strategy ? L.strategy.label : L.mode;
    (m.strategies[poll.season] = m.strategies[poll.season] || new Set()).add(strat);
    F.setLeague && F.setLeague(1);
    F.noteClock && F.noteClock(L);
    const td = await F.tradeDue(1, L, settings);
    const acts = (await F.managerPlan(L, settings, { lid: 1, includeTrades: settings.manage.trades && td.due && td })).filter((a) => !a.approval);
    if (td.due) await td.mark();
    if (acts.length) {
      const check = async () => (progressKey(await bridge.poll()) !== pk ? "state changed" : null);
      const res = await F.runActions(acts, { stateKey: pk, check });
      for (const r of res) {
        if (r.skipped) { m.skipped++; continue; }
        m.actions++; m.kinds[r.a.kind] = (m.kinds[r.a.kind] || 0) + 1;
        if (!r.ok) { m.failed++; (m.errors = m.errors || []).push(`${r.a.kind}: ${r.error}`); }
      }
      rounds = roundsKey === pk ? rounds + 1 : 1; roundsKey = pk;
      if (process.env.BT_DEBUG) console.error("acts", res.map((r) => `${r.a.kind}:${r.ok ? "ok" : r.error}`).join(" "));
      if (res.some((r) => r.ok) && rounds < 3) continue;
    }
    if (poll.phase === 5 && poll.onClock === poll.userTid) {
      const LD = await LG.build(await bridge.snapshot(), settings, null, { strategyStored: stored });
      const dr = await F.draftStep(LD, settings, { act: true });
      if (process.env.BT_DEBUG) console.error("draft", dr.state, LD.snap.phase, LD.snap.order.length, F.draftBoard(LD).length, LD.snap.players.filter((p) => p.tid === -2 && p.draft.year === LD.snap.season).length);
      continue;
    }
    const [action] = F.nextPlayAction(poll, settings);
    try { await bridge.call("playMenu", action); } catch (e) { m.lastError = e.message; }
    let after = await bridge.poll();
    if (progressKey(after) === pk && after.phase <= 3) { try { await bridge.call("playMenu", "day"); } catch (e) { m.lastError = e.message; } after = await bridge.poll(); }
    if (progressKey(after) === pk) { m.stalls++; if (++stuck >= 2) { m.stoppedEarly = m.lastError || "didn't advance"; break; } } else stuck = 0;
  }
  const hist = truth.history().filter((h) => h.season >= startSeason);
  const mine = hist.map((h) => h.rows.find((r) => r.tid === 0));
  const games = mine.reduce((s, r) => s + r.won + r.lost, 0);
  return {
    label, scenario, seed, seasonsPlayed: mine.length,
    titles: mine.filter((r) => r.prw >= 3).length, playoffApps: mine.filter((r) => r.prw >= 0).length,
    winPct: games ? mine.reduce((s, r) => s + r.won, 0) / games : null,
    rosterValueEnd: Math.round(truth.rosterValue()), avgPayroll: mine.length ? Math.round(mine.reduce((s, r) => s + r.salary, 0) / mine.length) : null,
    invalidActions: m.failed, ruleViolations: truth.violations().length, stalls: m.stalls, stoppedEarly: m.stoppedEarly, skipped: m.skipped,
    actions: m.actions, kinds: m.kinds, errors: (m.errors || []).slice(0, 20), strategies: Object.fromEntries(Object.entries(m.strategies).map(([k, v]) => [k, [...v].join("/")])), runtimeMs: Date.now() - t0,
  };
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const fmt = (a, d = 3) => { const v = a.filter((x) => x != null); return v.length ? `${mean(v).toFixed(d)} ± ${sd(v).toFixed(d)}` : "–"; };

(async () => {
  const versions = [{ label: `v2.3.0 (${BASE})`, src: sources(BASE) }, { label: "candidate (working tree)", src: sources("work") }];
  const results = [];
  const jobs = [];
  for (const scenario of SCENARIOS) for (let seed = 1; seed <= SEEDS; seed++) for (const v of versions) jobs.push({ ...v, scenario, seed, seasons: SEASONS });
  if (LONG) for (const v of versions) jobs.push({ ...v, scenario: "default", seed: 1, seasons: LONG, long: true });
  for (const j of jobs) {
    const r = await runOne(j);
    r.long = !!j.long;
    results.push(r);
    process.stderr.write(`${r.label.padEnd(26)} ${r.scenario.padEnd(11)} seed ${r.seed} ${r.long ? `(${j.seasons}-season run) ` : ""}→ ${r.seasonsPlayed} seasons, win% ${r.winPct == null ? "–" : r.winPct.toFixed(3)}, titles ${r.titles}, fails ${r.invalidActions}, stalls ${r.stalls}${r.stoppedEarly ? ` (stopped: ${r.stoppedEarly})` : ""}, ${(r.runtimeMs / 1000).toFixed(1)}s\n`);
  }
  // Table: per scenario, per version, mean ± sd over seeds (no percentages of "improvement": the samples are small).
  const lines = ["| Scenario | Version | Win % | Titles | Playoff apps | Roster value (end) | Avg payroll ($k) | Failed actions | Rule violations | Stalls | Early stops | Runtime (s) |", "|---|---|---|---|---|---|---|---|---|---|---|---|"];
  const groups = [...new Set(results.map((r) => `${r.long ? "long" : r.scenario}`))];
  for (const g of groups) for (const v of versions) {
    const rs = results.filter((r) => (r.long ? "long" : r.scenario) === g && r.label === v.label);
    if (!rs.length) continue;
    const col = (k, d) => fmt(rs.map((r) => r[k]), d);
    lines.push(`| ${g}${g === "long" ? ` (${LONG} seasons, 1 seed)` : ` (${rs.length} seeds × ${SEASONS} seasons)`} | ${v.label} | ${col("winPct", 3)} | ${col("titles", 2)} | ${col("playoffApps", 2)} | ${col("rosterValueEnd", 0)} | ${col("avgPayroll", 0)} | ${col("invalidActions", 1)} | ${col("ruleViolations", 1)} | ${col("stalls", 1)} | ${rs.filter((r) => r.stoppedEarly).length} | ${col("runtimeMs", 0).replace(/(\d+)/g, (x) => (Number(x) / 1000).toFixed(1))} |`);
  }
  const table = lines.join("\n");
  console.log(table);
  if (args.out) fs.writeFileSync(args.out, JSON.stringify({ when: new Date().toISOString(), seasons: SEASONS, seeds: SEEDS, base: BASE, results, table }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
