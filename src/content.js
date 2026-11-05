/*
 * BBGM Scout – content script: the in-page dock (Outlook, AI, Trades, Targets,
 * Free Agents, Draft, Manager/Autopilot) and inline peak badges.
 */
(function () {
  "use strict";
  const S = globalThis.BBGMScoutStorage;
  const D = globalThis.BBGMScoutData;
  const A = globalThis.BBGMScoutAnalyze;
  const B = globalThis.BBGMScoutBridge;
  const LG = globalThis.BBGMScoutLeague;
  const F = globalThis.BBGMScoutFeatures;
  const R = globalThis.BBGMScoutRealism;
  const P = globalThis.BBGMScoutPlanning;
  const SG = globalThis.BBGMScoutStrategy;
  const MB = globalThis.BBGMScoutMoneyball;
  const ext = globalThis.chrome || globalThis.browser;

  const PLAYER_RE = /\/l\/(\d+)\/player\/(\d+)/;
  const LEAGUE_RE = /\/l\/(\d+)(?:\/|$)/;
  const DRAFT_RE = /\/l\/\d+\/(draft|draft_scouting|draft_history)(\/|$)/;
  const TRADE_RE = /\/l\/\d+\/trade(\/|$|\?)/;

  let settings = { ...S.DEFAULT_SETTINGS };
  let lastUrl = "";
  const badgeCache = new Map();

  const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (x, d = 1) => (x >= 0 ? "+" : "") + x.toFixed(d);
  const lidNow = () => { const m = location.pathname.match(LEAGUE_RE); return m ? Number(m[1]) : null; };
  const pidNow = () => { const m = location.pathname.match(PLAYER_RE); return m ? Number(m[2]) : null; };
  const plink = (pid, label) => `<a class="pl" href="/l/${lidNow()}/player/${pid}" title="Open player page">${esc(label)}</a>`;
  /** Escape `text`, turning the names of the given players into profile links. */
  function linkText(text, pids) {
    let html = esc(text);
    for (const pid of pids || []) {
      const name = st.L ? LG.name(st.L, pid) : null;
      if (name && !name.startsWith("#")) html = html.replace(esc(name), plink(pid, name));
    }
    return html;
  }
  const PROT_ICON = { available: "", ask: "?", never: "🔒" };
  function protectSelect(kind, id) {
    const cur = kind === "pick" ? P.pickLevel(id) : P.playerLevel(id);
    return `<select class="prot ${cur}" data-protect="${kind}:${id}" title="Trade protection: automation never trades, cuts or lets go a Never-trade asset, and always asks before moving an Ask-first one">
      ${Object.entries(P.LEVELS).map(([k, label]) => `<option value="${k}"${k === cur ? " selected" : ""}>${PROT_ICON[k] ? PROT_ICON[k] + " " : ""}${label}</option>`).join("")}</select>`;
  }
  /** Go to a BBGM page in this tab, letting BBGM's own router handle it (no reload, never a new tab). */
  function goTo(href) {
    const a = document.createElement("a");
    a.href = href;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function isDark() {
    if (settings.theme === "dark") return true;
    if (settings.theme === "light") return false;
    const t = document.documentElement.getAttribute("data-bs-theme") || document.body.getAttribute("data-bs-theme");
    if (t) return t === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  // ======================================================================
  // State
  // ======================================================================
  const st = {
    tab: "outlook",
    outlook: null, // { lid, pid, loading, error, result, pinned }
    poll: null,
    pollKey: "",
    L: null, LKey: "", building: null, buildMsg: "",
    trades: { ideas: null, note: "", busy: false, msg: "", forKey: "" },
    current: null, // evaluation of the trade on the trade screen
    offer: null, // targets: built offer
    targetsBusy: null,
    pending: null, // manager suggestions
    log: [],
    ap: { running: false, status: "", startSeason: null, stopReq: false },
    ask: { q: "", busy: false, answer: "", error: "" },
    flash: "",
  };
  const handlers = new Map();
  let hid = 0;
  const on = (fn) => { const id = `h${++hid}`; handlers.set(id, fn); return id; };

  const THEME_ICON = { auto: "◐ Auto", light: "☀ Light", dark: "☾ Dark" };
  const THEME_LABEL = { auto: "Auto (follows BBGM)", light: "Light", dark: "Dark" };
  const TABS = [
    ["outlook", "Outlook", () => true],
    ["assistant", "AI", () => settings.features.assistant],
    ["trades", "Trades", () => settings.features.trades],
    ["targets", "Targets", () => settings.features.targets],
    ["fa", "FA", () => settings.features.freeAgents],
    ["draft", "Draft", () => settings.features.drafter],
    ["manager", "Manager", () => settings.features.manager || settings.features.autopilot],
    ["needs", "Needs", () => settings.features.needs],
    ["plan", "Plan", () => settings.features.plan],
    ["moneyball", "Moneyball", () => settings.features.moneyball],
    ["realism", "Realism", () => settings.features.realism],
  ];
  const needsBridge = () => TABS.slice(1).some(([, , en]) => en());

  // ======================================================================
  // League model (live snapshot through BBGM's engine)
  // ======================================================================
  const keyOf = (p) => (p ? `${p.season}:${p.phase}:${p.gp}:${p.onClock}` : "");
  // Finer-grained: also changes as playoff games, scheduled games and free-agency days are played.
  const progressKey = (p) => (p ? `${keyOf(p)}:${p.prog}:${p.sched}:${p.daysLeft}:${p.round}` : "");
  async function getL(force) {
    const k = st.pollKey;
    if (!force && st.L && st.LKey === k) return st.L;
    if (st.building) return st.building;
    st.building = (async () => {
      st.buildMsg = "Reading league…"; render();
      const snap = await B.snapshot();
      const sid = st.league || `lid${lidNow()}`;
      const stored = await S.getStrategy(sid);
      const L = await LG.build(snap, settings, (f) => { st.buildMsg = `Analyzing players… ${Math.round(f * 100)}%`; render(); }, { strategyStored: stored });
      F.setLeague(lidNow()); F.noteClock(L);
      const dec = L.strategy.auto && L.strategy.decision;
      if (dec && (!stored || stored.cp !== dec.cp || stored.key !== dec.key)) {
        await S.setStrategy(sid, dec);
        if (stored && stored.key !== dec.key) {
          await S.addLog({ kind: "strategy", text: `Strategy (Auto): ${SG.STRATEGIES[stored.key] ? SG.STRATEGIES[stored.key].label : stored.key} → ${L.strategy.label}`,
            ex: { why: `Re-evaluated at the ${dec.cp.split(":")[1]} checkpoint of ${dec.cp.split(":")[0]}; strength ${dec.strength} cleared the hysteresis margin.`, benefits: L.strategy.reasons, costs: [], strategy: L.strategy.label, basis: "projected" } });
          st.log = await S.getLog();
        }
      }
      st.L = L; st.LKey = k;
      if (settings.features.realism) refreshRealism(L).then(() => { if (st.tab === "realism") render(); });
      return L;
    })();
    try { return await st.building; } finally { st.building = null; st.buildMsg = ""; }
  }
  const invalidate = () => { st.L = null; st.LKey = ""; };

  // ======================================================================
  // Dock shell
  // ======================================================================
  let host, shadow;
  function ensureHost() {
    if (host && document.body.contains(host)) return;
    host = document.createElement("div");
    host.id = "bbgm-scout-host";
    shadow = host.attachShadow({ mode: "open" });
    const linkClick = (e) => {
      const pl = e.target.closest("a.pl");
      if (!pl) return false;
      e.preventDefault();
      e.stopPropagation();
      goTo(pl.getAttribute("href"));
      return true;
    };
    shadow.addEventListener("auxclick", (e) => { if (e.button === 1) linkClick(e); });
    shadow.addEventListener("click", async (e) => {
      if (linkClick(e)) return;
      const el = e.target.closest("[data-h]");
      if (!el) return;
      const fn = handlers.get(el.dataset.h);
      if (fn) { e.preventDefault(); await fn(el); }
    });
    shadow.addEventListener("input", (e) => { if (e.target.id === "askq") st.ask.q = e.target.value; });
    shadow.addEventListener("change", async (e) => {
      const ctl = e.target.closest("[data-set]");
      if (ctl) {
        const k = ctl.dataset.set;
        let v = ctl.type === "number" ? Number(ctl.value) : ctl.value;
        if (ctl.type === "number") v = Math.max(Number(ctl.min || -1e9), Math.min(Number(ctl.max || 1e9), Number.isFinite(v) ? v : 0));
        if (k === "apSeasons") v = Math.max(1, Math.min(100, Number(v) || 1));
        settings[k] = v;
        await S.saveSettings({ [k]: v });
        if (k === "teamMode") { invalidate(); st.trades.ideas = null; st.pending = null; }
        render();
        return;
      }
      const sel = e.target.closest("select[data-protect]");
      if (!sel) return;
      const [kind, id] = sel.dataset.protect.split(":");
      const league = await ensureIdentity();
      if (!league) { st.flash = "BBGM hasn't saved this league yet; try again in a moment."; render(); return; }
      await P.setProtection(league, kind, Number(id), sel.value);
      st.trades.ideas = null; st.pending = null;
      st.flash = `${sel.value === "never" ? "Never trade" : sel.value === "ask" ? "Ask first" : "Available"} saved. Every automated feature will follow it.`;
      render();
      setTimeout(() => { st.flash = ""; render(); }, 3500);
    });
    document.body.appendChild(host);
  }
  function removeHost() { if (host) host.remove(); host = shadow = null; }

  const CSS = `
  :host { all: initial; }
  .wrap { position: fixed; bottom: 16px; z-index: 2147483000; width: 340px; max-width: calc(100vw - 32px);
    font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --bg:#fff; --fg:#1d2330; --mut:#667085; --line:#e4e7ec; --chip:#f2f4f7; --acc:#2f6fed; --good:#12804a; --bad:#c4321c; --warn:#a15c00;
    background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 8px 28px rgba(16,24,40,.18); overflow: hidden; display:flex; flex-direction:column; max-height: min(78vh, 720px); }
  .wrap.dark { --bg:#1b1f27; --fg:#e7e9ee; --mut:#98a2b3; --line:#2f3542; --chip:#262b36; --acc:#6f9bff; --good:#4cc38a; --bad:#ff7a66; --warn:#f5b04c; }
  .wrap.right { right: 16px; } .wrap.left { left: 16px; }
  a { color: var(--acc); text-decoration: none; } a:hover { text-decoration: underline; }
  a.pl { color: inherit; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 28%, transparent); text-underline-offset: 2px; text-decoration-thickness: 1px; }
  a.pl:hover { color: var(--acc); text-decoration-color: currentColor; }
  header { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--line); cursor:pointer; user-select:none; flex:none; }
  header b { font-size:13px; }
  .sync { margin-left:auto; font-size:11px; color:var(--mut); display:flex; align-items:center; gap:4px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--good); } .dot.local { background:var(--warn); } .dot.error { background:var(--bad); }
  .caret { color:var(--mut); font-size:11px; padding:1px 7px; }
  header .theme { padding:1px 7px; font-size:11px; color:var(--mut); }
  nav { display:flex; flex-wrap:wrap; gap:0 1px; padding:4px 6px 0; border-bottom:1px solid var(--line); flex:none; }
  nav button { border:0; background:none; color:var(--mut); font:inherit; font-size:12px; padding:5px 7px; cursor:pointer; border-bottom:2px solid transparent; white-space:nowrap; border-radius:0; flex:none; }
  nav button.active { color:var(--fg); border-color:var(--acc); }
  nav .n { display:inline-block; min-width:14px; padding:0 4px; margin-left:3px; border-radius:999px; background:var(--acc); color:#fff; font-size:10px; line-height:14px; }
  .body { padding:10px 8px 12px 12px; overflow-y:scroll; overflow-x:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
  /* Always-visible scrollbar (macOS otherwise hides it until you scroll) */
  .body::-webkit-scrollbar { width:10px; height:10px; }
  .body::-webkit-scrollbar-track { background:var(--chip); border-radius:6px; }
  .body::-webkit-scrollbar-thumb { background:var(--mut); border-radius:6px; border:2px solid var(--chip); min-height:30px; }
  .body::-webkit-scrollbar-thumb:hover { background:var(--fg); }
  .body::-webkit-scrollbar-corner { background:transparent; }
  @supports not selector(::-webkit-scrollbar) { .body { scrollbar-width:thin; scrollbar-color:var(--mut) var(--chip); } }
  .collapsed nav, .collapsed .body { display:none; }
  .title { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
  .name { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sub { color:var(--mut); font-size:12px; margin-top:1px; }
  .tag { font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; background:var(--chip); white-space:nowrap; }
  .tag.up { color:var(--good); } .tag.down { color:var(--bad); }
  .big { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin:10px 0 8px; text-align:center; }
  .big div { background:var(--chip); border-radius:8px; padding:6px 2px; }
  .big small { display:block; color:var(--mut); font-size:10.5px; text-transform:uppercase; letter-spacing:.4px; }
  .big strong { display:block; font-size:22px; font-variant-numeric:tabular-nums; line-height:1.15; }
  .big em { display:block; font-style:normal; color:var(--mut); font-size:10.5px; }
  .rows > div { display:flex; justify-content:space-between; gap:8px; padding:3px 0; border-bottom:1px dashed var(--line); }
  .rows > div:last-child { border-bottom:0; }
  .rows span:first-child { color:var(--mut); white-space:nowrap; }
  .rows span:last-child { font-weight:600; font-variant-numeric:tabular-nums; text-align:right; }
  .good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); } .mut { color:var(--mut); }
  svg { display:block; width:100%; height:46px; margin:8px 0 2px; }
  .legend { display:flex; gap:10px; font-size:10.5px; color:var(--mut); }
  .legend i { display:inline-block; width:10px; height:2px; vertical-align:middle; margin-right:3px; background:var(--fg); }
  .legend i.f { background:var(--acc); }
  .why { color:var(--mut); font-size:11px; margin-top:6px; }
  .actions { display:flex; gap:6px; margin-top:10px; flex-wrap:wrap; }
  button { font:inherit; font-size:12px; padding:5px 8px; border-radius:7px; border:1px solid var(--line); background:var(--bg); color:var(--fg); cursor:pointer; }
  button:hover { border-color:var(--acc); }
  button.on, button.pri { background:var(--acc); color:#fff; border-color:var(--acc); }
  button.sm { font-size:11px; padding:2px 7px; }
  button:disabled { opacity:.5; cursor:default; }
  .actions button { flex:1; }
  .card .actions { margin-top:6px; } .card .actions button { flex:none; }
  .msg { color:var(--mut); padding:4px 0; }
  .card { border:1px solid var(--line); border-radius:9px; padding:8px 9px; margin-bottom:8px; }
  .card .hd { display:flex; justify-content:space-between; align-items:center; gap:6px; }
  .card ul { margin:4px 0 0; padding-left:16px; } .card li { margin:2px 0; }
  .h { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--mut); margin:10px 0 5px; }
  .h:first-child { margin-top:0; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; font-size:12px; }
  th { text-align:right; font-weight:500; color:var(--mut); font-size:10.5px; padding:2px 3px; border-bottom:1px solid var(--line); }
  td { text-align:right; padding:4px 3px; border-bottom:1px solid var(--line); }
  th:first-child, td:first-child { text-align:left; }
  td small { display:block; color:var(--mut); font-size:10.5px; }
  .chip { display:inline-block; font-size:10.5px; font-weight:600; padding:1px 6px; border-radius:999px; background:var(--chip); }
  .chip.gem { color:var(--good); } .chip.over { color:var(--bad); }
  textarea { width:100%; box-sizing:border-box; font:inherit; font-size:12px; border:1px solid var(--line); border-radius:7px; padding:6px; background:var(--bg); color:var(--fg); resize:vertical; min-height:46px; }
  .answer { white-space:pre-wrap; background:var(--chip); border-radius:8px; padding:8px; margin-top:6px; }
  .banner { background:var(--chip); border-radius:8px; padding:7px 9px; margin-bottom:8px; }
  .banner.acc { border-left:3px solid var(--acc); }
  .log div { display:flex; gap:6px; justify-content:space-between; padding:3px 0; border-bottom:1px dashed var(--line); font-size:11.5px; }
  .log time { color:var(--mut); flex:none; }
  select.prot { font:inherit; font-size:11px; padding:1px 3px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--fg); max-width:118px; }
  label.apseasons { display:flex; align-items:center; gap:6px; } label.apseasons select { font:inherit; padding:2px 4px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--fg); }
  .dash { display:grid; grid-template-columns:1fr 1fr; gap:6px 10px; align-items:center; }
  .dash label { display:flex; flex-direction:column; gap:2px; font-size:11px; color:var(--mut); }
  .dash select, .dash input, .adv select, .adv input { font:inherit; font-size:12px; padding:2px 4px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--fg); }
  .dash .full { grid-column:1 / -1; }
  details { margin:4px 0; } details > summary { cursor:pointer; color:var(--mut); font-size:12px; }
  .adv { display:grid; grid-template-columns:1fr; gap:6px; margin-top:6px; } .adv label { display:flex; justify-content:space-between; gap:8px; align-items:center; font-size:12px; }
  .adv input[type=number] { width:64px; }
  .ex { font-size:11px; color:var(--mut); margin:2px 0 4px; } .ex b { color:var(--fg); font-weight:600; } .ex ul { margin:2px 0 0 14px; padding:0; }
  .sum td, .sum th { font-size:11.5px; }
  select.prot.never { border-color:var(--bad); } select.prot.ask { border-color:var(--warn); }
  .warn-line { color:var(--warn); font-size:11px; margin-top:3px; }
  .flag { border-left:3px solid var(--line); padding:5px 8px; margin-bottom:6px; background:var(--chip); border-radius:6px; font-size:12px; }
  .flag.high { border-color:var(--bad); } .flag.medium { border-color:var(--warn); } .flag.good { border-color:var(--good); }
  .bar { height:6px; border-radius:3px; background:var(--line); position:relative; overflow:hidden; margin-top:3px; }
  .bar i { position:absolute; left:0; top:0; bottom:0; background:var(--acc); border-radius:3px; }
  .bar.weak i { background:var(--bad); }
  `;

  function tabCount(id) {
    if (id === "trades" && st.trades.ideas) return st.trades.ideas.length;
    if (id === "manager" && st.pending) return st.pending.length;
    if (id === "draft" && st.poll && st.poll.phase === 5 && st.poll.onClock === st.poll.userTid) return "!";
    return 0;
  }

  async function render() {
    if (!lidNow()) return removeHost();
    ensureHost();
    handlers.clear();
    const sync = await S.status();
    const tabs = TABS.filter(([, , en]) => en());
    if (!tabs.some(([id]) => id === st.tab)) st.tab = pidNow() ? "outlook" : tabs[tabs.length > 1 ? 1 : 0][0];
    const themeBtn = on(async () => {
      const next = { auto: "light", light: "dark", dark: "auto" }[settings.theme] || "light";
      settings.theme = next;
      await S.saveSettings({ theme: next });
      render();
    });
    const hdr = on(async () => { settings.panelCollapsed = !settings.panelCollapsed; await S.saveSettings({ panelCollapsed: settings.panelCollapsed }); render(); });
    const nav = tabs.length > 1 ? `<nav>${tabs.map(([id, label]) => {
      const n = tabCount(id);
      return `<button class="${st.tab === id ? "active" : ""}" data-h="${on(() => { st.tab = id; render(); onTabOpen(id); })}">${label}${n ? `<span class="n">${n}</span>` : ""}</button>`;
    }).join("")}</nav>` : "";
    let body = "";
    try { body = bodyFor(st.tab); } catch (e) { body = `<div class="msg">${esc(e.message)}</div>`; }
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="wrap ${settings.panelSide === "left" ? "left" : "right"}${isDark() ? " dark" : ""}${settings.panelCollapsed ? " collapsed" : ""}">
        <header data-h="${hdr}" title="Click to ${settings.panelCollapsed ? "open" : "close"}"><b>BBGM Scout</b><button class="sm theme" data-h="${themeBtn}" title="Theme: ${THEME_LABEL[settings.theme] || "Auto"} (click to change)" aria-label="Switch light or dark mode">${THEME_ICON[settings.theme] || THEME_ICON.auto}</button>${st.ap.running ? `<span class="chip">Autopilot</span>` : ""}<span class="sync" title="${esc(sync.detail)}"><span class="dot ${sync.mode}"></span>${esc(sync.text)}</span><button class="sm caret" data-h="${hdr}" title="${settings.panelCollapsed ? "Open" : "Close"} BBGM Scout" aria-label="${settings.panelCollapsed ? "Open" : "Close"} BBGM Scout" aria-expanded="${!settings.panelCollapsed}">${settings.panelCollapsed ? "▲ Open" : "▼ Close"}</button></header>
        ${nav}
        <div class="body">${st.flash ? `<div class="banner acc">${esc(st.flash)}</div>` : ""}${body}</div>
      </div>`;
  }

  function bodyFor(tab) {
    switch (tab) {
      case "outlook": return outlookBody();
      case "assistant": return assistantBody();
      case "trades": return tradesBody();
      case "targets": return targetsBody();
      case "fa": return faBody();
      case "draft": return draftBody();
      case "manager": return managerBody();
      case "realism": return realismBody();
      case "needs": return needsBody();
      case "moneyball": return moneyballBody();
      case "plan": return planBody();
      default: return "";
    }
  }

  const needL = () => {
    if (st.L) return null;
    if (!st.poll || !st.poll.inLeague) return `<div class="msg">Waiting for BBGM to load the league…</div>`;
    if (!st.building) getL().then(render, (e) => { st.flash = e.message; render(); });
    return `<div class="msg">${esc(st.buildMsg || "Reading league…")}</div>`;
  };

  async function onTabOpen(id) {
    if (id === "trades" && !st.trades.ideas && !st.trades.busy) refreshTrades();
    if (id === "manager" && settings.features.manager && !st.pending) refreshPending();
    if (id === "manager") { st.log = await S.getLog(); render(); }
  }

  // ======================================================================
  // Outlook tab (player page)
  // ======================================================================
  function sparkline(res) {
    const hist = res.ovrHistory.slice(-6);
    const fut = res.fc.meanPath.slice(0, Math.max(2, res.fc.peakAgeRange[1] - res.summary.age + 3));
    const pts = [...hist, ...fut];
    const ages = pts.map((p) => p.age), ovrs = pts.map((p) => p.ovr);
    const a0 = Math.min(...ages), a1 = Math.max(...ages);
    const o0 = Math.min(...ovrs, res.summary.ceiling) - 2, o1 = Math.max(...ovrs, res.summary.ceiling) + 2;
    const W = 316, H = 46;
    const x = (a) => ((a - a0) / Math.max(1, a1 - a0)) * (W - 4) + 2;
    const y = (o) => H - 3 - ((o - o0) / Math.max(1, o1 - o0)) * (H - 6);
    const line = (arr) => arr.map((p, i) => `${i ? "L" : "M"}${x(p.age).toFixed(1)},${y(p.ovr).toFixed(1)}`).join("");
    const ceilY = y(res.summary.ceiling).toFixed(1);
    const peak = res.fc.meanPath.find((p) => p.age === res.summary.peakAge);
    return `<svg viewBox="0 0 ${W} ${H}" aria-label="OVR history and forecast">
      <line x1="2" x2="${W - 2}" y1="${ceilY}" y2="${ceilY}" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="3 3"/>
      ${hist.length > 1 ? `<path d="${line(hist)}" fill="none" stroke="currentColor" stroke-width="1.6"/>` : ""}
      <path d="${line(fut)}" fill="none" stroke="var(--acc)" stroke-width="1.8" stroke-dasharray="4 2"/>
      <circle cx="${x(res.summary.peakAge)}" cy="${y(peak ? peak.ovr : res.summary.peakOvr)}" r="2.6" fill="var(--acc)"/>
    </svg>
    <div class="legend"><span><i></i>History</span><span><i class="f"></i>Avg forecast</span><span>- - Ceiling ${res.summary.ceiling}</span></div>`;
  }

  function outlookBody() {
    const o = st.outlook;
    if (!o) return `<div class="msg">Open any player's page to see their development outlook.${settings.features.assistant ? " The AI tab lists hidden gems around the league." : ""}</div>`;
    if (o.loading) return `<div class="msg">Reading league data…</div>`;
    if (o.error) return `<div class="msg">${esc(o.error)}</div>`;
    const r = o.result, s = r.summary;
    const tagCls = /upside|Rising/.test(s.label) ? "up" : /Declin/.test(s.label) ? "down" : "";
    const trCls = s.trend === "Above expected" ? "good" : s.trend === "Below expected" ? "bad" : "";
    const confCls = s.confidence === "High" ? "good" : s.confidence === "Low" ? "bad" : "warn";
    const trendTip = r.trend.seasons.map((t) => `${t.season}: ${t.actual >= 0 ? "+" : ""}${t.actual} actual vs ${t.expected >= 0 ? "+" : ""}${t.expected.toFixed(1)} expected`).join("\n");
    const bustTip = settings.bustMode === "fixed" ? `Peak OVR stays below ${settings.bustOvr}` : `Peak OVR stays below POT − ${settings.bustMargin} (${r.fc.bustThreshold})`;
    const gem = st.L && settings.features.assistant ? F.gemVerdict(st.L, o.pid) : null;
    const pin = on(async () => { await ensureIdentity(); await S.markSaved(o.lid); o.pinned = await S.togglePin(pinSummary(o)); render(); });
    const save = on(async (el) => {
      const note = window.prompt("Optional scouting note for this report:", "");
      if (note === null) return;
      await ensureIdentity(); await S.markSaved(o.lid);
      const ok = await S.saveReport({ ...pinSummary(o), note, savedAt: Date.now() });
      el.textContent = ok ? "Saved ✓" : "Save failed";
      setTimeout(render, 1500);
    });
    return `
      <div class="title"><div class="name">${plink(o.pid, s.name)}</div><span class="tag ${tagCls}">${esc(s.label)}</span></div>
      <div class="sub">Age ${s.age} · OVR ${s.ovr} · POT ${s.pot}${s.pos ? ` · ${esc(s.pos)}` : ""}${gem ? ` · <span class="chip ${gem.score >= 7 ? "gem" : gem.score <= -10 ? "over" : ""}" title="See the AI tab">${esc(gem.verdict)}</span>` : ""}</div>
      <div class="big">
        <div title="Median age of career-high OVR (middle 50%: ${r.fc.peakAgeRange[0]}–${r.fc.peakAgeRange[1]})"><small>Peak age</small><strong>${s.peakAge}</strong><em>${r.fc.peakAgeRange[0]}–${r.fc.peakAgeRange[1]}</em></div>
        <div title="Median career-high OVR (10th pct: ${r.fc.peakOvrLow})"><small>Peak OVR</small><strong>${s.peakOvr}</strong><em>low ${r.fc.peakOvrLow}</em></div>
        <div title="90th-percentile career-high OVR"><small>Ceiling</small><strong>${s.ceiling}</strong><em>90th pct</em></div>
      </div>
      <div class="rows">
        <div title="Chance of gaining 5+ OVR next season"><span>Breakout chance</span><span class="${s.breakout >= 0.2 ? "good" : ""}">${pct(s.breakout)}</span></div>
        <div title="Chance of losing 5+ OVR next season"><span>Decline risk</span><span class="${s.decline >= 0.1 ? "bad" : ""}">${pct(s.decline)}</span></div>
        <div title="${esc(bustTip)}"><span>Bust risk</span><span class="${s.bust >= 0.5 ? "bad" : ""}">${pct(s.bust)}</span></div>
        <div title="${esc(r.trend.diff != null ? `Average ${num(r.trend.diff)} OVR/yr vs. expected\n${trendTip}` : "Needs at least one completed season")}\n\nBBGM progression is random each year, so this describes the past; it doesn't change the forecast."><span>Development trend</span><span class="${trCls}">${esc(s.trend)}</span></div>
        <div title="${esc(r.confidence.reasons.join("\n"))}"><span>Confidence</span><span class="${confCls}">${s.confidence} · ${r.confidence.score}</span></div>
      </div>
      ${sparkline(r)}
      <div class="why">${esc(r.confidence.reasons[0])}${r.fog ? " · fog on" : ""} · ${r.fc.nSims.toLocaleString()} sims</div>
      ${st.L && st.L.byPid.get(o.pid) && st.L.byPid.get(o.pid).p.tid === st.L.snap.userTid ? `<div class="rows" style="margin-top:6px"><div><span>Trade protection</span><span>${protectSelect("player", o.pid)}</span></div></div>` : ""}
      <div class="actions">
        <button data-h="${pin}" class="${o.pinned ? "on" : ""}">${o.pinned ? "★ Pinned" : "☆ Pin"}</button>
        <button data-h="${save}">Save report</button>
      </div>`;
  }
  function pinSummary(o) {
    const s = o.result.summary;
    return { lid: o.lid, league: st.league || undefined, ...s, label: s.label, savedAt: Date.now(), url: location.pathname };
  }
  async function showPlayer(lid, pid) {
    const o = { lid, pid, loading: true };
    st.outlook = o;
    st.tab = "outlook";
    render();
    try {
      // Ask BBGM to write its in-memory changes to the database first, so the numbers are current.
      await B.call("main", "idbCacheFlush", undefined, 5000).catch(() => {});
      const ctx = await D.load(lid, [pid]);
      const p = ctx.players.get(pid);
      if (!p) throw new Error("This player isn't in the saved league data yet. Try again after the next game day.");
      if (st.outlook !== o) return;
      o.result = A.analyze(ctx, p, settings);
      const league = await ensureIdentity();
      o.pinned = await S.isPinned(league || `lid${lid}`, pid);
      if (o.pinned) S.refreshPin(pinSummary(o));
    } catch (e) {
      o.error = e.message || String(e);
    }
    o.loading = false;
    if (st.outlook === o) render();
  }

  // ======================================================================
  // AI tab: hidden gems + Ask Claude
  // ======================================================================
  const verdictChip = (g) => `<span class="chip ${g.score >= 7 ? "gem" : g.score <= -10 ? "over" : ""}">${esc(g.verdict)} ${g.score >= 0 ? "+" : ""}${g.score}</span>`;
  function assistantBody() {
    const wait = needL();
    if (wait) return wait;
    const L = st.L;
    let html = "";
    const pid = pidNow();
    if (pid && L.byPid.get(pid)) {
      const g = F.gemVerdict(L, pid);
      html += `<div class="h">Is this player a hidden gem?</div>
        <div class="card"><div class="hd"><b>${plink(g.pid, g.name)}</b>${verdictChip(g)}</div>
        <ul>${g.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`;
    }
    const gems = F.gemList(L, 8);
    html += `<div class="h">Hidden gems around the league</div>`;
    html += gems.length ? gems.map((g) => {
      const t = L.teams.get(g.tid);
      const where = g.tid === -1 ? "Free agent" : g.tid < -1 ? "Draft prospect" : t ? t.abbrev : "";
      return `<div class="card"><div class="hd">${plink(g.pid, g.name)} ${verdictChip(g)}</div>
        <div class="sub">${esc(where)} · age ${g.summary.age} · OVR ${g.summary.ovr}/${g.summary.pot} → peak ${g.summary.peakOvr}, ceiling ${g.summary.ceiling}</div>
        <div class="why">${esc(g.reasons.slice(1, 3).join(" ") || g.reasons[0])}</div></div>`;
    }).join("") : `<div class="msg">No clear hidden gems right now.</div>`;
    html += `<div class="h">Ask Claude</div>`;
    if (!settings.claudeEnabled) {
      html += `<div class="msg">Turn on "Ask Claude" in BBGM Scout settings and add an Anthropic API key to ask free-form questions (for example, "Who should I build around?").</div>`;
    } else {
      const ask = on(() => askClaude());
      html += `<textarea id="askq" placeholder="e.g. Is this player worth a first-round pick? Who on my team should I sell?">${esc(st.ask.q)}</textarea>
        <div class="actions"><button class="pri" data-h="${ask}" ${st.ask.busy ? "disabled" : ""}>${st.ask.busy ? "Thinking…" : "Ask"}</button></div>
        ${st.ask.error ? `<div class="msg bad">${esc(st.ask.error)}</div>` : ""}
        ${st.ask.answer ? `<div class="answer">${esc(st.ask.answer)}</div>` : ""}
        <div class="why">Sends your question and a summary of the relevant players (not your league file) to the Claude API using your key. Model: ${esc(settings.claudeModel)}.</div>`;
    }
    return html;
  }
  async function askClaude() {
    const L = st.L;
    if (!L || !st.ask.q.trim()) return;
    st.ask.busy = true; st.ask.error = ""; st.ask.answer = ""; render();
    const brief = (pid) => {
      const v = L.byPid.get(pid);
      if (!v) return null;
      const s = v.summary;
      return { name: s.name, team: (L.teams.get(v.p.tid) || {}).abbrev || (v.p.tid === -1 ? "FA" : "prospect"), age: s.age, pos: s.pos, ovr: s.ovr, pot: s.pot,
        peakOvr: s.peakOvr, peakAge: s.peakAge, ceiling: s.ceiling, breakout: s.breakout, decline: s.decline,
        contract: v.p.contract ? { amount: v.p.contract.amount, exp: v.p.contract.exp } : null, gemScore: Math.round(v.gemScore), valueForYourTeam: +v.surplus.toFixed(1) };
    };
    const pid = pidNow();
    const context = {
      season: L.snap.season, phase: L.snap.phase, yourTeam: L.user ? `${L.user.region} ${L.user.name}` : "", strategy: L.strategy ? L.strategy.label : L.mode,
      record: L.user ? `${L.user.won}-${L.user.lost}` : "", cap: L.capInfo,
      focusPlayer: pid ? { ...brief(pid), verdict: F.gemVerdict(L, pid) } : null,
      yourRoster: L.roster(L.snap.userTid).map((p) => brief(p.pid)).filter(Boolean),
      hiddenGems: F.gemList(L, 10).map((g) => brief(g.pid)),
      topFreeAgents: F.freeAgents(L).slice(0, 8).map((f) => ({ ...brief(f.pid), asking: f.ask })),
    };
    try {
      const r = await ext.runtime.sendMessage({ type: "bbgmScout:askClaude", question: st.ask.q, context, model: settings.claudeModel });
      if (r && r.error) st.ask.error = r.error;
      else st.ask.answer = (r && r.text) || "";
    } catch (e) {
      st.ask.error = e.message;
    }
    st.ask.busy = false; render();
  }

  // ======================================================================
  // Trades tab
  // ======================================================================
  async function refreshTrades() {
    if (st.trades.busy) return;
    st.trades.busy = true; st.trades.msg = "Reading league…"; render();
    try {
      const L = await getL();
      const r = await F.tradeIdeas(L, { shop: 3, onProgress: (m) => { st.trades.msg = m; render(); } });
      st.trades.ideas = r.ideas; st.trades.note = r.note; st.trades.forKey = st.pollKey;
    } catch (e) {
      st.trades.note = e.message;
    }
    st.trades.busy = false; st.trades.msg = ""; render();
  }
  function tradeCard(L, idea, { propose: proposeOpt = true } = {}) {
    let propose = proposeOpt;
    const d = idea.desc;
    const side = (t) => [
      ...t.pids.map((pid) => { const v = L.byPid.get(pid); return `${plink(pid, LG.name(L, pid))}${v ? ` (${v.summary.ovr})` : ""}`; }),
      ...t.dpids.map((dpid) => esc(LG.pickName(L, dpid))),
    ].join(", ") || "nothing";
    const go = on(async (el) => {
      el.disabled = true; el.textContent = "Proposing…";
      try {
        const r = await F.proposeTrade(L, idea.teams);
        st.flash = r && r.accepted ? `Trade accepted. You can undo it from the Manager tab or the game's notification.` : `Rejected: ${(r && r.message) || "the AI changed its mind"}`;
      } catch (e) { st.flash = e.message; }
      st.trades.ideas = null; invalidate(); render();
      setTimeout(() => { st.flash = ""; render(); }, 6000);
    });
    const open = on(async () => { await B.call("main", "createTrade", idea.teams); location.assign(`/l/${lidNow()}/trade`); });
    const im = idea.impact || LG.tradeImpact(L, idea.teams);
    const needed = F.isNecessary(L, im, settings);
    const askNames = P.protectedNames(L, idea.teams[0].pids, idea.teams[0].dpids, "ask");
    const neverNames = P.protectedNames(L, idea.teams[0].pids, idea.teams[0].dpids, "never");
    const rb = idea.ruleBreak !== undefined ? idea.ruleBreak : P.contractRuleBreak(L, settings, { payrollDelta: P.tradePayrollDelta(L, idea.teams) });
    const warns = [
      neverNames.length ? `Includes Never-trade: ${neverNames.join(", ")}` : "",
      askNames.length ? `Includes Ask-first: ${askNames.join(", ")}` : "",
      rb ? `Breaks your rules: ${rb}` : "",
      idea.blocked ? `Manager won't make this automatically: ${idea.blocked}` : "",
      idea.rosterAfter > L.capInfo.maxRoster ? `Leaves your roster at ${idea.rosterAfter}/${L.capInfo.maxRoster}: you'd have to release ${idea.rosterAfter - L.capInfo.maxRoster} player${idea.rosterAfter - L.capInfo.maxRoster === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    if (neverNames.length) propose = false;
    return `<div class="card"><div class="hd"><b>${esc(d.team)}</b><span class="chip ${im.score > 0 ? "gem" : "over"}" title="Change in BBGM team rating (predicted margin of victory)">${num(im.now)} now · ${num(im.future)} future</span></div>
      <div class="why">${esc(F.impactText(L, im))} · long-term value ${num(im.value, 0)}${needed ? " · <b>improves your team</b>" : ""}</div>
      <div class="sub">You give: ${side(idea.teams[0])}</div>
      <div class="sub">You get: ${side(idea.teams[1])}</div>
      ${warns.map((w) => `<div class="warn-line">⚠ ${esc(w)}</div>`).join("")}
      ${propose ? `<div class="actions"><button class="pri sm" data-h="${go}">Propose</button><button class="sm" data-h="${open}">Open in trade screen</button></div>` : ""}</div>`;
  }
  function tradesBody() {
    const wait = needL();
    if (wait) return wait;
    const L = st.L;
    let html = "";
    if (st.current) {
      const c = st.current;
      const im = LG.tradeImpact(L, c.teams);
      const verdict = F.isNecessary(L, im, settings) ? ["Improves your team", "good"] : im.score < -0.3 ? ["Makes your team worse", "bad"] : ["Marginal", "warn"];
      html += `<div class="h">Deal on the trade screen</div><div class="card"><div class="hd"><b>${esc(c.desc.team)}</b><span class="chip ${verdict[1] === "good" ? "gem" : verdict[1] === "bad" ? "over" : ""}">${verdict[0]}</span></div>
        <div class="why">${esc(F.impactText(L, im))}</div>
        <table>${[...c.get, ...c.give].map((r) => `<tr><td>${r.value >= 0 ? "Get" : "Give"} ${r.pid != null ? plink(r.pid, r.label) : esc(r.label)}</td><td class="${r.value >= 0 ? "good" : "bad"}">${num(r.value)}</td></tr>`).join("")}</table>
        <div class="why">Per-asset value = forecast on-court value for your ${esc(L.strategy.label)} strategy, minus salary.</div></div>`;
    }
    const refresh = on(() => { st.trades.ideas = null; invalidate(); refreshTrades(); });
    html += `<div class="h">Suggested trades <span class="mut">(${esc(L.strategy.label)})</span></div>`;
    if (st.trades.busy) html += `<div class="msg">${esc(st.trades.msg || "Searching…")}</div>`;
    else if (!st.trades.ideas) html += `<div class="msg">Not searched yet.</div>`;
    else if (!st.trades.ideas.length) html += `<div class="msg">${esc(st.trades.note || "No trade improves your team right now.")}</div>`;
    else html += st.trades.ideas.map((i) => tradeCard(L, i)).join("");
    html += `<div class="actions"><button data-h="${refresh}" ${st.trades.busy ? "disabled" : ""}>Search again</button></div>
      <div class="why">Each offer is one an AI team would actually accept (built by BBGM's trade AI), ranked by a multi-season score for your ${esc(L.strategy.label)} strategy (team rating now and over the next two seasons, value, picks, young talent, aging, payroll and roster fit).${settings.tradeOnGameDay ? " Refreshes every game day." : ""}</div>`;
    return html;
  }

  // ======================================================================
  // Targets tab
  // ======================================================================
  function targetsBody() {
    const wait = needL();
    if (wait) return wait;
    const L = st.L;
    let html = "";
    if (st.offer) {
      const o = st.offer;
      html += `<div class="h">Offer</div><div class="banner">${esc((o.message || "").replace(/<[^>]+>/g, ""))}</div>`;
      if (o.teams && o.desc) html += tradeCard(L, o);
      const clr = on(() => { st.offer = null; render(); });
      html += `<div class="actions"><button class="sm" data-h="${clr}">Back to targets</button></div>`;
      return html;
    }
    const list = F.targets(L, 12);
    html += `<div class="h">Players worth adding <span class="mut">(${esc(L.strategy.label)})</span></div>`;
    html += list.length ? `<table><tr><th>Player</th><th>Age</th><th>OVR</th><th>Peak</th><th>Value</th><th></th></tr>${list.map((t) => {
      const b = on(async (el) => {
        el.disabled = true; el.textContent = "…";
        try { st.offer = await F.buildOfferFor(L, t.pid); } catch (e) { st.flash = e.message; }
        render();
      });
      return `<tr><td>${plink(t.pid, t.name)}<small>${esc(t.team)} · ${F.fmtMoney(t.contract.amount)} thru ${t.contract.exp}${t.gem >= 7 ? " · gem" : ""}</small></td><td>${t.s.age}</td><td>${t.s.ovr}</td><td>${t.s.peakOvr}</td><td>${t.surplus.toFixed(0)}</td>
        <td><button class="sm" data-h="${b}" title="Ask the AI team what it wants for this player">Ask</button></td></tr>`;
    }).join("")}</table>` : `<div class="msg">No standout targets.</div>`;
    html += `<div class="why">"Ask" puts the player in a trade and uses BBGM's "What would make this work?" to see what the other team wants, then shows whether that's a good deal for you.</div>`;
    return html;
  }

  // ======================================================================
  // Free agents tab
  // ======================================================================
  function faBody() {
    const wait = needL();
    if (wait) return wait;
    const L = st.L;
    const list = F.freeAgents(L);
    const c = L.capInfo;
    let html = `<div class="banner">Roster ${c.rosterSize}/${c.maxRoster} · Payroll ${F.fmtMoney(c.payroll)} / cap ${F.fmtMoney(c.cap || 0)} (${esc(c.type)})</div>`;
    if (!list.length) return html + `<div class="msg">No free agents available.</div>`;
    html += `<table><tr><th>Player</th><th>Age</th><th>OVR</th><th>Peak</th><th>Ask</th><th>Value</th><th></th></tr>${list.slice(0, 15).map((f) => {
      const b = on(async (el) => {
        el.disabled = true;
        try { await F.sign(L, f); st.flash = `Signed ${f.name}.`; } catch (e) { st.flash = e.message; }
        invalidate(); render();
        setTimeout(() => { st.flash = ""; render(); }, 5000);
      });
      return `<tr><td>${plink(f.pid, f.name)}<small>${esc(f.s.pos || "")}${f.gem >= 7 ? " · gem" : ""}${f.why ? ` · ${esc(f.why)}` : ""}</small></td><td>${f.s.age}</td><td>${f.s.ovr}</td><td>${f.s.peakOvr}</td>
        <td>${F.fmtMoney(f.ask)}<small>thru ${f.exp}</small></td><td class="${f.surplus > 0 ? "good" : "bad"}">${f.surplus.toFixed(0)}</td>
        <td>${f.canSign ? `<button class="sm" data-h="${b}">Sign</button>` : ""}</td></tr>`;
    }).join("")}</table><div class="why">Value = forecast on-court value minus the asking salary, for your ${esc(L.strategy.label)} strategy. Asking prices come from each player's mood toward your team.</div>`;
    return html;
  }

  // ======================================================================
  // Draft tab
  // ======================================================================
  function draftBody() {
    const wait = needL();
    if (wait) return wait;
    const L = st.L;
    const board = F.draftBoard(L);
    let html = "";
    const p = st.poll || {};
    if (p.phase === 5) {
      if (p.onClock === p.userTid) {
        const best = board[0];
        const b = on(async () => { await F.draftStep(L, settings, { act: true }); invalidate(); render(); });
        html += `<div class="banner acc"><b>You're on the clock.</b> Best available: ${best ? plink(best.pid, best.name) : "—"}${best ? ` (peak ${best.s.peakOvr}, ceiling ${best.s.ceiling})` : ""}
          ${settings.draftMode === "auto" ? "<div class='why'>Auto Drafter will pick automatically.</div>" : `<div class="actions"><button class="pri" data-h="${b}">Draft ${esc(best ? best.name : "")}</button></div>`}</div>`;
      } else html += `<div class="banner">Draft in progress. ${settings.draftMode === "auto" ? "Auto Drafter will pick for you when you're on the clock." : "You'll get a prompt when you're on the clock."}${settings.draftTradeUp ? " Trade-up is on." : ""}</div>`;
    } else html += `<div class="banner">Draft board for the ${L.draftSeason} class (your scouting view). Auto Drafter acts during the draft phase.</div>`;
    if (board.length) {
      const counts = F.tierCounts(board);
      html += `<div class="banner">Tier 1 has <b>${counts[1]}</b> similar prospect${counts[1] === 1 ? "" : "s"} left${counts[1] >= 3 ? ", so you may be able to trade down and still get one" : ""}. Ranking uses your <b>${esc(L.risk)}</b> risk preference.</div>`;
      if (p.phase === 5 && p.onClock === p.userTid) {
        if (st.tradeDown && st.tradeDown.key === st.pollKey) {
          const ideas = st.tradeDown.ideas;
          html += ideas.length ? ideas.map((d) => {
            const go = on(async (el) => { el.disabled = true; try { const r = await F.proposeTrade(L, d.teams, `trade down ${d.slotsDown} spots`); st.flash = r && r.accepted ? "Traded down." : `Rejected: ${(r && r.message) || ""}`; } catch (e) { st.flash = e.message; } st.tradeDown = null; invalidate(); render(); });
            return `<div class="card"><div class="hd"><b>Trade down ${d.slotsDown} spot${d.slotsDown === 1 ? "" : "s"} with ${esc(d.team)}</b><span class="chip gem">${num(d.gain, 0)} value</span></div>
              <div class="why">You'd still likely get a tier-${d.expected.tier} prospect (for example ${plink(d.expected.pid, d.expected.name)}) and gain ${esc(d.extraGet.join(", ") || "nothing extra")}${d.extraGive.length ? `, giving up ${esc(d.extraGive.join(", "))}` : ""}.</div>
              <div class="actions"><button class="sm pri" data-h="${go}">Propose</button></div></div>`;
          }).join("") : `<div class="msg">No trade-down offer beats taking the best player now.</div>`;
        } else if (counts[1] >= 3) {
          const chk = on(async (el) => { el.disabled = true; el.textContent = "Asking teams…"; try { st.tradeDown = { key: st.pollKey, ideas: await F.tradeDownIdeas(L, settings) }; } catch (e) { st.flash = e.message; } render(); });
          html += `<div class="actions"><button class="sm" data-h="${chk}">Check trade-down offers</button></div>`;
        }
      }
      html += `<table><tr><th>#</th><th>Tier</th><th>Prospect</th><th>Age</th><th>OVR</th><th>Peak</th><th>Ceil</th><th title="BBGM's own ranking">BBGM</th></tr>${board.slice(0, 20).map((b, i) =>
        `<tr${i > 0 && board[i - 1].tier !== b.tier ? ' style="border-top:2px solid var(--line)"' : ""}><td>${b.ourRank}</td><td><span class="chip">${b.tier}</span></td><td>${plink(b.pid, b.name)}${b.gem >= 7 ? ` <span class="chip gem">gem</span>` : ""}</td><td>${b.s.age}</td><td>${b.s.ovr}</td><td>${b.s.peakOvr}</td><td>${b.s.ceiling}</td><td class="${b.marketRank - b.ourRank >= 5 ? "good" : ""}">${b.marketRank}</td></tr>`).join("")}</table>
        <div class="why">Tiers group prospects whose forecasts overlap with the best player in the tier; within a tier, the difference is mostly noise.</div>`;
    } else html += `<div class="msg">No prospects yet.</div>`;
    return html;
  }

  // ======================================================================
  // Manager tab (suggestions, autopilot, log)
  // ======================================================================
  async function refreshPending() {
    try {
      const L = await getL();
      const td = await F.tradeDue(lidNow(), L, settings);
      st.pending = await F.managerPlan(L, settings, { lid: lidNow(), includeTrades: settings.manage.trades && td.due && td });
      st.pendingKey = progressKey(st.poll);
      if (td.due) td.mark();
    } catch (e) { st.flash = e.message; }
    render();
  }
  const exHtml = (ex) => !ex ? "" : `<details class="ex"><summary>Why</summary><div>${esc(ex.why || "")}${ex.strategy ? ` <span class="chip">${esc(ex.strategy)}</span>` : ""} <span class="mut">(${esc(ex.basis || "projected")})</span></div>
    ${ex.benefits && ex.benefits.length ? `<div><b>Benefits</b><ul>${ex.benefits.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}
    ${ex.costs && ex.costs.length ? `<div><b>Costs</b><ul>${ex.costs.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}</details>`;

  function summaryHtml(sm) {
    if (!sm) return "";
    const pct = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
    const m = (x) => (x == null ? "–" : F.fmtMoney(x));
    const t = sm.trades;
    return `<details class="card" ${st.ap.justFinished ? "open" : ""}><summary><b>Last Autopilot run</b> · ${sm.from}${sm.to !== sm.from ? `–${sm.to}` : ""} · ${sm.seasons.length} season${sm.seasons.length === 1 ? "" : "s"} with games</summary>
      <table class="sum">
        <tr><td>Championships</td><td><b>${sm.titles}</b></td></tr>
        <tr><td>Playoff appearances</td><td>${sm.playoffApps} of ${sm.seasons.length}</td></tr>
        <tr><td>Regular-season win %</td><td>${pct(sm.winPct)}</td></tr>
        <tr><td>Salary spent per win</td><td>${m(sm.payrollPerWin)} <small class="mut">(league average ${m(sm.leaguePayrollPerWin)}, for reference)</small></td></tr>
        <tr><td>Trades</td><td>${t.count}${t.withNumbers ? ` <small class="mut">(projected at the time: ${t.projectedNow >= 0 ? "+" : ""}${t.projectedNow.toFixed(1)} rating now, ${t.projectedFuture >= 0 ? "+" : ""}${t.projectedFuture.toFixed(1)} future, summed)</small>` : ""}</td></tr>
        <tr><td>Other moves</td><td>${sm.moves.signings} signed, ${sm.moves.resignings} re-signed, ${sm.moves.letWalk} let go, ${sm.moves.releases} released${sm.moves.errors ? `, <span class="bad">${sm.moves.errors} failed</span>` : ""}</td></tr>
        <tr><td>Roster turnover</td><td>${sm.turnover} of ${sm.rosterStartSize} starting players gone</td></tr>
      </table>
      ${sm.drafts.length ? `<details><summary>Draft picks (${sm.drafts.length})</summary><div class="ex"><ul>${sm.drafts.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div></details>` : ""}
      ${sm.strategyChanges.length ? `<details><summary>Strategy changes (${sm.strategyChanges.length})</summary><div class="ex"><ul>${sm.strategyChanges.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div></details>` : ""}
      ${sm.seasons.length ? `<details><summary>Season by season</summary><table class="sum"><tr><th>Season</th><th>Record</th><th>Playoffs</th><th>Strategy</th></tr>${sm.seasons.map((x) =>
        `<tr><td>${x.season}</td><td>${x.won}-${x.lost}${x.tied ? `-${x.tied}` : ""}</td><td class="${x.champion ? "good" : ""}">${esc(x.playoffs)}</td><td>${esc(x.strategy || "")}</td></tr>`).join("")}</table></details>` : ""}
      <div class="why">Observed results from BBGM's records. League averages are context only; this isn't a comparison against what would have happened without Autopilot.</div>
    </details>`;
  }

  function managerBody() {
    let html = "";
    const L = st.L;
    const waiting = (st.pending || []).filter((a) => a.approval).length;
    // ---- Dashboard: Strategy, Seasons, Approvals, Run ----
    const stratOpts = [["auto", "Auto"], ...SG.ORDER.map((k) => [k, SG.STRATEGIES[k].label])];
    const curMode = SG.manualChoice(settings.teamMode) || "auto";
    const stratNow = L && L.strategy ? L.strategy : null;
    html += `<div class="card"><div class="dash">
      <label>Strategy<select data-set="teamMode" title="Auto picks a strategy from your roster, projections, cap and picks, and re-checks it at the start of the season, mid-season and in the offseason">${stratOpts.map(([k, l]) => `<option value="${k}"${k === curMode ? " selected" : ""}>${l}${k === "auto" && stratNow && stratNow.auto ? ` (${esc(stratNow.label)})` : ""}</option>`).join("")}</select></label>
      ${settings.features.autopilot ? `<label>Seasons<select data-set="apSeasons" title="How many seasons Autopilot plays before it stops (1–100)"${st.ap.running ? " disabled" : ""}>${Array.from({ length: 100 }, (_, i) => i + 1).map((n) => `<option value="${n}"${n === settings.apSeasons ? " selected" : ""}>${n}</option>`).join("")}</select></label>` : "<span></span>"}
      <div class="full">${stratNow ? `<details class="ex"><summary>${esc(stratNow.label)}: ${esc(stratNow.goal)}</summary><ul>${(stratNow.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : ""}</div>
      <span class="mut">${waiting ? `<span class="warn">${waiting} move${waiting === 1 ? "" : "s"} waiting for your OK</span>` : "No approvals waiting"}</span>
      ${settings.features.autopilot ? `<span style="text-align:right">${st.ap.running ? `<button data-h="${on(() => stopAutopilot())}">Stop</button>` : `<button class="pri" data-h="${on(() => startAutopilot())}">Run Autopilot</button>`}</span>` : "<span></span>"}
    </div>
    ${settings.features.autopilot && st.ap.running ? `<div class="banner acc">${esc(st.ap.status || "Running…")}</div>` : st.ap.status ? `<div class="why">${esc(st.ap.status)}</div>` : ""}
    <details><summary>Advanced settings</summary><div class="adv">
      <label>Manager mode<select data-set="managerMode"><option value="suggest"${settings.managerMode !== "auto" ? " selected" : ""}>Suggest (you approve)</option><option value="auto"${settings.managerMode === "auto" ? " selected" : ""}>Fully automatic</option></select></label>
      ${settings.features.autopilot ? `<label>Autopilot step<select data-set="apStep"><option value="day"${settings.apStep !== "week" ? " selected" : ""}>A day</option><option value="week"${settings.apStep === "week" ? " selected" : ""}>A week</option></select></label>
      <label>Stop at checkpoint<select data-set="apStopAt">${[["never", "Never"], ["playoffs", "Playoffs"], ["draft", "Draft"], ["freeAgency", "Free agency"]].map(([k, l]) => `<option value="${k}"${settings.apStopAt === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
      ${settings.features.autopilot ? `<label title="Fully automatic: Autopilot also makes moves involving Ask-first players or picks, and moves that break your contract rules. Never-trade players are still never traded, cut or let go.">Moves that need your OK<select data-set="apAutoApprove"><option value="true"${settings.apAutoApprove !== false && settings.apAutoApprove !== "false" ? " selected" : ""}>Autopilot makes them</option><option value="false"${settings.apAutoApprove === false || settings.apAutoApprove === "false" ? " selected" : ""}>Pause for me</option></select></label>` : ""}
      <label title="Minimum trade score in team-rating points (1 point ≈ 2.7 wins over 82 games)">Minimum trade improvement<input type="number" data-set="tradeMinMov" min="0.1" max="10" step="0.1" value="${settings.tradeMinMov ?? 0.5}"></label>
      <label title="Game days before a newly acquired player can be traded again. Trades scoring 3× the minimum are allowed anyway; players are never sent back to the team they came from during the cooldown.">Trade cooldown (game days)<input type="number" data-set="tradeCooldownDays" min="0" max="200" value="${settings.tradeCooldownDays ?? 30}"></label>
      <label title="Searching is slow; raise this if sims feel sluggish">Search for trades every N game days<input type="number" data-set="tradeEveryDays" min="1" max="82" value="${settings.tradeEveryDays || 1}"></label>
    </div></details></div>`;

    if (settings.features.manager || settings.features.autopilot) {
      const refresh = on(() => { st.pending = null; invalidate(); render(); refreshPending(); });
      html += `<div class="h">${st.ap.running ? (settings.apAutoApprove !== false && settings.apAutoApprove !== "false" ? "Waiting for your OK (Never trade players only)" : "Waiting for your OK") : settings.managerMode === "auto" ? "Automatic management is on" : "Suggested moves"}</div>`;
      if (st.ap.running) html += `<div class="why">Autopilot makes the other moves itself before every step and logs them below. Only moves that need your OK (Ask-first players or picks, or moves that break your contract rules) wait here.</div>`;
      else if (settings.managerMode === "auto") html += `<div class="why">Runs after every game day and phase change. Everything it does is logged below with its reasons.</div>`;
      if (!st.pending) html += needL() || `<div class="msg">Planning…</div>`;
      else if (!st.pending.length) html += `<div class="msg">Nothing to change right now.</div>`;
      else {
        const planKey = st.pendingKey;
        const check = async () => { const p = await B.poll(); if (p.gameSim || p.drafting) return "BBGM is simulating; try again when it stops"; if (planKey && progressKey(p) !== planKey) return "the game moved on since this plan was made; press Re-plan"; return null; };
        const after = async (res) => { const bad = res.find((r) => r.skipped && r.error !== "already done"); if (bad) st.flash = `Not done: ${bad.error}`; invalidate(); st.log = await S.getLog(); refreshPending(); };
        const all = on(async (el) => { el.disabled = true; const acts = st.pending; st.pending = null; render(); await after(await F.runActions(acts, { stateKey: planKey, check })); });
        html += st.pending.map((a, i) => {
          const one = on(async (el) => { el.disabled = true; const [x] = st.pending.splice(i, 1); render(); await after(await F.runActions([x], { stateKey: planKey, check })); });
          const skip = on(() => { st.pending.splice(i, 1); render(); });
          return `<div class="card"><div class="hd"><span><span class="chip">${esc(a.kind)}</span> ${linkText(a.text, a.pids)}${a.approval ? `<div class="warn-line">Needs your OK: ${esc(a.why || "protected asset")}</div>` : ""}</span></div>
            ${exHtml(a.ex)}<div class="actions"><button class="sm pri" data-h="${one}">Do it</button><button class="sm" data-h="${skip}">Skip</button></div></div>`;
        }).join("") + (st.ap.running ? "" : `<div class="actions"><button class="pri" data-h="${all}">Do all ${st.pending.length}</button></div>`);
      }
      html += `<div class="actions"><button class="sm" data-h="${refresh}">Re-plan</button></div>`;
    }
    if (st.apSummary) html += summaryHtml(st.apSummary);
    html += `<div class="h">Activity log</div>`;
    const clear = on(async () => { await S.clearLog(); st.log = []; render(); });
    html += st.log.length ? `<div class="log">${st.log.slice(0, 30).map((e) => {
      const u = e.undoKey != null && !e.undone ? on(async (el) => { el.disabled = true; try { await B.call("undoLog", "undo", e.undoKey); await S.markUndone(e.t); st.log = await S.getLog(); st.flash = "Undone."; } catch (err) { st.flash = `Can't undo: ${err.message}`; } invalidate(); render(); setTimeout(() => { st.flash = ""; render(); }, 6000); }) : null;
      return `<div><span class="${e.kind === "error" ? "bad" : ""}">${linkText(e.text, e.pids)}${e.undone ? ` <small class="mut">(undone)</small>` : ""}${exHtml(e.ex)}</span><span>${u ? `<button class="sm" data-h="${u}">Undo</button> ` : ""}<time>${new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></span></div>`;
    }).join("")}</div><div class="actions"><button class="sm" data-h="${clear}">Clear log</button></div>` : `<div class="msg">No actions yet.</div>`;
    return html;
  }

  // ======================================================================
  // Needs tab (team needs scanner)
  // ======================================================================
  function needsBody() {
    const wait = needL();
    if (wait) return wait;
    const L = st.L;
    const N = P.teamNeeds(L, settings, F);
    let html = `<div class="h">Biggest weaknesses</div>`;
    if (!N.weaknesses.length) html += `<div class="msg">No clear weaknesses: you're at or above league average everywhere.</div>`;
    for (const w of N.weaknesses) {
      html += `<div class="card"><div class="hd"><b>${esc(w.label)}</b><span class="chip over">${ordinal(w.rank)} of ${w.of}</span></div>
        <div class="why">Your rotation: ${w.value.toFixed(1)} vs league average ${w.mean.toFixed(1)}${w.cat ? ` (BBGM skill tag: ${esc(w.cat.skill)})` : ""}</div>`;
      if (!w.fixes.length) html += `<div class="msg">No realistic fix found right now.</div>`;
      for (const f of w.fixes) {
        const label = f.kind === "trade" ? `Trade target · ${esc(f.team || "")}` : f.kind === "fa" ? `Free agent · asks ${F.fmtMoney(f.ask || 0)}` : "Draft prospect";
        let btn = "";
        if (f.kind === "trade") {
          const h = on(async (el) => { el.disabled = true; el.textContent = "…"; try { st.offer = await F.buildOfferFor(L, f.pid); st.tab = "targets"; } catch (e) { st.flash = e.message; } render(); });
          btn = `<button class="sm" data-h="${h}" title="Ask the AI team what it wants">Ask</button>`;
        } else if (f.kind === "fa") {
          const fa = F.freeAgents(L).find((x) => x.pid === f.pid);
          if (fa && fa.canSign) {
            const h = on(async (el) => { el.disabled = true; try { await F.sign(L, fa, `fills ${w.label.toLowerCase()}`); st.flash = `Signed ${fa.name}.`; } catch (e) { st.flash = e.message; } invalidate(); render(); });
            btn = `<button class="sm" data-h="${h}">Sign</button>`;
          }
        }
        html += `<div class="rows"><div><span>${plink(f.pid, f.name)} <small class="mut">${label}</small></span><span>+${f.gain.toFixed(1)} · OVR ${f.ovr} ${btn}</span></div></div>`;
      }
      html += `</div>`;
    }
    const stress = P.injuryStress(L, settings, F);
    if (stress.length) {
      html += `<div class="h">Injury stress test</div>`;
      html += stress.slice(0, 3).map((x) => `<div class="card"><div class="hd"><span>If ${plink(x.pid, x.name)} misses time <small class="mut">(${esc(x.why)})</small></span><span class="chip ${x.drop >= 2 ? "over" : ""}">${num(-x.drop)} MOV</span></div>
        <div class="why">About ${x.winsLost20.toFixed(1)} wins lost over a 20-game absence.${x.worst && x.worst.drop > 0 ? ` ${esc(x.worst.cat.label)} falls from ${ordinal(x.worst.from)} to ${ordinal(x.worst.to)}.` : ""}</div>
        ${x.backups.length ? x.backups.map((b) => `<div class="rows"><div><span>Backup: ${plink(b.pid, b.name)} <small class="mut">${b.kind === "fa" ? `free agent · asks ${F.fmtMoney(b.ask)}` : `trade · ${esc(b.team || "")} · ${F.fmtMoney(b.salary || 0)}`}</small></span><span>OVR ${b.ovr} · recovers ${b.recover.toFixed(1)}</span></div></div>`).join("") : `<div class="why">No affordable backup found that helps.</div>`}</div>`).join("");
    }
    html += `<div class="h">Full profile vs the league</div><table><tr><th>Area</th><th>Rank</th><th style="width:40%"></th></tr>${N.rows.map((r) => {
      const pctl = Math.max(4, Math.min(100, 100 * (1 - (r.rank - 1) / Math.max(1, r.of - 1))));
      return `<tr><td>${esc(r.label)}</td><td>${r.rank}/${r.of}</td><td><div class="bar ${r.z < -0.25 ? "weak" : ""}"><i style="width:${pctl}%"></i></div></td></tr>`;
    }).join("")}</table>
    <div class="why">Each area is a weighted average of the relevant BBGM ratings across your top 10 players, weighted like BBGM's team rating (starters count most). "+N" is how much the player would raise that area compared with your current level.${settings.respectFog ? " Other teams' players use the scouted ratings you can see." : ""}</div>`;
    return html;
  }

  // ======================================================================
  // Moneyball tab (value per dollar)
  // ======================================================================
  function moneyballBody() {
    const wait = needL();
    if (wait) return wait;
    const L = st.L;
    const A = MB.analyze(L, settings);
    const $ = (k) => F.fmtMoney(k);
    const askBtn = (give, getPid, tid) => on(async (el) => {
      el.disabled = true; el.textContent = "…";
      try {
        await B.call("main", "createTrade", [{ tid: L.snap.userTid, pids: give, dpids: [], pidsExcluded: [], dpidsExcluded: [] }, { tid, pids: [getPid], dpids: [], pidsExcluded: [], dpidsExcluded: [] }]);
        const r = await B.call("main", "tradeCounterOffer");
        const { teams } = await B.readTrade();
        st.offer = { message: r && r.message, teams, gain: teams ? LG.tradeGain(L, teams) : 0, desc: teams ? null : null };
        if (teams) st.offer.desc = { team: (L.teams.get(tid) || {}).region || "", give: [], get: [] };
        st.tab = "targets";
      } catch (e) { st.flash = e.message; }
      render();
    });
    const signBtn = (pid) => {
      const fa = F.freeAgents(L).find((x) => x.pid === pid);
      if (!fa || !fa.canSign) return "";
      const h = on(async (el) => { el.disabled = true; try { await F.sign(L, fa, "Moneyball value pick"); st.flash = `Signed ${fa.name}.`; } catch (e) { st.flash = e.message; } invalidate(); render(); });
      return `<button class="sm" data-h="${h}">Sign</button>`;
    };
    const me = A.me;
    let html = `<div class="banner">Your payroll buys <b>${me ? me.wins.toFixed(0) : "?"}</b> projected wins at <b>${me && isFinite(me.perWin) ? $(me.perWin) : "–"}</b> per win: <b>${me ? ordinal(me.rank) : "?"}</b> most efficient of ${A.teams.length}. Everything here is measured in BBGM's team rating (MOV): 1 point ≈ ${A.winsPerMov.toFixed(1)} wins a season.</div>`;

    html += `<div class="h">Moneyball swaps</div>`;
    html += A.swaps.length ? A.swaps.map((x) => `<div class="card"><div class="hd"><span>Replace ${plink(x.out.pid, x.out.name)} <small class="mut">${$(x.out.salary)}</small> with ${plink(x.inn.pid, x.inn.name)} <small class="mut">${x.inn.kind === "fa" ? "free agent" : esc(x.inn.team || "")} · ${$(x.inn.salary)}</small></span><span class="chip gem">${num(x.net)} MOV</span></div>
      <div class="why">${x.saves > 0 ? `Saves ${$(x.saves)} and ` : ""}adds ${num(x.net)} team rating (~${(x.net * A.winsPerMov).toFixed(1)} wins).</div>
      <div class="actions">${x.inn.kind === "fa" ? signBtn(x.inn.pid) : `<button class="sm" data-h="${askBtn([x.out.pid], x.inn.pid, L.byPid.get(x.inn.pid).p.tid)}">Ask about a swap</button>`}</div></div>`).join("")
      : `<div class="msg">No cheaper player clearly beats anyone on your roster right now.</div>`;

    html += `<div class="h">Best value per dollar available</div>`;
    html += A.available.length ? `<table><tr><th>Player</th><th>OVR</th><th>Salary</th><th title="Team rating added to your team">+MOV</th><th title="MOV added per $1M">/$1M</th><th></th></tr>${A.available.map((x) => `<tr><td>${plink(x.pid, x.name)}<small>${x.kind === "fa" ? "Free agent" : esc(x.team || "")} · age ${x.age}${x.futureOvr >= x.ovr + 3 ? ` · ${Math.round(x.futureOvr)} in 2 yrs` : ""}</small></td><td>${x.ovr}</td><td>${$(x.salary)}</td><td>${num(x.adds)}</td><td>${x.perM.toFixed(2)}</td>
      <td>${x.kind === "fa" ? signBtn(x.pid) : `<button class="sm" data-h="${askBtn([], x.pid, x.v.p.tid)}">Ask</button>`}</td></tr>`).join("")}</table>` : `<div class="msg">No one available adds enough to your rotation.</div>`;

    html += `<div class="h">Market inefficiencies</div><div class="why" style="margin-top:0">Where BBGM's AI valuation and the Scout model disagree. "Undervalued" groups are cheap to acquire relative to what they're worth to a team.</div>`;
    const traitRows = (list, cls) => list.map((t) => `<tr><td>${esc(t.label)} <small>${t.n} players</small></td><td class="${cls}">${t.gap >= 0 ? "+" : ""}${t.gap.toFixed(0)} pct pts</td></tr>`).join("");
    html += (A.undervalued.length || A.overvalued.length) ? `<table>${A.undervalued.length ? `<tr><th>Undervalued by the market</th><th></th></tr>${traitRows(A.undervalued, "good")}` : ""}${A.overvalued.length ? `<tr><th>Overvalued by the market</th><th></th></tr>${traitRows(A.overvalued, "bad")}` : ""}</table>` : `<div class="msg">The market is pricing players about right in this league.</div>`;

    html += `<div class="h">Age arbitrage</div>`;
    html += A.buy.length ? `<div class="sub"><b>Buy before the peak is priced in</b></div>${A.buy.map((x) => `<div class="rows"><div><span>${plink(x.pid, x.name)} <small class="mut">${esc(x.team || "")} · ${x.age}</small></span><span>${x.ovr} → ${x.later} in 2 yrs</span></div></div>`).join("")}` : "";
    html += A.sell.length ? `<div class="sub" style="margin-top:6px"><b>Sell before the decline shows</b></div>${A.sell.map((x) => `<div class="rows"><div><span>${plink(x.pid, x.name)} <small class="mut">${x.age}</small></span><span>${x.ovr} → ${x.later} in 2 yrs</span></div></div>`).join("")}` : "";
    if (!A.buy.length && !A.sell.length) html += `<div class="msg">No clear age-curve opportunities right now.</div>`;

    html += `<div class="h">Your roster by value per dollar</div><table><tr><th>Player</th><th>Salary</th><th title="Team rating lost without this player">Adds</th><th title="Salary per point of team rating">$/MOV</th></tr>${A.roster.map((r) => `<tr><td>${plink(r.pid, r.name)}<small>${r.age} · OVR ${r.ovr}${r.tag ? ` · <span class="${r.tag === "Bargain" ? "good" : "bad"}">${r.tag}</span>` : ""}</small></td><td>${$(r.salary)}</td><td>${num(r.adds)}</td><td>${isFinite(r.perPoint) ? $(r.perPoint) : "–"}</td></tr>`).join("")}</table>`;

    html += `<div class="h">Payroll efficiency, league-wide</div><table><tr><th>#</th><th>Team</th><th>Payroll</th><th>Proj. W</th><th>$/win</th></tr>${A.teams.map((t) => `<tr${t.tid === L.snap.userTid ? ' style="font-weight:700"' : ""}><td>${t.rank}</td><td>${esc(t.abbrev)}</td><td>${$(t.payroll)}</td><td>${t.wins.toFixed(0)}</td><td>${isFinite(t.perWin) ? $(t.perWin) : "–"}</td></tr>`).join("")}</table>
      <div class="why">Projected wins come from each roster's team rating today. Value-per-dollar uses current salary (asking price for free agents). Protected players are never suggested as swaps.</div>`;
    return html;
  }

  // ======================================================================
  // Plan tab (next three seasons + protections)
  // ======================================================================
  function planBody() {
    const wait = needL();
    if (wait) return wait;
    const L = st.L;
    const T = P.threeSeasons(L);
    const money = (k) => F.fmtMoney(k);
    let html = T.flags.length ? T.flags.map((f) => `<div class="flag ${f.level}">${linkText(f.text, f.pids)}</div>`).join("") : "";
    html += `<div class="h">Next three seasons</div><table><tr><th></th>${T.cols.map((c) => `<th>${c.season}</th>`).join("")}</tr>
      <tr><td>Team rating (MOV)</td>${T.cols.map((c) => `<td class="${c.mov >= 0 ? "good" : "bad"}">${num(c.mov)}</td>`).join("")}</tr>
      <tr><td>League rank</td>${T.cols.map((c) => `<td>${ordinal(c.rank)}</td>`).join("")}</tr>
      <tr><td>Payroll committed</td>${T.cols.map((c) => `<td>${money(c.payroll)}</td>`).join("")}</tr>
      <tr><td>Cap space</td>${T.cols.map((c) => `<td class="${c.space < 0 ? "bad" : ""}">${money(c.space)}</td>`).join("")}</tr>
      <tr><td>Expiring after season</td>${T.cols.map((c) => `<td>${c.expiring.length}</td>`).join("")}</tr>
      <tr><td>Your picks</td>${T.cols.map((c) => `<td>${c.picks.map((d) => (d.round === 1 ? "1st" : "2nd")).join(", ") || "–"}</td>`).join("")}</tr></table>
      <div class="why">Projections keep today's roster and use each player's forecast. Rank compares with every team's current roster projected the same way.</div>`;
    html += `<div class="h">Roster outlook and protection</div><table><tr><th>Player</th>${T.cols.map((c) => `<th>${String(c.season).slice(2)}</th>`).join("")}<th>Thru</th><th></th></tr>
      ${T.roster.map((v) => `<tr><td>${plink(v.p.pid, v.summary.name)}<small>${v.summary.age} · ${esc(v.summary.pos || "")}</small></td>
        ${T.cols.map((c) => `<td>${Math.round(LG.ovrAt(L, v.p.pid, c.season - L.snap.season))}</td>`).join("")}
        <td>${v.p.contract ? v.p.contract.exp : ""}</td><td>${protectSelect("player", v.p.pid)}</td></tr>`).join("")}</table>`;
    const picks = L.snap.draftPicks.filter((d) => d.tid === L.snap.userTid).sort((a, b) => a.season - b.season || a.round - b.round);
    html += `<div class="h">Your draft picks</div>${picks.length ? `<table>${picks.map((d) => `<tr><td>${esc(LG.pickName(L, d.dpid))}</td><td>${num(L.pickValue(d), 0)} value</td><td>${protectSelect("pick", d.dpid)}</td></tr>`).join("")}</table>` : `<div class="msg">No picks.</div>`}
      <div class="why"><b>Never trade</b>: automation never trades, cuts or lets this asset go. <b>Ask first</b>: automation suggests moves involving it but always waits for your OK, even in automatic mode and Autopilot. Contract-length and cap-reserve limits are in Features → Auto Team Management.</div>`;
    return html;
  }
  const ordinal = (n) => { const t = n % 100; if (t >= 11 && t <= 13) return `${n}th`; return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`; };

  // ======================================================================
  // Realism tab (God Mode / league setting suggestions over the years)
  // ======================================================================
  async function refreshRealism(L) {
    if (!settings.features.realism || !L) return;
    try {
      const hist = await R.record(lidNow(), L);
      st.realism = { key: st.LKey, ...R.advise(L, hist) };
    } catch (e) { st.realism = { error: e.message }; }
  }
  function realismBody() {
    const wait = needL();
    if (wait) return wait;
    if (!st.realism || st.realism.key !== st.LKey) { refreshRealism(st.L).then(render); return `<div class="msg">Checking the league…</div>`; }
    if (st.realism.error) return `<div class="msg">${esc(st.realism.error)}</div>`;
    const { suggestions, rows, now } = st.realism;
    const open = on(() => goTo(`/l/${lidNow()}/settings`));
    let html = `<div class="banner">These are suggestions only; BBGM Scout never changes your league settings. Most of them need God Mode (Tools → God Mode), then <a class="pl" href="/l/${lidNow()}/settings">League Settings</a>.</div>`;
    html += `<div class="h">Suggested tweaks</div>`;
    html += suggestions.length ? suggestions.map((sg) => `<div class="card"><div class="hd"><b>${esc(sg.title)}</b><span class="chip ${sg.severity === "high" ? "over" : ""}">${esc(sg.severity)}</span></div>
      <div class="why">${esc(sg.why)}</div>
      <table>${sg.changes.map((c) => `<tr><td>${esc(c.setting.join(" → "))}</td><td class="mut" style="white-space:nowrap">${c.current !== "" && c.current != null ? `${esc(String(c.current))} →` : "→"}</td><td><b>${esc(String(c.suggest))}</b></td></tr>`).join("")}</table></div>`).join("")
      : `<div class="msg">The league looks realistic right now. Check back as the seasons go by.</div>`;
    html += `<div class="actions"><button class="sm" data-h="${open}">Open league settings</button></div>`;
    const hist = [...rows.slice(-6)];
    if (!hist.length || hist[hist.length - 1].season !== now.season) hist.push({ ...now, partial: true });
    const f = (x, d = 1) => (x == null ? "–" : x.toFixed(d));
    html += `<div class="h">League over the years</div><table><tr><th>Season</th><th title="Players with 70+ OVR per team">Stars</th><th title="Spread of team strength (MOV)">Parity</th><th title="Median payroll ÷ cap">Payroll</th><th title="Share of shots that are threes">3PA</th><th>PPG</th></tr>
      ${hist.map((r) => `<tr><td>${r.season}${r.partial ? "*" : ""}</td><td>${f(r.stars70PerTeam, 2)}</td><td>${f(r.parity)}</td><td>${r.payrollRatio == null ? "–" : Math.round(r.payrollRatio * 100) + "%"}</td><td>${r.tpaRate == null ? "–" : Math.round(r.tpaRate * 100) + "%"}</td><td>${f(r.ppg)}</td></tr>`).join("")}</table>
      <div class="why">* season in progress. Recorded on this device each season the league is open.</div>`;
    return html;
  }

  // ======================================================================
  // Autopilot loop
  // ======================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitIdle(timeoutMs = 20 * 60 * 1000) {
    const t0 = Date.now();
    let errs = 0;
    for (;;) {
      let p;
      try { p = await B.poll(); errs = 0; } catch (e) {
        // BBGM's worker can be busy for a moment (e.g. right after Stop); retry a few times before giving up.
        if (++errs >= 8) throw e;
        await sleep(1000);
        continue;
      }
      if (!p.gameSim && !p.drafting) return p;
      if (Date.now() - t0 > timeoutMs) throw new Error("BBGM is taking too long");
      if (st.ap.stopReq) return p;
      await sleep(800);
    }
  }
  // BBGM asks "Are you sure you want to proceed to free agency while N of your players remain unsigned?"
  // when re-signing isn't finished. While Autopilot runs fully automatically it answers that prompt, since it
  // has already decided every player it can; any other BBGM dialog is left for you and reported.
  function answerBBGMDialogs() {
    const modal = document.querySelector(".modal.show");
    if (!modal) return null;
    const text = modal.innerText || "";
    const auto = settings.apAutoApprove !== false && settings.apAutoApprove !== "false";
    if (auto && /proceed to free agency/i.test(text)) {
      const ok = [...modal.querySelectorAll("button")].find((b) => /^\s*Proceed\s*$/i.test(b.textContent));
      if (ok) { ok.click(); S.addLog({ kind: "letwalk", text: "Answered BBGM's prompt: proceeded to free agency (players still unsigned became free agents)" }); return "answered"; }
    }
    return text.slice(0, 120);
  }
  /**
   * Handles the steps BBGM would otherwise stop and ask you about (BBGM's own Auto Play handles them too):
   *  - expansion vote: votes yes; relocation vote: votes no (the league still decides by its vote)
   *  - expansion draft protection: protects Never-trade players first, then Ask-first, then the most valuable
   *    for your strategy, up to the league's limit; then starts the expansion draft
   * Returns true if it did something (the loop re-reads the game afterwards).
   */
  async function handleLeagueEvents(poll, L) {
    if (poll.autoExpand) {
      st.ap.status = "Voting on league expansion…"; render();
      await B.call("main", "expandVote", { override: false, userVote: true });
      await S.addLog({ kind: "league", text: "Voted yes on the proposed league expansion (the league decides by vote)" });
      return true;
    }
    if (poll.autoRelocate) {
      st.ap.status = "Voting on team relocation…"; render();
      await B.call("main", "relocateVote", { override: false, realign: poll.relocRealign, rebrandTeam: poll.relocRebrand, userVote: false });
      await S.addLog({ kind: "league", text: "Voted no on the proposed team relocation (the league decides by vote)" });
      return true;
    }
    if (poll.phase === -2 && poll.exp === "protection") {
      st.ap.status = "Protecting players for the expansion draft…"; render();
      const info = await B.expansionInfo();
      const rank = (pid) => { const lv = P.playerLevel(pid); const v = L.byPid.get(pid); return [lv === "never" ? 0 : lv === "ask" ? 1 : 2, -(v ? v.talent : 0)]; };
      const order = [...info.pids].sort((a, b) => { const [ra, va] = rank(a), [rb, vb] = rank(b); return ra - rb || va - vb; });
      const keep = info.num > 0 ? order.slice(0, info.num) : order;
      await B.call("main", "updateProtectedPlayers", { tid: info.tid, protectedPids: keep });
      await B.call("main", "startExpansionDraft");
      await S.addLog({ kind: "league", text: `Expansion draft: protected ${keep.map((pid) => LG.name(L, pid)).join(", ")}`, pids: keep,
        ex: { why: `Protected ${keep.length} of ${info.pids.length} players (league limit ${info.num || "none"}): Never-trade first, then Ask-first, then highest value for ${L.strategy.label}.`, benefits: [], costs: [], strategy: L.strategy.label, basis: "projected" } });
      return true;
    }
    if (poll.gameOver) throw new Error("BBGM says you were fired (game over). Pick a new team or league in BBGM, then start Autopilot again");
    return false;
  }
  async function startAutopilot() {
    if (st.ap.running) return;
    const dialogTimer = setInterval(() => {
      if (!st.ap.running) return clearInterval(dialogTimer);
      const r = answerBBGMDialogs();
      if (r && r !== "answered" && !/Waiting for BBGM/.test(st.ap.status)) { st.ap.status = `Waiting for BBGM: it's showing a message that needs you ("${r.replace(/\s+/g, " ")}…")`; render(); }
    }, 1000);
    st.ap = { running: true, status: "Starting…", startSeason: null, stopReq: false, runStart: Date.now(), strategies: {}, rosterStart: null };
    render();
    // Autopilot must make every decision the game would otherwise stop and ask you about.
    const apSettings = () => ({ ...settings, manage: { ...settings.manage, resign: true, releases: true, signings: true } });
    let stuck = 0, rounds = 0, roundsKey = "", idle = 0, idleKey = "";
    let lastL = null;
    try {
      for (;;) {
        if (st.ap.stopReq) { st.ap.status = "Stopped."; break; }
        let poll = await waitIdle();
        if (st.ap.stopReq) { st.ap.status = "Stopped."; break; }
        if (!poll.inLeague) throw new Error("Not in a league");
        if (poll.multiTeam || poll.spectator) throw new Error("Autopilot needs a single user team (not multi-team or spectator mode)");
        if (st.ap.startSeason == null) st.ap.startSeason = poll.season;
        const reason = F.stopHere(poll, settings, st.ap.startSeason);
        if (reason && stuck === 0 && st.ap.lastKey) { st.ap.status = `Finished: ${reason}.`; break; }
        // Loop guard: many manager rounds without the game moving means something keeps failing.
        const pk = progressKey(poll);
        idle = idleKey === pk ? idle + 1 : 0; idleKey = pk;
        if (idle >= 8) throw new Error("The game hasn't moved after several manager rounds; stopping to avoid a loop");
        st.poll = poll; st.pollKey = keyOf(poll);
        invalidate();
        st.ap.status = "Managing the team…"; render();
        const L = await getL(true);
        lastL = L;
        if (!st.ap.rosterStart) st.ap.rosterStart = L.roster(L.snap.userTid).map((p) => p.pid);
        const ss = (st.ap.strategies[poll.season] = st.ap.strategies[poll.season] || []);
        if (ss[ss.length - 1] !== L.strategy.label) ss.push(L.strategy.label);
        const s2 = apSettings();
        const td = await F.tradeDue(lidNow(), L, s2);
        const planned = await F.managerPlan(L, s2, { lid: lidNow(), includeTrades: s2.manage.trades && td.due && td });
        // Fully automatic (default): moves that would wait for your OK are made too, except anything that
        // would trade, cut or let go a Never-trade player.
        const auto = settings.apAutoApprove !== false && settings.apAutoApprove !== "false";
        const waiting = planned.filter((a) => a.approval && (!auto || a.never));
        const acts = planned.filter((a) => !a.approval || (auto && !a.never));
        // Autopilot makes every other move itself, so the list only keeps what needs your OK.
        st.pending = waiting; st.pendingKey = pk;
        // Re-signing can't continue past undecided protected players, so hand control back.
        if (!auto && poll.phase === 7 && waiting.some((a) => a.kind === "resign" || a.kind === "letwalk") && !acts.length) {
          st.ap.status = `Paused: ${waiting.length} move${waiting.length === 1 ? "" : "s"} need your OK (protected players or contract rules). Approve or skip them below, then start Autopilot again.`;
          await S.addLog({ kind: "error", text: st.ap.status });
          break;
        }
        if (td.due) await td.mark();
        if (acts.length) {
          // Each action re-checks that BBGM is idle and still at the state the plan was made for;
          // Stop takes effect between actions, never in the middle of one.
          const check = async () => { const p = await B.poll(); if (p.gameSim || p.drafting) return "BBGM started simulating"; if (progressKey(p) !== pk) return "the game moved on since the plan was made"; return null; };
          const res = await F.runActions(acts, { stateKey: pk, check, shouldStop: () => st.ap.stopReq });
          invalidate();
          st.log = await S.getLog(); render();
          rounds = roundsKey === pk ? rounds + 1 : 1; roundsKey = pk;
          if (st.ap.stopReq) { st.ap.status = "Stopped."; break; }
          if (res.some((r) => r.ok) && rounds < 3) continue; // re-check after changes (e.g. roster size)
        }
        if (poll.phase === 5 && poll.onClock === poll.userTid) {
          st.ap.status = "Drafting…"; render();
          await F.draftStep(await getL(true), { ...s2, draftTradeUp: s2.draftTradeUp }, { act: true });
          continue;
        }
        // League events BBGM's own Auto Play also handles: votes and the expansion draft's protection step.
        if (await handleLeagueEvents(poll, L)) continue;
        const [action, label] = F.nextPlayAction(poll, settings);
        if (!action) throw new Error(`Unknown game phase (${poll.phase})`);
        if (poll.phase === 7 && poll.negs > 0) {
          // Players still unsigned (e.g. a Never-trade player who won't re-sign): BBGM will ask before free agency.
          await S.addLog({ kind: "letwalk", text: `${poll.negs} player${poll.negs === 1 ? "" : "s"} still unsigned at the end of re-signing; they become free agents` });
        }
        st.ap.status = `${label}…`; render();
        const before = progressKey(poll);
        st.ap.lastKey = before;
        await B.call("playMenu", action, undefined, 30 * 60 * 1000).catch((e) => { throw new Error(`${label} failed: ${e.message}`); });
        await sleep(600);
        poll = await waitIdle();
        if (progressKey(poll) === before && poll.phase <= 3 && !st.ap.stopReq) {
          // Some steps can be no-ops (for example, between playoff rounds). Fall back to playing a single day.
          st.ap.status = "Playing one day…"; render();
          await B.call("playMenu", "day", undefined, 30 * 60 * 1000).catch(() => {});
          await sleep(600);
          poll = await waitIdle();
        }
        if (progressKey(poll) === before) {
          if (++stuck >= 2) throw new Error(`The game didn't advance after "${label}". BBGM may be showing a message that needs you (for example, roster or cap limits); check the game window, then start Autopilot again.`);
        } else stuck = 0;
      }
    } catch (e) {
      st.ap.status = `Stopped: ${e.message}`;
      await S.addLog({ kind: "error", text: `Autopilot stopped: ${e.message}` });
    }
    st.ap.running = false;
    st.log = await S.getLog();
    await buildSummary(lastL).catch((e) => { st.ap.status += ` (summary unavailable: ${e.message})`; });
    st.ap.justFinished = true;
    render();
  }
  /** Observed results of the run (season records from BBGM) plus what the manager did (activity log). */
  async function buildSummary(L) {
    if (st.ap.startSeason == null) return;
    const p = await B.poll();
    const hist = await B.history(st.ap.startSeason, p.season);
    const log = (await S.getLog()).filter((e) => e.t >= st.ap.runStart);
    const end = (await B.evalJSON(`const ps = await bbgm.idb.cache.players.indexGetAll("playersByTid", bbgm.g.get("userTid")); console.log(JSON.stringify({ pids: ps.map((x) => x.pid) }));`, 15000)).pids;
    st.apSummary = SG.summarizeRun({ rows: hist.rows, userTid: hist.userTid, nr: hist.nr, from: st.ap.startSeason, to: p.season, log,
      strategies: st.ap.strategies, rosterStart: st.ap.rosterStart || [], rosterEnd: end });
    await S.localSet(`apSummary:${lidNow()}`, st.apSummary);
  }
  async function stopAutopilot() {
    st.ap.stopReq = true;
    st.ap.status = "Stopping after the current step…";
    await B.call("playMenu", "stop").catch(() => {});
    render();
  }

  // ======================================================================
  // Background loop: game-day refreshes, drafter, manager
  // ======================================================================
  let loopBusy = false;
  async function tick() {
    if (loopBusy || !lidNow() || !needsBridge()) return;
    loopBusy = true;
    try {
      const p = await B.poll();
      st.poll = p;
      if (!p.inLeague) return;
      const k = keyOf(p);
      const changed = k !== st.pollKey;
      st.pollKey = k;
      if (changed) { invalidate(); st.current = null; }
      if (st.ap.running || p.gameSim || p.drafting) { if (changed) render(); return; }

      // Trade screen: evaluate whatever deal is on the table.
      if (settings.features.trades && settings.tradeOnTradePage && TRADE_RE.test(location.pathname)) {
        const L = await getL();
        st.current = await F.evaluateCurrentTrade(L).catch(() => null);
        if (!st.trades.ideas && !st.trades.busy) refreshTrades();
      }
      // Every game day: refresh trade ideas.
      if (changed && settings.features.trades && settings.tradeOnGameDay && st.trades.forKey !== k && !st.trades.busy) {
        st.trades.ideas = null;
        if (st.tab === "trades" || TRADE_RE.test(location.pathname) || p.phase !== 1) refreshTrades();
        else setTimeout(refreshTrades, 1500);
      }
      // Auto Drafter.
      if (settings.features.drafter && p.phase === 5 && p.onClock === p.userTid && settings.draftMode === "auto") {
        await F.draftStep(await getL(true), settings, { act: true });
        invalidate();
      } else if (settings.features.drafter && p.phase === 5 && settings.draftMode === "auto" && settings.draftTradeUp) {
        await F.draftStep(await getL(), settings, { act: true });
      }
      // Auto Team Management.
      if (settings.features.manager && changed) {
        const L = await getL();
        const td = await F.tradeDue(lidNow(), L, settings);
        const acts = await F.managerPlan(L, settings, { lid: lidNow(), includeTrades: settings.manage.trades && td.due && td });
        if (td.due) await td.mark();
        const pk = progressKey(p);
        st.pendingKey = pk;
        if (settings.managerMode === "auto" && acts.length) {
          const ok = acts.filter((a) => !a.approval);
          const check = async () => { const q = await B.poll(); if (q.gameSim || q.drafting) return "BBGM started simulating"; if (progressKey(q) !== pk) return "the game moved on since the plan was made"; return null; };
          if (ok.length) await F.runActions(ok, { stateKey: pk, check, shouldStop: () => st.ap.running });
          invalidate();
          st.pending = acts.filter((a) => a.approval); // "Ask first" moves wait for you even in automatic mode
          st.log = await S.getLog();
        } else st.pending = acts;
      }
      if (changed) render();
    } catch (e) {
      // BBGM not ready, or not on a league page.
    } finally {
      loopBusy = false;
    }
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



  // ======================================================================
  // Hover cards: hover any player's name to see the Scout summary
  // ======================================================================
  const hoverCache = new Map(); // `${lid}:${pid}` -> { key, result }
  let tipHost = null, tipRoot = null, tipTimer = null, hideTimer = null, tipFor = null;
  const TIP_CSS = `
  :host { all: initial; }
  .tip { position: fixed; z-index: 2147483001; width: 270px; pointer-events: none;
    font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --bg:#fff; --fg:#1d2330; --mut:#667085; --line:#e4e7ec; --chip:#f2f4f7; --acc:#2f6fed; --good:#12804a; --bad:#c4321c; --warn:#a15c00;
    background: var(--bg); color: var(--fg); border:1px solid var(--line); border-radius:10px; box-shadow:0 8px 24px rgba(16,24,40,.2); padding:9px 10px; }
  .tip.dark { --bg:#1b1f27; --fg:#e7e9ee; --mut:#98a2b3; --line:#2f3542; --chip:#262b36; --acc:#6f9bff; --good:#4cc38a; --bad:#ff7a66; --warn:#f5b04c; }
  .hd { display:flex; justify-content:space-between; gap:6px; align-items:baseline; }
  b { font-size:13px; } .mut { color:var(--mut); } .good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); }
  .chip { font-size:10.5px; font-weight:600; padding:1px 6px; border-radius:999px; background:var(--chip); white-space:nowrap; }
  .chip.gem { color:var(--good); } .chip.over { color:var(--bad); }
  .g { display:grid; grid-template-columns:repeat(3,1fr); gap:4px; margin:7px 0 5px; text-align:center; }
  .g div { background:var(--chip); border-radius:6px; padding:3px 0; }
  .g small { display:block; font-size:9.5px; color:var(--mut); text-transform:uppercase; letter-spacing:.3px; }
  .g strong { font-size:16px; font-variant-numeric:tabular-nums; }
  .r { display:flex; justify-content:space-between; padding:1.5px 0; font-variant-numeric:tabular-nums; }
  .r span:first-child { color:var(--mut); }
  .why { color:var(--mut); font-size:11px; margin-top:5px; }`;

  function ensureTip() {
    if (tipHost && document.body.contains(tipHost)) return;
    tipHost = document.createElement("div");
    tipHost.id = "bbgm-scout-tip";
    tipRoot = tipHost.attachShadow({ mode: "open" });
    document.body.appendChild(tipHost);
  }
  function hideTip() { clearTimeout(tipTimer); tipFor = null; if (tipRoot) tipRoot.innerHTML = ""; }

  async function hoverData(lid, pid) {
    const ck = `${lid}:${pid}`;
    const c = hoverCache.get(ck);
    if (c && c.key === st.pollKey) return c.result;
    const ctx = await D.load(lid, [pid]);
    const p = ctx.players.get(pid);
    if (!p) return null;
    const result = A.analyze(ctx, p, settings, { nSims: 500 });
    hoverCache.set(ck, { key: st.pollKey, result });
    return result;
  }

  function tipHtml(pid, r) {
    const s = r.summary;
    const L = st.L;
    const v = L && L.byPid.get(pid);
    const gem = v && settings.features.assistant ? F.gemVerdict(L, pid) : null;
    const team = v ? (v.p.tid === -1 ? "Free agent" : v.p.tid <= -2 ? "Draft prospect" : (L.teams.get(v.p.tid) || {}).abbrev || "") : "";
    const rows = [];
    rows.push(["Breakout / decline", `<span class="${s.breakout >= 0.2 ? "good" : ""}">${pct(s.breakout)}</span> / <span class="${s.decline >= 0.1 ? "bad" : ""}">${pct(s.decline)}</span>`]);
    rows.push(["Bust risk", `<span class="${s.bust >= 0.5 ? "bad" : ""}">${pct(s.bust)}</span>`]);
    rows.push(["Development trend", `<span class="${s.trend === "Above expected" ? "good" : s.trend === "Below expected" ? "bad" : ""}">${esc(s.trend)}</span>`]);
    rows.push(["Confidence", `<span class="${s.confidence === "High" ? "good" : s.confidence === "Low" ? "bad" : "warn"}">${esc(s.confidence)}</span>`]);
    if (v) {
      rows.push([`Value to you (${esc(L.strategy.label)})`, `<span class="${v.surplus >= 0 ? "good" : "bad"}">${num(v.surplus, 0)}</span>`]);
      if (v.p.tid === -1 && v.p.mood) rows.push(["Asking", `${F.fmtMoney(v.p.mood.contractAmount)}${v.p.mood.willing ? "" : " · <span class='bad'>won't sign</span>"}`]);
      else if (v.p.contract && v.p.tid >= 0) rows.push(["Contract", `${F.fmtMoney(v.p.contract.amount)} thru ${v.p.contract.exp}`]);
      if (v.prospect) {
        const board = F.draftBoard(L);
        const b = board.find((x) => x.pid === pid);
        if (b) rows.push(["Draft rank (Scout / BBGM)", `#${b.ourRank} / #${b.marketRank}`]);
      }
      if (v.p.tid === L.snap.userTid && v.p.ptModifier != null && v.p.ptModifier !== 1) rows.push(["Playing time", esc(F.PT[v.p.ptModifier] || v.p.ptModifier)]);
      if (v.p.injury && v.p.injury.gamesRemaining > 0) rows.push(["Injury", `<span class="bad">${esc(v.p.injury.type)} (${v.p.injury.gamesRemaining} g)</span>`]);
    }
    return `<div class="hd"><b>${esc(s.name)}</b>${gem ? `<span class="chip ${gem.score >= 7 ? "gem" : gem.score <= -10 ? "over" : ""}">${esc(gem.verdict)}</span>` : `<span class="chip">${esc(s.label)}</span>`}</div>
      <div class="mut">${team ? `${esc(team)} · ` : ""}Age ${s.age} · OVR ${s.ovr} · POT ${s.pot}${s.pos ? ` · ${esc(s.pos)}` : ""}</div>
      <div class="g"><div><small>Peak age</small><strong>${s.peakAge}</strong></div><div><small>Peak OVR</small><strong>${s.peakOvr}</strong></div><div><small>Ceiling</small><strong>${s.ceiling}</strong></div></div>
      ${rows.map(([a, b]) => `<div class="r"><span>${a}</span><span>${b}</span></div>`).join("")}
      ${gem && gem.reasons[1] ? `<div class="why">${esc(gem.reasons[1])}</div>` : ""}`;
  }

  function placeTip(anchor) {
    const tip = tipRoot && tipRoot.querySelector(".tip");
    if (!tip) return;
    const a = anchor.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = Math.min(window.innerWidth - w - 8, Math.max(8, a.left));
    let top = a.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
  }

  function onHoverIn(e) {
    if (!settings.features.hover) return;
    const a = e.target.closest && e.target.closest('a[href*="/player/"]');
    if (!a || a.closest("#bbgm-scout-host")) return;
    const m = (a.getAttribute("href") || "").match(PLAYER_RE);
    const lid = lidNow();
    if (!m || Number(m[1]) !== lid) return;
    const pid = Number(m[2]);
    clearTimeout(hideTimer); clearTimeout(tipTimer);
    if (tipFor === a) return;
    tipTimer = setTimeout(async () => {
      tipFor = a;
      ensureTip();
      tipRoot.innerHTML = `<style>${TIP_CSS}</style><div class="tip${isDark() ? " dark" : ""}"><span class="mut">Scouting…</span></div>`;
      placeTip(a);
      try {
        const r = await hoverData(lid, pid);
        if (tipFor !== a) return;
        tipRoot.innerHTML = `<style>${TIP_CSS}</style><div class="tip${isDark() ? " dark" : ""}">${r ? tipHtml(pid, r) : `<span class="mut">Not in the saved league data yet.</span>`}</div>`;
        placeTip(a);
      } catch (err) {
        if (tipFor === a) tipRoot.innerHTML = "";
      }
    }, 300);
  }
  function onHoverOut(e) {
    const a = e.target.closest && e.target.closest('a[href*="/player/"]');
    if (!a) return;
    if (e.relatedTarget && a.contains(e.relatedTarget)) return;
    clearTimeout(tipTimer);
    hideTimer = setTimeout(hideTip, 120);
  }

  // ======================================================================
  // Routing
  // ======================================================================
  let protLid = null; // the league identity whose protections are loaded
  let identityFor = null;
  async function ensureIdentity() {
    const lid = lidNow();
    if (!lid || identityFor === lid) return st.league;
    identityFor = lid;
    await B.call("main", "idbCacheFlush", undefined, 5000).catch(() => {});
    let fp = await S.knownLeague(lid);
    if (!fp) { try { fp = await D.fingerprint(lid); } catch (e) { /* league not saved yet */ } }
    if (!fp) { identityFor = null; return null; } // try again later
    st.league = fp;
    await S.rememberLeague(fp, lid);
    await S.migrateLeague(lid, fp);
    protLid = fp;
    await P.loadProtections(fp);
    render();
    return fp;
  }
  function onRoute() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (lidNow() && identityFor !== lidNow()) { st.league = null; ensureIdentity(); }
    hideTip();
    const m = location.pathname.match(PLAYER_RE);
    if (m) showPlayer(Number(m[1]), Number(m[2]));
    else {
      st.outlook = null;
      if (st.tab === "outlook") st.tab = "";
      render();
    }
    if (TRADE_RE.test(location.pathname) && settings.features.trades) { st.tab = "trades"; tick(); }
    scheduleBadges();
  }

  async function init() {
    settings = await S.getSettings();
    S.onChange(async (changes) => {
      if (protLid && changes[`protect:${protLid}`]) { await P.loadProtections(protLid); st.trades.ideas = null; st.pending = null; render(); }
      if (!changes.settings) return;
      const prev = settings;
      settings = await S.getSettings();
      const modelChanged = ["nSims", "respectFog", "bustMode", "bustMargin", "bustOvr", "teamMode", "riskPref"].some((k) => prev[k] !== settings[k]);
      if (modelChanged) { badgeCache.clear(); clearBadges(); invalidate(); st.trades.ideas = null; st.pending = null; }
      if (st.outlook && modelChanged) { lastUrl = ""; onRoute(); }
      render();
      scheduleBadges();
    });
    st.log = await S.getLog();
    if (lidNow()) st.apSummary = (await S.localGet(`apSummary:${lidNow()}`)) || null;
    document.addEventListener("mouseover", onHoverIn, true);
    document.addEventListener("mouseout", onHoverOut, true);
    window.addEventListener("scroll", hideTip, true);
    onRoute();
    setInterval(onRoute, 500); // BBGM is a single-page app; watch for route changes.
    setInterval(tick, 3000);
    tick();
    new MutationObserver((muts) => {
      if (settings.badges === "off") return;
      if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !n.classList?.contains("bbgm-scout-badge") && n.id !== "bbgm-scout-host"))) scheduleBadges();
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
