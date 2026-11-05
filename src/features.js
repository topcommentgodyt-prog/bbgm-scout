/*
 * BBGM Scout – AI Assistant, Trade Helper, Targets, Free Agents, Auto Drafter,
 * Auto Team Management (incl. minutes) and Autopilot.
 *
 * Every action goes through BBGM's own API (see bridge-main.js), so the game
 * enforces its rules (cap, roster limits, trade deadline, player willingness)
 * exactly as if you clicked the buttons yourself.
 */
(function (root) {
  "use strict";
  const B = root.BBGMScoutBridge;
  const LG = root.BBGMScoutLeague;
  const S = root.BBGMScoutStorage;
  const PR = () => root.BBGMScoutPlanning; // loaded after this file
  const SG = root.BBGMScoutStrategy;
  const { PH, PL } = LG;
  const EMPTY_LOOKING_FOR = { positions: {}, skills: {}, assets: { draftPicks: false, prospects: false, bestCurrentPlayers: false } };
  const PT = { 0: "Out of rotation (0)", 0.75: "Fewer minutes (−)", 1: "Normal", 1.25: "More minutes (+)", 1.75: "Much more (++)" };

  const tradeTeams = (userTid, upids, udpids, tid, pids, dpids) => [
    { tid: userTid, pids: upids, dpids: udpids, pidsExcluded: [], dpidsExcluded: [] },
    { tid, pids, dpids, pidsExcluded: [], dpidsExcluded: [] },
  ];
  // Amounts are in thousands. Negative amounts (e.g. cap space when over the cap) read as "-$44.1M", not "$-44120k".
  const fmtMoney = (k) => {
    const a = Math.abs(k), sign = k < 0 ? "-" : "";
    return a >= 1000 ? `${sign}$${(a / 1000).toFixed(1)}M` : `${sign}$${Math.round(a)}k`;
  };
  const shownOvr = (v) => v.summary.ovr;

  // ======================= AI Assistant: hidden gems =======================
  const ATHLETIC = ["spd", "jmp", "endu"];
  function gemVerdict(L, pid) {
    const v = L.byPid.get(pid);
    if (!v) return null;
    const s = v.summary;
    const score = Math.round(v.gemScore);
    const verdict = score >= 15 ? "Hidden gem" : score >= 7 ? "Undervalued" : score <= -10 ? "Overvalued" : "Fairly valued";
    const reasons = [];
    const pool = v.prospect ? "this draft class" : "the league";
    reasons.push(`Scout model: ${Math.round(v.ourPct)}th percentile in ${pool}. BBGM's own valuation: ${Math.round(v.marketPct)}th.`);
    const cur = v.p.ratings[v.p.ratings.length - 1];
    const ath = ATHLETIC.reduce((a, k) => a + (cur[k] || 0), 0) / 3;
    const skill = ["oiq", "diq", "tp", "drb", "pss"].reduce((a, k) => a + (cur[k] || 0), 0) / 5;
    if (s.age >= 24) {
      if (skill - ath >= 8) reasons.push("Skill and IQ-heavy ratings profile, which ages well in BBGM (athleticism drops off after 27).");
      else if (ath - skill >= 10) reasons.push("Athleticism-heavy profile: expect a steeper decline after 27–28.");
    }
    if (s.breakout >= 0.35) reasons.push(`${Math.round(s.breakout * 100)}% chance of a 5+ OVR jump next season.`);
    if (s.ceiling - s.pot >= 3) reasons.push(`Ceiling ${s.ceiling} is above the displayed POT ${s.pot}. BBGM's POT comes from only 20 simulations, so it can be noisy.`);
    if (s.pot - s.peakOvr >= 6 && s.age < 25) reasons.push(`Displayed POT ${s.pot} looks optimistic; median peak is ${s.peakOvr}.`);
    if (!v.prospect && v.p.contract) {
      const yrs = v.p.contract.exp - L.snap.season + 1;
      if (v.surplusPct - v.ourPct >= 10) reasons.push(`Bargain contract: ${fmtMoney(v.p.contract.amount)} for ${yrs} more season${yrs === 1 ? "" : "s"}.`);
      else if (v.ourPct - v.surplusPct >= 15) reasons.push(`Expensive contract (${fmtMoney(v.p.contract.amount)} through ${v.p.contract.exp}) eats into the value.`);
    }
    if (v.fog) reasons.push(`Ratings are scouted (could be off by up to ±${v.fog.cutoff}); the forecast accounts for that.`);
    if (v.p.injury && v.p.injury.gamesRemaining > 0) reasons.push(`Currently injured (${v.p.injury.type}, ${v.p.injury.gamesRemaining} games).`);
    return { pid, name: LG.name(L, pid), verdict, score, reasons, summary: s, tid: v.p.tid };
  }
  function gemList(L, n = 10) {
    return [...L.byPid.values()]
      .filter((v) => v.p.tid !== L.snap.userTid && v.talentBal > 3 && v.gemScore >= 7)
      .sort((a, b) => b.gemScore * Math.sqrt(b.talentBal) - a.gemScore * Math.sqrt(a.talentBal))
      .slice(0, n)
      .map((v) => gemVerdict(L, v.p.pid));
  }

  // ======================= Move memory (per league, on this device) =======================
  let activeLid = null;
  const memCache = new Map();
  function setLeague(lid) { activeLid = lid || activeLid; }
  async function loadMem(lid = activeLid) {
    if (!lid) return SG.emptyMemory();
    if (!memCache.has(lid)) memCache.set(lid, { ...SG.emptyMemory(), ...((await S.localGet(`mem:${lid}`)) || {}) });
    return memCache.get(lid);
  }
  async function saveMem(lid = activeLid) {
    if (!lid || !memCache.has(lid)) return;
    await S.localSet(`mem:${lid}`, memCache.get(lid)).catch(() => {});
  }
  const gpOfTeam = (t) => (t ? t.won + t.lost + (t.tied || 0) + (t.otl || 0) : 0);
  const clockOf = (L) => SG.gameClock(L.snap.season, L.snap.phase, gpOfTeam(L.user));
  /** Why a trade is blocked by the move memory (cooldowns, reversals, rejected deals), or null. */
  function memoryBlock(L, mem, teams, score) {
    return SG.tradeBlocked(mem, teams, clockOf(L), { cooldown: Number(L.settings.tradeCooldownDays) || 30, score, min: L.settings.tradeMinMov ?? 0.5 });
  }

  // ======================= Trade Helper =======================
  // No trades after the deadline, during the playoffs, or during fantasy/expansion drafts (negative phases).
  const tradesAllowed = (L) => L.snap.phase >= 0 && !(L.snap.phase >= PH.AFTER_TRADE_DEADLINE && L.snap.phase <= PH.PLAYOFFS);

  async function tradeIdeas(L, { shop = 3, onProgress } = {}) {
    if (!tradesAllowed(L)) return { ideas: [], note: "Trades aren't allowed right now (after the deadline or during the playoffs)." };
    const mine = L.roster(L.snap.userTid).filter((p) => !p.untradable).map((p) => L.byPid.get(p.pid)).filter(Boolean);
    const byOvr = [...mine].sort((a, b) => b.summary.ovr - a.summary.ovr);
    const rank = (v) => byOvr.indexOf(v);
    // What to shop depends on the goal:
    //  contend  -> picks, and prospects outside the rotation, for help now
    //  rebuild  -> veterans the market values more than our timeline does
    //  balanced -> whatever the market overvalues relative to the Scout model
    const scored = mine.map((v) => {
      let edge = v.marketPct - v.ourPct + (v.surplus < 0 ? 15 : 0);
      if (L.mode === "contend") edge += (rank(v) >= 8 ? 25 : -30) + (v.summary.age <= 23 ? 10 : 0);
      if (L.mode === "rebuild") edge += (v.summary.age >= 27 ? 25 : 0) - (v.summary.age <= 23 ? 25 : 0);
      return { label: LG.name(L, v.p.pid), pids: [v.p.pid], dpids: [], edge };
    }).filter((c) => PR().playerLevel(c.pids[0]) !== "never");
    if (L.mode !== "rebuild") {
      const myPicks = L.snap.draftPicks.filter((d) => d.tid === L.snap.userTid);
      for (const dp of myPicks.filter((d) => PR().pickLevel(d.dpid) !== "never")) scored.push({ label: LG.pickName(L, dp.dpid), pids: [], dpids: [dp.dpid], edge: L.mode === "contend" ? 40 - dp.round * 10 : 0 });
    }
    const candidates = scored.sort((a, b) => b.edge - a.edge).slice(0, shop);
    const mem = await loadMem();
    const ideas = [];
    let i = 0;
    for (const c of candidates) {
      onProgress && onProgress(`Shopping ${c.label} to every AI team… (${++i}/${candidates.length})`);
      let offers = [];
      try { offers = await B.call("main", "getTradingBlockOffers", { pids: c.pids, dpids: c.dpids, lookingFor: EMPTY_LOOKING_FOR }, 180000); } catch (e) { continue; }
      for (const o of offers || []) {
        if (o.summary && o.summary.warning) continue;
        if (PR().assetsLevel(o.pidsUser, o.dpidsUser) === "never") continue; // never give up protected assets
        const teams = tradeTeams(L.snap.userTid, o.pidsUser, o.dpidsUser, o.tid, o.pids, o.dpids);
        const rosterAfter = L.capInfo.rosterSize - o.pidsUser.length + o.pids.length;
        const impact = LG.tradeImpact(L, teams);
        const protect = PR().assetsLevel(o.pidsUser, o.dpidsUser);
        const ruleBreak = PR().contractRuleBreak(L, L.settings, { payrollDelta: PR().tradePayrollDelta(L, teams) });
        ideas.push({ teams, gain: impact.value, impact, rosterAfter, protect, ruleBreak, blocked: memoryBlock(L, mem, teams, impact.score), desc: describeTrade(L, teams) });
      }
    }
    // Rank by improvement on the goal that matters for this team (rating now, future rating, or both).
    ideas.sort((a, b) => b.impact.score - a.impact.score || b.gain - a.gain);
    const useful = ideas.filter((x) => x.impact.score > 0.05 || (x.gain > 0 && x.impact.score > -0.05));
    return { ideas: useful.slice(0, 6), note: ideas.length ? "" : "No AI team made an offer." };
  }

  function describeTrade(L, teams) {
    const side = (t) => [...t.pids.map((pid) => `${LG.name(L, pid)} (${L.byPid.get(pid) ? shownOvr(L.byPid.get(pid)) : "?"})`), ...t.dpids.map((d) => LG.pickName(L, d))];
    const other = L.teams.get(teams[1].tid);
    return { give: side(teams[0]), get: side(teams[1]), team: other ? `${other.region} ${other.name}` : `Team ${teams[1].tid}`, abbrev: other ? other.abbrev : "" };
  }

  async function proposeTrade(L, teams, why, ex) {
    await B.call("main", "createTrade", teams);
    const r = await B.call("main", "proposeTrade", false);
    const d = describeTrade(L, teams);
    const mem = await loadMem();
    if (r && r.accepted) {
      SG.recordTrade(mem, teams, clockOf(L));
      await S.addLog({ kind: "trade", text: `Traded ${d.give.join(", ") || "nothing"} to ${d.team} for ${d.get.join(", ") || "nothing"}${why ? ` (${why})` : ""}`, undoKey: r.undoKey, pids: [...teams[0].pids, ...teams[1].pids],
        ex: ex || explainTrade(L, LG.tradeImpact(L, teams)) });
    } else {
      SG.recordRejected(mem, teams, clockOf(L));
      await B.call("main", "clearTrade", "all").catch(() => {});
    }
    await saveMem();
    return r;
  }

  /** Asks BBGM what would make a rejected deal work; returns { teams, impact } if the counter is still worth it. */
  async function counterOffer(L, teams, settings, signed = 0) {
    try {
      await B.call("main", "createTrade", teams);
      await B.call("main", "tradeCounterOffer");
      const { teams: t } = await B.readTrade();
      if (!t || !t[1] || t[1].tid !== teams[1].tid) return null;
      if (PR().assetsLevel(t[0].pids, t[0].dpids) !== "available") return null; // never offer protected assets
      const same = (a, b) => a.pids.length === b.pids.length && a.dpids.length === b.dpids.length && a.pids.every((x) => b.pids.includes(x)) && a.dpids.every((x) => b.dpids.includes(x));
      if (same(t[0], teams[0]) && same(t[1], teams[1])) return null; // nothing changed
      const impact = LG.tradeImpact(L, t);
      const rosterAfter = L.capInfo.rosterSize - t[0].pids.length + t[1].pids.length;
      if (!isNecessary(L, impact, settings) || rosterAfter + signed > L.capInfo.maxRoster) return null;
      if (PR().contractRuleBreak(L, settings, { payrollDelta: PR().tradePayrollDelta(L, t) })) return null;
      return { teams: t.map((x) => ({ tid: x.tid, pids: [...x.pids], dpids: [...x.dpids], pidsExcluded: [], dpidsExcluded: [] })), impact };
    } catch (e) {
      return null;
    } finally {
      await B.call("main", "clearTrade", "all").catch(() => {});
    }
  }

  const sgn = (x, n = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(n)}`;
  /** Concise, measurable reasons for a trade (projected at decision time). */
  function explainTrade(L, im) {
    const benefits = [], costs = [];
    (im.now >= 0 ? benefits : costs).push(`team rating ${sgn(im.now)} now (~${sgn(im.winsNow)} wins)`);
    (im.future >= 0 ? benefits : costs).push(`team rating ${sgn(im.future)} over the next two seasons`);
    (im.value >= 0 ? benefits : costs).push(`long-term value ${sgn(im.value, 0)}`);
    if (im.picksNet > 1) costs.push(`gives up draft picks worth ${im.picksNet.toFixed(0)}`);
    else if (im.picksNet < -1) benefits.push(`adds draft picks worth ${(-im.picksNet).toFixed(0)}`);
    if (im.youthNet > 1) costs.push(`gives up young talent worth ${im.youthNet.toFixed(0)}`);
    else if (im.youthNet < -1) benefits.push(`adds young talent worth ${(-im.youthNet).toFixed(0)}`);
    if (im.agingNet > 0.5) costs.push(`aging risk: about ${im.agingNet.toFixed(1)} OVR of decline expected from players 30+ over two seasons`);
    if (im.payroll && im.payroll[0]) {
      const dp = im.payroll[0].after - im.payroll[0].before;
      if (Math.abs(dp) >= 100) (dp < 0 ? benefits : costs).push(`${im.payroll[0].season} payroll ${dp < 0 ? "−" : "+"}${fmtMoney(Math.abs(dp))}`);
    }
    if (im.payrollOver > 0) costs.push(`$${im.payrollOver.toFixed(1)}M over your payroll limit across three seasons`);
    const st = L.strategy || { label: L.mode, goal: "" };
    return { why: `Fits ${st.label}: ${st.goal}. Score ${sgn(im.score, 2)} (threshold ${(L.settings.tradeMinMov ?? 0.5).toFixed(1)}).`, benefits, costs, strategy: st.label, basis: "projected",
      num: { now: Math.round(im.now * 100) / 100, future: Math.round(im.future * 100) / 100, value: Math.round(im.value), score: Math.round(im.score * 100) / 100 } };
  }

  async function evaluateCurrentTrade(L) {
    const { teams } = await B.readTrade();
    if (!teams || (!teams[0].pids.length && !teams[0].dpids.length && !teams[1].pids.length && !teams[1].dpids.length)) return null;
    const rows = (t, sign) => [
      ...t.pids.map((pid) => ({ pid, label: LG.name(L, pid), value: sign * (L.byPid.get(pid) ? L.byPid.get(pid).surplus : 0) })),
      ...t.dpids.map((dpid) => { const dp = L.snap.draftPicks.find((x) => x.dpid === dpid); return { label: LG.pickName(L, dpid), value: sign * (dp ? L.pickValue(dp) : 0) }; }),
    ];
    return { teams, gain: LG.tradeGain(L, teams), get: rows(teams[1], 1), give: rows(teams[0], -1), desc: describeTrade(L, teams) };
  }

  // ======================= Targets (players to add via trade) =======================
  function targets(L, n = 12) {
    return [...L.byPid.values()]
      .filter((v) => v.p.tid >= 0 && v.p.tid !== L.snap.userTid && !v.p.untradable && v.surplus > 2)
      .map((v) => ({ v, score: v.surplus * (1 + Math.max(0, v.gemScore) / 25) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map(({ v }) => ({ pid: v.p.pid, name: LG.name(L, v.p.pid), team: (L.teams.get(v.p.tid) || {}).abbrev, s: v.summary, surplus: v.surplus, gem: Math.round(v.gemScore), contract: v.p.contract }));
  }
  async function buildOfferFor(L, pid) {
    const v = L.byPid.get(pid);
    await B.call("main", "createTrade", tradeTeams(L.snap.userTid, [], [], v.p.tid, [pid], []));
    const r = await B.call("main", "tradeCounterOffer");
    const { teams } = await B.readTrade();
    return { message: r && r.message, teams, gain: teams ? LG.tradeGain(L, teams) : 0, desc: teams ? describeTrade(L, teams) : null };
  }

  // ======================= Free agents =======================
  const signingAllowed = (phase) => phase >= 0 && !(phase > PH.AFTER_TRADE_DEADLINE && phase <= PH.RESIGN_PLAYERS);
  function capFits(L, amount) {
    const c = L.capInfo;
    if (c.type === "none") return true;
    if (c.payroll + amount <= c.cap) return true;
    return c.type === "soft" && amount <= c.minContract + 1;
  }
  function freeAgents(L) {
    const ok = signingAllowed(L.snap.phase);
    return [...L.byPid.values()]
      .filter((v) => v.p.tid === PL.FREE_AGENT && v.p.mood)
      .map((v) => {
        const ask = v.p.mood.contractAmount, exp = v.p.contract.exp;
        const surplus = v.talent - L.costOf(ask, exp);
        let why = "";
        if (!ok) why = "Signing is closed in this phase";
        else if (!v.p.mood.willing) why = "Refuses to sign with you";
        else if (L.capInfo.rosterSize >= L.capInfo.maxRoster) why = "Roster full";
        else if (!capFits(L, ask)) why = "Over the cap";
        else { const rb = PR().contractRuleBreak(L, L.settings, { amount: ask, exp }); if (rb) why = `Breaks your rules: ${rb}`; }
        return { pid: v.p.pid, name: LG.name(L, v.p.pid), s: v.summary, ask, exp, surplus, gem: Math.round(v.gemScore), canSign: !why, why };
      })
      .sort((a, b) => b.surplus - a.surplus)
      .slice(0, 25);
  }
  async function sign(L, fa, why, ex) {
    const r = await B.call("main", "acceptContractNegotiation", { pid: fa.pid, amount: fa.ask, exp: fa.exp });
    if (typeof r === "string") throw new Error(r.replace(/<[^>]+>/g, ""));
    const mem = await loadMem();
    mem.acq[fa.pid] = { t: clockOf(L), from: -1 };
    await saveMem();
    await S.addLog({ kind: "sign", text: `Signed ${fa.name} (${fmtMoney(fa.ask)} through ${fa.exp})${why ? ` (${why})` : ""}`, undoKey: typeof r === "number" ? r : undefined, pids: [fa.pid], ex });
    return r;
  }

  // ======================= Contract planning =======================
  /**
   * Payroll for the next three seasons: contracts already signed, plus reserves for (a) re-signing young
   * players projected to start whose deals run out first and (b) rookie deals for your first-round picks.
   * The limit is the hard cap, or the luxury-tax line otherwise (from this league's settings).
   */
  function payrollPlan(L) {
    const snap = L.snap, ga = snap.ga || {}, c = L.capInfo;
    const mine = snap.players.filter((p) => p.tid === snap.userTid).map((p) => L.byPid.get(p.pid)).filter(Boolean);
    const byOvr = [...mine].sort((a, b) => b.summary.ovr - a.summary.ovr);
    const starter = byOvr[4] ? byOvr[4].summary.ovr : 50;
    const est = (ovr) => Math.round(c.minContract + (c.maxContract - c.minContract) * Math.pow(Math.max(0, Math.min(1, (ovr - 47) / 28)), 1.5));
    const growth = 1 + (Number(ga.inflationAvg) || 0) / 100;
    const baseLimit = c.type === "hard" ? c.cap : ga.luxuryPayroll || (c.type === "none" ? Infinity : c.cap * 1.25);
    const out = [];
    for (let k = 0; k < 3; k++) {
      const s = L.nextSeason + k;
      const y = s - snap.season;
      let committed = 0, reserve = 0;
      const keep = [];
      for (const v of mine) {
        const ct = v.p.contract;
        if (ct && ct.exp >= s) committed += ct.amount;
        else if (v.summary.age <= 25 && LG.ovrAt(L, v.p.pid, Math.max(0, y)) >= starter) { reserve += est(LG.ovrAt(L, v.p.pid, Math.max(0, y))); keep.push(v.p.pid); }
      }
      const rookies = snap.draftPicks.filter((d) => d.tid === snap.userTid && d.round === 1 && d.season === s - 1).length;
      reserve += rookies * (c.cap || 90000) * 0.025;
      out.push({ season: s, committed, reserve, total: committed + reserve, limit: baseLimit * Math.pow(growth, k), keep, rookies });
    }
    return out;
  }
  /** Whether adding `amount` through `exp` fits the plan. Minimum contracts always fit outside hard-cap leagues. */
  function fitsPlan(L, plan, amount, exp, extraRoom = 0) {
    if (L.capInfo.type !== "hard" && amount <= L.capInfo.minContract + 1) return { ok: true };
    for (const row of plan) {
      if (exp < row.season) continue;
      if (row.total + amount > row.limit + extraRoom) return { ok: false, season: row.season, over: row.total + amount - row.limit, row };
    }
    return { ok: true };
  }

  // ======================= Auto Drafter =======================
  function draftBoard(L) {
    const year = L.snap.phase === PH.DRAFT ? L.snap.season : L.draftSeason;
    const list = [...L.byPid.values()].filter((v) => v.p.tid === PL.UNDRAFTED && v.p.draft && v.p.draft.year === year);
    const byMarket = [...list].sort((a, b) => b.market - a.market).map((v) => v.p.pid);
    const board = list
      .sort((a, b) => b.draftTalent - a.draftTalent)
      .map((v, i) => ({ pid: v.p.pid, name: LG.name(L, v.p.pid), s: v.summary, value: v.draftTalent, floor: v.floor, upside: v.upside, ourRank: i + 1, marketRank: byMarket.indexOf(v.p.pid) + 1, gem: Math.round(v.gemScore) }));
    // Tiers: prospects whose forecast ranges overlap with the tier's top player. A prospect stays in the
    // tier if their ceiling (90th pct peak) reaches the leader's median peak and their value is within 20%.
    let tier = 0, head = null;
    for (const b of board) {
      if (!head || b.value < head.value * 0.8 || b.s.ceiling < head.s.peakOvr) { tier++; head = b; }
      b.tier = tier;
    }
    return board;
  }
  /** How many prospects remain in each tier. */
  const tierCounts = (board) => board.reduce((m, b) => ((m[b.tier] = (m[b.tier] || 0) + 1), m), {});

  /**
   * Trade-down advice when you're on the clock: if your current tier is deep, ask teams picking a few
   * spots later what they'd add to swap picks (BBGM's "What would make this work?"). Suggest the deal only
   * if a prospect from the same tier should still be available at the new pick and you gain value.
   */
  async function tradeDownIdeas(L, settings, { maxPartners = 3 } = {}) {
    const order = L.snap.order;
    if (L.snap.phase !== PH.DRAFT || !order.length || order[0].tid !== L.snap.userTid) return [];
    const mine = order[0];
    if (PR().pickLevel(mine.dpid) !== "available") return [];
    const board = draftBoard(L);
    if (!board.length) return [];
    const topTier = board[0].tier;
    const depth = board.filter((b) => b.tier === topTier).length;
    if (depth < 3) return [];
    const ideas = [];
    // Partners: other teams picking within the tier's depth (so a tier player should still be there).
    const partners = order.slice(1, depth).map((dp, i) => ({ dp, idx: i + 1 })).filter((x) => x.dp.tid !== L.snap.userTid).slice(0, maxPartners);
    for (const { dp, idx } of partners) {
      try {
        await B.call("main", "createTrade", tradeTeams(L.snap.userTid, [], [mine.dpid], dp.tid, [], [dp.dpid]));
        await B.call("main", "tradeCounterOffer");
        const { teams } = await B.readTrade();
        if (!teams || !teams[1].dpids.includes(dp.dpid) || !teams[0].dpids.includes(mine.dpid)) continue;
        if (PR().assetsLevel(teams[0].pids, teams[0].dpids) === "never") continue;
        // Value: the prospect we expect at the new slot (idx players taken before it) plus whatever else they add,
        // versus the best prospect now plus anything extra the AI asked from us.
        const expectedAtNew = board[Math.min(idx, board.length - 1)];
        const extraGet = L.assetValue(teams[1].pids, teams[1].dpids.filter((d) => d !== dp.dpid));
        const extraGive = L.assetValue(teams[0].pids, teams[0].dpids.filter((d) => d !== mine.dpid));
        const gain = expectedAtNew.value + extraGet - extraGive - board[0].value;
        if (expectedAtNew.tier !== topTier || gain <= 0) continue;
        const team = L.teams.get(dp.tid);
        ideas.push({ teams, gain, from: mine, to: dp, slotsDown: idx, depth, expected: expectedAtNew, team: team ? `${team.region} ${team.name}` : `Team ${dp.tid}`,
          extraGet: [...teams[1].pids.map((pid) => LG.name(L, pid)), ...teams[1].dpids.filter((d) => d !== dp.dpid).map((d) => LG.pickName(L, d))],
          extraGive: [...teams[0].pids.map((pid) => LG.name(L, pid)), ...teams[0].dpids.filter((d) => d !== mine.dpid).map((d) => LG.pickName(L, d))] });
      } catch (e) { /* skip this partner */ }
    }
    await B.call("main", "clearTrade", "all").catch(() => {});
    return ideas.sort((a, b) => b.gain - a.gain);
  }
  const tradeUpTried = new Set();
  /** Returns a description of what happened or what is suggested. */
  async function draftStep(L, settings, { act }) {
    if (L.snap.phase !== PH.DRAFT || !L.snap.order.length) return { state: "idle" };
    const board = draftBoard(L);
    if (!board.length) return { state: "idle" };
    const order = L.snap.order;
    const best = board[0];
    if (order[0].tid === L.snap.userTid) {
      if (!act) return { state: "onClock", best, board };
      if (settings.draftTradeDown && !tradeUpTried.has(`down:${order[0].dpid}`)) {
        tradeUpTried.add(`down:${order[0].dpid}`);
        const [down] = await tradeDownIdeas(L, settings);
        if (down) {
          const r = await proposeTrade(L, down.teams, `trade down ${down.slotsDown} spot${down.slotsDown === 1 ? "" : "s"}: ${down.depth} similar prospects left`);
          if (r && r.accepted) return { state: "tradedDown", down };
        }
      }
      await B.call("main", "draftUser", best.pid);
      await S.addLog({ kind: "draft", text: `Drafted ${best.name} with pick ${order[0].round}-${order[0].pick} (Scout #${best.ourRank}, BBGM #${best.marketRank}; peak ${best.s.peakOvr}, ceiling ${best.s.ceiling})`, pids: [best.pid] });
      return { state: "picked", best };
    }
    const nextIdx = order.findIndex((dp) => dp.tid === L.snap.userTid);
    if (act && settings.draftTradeUp && nextIdx > 0 && best.marketRank <= nextIdx && !tradeUpTried.has(order[0].dpid) && PR().pickLevel(order[nextIdx].dpid) === "available") {
      // Our top target will probably be gone before we pick. Ask the team on the clock what it wants for its pick.
      tradeUpTried.add(order[0].dpid);
      await B.call("main", "createTrade", tradeTeams(L.snap.userTid, [], [order[nextIdx].dpid], order[0].tid, [], [order[0].dpid]));
      await B.call("main", "tradeCounterOffer");
      const { teams } = await B.readTrade();
      if (teams && teams[1].dpids.includes(order[0].dpid) && PR().assetsLevel(teams[0].pids, teams[0].dpids) === "available") {
        const cost = L.assetValue(teams[0].pids, teams[0].dpids);
        const gain = best.value - cost;
        if (gain > 0) {
          const r = await proposeTrade(L, teams, `trade up for ${best.name}`);
          if (r && r.accepted) {
            await B.call("main", "draftUser", best.pid);
            await S.addLog({ kind: "draft", text: `Traded up and drafted ${best.name}`, pids: [best.pid] });
            return { state: "tradedUp", best };
          }
        } else {
          await B.call("main", "clearTrade", "all").catch(() => {});
        }
      }
    }
    return { state: "waiting", best, board, picksUntilYou: nextIdx };
  }

  // ======================= Auto Team Management =======================
  const FIN = {
    win: { coaching: 100, health: 100, facilities: 75, scouting: 1 },
    balanced: { coaching: 75, health: 50, facilities: 50, scouting: 34 },
    profit: { coaching: 50, health: 34, facilities: 34, scouting: 1 },
  };

  function minutesPlan(L, settings) {
    const mine = L.roster(L.snap.userTid).map((p) => L.byPid.get(p.pid)).filter(Boolean);
    const out = (v) => v.p.injury && v.p.injury.gamesRemaining > 0;
    // Depth chart: everyone except players out long-term. Short injuries keep their place, so one sprained
    // ankle doesn't reshuffle everyone's minutes for a few days.
    const ranked = mine.filter((v) => !(v.p.injury && v.p.injury.gamesRemaining > 10)).sort((a, b) => shownOvr(b) - shownOvr(a));
    const R = settings.rotationSize || 10;
    // What a player at depth-chart spot i should get. `cur` adds hysteresis to the contend rule: a star keeps "+"
    // until the gap to the 3rd-best player shrinks below 2 OVR (it needs 4 to get it), so the gap can't flicker.
    const ptAt = (v, i, cur) => {
      if (i < 0 || i >= ranked.length) return null;
      const age = v.summary.age;
      let pt = 1, why = "rotation player";
      if (i >= R + 2 && ranked.length > R + 2) { pt = 0; why = `#${i + 1} on the depth chart; shouldn't play`; }
      else if (i >= R) { pt = 0.75; why = "end of bench"; }
      if (L.mode === "contend" && i < 2 && ranked[2] && shownOvr(v) - shownOvr(ranked[2]) >= (cur === 1.25 ? 2 : 4)) { pt = 1.25; why = "best player; contending"; }
      if (L.mode === "rebuild" && i >= 5 && i < R + 2 && age <= 23 && v.summary.ceiling >= 58) {
        pt = 1.25; why = "young, high-upside: more minutes keep the player happy (playing time affects mood, not progression)";
      }
      if (settings.tank && L.mode === "rebuild" && i < 3 && age >= 26) { pt = 0.75; why = "tanking: resting veterans for better lottery odds"; }
      return [pt, why];
    };
    const plan = new Map();
    ranked.forEach((v, i) => {
      const cur = v.p.ptModifier ?? 1;
      let [pt, why] = ptAt(v, i, cur);
      // Hysteresis at cutoffs: keep the current setting while it's what the player would get one spot up or down.
      if (pt !== cur && ((ptAt(v, i - 1, cur) || [])[0] === cur || (ptAt(v, i + 1, cur) || [])[0] === cur)) [pt, why] = [cur, "unchanged"];
      plan.set(v.p.pid, [pt, why]);
    });
    // Injured players are left alone: BBGM already keeps them out of games, and benching then un-benching
    // them only doubles the moves (and could leave a healed player benched).
    return mine
      .filter((v) => !out(v) && plan.has(v.p.pid))
      .map((v) => ({ v, pt: plan.get(v.p.pid)[0], why: plan.get(v.p.pid)[1] }))
      .filter((x) => x.pt !== (x.v.p.ptModifier ?? 1));
  }


  /** BBGM's rule: a rookie drafted this year (or last season, before the regular season) can be released for free. */
  function justDrafted(L, v) {
    const d = v.p.draft, ph = L.snap.phase, season = L.snap.season;
    if (!d || !v.p.contract || !v.p.contract.rookie) return false;
    return (d.year === season && ph >= PH.DRAFT) || (d.year === season - 1 && ph >= 0 && ph < PH.REGULAR_SEASON);
  }

  /** Builds the list of actions the manager wants to take right now. Each has run() and an explanation. */
  async function managerPlan(L, settings, { lid, includeTrades }) {
    setLeague(lid);
    const acts = [];
    const m = settings.manage;
    const phase = L.snap.phase;
    const u = L.user;
    const mem = await loadMem();
    const clock = clockOf(L);
    lastClock = clock;
    const st = L.strategy || { label: L.mode, goal: "" };
    // approval: the move involves an "Ask first" asset, so it always waits for the user.
    const push = (kind, text, run, pids = [], opts = {}) => {
      const sig = opts.sig || `${kind}:${pids.join(",")}:${text.slice(0, 40)}`;
      if (mem.fails[sig] && mem.fails[sig].n >= 3 && clock - mem.fails[sig].t < 60) return; // failed repeatedly: stop retrying for a while
      acts.push({ kind, text, run, pids, sig, approval: !!opts.approval, never: !!opts.never, why: opts.why || "", ex: opts.ex || null });
    };
    const ex = (why, benefits = [], costs = []) => ({ why, benefits, costs, strategy: st.label, basis: "projected" });
    const lvl = (pid) => PR().playerLevel(pid);
    const rules = (o) => PR().contractRuleBreak(L, settings, o);
    const plan = payrollPlan(L);
    // Players joining the roster this round or soon: re-signings (players negotiating aren't on the roster in
    // BBGM) and draft picks still to be made. Trades must leave room for them, or someone gets cut right after.
    let rosterAdds = 0;
    const pendingDraft = phase >= PH.PLAYOFFS && phase <= PH.DRAFT ? L.snap.draftPicks.filter((d) => d.tid === L.snap.userTid && d.season === L.draftSeason).length : 0;

    if (m.finances && L.snap.ga.budget !== false && u && u.budget) {
      const want = FIN[settings.financeStyle] || FIN.balanced;
      const lvl = (k) => (typeof u.budget[k] === "number" ? u.budget[k] : u.budget[k] && u.budget[k].level);
      const differs = Object.keys(want).some((k) => Math.abs((lvl(k) || 0) - want[k]) > 1) || !u.autoTicketPrice;
      if (differs) {
        const changes = Object.keys(want).filter((k) => Math.abs((lvl(k) || 0) - want[k]) > 1).map((k) => `${k} ${lvl(k) || 0} → ${want[k]}`);
        push("finances", `Set budget: coaching ${want.coaching}, health ${want.health}, facilities ${want.facilities}, scouting ${want.scouting}; auto ticket price (${settings.financeStyle})`, () =>
          B.call("main", "updateBudget", { budgetLevels: { ...want, ticketPrice: typeof u.budget.ticketPrice === "number" ? u.budget.ticketPrice : (u.budget.ticketPrice || {}).amount }, adjustForInflation: u.adjustForInflation !== false, autoTicketPrice: true }),
          [], { sig: "finances", ex: ex(`Your finance style is "${settings.financeStyle}".`, changes.length ? [`budget ${changes.join(", ")}`] : ["turns on auto ticket price"]) });
      }
    }
    if (m.roster && u && !u.keepRosterSorted) {
      push("roster", "Turn on 'Keep auto sorted' so the lineup always follows the best available players", () => B.call("main", "updateKeepRosterSorted", { tid: L.snap.userTid, keepRosterSorted: true }), [], { sig: "roster" });
    }
    if (m.minutes && (phase === PH.REGULAR_SEASON || phase === PH.AFTER_TRADE_DEADLINE || phase === PH.PLAYOFFS || phase === PH.PRESEASON)) {
      for (const x of minutesPlan(L, settings)) {
        push("minutes", `${LG.name(L, x.v.p.pid)}: ${PT[x.pt]} (${x.why})`, () => B.call("main", "updatePlayingTime", { pid: x.v.p.pid, ptModifier: x.pt }), [x.v.p.pid], { sig: `minutes:${x.v.p.pid}:${x.pt}` });
      }
    }
    if (m.resign && phase === PH.RESIGN_PLAYERS) {
      const byOvr = L.roster(L.snap.userTid).map((p) => L.byPid.get(p.pid)).filter(Boolean).sort((a, b) => b.summary.ovr - a.summary.ovr);
      const starter = byOvr[4] ? byOvr[4].summary.ovr : 50;
      // Hard cap: re-signings must fit too. BBGM checks the current payroll (which still includes every
      // unsigned expiring contract) minus the player's old salary plus the new one. So: let players walk
      // first (that frees their salary), then re-sign best value first while each one still fits.
      const hard = L.capInfo.type === "hard" && L.capInfo.cap;
      const valueOf = (v) => v.talent - L.costOf(v.p.mood.contractAmount, v.p.contract.exp);
      const order = [...L.snap.negotiations].map((pid) => L.byPid.get(pid)).filter((v) => v && v.p.mood).sort((a, b) => valueOf(b) - valueOf(a));
      // Anyone whose demands couldn't be read still gets a decision, so BBGM never has to ask before free agency.
      for (const pid of L.snap.negotiations) {
        const v = L.byPid.get(pid);
        if (v && v.p.mood) continue;
        push("letwalk", `Let ${LG.name(L, pid)} walk (contract demands unavailable)`, () => B.call("main", "cancelContractNegotiation", pid), [pid],
          { approval: lvl(pid) !== "available", never: lvl(pid) === "never", why: lvl(pid) === "never" ? "Never trade: you decide" : lvl(pid) === "ask" ? "Ask first" : "", sig: `letwalk:${pid}`,
            ex: ex("BBGM didn't report his contract demands, so he can't be valued; undecided players would block free agency.") });
      }
      let hardPay = L.capInfo.payroll;
      const walk = (v, why) => {
        const pid = v.p.pid, level = lvl(pid), ask = v.p.mood.contractAmount;
        if (level === "available") hardPay -= v.p.contract.amount; // only moves that run without approval free room for sure
        push("letwalk", `Let ${LG.name(L, pid)} walk (${why})`, () => B.call("main", "cancelContractNegotiation", pid), [pid],
          { approval: level !== "available", never: level === "never", why: level === "never" ? "Never trade: you decide" : level === "ask" ? "Ask first" : "", sig: `letwalk:${pid}`,
            ex: ex(!v.p.mood.willing ? "He won't re-sign." : why.includes("hard cap") ? "No room under the hard cap after higher-value re-signings." : "Asking price is above his value to you.",
              [], v.p.mood.willing ? [`value ${sgn(valueOf(v), 0)} at ${fmtMoney(ask)}`] : []) });
      };
      const keep = [];
      for (const v of order) {
        const pid = v.p.pid;
        const ask = v.p.mood.contractAmount;
        const surplus = valueOf(v);
        const level = lvl(pid);
        // Young players projected to start are kept unless clearly overpriced: losing them is hard to undo.
        const young = v.summary.age <= 25 && Math.max(LG.ovrAt(L, pid, 1), LG.ovrAt(L, pid, 2)) >= starter && surplus > -0.25 * Math.abs(v.talent) && st.key !== "winnow";
        if (v.p.mood.willing && (surplus > 0 || level === "never" || young)) keep.push({ v, young, surplus });
        else walk(v, v.p.mood.willing ? `asking ${fmtMoney(ask)}, more than the player is worth to you` : "unwilling to re-sign");
      }
      // Roster room: players already under contract (including this year's draft picks) plus re-signings.
      // A marginal re-signing that would only be cut later for roster space is skipped (released salary is still owed).
      const negSet = new Set(L.snap.negotiations);
      let size = L.roster(L.snap.userTid).filter((p) => !negSet.has(p.pid)).length;
      const onRoster = L.roster(L.snap.userTid).map((p) => L.byPid.get(p.pid)).filter((v) => v && lvl(v.p.pid) !== "never");
      const worstTalent = onRoster.length ? Math.min(...onRoster.map((v) => v.talent)) : -Infinity;
      for (const { v, young, surplus } of keep) {
        const pid = v.p.pid, ask = v.p.mood.contractAmount, exp = v.p.contract.exp, level = lvl(pid);
        if (hard && hardPay - v.p.contract.amount + ask > L.capInfo.cap) { walk(v, `re-signing at ${fmtMoney(ask)} would put you over the hard cap`); continue; }
        // Roster full: only re-sign if he's clearly worth more than the player who'd be cut to make room.
        if (size >= L.capInfo.maxRoster && level !== "never" && !young && !(surplus >= 8 && v.talent > worstTalent)) { walk(v, `roster already full (${size}/${L.capInfo.maxRoster} with draft picks); not worth a roster spot`); continue; }
        size++; rosterAdds++;
        hardPay += ask - v.p.contract.amount;
        const broken = rules({ amount: ask, exp, payrollDelta: 0 }) || rules({ exp }); // length limit; re-signing doesn't add new payroll
        const why = level === "never" ? "protected player" : surplus > 0 ? `value +${surplus.toFixed(1)}` : `young core: projected ${Math.round(LG.ovrAt(L, pid, 2))} OVR in two seasons`;
        push("resign", `Re-sign ${LG.name(L, pid)} at ${fmtMoney(ask)} through ${exp} (${why})`, async () => {
          const r = await B.call("main", "acceptContractNegotiation", { pid, amount: ask, exp });
          if (typeof r === "string") throw new Error(r.replace(/<[^>]+>/g, ""));
          return r;
        }, [pid], { approval: !!broken || level === "ask", why: broken ? `breaks your rules: ${broken}` : level === "ask" ? "Ask first" : "", sig: `resign:${pid}`,
          ex: ex(young && surplus <= 0 ? "Young player projected to start; letting him walk would lose him for nothing." : "Worth more to you than the asking price.",
            [`value to you ${sgn(v.talent, 0)} over the contract`, `projected OVR ${Math.round(LG.ovrAt(L, pid, 1))} next season`], [`${fmtMoney(ask)} a year through ${exp}`]) });
      }
    }
    if (m.releases && L.capInfo.rosterSize > L.capInfo.maxRoster && (phase === PH.PRESEASON || phase === PH.REGULAR_SEASON || phase === PH.FREE_AGENCY)) {
      // Not right after the draft: expiring contracts leave at re-signing time, which usually frees the spots.
      const extra = L.capInfo.rosterSize - L.capInfo.maxRoster;
      const mine = L.roster(L.snap.userTid).map((p) => L.byPid.get(p.pid)).filter(Boolean);
      // Cut the players worth least to you. A released player's salary is still owed in BBGM, so salary
      // doesn't make a player more "cuttable"; young players also count their long-run value unless winning now.
      const youthW = st.key === "winnow" ? 0 : st.key === "contend" ? 0.25 : 0.5;
      // Players drafted this year cost nothing to release before the regular season, so they get a small nudge.
      const keepScore = (v) => v.talent + (v.summary.age <= 23 ? youthW * v.draftTalentNeutral : 0) - (justDrafted(L, v) ? 2 : 0);
      const cut = mine.filter((v) => lvl(v.p.pid) !== "never").map((v) => ({ v, score: keepScore(v) })).sort((a, b) => a.score - b.score).slice(0, extra);
      for (const { v } of cut) push("release", `Release ${LG.name(L, v.p.pid)} (lowest value on an over-full roster)`, () => B.call("main", "releasePlayer", { pids: [v.p.pid] }), [v.p.pid],
        { approval: lvl(v.p.pid) === "ask", why: lvl(v.p.pid) === "ask" ? "Ask first" : "", sig: `release:${v.p.pid}`,
          ex: ex(`Roster is ${L.capInfo.rosterSize}/${L.capInfo.maxRoster}; he's worth the least to you for ${st.label} (released salary is still owed, so it isn't a reason to cut).`,
            justDrafted(L, v) ? ["just drafted: BBGM voids his contract if he's released before the regular season, so this costs nothing"] : [],
            !justDrafted(L, v) && v.p.contract ? [`still owed ${fmtMoney(v.p.contract.amount)} a year through ${v.p.contract.exp}`] : []) });
    }
    let signed = 0, signedPay = 0; // signings planned this round, so a trade below can't break roster or hard-cap limits
    if (m.signings && signingAllowed(phase)) {
      let size = L.capInfo.rosterSize;
      const target = phase === PH.FREE_AGENCY || phase === PH.PRESEASON ? L.capInfo.maxRoster - 1 : L.capInfo.minRoster;
      let payroll = L.capInfo.payroll;
      const extraRoom = st.key === "winnow" ? 0.05 * (L.capInfo.cap || 0) : 0;
      for (const fa of freeAgents(L)) {
        if (size >= target && !(fa.surplus > 8 && size < L.capInfo.maxRoster)) continue;
        if (!fa.canSign || (fa.surplus <= 0 && size >= L.capInfo.minRoster)) continue;
        if (L.capInfo.type !== "none" && payroll + fa.ask > L.capInfo.cap && fa.ask > L.capInfo.minContract + 1) continue;
        // Three-season payroll check: keeps room to re-sign young starters and pay first-round picks.
        const fit = size < L.capInfo.minRoster ? { ok: true } : fitsPlan(L, plan, fa.ask, fa.exp, extraRoom);
        if (!fit.ok) continue;
        const row = plan[0];
        push("sign", `Sign ${fa.name} (OVR ${fa.s.ovr}, ${fmtMoney(fa.ask)} through ${fa.exp}, value +${fa.surplus.toFixed(1)})`, () => sign(L, fa, "", acts.find((a) => a.pids[0] === fa.pid && a.kind === "sign").ex), [fa.pid], {
          sig: `sign:${fa.pid}`,
          ex: ex(size < L.capInfo.minRoster ? `Roster below the minimum (${size}/${L.capInfo.minRoster}).` : `Positive value for ${st.label}; fits the three-season payroll plan.`,
            [`value ${sgn(fa.surplus)}`, `roster ${size} → ${size + 1}`],
            [`${fmtMoney(fa.ask)} a year through ${fa.exp}`, row && isFinite(row.limit) ? `${row.season} payroll ${fmtMoney(row.total + fa.ask)} of ${fmtMoney(row.limit)} limit (incl. ${fmtMoney(row.reserve)} reserved)` : ""].filter(Boolean)),
        });
        size++; payroll += fa.ask; signed++; signedPay += fa.ask;
        if (acts.filter((a) => a.kind === "sign").length >= 3) break;
      }
    }
    if (m.trades && includeTrades && tradesAllowed(L)) {
      const { ideas } = await tradeIdeas(L, { shop: 3 });
      // Don't take on more players than the roster holds, don't undo recent moves, don't retry rejected deals.
      const hardOk = (x) => L.capInfo.type !== "hard" || !L.capInfo.cap || L.capInfo.payroll + signedPay + PR().tradePayrollDelta(L, x.teams) <= L.capInfo.cap;
      const best = ideas.find((x) => isNecessary(L, x.impact, settings) && !x.ruleBreak && x.rosterAfter + signed + rosterAdds + pendingDraft <= L.capInfo.maxRoster && hardOk(x) && !memoryBlock(L, mem, x.teams, x.impact.score));
      if (best) {
        const why = impactText(L, best.impact);
        const exT = explainTrade(L, best.impact);
        push("trade", `Trade ${best.desc.give.join(", ")} to ${best.desc.team} for ${best.desc.get.join(", ")} (${why})`, async () => {
          let r = await proposeTrade(L, best.teams, why, exT);
          // Rejected: ask BBGM's "What would make this work?" once. Take the counter-offer only if it still clears
          // the strategy's bar, fits the roster, and asks for nothing protected.
          if (!(r && r.accepted)) {
            const counter = await counterOffer(L, best.teams, settings, signed + rosterAdds + pendingDraft);
            if (counter) {
              const why2 = impactText(L, counter.impact);
              r = await proposeTrade(L, counter.teams, `${why2}; after BBGM's counter-offer`, explainTrade(L, counter.impact));
            }
          }
          // BBGM's message says why (AI changed its mind, salary rules, roster limits…); keep it readable in the log.
          if (!r || !r.accepted) throw new Error(`Trade rejected${r && r.message ? `: ${String(r.message).replace(/<[^>]+>/g, "").trim()}` : ""}`);
          return r;
        }, [...best.teams[0].pids, ...best.teams[1].pids], { approval: best.protect === "ask", why: best.protect === "ask" ? `Ask first: ${PR().protectedNames(L, best.teams[0].pids, best.teams[0].dpids, "ask").join(", ")}` : "",
          sig: `trade:${SG.sigOf(best.teams)}`, ex: exT });
      }
    }
    return acts;
  }

  /**
   * A trade is only made when it clears the minimum improvement for the active strategy's objective
   * (see strategy.js: rating now vs the next two seasons, value, picks, youth, aging, payroll, roster fit).
   * Each accepted trade must strictly improve the team, so the manager can't churn back and forth.
   */
  function isNecessary(L, im, settings) {
    const min = settings.tradeMinMov ?? 0.5;
    const key = (L.strategy && L.strategy.key) || (L.mode === "contend" ? "contend" : L.mode === "rebuild" ? "rebuild" : "develop");
    return SG.tradeOk(key, im, min);
  }
  function impactText(L, im) {
    const f = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
    return `team rating ${f(im.now)} now (~${f(im.winsNow)} wins), ${f(im.future)} next 2 seasons`;
  }

  // Moves already made at a given game state, so a re-render, retry or double click can't repeat them.
  const doneLedger = new Set();
  /**
   * Runs actions in order with safeguards:
   *  - shouldStop(): stop between actions (never in the middle of one)
   *  - check(a): re-validates the game state before each action (e.g. BBGM started simulating, or the
   *    phase/day changed since the plan was made); the rest of a stale plan is skipped
   *  - stateKey: with each action's signature, makes actions idempotent per game state
   * Failures are logged and counted; an action that keeps failing is left out of later plans for a while.
   */
  async function runActions(acts, { stateKey, check, shouldStop } = {}) {
    const results = [];
    const mem = await loadMem();
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      if (shouldStop && shouldStop()) { acts.slice(i).forEach((x) => results.push({ a: x, ok: false, skipped: true, error: "stopped" })); break; }
      const key = stateKey ? `${stateKey}|${a.sig || a.text}` : null;
      if (key && doneLedger.has(key)) { results.push({ a, ok: false, skipped: true, error: "already done" }); continue; }
      if (check) {
        const bad = await check(a).catch((e) => e.message);
        if (bad) { acts.slice(i).forEach((x) => results.push({ a: x, ok: false, skipped: true, error: bad })); break; }
      }
      try {
        const r = await a.run();
        if (key) { doneLedger.add(key); if (doneLedger.size > 2000) doneLedger.delete(doneLedger.values().next().value); }
        if (a.kind !== "trade" && a.kind !== "sign") await S.addLog({ kind: a.kind, text: a.text, pids: a.pids, undoKey: typeof r === "number" ? r : undefined, ex: a.ex || undefined });
        results.push({ a, ok: true });
      } catch (e) {
        const n = SG.recordFail(mem, a.sig || a.text, activeLidClock());
        await S.addLog({ kind: "error", text: `${a.text} failed: ${e.message}${n >= 3 ? " (failed 3 times; paused for a while)" : ""}`, pids: a.pids });
        results.push({ a, ok: false, error: e.message });
      }
    }
    SG.pruneMemory(mem, activeLidClock());
    await saveMem();
    return results;
  }
  let lastClock = 0;
  const activeLidClock = () => lastClock;
  /** Call after building a league model so failure memory uses the game clock. */
  function noteClock(L) { lastClock = clockOf(L); }

  /** Should the manager look for trades now? Trades are slow to search, so they're rate-limited. */
  async function tradeDue(lid, L, settings) {
    const key = `lastTradeScan:${lid}`;
    const last = (await S.localGet(key)) || {};
    const now = { season: L.snap.season, phase: L.snap.phase, gp: L.user ? L.user.won + L.user.lost + (L.user.tied || 0) + (L.user.otl || 0) : 0 };
    // Searching is slow (every AI team builds an offer), so it runs every N game days and once per phase.
    const due = last.season !== now.season || last.phase !== now.phase || now.gp - (last.gp || 0) >= (settings.tradeEveryDays || 1);
    return { due, mark: () => S.localSet(key, now) };
  }

  // ======================= Autopilot =======================
  function nextPlayAction(poll, settings) {
    switch (poll.phase) {
      case PH.PRESEASON: return ["untilRegularSeason", "Start the regular season"];
      case PH.REGULAR_SEASON:
      case PH.AFTER_TRADE_DEADLINE: return [settings.apStep === "week" ? "week" : "day", `Play one ${settings.apStep === "week" ? "week" : "day"}`];
      case PH.PLAYOFFS: return poll.round === -1 ? ["untilEndOfPlayIn", "Play the play-in tournament"] : ["untilEndOfRound", `Play until the end of playoff round ${poll.round != null ? poll.round + 1 : ""}`.trim()];
      case PH.DRAFT_LOTTERY: return ["untilDraft", "Go to the draft"];
      case PH.DRAFT: return [poll.userHasPick ? "untilYourNextPick" : "untilEnd", poll.userHasPick ? "Draft until your next pick" : "Finish the draft"];
      case PH.AFTER_DRAFT: return ["untilResignPlayers", "Go to re-signing"];
      case PH.RESIGN_PLAYERS: return ["untilFreeAgency", "Go to free agency"];
      case PH.FREE_AGENCY: return ["untilPreseason", "Finish free agency (players develop in the new preseason)"];
      case -1: return ["untilEnd", "Finish the fantasy draft"]; // FANTASY_DRAFT
      case -2: return ["untilEnd", "Finish the expansion draft"]; // EXPANSION_DRAFT (after protection is done)
      default: return [null, "Unknown phase"];
    }
  }
  function stopHere(poll, settings, startSeason) {
    if (poll.season - startSeason >= settings.apSeasons && poll.phase >= PH.PRESEASON && poll.phase <= PH.REGULAR_SEASON) return "Played the requested number of seasons";
    if (settings.apStopAt === "playoffs" && poll.phase === PH.PLAYOFFS) return "Reached the playoffs";
    if (settings.apStopAt === "draft" && poll.phase === PH.DRAFT) return "Reached the draft";
    if (settings.apStopAt === "freeAgency" && poll.phase === PH.FREE_AGENCY) return "Reached free agency";
    return null;
  }

  root.BBGMScoutFeatures = {
    gemVerdict, gemList, tradeIdeas, proposeTrade, evaluateCurrentTrade, targets, buildOfferFor, freeAgents, sign,
    draftBoard, tierCounts, tradeDownIdeas, draftStep, managerPlan, runActions, tradeDue, isNecessary, impactText, minutesPlan, nextPlayAction, stopHere, tradesAllowed, PT, fmtMoney,
    explainTrade, payrollPlan, fitsPlan, setLeague, loadMem, saveMem, memoryBlock, clockOf, noteClock,
  };
})(globalThis);
