/*
 * BBGM Scout – forecasting engine.
 *
 * Forecasts are Monte Carlo simulations of Basketball GM's own yearly
 * progression rules (age-based base change + noise, per-rating age modifiers
 * and change limits, coaching effect) and its OVR formula. This is an
 * independent re-implementation of the published game mechanics, written for
 * personal use. It runs entirely on your device.
 *
 * Works as a classic script (exposes globalThis.BBGMScoutEngine) and in Node
 * (module.exports) so it can be unit tested.
 */
(function (root) {
  "use strict";

  const RATING_KEYS = ["hgt", "stre", "spd", "jmp", "endu", "ins", "dnk", "ft", "fg", "tp", "oiq", "diq", "drb", "pss", "reb"];
  const DEFAULT_LEVEL = 34; // budget level whose effect is 0

  // ---------- RNG (seeded so a player's forecast is stable across reloads) ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(...parts) {
    let h = 2166136261;
    for (const ch of parts.join("|")) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  const bound = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  function normal(rng, mu, sigma) {
    let z1, z2, r;
    do {
      z1 = 2 * rng() - 1;
      z2 = 2 * rng() - 1;
      r = z1 * z1 + z2 * z2;
    } while (r >= 1 || r === 0);
    return mu + sigma * z1 * Math.sqrt((-2 * Math.log(r)) / r);
  }
  // BBGM's "gauss" for scouting fuzz is a sum of three uniforms (bounded at ±3σ).
  const tri3 = (rng, sigma) => (rng() * 2 - 1 + (rng() * 2 - 1) + (rng() * 2 - 1)) * sigma;

  // ---------- Budget effects ----------
  function levelToEffect(level) {
    if (!Number.isFinite(level)) return 0;
    const x = (3 * (Math.round(level) - 1)) / 99 - 1;
    return x < 0 ? 1.1 * x : 1.1 * Math.tanh(x);
  }
  const coachingEffect = (level) => 0.09 * levelToEffect(level);
  function scoutingFuzz(level) {
    const e = levelToEffect(level);
    return { cutoff: Math.round((1 - e) * 3.5 + 1), sd: 2 - e };
  }

  // ---------- OVR ----------
  const OVR_W = {
    hgt: [0.159, 47.5], stre: [0.0777, 50.2], spd: [0.123, 50.8], jmp: [0.051, 48.7], endu: [0.0632, 39.9],
    ins: [0.0126, 42.4], dnk: [0.0286, 49.5], ft: [0.0202, 47.0], tp: [0.0726, 47.1], oiq: [0.133, 46.8],
    diq: [0.159, 46.7], drb: [0.059, 54.8], pss: [0.062, 51.3], fg: [0.01, 47.0], reb: [0.01, 51.4],
  };
  function ovr(r) {
    let x = 48.5;
    for (const k of RATING_KEYS) x += OVR_W[k][0] * (r[k] - OVR_W[k][1]);
    let fudge;
    if (x >= 68) fudge = 8;
    else if (x >= 50) fudge = 4 + (x - 50) * (4 / 18);
    else if (x >= 42) fudge = -5 + (x - 42) * (9 / 8);
    else if (x >= 31) fudge = -5 - (42 - x) * (5 / 11);
    else fudge = -10;
    return bound(Math.round(x + fudge), 0, 100);
  }

  // ---------- Yearly development ----------
  function step(age, cuts) {
    // cuts: [[maxAge, value], ...] ascending; last entry is the fallback
    for (const [a, v] of cuts) if (age <= a) return v;
    return cuts[cuts.length - 1][1];
  }
  const SHOOT_MOD = (a) => step(a, [[27, 0], [29, 0.5], [31, 1.5], [Infinity, 2]]);
  const IQ_MOD = (a) => step(a, [[21, 4], [23, 3], [27, 0], [29, 0.5], [31, 1.5], [Infinity, 2]]);
  const RULES = {
    stre: { mod: () => 0, lim: () => [-Infinity, Infinity] },
    spd: { mod: (a) => step(a, [[27, 0], [30, -2], [35, -3], [40, -4], [Infinity, -8]]), lim: () => [-12, 2] },
    jmp: { mod: (a) => step(a, [[26, 0], [30, -3], [35, -4], [40, -5], [Infinity, -10]]), lim: () => [-12, 2] },
    endu: {
      mod: (a, rng) => (a <= 23 ? rng() * 9 : step(a, [[30, 0], [35, -2], [40, -4], [Infinity, -8]])),
      lim: () => [-11, 19],
    },
    dnk: { mod: (a) => (a <= 27 ? 0 : 0.5), lim: () => [-3, 13] },
    ins: { mod: SHOOT_MOD, lim: () => [-3, 13] },
    ft: { mod: SHOOT_MOD, lim: () => [-3, 13] },
    fg: { mod: SHOOT_MOD, lim: () => [-3, 13] },
    tp: { mod: SHOOT_MOD, lim: () => [-3, 13] },
    oiq: { mod: IQ_MOD, lim: (a) => (a >= 24 ? [-3, 9] : [-3, 7 + 5 * (24 - a)]) },
    diq: { mod: IQ_MOD, lim: (a) => (a >= 24 ? [-3, 9] : [-3, 7 + 5 * (24 - a)]) },
    drb: { mod: SHOOT_MOD, lim: () => [-2, 5] },
    pss: { mod: SHOOT_MOD, lim: () => [-2, 5] },
    reb: { mod: SHOOT_MOD, lim: () => [-2, 5] },
  };
  const RULE_ENTRIES = Object.entries(RULES);

  function baseChange(age, coachLevel, rng) {
    let v = step(age, [[21, 2], [25, 1], [27, 0], [29, -1], [31, -2], [34, -3], [40, -4], [43, -5], [Infinity, -6]]);
    if (age <= 23) v += bound(normal(rng, 0, 5), -4, 20);
    else if (age <= 25) v += bound(normal(rng, 0, 5), -4, 10);
    else v += bound(normal(rng, 0, 3), -2, 4);
    v *= 1 + (v > 0 ? 1 : -1) * coachingEffect(coachLevel);
    return v;
  }
  const limitRating = (x) => (x > 100 ? 100 : x < 0 ? 0 : Math.floor(x));

  /** Develop ratings in place by one season. `age` is the age in the NEW season. */
  function developSeason(r, age, coachLevel, rng) {
    if (age <= 21) {
      const h = rng();
      if (h > 0.99 && age <= 20 && r.hgt <= 99) r.hgt += 1;
      if (h > 0.999 && r.hgt <= 99) r.hgt += 1;
    }
    const base = baseChange(age, coachLevel, rng);
    for (const [k, rule] of RULE_ENTRIES) {
      const [lo, hi] = rule.lim(age);
      const change = bound((base + rule.mod(age, rng)) * (0.4 + rng()), lo, hi);
      r[k] = limitRating(r[k] + change);
    }
  }

  // ---------- Stats helpers ----------
  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

  function pickRatings(src) {
    const r = {};
    for (const k of RATING_KEYS) r[k] = Number(src[k]) || 0;
    return r;
  }

  /**
   * Main forecast.
   * opts: {
   *   ratings      – current rating values (what you can see; already fuzzed if fog applies)
   *   age          – age in the current ratings season
   *   coachLevel   – coaching budget level of the player's team (default 34 = neutral)
   *   fog          – null, or { sd, cutoff } scouting uncertainty to integrate over
   *   locked       – ratings locked in God Mode (no development)
   *   nSims, maxAge, seed
   *   bustThreshold – peak OVR below this counts as a bust
   * }
   */
  function forecast(opts) {
    const nSims = opts.nSims || 1000;
    const maxAge = opts.maxAge || 36;
    const coach = Number.isFinite(opts.coachLevel) ? opts.coachLevel : DEFAULT_LEVEL;
    const rng = mulberry32(opts.seed != null ? opts.seed : 12345);
    const seen = pickRatings(opts.ratings);
    const age0 = opts.age;
    const years = Math.max(0, maxAge - age0);

    const peaks = [], peakAges = [], nextDeltas = [], startOvrs = [];
    const pathSum = new Array(years + 1).fill(0);

    for (let s = 0; s < nSims; s++) {
      const r = { ...seen };
      if (opts.fog) {
        // Displayed = true + fuzz  =>  true = displayed - fuzz, fuzz drawn from the scouting prior.
        const f = bound(tri3(rng, opts.fog.sd), -opts.fog.cutoff, opts.fog.cutoff);
        for (const k of RATING_KEYS) r[k] = bound(r[k] - f, 0, 100);
      }
      const o0 = ovr(r);
      startOvrs.push(o0);
      let best = o0, bestAge = age0;
      pathSum[0] += o0;
      for (let y = 1; y <= years; y++) {
        if (!opts.locked) developSeason(r, age0 + y, coach, rng);
        const o = ovr(r);
        pathSum[y] += o;
        if (y === 1) nextDeltas.push(o - o0);
        if (o > best) { best = o; bestAge = age0 + y; }
      }
      if (years === 0) nextDeltas.push(0);
      peaks.push(best);
      peakAges.push(bestAge);
    }

    const sp = [...peaks].sort((a, b) => a - b);
    const sa = [...peakAges].sort((a, b) => a - b);
    const frac = (arr, fn) => arr.filter(fn).length / arr.length;
    const thr = opts.bustThreshold;

    return {
      nSims,
      startOvr: Math.round(mean(startOvrs)),
      peakOvr: Math.round(quantile(sp, 0.5)),
      peakOvrLow: Math.round(quantile(sp, 0.1)),
      ceiling: Math.round(quantile(sp, 0.9)),
      peakAge: Math.round(quantile(sa, 0.5)),
      peakAgeRange: [Math.round(quantile(sa, 0.25)), Math.round(quantile(sa, 0.75))],
      breakout: frac(nextDeltas, (d) => d >= 5),
      decline: frac(nextDeltas, (d) => d <= -5),
      expectedNextDelta: mean(nextDeltas),
      bust: Number.isFinite(thr) ? frac(peaks, (p) => p < thr) : null,
      bustThreshold: thr,
      meanPath: pathSum.map((x, i) => ({ age: age0 + i, ovr: x / nSims })),
    };
  }

  /** Expected OVR change for one season of development from `ratings` (age = age in the new season). */
  function expectedDelta(ratings, newAge, coachLevel, nSims, seed) {
    const rng = mulberry32(seed);
    const base = pickRatings(ratings);
    const o0 = ovr(base);
    let sum = 0;
    for (let s = 0; s < nSims; s++) {
      const r = { ...base };
      developSeason(r, newAge, coachLevel, rng);
      sum += ovr(r) - o0;
    }
    return sum / nSims;
  }

  /**
   * Development trend: actual OVR change vs. what BBGM's progression rules
   * expected for each of the player's last few seasons.
   * rows: ratings rows oldest→newest, each with season + rating keys (+ ovr).
   */
  function trend(rows, bornYear, coachLevel, seed) {
    const out = [];
    for (let i = Math.max(1, rows.length - 3); i < rows.length; i++) {
      const prev = rows[i - 1], cur = rows[i];
      if (cur.season !== prev.season + 1 || cur.locked) continue;
      const exp = expectedDelta(prev, cur.season - bornYear, coachLevel, 300, seed + i);
      const act = ovr(pickRatings(cur)) - ovr(pickRatings(prev));
      out.push({ season: cur.season, expected: exp, actual: act, diff: act - exp });
    }
    if (!out.length) return { label: "Not enough history", diff: null, seasons: [] };
    const d = mean(out.map((x) => x.diff));
    const label = d >= 2 ? "Above expected" : d <= -2 ? "Below expected" : "As expected";
    return { label, diff: d, seasons: out };
  }

  /** 0–100 forecast reliability score with plain-language reasons. */
  function confidence({ fc, fog, historySeasons, realPlayerDeterminism, locked, staleSave }) {
    let score = 100;
    const reasons = [];
    if (locked) return { score: 95, label: "High", reasons: ["Ratings are locked (no development)"] };
    const spread = fc.ceiling - fc.peakOvrLow;
    const spreadPen = Math.min(40, Math.max(0, spread - 4) * 2.5);
    if (spreadPen >= 10) reasons.push(`Wide outcome range (${fc.peakOvrLow}–${fc.ceiling} peak)`);
    score -= spreadPen;
    if (fog) {
      const p = Math.min(25, fog.sd * 7);
      score -= p;
      reasons.push(`Scouting fog (±${fog.cutoff} OVR possible)`);
    }
    if (historySeasons === 0) { score -= 15; reasons.push("No completed seasons yet"); }
    else if (historySeasons === 1) { score -= 8; reasons.push("Only one season of history"); }
    if (realPlayerDeterminism > 0) {
      score -= 20 * Math.min(1, realPlayerDeterminism);
      reasons.push("Real-player determinism is on; real career data overrides random progs");
    }
    if (staleSave) { score -= 5; reasons.push("League may have unsaved changes"); }
    score = Math.round(bound(score, 5, 99));
    const label = score >= 70 ? "High" : score >= 45 ? "Medium" : "Low";
    if (!reasons.length) reasons.push("Progression model matches BBGM rules; little uncertainty");
    return { score, label, reasons };
  }

  function outlookLabel({ age, ovr: cur, fc }) {
    const upside = fc.ceiling - cur;
    if (fc.peakAge <= age && fc.expectedNextDelta < -1) return "Declining";
    if (fc.peakAge <= age) return "At peak";
    if (upside >= 15) return "High upside";
    if (upside >= 8) return "Rising";
    return "Near peak";
  }

  const api = {
    RATING_KEYS, DEFAULT_LEVEL, ovr, developSeason, forecast, expectedDelta, trend, confidence,
    outlookLabel, scoutingFuzz, coachingEffect, levelToEffect, mulberry32, hashSeed, quantile,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BBGMScoutEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
