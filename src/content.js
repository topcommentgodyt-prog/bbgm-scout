/*
 * BBGM Scout – content script: player outlook panel + inline peak badges.
 */
(function () {
  "use strict";
  const S = globalThis.BBGMScoutStorage;
  const D = globalThis.BBGMScoutData;
  const A = globalThis.BBGMScoutAnalyze;

  const PLAYER_RE = /\/l\/(\d+)\/player\/(\d+)/;
  const LEAGUE_RE = /\/l\/(\d+)(?:\/|$)/;
  const DRAFT_RE = /\/l\/\d+\/(draft|draft_scouting|draft_history)(\/|$)/;

  let settings = { ...S.DEFAULT_SETTINGS };
  let lastUrl = "";
  let current = null; // { lid, pid, result }
  const badgeCache = new Map(); // `${lid}:${pid}:${respectFog}` -> summary

  const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function isDark() {
    const t = document.documentElement.getAttribute("data-bs-theme") || document.body.getAttribute("data-bs-theme");
    if (t) return t === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  // ---------------- Panel ----------------
  let host, shadow;
  function ensurePanel() {
    if (host && document.body.contains(host)) return;
    host = document.createElement("div");
    host.id = "bbgm-scout-host";
    shadow = host.attachShadow({ mode: "open" });
    document.body.appendChild(host);
  }
  function removePanel() {
    if (host) host.remove();
    host = shadow = null;
  }

  const CSS = `
  :host { all: initial; }
  .wrap { position: fixed; bottom: 16px; z-index: 2147483000; width: 290px; max-width: calc(100vw - 32px);
    font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --bg:#fff; --fg:#1d2330; --mut:#667085; --line:#e4e7ec; --chip:#f2f4f7; --acc:#2f6fed; --good:#12804a; --bad:#c4321c; --warn:#a15c00;
    background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 8px 28px rgba(16,24,40,.18); overflow: hidden; }
  .wrap.dark { --bg:#1b1f27; --fg:#e7e9ee; --mut:#98a2b3; --line:#2f3542; --chip:#262b36; --acc:#6f9bff; --good:#4cc38a; --bad:#ff7a66; --warn:#f5b04c; }
  .wrap.right { right: 16px; } .wrap.left { left: 16px; }
  header { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--line); cursor:pointer; user-select:none; }
  header b { font-size:13px; letter-spacing:.2px; }
  .sync { margin-left:auto; font-size:11px; color:var(--mut); display:flex; align-items:center; gap:4px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--good); } .dot.local { background:var(--warn); } .dot.error { background:var(--bad); }
  .caret { color:var(--mut); font-size:11px; }
  .body { padding:10px 12px 12px; }
  .collapsed .body { display:none; }
  .title { display:flex; justify-content:space-between; align-items:baseline; }
  .name { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sub { color:var(--mut); font-size:12px; margin-top:1px; }
  .tag { font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; background:var(--chip); white-space:nowrap; }
  .tag.up { color:var(--good); } .tag.down { color:var(--bad); }
  .big { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin:10px 0 8px; text-align:center; }
  .big div { background:var(--chip); border-radius:8px; padding:6px 2px; }
  .big small { display:block; color:var(--mut); font-size:10.5px; text-transform:uppercase; letter-spacing:.4px; }
  .big strong { display:block; font-size:22px; font-variant-numeric:tabular-nums; line-height:1.15; }
  .big em { display:block; font-style:normal; color:var(--mut); font-size:10.5px; }
  .rows div { display:flex; justify-content:space-between; padding:3px 0; border-bottom:1px dashed var(--line); }
  .rows div:last-child { border-bottom:0; }
  .rows span:first-child { color:var(--mut); white-space:nowrap; }
  .rows span:last-child { font-weight:600; font-variant-numeric:tabular-nums; }
  .good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); }
  svg { display:block; width:100%; height:46px; margin:8px 0 2px; }
  .legend { display:flex; gap:10px; font-size:10.5px; color:var(--mut); }
  .legend i { display:inline-block; width:10px; height:2px; vertical-align:middle; margin-right:3px; background:var(--fg); }
  .legend i.f { background:var(--acc); }
  .why { color:var(--mut); font-size:11px; margin-top:6px; }
  .actions { display:flex; gap:6px; margin-top:10px; }
  button { flex:1; font:inherit; font-size:12px; padding:5px 8px; border-radius:7px; border:1px solid var(--line); background:var(--bg); color:var(--fg); cursor:pointer; }
  button:hover { border-color:var(--acc); }
  button.on { background:var(--acc); color:#fff; border-color:var(--acc); }
  .msg { color:var(--mut); padding:4px 0; }
  `;

  function sparkline(res) {
    const hist = res.ovrHistory.slice(-6);
    const fut = res.fc.meanPath.slice(0, Math.max(2, res.fc.peakAgeRange[1] - res.summary.age + 3));
    const pts = [...hist, ...fut];
    const ages = pts.map((p) => p.age), ovrs = pts.map((p) => p.ovr);
    const a0 = Math.min(...ages), a1 = Math.max(...ages);
    const o0 = Math.min(...ovrs, res.summary.ceiling) - 2, o1 = Math.max(...ovrs, res.summary.ceiling) + 2;
    const W = 266, H = 46;
    const x = (a) => ((a - a0) / Math.max(1, a1 - a0)) * (W - 4) + 2;
    const y = (o) => H - 3 - ((o - o0) / Math.max(1, o1 - o0)) * (H - 6);
    const line = (arr) => arr.map((p, i) => `${i ? "L" : "M"}${x(p.age).toFixed(1)},${y(p.ovr).toFixed(1)}`).join("");
    const ceilY = y(res.summary.ceiling).toFixed(1);
    return `<svg viewBox="0 0 ${W} ${H}" aria-label="OVR history and forecast">
      <line x1="2" x2="${W - 2}" y1="${ceilY}" y2="${ceilY}" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="3 3"/>
      ${hist.length > 1 ? `<path d="${line(hist)}" fill="none" stroke="currentColor" stroke-width="1.6"/>` : ""}
      <path d="${line(fut)}" fill="none" stroke="var(--acc)" stroke-width="1.8" stroke-dasharray="4 2"/>
      <circle cx="${x(res.summary.peakAge)}" cy="${y(res.fc.meanPath.find((p) => p.age === res.summary.peakAge)?.ovr ?? res.summary.peakOvr)}" r="2.6" fill="var(--acc)"/>
    </svg>
    <div class="legend"><span><i></i>History</span><span><i class="f"></i>Avg forecast</span><span>- - Ceiling ${res.summary.ceiling}</span></div>`;
  }

  async function renderPanel(state) {
    ensurePanel();
    const st = await S.status();
    const dark = isDark() ? " dark" : "";
    const col = settings.panelCollapsed ? " collapsed" : "";
    let body;
    if (state.loading) body = `<div class="msg">Reading league data…</div>`;
    else if (state.error) body = `<div class="msg">${esc(state.error)}</div>`;
    else {
      const r = state.result, s = r.summary;
      const tagCls = /upside|Rising/.test(s.label) ? "up" : /Declin/.test(s.label) ? "down" : "";
      const trCls = s.trend === "Above expected" ? "good" : s.trend === "Below expected" ? "bad" : "";
      const confCls = s.confidence === "High" ? "good" : s.confidence === "Low" ? "bad" : "warn";
      const trendTip = r.trend.seasons.map((t) => `${t.season}: ${t.actual >= 0 ? "+" : ""}${t.actual} actual vs ${t.expected >= 0 ? "+" : ""}${t.expected.toFixed(1)} expected`).join("\n");
      const bustTip = settings.bustMode === "fixed" ? `Peak OVR stays below ${settings.bustOvr}` : `Peak OVR stays below POT − ${settings.bustMargin} (${r.fc.bustThreshold})`;
      body = `
        <div class="title"><div class="name" title="${esc(s.name)}">${esc(s.name)}</div><span class="tag ${tagCls}">${esc(s.label)}</span></div>
        <div class="sub">Age ${s.age} · OVR ${s.ovr} · POT ${s.pot}${s.pos ? ` · ${esc(s.pos)}` : ""}</div>
        <div class="big">
          <div title="Median age of career-high OVR (middle 50%: ${r.fc.peakAgeRange[0]}–${r.fc.peakAgeRange[1]})"><small>Peak age</small><strong>${s.peakAge}</strong><em>${r.fc.peakAgeRange[0]}–${r.fc.peakAgeRange[1]}</em></div>
          <div title="Median career-high OVR (10th pct: ${r.fc.peakOvrLow})"><small>Peak OVR</small><strong>${s.peakOvr}</strong><em>low ${r.fc.peakOvrLow}</em></div>
          <div title="90th-percentile career-high OVR"><small>Ceiling</small><strong>${s.ceiling}</strong><em>90th pct</em></div>
        </div>
        <div class="rows">
          <div title="Chance of gaining 5+ OVR next season"><span>Breakout chance</span><span class="${s.breakout >= 0.2 ? "good" : ""}">${pct(s.breakout)}</span></div>
          <div title="Chance of losing 5+ OVR next season"><span>Decline risk</span><span class="${s.decline >= 0.1 ? "bad" : ""}">${pct(s.decline)}</span></div>
          <div title="${esc(bustTip)}"><span>Bust risk</span><span class="${s.bust >= 0.5 ? "bad" : ""}">${pct(s.bust)}</span></div>
          <div title="${esc(r.trend.diff != null ? `Average ${r.trend.diff >= 0 ? "+" : ""}${r.trend.diff.toFixed(1)} OVR/yr vs. expected\n${trendTip}` : "Needs at least one completed season")}\n\nBBGM progression is random each year, so this describes the past; it doesn't change the forecast."><span>Development trend</span><span class="${trCls}">${esc(s.trend)}</span></div>
          <div title="${esc(r.confidence.reasons.join("\n"))}"><span>Confidence</span><span class="${confCls}">${s.confidence} · ${r.confidence.score}</span></div>
        </div>
        ${sparkline(r)}
        <div class="why">${esc(r.confidence.reasons[0])}${r.fog ? " · fog on" : ""} · ${r.fc.nSims.toLocaleString()} sims</div>
        <div class="actions">
          <button id="pin" class="${state.pinned ? "on" : ""}">${state.pinned ? "★ Pinned" : "☆ Pin"}</button>
          <button id="save">Save report</button>
        </div>`;
    }
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="wrap ${settings.panelSide === "left" ? "left" : "right"}${dark}${col}">
        <header id="hdr"><b>BBGM Scout</b><span class="sync" title="${esc(st.detail)}"><span class="dot ${st.mode}"></span>${esc(st.text)}</span><span class="caret">${settings.panelCollapsed ? "▲" : "▼"}</span></header>
        <div class="body">${body}</div>
      </div>`;
    shadow.getElementById("hdr").onclick = async () => {
      settings.panelCollapsed = !settings.panelCollapsed;
      await S.saveSettings({ panelCollapsed: settings.panelCollapsed });
      renderPanel(state);
    };
    const pinBtn = shadow.getElementById("pin");
    if (pinBtn) pinBtn.onclick = async () => {
      state.pinned = await S.togglePin(pinSummary(state));
      renderPanel(state);
    };
    const saveBtn = shadow.getElementById("save");
    if (saveBtn) saveBtn.onclick = async () => {
      const note = window.prompt("Optional scouting note for this report:", "") ;
      if (note === null) return;
      const ok = await S.saveReport({ ...pinSummary(state), note, savedAt: Date.now() });
      saveBtn.textContent = ok ? "Saved ✓" : "Save failed";
      setTimeout(() => renderPanel(state), 1500);
    };
  }

  function pinSummary(state) {
    const s = state.result.summary;
    return { lid: state.lid, ...s, label: s.label, savedAt: Date.now(), url: location.pathname };
  }

  async function showPlayer(lid, pid) {
    const state = { lid, pid, loading: true };
    current = state;
    renderPanel(state);
    try {
      const ctx = await D.load(lid, [pid]);
      const p = ctx.players.get(pid);
      if (!p) throw new Error("This player isn't in the saved league data yet. BBGM saves to your browser periodically. Try again after the next game day or phase change.");
      if (current !== state) return;
      state.result = A.analyze(ctx, p, settings);
      state.pinned = await S.isPinned(lid, pid);
      if (state.pinned) S.refreshPin(pinSummary(state));
    } catch (e) {
      state.error = e.message || String(e);
    }
    state.loading = false;
    if (current === state) renderPanel(state);
  }

  // ---------------- Inline badges ----------------
  const BADGE_STYLE_ID = "bbgm-scout-badge-style";
  function ensureBadgeStyle() {
    if (document.getElementById(BADGE_STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = BADGE_STYLE_ID;
    st.textContent = `.bbgm-scout-badge{display:inline-block;margin-left:5px;padding:0 5px;border-radius:999px;font-size:10.5px;line-height:15px;font-weight:600;vertical-align:1px;background:rgba(47,111,237,.12);color:#2f6fed;white-space:nowrap;font-variant-numeric:tabular-nums;cursor:help}
    [data-bs-theme=dark] .bbgm-scout-badge{background:rgba(111,155,255,.18);color:#8fb0ff}`;
    document.head.appendChild(st);
  }
  function badgesWanted() {
    if (settings.badges === "off") return false;
    if (settings.badges === "draft") return DRAFT_RE.test(location.pathname);
    return LEAGUE_RE.test(location.pathname);
  }
  function clearBadges() {
    document.querySelectorAll(".bbgm-scout-badge").forEach((b) => b.remove());
  }

  let badgeTimer = null, badgeRunning = false;
  function scheduleBadges() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(runBadges, 350);
  }
  async function runBadges() {
    if (badgeRunning) return scheduleBadges();
    if (!badgesWanted()) return clearBadges();
    const lm = location.pathname.match(LEAGUE_RE);
    if (!lm) return;
    const lid = Number(lm[1]);
    const links = [...document.querySelectorAll('a[href*="/player/"]')].filter((a) => {
      if (a.closest("#bbgm-scout-host")) return false;
      const m = a.getAttribute("href").match(PLAYER_RE);
      if (!m || Number(m[1]) !== lid) return false;
      const nx = a.nextElementSibling;
      return !(nx && nx.classList.contains("bbgm-scout-badge"));
    });
    if (!links.length) return;
    badgeRunning = true;
    try {
      ensureBadgeStyle();
      const fogKey = settings.respectFog ? 1 : 0;
      const pids = [...new Set(links.map((a) => Number(a.getAttribute("href").match(PLAYER_RE)[2])))];
      const missing = pids.filter((pid) => !badgeCache.has(`${lid}:${pid}:${fogKey}`)).slice(0, 400);
      if (missing.length) {
        const ctx = await D.load(lid, missing);
        for (const pid of missing) {
          const p = ctx.players.get(pid);
          let s = null;
          if (p && p.tid !== D.PLAYER.RETIRED) {
            try { s = A.analyze(ctx, p, settings, { nSims: 250, full: false }).summary; } catch (e) { s = null; }
          }
          badgeCache.set(`${lid}:${pid}:${fogKey}`, s);
        }
      }
      for (const a of links) {
        const pid = Number(a.getAttribute("href").match(PLAYER_RE)[2]);
        const s = badgeCache.get(`${lid}:${pid}:${fogKey}`);
        if (!s) continue;
        const b = document.createElement("span");
        b.className = "bbgm-scout-badge";
        b.textContent = `▲${s.peakOvr}`;
        b.title = `BBGM Scout: projected peak ${s.peakOvr} OVR at age ${s.peakAge} · ceiling ${s.ceiling} · breakout ${Math.round(s.breakout * 100)}%`;
        a.insertAdjacentElement("afterend", b);
      }
    } catch (e) {
      // League DB unavailable (e.g. not on a league page); stay quiet.
    } finally {
      badgeRunning = false;
    }
  }

  // ---------------- Routing ----------------
  function onRoute() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const m = location.pathname.match(PLAYER_RE);
    if (m) showPlayer(Number(m[1]), Number(m[2]));
    else { current = null; removePanel(); }
    scheduleBadges();
  }

  async function init() {
    settings = await S.getSettings();
    S.onChange((changes) => {
      if (!changes.settings) return;
      const prev = settings;
      settings = { ...S.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      const modelChanged = ["nSims", "respectFog", "bustMode", "bustMargin", "bustOvr"].some((k) => prev[k] !== settings[k]);
      if (modelChanged) { badgeCache.clear(); clearBadges(); }
      if (current && (modelChanged || prev.panelSide !== settings.panelSide)) { lastUrl = ""; onRoute(); }
      scheduleBadges();
    });
    onRoute();
    setInterval(onRoute, 500); // BBGM is a single-page app; poll for route changes.
    new MutationObserver((muts) => {
      if (settings.badges === "off") return;
      if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !n.classList?.contains("bbgm-scout-badge") && n.id !== "bbgm-scout-host"))) scheduleBadges();
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
