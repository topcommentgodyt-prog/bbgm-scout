/*
 * Courtside – Moneyball: value per dollar.
 *
 * Everything is measured in BBGM's own team rating (predicted margin of victory, MOV): what a player adds
 * to YOUR team's rating, divided by what they cost. ~1 point of MOV ≈ 2.7 wins over 82 games.
 */
(function (root) {
  "use strict";
  const LG = root.BBGMScoutLeague;
  const { PH, PL } = LG;
  const P = () => root.BBGMScoutPlanning;
  const F = () => root.BBGMScoutFeatures;

  const M = (k) => k / 1000; // thousands -> $M
  const healthy = (v) => !(v.p.injury && v.p.injury.gamesRemaining > 20);
  const ovrsOf = (vs) => vs.map((v) => v.summary.ovr);

  function analyze(L, settings) {
    const snap = L.snap, ga = snap.ga || {};
    const games = ga.numGames || 82;
    const winsOf = (mov) => Math.max(0, Math.min(games, games * (0.5 + 0.033 * mov)));
    const teamPlayers = (tid) => snap.players.filter((p) => p.tid === tid).map((p) => L.byPid.get(p.pid)).filter(Boolean);
    const mine = teamPlayers(snap.userTid).filter(healthy);
    const baseMov = LG.teamMov(ovrsOf(mine));
    const withPlayer = (v) => LG.teamMov(ovrsOf([...mine, v])) - baseMov;
    const withoutPlayer = (v) => baseMov - LG.teamMov(ovrsOf(mine.filter((x) => x !== v)));
    const salary = (v) => (v.p.tid === PL.FREE_AGENT && v.p.mood ? v.p.mood.contractAmount : v.p.contract ? v.p.contract.amount : 0);

    // 1. Payroll efficiency for every team
    const teams = snap.teams.map((t) => {
      const ps = teamPlayers(t.tid).filter(healthy);
      const mov = LG.teamMov(ovrsOf(ps));
      const wins = winsOf(mov);
      return { tid: t.tid, abbrev: t.abbrev, name: `${t.region} ${t.name}`, payroll: t.payroll, mov, wins, perWin: wins > 0 ? t.payroll / wins : Infinity };
    }).sort((a, b) => a.perWin - b.perWin);
    teams.forEach((t, i) => (t.rank = i + 1));
    const me = teams.find((t) => t.tid === snap.userTid);

    // 2. Your roster by value per dollar
    const roster = teamPlayers(snap.userTid).map((v) => {
      const adds = healthy(v) ? withoutPlayer(v) : 0;
      const sal = salary(v);
      return { v, pid: v.p.pid, name: v.summary.name, age: v.summary.age, ovr: v.summary.ovr, salary: sal, adds, perPoint: adds > 0.05 ? sal / adds : Infinity, surplus: v.surplus,
        tag: v.surplus <= -5 ? "Overpaid" : v.surplus >= 8 && sal <= (ga.salaryCap || 1e9) * 0.1 ? "Bargain" : "" };
    }).sort((a, b) => b.adds / Math.max(0.3, M(b.salary)) - a.adds / Math.max(0.3, M(a.salary)));

    // 3. Market inefficiencies: where BBGM's AI valuation and the Scout model disagree, by trait
    const active = [...L.byPid.values()].filter((v) => v.p.tid >= -1 && !v.prospect);
    const traits = [];
    const gap = (list) => (list.length >= 8 ? list.reduce((s, v) => s + (v.ourPct - v.marketPct), 0) / list.length : null);
    for (const c of P().CATS) {
      const scored = active.map((v) => ({ v, x: P().catScore(c, P().shownRatings(L, v)) })).sort((a, b) => b.x - a.x);
      const top = scored.slice(0, Math.max(8, Math.floor(scored.length / 5))).map((x) => x.v);
      const g = gap(top); if (g != null) traits.push({ label: `Strong ${c.label.toLowerCase()}`, gap: g, n: top.length });
    }
    const bands = [[19, 22, "Age 19–22"], [23, 25, "Age 23–25"], [26, 28, "Age 26–28"], [29, 31, "Age 29–31"], [32, 45, "Age 32+"]];
    for (const [a, b, label] of bands) { const list = active.filter((v) => v.summary.age >= a && v.summary.age <= b); const g = gap(list); if (g != null) traits.push({ label, gap: g, n: list.length }); }
    const ath = (v) => { const r = P().shownRatings(L, v); return (r.spd + r.jmp + r.endu) / 3 - (r.oiq + r.diq + r.tp + r.drb + r.pss) / 5; };
    const athList = active.filter((v) => ath(v) >= 8), iqList = active.filter((v) => ath(v) <= -8);
    if (gap(athList) != null) traits.push({ label: "Athleticism-heavy builds", gap: gap(athList), n: athList.length });
    if (gap(iqList) != null) traits.push({ label: "Skill / IQ-heavy builds", gap: gap(iqList), n: iqList.length });
    traits.sort((a, b) => b.gap - a.gap);
    const undervalued = traits.filter((t) => t.gap >= 3).slice(0, 4);
    const overvalued = traits.filter((t) => t.gap <= -3).slice(-4).reverse();

    // 4. Best value per dollar available (free agents you can sign + trade targets)
    const fas = new Map(F().freeAgents(L).map((f) => [f.pid, f]));
    const pool = [...L.byPid.values()].filter((v) => (v.p.tid === PL.FREE_AGENT && fas.get(v.p.pid) && fas.get(v.p.pid).canSign) || (v.p.tid >= 0 && v.p.tid !== snap.userTid && !v.p.untradable && P().playerLevel(v.p.pid) !== "never"));
    const available = pool.map((v) => {
      const adds = withPlayer(v), sal = salary(v);
      return { v, pid: v.p.pid, name: v.summary.name, age: v.summary.age, ovr: v.summary.ovr, kind: v.p.tid === PL.FREE_AGENT ? "fa" : "trade", team: (L.teams.get(v.p.tid) || {}).abbrev,
        salary: sal, adds, perM: adds / Math.max(0.5, M(sal)), surplus: v.surplus, futureOvr: LG.ovrAt(L, v.p.pid, 2) };
    }).filter((x) => x.adds >= 0.2).sort((a, b) => b.perM - a.perM).slice(0, 10);

    // 5. Age arbitrage
    const buy = [...L.byPid.values()].filter((v) => v.p.tid >= 0 && v.p.tid !== snap.userTid && !v.p.untradable && v.summary.age >= 21 && v.summary.age <= 25)
      .map((v) => ({ v, rise: LG.ovrAt(L, v.p.pid, 2) - v.summary.ovr, edge: v.ourPct - v.marketPct }))
      .filter((x) => x.rise >= 3 && x.edge >= 5 && x.v.surplus > 0).sort((a, b) => b.rise + b.edge / 5 - (a.rise + a.edge / 5)).slice(0, 5)
      .map((x) => ({ pid: x.v.p.pid, name: x.v.summary.name, team: (L.teams.get(x.v.p.tid) || {}).abbrev, age: x.v.summary.age, ovr: x.v.summary.ovr, later: Math.round(LG.ovrAt(L, x.v.p.pid, 2)), edge: x.edge }));
    const sell = teamPlayers(snap.userTid).filter((v) => v.summary.age >= 28 && P().playerLevel(v.p.pid) === "available")
      .map((v) => ({ v, drop: v.summary.ovr - LG.ovrAt(L, v.p.pid, 2), edge: v.marketPct - v.ourPct }))
      .filter((x) => x.drop >= 2 && x.edge >= 3).sort((a, b) => b.drop + b.edge / 5 - (a.drop + a.edge / 5)).slice(0, 5)
      .map((x) => ({ pid: x.v.p.pid, name: x.v.summary.name, age: x.v.summary.age, ovr: x.v.summary.ovr, later: Math.round(LG.ovrAt(L, x.v.p.pid, 2)), edge: x.edge }));

    // 6. Moneyball swaps: replace a poor-value player with a same-or-cheaper one who adds more
    const swaps = [];
    const usedIn = new Set();
    const weak = roster.filter((r) => r.salary > (ga.minContract || 750) * 1.5 && P().playerLevel(r.pid) === "available" && r.v.p.tid === snap.userTid)
      .sort((a, b) => a.adds / Math.max(0.3, M(a.salary)) - b.adds / Math.max(0.3, M(b.salary))).slice(0, 4);
    for (const w of weak) {
      const without = mine.filter((x) => x.p.pid !== w.pid);
      const baseW = LG.teamMov(ovrsOf(without));
      const cand = pool.filter((v) => !usedIn.has(v.p.pid) && salary(v) <= w.salary * 1.05)
        .map((v) => ({ v, net: LG.teamMov(ovrsOf([...without, v])) - baseW - w.adds, saves: w.salary - salary(v) }))
        .filter((x) => x.net >= 0.3).sort((a, b) => b.net + M(b.saves) * 0.1 - (a.net + M(a.saves) * 0.1))[0];
      if (cand) {
        usedIn.add(cand.v.p.pid);
        swaps.push({ out: w, inn: { pid: cand.v.p.pid, name: cand.v.summary.name, ovr: cand.v.summary.ovr, salary: salary(cand.v), kind: cand.v.p.tid === PL.FREE_AGENT ? "fa" : "trade", team: (L.teams.get(cand.v.p.tid) || {}).abbrev },
          net: cand.net, saves: cand.saves });
      }
    }
    return { teams, me, roster, undervalued, overvalued, available, buy, sell, swaps, baseMov, winsPerMov: games * 0.033, M };
  }

  root.BBGMScoutMoneyball = { analyze };
})(globalThis);
