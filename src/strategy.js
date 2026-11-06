/*
 * Courtside – Franchise Strategy Brain, trade scoring and move memory.
 *
 * Pure functions (no DOM, no BBGM calls), so they run in the page and in Node tests.
 *
 *  - Five strategies: Rebuild, Develop, Contend, Win Now (+ Auto, which picks one).
 *    Each has one multi-season objective (weights on "now" vs the next two seasons, a value
 *    discount, and penalties for giving up youth or picks, or taking on aging players).
 *  - Auto re-decides only at checkpoints (start of season, mid-season, offseason) and uses
 *    hysteresis, so a short slump or hot streak doesn't flip the plan.
 *  - Trade scoring combines team rating now and later, long-term value, contracts, draft-pick
 *    opportunity cost, youth given up, aging risk and roster fit, weighted by the strategy.
 *  - Move memory: no retrying rejected (or nearly identical) deals for a few game days.
 */
(function (root) {
  "use strict";

  const STRATEGIES = {
    rebuild: { key: "rebuild", label: "Rebuild", mode: "rebuild", d: 0.9, wNow: 0.1, wFuture: 0.9, youth: 1, picks: 1, aging: 0.2,
      goal: "maximize team rating two or more seasons out; collect young talent and picks" },
    develop: { key: "develop", label: "Develop", mode: "balanced", d: 0.8, wNow: 0.35, wFuture: 0.65, youth: 0.6, picks: 0.5, aging: 0.4,
      goal: "grow the young core into a contender without giving up the future" },
    contend: { key: "contend", label: "Contend", mode: "contend", d: 0.65, wNow: 0.65, wFuture: 0.35, youth: 0.25, picks: 0.25, aging: 0.6,
      goal: "win as many games as possible this season and next" },
    winnow: { key: "winnow", label: "Win Now", mode: "contend", d: 0.5, wNow: 0.9, wFuture: 0.1, youth: 0, picks: 0, aging: 1,
      goal: "maximize this season's title chances; aging risk is still priced in" },
  };
  const ORDER = ["rebuild", "develop", "contend", "winnow"];
  const BOUNDS = [0.38, 0.55, 0.72]; // strength cutoffs: rebuild | develop | contend | (contend or win now)
  const MARGIN = 0.05; // hysteresis: a strategy is kept until strength clears its band by this much
  const RECENT_MARGIN = 0.12; // ...and by more if Auto already changed strategy within the last season

  /**
   * How BBGM's difficulty setting changes the plan. BBGM's values: Easy −0.25, Normal 0, Hard 0.25, Insane 1
   * (custom values in between are allowed). Higher difficulty makes the trade AI ask more from you and makes
   * players less willing to sign with you and costlier to re-sign, so:
   *  - keep:    young players, picks and long-term value you already own are worth more (harder to replace)
   *  - minNow:  for Contend / Win Now, good trades are rarer, so a smaller real gain is accepted
   *  - shift:   Auto needs a stronger roster before it contends (in-season upgrades are expensive)
   * Easy is the reverse: talent is cheap to buy, so the manager trades more freely and is pickier about each deal.
   */
  function difficultyProfile(diff) {
    const raw = Number(diff);
    const x = Number.isFinite(raw) ? Math.max(-0.5, Math.min(1.5, raw)) : 0;
    const label = x <= -0.125 ? "Easy" : x < 0.125 ? "Normal" : x < 0.625 ? "Hard" : "Insane";
    const keep = 1 + 0.6 * x; // Easy 0.85, Hard 1.15, Insane 1.6
    const minNow = Math.max(0.75, Math.min(1.15, 1 - 0.25 * x)); // Easy 1.06, Hard 0.94, Insane 0.75
    const shift = 0.06 * x; // Easy −0.015, Hard +0.015, Insane +0.06
    const note = label === "Normal" ? null
      : label === "Easy" ? "difficulty Easy: talent is cheap to buy, so trades are made more freely and each must clear a slightly higher bar"
      : `difficulty ${label}: trades and free agents cost more, so young players and picks you own are valued ${Math.round((keep - 1) * 100)}% higher${x >= 0.625 ? " and contending needs a stronger roster" : ""}`;
    return { diff: x, label, keep, minNow, shift, note };
  }
  const NORMAL = difficultyProfile(0);

  /** Normalizes the teamMode setting. Legacy "balanced" maps to Develop. */
  function manualChoice(teamMode) {
    if (teamMode === "balanced") return "develop";
    return STRATEGIES[teamMode] ? teamMode : null; // null = auto
  }

  /**
   * Which checkpoint a game state belongs to. Auto strategy is only re-evaluated when this changes:
   * start of season (preseason / first half), mid-season (second half, around the trade deadline,
   * playoffs) and the offseason (lottery onward).
   */
  function checkpoint(season, phase, gp, numGames) {
    const half = (numGames || 82) / 2;
    if (phase === 0 || (phase === 1 && gp < half)) return `${season}:start`;
    if (phase <= 3) return `${season}:mid`;
    return `${season}:off`;
  }

  /**
   * Team strength from features, all 0..1 percentiles (1 = best in the league):
   *   rankNow, rankFuture (projected team rating in two seasons), winPct (null early in a season).
   */
  function strength(f) {
    // The record counts more as the season goes on (up to 20% at mid-season), so a few games can't swing it.
    const w = f.winPct == null ? 0 : Math.min(1, (f.gp || 0) / Math.max(1, (f.numGames || 82) * 0.5)) * 0.2;
    return (0.7 - w) * f.rankNow + 0.3 * f.rankFuture + w * f.winPct;
  }

  /**
   * Picks a strategy from roster/league features.
   * f: { rankNow, rankFuture, winPct, gp, numGames, coreAge, capRoomPct, firsts, youngCore }
   * prev: previous strategy key (for hysteresis) or null.
   */
  function choose(f, prev, margin = MARGIN, prof = NORMAL) {
    const x = strength(f);
    const pi = prev ? ORDER.indexOf(prev) : -1;
    // Harder difficulty raises the contend / win-now bands (and lowers them on Easy); Rebuild's band is kept.
    const bounds = BOUNDS.map((b, i) => (i > 0 ? b + prof.shift : b)).map((b, i) => (pi < 0 ? b : i < pi ? b - margin : b + margin));
    let idx = bounds.filter((b) => x >= b).length; // 0..3
    const closing = f.rankNow - f.rankFuture; // > 0: projected to get worse
    const aging = (f.coreAge - 27) / 5;
    // Rising young team: develop rather than tear down.
    if (idx === 0 && f.rankFuture - f.rankNow >= 0.25 && f.rankFuture >= 0.5 && f.youngCore >= 2) idx = 1;
    // Job on the line (owner mood projects a firing): a multi-season rebuild isn't an option.
    const jobRisk = f.jobRisk === "high";
    if (jobRisk && idx === 0) idx = 1;
    let key = ORDER[Math.min(idx, 2)];
    if (idx === 3) {
      // Top band: Win Now when the window is closing (aging core or worse projection), otherwise Contend.
      // Going all-in also needs a real title shot: within ~2.5 team-rating points (~7 wins) of the best team.
      const shot = f.titleGap == null || f.titleGap <= (prev === "winnow" ? 3.5 : 2.5);
      const enter = (closing > 0.1 || aging > 0.4 || jobRisk) && shot;
      const stay = (closing > 0 || aging > 0.3 || jobRisk) && shot;
      key = (prev === "winnow" ? stay : enter) ? "winnow" : "contend";
    }
    const ord = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
    const pct = (v) => ord(Math.round(v * 100));
    const reasons = [
      `team rating ${pct(f.rankNow)} percentile now, ${pct(f.rankFuture)} projected in two seasons`,
      f.winPct != null ? `record ${(f.winPct * 1000 | 0) / 1000} win%` : null,
      `core age ${f.coreAge.toFixed(1)}`,
      `${f.firsts} own first-round pick${f.firsts === 1 ? "" : "s"} in the next two drafts`,
      f.youngCore ? `${f.youngCore} young player${f.youngCore === 1 ? "" : "s"} projected to start` : null,
      `cap room next season ${Math.round(f.capRoomPct * 100)}% of the cap`,
      f.titleGap != null ? (f.titleGap <= 0 ? "best team rating in the league" : `${f.titleGap.toFixed(1)} team-rating points (~${Math.round(f.titleGap * 2.7)} wins) behind the best team`) : null,
      jobRisk ? "owner mood projects a firing: no long rebuild" : null,
      prof.note,
    ].filter(Boolean);
    return { key, strength: x, reasons };
  }

  /**
   * Resolves the strategy for this game state.
   *  teamMode: setting ("auto" or a manual strategy); f: features; cp: current checkpoint;
   *  stored: { key, cp, strength, reasons } from the last decision (or null).
   * Returns { key, auto, changed, decision } where decision is what should be stored.
   */
  function resolve(teamMode, f, cp, stored, prof = NORMAL) {
    const manual = manualChoice(teamMode);
    if (manual) return { key: manual, auto: false, changed: false, decision: stored, reasons: ["chosen by you", prof.note].filter(Boolean) };
    if (stored && stored.key && stored.cp === cp) return { key: stored.key, auto: true, changed: false, decision: stored, reasons: stored.reasons || [] };
    // Changed within the last season (3 checkpoints)? Then it takes a bigger move to change again.
    const season = Number(String(cp).split(":")[0]);
    const recent = stored && stored.changedAt != null && season - stored.changedAt <= 1;
    const c = choose(f, stored && stored.key, recent ? RECENT_MARGIN : MARGIN, prof);
    const changed = !stored || stored.key !== c.key;
    const decision = { key: c.key, cp, strength: Math.round(c.strength * 1000) / 1000, reasons: c.reasons, prev: stored ? stored.key : null,
      changedAt: stored && changed ? season : stored ? stored.changedAt ?? null : null };
    return { key: c.key, auto: true, changed, decision, reasons: c.reasons };
  }

  // ======================= Trade scoring =======================
  /**
   * Combines the parts of a trade into one score in team-rating points (MOV), weighted by strategy.
   * parts: { now, future, value, youthNet, picksNet, agingNet, overflow, payrollOver }
   *   value     – long-term value gained (Scout units)
   *   youthNet  – long-horizon value of young players given minus received (> 0 = giving up youth)
   *   picksNet  – value of picks given minus received
   *   agingNet  – expected OVR decline over two seasons of players received minus given (aged 30+)
   *   overflow  – players over the roster maximum after the trade
   *   payrollOver – $M over the payroll limit (cap or tax line) in the next three seasons, summed
   */
  function tradeScore(strat, p, prof = NORMAL) {
    const s = STRATEGIES[strat] || STRATEGIES.develop;
    // Long-term value lost is harder to win back on harder difficulties (the AI asks more in every deal).
    const valueW = 0.004 * (p.value < 0 ? prof.keep : 1);
    // Fit (weak areas, synergy, star power) helps you win now, so it counts more the more the strategy is about now.
    const fitW = 0.4 + 0.6 * s.wNow;
    const base = s.wNow * p.now + s.wFuture * p.future + valueW * p.value + fitW * (p.fit || 0);
    const youthPen = s.youth * prof.keep * Math.max(0, p.youthNet) * 0.008;
    const pickPen = s.picks * prof.keep * Math.max(0, p.picksNet) * 0.008;
    const agePen = s.aging * Math.max(0, p.agingNet) * 0.06;
    const fitPen = 1.5 * Math.max(0, p.overflow || 0) + 0.05 * Math.max(0, p.payrollOver || 0);
    return { score: base - youthPen - pickPen - agePen - fitPen, base, youthPen, pickPen, agePen, fitPen };
  }

  /** Whether a scored trade clears the bar for the strategy. min = features.js tradeBar (automatic since v3.3). */
  function tradeOk(strat, im, min, prof = NORMAL) {
    // Contend / Win Now take smaller real gains when good trades are rare (harder difficulty); everyone is
    // pickier on Easy. Rebuild and Develop keep your bar: their protection comes from valuing youth and picks more.
    const m = strat === "contend" || strat === "winnow" ? min * prof.minNow : prof.diff < 0 ? min * prof.minNow : min;
    if (!(im.score >= m)) return false;
    if (im.overflow > 0) return false;
    // How much long-term value a deal may give up shrinks on harder difficulties (it can't be bought back cheaply).
    const loss = (x) => x / prof.keep;
    switch (strat) {
      case "rebuild": return im.future >= 0 && im.value > 0;
      case "develop": return im.future >= -0.1 && im.now >= -1 && im.value > -loss(10);
      case "contend": return im.now >= 0.5 * m && im.future > -2 * m && im.value > -loss(40);
      case "winnow": return im.now >= m;
      default: return true;
    }
  }

  // ======================= Draft pick value under uncertainty =======================
  /**
   * Expected value of a pick when its slot isn't known yet: a normal distribution over slots around
   * the projected slot (sd grows with years out and early in a season), truncated to 1..numTeams.
   * curve(overall) gives the value of the overall-th pick.
   */
  function expectedPickValue({ projSlot, sd, round, numTeams, curve }) {
    let tot = 0, wsum = 0;
    for (let slot = 1; slot <= numTeams; slot++) {
      const w = Math.exp(-0.5 * ((slot - projSlot) / sd) ** 2);
      tot += w * curve((round - 1) * numTeams + slot);
      wsum += w;
    }
    return wsum ? tot / wsum : curve((round - 1) * numTeams + Math.round(projSlot));
  }

  // ======================= Move memory =======================
  /** A game clock in "days": regular season days are games played; the offseason counts as ~40 days. */
  function gameClock(season, phase, gp) {
    // Continuous across seasons: the offseason counts as a few days, so a cooldown started at the draft
    // still applies in the next preseason (it used to count as ~40 days and expire over the summer).
    return season * 130 + (phase <= 0 ? 0 : phase <= 3 ? Math.min(gp || 0, 120) : 120 + (phase - 3));
  }
  /** Players only (no picks): a deal that differs only in which picks are attached is "nearly identical". */
  const sigPlayers = (teams) => teams.map((t) => `${t.tid}:${[...t.pids].sort((a, b) => a - b).join(",")}`).join("|");
  const sigOf = (teams) => teams.map((t) => `${t.tid}:${[...t.pids].sort((a, b) => a - b).join(",")}/${[...t.dpids].sort((a, b) => a - b).join(",")}`).join("|");

  function emptyMemory() { return { acq: {}, sent: {}, rejected: {}, rejectedP: {}, fails: {} }; }

  /**
   * Returns null if the trade may be tried, or a reason it's blocked:
   *  - the same deal was rejected within the last REJECT_WINDOW game days
   *  - the same players (picks aside) were rejected twice in that window, unless the gain is significant
   */
  // Rejected deals aren't re-proposed for this many game days (the trade cooldown on players was removed in 2.8).
  const REJECT_WINDOW = 10;
  function tradeBlocked(mem, teams, clock, { score = 0, min = 0.5 } = {}) {
    if (!mem) return null;
    const recent = (t) => t != null && clock - t < REJECT_WINDOW;
    const big = score >= 3 * Math.max(0.1, min); // significant opportunity
    const rej = mem.rejected[sigOf(teams)];
    if (recent(rej)) return "the same deal was rejected recently";
    // Nearly identical: the same players were turned down twice recently (only the picks differed).
    const rp = mem.rejectedP && mem.rejectedP[sigPlayers(teams)];
    if (rp && rp.n >= 2 && recent(rp.t) && !big) return "a nearly identical deal (same players) was rejected twice recently";
    return null;
  }
  function recordTrade(mem, teams, clock) {
    const [u, o] = teams;
    for (const pid of o.pids) mem.acq[pid] = { t: clock, from: o.tid };
    for (const pid of u.pids) { mem.sent[pid] = { t: clock, to: o.tid }; delete mem.acq[pid]; }
    return mem;
  }
  function recordRejected(mem, teams, clock) {
    mem.rejected[sigOf(teams)] = clock;
    mem.rejectedP = mem.rejectedP || {};
    const k = sigPlayers(teams), prev = mem.rejectedP[k];
    mem.rejectedP[k] = { n: prev && clock - prev.t < 60 ? prev.n + 1 : 1, t: clock };
    return mem;
  }
  function recordFail(mem, sig, clock) {
    const f = mem.fails[sig] || { n: 0, t: clock };
    mem.fails[sig] = { n: clock - f.t > 60 ? 1 : f.n + 1, t: clock };
    return mem.fails[sig].n;
  }
  /** Drops entries older than ~two seasons so stored memory stays small. */
  function pruneMemory(mem, clock) {
    const keep = (t) => clock - t < 400;
    for (const k of ["acq", "sent"]) for (const id of Object.keys(mem[k])) if (!keep(mem[k][id].t)) delete mem[k][id];
    for (const id of Object.keys(mem.rejected)) if (!keep(mem.rejected[id])) delete mem.rejected[id];
    for (const id of Object.keys(mem.rejectedP || {})) if (!keep(mem.rejectedP[id].t)) delete mem.rejectedP[id];
    for (const id of Object.keys(mem.fails)) if (!keep(mem.fails[id].t)) delete mem.fails[id];
    // Hard size limit (oldest first), so 100-season runs can't grow it without bound.
    const cap = (obj, tOf, max) => { const ks = Object.keys(obj); if (ks.length <= max) return; ks.sort((a, b) => tOf(obj[a]) - tOf(obj[b])).slice(0, ks.length - max).forEach((k) => delete obj[k]); };
    cap(mem.acq, (x) => x.t, 300); cap(mem.sent, (x) => x.t, 300); cap(mem.rejected, (x) => x, 400); cap(mem.rejectedP || {}, (x) => x.t, 400); cap(mem.fails, (x) => x.t, 200);
    return mem;
  }

  // ======================= Autopilot run summary =======================
  /**
   * Summarizes an Autopilot run from observed season records (BBGM's teamSeasons) and the activity log.
   *  rows: [{ tid, season, won, lost, tied, otl, prw, salary }] for every team; nr: playoff rounds;
   *  log: activity-log entries made during the run; strategies: { season: [labels] };
   *  rosterStart/rosterEnd: user pids at start and end.
   * League averages are shown for reference only; they are not a baseline for Autopilot's effect.
   */
  function summarizeRun({ rows, userTid, nr, from, to, log = [], strategies = {}, rosterStart = [], rosterEnd = [] }) {
    const gp = (r) => r.won + r.lost + (r.tied || 0) + (r.otl || 0);
    const mine = rows.filter((r) => r.tid === userTid && r.season >= from && r.season <= to && gp(r) > 0).sort((a, b) => a.season - b.season);
    const result = (prw) => (prw < 0 ? "Missed playoffs" : prw >= nr ? "Champion" : prw === nr - 1 ? "Lost in the finals" : `Lost in round ${prw + 1}`);
    const seasons = mine.map((r) => ({ season: r.season, won: r.won, lost: r.lost + (r.otl || 0), tied: r.tied || 0, winPct: (r.won + 0.5 * (r.tied || 0)) / gp(r),
      playoffs: result(r.prw), champion: r.prw >= nr && nr > 0, made: r.prw >= 0, salary: r.salary, strategy: (strategies[r.season] || []).join(" → ") }));
    const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
    const wins = sum(mine, (r) => r.won), games = sum(mine, gp);
    const league = rows.filter((r) => r.season >= from && r.season <= to && gp(r) > 0);
    const lgWins = sum(league, (r) => r.won);
    const live = (e) => !e.undone;
    const count = (k) => log.filter((e) => e.kind === k && live(e)).length;
    const trades = log.filter((e) => e.kind === "trade" && live(e));
    const proj = trades.reduce((t, e) => { const n = e.ex && e.ex.num; return n ? { now: t.now + n.now, future: t.future + n.future, n: t.n + 1 } : t; }, { now: 0, future: 0, n: 0 });
    const end = new Set(rosterEnd);
    return {
      from, to, seasons,
      titles: seasons.filter((x) => x.champion).length,
      playoffApps: seasons.filter((x) => x.made).length,
      winPct: games ? (wins + 0.5 * sum(mine, (r) => r.tied || 0)) / games : null,
      payrollPerWin: wins ? sum(mine, (r) => r.salary) / wins : null,
      leaguePayrollPerWin: lgWins ? sum(league, (r) => r.salary) / lgWins : null, // reference only
      drafts: log.filter((e) => e.kind === "draft" && live(e)).map((e) => e.text),
      trades: { count: trades.length, projectedNow: proj.now, projectedFuture: proj.future, withNumbers: proj.n },
      moves: { signings: count("sign"), resignings: count("resign"), letWalk: count("letwalk"), releases: count("release"), errors: count("error") },
      strategyChanges: log.filter((e) => e.kind === "strategy").map((e) => e.text),
      turnover: rosterStart.filter((pid) => !end.has(pid)).length, rosterStartSize: rosterStart.length,
    };
  }

  const api = {
    STRATEGIES, ORDER, BOUNDS, MARGIN, difficultyProfile, manualChoice, checkpoint, strength, choose, resolve, tradeScore, tradeOk,
    expectedPickValue, gameClock, sigOf, sigPlayers, emptyMemory, tradeBlocked, recordTrade, recordRejected, recordFail, pruneMemory, summarizeRun,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BBGMScoutStrategy = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
