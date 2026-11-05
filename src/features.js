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
  const { PH, PL } = LG;
  const EMPTY_LOOKING_FOR = { positions: {}, skills: {}, assets: { draftPicks: false, prospects: false, bestCurrentPlayers: false } };
  const PT = { 0: "Out of rotation (0)", 0.75: "Fewer minutes (−)", 1: "Normal", 1.25: "More minutes (+)", 1.75: "Much more (++)" };

  const tradeTeams = (userTid, upids, udpids, tid, pids, dpids) => [
    { tid: userTid, pids: upids, dpids: udpids, pidsExcluded: [], dpidsExcluded: [] },
    { tid, pids, dpids, pidsExcluded: [], dpidsExcluded: [] },
  ];
  const fmtMoney = (k) => (k >= 1000 ? `$${(k / 1000).toFixed(1)}M` : `$${Math.round(k)}k`);
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

  // ======================= Trade Helper =======================
  const tradesAllowed = (L) => !(L.snap.phase >= PH.AFTER_TRADE_DEADLINE && L.snap.phase <= PH.PLAYOFFS);

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
        ideas.push({ teams, gain: impact.value, impact, rosterAfter, protect, ruleBreak, desc: describeTrade(L, teams) });
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

  async function proposeTrade(L, teams, why) {
    await B.call("main", "createTrade", teams);
    const r = await B.call("main", "proposeTrade", false);
    const d = describeTrade(L, teams);
    if (r && r.accepted) {
      await S.addLog({ kind: "trade", text: `Traded ${d.give.join(", ") || "nothing"} to ${d.team} for ${d.get.join(", ") || "nothing"}${why ? ` (${why})` : ""}`, undoKey: r.undoKey, pids: [...teams[0].pids, ...teams[1].pids] });
    } else {
      await B.call("main", "clearTrade", "all").catch(() => {});
    }
    return r;
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
  async function sign(L, fa, why) {
    const r = await B.call("main", "acceptContractNegotiation", { pid: fa.pid, amount: fa.ask, exp: fa.exp });
    if (typeof r === "string") throw new Error(r.replace(/<[^>]+>/g, ""));
    await S.addLog({ kind: "sign", text: `Signed ${fa.name} (${fmtMoney(fa.ask)} through ${fa.exp})${why ? ` (${why})` : ""}`, undoKey: typeof r === "number" ? r : undefined, pids: [fa.pid] });
    return r;
  }

  // ======================= Auto Drafter =======================
  function draftBoard(L) {
    const year = L.snap.phase === PH.DRAFT ? L.snap.season : L.draftSeason;
    const list = [...L.byPid.values()].filter((v) => v.p.tid === PL.UNDRAFTED && v.p.draft && v.p.draft.year === year);
    const byMarket = [...list].sort((a, b) => b.market - a.market).map((v) => v.p.pid);
    return list
      .sort((a, b) => b.draftTalent - a.draftTalent)
      .map((v, i) => ({ pid: v.p.pid, name: LG.name(L, v.p.pid), s: v.summary, value: v.draftTalent, ourRank: i + 1, marketRank: byMarket.indexOf(v.p.pid) + 1, gem: Math.round(v.gemScore) }));
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
    const healthy = mine.filter((v) => !(v.p.injury && v.p.injury.gamesRemaining > 0)).sort((a, b) => shownOvr(b) - shownOvr(a));
    const R = settings.rotationSize || 10;
    const plan = new Map();
    for (const v of mine) if (v.p.injury && v.p.injury.gamesRemaining > 0) plan.set(v.p.pid, [0, `injured (${v.p.injury.gamesRemaining} games)`]);
    healthy.forEach((v, i) => {
      const age = v.summary.age;
      let pt = 1, why = "rotation player";
      if (i >= R + 2 && healthy.length > R + 2) { pt = 0; why = `#${i + 1} on the depth chart; shouldn't play`; }
      else if (i >= R) { pt = 0.75; why = "end of bench"; }
      if (L.mode === "contend" && i < 2 && healthy[2] && shownOvr(v) - shownOvr(healthy[2]) >= 4) { pt = 1.25; why = "best player; contending"; }
      if (L.mode === "rebuild" && i >= 5 && i < R + 2 && age <= 23 && v.summary.ceiling >= 58) {
        pt = 1.25; why = "young, high-upside: more minutes keep the player happy (playing time affects mood, not progression)";
      }
      if (settings.tank && L.mode === "rebuild" && i < 3 && age >= 26) { pt = 0.75; why = "tanking: resting veterans for better lottery odds"; }
      plan.set(v.p.pid, [pt, why]);
    });
    return mine
      .map((v) => ({ v, pt: plan.get(v.p.pid)[0], why: plan.get(v.p.pid)[1] }))
      .filter((x) => x.pt !== (x.v.p.ptModifier ?? 1));
  }

  /** Builds the list of actions the manager wants to take right now. Each has run(). */
  async function managerPlan(L, settings, { lid, includeTrades }) {
    const acts = [];
    const m = settings.manage;
    const phase = L.snap.phase;
    const u = L.user;
    // approval: the move involves an "Ask first" asset, so it always waits for the user.
    const push = (kind, text, run, pids = [], opts = {}) => acts.push({ kind, text, run, pids, approval: !!opts.approval, why: opts.why || "" });
    const lvl = (pid) => PR().playerLevel(pid);
    const rules = (o) => PR().contractRuleBreak(L, settings, o);

    if (m.finances && L.snap.ga.budget !== false && u && u.budget) {
      const want = FIN[settings.financeStyle] || FIN.balanced;
      const lvl = (k) => (typeof u.budget[k] === "number" ? u.budget[k] : u.budget[k] && u.budget[k].level);
      const differs = Object.keys(want).some((k) => Math.abs((lvl(k) || 0) - want[k]) > 1) || !u.autoTicketPrice;
      if (differs) {
        push("finances", `Set budget: coaching ${want.coaching}, health ${want.health}, facilities ${want.facilities}, scouting ${want.scouting}; auto ticket price (${settings.financeStyle})`, () =>
          B.call("main", "updateBudget", { budgetLevels: { ...want, ticketPrice: typeof u.budget.ticketPrice === "number" ? u.budget.ticketPrice : (u.budget.ticketPrice || {}).amount }, adjustForInflation: u.adjustForInflation !== false, autoTicketPrice: true }));
      }
    }
    if (m.roster && u && !u.keepRosterSorted) {
      push("roster", "Turn on 'Keep auto sorted' so the lineup always follows the best available players", () => B.call("main", "updateKeepRosterSorted", { tid: L.snap.userTid, keepRosterSorted: true }));
    }
    if (m.minutes && (phase === PH.REGULAR_SEASON || phase === PH.AFTER_TRADE_DEADLINE || phase === PH.PLAYOFFS || phase === PH.PRESEASON)) {
      for (const x of minutesPlan(L, settings)) {
        push("minutes", `${LG.name(L, x.v.p.pid)}: ${PT[x.pt]} (${x.why})`, () => B.call("main", "updatePlayingTime", { pid: x.v.p.pid, ptModifier: x.pt }), [x.v.p.pid]);
      }
    }
    if (m.resign && phase === PH.RESIGN_PLAYERS) {
      for (const pid of L.snap.negotiations) {
        const v = L.byPid.get(pid);
        if (!v || !v.p.mood) continue;
        const ask = v.p.mood.contractAmount, exp = v.p.contract.exp;
        const surplus = v.talent - L.costOf(ask, exp);
        const level = lvl(pid);
        const broken = rules({ amount: ask, exp, payrollDelta: 0 }) || rules({ exp }); // length limit; re-signing doesn't add new payroll
        const resign = () => push("resign", `Re-sign ${LG.name(L, pid)} at ${fmtMoney(ask)} through ${exp} (${level === "never" ? "protected player" : `value +${surplus.toFixed(1)}`})`, async () => {
          const r = await B.call("main", "acceptContractNegotiation", { pid, amount: ask, exp });
          if (typeof r === "string") throw new Error(r.replace(/<[^>]+>/g, ""));
          return r;
        }, [pid], { approval: !!broken || level === "ask", why: broken ? `breaks your rules: ${broken}` : level === "ask" ? "Ask first" : "" });
        if (v.p.mood.willing && (surplus > 0 || level === "never")) resign();
        else {
          const why = v.p.mood.willing ? `asking ${fmtMoney(ask)}, more than the player is worth to you` : "unwilling to re-sign";
          push("letwalk", `Let ${LG.name(L, pid)} walk (${why})`, () => B.call("main", "cancelContractNegotiation", pid), [pid],
            { approval: level !== "available", why: level === "never" ? "Never trade: you decide" : level === "ask" ? "Ask first" : "" });
        }
      }
    }
    if (m.releases && L.capInfo.rosterSize > L.capInfo.maxRoster && (phase === PH.PRESEASON || phase === PH.REGULAR_SEASON || phase === PH.AFTER_DRAFT || phase === PH.FREE_AGENCY)) {
      const extra = L.capInfo.rosterSize - L.capInfo.maxRoster;
      const mine = L.roster(L.snap.userTid).map((p) => L.byPid.get(p.pid)).filter(Boolean);
      // Cheapest to cut = lowest value, counting the salary you'd still owe.
      const cut = mine.filter((v) => lvl(v.p.pid) !== "never").map((v) => ({ v, score: v.talent - 0.3 * v.cost })).sort((a, b) => a.score - b.score).slice(0, extra);
      for (const { v } of cut) push("release", `Release ${LG.name(L, v.p.pid)} (lowest value on an over-full roster)`, () => B.call("main", "releasePlayer", { pids: [v.p.pid] }), [v.p.pid],
        { approval: lvl(v.p.pid) === "ask", why: lvl(v.p.pid) === "ask" ? "Ask first" : "" });
    }
    if (m.signings && signingAllowed(phase)) {
      let size = L.capInfo.rosterSize;
      const target = phase === PH.FREE_AGENCY || phase === PH.PRESEASON ? L.capInfo.maxRoster - 1 : L.capInfo.minRoster;
      let payroll = L.capInfo.payroll;
      for (const fa of freeAgents(L)) {
        if (size >= target && !(fa.surplus > 8 && size < L.capInfo.maxRoster)) continue;
        if (!fa.canSign || (fa.surplus <= 0 && size >= L.capInfo.minRoster)) continue;
        if (L.capInfo.type !== "none" && payroll + fa.ask > L.capInfo.cap && fa.ask > L.capInfo.minContract + 1) continue;
        push("sign", `Sign ${fa.name} (OVR ${fa.s.ovr}, ${fmtMoney(fa.ask)} through ${fa.exp}, value +${fa.surplus.toFixed(1)})`, () => sign(L, fa), [fa.pid]);
        size++; payroll += fa.ask;
        if (acts.filter((a) => a.kind === "sign").length >= 3) break;
      }
    }
    if (m.trades && includeTrades && tradesAllowed(L)) {
      const { ideas } = await tradeIdeas(L, { shop: 3 });
      const best = ideas.find((x) => isNecessary(L, x.impact, settings) && !x.ruleBreak);
      if (best) {
        const why = impactText(L, best.impact);
        push("trade", `Trade ${best.desc.give.join(", ")} to ${best.desc.team} for ${best.desc.get.join(", ")} (${why})`, async () => {
          const r = await proposeTrade(L, best.teams, why);
          if (!r || !r.accepted) throw new Error((r && r.message) || "Trade rejected");
          return r;
        }, [...best.teams[0].pids, ...best.teams[1].pids], { approval: best.protect === "ask", why: best.protect === "ask" ? `Ask first: ${PR().protectedNames(L, best.teams[0].pids, best.teams[0].dpids, "ask").join(", ")}` : "" });
      }
    }
    return acts;
  }

  /**
   * A trade is only made when it makes the team better on the goal that fits its timeline:
   *  contend: team rating now (= record) goes up, and long-term value doesn't collapse
   *  rebuild: team rating over the next two seasons goes up, and total value goes up
   *  balanced: both don't get worse and at least one improves
   * Each accepted trade must strictly improve the team, so the manager can't churn back and forth.
   */
  function isNecessary(L, im, settings) {
    const min = settings.tradeMinMov ?? 0.5;
    if (L.mode === "contend") return im.now >= min && im.future > -2 * min && im.value > -40;
    if (L.mode === "rebuild") return im.future >= min && im.value > 0;
    return im.now >= -0.1 && im.future >= -0.1 && (im.now + im.future) / 2 >= min;
  }
  function impactText(L, im) {
    const f = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
    return `team rating ${f(im.now)} now (~${f(im.winsNow)} wins), ${f(im.future)} next 2 seasons`;
  }

  async function runActions(acts) {
    const results = [];
    for (const a of acts) {
      try {
        const r = await a.run();
        if (a.kind !== "trade" && a.kind !== "sign") await S.addLog({ kind: a.kind, text: a.text, pids: a.pids, undoKey: typeof r === "number" ? r : undefined });
        results.push({ a, ok: true });
      } catch (e) {
        await S.addLog({ kind: "error", text: `${a.text} failed: ${e.message}`, pids: a.pids });
        results.push({ a, ok: false, error: e.message });
      }
    }
    return results;
  }

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
      case PH.PLAYOFFS: return ["untilEndOfRound", "Play until the end of this playoff round"];
      case PH.DRAFT_LOTTERY: return ["untilDraft", "Go to the draft"];
      case PH.DRAFT: return [poll.userHasPick ? "untilYourNextPick" : "untilEnd", poll.userHasPick ? "Draft until your next pick" : "Finish the draft"];
      case PH.AFTER_DRAFT: return ["untilResignPlayers", "Go to re-signing"];
      case PH.RESIGN_PLAYERS: return ["untilFreeAgency", "Go to free agency"];
      case PH.FREE_AGENCY: return ["untilPreseason", "Finish free agency (players develop in the new preseason)"];
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
    draftBoard, draftStep, managerPlan, runActions, tradeDue, isNecessary, impactText, minutesPlan, nextPlayAction, stopHere, tradesAllowed, PT, fmtMoney,
  };
})(globalThis);
