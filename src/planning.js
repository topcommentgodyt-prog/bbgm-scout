/*
 * BBGM Scout – planning tools:
 *   - Protected players and picks ("Never trade" / "Ask first" / "Available"),
 *     plus contract-length and cap-reserve rules that every automated feature respects
 *   - Team needs scanner (biggest roster weaknesses vs. the league, with fixes)
 *   - Three-season view (strength, payroll, expiring deals, picks, warnings)
 */
(function (root) {
  "use strict";
  const LG = root.BBGMScoutLeague;
  const S = root.BBGMScoutStorage;
  const { PH, PL } = LG;
  const RK = root.BBGMScoutEngine.RATING_KEYS;

  // ======================= Protections =======================
  // Synced per league: { players: { pid: level }, picks: { dpid: level } }, level = "never" | "ask" (absent = available)
  const LEVELS = { available: "Available", ask: "Ask first", never: "Never trade" };
  let cache = { lid: null, players: {}, picks: {} };
  const keyFor = (league) => `protect:${league}`; // league = stable league identity (data.js fingerprint)
  async function loadProtections(lid) {
    const api = root.chrome || root.browser;
    let v = {};
    try { v = (await api.storage.sync.get(keyFor(lid)))[keyFor(lid)] || {}; } catch (e) { /* ignore */ }
    cache = { lid, players: v.players || {}, picks: v.picks || {} };
    return cache;
  }
  async function setProtection(lid, kind, id, level) {
    if (cache.lid !== lid) await loadProtections(lid);
    const bucket = kind === "pick" ? cache.picks : cache.players;
    if (!level || level === "available") delete bucket[id]; else bucket[id] = level;
    const api = root.chrome || root.browser;
    try { await api.storage.sync.set({ [keyFor(lid)]: { players: cache.players, picks: cache.picks } }); } catch (e) { /* quota */ }
  }
  const playerLevel = (pid) => cache.players[pid] || "available";
  const pickLevel = (dpid) => cache.picks[dpid] || "available";
  /** Strictest protection level among the user's assets in a move. */
  function assetsLevel(pids = [], dpids = []) {
    const lv = [...pids.map(playerLevel), ...dpids.map(pickLevel)];
    return lv.includes("never") ? "never" : lv.includes("ask") ? "ask" : "available";
  }
  function protectedNames(L, pids = [], dpids = [], level) {
    return [
      ...pids.filter((p) => playerLevel(p) === level).map((p) => LG.name(L, p)),
      ...dpids.filter((d) => pickLevel(d) === level).map((d) => LG.pickName(L, d)),
    ];
  }

  // ---- contract rules ----
  function contractYears(L, exp) {
    // A contract signed during the season covers this season; one signed in the offseason starts next season.
    return exp - L.snap.season + (L.snap.phase <= PH.PLAYOFFS ? 1 : 0);
  }
  /** Returns null if allowed, or a reason string. */
  function contractRuleBreak(L, settings, { amount, exp, payrollDelta }) {
    const maxY = Number(settings.maxContractYears) || 0;
    if (maxY > 0 && exp != null && contractYears(L, exp) > maxY) return `contract runs ${contractYears(L, exp)} years (your limit is ${maxY})`;
    const reserve = (Number(settings.minCapReserve) || 0) * 1000;
    const c = L.capInfo;
    const delta = payrollDelta != null ? payrollDelta : amount || 0;
    if (reserve > 0 && c.cap && delta > 0 && c.payroll + delta > c.cap - reserve) {
      if (!(L.capInfo.rosterSize < L.capInfo.minRoster && amount <= c.minContract + 1)) return `would leave less than $${(reserve / 1000).toFixed(1)}M of cap space`;
    }
    return null;
  }
  function tradePayrollDelta(L, teams) {
    const sal = (pids) => pids.reduce((s, pid) => { const v = L.byPid.get(pid); return s + (v && v.p.contract ? v.p.contract.amount : 0); }, 0);
    return sal(teams[1].pids) - sal(teams[0].pids);
  }

  // ======================= Team needs =======================
  const CATS = [
    { id: "shooting", label: "Outside shooting", w: { tp: 0.55, fg: 0.25, ft: 0.2 }, skill: "3" },
    { id: "inside", label: "Inside scoring", w: { ins: 0.4, dnk: 0.3, hgt: 0.3 }, skill: "Po" },
    { id: "playmaking", label: "Ball handling & passing", w: { drb: 0.35, pss: 0.4, oiq: 0.25 }, skill: "B / Ps" },
    { id: "perimeterD", label: "Perimeter defense", w: { diq: 0.5, spd: 0.3, jmp: 0.2 }, skill: "Dp" },
    { id: "rimD", label: "Rim protection", w: { hgt: 0.45, diq: 0.25, jmp: 0.3 }, skill: "Di" },
    { id: "rebounding", label: "Rebounding", w: { reb: 0.5, hgt: 0.3, stre: 0.2 }, skill: "R" },
    { id: "athleticism", label: "Athleticism", w: { spd: 0.4, jmp: 0.3, endu: 0.3 }, skill: "A" },
  ];
  const MOV_W = Array.from({ length: 10 }, (_, i) => Math.exp(-0.1609 * i));

  function shownRatings(L, v) {
    const r = v.p.ratings[v.p.ratings.length - 1];
    const fz = L.settings.respectFog && v.p.tid !== L.snap.userTid ? r.fuzz || 0 : 0;
    const o = {};
    for (const k of RK) o[k] = Math.max(0, Math.min(100, (r[k] || 0) + fz));
    return o;
  }
  const catScore = (cat, r) => Object.entries(cat.w).reduce((s, [k, w]) => s + w * (r[k] || 0), 0);

  function rotation(L, tid) {
    return L.snap.players.filter((p) => p.tid === tid).map((p) => L.byPid.get(p.pid)).filter(Boolean)
      .filter((v) => !(v.p.injury && v.p.injury.gamesRemaining > 20))
      .sort((a, b) => b.summary.ovr - a.summary.ovr).slice(0, 10);
  }
  function teamProfile(L, tid) {
    const rot = rotation(L, tid);
    const out = {};
    for (const c of CATS) {
      let s = 0, w = 0;
      rot.forEach((v, i) => { s += MOV_W[i] * catScore(c, shownRatings(L, v)); w += MOV_W[i]; });
      out[c.id] = w ? s / w : 0;
    }
    const ovrs = rot.map((v) => v.summary.ovr);
    out.depth = ovrs.slice(5, 10).reduce((a, b) => a + b, 0) / Math.max(1, ovrs.slice(5, 10).length);
    out.star = ovrs[0] || 0;
    return { rot, scores: out };
  }

  function teamNeeds(L, settings, F) {
    const tids = L.snap.teams.map((t) => t.tid);
    const profiles = new Map(tids.map((tid) => [tid, teamProfile(L, tid)]));
    const mine = profiles.get(L.snap.userTid);
    const dims = [...CATS.map((c) => ({ id: c.id, label: c.label, cat: c })), { id: "depth", label: "Bench depth (players 6–10)" }, { id: "star", label: "Star power (best player)" }];
    const rows = dims.map((d) => {
      const vals = tids.map((tid) => profiles.get(tid).scores[d.id]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
      const mineV = mine.scores[d.id];
      const rank = 1 + vals.filter((x) => x > mineV).length;
      return { ...d, value: mineV, mean, z: (mineV - mean) / sd, rank, of: tids.length };
    });
    const weaknesses = rows.filter((r) => r.z < -0.25).sort((a, b) => a.z - b.z).slice(0, 3);
    const strengths = rows.filter((r) => r.z > 0.5).sort((a, b) => b.z - a.z).slice(0, 2);

    // Fixes: best trade target, free agent and draft prospect for each weakness.
    const rotFloor = mine.rot.length >= 8 ? mine.rot[7].summary.ovr : 40;
    const fas = F.freeAgents(L);
    const board = F.draftBoard(L);
    const used = new Set();
    const fixesFor = (w) => {
      const score = (v) => {
        const r = shownRatings(L, v);
        const gain = w.cat ? catScore(w.cat, r) - w.value : w.id === "depth" ? v.summary.ovr - w.value : v.summary.ovr - w.value;
        return gain;
      };
      const plays = (v, horizon) => (horizon ? LG.ovrAt(L, v.p.pid, horizon) : v.summary.ovr) >= rotFloor - 2;
      const pick = (list, horizon) => list.filter((v) => !used.has(v.p.pid)).map((v) => ({ v, g: score(v) })).filter((x) => x.g > 2 && plays(x.v, horizon))
        .sort((a, b) => b.g + 0.15 * b.v.surplus - (a.g + 0.15 * a.v.surplus))[0];
      const tradeable = [...L.byPid.values()].filter((v) => v.p.tid >= 0 && v.p.tid !== L.snap.userTid && !v.p.untradable && v.surplus > -5);
      const faPool = fas.filter((f) => f.canSign && !contractRuleBreak(L, settings, { amount: f.ask, exp: f.exp })).map((f) => L.byPid.get(f.pid)).filter(Boolean);
      const draftPool = board.map((b) => L.byPid.get(b.pid)).filter(Boolean);
      const t = pick(tradeable, 0), f = pick(faPool, 0), d = pick(draftPool, 2);
      [t, f, d].forEach((x) => x && used.add(x.v.p.pid)); // a different player for each weakness
      const fmt = (x, kind) => x && { kind, pid: x.v.p.pid, name: LG.name(L, x.v.p.pid), gain: x.g, ovr: x.v.summary.ovr, team: (L.teams.get(x.v.p.tid) || {}).abbrev, surplus: x.v.surplus,
        ask: kind === "fa" ? (fas.find((q) => q.pid === x.v.p.pid) || {}).ask : null };
      return [fmt(t, "trade"), fmt(f, "fa"), fmt(d, "draft")].filter(Boolean);
    };
    return { rows, weaknesses: weaknesses.map((w) => ({ ...w, fixes: fixesFor(w) })), strengths };
  }

  // ======================= Injury stress test =======================
  /**
   * What happens to the team if a key player misses time: team rating (MOV) drop and the skill area
   * that falls the most in league rank, plus affordable backups that recover the most.
   */
  function injuryStress(L, settings, F) {
    const mineAll = rotation(L, L.snap.userTid);
    if (mineAll.length < 6) return [];
    const ovrsOf = (list) => list.map((v) => v.summary.ovr);
    const base = LG.teamMov(ovrsOf(mineAll));
    const others = L.snap.teams.filter((t) => t.tid !== L.snap.userTid).map((t) => teamProfile(L, t.tid).scores);
    const profileOf = (list) => {
      const out = {};
      for (const c of CATS) { let s = 0, w = 0; list.slice(0, 10).forEach((v, i) => { s += MOV_W[i] * catScore(c, shownRatings(L, v)); w += MOV_W[i]; }); out[c.id] = w ? s / w : 0; }
      return out;
    };
    const rankIn = (id, val) => 1 + others.filter((o) => o[id] > val).length;
    const baseProf = profileOf(mineAll);
    const leaders = new Map();
    const add = (v, why) => v && !leaders.has(v.p.pid) && leaders.set(v.p.pid, { v, why });
    const by = (id) => [...mineAll].sort((a, b) => catScore(CATS.find((c) => c.id === id), shownRatings(L, b)) - catScore(CATS.find((c) => c.id === id), shownRatings(L, a)))[0];
    add(mineAll[0], "your best player");
    add(mineAll[1], "your second-best player");
    add(by("rimD"), "your top rim protector");
    add(by("playmaking"), "your top ball handler");

    // Affordable backups: free agents you can sign now (cheap first) and low-salary trade targets.
    const cap = L.capInfo.cap || 100000;
    const cheapFA = F.freeAgents(L).filter((f) => f.canSign && f.ask <= Math.max(L.capInfo.minContract * 3, cap * 0.05) && !contractRuleBreak(L, settings, { amount: f.ask, exp: f.exp }))
      .map((f) => ({ v: L.byPid.get(f.pid), kind: "fa", ask: f.ask })).filter((x) => x.v);
    const cheapTrade = [...L.byPid.values()].filter((v) => v.p.tid >= 0 && v.p.tid !== L.snap.userTid && !v.p.untradable && v.p.contract && v.p.contract.amount <= cap * 0.08 && v.surplus > 0)
      .map((v) => ({ v, kind: "trade" }));

    const out = [];
    for (const { v, why } of leaders.values()) {
      // The 11th man steps in: use the full roster minus the injured player.
      const roster = L.snap.players.filter((p) => p.tid === L.snap.userTid && p.pid !== v.p.pid).map((p) => L.byPid.get(p.pid)).filter(Boolean)
        .filter((x) => !(x.p.injury && x.p.injury.gamesRemaining > 20)).sort((a, b) => b.summary.ovr - a.summary.ovr);
      const mov = LG.teamMov(ovrsOf(roster));
      const prof = profileOf(roster);
      let worst = null;
      for (const c of CATS) {
        const r0 = rankIn(c.id, baseProf[c.id]), r1 = rankIn(c.id, prof[c.id]);
        if (!worst || r1 - r0 > worst.drop || (r1 - r0 === worst.drop && baseProf[c.id] - prof[c.id] > worst.delta)) worst = { cat: c, from: r0, to: r1, drop: r1 - r0, delta: baseProf[c.id] - prof[c.id] };
      }
      const fill = [...cheapFA, ...cheapTrade].map((x) => {
        const withB = [...roster, x.v].sort((a, b) => b.summary.ovr - a.summary.ovr);
        const recover = LG.teamMov(ovrsOf(withB)) - mov;
        const catBack = worst ? profileOf(withB)[worst.cat.id] - prof[worst.cat.id] : 0;
        return { ...x, recover, catBack, score: recover + 0.15 * catBack };
      }).filter((x) => x.recover > 0.05 || x.catBack > 0.5).sort((a, b) => b.score - a.score || (a.kind === "fa" ? -1 : 1));
      // ~0.033 win% per point of MOV, so a 20-game absence costs about drop × 0.66 wins.
      out.push({ pid: v.p.pid, name: v.summary.name, why, drop: base - mov, winsLost20: (base - mov) * 0.033 * 20, worst,
        backups: fill.slice(0, 2).map((x) => ({ pid: x.v.p.pid, name: x.v.summary.name, kind: x.kind, ovr: x.v.summary.ovr, recover: x.recover, ask: x.ask,
          team: (L.teams.get(x.v.p.tid) || {}).abbrev, salary: x.v.p.contract ? x.v.p.contract.amount : null })) });
    }
    return out.sort((a, b) => b.drop - a.drop);
  }

  // ======================= Three-season view =======================
  function threeSeasons(L) {
    const snap = L.snap, ga = snap.ga || {};
    const base = snap.phase > PH.PLAYOFFS ? snap.season + 1 : snap.season; // the season being played or coming next
    const seasons = [base, base + 1, base + 2];
    const mineP = snap.players.filter((p) => p.tid === snap.userTid);
    const offset = (s) => s - snap.season; // years of development from today's ratings
    const capGrowth = 1 + (Number(ga.inflationAvg) || 0) / 100;
    const allTids = snap.teams.map((t) => t.tid);
    const movOf = (tid, s, onlyContracted) => {
      const ps = snap.players.filter((p) => p.tid === tid && (!onlyContracted || (p.contract && p.contract.exp >= s)));
      return LG.teamMov(ps.map((p) => LG.ovrAt(L, p.pid, offset(s))));
    };
    const cols = seasons.map((s, i) => {
      const mov = movOf(snap.userTid, s, false);
      const movContracted = movOf(snap.userTid, s, true);
      const others = allTids.map((tid) => movOf(tid, s, false));
      const rank = 1 + others.filter((x) => x > mov).length;
      const payroll = mineP.filter((p) => p.contract && p.contract.exp >= s).reduce((t, p) => t + p.contract.amount, 0);
      const cap = (ga.salaryCap || 0) * Math.pow(capGrowth, i);
      const expiring = mineP.filter((p) => p.contract && p.contract.exp === s).map((p) => p.pid);
      const picks = snap.draftPicks.filter((d) => d.tid === snap.userTid && d.season === s).sort((a, b) => a.round - b.round);
      return { season: s, mov, movContracted, rank, of: allTids.length, payroll, cap, space: cap - payroll, expiring, picks };
    });

    // Warnings
    const flags = [];
    const byNow = [...mineP].map((p) => L.byPid.get(p.pid)).filter(Boolean).sort((a, b) => b.summary.ovr - a.summary.ovr);
    const core = byNow.slice(0, 3);
    const starter = byNow[4] ? byNow[4].summary.ovr : 50;
    if (core.length === 3) {
      const coreNow = core.reduce((s, v) => s + v.summary.ovr, 0) / 3;
      const coreLater = core.reduce((s, v) => s + LG.ovrAt(L, v.p.pid, offset(seasons[2])), 0) / 3;
      const young = byNow.filter((v) => v.summary.age <= 23 && !core.includes(v));
      const bestYoung = young.map((v) => ({ v, o: LG.ovrAt(L, v.p.pid, offset(seasons[2])) })).sort((a, b) => b.o - a.o)[0];
      if (coreNow - coreLater >= 3 && (!bestYoung || bestYoung.o < starter)) {
        flags.push({ level: "high", text: `Your top three (${core.map((v) => v.summary.name).join(", ")}) are projected to lose ${(coreNow - coreLater).toFixed(1)} OVR on average by ${seasons[2]}, and ${bestYoung ? `your best young player (${bestYoung.v.summary.name}) projects to only ${Math.round(bestYoung.o)}` : "you have no young players"}, below starter level (${starter}). Your window may close before your prospects are ready.`,
          pids: [...core.map((v) => v.p.pid), ...(bestYoung ? [bestYoung.v.p.pid] : [])] });
      } else if (bestYoung && bestYoung.o >= core[0].summary.ovr - 2) {
        flags.push({ level: "good", text: `${bestYoung.v.summary.name} projects to ${Math.round(bestYoung.o)} by ${seasons[2]}, about the level of your best player today.`, pids: [bestYoung.v.p.pid] });
      }
    }
    if (cols[0].rank <= 4 && cols[2].rank > cols[0].rank + 4) flags.push({ level: "medium", text: `You project as a top-${cols[0].rank} team now but ${ordinal(cols[2].rank)} by ${seasons[2]}. If you want to win, it's now.` });
    if (cols[2].rank + 4 < cols[0].rank) flags.push({ level: "good", text: `You're on the rise: ${ordinal(cols[0].rank)} now, projected ${ordinal(cols[2].rank)} by ${seasons[2]}.` });
    const next = cols[1];
    if (ga.salaryCap && next.payroll > next.cap) flags.push({ level: "medium", text: `${next.season} payroll is already ${Math.round((next.payroll / next.cap) * 100)}% of the cap before any re-signings.` });
    const rotationPids = new Set(byNow.slice(0, 8).map((v) => v.p.pid));
    const bigExpiring = cols[0].expiring.filter((pid) => rotationPids.has(pid));
    if (bigExpiring.length >= 3) flags.push({ level: "medium", text: `${bigExpiring.length} rotation players' contracts expire after ${cols[0].season}.`, pids: bigExpiring });
    const firsts = cols.slice(0, 2).reduce((n, c) => n + c.picks.filter((d) => d.round === 1).length, 0);
    if (firsts === 0) flags.push({ level: "medium", text: `You have no first-round picks in the next two drafts, so the future depends on development and trades.` });
    if (cols[0].movContracted < cols[0].mov - 3 && cols[1].movContracted < cols[1].mov - 3) flags.push({ level: "low", text: `Much of next season's strength comes from players without contracts for it; plan your re-signings.` });
    return { seasons, cols, flags, roster: byNow };
  }
  const ordinal = (n) => {
    const t = n % 100;
    if (t >= 11 && t <= 13) return `${n}th`;
    return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
  };

  root.BBGMScoutPlanning = {
    LEVELS, loadProtections, setProtection, playerLevel, pickLevel, assetsLevel, protectedNames,
    contractYears, contractRuleBreak, tradePayrollDelta, teamNeeds, threeSeasons, injuryStress, CATS, shownRatings, catScore,
  };
})(globalThis);
