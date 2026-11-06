/*
 * Courtside – turns a raw BBGM player record into a scouting summary.
 * Shared by the player panel and the inline badges.
 */
(function (root) {
  "use strict";
  const E = root.BBGMScoutEngine;
  const D = root.BBGMScoutData;

  const fuzzed = (v, f) => Math.round(Math.max(0, Math.min(100, v + f)));

  function analyze(ctx, p, settings, { nSims, full = true, maxAge } = {}) {
    const rows = (p.ratings || []).filter((r) => typeof r.season === "number").sort((a, b) => a.season - b.season);
    if (!rows.length) throw new Error("Player has no ratings");
    const cur = rows[rows.length - 1];
    const age = cur.season - p.born.year;
    const team = ctx.teams.get(p.tid);
    const userTeam = ctx.teams.get(ctx.userTid);
    const coachLevel = D.budgetLevel(team, "coaching");

    const fogApplies = settings.respectFog && !ctx.godMode && !ctx.multiTeam && p.tid !== ctx.userTid && !!cur.fuzz;
    const fuzz = fogApplies ? cur.fuzz : 0;
    const shown = {};
    for (const k of E.RATING_KEYS) shown[k] = fuzzed(cur[k], fuzz);
    const shownOvr = fuzzed(cur.ovr, fuzz);
    const shownPot = fuzzed(cur.pot, fuzz);
    const fog = fogApplies ? E.scoutingFuzz(D.budgetLevel(userTeam, "scouting") ?? E.DEFAULT_LEVEL) : null;

    const bustThreshold = settings.bustMode === "fixed" ? settings.bustOvr : shownPot - settings.bustMargin;
    const seed = E.hashSeed(p.pid, cur.season, settings.respectFog ? 1 : 0);
    const fc = E.forecast({
      ratings: shown, age, coachLevel, fog, locked: !!cur.locked,
      nSims: nSims || settings.nSims, seed, bustThreshold, maxAge,
    });
    const summary = {
      pid: p.pid,
      name: `${p.firstName || ""} ${p.lastName || ""}`.trim(),
      season: cur.season,
      age, ovr: shownOvr, pot: shownPot, pos: cur.pos,
      peakAge: fc.peakAge, peakOvr: fc.peakOvr, ceiling: fc.ceiling,
      breakout: fc.breakout, decline: fc.decline, bust: fc.bust,
    };
    if (!full) return { summary, fc, fog, coachLevel };

    // History: rows the user could see (fuzzed the same way the game shows them).
    const histRows = rows.map((r) => {
      const fz = fogApplies ? r.fuzz || 0 : 0;
      const o = { season: r.season, locked: r.locked, ovr: fuzzed(r.ovr, fz) };
      for (const k of E.RATING_KEYS) o[k] = fuzzed(r[k], fz);
      return o;
    });
    const tr = E.trend(histRows, p.born.year, coachLevel, seed);
    const historySeasons = rows.filter((r, i) => i > 0 && r.season === rows[i - 1].season + 1).length;
    const conf = E.confidence({
      fc, fog, historySeasons, locked: !!cur.locked,
      realPlayerDeterminism: p.srID ? ctx.realPlayerDeterminism : 0,
    });
    summary.trend = tr.label;
    summary.confidence = conf.label;
    summary.label = E.outlookLabel({ age, ovr: shownOvr, fc });
    // Attributes as the game shows them now, and at the end of last season (for the ▲/▼ changes).
    const prevRow = histRows.length > 1 ? histRows[histRows.length - 2] : null;
    const attrs = { season: cur.season, ovr: shownOvr, pot: shownPot, ratings: shown, prev: prevRow ? { season: prevRow.season, ovr: prevRow.ovr, ratings: Object.fromEntries(E.RATING_KEYS.map((k) => [k, prevRow[k]])) } : null };
    return { summary, fc, trend: tr, confidence: conf, fog, coachLevel, attrs, ovrHistory: histRows.map((r) => ({ age: r.season - p.born.year, ovr: r.ovr })) };
  }

  root.BBGMScoutAnalyze = { analyze };
})(globalThis);
