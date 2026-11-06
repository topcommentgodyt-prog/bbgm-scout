/*
 * Courtside – Insights: front-office analysis built on the league model (no DOM, no game actions).
 *
 *  - resignRisks       who may refuse to re-sign (BBGM's own mood: probWilling)
 *  - jobSecurity       owner mood → firing risk, using BBGM's owner-mood formula
 *  - decisions         the next GM decisions coming up (deadline, draft, re-signing, roster limits…)
 *  - lineupSynergy     BBGM's on-court skill synergy (3/B/Ps/Po/A/Di/Dp/R) for your lineup vs the best five
 *  - playoffScout      matchup strengths and weaknesses vs your playoff opponent (or the top threats)
 *  - draftClass        this draft class vs the next one and past classes in this league
 *  - rivals            what each AI team is likely to want (BBGM strategy, age, picks, payroll, trade activity)
 *  - legacyView        franchise players (drafted by you or long-time players), awards and where they are now
 *  - accuracy          records forecasts and grades them a season later (error, bias, 80% range coverage)
 *  - watchAlerts       changes to pinned players (breakout, decline, traded, free agent, injury, expiring)
 *  - benchmark         Autopilot runs grouped by strategy, for A/B tests on copies of a league
 *  - winContext/fitGain the win engine inside the manager: weak areas, synergy and star power in every trade and signing
 */
(function (root) {
  "use strict";
  const LG = root.BBGMScoutLeague;
  const { PH, PL } = LG;
  const P = () => root.BBGMScoutPlanning;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const sigm = (x, a, b) => 1 / (1 + Math.exp(-a * (x - b)));
  const gpOf = (t) => (t ? t.won + t.lost + (t.tied || 0) + (t.otl || 0) : 0);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const money = (k) => (Math.abs(k) >= 1000 ? `$${(k / 1000).toFixed(1)}M` : `$${Math.round(k)}k`);

  // ======================= #1 Re-signing risk =======================
  /** Your players whose contracts end after this season (or next, once this season's re-signing is over). */
  function resignRisks(L) {
    const s = L.snap;
    const exp = s.phase > PH.RESIGN_PLAYERS ? s.season + 1 : s.season;
    const mine = L.roster(s.userTid).map((p) => L.byPid.get(p.pid)).filter(Boolean);
    const byVal = [...mine].sort((a, b) => b.talent - a.talent);
    return mine.filter((v) => v.p.contract && v.p.contract.exp <= exp).map((v) => {
      const m = v.p.mood || {};
      const pw = typeof m.probWilling === "number" ? m.probWilling : m.willing === false ? 0 : m.willing ? 1 : null;
      const rank = byVal.indexOf(v) + 1;
      const risk = pw == null ? "unknown" : pw < 0.35 ? "high" : pw < 0.7 ? "medium" : "low";
      const key = rank <= 5 || (v.summary.age <= 25 && v.summary.ceiling >= 60);
      return { pid: v.p.pid, name: LG.name(L, v.p.pid), ovr: v.summary.ovr, age: v.summary.age, rank, key, probWilling: pw, ask: m.contractAmount || null, risk,
        traits: m.traits || [], exp: v.p.contract.exp };
    }).sort((a, b) => (a.key === b.key ? 0 : a.key ? -1 : 1) || (a.probWilling ?? 1) - (b.probWilling ?? 1));
  }
  const TRAIT = { F: "Fame (wants a winner and minutes)", L: "Loyalty", $: "Money", W: "Winning" };

  // ======================= #3 Owner job security =======================
  /**
   * BBGM's owner mood: every season adds
   *   wins     = 0.25 × (wins − games/2) / (games/2)
   *   playoffs = −0.2 if you miss, 0.16 × roundsWon / rounds if you lose in them, +0.2 for a title
   *   money    = (profit − $15M) / $100M, scaled by salary cap / $90M (0 if the budget is off)
   * The running total is kept (each part capped at +1) once the grace period is over; a total below −1
   * at season's end gets you fired (never in God Mode).
   */
  function ownerDeltas(o, { won, games, prw, profitM }) {
    const n = (o.salaryCap || 90000) / 90000;
    const rounds = o.rounds || 4;
    return {
      wins: (0.25 * (won - games / 2)) / (games / 2),
      playoffs: prw < 0 ? -0.2 : prw < rounds ? (0.16 / rounds) * prw : 0.2,
      money: o.budget ? (profitM - 15 * n) / (100 * n) : 0,
    };
  }
  function jobSecurity(L, o) {
    if (!o || !o.rows) return null;
    const row = o.rows.find((r) => r.season === o.season) || o.rows[o.rows.length - 1] || {};
    const base = row.ownerMood || { wins: 0, playoffs: 0, money: 0 };
    const games = o.numGames || 82;
    const gp = row.won + row.lost + (row.tied || 0) + (row.otl || 0);
    const inGrace = o.season < (o.gracePeriodEnd || 0);
    const seasonDone = o.phase > PH.PLAYOFFS; // BBGM already added this season's mood
    let proj = { ...base }, deltas = null;
    if (!seasonDone) {
      // Project this season from the pace so far (team rating rank early on, when few games are played).
      const share = gp ? gp / games : 0;
      const pace = gp >= 10 ? row.won / gp : L ? 0.5 + 0.35 * ((L.strategy.features.rankNow || 0.5) - 0.5) * 2 : 0.5;
      const won = row.won + (games - gp) * pace;
      const tids = L ? L.snap.teams.length : 30;
      const playoffTeams = (L && L.snap.ga && L.snap.ga.numGamesPlayoffSeries ? Math.pow(2, L.snap.ga.numGamesPlayoffSeries.length) : 16) - ((L && L.snap.ga && L.snap.ga.numPlayoffByes) || 0);
      const rank = L ? 1 + L.snap.teams.filter((t) => t.tid !== L.snap.userTid && (gp >= 10 ? (t.won / Math.max(1, gpOf(t))) : (L.movNow.get(t.tid) || 0)) > (gp >= 10 ? pace : (L.movNow.get(L.snap.userTid) || 0))).length : tids / 2;
      const prw = o.phase === PH.PLAYOFFS ? Math.max(0, row.prw) : rank <= Math.min(playoffTeams, tids) * 0.25 ? 1 : rank <= Math.min(playoffTeams, tids) ? 0 : -1;
      const profitM = share > 0.1 ? row.profit / share : row.profit;
      deltas = ownerDeltas(o, { won, games, prw, profitM });
      // During the grace period BBGM doesn't count it yet; the projection still shows what the owner would think.
      for (const k of ["wins", "playoffs", "money"]) proj[k] = Math.min(1, base[k] + deltas[k]);
    }
    const total = proj.wins + proj.playoffs + proj.money;
    const now = base.wins + base.playoffs + base.money;
    const level = total < -1 ? "fired" : total < -0.5 ? "high" : total < 0.25 ? "medium" : "low";
    const risk = o.godMode ? "none" : inGrace ? "grace" : level;
    const weakest = ["wins", "playoffs", "money"].sort((a, b) => proj[a] - proj[b])[0];
    const tips = [];
    if (risk === "fired" || risk === "high" || (inGrace && (level === "fired" || level === "high"))) {
      if (weakest === "money") tips.push("Money is the weakest part: set the finance style to Profit (Manager → finances) and avoid the luxury tax.");
      if (weakest === "wins") tips.push("Wins are the weakest part: Contend this season; a rebuild now could cost you the job.");
      if (weakest === "playoffs") tips.push("Missing the playoffs costs −0.2 a year: push for a playoff spot (trade picks for help now).");
    }
    if (o.challengeFiredMissPlayoffs) tips.push("Challenge mode: missing the playoffs gets you fired.");
    if (o.challengeFiredLuxuryTax) tips.push("Challenge mode: paying the luxury tax gets you fired.");
    // 0% = at the firing line (−1), 50% = neutral owner (0), 100% = delighted (+1 or more).
    return { base, proj, deltas, total, now, risk, level, inGrace, graceEnd: o.gracePeriodEnd, seasonDone, weakest, tips,
      security: o.godMode ? 100 : Math.round(clamp((total + 1) / 2, 0, 1) * 100) };
  }

  // ======================= #4 Upcoming decisions =======================
  function decisions(L, extra = {}) {
    const s = L.snap, ga = s.ga || {}, ph = s.phase, out = [];
    const gp = gpOf(L.user), games = ga.numGames || 82;
    const cap = L.capInfo;
    if (ph === PH.REGULAR_SEASON && ga.tradeDeadline != null && ga.tradeDeadline > 0 && ga.tradeDeadline < 1) {
      const left = Math.ceil(games * ga.tradeDeadline) - gp;
      if (left >= 0) out.push({ when: left <= 1 ? "Now" : `${left} games`, text: `Trade deadline in ${left} game${left === 1 ? "" : "s"}: last chance for trades this season`, tab: "trades", urgent: left <= 5 });
    }
    const exp = resignRisks(L).filter((r) => r.exp === s.season && ph <= PH.RESIGN_PLAYERS);
    if (exp.length) {
      const high = exp.filter((r) => r.risk === "high" && r.key);
      out.push({ when: ph === PH.RESIGN_PLAYERS ? "Now" : "Offseason", text: `${exp.length} contract${exp.length === 1 ? "" : "s"} expire this season${high.length ? `; ${high.map((r) => r.name).join(", ")} may refuse to re-sign` : ""}`, tab: "office", urgent: high.length > 0 && ph >= PH.REGULAR_SEASON });
    }
    if (ph === PH.PLAYOFFS) out.push({ when: "Soon", text: "Draft lottery and draft after the playoffs", tab: "draft" });
    if (ph === PH.DRAFT_LOTTERY || ph === PH.DRAFT) {
      const picks = s.draftPicks.filter((d) => d.tid === s.userTid && d.season === s.season);
      out.push({ when: ph === PH.DRAFT ? "Now" : "Next", text: `Draft: you have ${picks.length} pick${picks.length === 1 ? "" : "s"}${picks.length ? ` (${picks.map((d) => LG.pickName(L, d.dpid)).join(", ")})` : ""}`, tab: "draft", urgent: ph === PH.DRAFT });
    }
    if (ph === PH.AFTER_DRAFT) out.push({ when: "Next", text: "Re-signing players comes next", tab: "office" });
    if (ph === PH.RESIGN_PLAYERS && s.negotiations.length) out.push({ when: "Now", text: `${s.negotiations.length} player${s.negotiations.length === 1 ? "" : "s"} to decide on (re-sign or let walk)`, tab: "manager", urgent: true });
    if (ph === PH.FREE_AGENCY || ph === PH.RESIGN_PLAYERS) {
      const space = cap.type === "none" ? null : cap.cap - cap.payroll;
      out.push({ when: ph === PH.FREE_AGENCY ? "Now" : "Next", text: `Free agency: ${space == null ? "no cap" : space > 0 ? `${money(space)} of cap space` : `${money(-space)} over the cap (minimum contracts only)`}`, tab: "fa" });
    }
    if (cap.rosterSize > cap.maxRoster) out.push({ when: "Before games", text: `Roster ${cap.rosterSize}/${cap.maxRoster}: ${cap.rosterSize - cap.maxRoster} player${cap.rosterSize - cap.maxRoster === 1 ? "" : "s"} must go before the season`, tab: "manager", urgent: true });
    if (cap.rosterSize < cap.minRoster && ph >= 0) out.push({ when: "Before games", text: `Roster ${cap.rosterSize}/${cap.minRoster}: sign ${cap.minRoster - cap.rosterSize} more`, tab: "fa", urgent: true });
    if (extra.job && (extra.job.risk === "high" || extra.job.risk === "fired")) out.push({ when: "This season", text: `Job security ${extra.job.security}%: ${extra.job.risk === "fired" ? "on pace to be fired at season's end" : "the owner is unhappy"}`, tab: "office", urgent: true });
    return out;
  }

  // ======================= #7 Lineup synergy =======================
  /** BBGM's game-sim synergy from the skills on the floor (offense, defense, rebounding; each 0..1). */
  function synergyOf(skillLists) {
    const c = { 3: 0, A: 0, B: 0, Di: 0, Dp: 0, Po: 0, Ps: 0, R: 0 };
    for (const sk of skillLists) for (const k of sk || []) if (k in c) c[k]++;
    let off = 5 * sigm(c[3], 3, 2) + 3 * sigm(c.B, 15, 0.75) + sigm(c.B, 5, 1.75) + 3 * sigm(c.Ps, 15, 0.75) + sigm(c.Ps, 5, 1.75) + sigm(c.Ps, 5, 2.75)
      + sigm(c.Po, 15, 0.75) + sigm(c.A, 15, 1.75) + sigm(c.A, 5, 2.75);
    off /= 17;
    off *= clamp(Math.sqrt(1 + c.B + c.Ps + c[3]) - 1, 0, 2) / 2; // needs several perimeter skills
    const def = (sigm(c.Dp, 15, 0.75) + 2 * sigm(c.Di, 15, 0.75) + sigm(c.A, 5, 2) + sigm(c.A, 5, 3.25)) / 6;
    const reb = (sigm(c.R, 15, 0.75) + sigm(c.R, 5, 1.75)) / 4;
    return { off, def, reb, total: off + def + reb, counts: c };
  }
  const K_SYN = 8; // OVR points (summed over five starters) a full unit of synergy is treated as worth
  function lineupSynergy(L, tid = L.snap.userTid) {
    const rot = L.snap.players.filter((p) => p.tid === tid && !(p.injury && p.injury.gamesRemaining > 0)).map((p) => L.byPid.get(p.pid)).filter(Boolean);
    if (rot.length < 5) return null;
    const skills = (v) => (v.p.ratings[v.p.ratings.length - 1] || {}).skills || [];
    const ovr = (v) => v.summary.ovr;
    const score = (five) => five.reduce((s, v) => s + ovr(v), 0) + K_SYN * synergyOf(five.map(skills)).total;
    const cur = [...rot].sort((a, b) => (a.p.rosterOrder ?? 99) - (b.p.rosterOrder ?? 99)).slice(0, 5);
    const pool = [...rot].sort((a, b) => ovr(b) - ovr(a)).slice(0, 9);
    let best = null, bestS = -Infinity;
    const pick = (start, chosen) => {
      if (chosen.length === 5) { const s = score(chosen); if (s > bestS) { bestS = s; best = [...chosen]; } return; }
      for (let i = start; i < pool.length; i++) { chosen.push(pool[i]); pick(i + 1, chosen); chosen.pop(); }
    };
    pick(0, []);
    const syn = (five) => synergyOf(five.map(skills));
    const sc = syn(cur), sb = syn(best);
    const missing = [];
    if (sc.counts[3] < 2) missing.push("three-point shooters (3)");
    if (sc.counts.B + sc.counts.Ps < 2) missing.push("ball handling / passing (B, Ps)");
    if (sc.counts.Di < 1) missing.push("a rim protector (Di)");
    if (sc.counts.R < 1) missing.push("a rebounder (R)");
    if (sc.counts.A < 1) missing.push("athleticism (A)");
    return {
      current: { pids: cur.map((v) => v.p.pid), syn: sc, ovr: cur.reduce((s, v) => s + ovr(v), 0), score: score(cur) },
      best: { pids: best.map((v) => v.p.pid), syn: sb, ovr: best.reduce((s, v) => s + ovr(v), 0), score: bestS },
      gain: bestS - score(cur), missing,
      swaps: { out: cur.filter((v) => !best.includes(v)).map((v) => v.p.pid), in: best.filter((v) => !cur.includes(v)).map((v) => v.p.pid) },
    };
  }

  // ======================= #8 Playoff matchup scout =======================
  function profileVs(L, a, b) {
    const pa = P().teamProfile(L, a).scores, pb = P().teamProfile(L, b).scores;
    const rows = P().CATS.map((c) => ({ id: c.id, label: c.label, mine: pa[c.id], theirs: pb[c.id], diff: pa[c.id] - pb[c.id] }));
    rows.push({ id: "depth", label: "Bench depth", mine: pa.depth, theirs: pb.depth, diff: pa.depth - pb.depth });
    rows.push({ id: "star", label: "Best player", mine: pa.star, theirs: pb.star, diff: pa.star - pb.star });
    return rows.sort((x, y) => y.diff - x.diff);
  }
  function playoffScout(L, bracket) {
    const me = L.snap.userTid;
    const mov = (t) => L.movNow.get(t) || 0;
    let opp = null, series = null;
    if (bracket && bracket.series) {
      series = bracket.series.find((m) => (m.home && m.home.tid === me) || (m.away && m.away.tid === me)) || null;
      if (series) opp = series.home && series.home.tid === me ? series.away && series.away.tid : series.home && series.home.tid;
    }
    const threats = L.snap.teams.filter((t) => t.tid !== me).sort((a, b) => mov(b.tid) - mov(a.tid)).slice(0, 3).map((t) => t.tid);
    const make = (tid) => {
      const t = L.teams.get(tid);
      const rows = profileVs(L, me, tid);
      const edge = mov(me) - mov(tid);
      return { tid, name: t ? `${t.region} ${t.name}` : `Team ${tid}`, abbrev: t ? t.abbrev : "", edge, winProb: clamp(1 / (1 + Math.exp(-edge / 3.2)), 0.02, 0.98),
        strengths: rows.filter((r) => r.diff > 1.5).slice(0, 3), weaknesses: rows.filter((r) => r.diff < -1.5).slice(-3).reverse(), rows };
    };
    return { series, opponent: opp != null ? make(opp) : null, threats: threats.map(make), inPlayoffs: L.snap.phase === PH.PLAYOFFS };
  }

  // ======================= #9 Draft class strength =======================
  function classStats(L, year) {
    const vals = [...L.byPid.values()].filter((v) => v.prospect && v.p.draft && v.p.draft.year === year).map((v) => v.draftTalentNeutral).sort((a, b) => b - a);
    if (vals.length < 10) return null;
    return { year, n: vals.length, top5: mean(vals.slice(0, 5)), top14: mean(vals.slice(0, 14)), top30: mean(vals.slice(0, 30)) };
  }
  let classHistory = []; // set by the dock from this league's stored history
  function setClassHistory(h) { classHistory = Array.isArray(h) ? h : []; }
  function draftClass(L) {
    const now = classStats(L, L.draftSeason);
    if (!now) return null;
    const next = classStats(L, L.draftSeason + 1);
    const past = classHistory.filter((h) => h.year < L.draftSeason).slice(-8);
    // Baseline: past classes in this league when there are enough, otherwise the next class (if mostly known).
    const baseOf = (k) => (past.length >= 2 ? mean(past.map((h) => h[k])) : next ? next[k] : null);
    const ratio = (k) => (baseOf(k) ? now[k] / baseOf(k) : 1);
    const r = 0.5 * ratio("top5") + 0.5 * ratio("top14");
    const verdict = r >= 1.1 ? "strong" : r <= 0.9 ? "weak" : "average";
    const advice = verdict === "strong" ? "Strong class: keep this year's picks, and trading into the lottery is worth a look."
      : verdict === "weak" ? "Weak class: this year's picks are better used as trade chips (for players or future picks)."
      : "Average class: value picks normally.";
    return { now, next, past, ratio: r, verdict, advice, basis: past.length >= 2 ? `${past.length} past classes in this league` : next ? "next year's class" : "no comparison yet" };
  }

  // ======================= #10 Rival GM tendencies =======================
  function rivals(L, events) {
    const s = L.snap, ga = s.ga || {};
    const trades = new Map();
    for (const e of (events && events.events) || []) for (const t of e.tids) trades.set(t, (trades.get(t) || 0) + 1);
    return s.teams.filter((t) => t.tid !== s.userTid).map((t) => {
      const rot = P().rotation(L, t.tid);
      const age = mean(rot.slice(0, 8).map((v) => v.summary.age));
      const picks = s.draftPicks.filter((d) => d.tid === t.tid);
      const firsts = picks.filter((d) => d.round === 1).length;
      const payPct = ga.salaryCap ? (t.payroll || 0) / ga.salaryCap : null;
      const tags = [];
      if (t.strategy === "contending") tags.push("Buyer: contending, pays for proven players now");
      if (t.strategy === "rebuilding") tags.push("Seller: rebuilding, wants young players and picks");
      if (firsts >= 4) tags.push(`Pick hoarder (${firsts} firsts)`);
      if (payPct != null && payPct > 1.15) tags.push("Cap-strapped: may take back less salary");
      if (payPct != null && payPct < 0.85) tags.push("Has cap room: can absorb salary");
      if (age >= 29) tags.push("Old roster");
      if (age <= 24.5) tags.push("Young roster");
      const n = trades.get(t.tid) || 0;
      if (n >= 6) tags.push(`Active trader (${n} trades in two seasons)`);
      const shop = t.strategy === "contending" ? "Offer veterans in their prime; ask for picks and prospects back." : t.strategy === "rebuilding" ? "Offer young players or picks; ask for their veterans." : "Balanced: value-for-value deals.";
      return { tid: t.tid, name: `${t.region} ${t.name}`, abbrev: t.abbrev, strategy: t.strategy || "?", age, firsts, payPct, trades: n, mov: L.movNow.get(t.tid) || 0, tags, shop };
    }).sort((a, b) => b.mov - a.mov);
  }

  // ======================= #11 Player legacy =======================
  const AWARD_ORDER = ["Most Valuable Player", "Finals MVP", "Won Championship", "All-League", "All-Star", "Defensive Player of the Year", "Rookie of the Year", "Sixth Man of the Year", "Most Improved Player"];
  function legacyView(L, data) {
    if (!data || !data.players) return null;
    const me = data.tid;
    const awardsText = (aw) => Object.entries(aw).filter(([k]) => k && k !== "undefined").map(([k, n]) => [AWARD_ORDER.findIndex((a) => k.includes(a)), `${n}× ${k}`]).sort((a, b) => (a[0] < 0 ? 99 : a[0]) - (b[0] < 0 ? 99 : b[0])).map((x) => x[1]).slice(0, 3).join(", ");
    const rows = data.players.map((p) => {
      const now = L.byPid.get(p.pid);
      const where = p.retired ? (p.hof ? "Hall of Fame" : "Retired") : p.tid === me ? "With you" : p.tid === PL.FREE_AGENT ? "Free agent" : (L.teams.get(p.tid) ? L.teams.get(p.tid).abbrev : `Team ${p.tid}`);
      return { ...p, where, ovrNow: now ? now.summary.ovr : null, awardsText: awardsText(p.awards || {}), left: !p.retired && p.tid !== me && p.seasonsWithUs > 0 };
    });
    return { rows, drafted: rows.filter((r) => r.drafted), gone: rows.filter((r) => r.left) };
  }

  // ======================= #16 Prediction accuracy =======================
  /** Snapshot of next-season forecasts for every active player (stored once per season, in the regular season). */
  function forecastRecord(L) {
    const out = {};
    for (const v of L.byPid.values()) {
      if (v.prospect || v.p.tid < 0) continue;
      const pt = v.fc.meanPath[1];
      if (!pt) continue;
      out[v.p.pid] = [Math.round(v.summary.ovr), Math.round(pt.ovr * 10) / 10, Math.round(pt.lo), Math.round(pt.hi), v.p.tid === L.snap.userTid ? 1 : 0];
    }
    return out;
  }
  /** Grades stored forecasts against what happened. store: { season: { model, players: {pid: [ovr, pred, lo, hi, mine]} } } */
  function accuracy(L, store) {
    const seasons = [];
    for (const [season, rec] of Object.entries(store || {})) {
      const s = Number(season);
      if (!(L.snap.season > s)) continue; // next season's ratings don't exist yet
      let n = 0, abs = 0, bias = 0, inRange = 0, naiveAbs = 0, nMine = 0, absMine = 0;
      for (const [pid, [ovr0, pred, lo, hi, mine]] of Object.entries(rec.players || {})) {
        const v = L.byPid.get(Number(pid));
        if (!v) continue;
        const row = v.p.ratings.find((r) => r.season === s + 1);
        if (!row) continue;
        const fz = L.settings.respectFog && v.p.tid !== L.snap.userTid ? row.fuzz || 0 : 0;
        // Scouting fog: other teams' players are graded against the OVR you can see (true OVR + fuzz), never the
        // hidden true rating, so the tracker can't leak what fog conceals.
        const actual = row.ovr + (mine ? 0 : fz);
        n++; abs += Math.abs(actual - pred); bias += pred - actual; naiveAbs += Math.abs(actual - ovr0);
        if (actual >= lo && actual <= hi) inRange++;
        if (mine) { nMine++; absMine += Math.abs(actual - pred); }
      }
      if (n) seasons.push({ season: s, model: rec.model, n, mae: abs / n, bias: bias / n, coverage: inRange / n, naiveMae: naiveAbs / n, maeMine: nMine ? absMine / nMine : null });
    }
    seasons.sort((a, b) => a.season - b.season);
    const tot = seasons.reduce((t, x) => ({ n: t.n + x.n, mae: t.mae + x.mae * x.n, cov: t.cov + x.coverage * x.n, naive: t.naive + x.naiveMae * x.n, bias: t.bias + x.bias * x.n }), { n: 0, mae: 0, cov: 0, naive: 0, bias: 0 });
    return { seasons, overall: tot.n ? { n: tot.n, mae: tot.mae / tot.n, coverage: tot.cov / tot.n, naiveMae: tot.naive / tot.n, bias: tot.bias / tot.n } : null,
      pending: Object.keys(store || {}).map(Number).filter((s) => !(L.snap.season > s)) };
  }

  // ======================= #17 Watchlist alerts =======================
  /** Compares pinned players with their last-seen state. Returns { alerts, state } (state to store). */
  function watchAlerts(L, pids, prev = {}) {
    const alerts = [], state = {};
    const s = L.snap;
    for (const pid of pids) {
      const v = L.byPid.get(pid);
      if (!v) continue;
      const p = v.p, cur = { tid: p.tid, ovr: v.summary.ovr, exp: p.contract ? p.contract.exp : null, inj: p.injury ? p.injury.gamesRemaining : 0, season: s.season };
      state[pid] = cur;
      const old = prev[pid];
      const name = LG.name(L, pid);
      if (!old) continue;
      const team = (tid) => (tid === PL.FREE_AGENT ? "free agency" : L.teams.get(tid) ? L.teams.get(tid).abbrev : `team ${tid}`);
      if (cur.ovr - old.ovr >= 4) alerts.push({ pid, kind: "breakout", text: `${name} broke out: OVR ${old.ovr} → ${cur.ovr}` });
      if (old.ovr - cur.ovr >= 4) alerts.push({ pid, kind: "decline", text: `${name} declined: OVR ${old.ovr} → ${cur.ovr}` });
      if (cur.tid !== old.tid) alerts.push({ pid, kind: cur.tid === PL.FREE_AGENT ? "available" : "moved", text: cur.tid === PL.FREE_AGENT ? `${name} is a free agent (was ${team(old.tid)})` : `${name} moved: ${team(old.tid)} → ${team(cur.tid)}` });
      if (cur.inj > 20 && !(old.inj > 20)) alerts.push({ pid, kind: "injury", text: `${name} is injured (${cur.inj} games)` });
      if (cur.exp === s.season && old.exp !== s.season && cur.tid >= 0) alerts.push({ pid, kind: "expiring", text: `${name}'s contract expires after this season` });
    }
    return { alerts, state };
  }

  // ======================= #12 Strategy benchmark =======================
  function benchmark(runs) {
    const by = new Map();
    for (const r of runs || []) {
      const k = r.strategy || "auto";
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r);
    }
    return [...by.entries()].map(([k, rs]) => ({
      strategy: k, runs: rs.length, seasons: rs.reduce((s, r) => s + (r.seasons || 0), 0),
      winPct: mean(rs.map((r) => r.winPct).filter((x) => x != null)), titles: rs.reduce((s, r) => s + (r.titles || 0), 0),
      playoffRate: mean(rs.map((r) => (r.seasons ? (r.playoffApps || 0) / r.seasons : 0))), payrollPerWin: mean(rs.map((r) => r.payrollPerWin).filter((x) => x != null)),
    })).sort((a, b) => b.winPct - a.winPct);
  }

  // ======================= Win engine (inside the manager's decisions) =======================
  /**
   * How the team wins more, as an input to every trade and signing (recomputed with each league-model build,
   * i.e. every game day during Autopilot):
   *  - where you stand: gaps (team rating) to the best team, the top three and the playoff line
   *  - weaknesses: rotation areas (shooting, rim protection, playmaking…) below the league average, weighted by
   *    how far below; a move that lifts them counts extra, one that drains them counts against it
   *  - lineup synergy: BBGM's on-court skill bonus for the best five
   *  - star power: near the top, the best player's OVR matters most in the playoffs, so upgrades there count extra
   * team rating (the existing score) still dominates; the fit adds at most ±0.6 points.
   */
  function winContext(L) {
    if (L._win) return L._win;
    const s = L.snap, me = s.userTid;
    const tids = s.teams.map((t) => t.tid);
    const profs = new Map(tids.map((tid) => [tid, P().teamProfile(L, tid).scores]));
    const mine = profs.get(me) || {};
    const weak = [], strong = [];
    for (const c of P().CATS) {
      const vals = tids.map((t) => profs.get(t)[c.id]);
      const m = mean(vals), sd = Math.sqrt(mean(vals.map((x) => (x - m) ** 2))) || 1;
      const z = (mine[c.id] - m) / sd;
      if (z < -0.3) weak.push({ id: c.id, label: c.label, z, w: clamp(-z, 0.3, 2) });
      else if (z > 0.8) strong.push({ id: c.id, label: c.label, z });
    }
    weak.sort((a, b) => a.z - b.z);
    const movs = tids.map((t) => ({ tid: t, mov: L.movNow.get(t) || 0 })).sort((a, b) => b.mov - a.mov);
    const my = L.movNow.get(me) || 0, others = movs.filter((x) => x.tid !== me);
    const rank = movs.findIndex((x) => x.tid === me) + 1;
    const gapTop = others[0] ? others[0].mov - my : 0, gap3 = others[2] ? others[2].mov - my : 0;
    const gapPO = movs[Math.floor(movs.length / 2)] ? movs[Math.floor(movs.length / 2)].mov - my : 0;
    const starPush = (L.mode === "contend") && gap3 <= 3;
    L._win = { weak, strong, rank, of: movs.length, gapTop, gap3, gapPO, starPush };
    return L._win;
  }
  /** Rotation profile (top 10 by OVR) of a hypothetical roster, as the ratings you can see. */
  function profileOf(L, pids) {
    const rot = pids.map((pid) => L.byPid.get(pid)).filter((v) => v && !(v.p.injury && v.p.injury.gamesRemaining > 20))
      .sort((a, b) => b.summary.ovr - a.summary.ovr).slice(0, 10);
    const out = {};
    for (const c of P().CATS) {
      let sum = 0, w = 0;
      rot.forEach((v, i) => { sum += P().MOV_W[i] * P().catScore(c, P().shownRatings(L, v)); w += P().MOV_W[i]; });
      out[c.id] = w ? sum / w : 0;
    }
    out.star = rot[0] ? rot[0].summary.ovr : 0;
    out.syn = synergyOf(rot.slice(0, 5).map((v) => (v.p.ratings[v.p.ratings.length - 1] || {}).skills || [])).total;
    return out;
  }
  /** Fit of a roster change for winning: { fit (team-rating points, ±0.6), why: [reasons] }. */
  function fitGain(L, beforePids, afterPids) {
    const ctx = winContext(L);
    const a = profileOf(L, beforePids), b = profileOf(L, afterPids);
    let fit = 0;
    const why = [], hurt = [];
    for (const w of ctx.weak) {
      const c = (b[w.id] - a[w.id]) * 0.04 * w.w;
      fit += c;
      if (c > 0.04) why.push(`${w.label.toLowerCase()} (a weak spot) +${(b[w.id] - a[w.id]).toFixed(1)}`);
      else if (c < -0.04) hurt.push(`${w.label.toLowerCase()} (already weak) ${(b[w.id] - a[w.id]).toFixed(1)}`);
    }
    const ds = (b.syn - a.syn) * 1.0;
    fit += ds;
    if (ds > 0.05) why.push("better skill synergy in the best five");
    else if (ds < -0.05) hurt.push("worse skill synergy in the best five");
    if (ctx.starPush) {
      const d = b.star - a.star;
      fit += d * 0.08;
      if (d >= 2) why.push(`star power +${d.toFixed(0)} OVR (close to the top: stars decide playoff series)`);
      else if (d <= -2) hurt.push(`star power ${d.toFixed(0)} OVR`);
    }
    return { fit: clamp(fit, -0.6, 0.6), why, hurt };
  }

  root.BBGMScoutInsights = {
    resignRisks, TRAIT, ownerDeltas, jobSecurity, decisions, synergyOf, lineupSynergy, playoffScout, classStats, setClassHistory, draftClass,
    rivals, legacyView, forecastRecord, accuracy, watchAlerts, benchmark, winContext, profileOf, fitGain,
  };
})(globalThis);
