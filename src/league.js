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
  const PH = { PRESEASON: 0, REGULAR_SEASON: 1, AFTER_TRADE_DEADLINE: 2, PLAYOFFS: 3, DRAFT_LOTTERY: 4, DRAFT: 5, AFTER_DRAFT: 6, RESIGN_PLAYERS: 7, FREE_AGENCY: 8 };
  const PL = { FREE_AGENT: -1, UNDRAFTED: -2, UNDRAFTED_2: -4, UNDRAFTED_3: -5 };
  const DISCOUNT = { contend: 0.55, balanced: 0.75, rebuild: 0.9 };
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

  async function build(snap, settings, onProgress) {
    const ga = snap.ga || {};
    const teams = new Map(snap.teams.map((t) => [t.tid, t]));
    const ctx = {
      season: snap.season, userTid: snap.userTid, godMode: !!ga.godMode,
      multiTeam: Array.isArray(ga.userTids) && ga.userTids.length > 1,
      realPlayerDeterminism: Number(ga.realPlayerDeterminism) || 0, teams,
    };
    const user = teams.get(snap.userTid);
    let mode = settings.teamMode || "auto";
    if (mode === "auto") mode = user && user.strategy === "rebuilding" ? "rebuild" : user && user.strategy === "contending" ? "contend" : "balanced";
    const d = DISCOUNT[mode] || 0.75;
    const dDraft = Math.max(d, 0.85);
    const maxContract = ga.maxContract || 50000;

    const byPid = new Map();
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
      const path = res.fc.meanPath;
      const disc = (dd) => path.slice(0, YEARS).reduce((s, x, y) => s + x.w * Math.pow(dd, y), 0);
      const prospect = p.tid === PL.UNDRAFTED || p.tid === PL.UNDRAFTED_2 || p.tid === PL.UNDRAFTED_3;
      const talent = prospect ? disc(dDraft) : disc(d);
      byPid.set(p.pid, {
        p, summary: res.summary, fc: res.fc, fog: res.fog, prospect,
        talent, talentBal: disc(0.75), draftTalent: disc(dDraft),
        market: (p.tid === snap.userTid || !settings.respectFog ? p.value : p.valueFuzz) || 0,
      });
      if (++i % 40 === 0) { onProgress && onProgress(i / snap.players.length); await yieldUI(); }
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
    const draftSeason = snap.phase > PH.DRAFT ? snap.season + 1 : snap.season;
    const classCurve = (year) => [...byPid.values()].filter((v) => v.prospect && v.p.draft && v.p.draft.year === year)
      .map((v) => v.draftTalent).sort((a, b) => b - a);
    const curveNow = classCurve(draftSeason);
    const numTeams = snap.teams.length;
    const record = (t) => (t.won + 0.5 * (t.tied || 0)) / Math.max(1, t.won + t.lost + (t.tied || 0) + (t.otl || 0));
    const worstFirst = [...snap.teams].sort((a, b) => record(a) - record(b)).map((t) => t.tid);
    const genericCurve = (slot) => Math.max(1, 60 * Math.exp(-slot / 9));
    const liveOrder = (snap.order || []).map((x) => x.dpid);
    function pickValue(dp) {
      const live = liveOrder.indexOf(dp.dpid);
      if (live >= 0) return curveNow[live] ?? genericCurve(live + 1); // draft in progress: remaining board
      const offset = Math.max(0, dp.season - draftSeason);
      let slot = dp.pick > 0 ? dp.pick : worstFirst.indexOf(dp.originalTid) + 1 || Math.ceil(numTeams / 2);
      if (offset > 0) slot = Math.round((slot + numTeams / 2) / 2); // regress future picks toward the middle
      const overall = (dp.round - 1) * numTeams + slot;
      const curve = offset === 0 ? curveNow : classCurve(dp.season);
      const v = curve.length >= overall ? curve[overall - 1] : genericCurve(overall);
      return v * Math.pow(d, offset);
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

    return { snap, settings, byPid, mode, d, teams, user, capInfo, pickValue, assetValue, roster, draftSeason, PH, PL, costOf };
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
  /** How a trade changes the user's team rating now and over the next two seasons. */
  function tradeImpact(L, teams) {
    const [u, o] = teams;
    const before = L.snap.players.filter((p) => p.tid === L.snap.userTid).map((p) => p.pid);
    const after = before.filter((pid) => !u.pids.includes(pid)).concat(o.pids);
    const healthy = (pid) => { const v = L.byPid.get(pid); return !(v && v.p.injury && v.p.injury.gamesRemaining > 10); };
    const mov = (pids, y) => teamMov(pids.filter((pid) => y > 0 || healthy(pid)).map((pid) => ovrAt(L, pid, y)));
    const now = mov(after, 0) - mov(before, 0);
    const future = (mov(after, 1) - mov(before, 1) + mov(after, 2) - mov(before, 2)) / 2;
    const value = tradeGain(L, teams);
    const games = (L.snap.ga && L.snap.ga.numGames) || 82;
    const winsPerMov = games * 0.033; // ~2.7 wins per point of MOV over 82 games
    let score;
    if (L.mode === "contend") score = now;
    else if (L.mode === "rebuild") score = future;
    else score = (now + future) / 2;
    return { now, future, value, score, winsNow: now * winsPerMov, winsFuture: future * winsPerMov };
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
