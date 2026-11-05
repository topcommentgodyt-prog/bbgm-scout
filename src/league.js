/*
 * BBGM Scout – league-wide valuation.
 *
 * Turns a live snapshot (from bridge.js) into a value for every player and
 * draft pick, from the point of view of your team's timeline:
 *   talent  = Σ discount^year × expected on-court value that year (from the forecast)
 *   cost    = Σ discount^year × salary cost while under contract
 *   surplus = talent − cost   (what trades, signings and cuts optimise)
 * "Market" value is BBGM's own player value (fuzzed when scouting fog applies),
 * which is what the AI teams use. Hidden gems are where the two disagree.
 */
(function (root) {
  "use strict";
  const A = root.BBGMScoutAnalyze;
  const SG = root.BBGMScoutStrategy;
  const PH = { PRESEASON: 0, REGULAR_SEASON: 1, AFTER_TRADE_DEADLINE: 2, PLAYOFFS: 3, DRAFT_LOTTERY: 4, DRAFT: 5, AFTER_DRAFT: 6, RESIGN_PLAYERS: 7, FREE_AGENCY: 8 };
  const PL = { FREE_AGENT: -1, UNDRAFTED: -2, UNDRAFTED_2: -4, UNDRAFTED_3: -5 };
  const DISCOUNT = { contend: 0.55, balanced: 0.75, rebuild: 0.9 }; // legacy timelines (kept for reference)
  const COST_K = 17; // value units per season of a max contract
  const YEARS = 8;
  const SIMS = 150;

  const fcCache = new Map(); // key -> {summary, fc}

  function percentileRanker(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return (v) => {
      if (sorted.length < 2) return 50;
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const m = (lo + hi) >> 1; sorted[m] < v ? (lo = m + 1) : (hi = m); }
      return (100 * lo) / (sorted.length - 1);
    };
  }

  const yieldUI = () => new Promise((r) => setTimeout(r, 0));

  /**
   * opts.strategyStored: the last Auto strategy decision for this league ({ key, cp, ... }), for hysteresis.
   * The result's `strategy` says which strategy is active, why, and whether Auto just changed it.
   */
  async function build(snap, settings, onProgress, opts = {}) {
    const ga = snap.ga || {};
    const teams = new Map(snap.teams.map((t) => [t.tid, t]));
    const ctx = {
      season: snap.season, userTid: snap.userTid, godMode: !!ga.godMode,
      multiTeam: Array.isArray(ga.userTids) && ga.userTids.length > 1,
      realPlayerDeterminism: Number(ga.realPlayerDeterminism) || 0, teams,
    };
    const user = teams.get(snap.userTid);
    const maxContract = ga.maxContract || 50000;

    // Pass 1: forecasts (cached per player and season). Older seasons are dropped so 100-season runs stay small.
    if (fcCache.size > 4 * snap.players.length + 500) {
      for (const k of fcCache.keys()) if (Number(k.split(":")[1]) < snap.season) fcCache.delete(k);
    }
    const fcs = [];
    let i = 0;
    for (const p of snap.players) {
      if (!p.ratings || !p.ratings.length) continue;
      const cur = p.ratings[p.ratings.length - 1];
      const key = `${p.pid}:${cur.season}:${cur.ovr}:${cur.fuzz}:${p.tid === snap.userTid}:${settings.respectFog}`;
      let res = fcCache.get(key);
      if (!res) {
        const age = cur.season - p.born.year;
        try {
          res = A.analyze(ctx, p, settings, { nSims: SIMS, full: false, maxAge: Math.min(40, age + YEARS) });
        } catch (e) { continue; }
        fcCache.set(key, res);
      }
      fcs.push([p, res]);
      if (++i % 40 === 0) { onProgress && onProgress(0.8 * i / snap.players.length); await yieldUI(); }
    }
    const fcOf = new Map(fcs.map(([p, res]) => [p.pid, res]));
    const ovrIn = (pid, y) => { const r = fcOf.get(pid); if (!r) return 0; if (y === 0) return r.summary.ovr; const pt = r.fc.meanPath[y]; return pt ? pt.ovr : r.fc.meanPath[r.fc.meanPath.length - 1].ovr; };

    // Team strength now and in two seasons (shown ratings only), for the strategy brain and pick values.
    const activeTeams = snap.teams.map((t) => t.tid);
    const rosterPids = new Map(activeTeams.map((tid) => [tid, []]));
    for (const p of snap.players) if (rosterPids.has(p.tid)) rosterPids.get(p.tid).push(p);
    const movAt = (tid, y) => teamMov(rosterPids.get(tid).filter((p) => y > 0 || !(p.injury && p.injury.gamesRemaining > 20)).map((p) => ovrIn(p.pid, y)));
    const movNow = new Map(activeTeams.map((tid) => [tid, movAt(tid, 0)]));
    const mov2 = new Map(activeTeams.map((tid) => [tid, movAt(tid, 2)]));
    const pctOf = (m, tid) => activeTeams.length < 2 ? 0.5 : activeTeams.filter((x) => x !== tid && m.get(x) < m.get(tid)).length / (activeTeams.length - 1);

    // Strategy features for the user's team.
    const numGames = ga.numGames || 82;
    const gpOf = (t) => (t ? t.won + t.lost + (t.tied || 0) + (t.otl || 0) : 0);
    const recOf = (t) => (t.won + 0.5 * (t.tied || 0)) / Math.max(1, gpOf(t));
    const mine = (rosterPids.get(snap.userTid) || []).map((p) => ({ p, ovr: ovrIn(p.pid, 0) })).sort((a, b) => b.ovr - a.ovr);
    const top5 = mine.slice(0, 5);
    const starterOvr = mine[4] ? mine[4].ovr : 50;
    const draftSeason = snap.phase > PH.DRAFT ? snap.season + 1 : snap.season;
    const nextSeason = snap.phase > PH.PLAYOFFS ? snap.season + 1 : snap.season;
    const committedNext = mine.filter((x) => x.p.contract && x.p.contract.exp >= nextSeason + (snap.phase > PH.PLAYOFFS ? 0 : 1)).reduce((s, x) => s + x.p.contract.amount, 0);
    const features = {
      rankNow: pctOf(movNow, snap.userTid), rankFuture: pctOf(mov2, snap.userTid),
      winPct: user && gpOf(user) >= 10 ? recOf(user) : null, gp: gpOf(user), numGames,
      coreAge: top5.length ? top5.reduce((s, x) => s + (snap.season - x.p.born.year), 0) / top5.length : 27,
      capRoomPct: ga.salaryCap ? (ga.salaryCap - committedNext) / ga.salaryCap : 0,
      firsts: snap.draftPicks.filter((d) => d.tid === snap.userTid && d.round === 1 && d.season >= draftSeason && d.season <= draftSeason + 1).length,
      youngCore: mine.filter((x) => snap.season - x.p.born.year <= 24 && ovrIn(x.p.pid, 2) >= starterOvr).length,
    };
    const cp = SG.checkpoint(snap.season, snap.phase, gpOf(user), numGames);
    const res = SG.resolve(settings.teamMode || "auto", features, cp, opts.strategyStored || null);
    const strat = SG.STRATEGIES[res.key];
    const mode = strat.mode;
    const strategy = { key: res.key, label: strat.label, goal: strat.goal, mode, auto: res.auto, changed: res.changed, decision: res.decision, reasons: res.reasons, features, cp };
    const d = strat.d;
    // Risk preference is separate from the timeline. "auto": contenders favour reliability, rebuilders upside.
    let risk = settings.riskPref || "auto";
    if (risk === "auto") risk = mode === "contend" ? "conservative" : mode === "rebuild" ? "upside" : "balanced";
    const dDraft = Math.max(d, 0.85);

    // Pass 2: values for the active strategy.
    const byPid = new Map();
    for (const [p, res] of fcs) {
      const path = res.fc.meanPath;
      // Risk preference blends the average outcome with the floor (conservative) or ceiling (upside).
      const wOf = (x) => (risk === "conservative" ? 0.6 * x.w + 0.4 * x.wLo : risk === "upside" ? 0.6 * x.w + 0.4 * x.wHi : x.w);
      const disc = (dd, neutral) => path.slice(0, YEARS).reduce((s, x, y) => s + (neutral ? x.w : wOf(x)) * Math.pow(dd, y), 0);
      const prospect = p.tid === PL.UNDRAFTED || p.tid === PL.UNDRAFTED_2 || p.tid === PL.UNDRAFTED_3;
      const talent = prospect ? disc(dDraft) : disc(d);
      byPid.set(p.pid, {
        p, summary: res.summary, fc: res.fc, fog: res.fog, prospect,
        talent, talentBal: disc(0.75, true), draftTalent: disc(dDraft), draftTalentNeutral: disc(dDraft, true),
        floor: path.slice(0, YEARS).reduce((s, x, y) => s + x.wLo * Math.pow(dDraft, y), 0),
        upside: path.slice(0, YEARS).reduce((s, x, y) => s + x.wHi * Math.pow(dDraft, y), 0),
        market: (p.tid === snap.userTid || !settings.respectFog ? p.value : p.valueFuzz) || 0,
      });
    }

    // Contract cost, given an amount (thousands) running through `exp`.
    const costOf = (amount, exp) => {
      let c = 0;
      for (let s = snap.season, y = 0; s <= exp && y < YEARS; s++, y++) c += Math.pow(d, y) * COST_K * (amount / maxContract);
      return c;
    };
    for (const v of byPid.values()) {
      v.cost = v.prospect ? 0 : costOf(v.p.contract ? v.p.contract.amount : 0, v.p.contract ? v.p.contract.exp : snap.season);
      v.surplus = v.talent - v.cost;
    }

    // Percentiles within comparable pools: active players, and each draft class.
    const pools = new Map();
    for (const v of byPid.values()) {
      const k = v.prospect ? `draft${v.p.draft ? v.p.draft.year : "?"}` : "active";
      if (!pools.has(k)) pools.set(k, []);
      pools.get(k).push(v);
    }
    for (const list of pools.values()) {
      const ourR = percentileRanker(list.map((v) => v.talentBal));
      const mktR = percentileRanker(list.map((v) => v.market));
      const surR = percentileRanker(list.map((v) => v.talentBal - (v.cost || 0)));
      for (const v of list) {
        v.ourPct = ourR(v.talentBal);
        v.marketPct = mktR(v.market);
        v.surplusPct = surR(v.talentBal - (v.cost || 0));
        v.gemScore = v.ourPct - v.marketPct + (v.prospect ? 0 : 0.5 * (v.surplusPct - v.ourPct));
      }
    }

    // Draft pick values: the k-th best prospect (by our model) in the class the pick will select from.
    const classCurve = (year) => [...byPid.values()].filter((v) => v.prospect && v.p.draft && v.p.draft.year === year)
      .map((v) => v.draftTalent).sort((a, b) => b - a);
    const curveNow = classCurve(draftSeason);
    const numTeams = snap.teams.length;
    const genericCurve = (slot) => Math.max(1, 60 * Math.exp(-slot / 9));
    // Projected strength of each original team: early in a season mostly roster strength, later mostly the record.
    const recW = Math.min(0.8, gpOf(user) / numGames);
    const strengthFor = (tid, offset) => {
      const t = teams.get(tid);
      const rosterPct = offset > 0 ? 0.5 * pctOf(movNow, tid) + 0.5 * pctOf(mov2, tid) : pctOf(movNow, tid);
      if (!t || offset > 0 || snap.phase > PH.PLAYOFFS) return rosterPct;
      const recPct = activeTeams.filter((x) => x !== tid && teams.get(x) && recOf(teams.get(x)) < recOf(t)).length / Math.max(1, activeTeams.length - 1);
      return recW * recPct + (1 - recW) * rosterPct;
    };
    const liveOrder = (snap.order || []).map((x) => x.dpid);
    const curveCache = new Map();
    function pickValue(dp) {
      const live = liveOrder.indexOf(dp.dpid);
      if (live >= 0) return curveNow[live] ?? genericCurve(live + 1); // draft in progress: remaining board
      const offset = Math.max(0, dp.season - draftSeason);
      if (!curveCache.has(dp.season)) {
        // Future classes aren't fully known: blend with this year's class as an "average class".
        const fut = offset === 0 ? curveNow : classCurve(dp.season);
        curveCache.set(dp.season, (overall) => {
          const a = curveNow[overall - 1], b = fut[overall - 1];
          if (offset === 0) return a ?? genericCurve(overall);
          if (a != null && b != null) return 0.5 * a + 0.5 * b;
          return a ?? b ?? genericCurve(overall);
        });
      }
      const curve = curveCache.get(dp.season);
      // Picks aren't discounted like player value (that would make contenders give away future firsts):
      // they use the long-horizon draft discount.
      const disc = Math.pow(dDraft, offset);
      if (dp.pick > 0) return curve((dp.round - 1) * numTeams + dp.pick) * disc;
      // Slot unknown: a range of slots around the projected one; wider for later years, early in the season,
      // and for lottery picks (projected standings don't guarantee a lottery position).
      const projSlot = 1 + (numTeams - 1) * strengthFor(dp.originalTid, offset);
      const lottery = snap.ga && snap.ga.draftType && snap.ga.draftType !== "noLottery" ? 2 : 0;
      const sd = 2 + 3 * offset + 3 * (1 - recW) + (projSlot <= numTeams / 3 ? lottery : 0);
      return SG.expectedPickValue({ projSlot, sd, round: dp.round, numTeams, curve }) * disc;
    }

    const roster = (tid) => snap.players.filter((p) => p.tid === tid);
    const userRoster = roster(snap.userTid);
    const payroll = user ? user.payroll : 0;
    const capInfo = {
      cap: ga.salaryCap, type: ga.salaryCapType || "soft", payroll, space: (ga.salaryCap || 0) - payroll,
      minContract: ga.minContract || 750, maxContract, maxRoster: ga.maxRosterSize || 15, minRoster: ga.minRosterSize || 13,
      rosterSize: userRoster.length,
    };
    const valueOf = (pid) => (byPid.get(pid) ? byPid.get(pid).surplus : 0);
    const assetValue = (pids = [], dpids = []) =>
      pids.reduce((s, pid) => s + valueOf(pid), 0) +
      dpids.reduce((s, dpid) => { const dp = snap.draftPicks.find((x) => x.dpid === dpid); return s + (dp ? pickValue(dp) : 0); }, 0);

    return { snap, settings, byPid, mode, strategy, risk, d, teams, user, capInfo, pickValue, assetValue, roster, draftSeason, nextSeason, PH, PL, costOf, movNow, mov2 };
  }

  /** BBGM's team rating: predicted margin of victory from the top 10 OVRs (regular-season weights). */
  function teamMov(ovrs) {
    const r = [...ovrs].sort((a, b) => b - a).slice(0, 10);
    while (r.length < 10) r.push(0);
    return -102.98 + r.reduce((s, o, i) => s + 0.3334 * Math.exp(-0.1609 * i) * o, 0);
  }
  /** Expected OVR of a player `y` seasons from now (0 = today, as shown to you). */
  function ovrAt(L, pid, y) {
    const v = L.byPid.get(pid);
    if (!v) return 0;
    if (y === 0) return v.summary.ovr;
    const pt = v.fc.meanPath[y];
    return pt ? pt.ovr : v.fc.meanPath[v.fc.meanPath.length - 1].ovr;
  }
  /**
   * How a trade changes the user's team over several seasons, scored for the active strategy:
   * team rating now and in each of the next two seasons, long-term value, contracts (payroll over the
   * next three seasons against the cap or tax line), draft picks, young talent, aging risk and roster fit.
   */
  function tradeImpact(L, teams) {
    const [u, o] = teams;
    const before = L.snap.players.filter((p) => p.tid === L.snap.userTid).map((p) => p.pid);
    const after = before.filter((pid) => !u.pids.includes(pid)).concat(o.pids);
    const healthy = (pid) => { const v = L.byPid.get(pid); return !(v && v.p.injury && v.p.injury.gamesRemaining > 10); };
    const mov = (pids, y) => teamMov(pids.filter((pid) => y > 0 || healthy(pid)).map((pid) => ovrAt(L, pid, y)));
    const now = mov(after, 0) - mov(before, 0);
    const y1 = mov(after, 1) - mov(before, 1), y2 = mov(after, 2) - mov(before, 2);
    const future = (y1 + y2) / 2;
    const value = tradeGain(L, teams);
    const games = (L.snap.ga && L.snap.ga.numGames) || 82;
    const winsPerMov = games * 0.033; // ~2.7 wins per point of MOV over 82 games

    const V = (pid) => L.byPid.get(pid);
    const ageOf = (pid) => { const v = V(pid); return v ? v.summary.age : 0; };
    const youthVal = (pids) => pids.filter((pid) => ageOf(pid) <= 23).reduce((s, pid) => s + (V(pid) ? V(pid).draftTalentNeutral : 0), 0);
    const pickVal = (dpids) => dpids.reduce((s, dpid) => { const dp = L.snap.draftPicks.find((x) => x.dpid === dpid); return s + (dp ? L.pickValue(dp) : 0); }, 0);
    const decline = (pids) => pids.filter((pid) => ageOf(pid) >= 30).reduce((s, pid) => s + Math.max(0, ovrAt(L, pid, 0) - ovrAt(L, pid, 2)), 0);
    const youthNet = youthVal(u.pids) - youthVal(o.pids);
    const picksNet = pickVal(u.dpids) - pickVal(o.dpids);
    const agingNet = decline(o.pids) - decline(u.pids);
    const rosterAfter = after.length;
    const overflow = Math.max(0, rosterAfter - L.capInfo.maxRoster);

    // Contracts: payroll for each of the next three seasons vs the limit that matters in this league.
    const ga = L.snap.ga || {};
    const limit = L.capInfo.type === "hard" ? L.capInfo.cap : ga.luxuryPayroll || L.capInfo.cap || 0;
    const payFor = (pids, s) => pids.reduce((t, pid) => { const v = V(pid); return t + (v && v.p.contract && v.p.contract.exp >= s ? v.p.contract.amount : 0); }, 0);
    let payrollOver = 0;
    const payroll = [];
    for (let k = 0; k < 3; k++) {
      const s = L.nextSeason + k;
      const b = payFor(before, s), a = payFor(after, s);
      payroll.push({ season: s, before: b, after: a });
      if (limit) payrollOver += Math.max(0, a - limit) / 1000 - Math.max(0, b - limit) / 1000; // only new overage counts
    }
    payrollOver = Math.max(0, payrollOver);

    const strat = (L.strategy && L.strategy.key) || (L.mode === "contend" ? "contend" : L.mode === "rebuild" ? "rebuild" : "develop");
    const parts = { now, future, value, youthNet, picksNet, agingNet, overflow, payrollOver };
    const sc = SG.tradeScore(strat, parts);
    return { now, y1, y2, future, value, score: sc.score, scoreParts: sc, youthNet, picksNet, agingNet, rosterAfter, overflow, payroll, payrollOver,
      strategy: strat, winsNow: now * winsPerMov, winsFuture: future * winsPerMov };
  }

  /** Our net gain for the user's team from a two-team trade ([user, other]). */
  function tradeGain(L, teams) {
    const [u, o] = teams;
    return L.assetValue(o.pids, o.dpids) - L.assetValue(u.pids, u.dpids);
  }

  function name(L, pid) {
    const v = L.byPid.get(pid);
    return v ? `${v.p.firstName} ${v.p.lastName}` : `#${pid}`;
  }
  function pickName(L, dpid) {
    const dp = L.snap.draftPicks.find((x) => x.dpid === dpid);
    if (!dp) return `pick #${dpid}`;
    const t = L.teams.get(dp.originalTid);
    return `${dp.season} ${dp.round === 1 ? "1st" : dp.round === 2 ? "2nd" : `R${dp.round}`}${t ? ` (${t.abbrev})` : ""}${dp.pick > 0 ? ` #${dp.pick}` : ""}`;
  }

  root.BBGMScoutLeague = { build, tradeGain, tradeImpact, teamMov, ovrAt, name, pickName, PH, PL, DISCOUNT };
})(globalThis);
