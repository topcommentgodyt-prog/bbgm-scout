/*
 * Courtside – extension-side client for the page-world bridge, plus the
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
      // Progress signals that also move during the playoffs and free agency (regular-season gp doesn't).
      let round = null, prog = 0, sched = null;
      try {
        const ps = await bbgm.idb.cache.playoffSeries.get(season);
        if (ps && phase === bbgm.PHASE.PLAYOFFS) {
          round = ps.currentRound;
          prog = (ps.currentRound + 1) * 1000 + ps.series.flat().reduce((t, x) => t + ((x.home && x.home.won) || 0) + ((x.away && x.away.won) || 0), 0)
            + (ps.playIns || []).flat().reduce((t, x) => t + (x && x.pts != null ? 1 : 0), 0);
        }
      } catch (e) {}
      try { sched = (await bbgm.idb.cache.schedule.getAll()).length; } catch (e) {}
      let negs = 0;
      try { negs = (await bbgm.idb.cache.negotiations.getAll()).filter((n) => n.tid === userTid).length; } catch (e) {}
      // Unread inbox messages (e.g. the owner's "Annual performance evaluation"); BBGM's Play menu waits on these.
      let unread = [];
      try { unread = (await bbgm.idb.cache.messages.getAll()).filter((m) => !m.read).map((m) => m.mid).sort((a, b) => a - b); } catch (e) {}
      const ed = opt("expansionDraft") || {};
      out = { inLeague: true, userTid, season, phase, gp, won: t.won || 0, lost: (t.lost || 0) + (t.otl || 0), onClock, userHasPick, round, prog, sched, daysLeft: opt("daysLeft"), negs, unread,
        exp: ed.phase || null, autoExpand: !!opt("autoExpand"), autoRelocate: !!opt("autoRelocate"), relocRealign: opt("autoRelocateRealign") !== false,
        relocRebrand: opt("autoRelocateRebrand") !== false, gameOver: !!opt("gameOver"),
        gameSim: !!bbgm.lock.get("gameSim"), drafting: !!bbgm.lock.get("drafting"),
        godMode: !!opt("godMode"), multiTeam: (opt("userTids") || [userTid]).length > 1, spectator: !!opt("spectator") };
    } catch (e) { out.error = String(e.message || e); }
    console.log(JSON.stringify(out));`;

  const SNAPSHOT = `
    const g = bbgm.g, idb = bbgm.idb, RK = ${RATINGS};
    const userTid = g.get("userTid"), season = g.get("season"), phase = g.get("phase");
    const ga = {};
    for (const k of ["salaryCap","minPayroll","luxuryPayroll","luxuryTax","minContract","maxContract","maxContractLength","maxRosterSize","minRosterSize","salaryCapType","numGames","budget","godMode","realPlayerDeterminism","numActiveTeams","draftType","inflationAvg","inflationStd","softCapTradeSalaryMatch","aiTradesFactor","injuryRate","threePointTendencyFactor","pace","difficulty","tradeDeadline","gracePeriodEnd","minContractLength","challengeNoTrades","challengeNoFreeAgents","challengeNoDraftPicks","challengeNoRatings","challengeFiredLuxuryTax","challengeFiredMissPlayoffs","challengeLoseBestPlayer","numGamesPlayoffSeries","numPlayoffByes"]) {
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
    // Contract demands for the top 80 free agents, and always for everyone you're negotiating with
    // (otherwise a low-value expiring player is never decided and BBGM asks before free agency).
    // ...and for your own players whose contracts end this season or next (re-sign risk alerts).
    const expSoon = all.filter((p) => p.tid === userTid && p.contract && p.contract.exp <= season + 1 && !negPids.has(p.pid));
    const rowOf = new Map(players.map((r) => [r.pid, r]));
    for (const [p, row] of [...fas.filter(([q], i) => i < 80 || negPids.has(q.pid)), ...expSoon.map((p) => [p, rowOf.get(p.pid)])]) {
      if (!row) continue;
      try { const m = await bbgm.player.moodInfo(p, userTid); row.mood = { willing: !!m.willing, contractAmount: m.contractAmount, probWilling: typeof m.probWilling === "number" ? m.probWilling : null, traits: m.traits || [] }; } catch (e) {}
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
    /** Expansion draft protection info for the user's team (read-only). */
    expansionInfo: () => evalJSON(`
      const g = bbgm.g, tid = g.get("userTid"), ed = g.get("expansionDraft") || {};
      const ps = await bbgm.idb.cache.players.indexGetAll("playersByTid", tid);
      console.log(JSON.stringify({ tid, phase: ed.phase || null, num: Number(ed.numProtectedPlayers) || 0,
        protectedPids: (ed.protectedPids && ed.protectedPids[tid]) || [], expansionTids: ed.expansionTids || [], pids: ps.map((p) => p.pid) }));`, 15000),
    /**
     * Teams you can take over after being fired (read-only). Mirrors BBGM's New Team page: your old team is
     * excluded and, unless God Mode is on, only the five teams with the worst record this season are offered.
     */
    newTeamOptions: () => evalJSON(`
      const g = bbgm.g, season = g.get("season"), userTid = g.get("userTid");
      let godMode = false; try { godMode = !!g.get("godMode"); } catch (e) {}
      const teams = (await bbgm.idb.cache.teams.getAll()).filter((t) => !t.disabled && t.tid !== userTid);
      const rows = [];
      for (const t of teams) {
        const ts = (await bbgm.idb.cache.teamSeasons.indexGetAll("teamSeasonsByTidSeason", [[t.tid, season], [t.tid, season]]))[0] || {};
        const gp = (ts.won || 0) + (ts.lost || 0) + (ts.tied || 0) + (ts.otl || 0);
        rows.push({ tid: t.tid, region: t.region, name: t.name, abbrev: t.abbrev, won: ts.won || 0, lost: ts.lost || 0,
          winp: gp ? ((ts.won || 0) + 0.5 * (ts.tied || 0)) / gp : 0.5 });
      }
      rows.sort((a, b) => a.winp - b.winp);
      console.log(JSON.stringify({ godMode, userTid, teams: godMode ? rows : rows.slice(0, 5) }));`, 30000),
    /** Owner mood history for your team plus what's needed to project this season (read-only). */
    ownerInfo: () => evalJSON(`
      const g = bbgm.g, tid = g.get("userTid"), season = g.get("season");
      const opt = (k) => { try { return g.get(k); } catch (e) { return undefined; } };
      const amt = (x) => (typeof x === "number" ? x : (x && x.amount) || 0);
      const sum = (o) => (o ? Object.values(o).reduce((s, r) => s + amt(r), 0) : 0);
      const rows = (await bbgm.idb.cache.teamSeasons.indexGetAll("teamSeasonsByTidSeason", [[tid, 0], [tid, 9999]]))
        .map((r) => ({ season: r.season, ownerMood: r.ownerMood || null, won: r.won || 0, lost: r.lost || 0, tied: r.tied || 0, otl: r.otl || 0,
          prw: r.playoffRoundsWon ?? -1, profit: (sum(r.revenues) - sum(r.expenses)) / 1000 }));
      let rounds = 4; try { rounds = (g.get("numGamesPlayoffSeries", "current") || []).length; } catch (e) {}
      console.log(JSON.stringify({ tid, season, phase: g.get("phase"), rows, rounds, gracePeriodEnd: opt("gracePeriodEnd"), godMode: !!opt("godMode"),
        budget: opt("budget") !== false, numGames: opt("numGames") || 82, salaryCap: opt("salaryCap") || 90000,
        challengeFiredLuxuryTax: !!opt("challengeFiredLuxuryTax"), challengeFiredMissPlayoffs: !!opt("challengeFiredMissPlayoffs") }));`, 30000),
    /** The current playoff bracket round (read-only). */
    playoffInfo: () => evalJSON(`
      const season = bbgm.g.get("season");
      const ps = await bbgm.idb.cache.playoffSeries.get(season);
      const side = (x) => (x ? { tid: x.tid, seed: x.seed, won: x.won || 0 } : null);
      console.log(JSON.stringify(ps ? { currentRound: ps.currentRound, series: (ps.series[ps.currentRound] || []).map((m) => ({ home: side(m.home), away: side(m.away) })) } : { currentRound: null, series: [] }));`, 15000),
    /** Trades between teams over the last two seasons (read-only), for rival tendencies. */
    tradeEvents: () => evalJSON(`
      const season = bbgm.g.get("season");
      let ev = []; try { ev = await bbgm.idb.cache.events.getAll(); } catch (e) {}
      console.log(JSON.stringify({ events: ev.filter((e) => e.type === "trade" && e.season >= season - 2).map((e) => ({ season: e.season, tids: e.tids || [], pids: e.pids || [] })).slice(-400) }));`, 30000),
    /** Franchise history: players drafted by or who played for your team, active and retired (read-only). */
    legacy: () => evalJSON(`
      const g = bbgm.g, tid = g.get("userTid");
      let ps = [];
      try { ps = await bbgm.idb.getCopies.players({ activeAndRetired: true }); } catch (e) { ps = await bbgm.idb.cache.players.getAll(); }
      const out = [];
      for (const p of ps) {
        const st = (p.stats || []).filter((s) => !s.playoffs);
        const ours = st.filter((s) => s.tid === tid);
        const drafted = p.draft && p.draft.tid === tid;
        if (!drafted && ours.reduce((t, s) => t + (s.gp || 0), 0) < 41) continue;
        const sum = (rows, k) => rows.reduce((t, s) => t + (s[k] || 0), 0);
        const aw = {}; for (const a of p.awards || []) if (a && a.type) aw[a.type] = (aw[a.type] || 0) + 1;
        const ovrs = (p.ratings || []).map((r) => r.ovr);
        out.push({ pid: p.pid, name: p.firstName + " " + p.lastName, tid: p.tid, retired: p.tid === bbgm.PLAYER.RETIRED, hof: !!p.hof,
          draft: p.draft ? { year: p.draft.year, round: p.draft.round, pick: p.draft.pick, tid: p.draft.tid } : null, drafted,
          seasonsWithUs: new Set(ours.map((s) => s.season)).size, gpUs: sum(ours, "gp"), ptsUs: sum(ours, "pts"), gp: sum(st, "gp"), pts: sum(st, "pts"),
          peak: ovrs.length ? Math.max(...ovrs) : null, awards: aw });
      }
      out.sort((a, b) => (Object.values(b.awards).reduce((s, x) => s + x, 0) * 500 + b.pts) - (Object.values(a.awards).reduce((s, x) => s + x, 0) * 500 + a.pts));
      console.log(JSON.stringify({ tid, players: out.slice(0, 40) }));`, 180000),
    /** Health check: which allow-listed BBGM actions exist in this version of the game (read-only). */
    capabilities: (names) => evalJSON(`
      const api = bbgm.api || {}, want = ${JSON.stringify(names || [])}, have = {};
      for (const n of want) { const [cat, fn] = n.split("."); have[n] = !!(api[cat] && typeof api[cat][fn] === "function"); }
      console.log(JSON.stringify({ have, version: (globalThis.bbgmVersion || null) }));`, 15000),
    readTrade: () => evalJSON(`const tr = await bbgm.idb.cache.trade.get(0); console.log(JSON.stringify({ teams: tr ? tr.teams : null }));`, 15000),
    /** Every active team's season records from `from` to `to` (read-only), for the Autopilot summary. */
    history: (from, to) => evalJSON(`
      const g = bbgm.g, nr = (g.get("numGamesPlayoffSeries") || []).length;
      const get = async (tid) => {
        try { return await bbgm.idb.merged.teamSeasons.getAll({ tid, seasons: [${Number(from)}, ${Number(to)}] }); }
        catch (e) { return await bbgm.idb.getCopies.teamSeasons({ tid, seasons: [${Number(from)}, ${Number(to)}] }); }
      };
      const amt = (x) => (typeof x === "number" ? x : (x && x.amount) || 0);
      const tids = (await bbgm.idb.cache.teams.getAll()).filter((t) => !t.disabled).map((t) => t.tid);
      const rows = [];
      for (const tid of tids) for (const r of await get(tid)) rows.push({ tid, season: r.season, won: r.won || 0, lost: r.lost || 0, tied: r.tied || 0, otl: r.otl || 0, prw: r.playoffRoundsWon ?? -1, salary: amt(r.expenses && r.expenses.salary) });
      console.log(JSON.stringify({ userTid: g.get("userTid"), nr, rows }));`, 120000),
  };
})(globalThis);
