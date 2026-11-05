/*
 * A small, seeded stand-in for Basketball GM's game engine, for backtesting BBGM Scout's Manager and
 * Autopilot policies in Node. It implements the subset of BBGM's API the extension uses (snapshot, poll,
 * trades, signings, releases, the draft and the Play menu) with simplified rules:
 *   - games: win probability from each team's BBGM-style rating (top-10 OVRs), random injuries
 *   - progression: BBG Scout's re-implementation of BBGM's yearly progression (engine.developSeason)
 *   - AI trades: AI teams value players by a convex function of BBGM-like "value" (stars are worth much
 *     more than role players), rebuilding AI teams prefer youth; AI teams don't trade with each other
 *   - contracts, cap (soft/hard), roster limits, re-signing, free agency, lottery and a two-round draft
 * It is NOT BBGM. Results show how the policies behave relative to each other under the same simplified
 * rules and the same starting states; they don't predict results in real BBGM leagues.
 */
"use strict";
const E = require("../../src/engine.js");

const RK = E.RATING_KEYS;
const PH = { PRESEASON: 0, REGULAR_SEASON: 1, AFTER_TRADE_DEADLINE: 2, PLAYOFFS: 3, DRAFT_LOTTERY: 4, DRAFT: 5, AFTER_DRAFT: 6, RESIGN_PLAYERS: 7, FREE_AGENCY: 8 };
const FIRST = ["Alex", "Jordan", "Chris", "Sam", "Taylor", "Jamal", "Luis", "Marcus", "Andre", "Kevin", "Tyler", "Darius", "Evan", "Isaiah", "Noah", "Owen"];
const LAST = ["Smith", "Johnson", "Brown", "Lee", "Walker", "Young", "Allen", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Ramirez", "Campbell", "Mitchell"];

function createLeague({ seed = 1, numTeams = 20, rosterSize = 13, ga: gaOver = {}, scenario = "default", injuryMult = 1 } = {}) {
  const rng = E.mulberry32(seed * 7919 + 13);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const normal = (mu, sd) => mu + sd * Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());
  const ga = {
    salaryCap: 150000, minPayroll: 90000, luxuryPayroll: 189000, luxuryTax: 1.5, minContract: 1200, maxContract: 50000, maxContractLength: 5,
    maxRosterSize: 15, minRosterSize: 13, salaryCapType: "soft", numGames: 82, budget: true, godMode: false, realPlayerDeterminism: 0,
    numActiveTeams: numTeams, draftType: "nba2019", inflationAvg: 0, inflationStd: 0, numGamesPlayoffSeries: [7, 7, 7, 7], ...gaOver,
  };
  const S = { season: 2026, phase: PH.PRESEASON, day: 0, nextPid: 1, nextDpid: 1, undo: 1, userTid: 0, trade: null, negotiations: new Set(),
    playoff: null, order: [], champion: null, violations: [], history: [], deadMoney: [] };
  const players = new Map();
  const teams = [];
  for (let tid = 0; tid < numTeams; tid++) {
    teams.push({ tid, abbrev: `T${tid}`, region: `City${tid}`, name: `Team${tid}`, strategy: "contending", won: 0, lost: 0, tied: 0, otl: 0,
      budget: { coaching: 50, health: 50, facilities: 50, scouting: 34, ticketPrice: 35 }, autoTicketPrice: true, keepRosterSorted: true, adjustForInflation: true });
  }

  // ---------- players ----------
  function ratingsAt(level, age) {
    const r = {};
    for (const k of RK) r[k] = Math.max(0, Math.min(100, Math.round(normal(level, 9))));
    r.hgt = Math.max(0, Math.min(100, Math.round(normal(level, 14))));
    if (age >= 30) { r.spd -= 5; r.jmp -= 5; r.oiq += 6; r.diq += 6; }
    return r;
  }
  const ovrOf = (p) => E.ovr(p.r);
  function potOf(p) { const age = S.season - p.bornYear, o = ovrOf(p); return age < 25 ? Math.min(100, Math.round(o + (25 - age) * 2.6)) : o; }
  function valueOf(p) { // BBGM-like market value: current OVR, plus potential for the young
    const age = S.season - p.bornYear, o = ovrOf(p), pot = potOf(p);
    if (age <= 19) return 0.7 * pot + 0.3 * o; if (age <= 22) return 0.55 * pot + 0.45 * o; if (age <= 24) return 0.3 * pot + 0.7 * o;
    return o - Math.max(0, age - 29) * 1.5;
  }
  const amountFor = (v) => Math.round((ga.minContract + (ga.maxContract - ga.minContract) * Math.pow(Math.max(0, Math.min(1, (v - 45) / 30)), 2)) / 10) * 10;
  function newPlayer(tid, age, level, extra = {}) {
    const pid = S.nextPid++;
    const p = { pid, tid, firstName: FIRST[pid % FIRST.length], lastName: `${LAST[(pid * 7) % LAST.length]}${pid}`, bornYear: S.season - age,
      r: ratingsAt(level, age), injury: null, ptModifier: 1, history: [], draft: null, willing: rng() < 0.75, ...extra };
    const v = valueOf(p);
    p.contract = { amount: amountFor(v), exp: S.season + ri(0, 3) };
    players.set(pid, p);
    return p;
  }
  function draftClass(year, n) {
    for (let i = 0; i < n; i++) {
      const age = 19 + ri(0, 2) - (year - S.season);
      const p = newPlayer(-2, Math.max(16, age), normal(40, 6) - 3 * (year - S.season), { draft: { year, round: 0, pick: 0 } });
      p.contract = { amount: ga.minContract, exp: year + 3 };
    }
  }
  for (const t of teams) for (let i = 0; i < rosterSize; i++) newPlayer(t.tid, ri(20, 33), normal(50, 7));
  for (let i = 0; i < 25; i++) newPlayer(-1, ri(21, 33), normal(44, 5));
  draftClass(S.season, 45); draftClass(S.season + 1, 45); draftClass(S.season + 2, 45);
  const draftPicks = [];
  const addPicks = (season) => { for (const t of teams) for (const round of [1, 2]) draftPicks.push({ dpid: S.nextDpid++, tid: t.tid, originalTid: t.tid, season, round, pick: 0 }); };
  for (let y = 0; y < 4; y++) addPicks(S.season + y);

  const roster = (tid) => [...players.values()].filter((p) => p.tid === tid);
  const teamMov = (tid, noInj) => {
    const ov = roster(tid).filter((p) => (noInj || !p.injury) && p.ptModifier !== 0).map(ovrOf).sort((a, b) => b - a).slice(0, 10);
    while (ov.length < 10) ov.push(0);
    return -102.98 + ov.reduce((s, o, i) => s + 0.3334 * Math.exp(-0.1609 * i) * o, 0); // BBGM's team rating (MOV)
  };

  // ---------- scenarios: reshape the user's team from the same random league ----------
  const strongest = [...players.values()].filter((p) => p.tid >= 0).sort((a, b) => ovrOf(b) - ovrOf(a));
  function swapInto(tid, pick) { // give the user team the chosen players, sending its own to their teams
    const mine = roster(tid);
    pick.forEach((p, i) => { const other = mine[i]; if (!other || p.tid === tid) return; other.tid = p.tid; p.tid = tid; });
  }
  if (scenario === "contender") swapInto(0, strongest.filter((p) => p.tid !== 0).slice(0, 6));
  if (scenario === "rebuilding") swapInto(0, [...strongest].reverse().filter((p) => p.tid !== 0).slice(0, 8));
  if (scenario === "aging") {
    const vets = strongest.filter((p) => p.tid !== 0 && S.season - p.bornYear >= 29).slice(0, 6);
    swapInto(0, vets);
    for (const p of roster(0)) if (S.season - p.bornYear >= 29) { p.bornYear = S.season - ri(31, 34); p.contract = { amount: Math.min(ga.maxContract, Math.round(p.contract.amount * 1.8)), exp: S.season + 2 }; }
  }

  const payroll = (tid) => roster(tid).reduce((s, p) => s + p.contract.amount, 0) + S.deadMoney.filter((d) => d.tid === tid && d.exp >= S.season).reduce((s, d) => s + d.amount, 0);
  const gp = (t) => t.won + t.lost;
  const record = (t) => t.won / Math.max(1, gp(t));
  function updateStrategies() { // BBGM-like: AI teams in the bottom half rebuild
    const order = [...teams].sort((a, b) => teamMov(b.tid, true) - teamMov(a.tid, true));
    order.forEach((t, i) => { t.strategy = i < teams.length / 2 ? "contending" : "rebuilding"; });
  }
  updateStrategies();

  // ---------- AI valuation for trades ----------
  function aiVal(p, team) {
    const age = S.season - p.bornYear;
    let v = Math.pow(Math.max(0, valueOf(p)) / 50, 5) * 10;
    if (team && team.strategy === "rebuilding") v *= age <= 24 ? 1.25 : age >= 29 ? 0.7 : 1;
    const contractYears = p.contract.exp - S.season + 1;
    v -= (p.contract.amount / ga.maxContract) * 2 * Math.max(0, contractYears) * (team && team.strategy === "rebuilding" ? 1.2 : 0.8);
    return v;
  }
  function pickVal(dp, team) {
    const orig = teams[dp.originalTid];
    const rank = [...teams].sort((a, b) => record(a) - record(b)).indexOf(orig);
    const base = dp.round === 1 ? 6 + 8 * (1 - rank / teams.length) : 1;
    return base * (team && team.strategy === "rebuilding" ? 1.3 : 1) * Math.pow(0.9, Math.max(0, dp.season - S.season));
  }
  const assetsVal = (pids, dpids, team) => pids.reduce((s, pid) => s + aiVal(players.get(pid), team), 0) + dpids.reduce((s, d) => s + pickVal(draftPicks.find((x) => x.dpid === d), team), 0);
  const inSeason = () => S.phase === PH.REGULAR_SEASON || S.phase === PH.PRESEASON;
  function rosterWarning(uPids, oTid, oPids) {
    const u = roster(S.userTid).length - uPids.length + oPids.length;
    const o = roster(oTid).length - oPids.length + uPids.length;
    if (S.phase === PH.REGULAR_SEASON && (u > ga.maxRosterSize || o > ga.maxRosterSize)) return "over the roster limit";
    if (ga.salaryCapType === "hard") {
      const sal = (ids) => ids.reduce((s, pid) => s + players.get(pid).contract.amount, 0);
      if (payroll(S.userTid) - sal(uPids) + sal(oPids) > ga.salaryCap) return "over the hard cap";
    }
    return null;
  }

  // ---------- season sim ----------
  function playDay() {
    if (S.phase !== PH.REGULAR_SEASON && S.phase !== PH.AFTER_TRADE_DEADLINE) return;
    const n = roster(S.userTid).length;
    if (n > ga.maxRosterSize || n < Math.min(ga.minRosterSize, 5)) {
      S.violations.push(`day ${S.day}: roster ${n} outside limits`);
      throw new Error(`Your roster has ${n} players; BBGM requires ${ga.minRosterSize}–${ga.maxRosterSize}`);
    }
    for (const t of teams) if (t.tid !== S.userTid) aiFixRoster(t.tid);
    const ids = teams.map((t) => t.tid).sort(() => rng() - 0.5);
    for (let i = 0; i + 1 < ids.length; i += 2) {
      const a = ids[i], b = ids[i + 1];
      const pa = 1 / (1 + Math.exp(-(teamMov(a) - teamMov(b)) / 7));
      const w = rng() < pa ? a : b, l = w === a ? b : a;
      teams[w].won++; teams[l].lost++;
      for (const tid of [a, b]) for (const p of roster(tid)) {
        if (p.injury) { if (--p.injury.gamesRemaining <= 0) p.injury = null; }
        else if (rng() < 0.0035 * injuryMult) p.injury = { type: "Sprained Ankle", gamesRemaining: ri(1, 30) };
      }
    }
    S.day++;
    if (S.day >= Math.round(ga.numGames * 0.6) && S.phase === PH.REGULAR_SEASON) S.phase = PH.AFTER_TRADE_DEADLINE;
    if (S.day >= ga.numGames) startPlayoffs();
  }
  function startPlayoffs() {
    S.phase = PH.PLAYOFFS;
    const seeds = [...teams].sort((a, b) => record(b) - record(a)).slice(0, 8).map((t) => t.tid);
    S.playoff = { round: 0, alive: seeds, roundsWon: Object.fromEntries(teams.map((t) => [t.tid, seeds.includes(t.tid) ? 0 : -1])) };
  }
  function playRound() {
    const P = S.playoff, next = [];
    for (let i = 0; i < P.alive.length / 2; i++) {
      const a = P.alive[i], b = P.alive[P.alive.length - 1 - i];
      const pa = 1 / (1 + Math.exp(-(teamMov(a) - teamMov(b)) / 7));
      let wa = 0, wb = 0;
      while (wa < 4 && wb < 4) rng() < pa ? wa++ : wb++;
      const w = wa === 4 ? a : b;
      P.roundsWon[w]++; next.push(w);
    }
    P.alive = next; P.round++;
    if (P.alive.length === 1) { S.champion = P.alive[0]; endSeason(); }
  }
  function endSeason() {
    S.history.push({ season: S.season, rows: teams.map((t) => ({ tid: t.tid, season: S.season, won: t.won, lost: t.lost, tied: 0, otl: 0, prw: S.playoff.roundsWon[t.tid], salary: payroll(t.tid) })) });
    S.phase = PH.DRAFT_LOTTERY;
  }
  function lottery() {
    const worst = [...teams].sort((a, b) => record(a) - record(b)).map((t) => t.tid);
    const lot = worst.slice(0, Math.ceil(teams.length * 0.6));
    const top = [];
    for (let i = 0; i < 4 && lot.length; i++) top.push(lot.splice(Math.floor(Math.pow(rng(), 1.6) * lot.length), 1)[0]);
    const firstRound = [...top, ...worst.filter((t) => !top.includes(t))];
    const secondRound = worst;
    S.order = [];
    [firstRound, secondRound].forEach((ord, r) => ord.forEach((origTid, i) => {
      const dp = draftPicks.find((d) => d.season === S.season && d.round === r + 1 && d.originalTid === origTid);
      if (dp) { dp.pick = i + 1; S.order.push(dp); }
    }));
    S.phase = PH.DRAFT;
  }
  function makePick(dp, pid) {
    const p = players.get(pid);
    if (!p || p.tid !== -2 || !p.draft || p.draft.year !== S.season) throw new Error("Invalid draft pick");
    p.tid = dp.tid; p.draft = { year: S.season, round: dp.round, pick: dp.pick };
    p.contract = { amount: dp.round === 1 ? Math.round(ga.minContract * (1 + 3 * (1 - dp.pick / teams.length))) : ga.minContract, exp: S.season + (dp.round === 1 ? 3 : 2) };
    draftPicks.splice(draftPicks.indexOf(dp), 1);
    S.order.shift();
  }
  function aiPicksUntilUser(stopAtUser) {
    while (S.order.length && !(stopAtUser && S.order[0].tid === S.userTid)) {
      const dp = S.order[0];
      const best = [...players.values()].filter((p) => p.tid === -2 && p.draft.year === S.season).sort((a, b) => valueOf(b) - valueOf(a))[0];
      if (!best) { S.order.shift(); continue; }
      makePick(dp, best.pid);
    }
    if (!S.order.length) S.phase = PH.AFTER_DRAFT;
  }
  function aiFixRoster(tid) {
    const r = roster(tid);
    if (r.length > ga.maxRosterSize) r.sort((a, b) => valueOf(a) - valueOf(b)).slice(0, r.length - ga.maxRosterSize).forEach((p) => release(p));
    let n = roster(tid).length;
    if (n < ga.minRosterSize) {
      const fas = [...players.values()].filter((p) => p.tid === -1).sort((a, b) => valueOf(b) - valueOf(a));
      for (const p of fas) { if (n >= ga.minRosterSize) break; p.tid = tid; p.contract = { amount: ga.minContract, exp: S.season + 1 }; n++; }
      while (n < ga.minRosterSize) { newPlayer(tid, 24, 40); n++; }
    }
  }
  function release(p) {
    if (p.contract.exp >= S.season && p.tid >= 0) S.deadMoney.push({ tid: p.tid, amount: p.contract.amount, exp: p.contract.exp });
    p.tid = -1;
  }
  function resignPhase() {
    S.phase = PH.RESIGN_PLAYERS;
    S.negotiations = new Set(roster(S.userTid).filter((p) => p.contract.exp <= S.season).map((p) => p.pid));
    for (const t of teams) if (t.tid !== S.userTid) for (const p of roster(t.tid)) if (p.contract.exp <= S.season) {
      if (valueOf(p) >= 52 && rng() < 0.7) p.contract = { amount: amountFor(valueOf(p)), exp: S.season + 1 + ri(1, 3) }; else p.tid = -1;
    }
  }
  function freeAgency() {
    for (const pid of S.negotiations) { const p = players.get(pid); if (p) p.tid = -1; }
    S.negotiations = new Set();
    for (const p of players.values()) if (p.tid === -1) { p.contract = { amount: amountFor(valueOf(p)), exp: S.season + 1 + ri(0, 3) }; p.willing = rng() < 0.75; }
    S.phase = PH.FREE_AGENCY;
  }
  function newSeason() {
    for (const t of teams) if (t.tid !== S.userTid) { // AI fills toward 14 with the best free agents it can afford
      const fas = [...players.values()].filter((p) => p.tid === -1).sort((a, b) => valueOf(b) - valueOf(a));
      for (const p of fas) {
        if (roster(t.tid).length >= 14) break;
        if (payroll(t.tid) + p.contract.amount > ga.salaryCap && p.contract.amount > ga.minContract) continue;
        p.tid = t.tid;
      }
      aiFixRoster(t.tid);
    }
    S.season++;
    S.deadMoney = S.deadMoney.filter((d) => d.exp >= S.season);
    for (const p of players.values()) {
      if (p.tid === -3) continue;
      const age = S.season - p.bornYear;
      const coach = p.tid >= 0 ? teams[p.tid].budget.coaching : 50;
      E.developSeason(p.r, age, coach, rng);
      if (p.tid !== -2 && age >= 34 && (ovrOf(p) < 55 || rng() < 0.4)) { if (p.tid >= 0) aiFixRoster(p.tid); p.tid = -3; }
      if (p.injury) p.injury = null;
      p.ptModifier = p.ptModifier ?? 1;
    }
    for (const p of players.values()) if (p.tid === -2 && p.draft.year < S.season) p.tid = -1; // undrafted
    draftClass(S.season + 2, 45);
    addPicks(S.season + 3);
    for (const t of teams) { t.won = 0; t.lost = 0; }
    for (const t of teams) aiFixRoster(t.tid === S.userTid ? -99 : t.tid);
    updateStrategies();
    S.phase = PH.PRESEASON; S.day = 0; S.playoff = null; S.champion = null;
  }

  // ---------- the API the extension calls ----------
  function snapshot() {
    const cur = (p) => {
      const o = { season: S.season, ovr: ovrOf(p), pot: potOf(p), fuzz: 0, pos: "F", locked: false, skills: [] };
      for (const k of RK) o[k] = p.r[k];
      return o;
    };
    const list = [...players.values()].filter((p) => p.tid >= -2);
    const fas = new Set(list.filter((p) => p.tid === -1).map((p) => p.pid));
    return {
      userTid: S.userTid, season: S.season, phase: S.phase, ga: { ...ga, userTids: [S.userTid] },
      teams: teams.map((t) => ({ ...t, budget: { ...t.budget }, payroll: payroll(t.tid) })),
      players: list.map((p) => ({ pid: p.pid, tid: p.tid, firstName: p.firstName, lastName: p.lastName, born: { year: p.bornYear }, ratings: [cur(p)],
        contract: { ...p.contract }, value: valueOf(p), valueFuzz: valueOf(p), srID: 0, injury: p.injury ? { ...p.injury } : null, draft: p.draft ? { ...p.draft } : null,
        untradable: p.tid === S.userTid && S.phase === PH.DRAFT && p.draft && p.draft.year === S.season, ptModifier: p.ptModifier, rosterOrder: 0,
        mood: fas.has(p.pid) || S.negotiations.has(p.pid) ? { willing: S.negotiations.has(p.pid) ? true : p.willing, contractAmount: S.negotiations.has(p.pid) ? amountFor(valueOf(p)) : p.contract.amount } : undefined })),
      negotiations: [...S.negotiations], draftPicks: draftPicks.map((d) => ({ ...d })), order: S.phase === PH.DRAFT ? S.order.map((d) => ({ dpid: d.dpid, tid: d.tid, round: d.round, pick: d.pick })) : [],
      trade: S.trade, leagueStats: null, gameSim: false,
    };
  }
  function poll() {
    const u = teams[S.userTid];
    return { inLeague: true, userTid: S.userTid, season: S.season, phase: S.phase, gp: gp(u), onClock: S.phase === PH.DRAFT && S.order[0] ? S.order[0].tid : null,
      userHasPick: S.phase === PH.DRAFT && S.order.some((d) => d.tid === S.userTid), round: S.playoff ? S.playoff.round : null,
      prog: S.playoff ? S.playoff.round * 1000 + S.order.length : S.order.length, sched: ga.numGames * teams.length / 2 - S.day * teams.length / 2, daysLeft: 0,
      gameSim: false, drafting: false, godMode: false, multiTeam: false, spectator: false };
  }
  const tradeSides = (teamsArg) => ({ u: teamsArg[0], o: teamsArg[1] });
  function executeTrade(t) {
    const { u, o } = tradeSides(t);
    for (const pid of u.pids) players.get(pid).tid = o.tid;
    for (const pid of o.pids) players.get(pid).tid = u.tid;
    for (const d of u.dpids) draftPicks.find((x) => x.dpid === d).tid = o.tid;
    for (const d of o.dpids) draftPicks.find((x) => x.dpid === d).tid = u.tid;
    for (const d of S.order) d.tid = draftPicks.find((x) => x.dpid === d.dpid) ? draftPicks.find((x) => x.dpid === d.dpid).tid : d.tid;
  }
  const valid = (t) => {
    const { u, o } = tradeSides(t);
    return u.pids.every((pid) => players.get(pid) && players.get(pid).tid === u.tid) && o.pids.every((pid) => players.get(pid) && players.get(pid).tid === o.tid)
      && u.dpids.every((d) => draftPicks.some((x) => x.dpid === d && x.tid === u.tid)) && o.dpids.every((d) => draftPicks.some((x) => x.dpid === d && x.tid === o.tid));
  };
  async function call(cat, name, param) {
    const key = `${cat}.${name}`;
    switch (key) {
      case "main.getTradingBlockOffers": {
        if (S.phase >= PH.AFTER_TRADE_DEADLINE && S.phase <= PH.PLAYOFFS) return [];
        const offers = [];
        for (const t of teams) {
          if (t.tid === S.userTid) continue;
          const want = assetsVal(param.pids, param.dpids, t) * 0.95;
          if (want <= 0.5) continue;
          const theirs = roster(t.tid).filter((p) => !p.injury).map((p) => ({ p, v: aiVal(p, t) })).filter((x) => x.v > 0.2).sort((a, b) => b.v - a.v);
          const pkg = []; let got = 0;
          for (const x of theirs) { if (got + x.v <= want) { pkg.push(x.p.pid); got += x.v; } if (pkg.length >= 3) break; }
          const picks = [];
          if (got < 0.6 * want) for (const d of draftPicks.filter((d) => d.tid === t.tid && d.season > S.season)) { const v = pickVal(d, t); if (got + v <= want) { picks.push(d.dpid); got += v; } if (got >= 0.6 * want) break; }
          if (got < 0.5 * want || (!pkg.length && !picks.length)) continue;
          const warning = rosterWarning(param.pids, t.tid, pkg);
          offers.push({ tid: t.tid, pids: pkg, dpids: picks, pidsUser: [...param.pids], dpidsUser: [...param.dpids], summary: { warning } });
        }
        return offers;
      }
      case "main.createTrade": S.trade = param.map((x) => ({ ...x, pids: [...x.pids], dpids: [...x.dpids] })); return null;
      case "main.clearTrade": S.trade = null; return null;
      case "main.tradeCounterOffer": return { message: "Not interested." };
      case "main.proposeTrade": {
        const t = S.trade;
        if (!t || !valid(t)) { S.trade = null; return { accepted: false, message: "Invalid trade" }; }
        if (S.phase >= PH.AFTER_TRADE_DEADLINE && S.phase <= PH.PLAYOFFS) return { accepted: false, message: "Trade deadline has passed" };
        const { u, o } = tradeSides(t);
        const team = teams[o.tid];
        const warn = rosterWarning(u.pids, o.tid, o.pids);
        if (warn) return { accepted: false, message: warn };
        if (assetsVal(u.pids, u.dpids, team) < assetsVal(o.pids, o.dpids, team)) return { accepted: false, message: "The AI rejected it" };
        executeTrade(t); S.trade = null;
        return { accepted: true, message: "Accepted", undoKey: S.undo++ };
      }
      case "main.acceptContractNegotiation": {
        const p = players.get(param.pid);
        if (!p) return "No such player";
        const resign = S.negotiations.has(p.pid);
        if (!resign && !(p.tid === -1 && [0, 1, 2, 8].includes(S.phase))) return "You can't sign players now";
        if (!resign && !p.willing) return "Refuses to negotiate with you";
        if (!resign && roster(S.userTid).length >= ga.maxRosterSize) return "Your roster is full";
        const pay = payroll(S.userTid) - (resign ? p.contract.amount : 0);
        if (ga.salaryCapType === "hard" && pay + param.amount > ga.salaryCap) return "Over the hard cap";
        if (ga.salaryCapType === "soft" && !resign && pay + param.amount > ga.salaryCap && param.amount > ga.minContract) return "Over the cap";
        p.tid = S.userTid; p.contract = { amount: param.amount, exp: Math.max(param.exp, S.season + (S.phase >= PH.RESIGN_PLAYERS ? 1 : 0)) };
        S.negotiations.delete(p.pid);
        return S.undo++;
      }
      case "main.cancelContractNegotiation": { const p = players.get(param); if (p) p.tid = -1; S.negotiations.delete(param); return null; }
      case "main.releasePlayer": for (const pid of param.pids) { const p = players.get(pid); if (p && p.tid === S.userTid) release(p); } return null;
      case "main.updateBudget": Object.assign(teams[S.userTid].budget, param.budgetLevels); teams[S.userTid].autoTicketPrice = !!param.autoTicketPrice; return null;
      case "main.updateKeepRosterSorted": teams[S.userTid].keepRosterSorted = !!param.keepRosterSorted; return null;
      case "main.updatePlayingTime": { const p = players.get(param.pid); if (p) p.ptModifier = param.ptModifier; return null; }
      case "main.draftUser": {
        if (S.phase !== PH.DRAFT || !S.order[0] || S.order[0].tid !== S.userTid) throw new Error("You're not on the clock");
        makePick(S.order[0], param); if (!S.order.length) S.phase = PH.AFTER_DRAFT; return null;
      }
      case "main.idbCacheFlush": case "main.autoSortRoster": return null;
      case "playMenu.untilRegularSeason": if (S.phase === PH.PRESEASON) S.phase = PH.REGULAR_SEASON; return null;
      case "playMenu.day": playDay(); return null;
      case "playMenu.week": for (let i = 0; i < 7 && (S.phase === 1 || S.phase === 2); i++) playDay(); return null;
      case "playMenu.untilEndOfRound": case "playMenu.untilEndOfPlayIn": if (S.phase === PH.PLAYOFFS) playRound(); return null;
      case "playMenu.untilDraft": if (S.phase === PH.DRAFT_LOTTERY) lottery(); return null;
      case "playMenu.untilYourNextPick": aiPicksUntilUser(true); return null;
      case "playMenu.untilEnd": aiPicksUntilUser(false); return null;
      case "playMenu.untilResignPlayers": if (S.phase === PH.AFTER_DRAFT) resignPhase(); return null;
      case "playMenu.untilFreeAgency": if (S.phase === PH.RESIGN_PLAYERS) freeAgency(); return null;
      case "playMenu.untilPreseason": if (S.phase === PH.FREE_AGENCY) newSeason(); return null;
      case "playMenu.stop": return null;
      default: throw new Error(`Mock BBGM: unsupported action ${key}`);
    }
  }
  const bridge = {
    call, poll: async () => poll(), snapshot: async () => snapshot(),
    readTrade: async () => ({ teams: S.trade }), evalJSON: async () => { throw new Error("evalJSON not supported in the mock"); },
    history: async (from, to) => ({ userTid: S.userTid, nr: 3, rows: S.history.filter((h) => h.season >= from && h.season <= to).flatMap((h) => h.rows) }),
  };
  /** Ground-truth measures the policies can't see directly. */
  const truth = {
    rosterValue: () => roster(S.userTid).map(valueOf).sort((a, b) => b - a).slice(0, 10).reduce((s, v) => s + v, 0),
    payroll: () => payroll(S.userTid), rosterSize: () => roster(S.userTid).length, history: () => S.history, violations: () => S.violations, state: () => S,
  };
  return { bridge, truth, ga };
}

module.exports = { createLeague, PH };
