/*
 * BBGM Scout – extension-side client for the page-world bridge, plus the
 * read-only worker scripts that build a live snapshot of the league.
 */
(function (root) {
  "use strict";
  let nextId = 1;
  const pending = new Map();

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__bbgmScout !== "res") return;
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    clearTimeout(p.timer);
    e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
  });

  function call(cat, name, param, timeoutMs = 60000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`BBGM did not respond to ${name}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ __bbgmScout: "req", id, cat, name, param }, location.origin);
    });
  }

  /** Run a read-only script in BBGM's worker; the script must console.log(JSON.stringify(result)) once. */
  async function evalJSON(code, timeoutMs) {
    const out = await call("main", "evalOnWorker", code, timeoutMs);
    if (typeof out !== "string") throw new Error("No output from BBGM");
    // Other logging can interleave while the script runs; use the last line that parses.
    const lines = out.split("\n").reverse();
    for (const l of lines) {
      if (l.startsWith("{")) {
        try { return JSON.parse(l); } catch (e) { /* keep looking */ }
      }
    }
    throw new Error("Could not read BBGM output");
  }

  // ---- Worker scripts (run inside BBGM's engine; read-only) ----
  const RATINGS = '["hgt","stre","spd","jmp","endu","ins","dnk","ft","fg","tp","oiq","diq","drb","pss","reb"]';

  const POLL = `
    const g = bbgm.g;
    const opt = (k) => { try { return g.get(k); } catch (e) { return undefined; } };
    let out = { inLeague: false };
    try {
      const userTid = g.get("userTid"), season = g.get("season"), phase = g.get("phase");
      const ts = await bbgm.idb.cache.teamSeasons.indexGetAll("teamSeasonsByTidSeason", [[userTid, season], [userTid, season]]);
      const t = ts[0] || {};
      const gp = (t.won || 0) + (t.lost || 0) + (t.tied || 0) + (t.otl || 0);
      let onClock = null, userHasPick = false;
      if (phase === bbgm.PHASE.DRAFT) { const o = await bbgm.draft.getOrder(); onClock = o[0] ? o[0].tid : null; userHasPick = o.some((d) => d.tid === userTid); }
      out = { inLeague: true, userTid, season, phase, gp, onClock, userHasPick,
        gameSim: !!bbgm.lock.get("gameSim"), drafting: !!bbgm.lock.get("drafting"),
        godMode: !!opt("godMode"), multiTeam: (opt("userTids") || [userTid]).length > 1, spectator: !!opt("spectator") };
    } catch (e) { out.error = String(e.message || e); }
    console.log(JSON.stringify(out));`;

  const SNAPSHOT = `
    const g = bbgm.g, idb = bbgm.idb, RK = ${RATINGS};
    const userTid = g.get("userTid"), season = g.get("season"), phase = g.get("phase");
    const ga = {};
    for (const k of ["salaryCap","minPayroll","luxuryPayroll","luxuryTax","minContract","maxContract","maxContractLength","maxRosterSize","minRosterSize","salaryCapType","numGames","budget","godMode","realPlayerDeterminism","numActiveTeams","draftType","inflationAvg","inflationStd","softCapTradeSalaryMatch","aiTradesFactor","injuryRate","threePointTendencyFactor","pace"]) {
      try { ga[k] = g.get(k); } catch (e) {}
    }
    try { ga.userTids = g.get("userTids"); } catch (e) { ga.userTids = [userTid]; }
    const sumMoney = (o) => (o ? Object.values(o).reduce((s, r) => s + (typeof r === "number" ? r : (r && r.amount) || 0), 0) : null);
    const teamsRaw = (await idb.cache.teams.getAll()).filter((t) => !t.disabled);
    const teams = [];
    for (const t of teamsRaw) {
      const ts = (await idb.cache.teamSeasons.indexGetAll("teamSeasonsByTidSeason", [[t.tid, season], [t.tid, season]]))[0] || {};
      let payroll = await bbgm.team.getPayroll(t.tid);
      if (Array.isArray(payroll)) payroll = payroll[0];
      teams.push({ tid: t.tid, abbrev: t.abbrev, region: t.region, name: t.name, strategy: t.strategy,
        budget: t.budget, autoTicketPrice: t.autoTicketPrice, adjustForInflation: t.adjustForInflation,
        keepRosterSorted: t.keepRosterSorted, won: ts.won || 0, lost: ts.lost || 0, tied: ts.tied || 0, otl: ts.otl || 0,
        payroll, revenues: sumMoney(ts.revenues), expenses: sumMoney(ts.expenses) });
    }
    const all = await idb.cache.players.getAll();
    const negotiations = (await idb.cache.negotiations.getAll()).filter((n) => n.tid === userTid);
    const negPids = new Set(negotiations.map((n) => n.pid));
    const players = [];
    const fas = [];
    for (const p of all) {
      if (p.tid === bbgm.PLAYER.RETIRED || p.tid < -5) continue;
      const rows = p.ratings.slice(-4).map((r) => { const o = { season: r.season, ovr: r.ovr, pot: r.pot, fuzz: r.fuzz || 0, pos: r.pos, locked: !!r.locked, skills: r.skills }; for (const k of RK) o[k] = r[k]; return o; });
      let untradable = false;
      try { untradable = bbgm.trade.isUntradable(p).untradable; } catch (e) {}
      const row = { pid: p.pid, tid: p.tid, firstName: p.firstName, lastName: p.lastName, born: { year: p.born.year },
        ratings: rows, contract: p.contract, value: p.value, valueFuzz: p.valueFuzz ?? p.value, srID: p.srID ? 1 : 0,
        injury: p.injury ? { type: p.injury.type, gamesRemaining: p.injury.gamesRemaining } : null,
        draft: p.draft ? { year: p.draft.year, round: p.draft.round, pick: p.draft.pick } : null, untradable,
        ptModifier: p.ptModifier ?? 1, rosterOrder: p.rosterOrder };
      players.push(row);
      if (p.tid === bbgm.PLAYER.FREE_AGENT || negPids.has(p.pid)) fas.push([p, row]);
    }
    fas.sort((a, b) => (b[0].valueFuzz ?? b[0].value) - (a[0].valueFuzz ?? a[0].value));
    for (const [p, row] of fas.slice(0, 80)) {
      try { const m = await bbgm.player.moodInfo(p, userTid); row.mood = { willing: !!m.willing, contractAmount: m.contractAmount }; } catch (e) {}
    }
    const draftPicks = (await idb.cache.draftPicks.getAll()).map((d) => ({ dpid: d.dpid, tid: d.tid, originalTid: d.originalTid, season: d.season, round: d.round, pick: d.pick }));
    let order = [];
    if (phase === bbgm.PHASE.DRAFT) order = (await bbgm.draft.getOrder()).map((d) => ({ dpid: d.dpid, tid: d.tid, round: d.round, pick: d.pick }));
    let leagueStats = null;
    try {
      const rows = (await idb.cache.teamStats.getAll()).filter((r) => !r.playoffs && r.season === season);
      const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
      if (rows.length) leagueStats = { gp: sum("gp"), fga: sum("fga"), tpa: sum("tpa"), pts: sum("pts") };
    } catch (e) {}
    const tr = await idb.cache.trade.get(0);
    console.log(JSON.stringify({ userTid, season, phase, ga, teams, players, negotiations: [...negPids], draftPicks, order,
      trade: tr ? tr.teams : null, leagueStats, gameSim: !!bbgm.lock.get("gameSim") }));`;

  root.BBGMScoutBridge = {
    call,
    evalJSON,
    poll: () => evalJSON(POLL, 15000),
    snapshot: () => evalJSON(SNAPSHOT, 120000),
    readTrade: () => evalJSON(`const tr = await bbgm.idb.cache.trade.get(0); console.log(JSON.stringify({ teams: tr ? tr.teams : null }));`, 15000),
  };
})(globalThis);
