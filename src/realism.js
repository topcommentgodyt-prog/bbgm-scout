/*
 * BBGM Scout – Realism advisor.
 *
 * Records a few league-wide numbers every season (stars, parity, payrolls vs.
 * the cap, contract sizes, injuries, scoring and three-point rates) and, as
 * the years go by, suggests God Mode / league settings that would keep the
 * league realistic. It only suggests; it never changes settings.
 */
(function (root) {
  "use strict";
  const LG = root.BBGMScoutLeague;
  const S = root.BBGMScoutStorage;
  const { PH } = LG;

  const std = (a) => { const m = a.reduce((s, x) => s + x, 0) / (a.length || 1); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length || 1)); };
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
  const money = (k) => `$${(k / 1000).toFixed(1)}M`;

  function measure(L) {
    const snap = L.snap, ga = snap.ga || {};
    const active = snap.players.filter((p) => p.tid >= 0);
    const ovr = (p) => p.ratings[p.ratings.length - 1].ovr;
    const nTeams = snap.teams.length || 1;
    const teamOvrs = snap.teams.map((t) => active.filter((p) => p.tid === t.tid).map(ovr));
    const movs = teamOvrs.map((o) => LG.teamMov(o));
    const gp = (t) => t.won + t.lost + (t.tied || 0) + (t.otl || 0);
    const pctW = snap.teams.filter((t) => gp(t) >= 10).map((t) => t.won / gp(t));
    const top50 = [...active].sort((a, b) => ovr(b) - ovr(a)).slice(0, 50);
    const payrolls = snap.teams.map((t) => t.payroll);
    const st = snap.leagueStats;
    return {
      season: snap.season,
      stars70PerTeam: active.filter((p) => ovr(p) >= 70).length / nTeams,
      stars60PerTeam: active.filter((p) => ovr(p) >= 60).length / nTeams,
      topOvr: top50.length ? ovr(top50[0]) : 0,
      parity: std(movs),
      winPctSpread: pctW.length >= 4 ? std(pctW) : null,
      bestWinPct: pctW.length ? Math.max(...pctW) : null,
      payrollRatio: ga.salaryCap ? median(payrolls) / ga.salaryCap : null,
      overTax: ga.luxuryPayroll ? payrolls.filter((x) => x > ga.luxuryPayroll).length / nTeams : null,
      maxShare: ga.maxContract ? active.filter((p) => p.contract && p.contract.amount >= ga.maxContract * 0.98).length / Math.max(1, active.length) : null,
      injuredShare: active.filter((p) => p.injury && p.injury.gamesRemaining > 20).length / Math.max(1, active.length),
      top50Age: top50.length ? top50.reduce((s, p) => s + (snap.season - p.born.year), 0) / top50.length : null,
      ppg: st && st.gp ? st.pts / st.gp : null,
      tpaRate: st && st.fga ? st.tpa / st.fga : null,
      salaryCap: ga.salaryCap,
      gamesPlayed: snap.teams.reduce((s, t) => s + gp(t), 0) / nTeams,
    };
  }

  /** Store this season's numbers (once the season is far enough along to mean something). */
  async function record(lid, L) {
    const key = `realism:${lid}`;
    const hist = (await S.localGet(key)) || {};
    const m = measure(L);
    const ga = L.snap.ga || {};
    const enough = (L.snap.phase === PH.REGULAR_SEASON && m.gamesPlayed >= (ga.numGames || 82) * 0.25) || L.snap.phase === PH.AFTER_TRADE_DEADLINE || L.snap.phase === PH.PLAYOFFS;
    if (enough || !hist[m.season]) hist[m.season] = { ...m, partial: !enough };
    const seasons = Object.keys(hist).map(Number).sort((a, b) => a - b);
    for (const s of seasons.slice(0, Math.max(0, seasons.length - 60))) delete hist[s];
    await S.localSet(key, hist);
    return hist;
  }

  /** Suggestions: { title, why, setting: [category, name], current, suggest, severity } */
  function advise(L, hist) {
    const ga = L.snap.ga || {};
    const rows = Object.values(hist).filter((r) => !r.partial).sort((a, b) => a.season - b.season);
    const now = measure(L);
    const first = rows[0];
    const last3 = rows.slice(-3);
    const out = [];
    const add = (o) => out.push(o);
    // Early in a season there's little to go on, so judge money and style from the last full season instead.
    const minGames = (ga.numGames || 82) * 0.25;
    const ref = now.gamesPlayed >= minGames || !rows.length ? now : { ...rows[rows.length - 1], gamesPlayed: rows[rows.length - 1].gamesPlayed };

    // 1. Parity: dynasties / super-teams, or everyone the same
    const avgParity = last3.length ? last3.reduce((s, r) => s + r.parity, 0) / last3.length : now.parity;
    const dynasty = last3.filter((r) => r.bestWinPct != null && r.bestWinPct >= 0.78).length >= 2;
    if (avgParity > 8.5 || dynasty) {
      add({ severity: "high", title: "Talent is concentrating on a few teams",
        why: `Team strength spread is ${avgParity.toFixed(1)} points of margin of victory${dynasty ? ", and the best team has won 78%+ of its games in 2 of the last 3 seasons" : ""}. Real leagues are usually around 5 to 7.`,
        changes: [
          ga.salaryCapType === "soft" ? { setting: ["Finances", "Salary Cap Type"], current: "soft", suggest: "hard (no exceeding the cap to re-sign stars)" } : null,
          { setting: ["Finances", "Luxury Tax"], current: ga.luxuryTax, suggest: Math.min(3, (ga.luxuryTax || 1.5) + 0.5).toFixed(1) },
          ga.softCapTradeSalaryMatch > 110 ? { setting: ["Finances", "Trade Salary Match"], current: `${ga.softCapTradeSalaryMatch}%`, suggest: "110%" } : null,
          ga.aiTradesFactor > 0.5 ? { setting: ["Events", "AI-to-AI Trades Factor"], current: ga.aiTradesFactor, suggest: (ga.aiTradesFactor * 0.6).toFixed(2) } : null,
        ].filter(Boolean) });
    } else if (avgParity < 3.5 && rows.length >= 2) {
      add({ severity: "low", title: "Every team is about the same",
        why: `Team strength spread is only ${avgParity.toFixed(1)} points. Real leagues have clearer contenders and rebuilders.`,
        changes: [{ setting: ["Finances", "Luxury Tax"], current: ga.luxuryTax, suggest: Math.max(1, (ga.luxuryTax || 1.5) - 0.5).toFixed(1) },
          { setting: ["Events", "AI-to-AI Trades Factor"], current: ga.aiTradesFactor, suggest: Math.min(3, (ga.aiTradesFactor || 1) * 1.5).toFixed(2) }] });
    }

    // 2. Money: payrolls running away from the cap, max deals everywhere, no inflation over many years
    if (ref.payrollRatio != null && (ref.payrollRatio > 1.15 || (ref.overTax || 0) > 0.35)) {
      add({ severity: "medium", title: "Payrolls have outgrown the salary cap",
        why: `The median payroll is ${(ref.payrollRatio * 100).toFixed(0)}% of the cap and ${Math.round((ref.overTax || 0) * 100)}% of teams pay luxury tax.`,
        changes: [{ setting: ["Finances", "Salary Cap"], current: money(ga.salaryCap), suggest: money(Math.round(ga.salaryCap * 1.1)) },
          { setting: ["Finances", "Luxury Tax Threshold"], current: money(ga.luxuryPayroll), suggest: money(Math.round(ga.luxuryPayroll * 1.1)) }] });
    } else if (ref.payrollRatio != null && ref.payrollRatio < 0.8 && ref.gamesPlayed > 5) {
      add({ severity: "low", title: "Teams have lots of unused cap space",
        why: `The median payroll is only ${(ref.payrollRatio * 100).toFixed(0)}% of the cap, so free agency becomes a free-for-all.`,
        changes: [{ setting: ["Finances", "Salary Cap"], current: money(ga.salaryCap), suggest: money(Math.round(ga.salaryCap * 0.92)) },
          { setting: ["Contracts", "Min Contract"], current: money(ga.minContract), suggest: money(Math.round(ga.minContract * 1.1)) }] });
    }
    if (ref.maxShare != null && ref.maxShare > 0.1) {
      add({ severity: "medium", title: "Too many max contracts",
        why: `${Math.round(ref.maxShare * 100)}% of players are on max deals (closer to 5% is realistic), so stars and good starters get paid the same.`,
        changes: [{ setting: ["Contracts", "Max Contract"], current: money(ga.maxContract), suggest: money(Math.round(ga.maxContract * 1.15)) }] });
    }
    if (rows.length >= 4 && !(ga.inflationAvg > 0)) {
      add({ severity: "low", title: "The salary cap never changes",
        why: `${rows.length} seasons in with no inflation. In the NBA the cap has grown about 5% a year, which keeps old contracts aging realistically.`,
        changes: [{ setting: ["Inflation", "Average"], current: `${ga.inflationAvg || 0}%`, suggest: "3%" }, { setting: ["Inflation", "Standard Deviation"], current: `${ga.inflationStd || 0}%`, suggest: "2%" }] });
    }

    // 3. Star inflation / deflation over the years
    if (first && rows.length >= 3) {
      const r = now.stars70PerTeam / Math.max(0.05, first.stars70PerTeam);
      if (r > 1.6 && now.stars70PerTeam > 0.6) {
        add({ severity: "medium", title: "Ratings are inflating",
          why: `There are now ${now.stars70PerTeam.toFixed(2)} players with 70+ OVR per team, up from ${first.stars70PerTeam.toFixed(2)} in ${first.season}. A few superstars per league is realistic.`,
          changes: [{ setting: ["Draft", "Draft Type"], current: ga.draftType, suggest: "keep, but consider importing realistic draft classes (Tools → Draft classes)" },
            { setting: ["Players", "God Mode: edit outlier ratings"], current: "", suggest: "trim the most extreme outliers" }] });
      } else if (r < 0.5 && first.stars70PerTeam > 0.3) {
        add({ severity: "low", title: "Stars are disappearing",
          why: `Only ${now.stars70PerTeam.toFixed(2)} players with 70+ OVR per team, down from ${first.stars70PerTeam.toFixed(2)} in ${first.season}.`,
          changes: [{ setting: ["Draft", "Draft classes"], current: "", suggest: "upload or generate stronger draft classes" }] });
      }
    }

    // 4. Injuries
    if (ref.injuredShare > 0.1) {
      add({ severity: "medium", title: "Too many long-term injuries",
        why: `${Math.round(ref.injuredShare * 100)}% of players are out 20+ games.`,
        changes: [{ setting: ["Injuries", "Injury Rate"], current: ga.injuryRate != null ? ga.injuryRate.toExponential(2) : "", suggest: ga.injuryRate != null ? (ga.injuryRate * 0.75).toExponential(2) : "lower by 25%" }] });
    }

    // 5. Style of play compared with the modern NBA (~40% of shots are threes, ~114 points a game)
    if (ref.tpaRate != null && ref.gamesPlayed >= 10) {
      if (ref.tpaRate < 0.33 || ref.tpaRate > 0.47) {
        const f = (ga.threePointTendencyFactor || 1) * (0.4 / ref.tpaRate);
        add({ severity: "low", title: ref.tpaRate < 0.33 ? "Fewer threes than the modern game" : "More threes than the modern game",
          why: `${Math.round(ref.tpaRate * 100)}% of shots are threes. The modern NBA is about 40%.`,
          changes: [{ setting: ["Tendencies", "Three Point Tendency Factor"], current: ga.threePointTendencyFactor ?? 1, suggest: f.toFixed(2) }] });
      }
      const ppgTeam = ref.ppg; // team points per team-game
      if (ppgTeam != null && (ppgTeam < 104 || ppgTeam > 124)) {
        add({ severity: "low", title: ppgTeam < 104 ? "Scoring is low for the modern era" : "Scoring is high for the modern era",
          why: `Teams average ${ppgTeam.toFixed(1)} points per game. The modern NBA is about 112 to 116.`,
          changes: [{ setting: ["Tendencies", "Pace"], current: ga.pace ?? 100, suggest: Math.round((ga.pace || 100) * (114 / ppgTeam)) }] });
      }
    }
    const order = { high: 0, medium: 1, low: 2 };
    return { now, rows, suggestions: out.sort((a, b) => order[a.severity] - order[b.severity]) };
  }

  root.BBGMScoutRealism = { measure, record, advise };
})(globalThis);
