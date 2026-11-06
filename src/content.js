/*
 * Courtside – content script: the in-page dock (Outlook, AI, Trades, Targets,
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
  const IN = globalThis.BBGMScoutInsights;
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
  const isOn = (v) => v === true || v === "true";
  // Set when a newer copy of this script takes over the page (see "One live copy per page" at the end).
  const timers = [];
  let observer = null, shutDown = false;
  /** Master switch (popup): when off, Courtside shows nothing and does nothing on BBGM pages. */
  const enabled = () => settings.enabled !== false && !shutDown;
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
    openDetails: {}, // which expandable sections are open, so re-renders don't close them
    ratingBase: new Map(), // "lid:pid" -> attributes when you first opened the player this session (for the Live column)
    log: [],
    ap: { running: false, status: "", startSeason: null, stopReq: false },
    ask: { q: "", busy: false, answer: "", error: "" },
    flash: "",
  };
  const handlers = new Map();
  let hid = 0;
  const on = (fn) => { const id = `h${++hid}`; handlers.set(id, fn); return id; };

  const THEME_ICON = { auto: "◐", light: "☀", dark: "☾" }; // icon only; the button's title names the theme
  const THEME_LABEL = { auto: "Auto (follows BBGM)", light: "Light", dark: "Dark" };
  // Small line icons for the tabs (inline SVG, inherit the text color).
  const ico = (d) => `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const TAB_ICON = {
    outlook: ico('<path d="M2 12l3.5-4 3 2.5L14 4"/><path d="M10.5 4H14v3.5"/>'),
    assistant: ico('<path d="M8 1.5l1.6 4.2 4.4.3-3.4 2.8 1.1 4.3L8 10.8 4.3 13.1l1.1-4.3L2 6l4.4-.3z"/>'),
    trades: ico('<path d="M3 5h9l-2.5-2.5M13 11H4l2.5 2.5"/>'),
    targets: ico('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.5"/>'),
    fa: ico('<circle cx="6" cy="5" r="2.5"/><path d="M1.5 14c.5-3 2.3-4.5 4.5-4.5S10 11 10.5 14M12.5 5.5v4M10.5 7.5h4"/>'),
    draft: ico('<rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/>'),
    manager: ico('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>'),
    needs: ico('<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3.5M8 12v.1"/>'),
    plan: ico('<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>'),
    moneyball: ico('<circle cx="8" cy="8" r="6.2"/><path d="M10 5.8c-.5-.7-1.2-1-2-1-1.2 0-2 .6-2 1.5 0 2 4 1.2 4 3.3 0 .9-.9 1.6-2.1 1.6-.9 0-1.7-.4-2.1-1.1M8 3.5v1.3M8 11.2v1.3"/>'),
    realism: ico('<path d="M2 13.5h12M3.5 13.5V8M6.5 13.5V5M9.5 13.5V9.5M12.5 13.5V3"/>'),
    office: ico('<rect x="2" y="5" width="12" height="9" rx="1.5"/><path d="M5.5 5V3.5A1.5 1.5 0 0 1 7 2h2a1.5 1.5 0 0 1 1.5 1.5V5M2 9h12"/>'),
    insights: ico('<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4L14 14M5 7.5l1.5-2 1.5 2 1.5-2.5"/>'),
  };
  const TABS = [
    ["outlook", "Outlook", () => true],
    ["assistant", "AI", () => settings.features.assistant],
    ["trades", "Trades", () => settings.features.trades],
    ["targets", "Targets", () => settings.features.targets],
    ["fa", "FA", () => settings.features.freeAgents],
    ["draft", "Draft", () => settings.features.drafter],
    ["manager", "Manager", () => settings.features.manager || settings.features.autopilot],
    ["office", "Office", () => settings.features.office !== false],
    ["insights", "Insights", () => settings.features.insights !== false],
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
      // Job on the line? (owner mood projection; read-only) Auto won't pick a long rebuild then.
      let jobRisk = null;
      try { const js = IN && IN.jobSecurity(null, await loadOwner()); jobRisk = js && (js.risk === "high" || js.risk === "fired") ? "high" : null; } catch (e) { /* ignore */ }
      const L = await LG.build(snap, settings, (f) => { st.buildMsg = `Analyzing players… ${Math.round(f * 100)}%`; render(); }, { strategyStored: stored, jobRisk });
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
      afterBuild(L).then(() => { if (st.tab === "office" || st.tab === "manager" || isOn(settings.compactMode)) render(); }).catch(() => {});
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
    // ---- Horizontal tab scrolling: arrows, wheel/trackpad, drag, keyboard ----
    let drag = null, suppressClick = false;
    shadow.addEventListener("wheel", (e) => {
      const nav = e.target.closest && e.target.closest("nav");
      if (!nav) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; // a normal mouse wheel scrolls the tabs sideways
      if (!d) return;
      const before = nav.scrollLeft;
      nav.scrollLeft += d * (e.deltaMode === 1 ? 32 : 1);
      if (nav.scrollLeft !== before) e.preventDefault();
    }, { passive: false });
    shadow.addEventListener("pointerdown", (e) => {
      const nav = e.target.closest && e.target.closest("nav");
      if (!nav || e.button !== 0 || e.pointerType === "touch") return; // touch already scrolls natively
      drag = { nav, x: e.clientX, left: nav.scrollLeft, moved: false, id: e.pointerId };
    });
    shadow.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) > 5) { drag.moved = true; drag.nav.classList.add("dragging"); try { drag.nav.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      if (drag.moved) drag.nav.scrollLeft = drag.left - dx;
    });
    const endDrag = () => {
      if (!drag) return;
      if (drag.moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); drag.nav.classList.remove("dragging"); }
      drag = null;
    };
    shadow.addEventListener("pointerup", endDrag);
    shadow.addEventListener("pointercancel", endDrag);
    // ---- Move the whole dock: press and drag the logo / name in the header ----
    let move = null;
    shadow.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest && e.target.closest(".grip");
      if (!grip || e.button !== 0) return;
      const w = shadow.querySelector(".wrap"), r = w.getBoundingClientRect();
      move = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false, id: e.pointerId, w };
      st.dragging = true; // hold re-renders from the moment you press, so the element under your mouse stays put
    });
    shadow.addEventListener("pointermove", (e) => {
      if (!move || e.pointerId !== move.id) return;
      const dx = e.clientX - move.x, dy = e.clientY - move.y;
      move.w = shadow.querySelector(".wrap") || move.w;
      if (!move.moved && Math.hypot(dx, dy) > 4) { move.moved = true; move.w.classList.add("moving"); try { move.w.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      if (!move.moved) return;
      const r = move.w.getBoundingClientRect();
      const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, move.left + dx));
      const y = Math.max(4, Math.min(window.innerHeight - 44, move.top + dy));
      Object.assign(move.w.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto" });
      e.preventDefault();
    });
    const endMove = async () => {
      if (!move) return;
      const m = move; move = null;
      if (!m.moved) { // a plain click: the header's open/close still works
        st.dragging = false;
        if (st.renderPending) { st.renderPending = false; setTimeout(render, 0); }
        return;
      }
      m.w.classList.remove("moving");
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
      const r = m.w.getBoundingClientRect();
      settings.panelPos = { x: Math.round(r.left), y: Math.round(r.top) };
      st.dragging = false;
      if (st.renderPending) { st.renderPending = false; render(); } else placeDock();
      await S.saveSettings({ panelPos: settings.panelPos });
    };
    shadow.addEventListener("pointerup", endMove);
    shadow.addEventListener("pointercancel", endMove);
    // Released outside the dock (or outside the window): still end the drag, so re-rendering never stays paused.
    window.addEventListener("pointerup", endMove, true);
    window.addEventListener("blur", endMove);
    shadow.addEventListener("dblclick", async (e) => {
      if (!(e.target.closest && e.target.closest(".grip"))) return;
      settings.panelPos = null;
      await S.saveSettings({ panelPos: null });
      render();
    });
    shadow.addEventListener("scroll", (e) => { if (e.target && e.target.tagName === "NAV") updateNavArrows(); }, true);
    shadow.addEventListener("keydown", (e) => {
      const tab = e.target.closest && e.target.closest('nav [role="tab"]');
      if (!tab || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
      const next = e.key === "ArrowRight" ? tab.nextElementSibling : tab.previousElementSibling;
      if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    });
    shadow.addEventListener("click", async (e) => {
      if (suppressClick) { e.preventDefault(); e.stopPropagation(); return; } // the end of a drag, not a tab click
      const arrow = e.target.closest && e.target.closest("[data-navscroll]");
      if (arrow) {
        const nav = shadow.querySelector("nav");
        if (nav) nav.scrollBy({ left: Number(arrow.dataset.navscroll) * Math.max(120, nav.clientWidth * 0.7), behavior: "smooth" });
        return;
      }
      if (linkClick(e)) return;
      const el = e.target.closest("[data-h]");
      if (!el) return;
      const fn = handlers.get(el.dataset.h);
      if (fn) { e.preventDefault(); await fn(el); }
    });
    shadow.addEventListener("toggle", (e) => {
      const d = e.target;
      if (d && d.tagName === "DETAILS" && d.dataset.key) st.openDetails[d.dataset.key] = d.open;
    }, true);
    shadow.addEventListener("input", (e) => { if (e.target.id === "askq") st.ask.q = e.target.value; });
    shadow.addEventListener("change", async (e) => {
      const q = e.target.closest("[data-q]");
      if (q) { st.queueSel = st.queueSel || new Set(); if (q.checked) st.queueSel.add(q.dataset.q); else st.queueSel.delete(q.dataset.q); render(); return; }
      const ob = e.target.closest("[data-obj]");
      if (ob) {
        const k = ob.dataset.obj;
        const v = ob.type === "checkbox" ? ob.checked : Math.max(0, Number(ob.value) || 0);
        settings.objectives = { ...(settings.objectives || {}), [k]: v };
        await S.saveSettings({ objectives: settings.objectives });
        invalidate(); st.pending = null; st.trades.ideas = null; render();
        return;
      }
      const cm = e.target.closest("[data-cmetric]");
      if (cm) {
        const cur = new Set(settings.compactMetrics || []);
        if (cm.checked) cur.add(cm.dataset.cmetric); else cur.delete(cm.dataset.cmetric);
        settings.compactMetrics = [...cur].slice(0, 3);
        await S.saveSettings({ compactMetrics: settings.compactMetrics });
        render();
        return;
      }
      const ctl = e.target.closest("[data-set]");
      if (ctl) {
        const k = ctl.dataset.set;
        let v = ctl.type === "checkbox" ? ctl.checked : ctl.type === "number" ? Number(ctl.value) : ctl.value;
        if (ctl.type === "number") v = Math.max(Number(ctl.min || -1e9), Math.min(Number(ctl.max || 1e9), Number.isFinite(v) ? v : 0));
        if (k === "apSeasons") v = Math.max(1, Math.min(100, Number(v) || 1));
        settings[k] = v;
        await S.saveSettings({ [k]: v });
        if (k === "teamMode" || k === "managerStyle") { invalidate(); st.trades.ideas = null; st.pending = null; }
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
  /** Shows the ‹ › arrows (and edge fades) only on the sides where more tabs are hidden. */
  function updateNavArrows() {
    const nav = shadow && shadow.querySelector("nav");
    if (!nav) return;
    const wrap = nav.parentElement;
    wrap.classList.toggle("can-left", nav.scrollLeft > 2);
    wrap.classList.toggle("can-right", nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
  }
  function removeHost() { if (host) host.remove(); host = shadow = null; }

  const CSS = `
  :host { all: initial; }
  /* "Courtside": hardwood and scoreboard in light mode, arena at night in dark mode. Basketball orange accent. */
  .wrap { position: fixed; bottom: 16px; z-index: 2147483000; width: 348px; max-width: calc(100vw - 32px);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --bg:#fcf7ef; --fg:#21180f; --mut:#7b6a57; --line:#ecdcc4; --chip:#f5e9d6; --card:#fffdf9;
    --acc:#e0631d; --acc2:#bf4a10; --navy:#1d3557; --good:#1d8a4d; --bad:#c8372d; --warn:#b06f08;
    --board:#15202f; --boardfg:#ffb26b; --shadow:0 18px 40px -12px rgba(73,38,10,.35), 0 2px 6px rgba(73,38,10,.12);
    background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 16px;
    box-shadow: var(--shadow); overflow: hidden; display:flex; flex-direction:column; max-height: min(80vh, 740px); }
  .wrap.dark { --bg:#0f1622; --fg:#edf1f7; --mut:#8e9ab0; --line:#223049; --chip:#18233a; --card:#131d2e;
    --acc:#ff8a3d; --acc2:#ff6a1a; --navy:#7fb2ff; --good:#4fd28f; --bad:#ff6f5e; --warn:#f6b544;
    --board:#060b14; --boardfg:#ffa95c; --shadow:0 18px 44px -10px rgba(0,0,0,.7), 0 0 0 1px rgba(255,138,61,.08); }
  .wrap.right { right: 16px; } .wrap.left { left: 16px; }
  a { color: var(--acc); text-decoration: none; } a:hover { text-decoration: underline; }
  a.pl { color: inherit; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 28%, transparent); text-underline-offset: 2px; text-decoration-thickness: 1px; }
  a.pl:hover { color: var(--acc); text-decoration-color: currentColor; }

  /* Header: a strip of basketball leather with faint court lines */
  header { position:relative; display:flex; align-items:center; gap:8px; padding:9px 12px; cursor:pointer; user-select:none; flex:none; color:#fff;
    background:
      radial-gradient(circle at 92% 160%, transparent 46px, rgba(255,255,255,.18) 47px, rgba(255,255,255,.18) 48px, transparent 49px),
      radial-gradient(circle at 8% -60%, transparent 30px, rgba(255,255,255,.14) 31px, rgba(255,255,255,.14) 32px, transparent 33px),
      linear-gradient(135deg, var(--acc) 0%, var(--acc2) 100%); }
  header::after { content:""; position:absolute; inset:auto 0 0 0; height:3px; background:repeating-linear-gradient(90deg, rgba(0,0,0,.18) 0 6px, transparent 6px 12px); opacity:.35; }
  header b { font-size:13.5px; letter-spacing:.9px; text-transform:uppercase; font-weight:800; text-shadow:0 1px 0 rgba(0,0,0,.18); }
  header .ball { width:18px; height:18px; flex:none; filter:drop-shadow(0 1px 1px rgba(0,0,0,.25)); }
  header .chip { background:rgba(255,255,255,.22); color:#fff; flex:none; white-space:nowrap; }
  /* The header row never overflows: buttons and chips keep their size, the sync label gives way first,
     and Open / Close is always the last thing visible. */
  header button, header .grip, header b { flex:none; white-space:nowrap; }
  header .caret { margin-left:auto; }
  /* "header > .sync": the status dot itself can also carry the class "sync" (its mode), so match the container only */
  header > .sync { flex:1 1 auto; min-width:0; justify-content:flex-end; overflow:hidden; }
  header > .sync .stxt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  header .dot { flex:none; }
  .wrap.compact header .stxt, .wrap.ap header .stxt { display:none; } /* tight header: the dot (with its tooltip) is enough */
  .wrap.compact header .apchip { padding:1px 6px; }
  .wrap.compact header { gap:6px; padding:9px 10px; } .wrap.compact header > .sync { display:none; }
  header .grip { display:flex; align-items:center; gap:8px; cursor:grab; touch-action:none; padding:2px 4px 2px 0; border-radius:8px; }
  header .grip:hover { background:rgba(255,255,255,.1); }
  .wrap.moving { transition:none; opacity:.92; box-shadow:0 24px 50px -10px rgba(0,0,0,.45); } .wrap.moving header .grip { cursor:grabbing; }
  .wrap.moving, .wrap.moving * { user-select:none; }
  .sync { margin-left:auto; font-size:11px; color:rgba(255,255,255,.9); display:flex; align-items:center; gap:4px; }
  .dot { width:7px; height:7px; border-radius:50%; background:#7dffb0; box-shadow:0 0 0 2px rgba(255,255,255,.25); } .dot.local { background:#ffd27a; } .dot.error { background:#ff9a8c; }
  header button { background:rgba(255,255,255,.16); border-color:rgba(255,255,255,.35); color:#fff; }
  header button:hover { background:rgba(255,255,255,.28); border-color:#fff; }
  .caret, header .theme { font-size:11px; padding:1px 7px; }

  /* Tabs: one sliding row of icon pills (scroll sideways; the active tab is kept in view), with soft fades at the edges */
  .navwrap { position:relative; flex:none; border-bottom:1px solid var(--line); background:color-mix(in srgb, var(--chip) 55%, var(--bg)); }
  nav { display:flex; flex-wrap:nowrap; gap:4px; padding:8px 10px; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; cursor:grab; touch-action:pan-x; }
  nav.dragging { cursor:grabbing; user-select:none; } nav.dragging button { pointer-events:none; }
  /* Edge fades only where more tabs are hidden */
  .can-left nav { -webkit-mask-image:linear-gradient(90deg, transparent 0, #000 34px); mask-image:linear-gradient(90deg, transparent 0, #000 34px); }
  .can-right nav { -webkit-mask-image:linear-gradient(90deg, #000 calc(100% - 34px), transparent 100%); mask-image:linear-gradient(90deg, #000 calc(100% - 34px), transparent 100%); }
  .can-left.can-right nav { -webkit-mask-image:linear-gradient(90deg, transparent 0, #000 34px, #000 calc(100% - 34px), transparent 100%); mask-image:linear-gradient(90deg, transparent 0, #000 34px, #000 calc(100% - 34px), transparent 100%); }
  .navarr { position:absolute; top:50%; transform:translateY(-50%); z-index:2; width:24px; height:24px; padding:0; border-radius:50%; display:none; align-items:center; justify-content:center;
    font-size:17px; font-weight:800; line-height:1; color:var(--fg); background:var(--card); border:1px solid var(--line); box-shadow:0 2px 8px -2px rgba(0,0,0,.35); }
  .navarr:hover { color:#fff; background:var(--acc); border-color:var(--acc); }
  .navarr.prev { left:4px; } .navarr.next { right:4px; }
  .can-left .navarr.prev, .can-right .navarr.next { display:flex; }
  nav::-webkit-scrollbar { display:none; }
  nav button { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--line); background:var(--card); color:var(--mut); font:inherit; font-size:12px; font-weight:700;
    padding:4px 10px 4px 8px; cursor:pointer; white-space:nowrap; border-radius:999px; flex:none; transition:background .15s, color .15s, border-color .15s, box-shadow .15s; }
  nav button .ti { display:inline-flex; opacity:.8; }
  nav button:hover { color:var(--fg); border-color:color-mix(in srgb, var(--acc) 45%, var(--line)); }
  nav button.active { color:#fff; border-color:transparent; background:linear-gradient(135deg, var(--acc), var(--acc2)); box-shadow:0 3px 10px -4px color-mix(in srgb, var(--acc) 80%, transparent); }
  nav button.active .ti { opacity:1; }
  nav .n { display:inline-block; min-width:14px; padding:0 4px; border-radius:999px; background:var(--acc); color:#fff; font-size:10px; line-height:15px; }
  nav button.active .n { background:rgba(255,255,255,.28); }
  nav button:focus-visible { outline:2px solid var(--acc); outline-offset:1px; }

  .body { padding:12px 8px 14px 12px; overflow-y:scroll; overflow-x:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
  /* Always-visible scrollbar (macOS otherwise hides it until you scroll) */
  .body::-webkit-scrollbar { width:10px; height:10px; }
  .body::-webkit-scrollbar-track { background:transparent; }
  .body::-webkit-scrollbar-thumb { background:color-mix(in srgb, var(--acc) 45%, var(--line)); border-radius:6px; border:3px solid var(--bg); min-height:30px; }
  .body::-webkit-scrollbar-thumb:hover { background:var(--acc); }
  .body::-webkit-scrollbar-corner { background:transparent; }
  @supports not selector(::-webkit-scrollbar) { .body { scrollbar-width:thin; scrollbar-color:var(--acc) transparent; } }
  .collapsed .navwrap, .collapsed .body { display:none; }

  .title { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
  .name { font-weight:800; font-size:16px; letter-spacing:-.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sub { color:var(--mut); font-size:12px; margin-top:2px; }
  .tag { font-size:11px; font-weight:700; padding:2px 9px; border-radius:999px; background:var(--chip); white-space:nowrap; }
  .tag.up { color:#fff; background:var(--good); } .tag.down { color:#fff; background:var(--bad); }

  /* Scoreboard tiles */
  .big { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin:12px 0 10px; text-align:center; }
  .big div { position:relative; background:var(--board); color:#cfd8e6; border-radius:10px; padding:7px 2px 6px; overflow:hidden;
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.06), inset 0 -10px 18px rgba(0,0,0,.35); }
  .big div::before { content:""; position:absolute; inset:0; background:radial-gradient(rgba(255,255,255,.05) 1px, transparent 1.2px) 0 0 / 4px 4px; pointer-events:none; }
  .big small { display:block; color:#8fa0b8; font-size:9.5px; text-transform:uppercase; letter-spacing:1.2px; font-weight:700; }
  .big strong { display:block; font-size:25px; font-weight:800; font-family:ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric:tabular-nums; line-height:1.15;
    color:var(--boardfg); text-shadow:0 0 10px color-mix(in srgb, var(--boardfg) 55%, transparent); }
  .big em { display:block; font-style:normal; color:#8fa0b8; font-size:10px; }

  .rows > div { display:flex; justify-content:space-between; gap:8px; padding:4px 0; border-bottom:1px dashed var(--line); }
  .rows > div:last-child { border-bottom:0; }
  .rows span:first-child { color:var(--mut); white-space:nowrap; }
  .rows span:last-child { font-weight:700; font-variant-numeric:tabular-nums; text-align:right; }
  .good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); } .mut { color:var(--mut); }

  /* Forecast chart */
  svg.spark { display:block; width:100%; height:64px; margin:10px 0 2px; overflow:visible; }
  .legend { display:flex; flex-wrap:wrap; gap:10px; font-size:10.5px; color:var(--mut); }
  .legend i { display:inline-block; width:12px; height:2px; vertical-align:middle; margin-right:4px; background:var(--fg); border-radius:2px; }
  .legend i.f { background:var(--acc); } .legend i.band { height:8px; background:color-mix(in srgb, var(--acc) 25%, transparent); }

  /* Predicted OVR range ribbons */
  .rib { position:relative; height:8px; min-width:70px; border-radius:4px; background:var(--chip); }
  .rib i { position:absolute; top:0; bottom:0; border-radius:4px; background:linear-gradient(90deg, color-mix(in srgb, var(--acc) 30%, transparent), color-mix(in srgb, var(--acc) 55%, transparent)); }
  .rib b { position:absolute; top:-2px; width:4px; height:12px; margin-left:-2px; border-radius:2px; background:var(--fg); }
  .rib + small { font-size:10px; color:var(--mut); }

  .why { color:var(--mut); font-size:11px; margin-top:7px; }
  .actions { display:flex; gap:6px; margin-top:10px; flex-wrap:wrap; }
  button { font:inherit; font-size:12px; font-weight:600; padding:5px 9px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; transition:border-color .15s, transform .05s, background .15s; }
  button:hover { border-color:var(--acc); }
  button:active { transform:translateY(1px); }
  button.on, button.pri { background:linear-gradient(135deg, var(--acc), var(--acc2)); color:#fff; border-color:transparent; box-shadow:0 2px 8px -2px color-mix(in srgb, var(--acc) 70%, transparent); }
  button.sm { font-size:11px; padding:2px 8px; }
  button:disabled { opacity:.5; cursor:default; }
  .actions button { flex:1; }
  .card .actions { margin-top:6px; } .card .actions button { flex:none; }
  .msg { color:var(--mut); padding:4px 0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:9px 10px; margin-bottom:8px; box-shadow:0 1px 0 rgba(0,0,0,.03); transition:border-color .15s, box-shadow .15s; }
  .card:hover { border-color:color-mix(in srgb, var(--acc) 40%, var(--line)); box-shadow:0 4px 14px -8px color-mix(in srgb, var(--acc) 60%, transparent); }
  .card .hd { display:flex; justify-content:space-between; align-items:center; gap:6px; }
  .card ul { margin:4px 0 0; padding-left:16px; } .card li { margin:2px 0; }
  .h { display:flex; align-items:center; gap:6px; font-size:10.5px; font-weight:800; text-transform:uppercase; letter-spacing:1.1px; color:var(--fg); margin:14px 0 6px; }
  .h::before { content:""; width:10px; height:10px; border-radius:50%; flex:none;
    background:radial-gradient(circle at 35% 35%, #ffb27a, var(--acc) 55%, var(--acc2)); box-shadow:inset 0 0 0 1px rgba(0,0,0,.15); }
  .h:first-child { margin-top:0; }
  table { width:100%; border-collapse:separate; border-spacing:0; font-variant-numeric:tabular-nums; font-size:12px; }
  .dl { font-size:11px; font-weight:600; white-space:nowrap; } .dl.up { color:var(--good); } .dl.dn { color:var(--bad); }
  table.attrs td:nth-child(n+2), table.attrs th:nth-child(n+2) { text-align:right; }
  tr.fresh td { animation: freshrow 2.4s ease-out; }
  @keyframes freshrow { from { background:rgba(255,170,60,.35); } to { background:transparent; } }
  th { text-align:right; font-weight:700; color:var(--mut); font-size:10px; text-transform:uppercase; letter-spacing:.6px; padding:3px 4px; border-bottom:2px solid var(--line); }
  td { text-align:right; padding:5px 4px; border-bottom:1px solid var(--line); }
  tr:nth-child(odd) td { background:color-mix(in srgb, var(--chip) 35%, transparent); }
  th:first-child, td:first-child { text-align:left; }
  td small { display:block; color:var(--mut); font-size:10.5px; }
  .chip { display:inline-block; font-size:10.5px; font-weight:700; padding:1px 7px; border-radius:999px; background:var(--chip); }
  .chip.gem { color:#fff; background:var(--good); } .chip.over { color:#fff; background:var(--bad); }
  textarea { width:100%; box-sizing:border-box; font:inherit; font-size:12px; border:1px solid var(--line); border-radius:9px; padding:7px; background:var(--card); color:var(--fg); resize:vertical; min-height:46px; }
  textarea:focus, select:focus, input:focus { outline:2px solid color-mix(in srgb, var(--acc) 55%, transparent); outline-offset:1px; }
  .answer { white-space:pre-wrap; background:var(--chip); border-radius:10px; padding:9px; margin-top:6px; }
  .banner { background:var(--chip); border-radius:10px; padding:8px 10px; margin-bottom:8px; }
  .banner.acc { border-left:4px solid var(--acc); background:color-mix(in srgb, var(--acc) 10%, var(--bg)); }
  .log div { display:flex; gap:6px; justify-content:space-between; padding:4px 0; border-bottom:1px dashed var(--line); font-size:11.5px; }
  .log time { color:var(--mut); flex:none; font-variant-numeric:tabular-nums; }
  select.prot { font:inherit; font-size:11px; padding:1px 3px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--fg); max-width:118px; }
  label.apseasons { display:flex; align-items:center; gap:6px; } label.apseasons select { font:inherit; padding:2px 4px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
  .dash { display:grid; grid-template-columns:1fr 1fr; gap:8px 10px; align-items:center; }
  .dash label { display:flex; flex-direction:column; gap:3px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; color:var(--mut); }
  .dash select, .dash input, .adv select, .adv input { font:inherit; font-size:12px; font-weight:600; text-transform:none; letter-spacing:0; padding:4px 6px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); }
  .dash .full { grid-column:1 / -1; }
  details { margin:4px 0; } details > summary { cursor:pointer; color:var(--mut); font-size:12px; font-weight:600; }
  details > summary:hover { color:var(--acc); }
  .adv { display:grid; grid-template-columns:1fr; gap:7px; margin-top:7px; } .adv label { display:flex; justify-content:space-between; gap:8px; align-items:center; font-size:12px; }
  .adv input[type=number] { width:64px; }
  .adv label.row { justify-content:flex-start; } .adv label.row input { margin:0; }
  .tradeauto { border-top:1px dashed var(--line); padding-top:6px; display:grid; gap:3px; }
  .tradeauto .ta-row { display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:12px; }
  .tradeauto .ta-row b { font-variant-numeric:tabular-nums; text-align:right; } .tradeauto .ta-row small { font-weight:600; }
  .ex { font-size:11px; color:var(--mut); margin:2px 0 4px; } .ex b { color:var(--fg); font-weight:700; } .ex ul { margin:2px 0 0 14px; padding:0; }
  .sum td, .sum th { font-size:11.5px; }
  select.prot.never { border-color:var(--bad); } select.prot.ask { border-color:var(--warn); }
  .warn-line { color:var(--warn); font-size:11px; margin-top:3px; }
  .flag { border-left:4px solid var(--line); padding:6px 9px; margin-bottom:6px; background:var(--chip); border-radius:8px; font-size:12px; }
  .flag.high { border-color:var(--bad); } .flag.medium { border-color:var(--warn); } .flag.good { border-color:var(--good); }
  .bar { height:6px; border-radius:3px; background:var(--line); position:relative; overflow:hidden; margin-top:3px; }
  .bar i { position:absolute; left:0; top:0; bottom:0; background:linear-gradient(90deg, var(--acc), var(--acc2)); border-radius:3px; }
  .bar.weak i { background:var(--bad); }
  /* Cleanup: collapsible cards read like cards, consistent spacing, quieter secondary text */
  details.card > summary { color:var(--fg); font-size:12.5px; font-weight:600; list-style:none; display:flex; align-items:center; gap:6px; }
  details.card > summary::before { content:"▸"; color:var(--acc); font-size:11px; transition:transform .15s; }
  details.card[open] > summary::before { transform:rotate(90deg); }
  details.card > summary::-webkit-details-marker { display:none; }
  .card.live { border-left:4px solid var(--acc); }
  .card .rows > div { padding:3px 0; }
  .card table { margin-top:4px; }
  .body > .h:first-child, .body > .card:first-child { margin-top:0; }
  .why { line-height:1.45; }
  .chips { display:flex; flex-wrap:wrap; gap:4px; margin:0 0 6px; } .chips button { padding:2px 8px; }
  input.q { vertical-align:middle; margin:0 2px 0 0; accent-color:var(--acc); }
  .meter { height:10px; border-radius:5px; background:linear-gradient(90deg, var(--bad), var(--warn) 45%, var(--good)); position:relative; margin:6px 0 2px; }
  .meter b { position:absolute; top:-3px; width:4px; height:16px; margin-left:-2px; border-radius:2px; background:var(--fg); box-shadow:0 0 0 2px var(--bg); }
  .dec { display:flex; gap:8px; align-items:baseline; padding:5px 0; border-bottom:1px dashed var(--line); font-size:12px; }
  .dec .when { flex:none; min-width:62px; font-weight:800; color:var(--mut); font-size:10.5px; text-transform:uppercase; letter-spacing:.5px; }
  .dec.urgent .when { color:var(--bad); }
  .lineup { display:grid; grid-template-columns:1fr 1fr; gap:6px; } .lineup > div { background:var(--chip); border-radius:8px; padding:6px 8px; font-size:11.5px; }
  .ok { color:var(--good); font-weight:700; } .no { color:var(--bad); font-weight:700; }
  /* Compact mode: a mini panel with three metrics */
  .wrap.compact { width:280px; } .wrap.compact .navwrap { display:none; }
  .mini { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; text-align:center; }
  .mini div { background:var(--board); color:#cfd8e6; border-radius:9px; padding:6px 2px; } .mini small { display:block; font-size:9px; text-transform:uppercase; letter-spacing:1px; color:#8fa0b8; font-weight:700; }
  .mini strong { display:block; font-size:16px; font-weight:800; color:var(--boardfg); font-variant-numeric:tabular-nums; }
  /* Command bar */
  .cmd { position:fixed; inset:0; z-index:2147483001; background:rgba(0,0,0,.35); display:flex; align-items:flex-start; justify-content:center; padding-top:12vh; font:13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .cmd .box { width:min(520px, calc(100vw - 32px)); background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow); overflow:hidden; }
  .cmd input { width:100%; box-sizing:border-box; border:0; border-bottom:1px solid var(--line); padding:12px 14px; font:inherit; font-size:15px; background:var(--card); color:var(--fg); outline:none; }
  .cmd ul { list-style:none; margin:0; padding:4px; max-height:50vh; overflow:auto; } .cmd li { padding:7px 10px; border-radius:8px; cursor:pointer; display:flex; justify-content:space-between; gap:8px; }
  .cmd li.sel, .cmd li:hover { background:color-mix(in srgb, var(--acc) 16%, var(--bg)); } .cmd li small { color:var(--mut); }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
  `;

  function tabCount(id) {
    if (id === "trades" && st.trades.ideas) return st.trades.ideas.length;
    if (id === "manager" && st.pending) return st.pending.length;
    if (id === "draft" && st.poll && st.poll.phase === 5 && st.poll.onClock === st.poll.userTid) return "!";
    return 0;
  }

  async function render() {
    // While you're dragging the dock, don't rebuild it (Autopilot re-renders constantly, which would drop the drag).
    if (st.dragging) { st.renderPending = true; return; }
    if (shutDown || !lidNow() || !enabled()) return removeHost();
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
    const nav = tabs.length > 1 ? `<div class="navwrap"><button class="navarr prev" data-navscroll="-1" tabindex="-1" aria-label="Scroll tabs left">‹</button><nav role="tablist">${tabs.map(([id, label]) => {
      const n = tabCount(id);
      return `<button role="tab" aria-selected="${st.tab === id}" class="${st.tab === id ? "active" : ""}" data-tab="${id}" data-h="${on(() => { st.tab = id; render(); onTabOpen(id); })}"><span class="ti" aria-hidden="true">${TAB_ICON[id] || ""}</span>${label}${n ? `<span class="n">${n}</span>` : ""}</button>`;
    }).join("")}</nav><button class="navarr next" data-navscroll="1" tabindex="-1" aria-label="Scroll tabs right">›</button></div>` : "";
    let body = "";
    const compact = isOn(settings.compactMode) && !settings.panelCollapsed;
    try { body = compact ? compactBody() : bodyFor(st.tab); } catch (e) { body = `<div class="msg">${esc(e.message)}</div>`; }
    const prevNav = shadow.querySelector("nav");
    const navScroll = prevNav ? prevNav.scrollLeft : 0;
    const prevBody = shadow.querySelector(".body");
    const scrollTop = prevBody && st.lastTab === st.tab ? prevBody.scrollTop : 0; // a new tab starts at the top
    st.lastTab = st.tab;
    const focusKey = shadow.activeElement && shadow.activeElement.dataset ? shadow.activeElement.dataset.set : null;
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="wrap ${settings.panelSide === "left" ? "left" : "right"}${isDark() ? " dark" : ""}${settings.panelCollapsed ? " collapsed" : ""}${compact ? " compact" : ""}${st.ap.running ? " ap" : ""}">
        <header data-h="${hdr}" title="Click to ${settings.panelCollapsed ? "open" : "close"}"><span class="grip" title="Drag to move Courtside (double-click to reset)"><svg class="ball" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="#fff" fill-opacity=".95"/><circle cx="12" cy="12" r="10.5" fill="none" stroke="#7a2d06" stroke-width="1.3"/><path d="M1.5 12h21M12 1.5v21M4.6 4.6c3.6 3.2 3.6 11.6 0 14.8M19.4 4.6c-3.6 3.2-3.6 11.6 0 14.8" fill="none" stroke="#7a2d06" stroke-width="1.3"/></svg><b>Courtside</b></span><button class="sm theme" data-h="${themeBtn}" title="Theme: ${THEME_LABEL[settings.theme] || "Auto"} (click to change)" aria-label="Switch light or dark mode">${THEME_ICON[settings.theme] || THEME_ICON.auto}</button>${st.ap.running ? `<span class="chip apchip" title="Autopilot is running">${compact ? "▶ AP" : "Autopilot"}</span>` : ""}<span class="sync" title="${esc(sync.text)}: ${esc(sync.detail)}"><span class="dot ${sync.mode}"></span><span class="stxt">${esc(sync.text)}</span></span><button class="sm caret" data-h="${hdr}" title="${settings.panelCollapsed ? "Open" : "Close"} Courtside" aria-label="${settings.panelCollapsed ? "Open" : "Close"} Courtside" aria-expanded="${!settings.panelCollapsed}">${settings.panelCollapsed ? "▲ Open" : compact ? "▼" : "▼ Close"}</button></header>
        ${nav}
        <div class="body">${st.flash ? `<div class="banner acc">${esc(st.flash)}</div>` : ""}${body}</div>
      </div>`;
    // Keep the reader's place: the panel is rebuilt on every change.
    const bodyEl = shadow.querySelector(".body");
    if (bodyEl && scrollTop) bodyEl.scrollTop = scrollTop;
    const navEl = shadow.querySelector("nav");
    if (navEl) {
      navEl.scrollLeft = navScroll;
      const act = navEl.querySelector("button.active");
      if (act && (act.offsetLeft < navEl.scrollLeft || act.offsetLeft + act.offsetWidth > navEl.scrollLeft + navEl.clientWidth)) navEl.scrollLeft = act.offsetLeft - 32;
      updateNavArrows();
    }
    if (focusKey) { const el = shadow.querySelector(`[data-set="${focusKey}"]`); if (el) el.focus(); }
    placeDock();
  }
  /** Puts the dock where you dragged it (kept on screen), or in its corner. */
  function placeDock() {
    const w = shadow && shadow.querySelector(".wrap");
    if (!w) return;
    const pos = settings.panelPos;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) { w.style.left = w.style.top = w.style.right = w.style.bottom = ""; return; }
    const r = w.getBoundingClientRect();
    const x = Math.max(4, Math.min(window.innerWidth - Math.min(r.width, window.innerWidth) - 4, pos.x));
    const y = Math.max(4, Math.min(window.innerHeight - 44, pos.y)); // the header always stays reachable
    Object.assign(w.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto", maxHeight: `${Math.max(160, window.innerHeight - y - 12)}px` });
  }
  window.addEventListener("resize", () => placeDock());

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
      case "office": return officeBody();
      case "insights": return insightsBody();
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
    const fut = res.fc.meanPath.slice(0, Math.max(3, res.fc.peakAgeRange[1] - res.summary.age + 3));
    const pts = [...hist, ...fut];
    const ages = pts.map((p) => p.age);
    const vals = [...pts.map((p) => p.ovr), ...fut.map((p) => p.lo), ...fut.map((p) => p.hi), res.summary.ceiling];
    const a0 = Math.min(...ages), a1 = Math.max(...ages);
    const o0 = Math.min(...vals) - 2, o1 = Math.max(...vals) + 2;
    const W = 320, H = 64;
    const x = (a) => ((a - a0) / Math.max(1, a1 - a0)) * (W - 8) + 4;
    const y = (o) => H - 4 - ((o - o0) / Math.max(1, o1 - o0)) * (H - 8);
    const line = (arr, k = "ovr") => arr.map((p, i) => `${i ? "L" : "M"}${x(p.age).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
    // 80% band (10th–90th percentile) around the forecast: a fan that widens with uncertainty.
    const band = `${line(fut, "hi")}L${[...fut].reverse().map((p) => `${x(p.age).toFixed(1)},${y(p.lo).toFixed(1)}`).join("L")}Z`;
    const ceilY = y(res.summary.ceiling).toFixed(1);
    const peak = res.fc.meanPath.find((p) => p.age === res.summary.peakAge);
    const nowX = x(res.summary.age).toFixed(1);
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-label="OVR history and forecast with 80% range">
      <defs><linearGradient id="fan" x1="0" x2="1"><stop offset="0" stop-color="var(--acc)" stop-opacity=".32"/><stop offset="1" stop-color="var(--acc)" stop-opacity=".1"/></linearGradient></defs>
      <line x1="${nowX}" x2="${nowX}" y1="2" y2="${H - 2}" stroke="currentColor" stroke-opacity=".15"/>
      <line x1="4" x2="${W - 4}" y1="${ceilY}" y2="${ceilY}" stroke="currentColor" stroke-opacity=".28" stroke-dasharray="3 3"/>
      <path d="${band}" fill="url(#fan)"/>
      ${hist.length > 1 ? `<path d="${line(hist)}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
      <path d="${line(fut)}" fill="none" stroke="var(--acc)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(res.summary.peakAge)}" cy="${y(peak ? peak.ovr : res.summary.peakOvr)}" r="3.6" fill="var(--bg)" stroke="var(--acc)" stroke-width="2"/>
    </svg>
    <div class="legend"><span><i></i>History</span><span><i class="f"></i>Forecast</span><span><i class="band"></i>80% range</span><span>- - Ceiling ${res.summary.ceiling}</span></div>`;
  }


  /**
   * Predicted OVR for the next seasons from the forecast (average of the simulations, with the 10th–90th
   * percentile range). Uses only the ratings you can see (scouting fog included).
   */
  function ovrPredictions(r, n = 4) {
    const path = r.fc.meanPath || [];
    const out = [];
    for (let i = 1; i <= n && i < path.length; i++) out.push({ season: r.summary.season + i, age: path[i].age, ovr: Math.round(path[i].ovr), lo: Math.round(path[i].lo), hi: Math.round(path[i].hi) });
    return out;
  }
  function predTable(r) {
    const rows = ovrPredictions(r);
    if (!rows.length) return "";
    const s = r.summary;
    // Shared scale for the range ribbons, so widening uncertainty is visible row to row.
    const lo0 = Math.min(s.ovr, ...rows.map((x) => x.lo)) - 2, hi0 = Math.max(...rows.map((x) => x.hi)) + 2;
    const ribbon = (x, a, b) => { const pc = (v) => ((v - a) / Math.max(1, b - a)) * 100; return `<div class="rib"><i style="left:${pc(x.lo).toFixed(1)}%;width:${(pc(x.hi) - pc(x.lo)).toFixed(1)}%"></i><b style="left:${pc(x.ovr).toFixed(1)}%"></b></div>`; };
    return `<div class="h">Predicted OVR</div><table><tr><th>Season</th><th>Age</th><th title="Expected OVR: the average of the simulations">OVR</th><th title="80% of simulations land in this range">Range</th><th title="Change from today">Δ</th></tr>
      ${rows.map((x) => `<tr><td>${x.season}</td><td>${x.age}</td><td><b>${x.ovr}</b></td><td title="${x.lo}–${x.hi}">${ribbon(x, lo0, hi0)}<small>${x.lo}–${x.hi}</small></td><td class="${x.ovr - s.ovr >= 2 ? "good" : x.ovr - s.ovr <= -2 ? "bad" : ""}">${x.ovr - s.ovr >= 0 ? "+" : ""}${x.ovr - s.ovr}</td></tr>`).join("")}</table>`;
  }

  const ATTR = [["hgt", "Height"], ["stre", "Strength"], ["spd", "Speed"], ["jmp", "Jumping"], ["endu", "Endurance"], ["ins", "Inside"], ["dnk", "Dunks/Layups"], ["ft", "Free throws"], ["fg", "Mid-range"], ["tp", "Three-pointers"], ["oiq", "Offensive IQ"], ["diq", "Defensive IQ"], ["drb", "Dribbling"], ["pss", "Passing"], ["reb", "Rebounding"]];
  const delta = (d, tip) => (d ? `<span class="dl ${d > 0 ? "up" : "dn"}" title="${esc(tip)}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>` : `<span class="dl mut" title="${esc(tip)}">–</span>`);
  // Every attribute with its change since last season, plus live changes since you opened the page. Refreshes as games are played.
  function attrTable(o) {
    const a = o.result.attrs;
    if (!a) return "";
    const base = st.ratingBase.get(`${o.lid}:${o.pid}`);
    const prev = a.prev;
    const liveD = (v, bv) => (base && bv != null ? v - bv : 0);
    const row = (k, label, v, pv, ld) => `<tr class="${o.fresh && o.fresh.has(k) ? "fresh" : ""}"><td>${label}</td><td><b>${v}</b></td><td>${pv == null ? `<span class="mut">–</span>` : delta(v - pv, `${pv} at the end of ${prev.season}`)}</td><td>${ld ? delta(ld, `${v - ld} when you first opened this player${base.season !== a.season ? ` (${base.season})` : ""}`) : ""}</td></tr>`;
    const liveN = ATTR.filter(([k]) => liveD(a.ratings[k], base && base.ratings[k])).length;
    const upd = new Date(o.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    return `${det("attrs", "", true)}<summary>Attributes <span class="mut">${prev ? `· vs ${prev.season}` : "· first season"}${liveN ? ` · <b class="good">${liveN} changed live</b>` : ""}</span></summary>
      <table class="attrs"><tr><th>Rating</th><th>Now</th><th title="Change since the end of last season">Season</th><th title="Change since you first opened this player (this browser session); updates automatically as games are played">Live</th></tr>
      ${row("ovr", "<b>Overall</b>", a.ovr, prev ? prev.ovr : null, liveD(a.ovr, base && base.ovr))}
      ${ATTR.map(([k, label]) => row(k, label, a.ratings[k], prev ? prev.ratings[k] : null, liveD(a.ratings[k], base && base.ratings[k]))).join("")}</table>
      <div class="why">Updates on its own as you play · last checked ${upd}${o.result.fog ? " · fog of war on (other teams' ratings are estimates)" : ""}</div></details>`;
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
      <div class="sub">Age ${s.age} · OVR ${s.ovr} · POT ${s.pot} · <span title="Scout POT: the forecast's most likely career-high OVR (median of ${r.fc.nSims.toLocaleString()} simulations of BBGM's progression rules). BBGM's own POT comes from only 20 simulations, so it can be noisy. It's above the year-by-year predictions because each simulated career peaks in a different season." class="${s.peakOvr - s.pot >= 3 ? "good" : s.peakOvr - s.pot <= -3 ? "bad" : ""}">Scout POT ${s.peakOvr}</span>${s.pos ? ` · ${esc(s.pos)}` : ""}${gem ? ` · <span class="chip ${gem.score >= 7 ? "gem" : gem.score <= -10 ? "over" : ""}" title="See the AI tab">${esc(gem.verdict)}</span>` : ""}</div>
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
      ${attrTable(o)}
      ${predTable(r)}
      ${sparkline(r)}
      <div class="why">${esc(r.confidence.reasons[0])}${r.fog ? " · fog on" : ""} · ${r.fc.nSims.toLocaleString()} sims</div>
      ${st.L && st.L.byPid.get(o.pid) && st.L.byPid.get(o.pid).p.tid === st.L.snap.userTid ? `<div class="rows" style="margin-top:6px"><div><span>Trade protection</span><span>${protectSelect("player", o.pid)}</span></div></div>` : ""}
      <div class="actions">
        <button data-h="${pin}" class="${o.pinned ? "on" : ""}">${o.pinned ? "★ Pinned" : "☆ Pin"}</button>
        <button data-h="${save}">Save report</button>
        <button data-h="${on(() => shareToReddit(...outlookPost(o)))}" title="Opens Reddit's post form with this outlook filled in. You review it and press Post yourself.">Share to Reddit</button>
      </div>`;
  }
  function pinSummary(o) {
    const s = o.result.summary;
    return { lid: o.lid, league: st.league || undefined, ...s, label: s.label, savedAt: Date.now(), url: location.pathname };
  }
  // quiet: refresh the open player in place (after games are played) without the loading screen or switching tabs.
  async function showPlayer(lid, pid, { quiet = false } = {}) {
    const old = st.outlook;
    const o = { lid, pid, loading: !quiet, key: progressKey(st.poll), at: Date.now() };
    if (quiet) { if (!old || old.pid !== pid || old.lid !== lid || !old.result) return; o.pinned = old.pinned; old.key = o.key; old.at = o.at; }
    else { st.outlook = o; st.tab = "outlook"; render(); }
    try {
      // Ask BBGM to write its in-memory changes to the database first, so the numbers are current.
      await B.call("main", "idbCacheFlush", undefined, 5000).catch(() => {});
      const ctx = await D.load(lid, [pid]);
      const p = ctx.players.get(pid);
      if (!p) throw new Error("This player isn't in the saved league data yet. Try again after the next game day.");
      if (st.outlook !== (quiet ? old : o)) return;
      o.result = A.analyze(ctx, p, settings);
      const bk = `${lid}:${pid}`, a = o.result.attrs;
      const base = st.ratingBase.get(bk);
      if (!base) st.ratingBase.set(bk, { season: a.season, ovr: a.ovr, ratings: { ...a.ratings }, at: Date.now() }); // "Live" = since you first opened this player
      // What changed since the last refresh, so the new numbers can be highlighted.
      const pa = quiet && old.result.attrs;
      o.fresh = new Set(pa ? Object.keys(a.ratings).filter((k) => a.ratings[k] !== pa.ratings[k]).concat(a.ovr !== pa.ovr ? ["ovr"] : []) : []);
      if (quiet) {
        o.loading = false;
        st.outlook = o;
        if (st.tab === "outlook" && !settings.panelCollapsed) render();
        if (o.pinned) S.refreshPin(pinSummary(o));
        // Highlight changed rows once; later re-renders (theme, tabs) shouldn't replay the flash.
        if (o.fresh.size) setTimeout(() => { o.fresh = null; }, 2500);
        return;
      }
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
      html += `<div class="msg">Turn on "Ask Claude" in Courtside settings and add an Anthropic API key to ask free-form questions (for example, "Who should I build around?").</div>`;
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
      if (td.due) td.mark(st.pending.filter((a) => a.kind === "trade").length);
    } catch (e) { st.flash = e.message; }
    render();
  }
  /** An expandable section that stays open/closed across re-renders (the panel redraws on every change). */
  const det = (key, cls = "", dflt = false) => `<details data-key="${esc(key)}"${cls ? ` class="${cls}"` : ""}${(st.openDetails[key] ?? dflt) ? " open" : ""}>`;
  const exHtml = (ex, key) => !ex ? "" : `${det(`why:${key}`, "ex")}<summary>Why</summary><div>${esc(ex.why || "")}${ex.strategy ? ` <span class="chip">${esc(ex.strategy)}</span>` : ""} <span class="mut">(${esc(ex.basis || "projected")})</span></div>
    ${ex.benefits && ex.benefits.length ? `<div><b>Benefits</b><ul>${ex.benefits.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}
    ${ex.costs && ex.costs.length ? `<div><b>Costs</b><ul>${ex.costs.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}</details>`;

  // ======================================================================
  // Share to Reddit: opens Reddit's own post form, pre-filled. Nothing is posted until you press Post there;
  // no Reddit login or token ever touches the extension.
  // ======================================================================
  const REPO = "https://github.com/topcommentgodyt-prog/bbgm-scout";
  const footer = `\n\n---\n*Made with [Courtside](${REPO}), a free browser extension for Basketball GM.*`;
  function shareToReddit(title, text) {
    const sub = String(settings.redditSub || "BasketballGM").replace(/^\/?r\//i, "").replace(/[^A-Za-z0-9_]/g, "") || "BasketballGM";
    let body = text + footer;
    if (body.length > 6000) body = `${body.slice(0, 5900)}\n\n…${footer}`; // keep the link a sane length
    // old.reddit's submit form reliably pre-fills a text post from the URL (selftext=true&title=…&text=…).
    const url = `https://old.reddit.com/r/${sub}/submit?selftext=true&title=${encodeURIComponent(title.slice(0, 300))}&text=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener");
  }
  function outlookPost(o) {
    const r = o.result, s = r.summary;
    const preds = ovrPredictions(r);
    const title = `${s.name} (${s.age}, ${s.ovr} OVR / ${s.pot} POT): projected ${preds.map((x) => x.ovr).join(" → ")}, Scout POT ${s.peakOvr}`;
    const lines = [
      `**${s.name}**: age ${s.age}, ${s.ovr} OVR, BBGM POT ${s.pot}${s.pos ? `, ${s.pos}` : ""}. Outlook: ${s.label}.`,
      "",
      "| Season | Age | Expected OVR | 80% range |", "|---|---|---|---|",
      ...preds.map((x) => `| ${x.season} | ${x.age} | ${x.ovr} | ${x.lo}–${x.hi} |`),
      "",
      `- Scout POT (typical career high): **${s.peakOvr}** (BBGM POT ${s.pot}), ceiling (90th pct) ${s.ceiling}, peak age ${s.peakAge}`,
      `- Breakout chance next season ${pct(s.breakout)}, decline risk ${pct(s.decline)}, bust risk ${pct(s.bust)}`,
      `- Forecast confidence: ${s.confidence}`,
      "",
      `*From ${r.fc.nSims.toLocaleString()} simulations of BBGM's progression rules, using only ratings visible to the team.*`,
    ];
    return [title, lines.join("\n")];
  }
  function summaryPost(sm) {
    const n = sm.seasons.length;
    const pctS = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
    const title = `Let Autopilot run my team for ${n} season${n === 1 ? "" : "s"}: ${sm.titles} title${sm.titles === 1 ? "" : "s"}, ${sm.playoffApps} playoff appearance${sm.playoffApps === 1 ? "" : "s"}, ${pctS(sm.winPct)} wins`;
    const lines = [
      `${sm.from}–${sm.to}, run by Courtside's Autopilot (strategy, trades, contracts, draft and minutes all automatic).`,
      "",
      "| Season | Record | Playoffs | Strategy |", "|---|---|---|---|",
      ...sm.seasons.map((x) => `| ${x.season} | ${x.won}-${x.lost}${x.tied ? `-${x.tied}` : ""} | ${x.playoffs} | ${x.strategy || ""} |`),
      "",
      `- Championships: **${sm.titles}**, playoff appearances: ${sm.playoffApps} of ${n}, regular-season win%: ${pctS(sm.winPct)}`,
      `- Trades: ${sm.trades.count}; signed ${sm.moves.signings}, re-signed ${sm.moves.resignings}, released ${sm.moves.releases}`,
      sm.payrollPerWin != null ? `- Salary per win: ${F.fmtMoney(sm.payrollPerWin)} (league average ${F.fmtMoney(sm.leaguePayrollPerWin)})` : "",
      sm.drafts.length ? `- Draft picks: ${sm.drafts.length}` : "",
    ].filter((l) => l !== "");
    return [title, lines.join("\n")];
  }

  function summaryHtml(sm) {
    if (!sm) return "";
    const pct = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
    const m = (x) => (x == null ? "–" : F.fmtMoney(x));
    const t = sm.trades;
    return `${det("summary", "card", !!st.ap.justFinished)}<summary><b>Last Autopilot run</b> · ${sm.from}${sm.to !== sm.from ? `–${sm.to}` : ""} · ${sm.seasons.length} season${sm.seasons.length === 1 ? "" : "s"} with games</summary>
      <table class="sum">
        <tr><td>Championships</td><td><b>${sm.titles}</b></td></tr>
        <tr><td>Playoff appearances</td><td>${sm.playoffApps} of ${sm.seasons.length}</td></tr>
        <tr><td>Regular-season win %</td><td>${pct(sm.winPct)}</td></tr>
        <tr><td>Salary spent per win</td><td>${m(sm.payrollPerWin)} <small class="mut">(league average ${m(sm.leaguePayrollPerWin)}, for reference)</small></td></tr>
        <tr><td>Trades</td><td>${t.count}${t.withNumbers ? ` <small class="mut">(projected at the time: ${t.projectedNow >= 0 ? "+" : ""}${t.projectedNow.toFixed(1)} rating now, ${t.projectedFuture >= 0 ? "+" : ""}${t.projectedFuture.toFixed(1)} future, summed)</small>` : ""}</td></tr>
        <tr><td>Other moves</td><td>${sm.moves.signings} signed, ${sm.moves.resignings} re-signed, ${sm.moves.letWalk} let go, ${sm.moves.releases} released${sm.moves.errors ? `, <span class="bad">${sm.moves.errors} failed</span>` : ""}</td></tr>
        <tr><td>Roster turnover</td><td>${sm.turnover} of ${sm.rosterStartSize} starting players gone</td></tr>
      </table>
      ${sm.drafts.length ? `${det("summary:drafts")}<summary>Draft picks (${sm.drafts.length})</summary><div class="ex"><ul>${sm.drafts.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div></details>` : ""}
      ${sm.strategyChanges.length ? `${det("summary:strategy")}<summary>Strategy changes (${sm.strategyChanges.length})</summary><div class="ex"><ul>${sm.strategyChanges.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div></details>` : ""}
      ${sm.seasons.length ? `${det("summary:seasons")}<summary>Season by season</summary><table class="sum"><tr><th>Season</th><th>Record</th><th>Playoffs</th><th>Strategy</th></tr>${sm.seasons.map((x) =>
        `<tr><td>${x.season}</td><td>${x.won}-${x.lost}${x.tied ? `-${x.tied}` : ""}</td><td class="${x.champion ? "good" : ""}">${esc(x.playoffs)}</td><td>${esc(x.strategy || "")}</td></tr>`).join("")}</table></details>` : ""}
      <div class="why">Observed results from BBGM's records. League averages are context only; this isn't a comparison against what would have happened without Autopilot.</div>
      <div class="actions"><button class="sm" data-h="${on(() => shareToReddit(...summaryPost(sm)))}" title="Opens Reddit's post form with this summary filled in. You review it and press Post yourself.">Share to Reddit</button></div>
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
      <label class="full">Style<select data-set="managerStyle" title="Standard: the usual manager. Moneyball: every trade, signing and re-signing is also judged on salary, priced at this league's market rate per point of team rating.">
        <option value="standard"${settings.managerStyle !== "moneyball" ? " selected" : ""}>Standard</option>
        <option value="moneyball"${settings.managerStyle === "moneyball" ? " selected" : ""}>Moneyball: value per dollar</option></select></label>
      ${settings.managerStyle === "moneyball" && L && L.moneyRate ? `<div class="full why" style="margin-top:-4px">Market rate in this league: ${F.fmtMoney(L.moneyRate.perPoint)} per point of team rating (${F.fmtMoney(L.moneyRate.perWin)} per win). Salary added or saved counts at that rate, overpaid contracts are shopped first, and free agents and re-signings above it are passed on.</div>` : ""}
      <div class="full">${stratNow ? `${det("strategy", "ex")}<summary>${esc(stratNow.label)}: ${esc(stratNow.goal)}</summary><ul>${(stratNow.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : ""}</div>
      <span class="mut">${waiting ? `<span class="warn">${waiting} move${waiting === 1 ? "" : "s"} waiting for your OK</span>` : "No approvals waiting"}</span>
      ${settings.features.autopilot ? `<span style="text-align:right">${st.ap.running ? `<button data-h="${on(() => stopAutopilot())}">Stop</button>` : `<button class="pri" data-h="${on(() => startAutopilot())}">Run Autopilot</button>`}</span>` : "<span></span>"}
    </div>
    ${settings.features.autopilot && st.ap.running ? `<div class="banner acc">${esc(st.ap.status || "Running…")}</div>` : st.ap.status ? `<div class="why">${esc(st.ap.status)}</div>` : ""}
    ${det("advanced")}<summary>Advanced settings</summary><div class="adv">
      <label>Manager mode<select data-set="managerMode"><option value="suggest"${settings.managerMode !== "auto" ? " selected" : ""}>Suggest (you approve)</option><option value="auto"${settings.managerMode === "auto" ? " selected" : ""}>Fully automatic</option></select></label>
      ${settings.features.autopilot ? `<label>Autopilot step<select data-set="apStep"><option value="day"${settings.apStep !== "week" ? " selected" : ""}>A day</option><option value="week"${settings.apStep === "week" ? " selected" : ""}>A week</option></select></label>
      <label>Stop at checkpoint<select data-set="apStopAt">${[["never", "Never"], ["playoffs", "Playoffs"], ["draft", "Draft"], ["freeAgency", "Free agency"]].map(([k, l]) => `<option value="${k}"${settings.apStopAt === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
      ${settings.features.autopilot ? `<label title="Fully automatic: Autopilot also makes moves involving Ask-first players or picks, and moves that break your contract rules. Never-trade players are still never traded, cut or let go.">Moves that need your OK<select data-set="apAutoApprove"><option value="true"${settings.apAutoApprove !== false && settings.apAutoApprove !== "false" ? " selected" : ""}>Autopilot makes them</option><option value="false"${settings.apAutoApprove === false || settings.apAutoApprove === "false" ? " selected" : ""}>Pause for me</option></select></label>
      <label class="row" title="When BBGM fires you, Autopilot takes over the strongest team BBGM offers (the worst records, or any team in God Mode) and keeps playing. Off: Autopilot stops so you can choose."><input type="checkbox" data-set="apAutoNewTeam"${isOn(settings.apAutoNewTeam) ? " checked" : ""}> Auto-pick a new team when fired</label>
      <label class="row" title="Opens unread inbox messages (like the owner's Annual performance evaluation) during and after the run, so you don't have to click through them before BBGM lets you play again."><input type="checkbox" data-set="apAutoReadMessages"${isOn(settings.apAutoReadMessages) ? " checked" : ""}> Auto-read owner messages</label>` : ""}
      ${tradeAutoHtml()}
    </div></details></div>`;

    html += liveHtml();
    html += faCheckHtml();

    if (settings.features.manager || settings.features.autopilot) {
      const refresh = on(() => { st.pending = null; st.queueSel = new Set(); invalidate(); render(); refreshPending(); });
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
        // Action queue: tick the moves you want, then run them together. Each is re-checked against the game
        // state right before it runs, and the rest stop if the game moved on.
        st.queueSel = st.queueSel || new Set();
        const selActs = st.pending.filter((a) => st.queueSel.has(a.sig));
        const runSel = on(async (el) => {
          el.disabled = true;
          const acts = st.pending.filter((a) => st.queueSel.has(a.sig));
          st.pending = st.pending.filter((a) => !st.queueSel.has(a.sig)); st.queueSel = new Set(); render();
          await after(await F.runActions(acts, { stateKey: planKey, check }));
        });
        const selAll = on(() => { const allOn = st.pending.every((a) => st.queueSel.has(a.sig)); st.queueSel = allOn ? new Set() : new Set(st.pending.map((a) => a.sig)); render(); });
        html += st.pending.map((a, i) => {
          const one = on(async (el) => { el.disabled = true; const [x] = st.pending.splice(i, 1); render(); await after(await F.runActions([x], { stateKey: planKey, check })); });
          const skip = on(() => { st.pending.splice(i, 1); st.queueSel.delete(a.sig); render(); });
          return `<div class="card"><div class="hd"><span>${st.ap.running ? "" : `<input type="checkbox" class="q" data-q="${esc(a.sig)}"${st.queueSel.has(a.sig) ? " checked" : ""} aria-label="Select this move"> `}<span class="chip">${esc(a.kind)}</span> ${linkText(a.text, a.pids)}${a.approval ? `<div class="warn-line">Needs your OK: ${esc(a.why || "protected asset")}</div>` : ""}</span></div>
            ${exHtml(a.ex, `p:${a.sig}`)}<div class="actions"><button class="sm pri" data-h="${one}">Do it</button><button class="sm" data-h="${skip}">Skip</button></div></div>`;
        }).join("") + (st.ap.running ? "" : `<div class="actions"><button class="sm" data-h="${selAll}">${st.pending.every((a) => st.queueSel.has(a.sig)) ? "Clear selection" : "Select all"}</button><button class="pri" data-h="${runSel}"${selActs.length ? "" : " disabled"}>Run selected (${selActs.length})</button><button data-h="${all}">Do all ${st.pending.length}</button></div>`);
      }
      html += `<div class="actions"><button class="sm" data-h="${refresh}">Re-plan</button></div>`;
    }
    if (st.apSummary) html += summaryHtml(st.apSummary);
    // Timeline: the activity log with filters by kind of event.
    html += `<div class="h">Timeline</div>`;
    const clear = on(async () => { await S.clearLog(); st.log = []; render(); });
    const f = st.logFilter || "all";
    const chips = Object.entries(TIMELINE).map(([k, t]) => `<button class="sm${f === k ? " on" : ""}" data-h="${on(() => { st.logFilter = k; render(); })}">${t.label}</button>`).join("");
    const shown = st.log.filter((e) => f === "all" || TIMELINE[f].kinds.includes(e.kind));
    html += `<div class="chips">${chips}</div>`;
    html += shown.length ? `<div class="log">${shown.slice(0, 60).map((e) => {
      const u = e.undoKey != null && !e.undone ? on(async (el) => { el.disabled = true; try { await B.call("undoLog", "undo", e.undoKey); await S.markUndone(e.t); st.log = await S.getLog(); st.flash = "Undone."; } catch (err) { st.flash = `Can't undo: ${err.message}`; } invalidate(); render(); setTimeout(() => { st.flash = ""; render(); }, 6000); }) : null;
      return `<div><span class="${e.kind === "error" ? "bad" : ""}">${linkText(e.text, e.pids)}${e.undone ? ` <small class="mut">(undone)</small>` : ""}${exHtml(e.ex, `l:${e.t}`)}</span><span>${u ? `<button class="sm" data-h="${u}">Undo</button> ` : ""}<time>${new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></span></div>`;
    }).join("")}</div><div class="actions"><button class="sm" data-h="${clear}">Clear log</button></div>` : `<div class="msg">${f === "all" ? "No actions yet." : "Nothing of this kind yet."}</div>`;
    return html;
  }
  const TIMELINE = {
    all: { label: "All", kinds: [] },
    trade: { label: "Trades", kinds: ["trade"] },
    roster: { label: "Signings", kinds: ["sign", "resign", "letwalk", "release"] },
    draft: { label: "Draft", kinds: ["draft"] },
    season: { label: "Seasons", kinds: ["season", "title", "league"] },
    strategy: { label: "Strategy", kinds: ["strategy"] },
    error: { label: "Problems", kinds: ["error"] },
  };

  /**
   * Automatic trade bar and search timing (Manager → Advanced settings; read-only). These replace the old
   * "Minimum trade improvement" and "Search for trades every N game days" inputs: see features.js tradeBar / tradeDue.
   */
  function tradeAutoHtml() {
    const L = st.L;
    if (!L) return "";
    const key = `${st.LKey}:${(st.log[0] || {}).t || 0}`;
    if (!st.tradeAuto || st.tradeAuto.key !== key) {
      if (!st.tradeAutoBusy) {
        st.tradeAutoBusy = true;
        F.tradeStatus(lidNow(), L, settings).then((s) => { st.tradeAuto = { key, ...s }; }).catch(() => {}).finally(() => { st.tradeAutoBusy = false; render(); });
      }
      if (!st.tradeAuto) return "";
    }
    const t = st.tradeAuto;
    const wins = (t.bar.min * ((L.snap.ga && L.snap.ga.numGames) || 82) * 0.033).toFixed(1);
    const search = t.closed ? `paused: ${t.closed}` : t.due ? `due now (${t.why})` : `in ~${t.nextIn} game day${t.nextIn === 1 ? "" : "s"}`;
    return `<div class="tradeauto">
      <div class="ta-row"><span>Minimum trade improvement</span><b>${t.bar.min.toFixed(2)} <small class="mut">auto · ~${wins} wins</small></b></div>
      <div class="why" style="margin-top:0">${t.bar.why.map(esc).join(" · ")}</div>
      <div class="ta-row"><span>Next trade search</span><b>${esc(search)}</b></div>
      <div class="why" style="margin-top:0">Searches at once when the roster, phase or strategy changes, and every game day in the last week before the deadline; otherwise every ${t.interval} game day${t.interval === 1 ? "" : "s"} for this strategy${t.empty ? `, slower after ${t.empty} search${t.empty === 1 ? "" : "es"} that found nothing worth doing` : ""}.</div>
    </div>`;
  }

  /** Free agency checker (Manager tab): roster vs limits, cap room, best fits, and whether Autopilot keeps shopping. */
  function faCheckHtml() {
    if (!st.L) return "";
    const L = st.L, ph = L.snap.phase;
    let fa;
    try { fa = F.freeAgencyCheck(L, settings, st.poll); } catch (e) { return ""; }
    const relevant = ph === PH_.RESIGN_PLAYERS || ph === PH_.FREE_AGENCY || ph === PH_.PRESEASON || fa.issues.length;
    if (!relevant) return "";
    const space = !Number.isFinite(fa.capSpace) ? "no cap" : fa.capSpace >= 0 ? `${F.fmtMoney(fa.capSpace)} under the cap` : `${F.fmtMoney(-fa.capSpace)} over the cap`;
    return `<div class="card"><div class="hd"><b>Free agency check</b><span class="chip ${fa.issues.length ? "over" : "gem"}">${fa.issues.length ? `${fa.issues.length} issue${fa.issues.length === 1 ? "" : "s"}` : "OK"}</span></div>
      <div class="rows">
        <div><span>Roster</span><span>${fa.rosterSize} (min ${fa.min}, max ${fa.max})${fa.openSpots ? ` · ${fa.openSpots} open` : ""}</span></div>
        <div><span>Cap</span><span>${esc(space)}${fa.minDealsOnly ? " · minimum deals only" : ""}</span></div>
        ${fa.daysLeft != null && ph === PH_.FREE_AGENCY ? `<div><span>Free agency</span><span>${fa.daysLeft} days left${fa.keepShopping ? " · Autopilot keeps shopping" : ""}</span></div>` : ""}
      </div>
      ${fa.issues.map((t) => `<div class="warn-line">${esc(t)}</div>`).join("")}
      ${fa.best.length ? `<div class="why">Best fits: ${fa.best.slice(0, 3).map((f) => `${plink(f.pid, f.name)} (OVR ${f.s.ovr}, ${F.fmtMoney(f.ask)}${f.canSign ? "" : `, ${esc(f.why.toLowerCase())}`})`).join(", ")}</div>` : ""}
      <div class="why">During free agency Autopilot goes day by day while you have open spots and players worth signing (asking prices fall over the 30 days), and the roster is always brought to BBGM's minimum before games.</div></div>`;
  }

  /** Autopilot live: seasons completed, where the run is now, season results and the latest moves. */
  function liveHtml() {
    const ap = st.ap;
    if (!settings.features.autopilot || (!ap.running && !(ap.seasonLog || []).length)) return "";
    const done = (ap.seasonLog || []).length, target = Number(settings.apSeasons) || 1;
    const pctDone = Math.min(100, Math.round((done / target) * 100));
    const el = ap.runStart ? (Date.now() - ap.runStart) / 1000 : 0;
    const fmtT = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
    const per = done ? el / done : null;
    const lv = ap.live;
    const titles = (ap.seasonLog || []).filter((r) => r.champion).length;
    const recent = (S.runLogEntries ? S.runLogEntries() : []).filter((e) => e.kind !== "minutes" && e.text).slice(-5).reverse(); // newest first
    return `<div class="card live"><div class="hd"><b>Autopilot ${ap.running ? "live" : "run"}</b><span class="chip ${ap.running ? "gem" : ""}">${ap.running ? "● running" : "finished"}</span></div>
      <div class="rows">
        <div><span>Seasons completed</span><span>${done} of ${target}${titles ? ` · 🏆 ${titles}` : ""}</span></div>
      </div><div class="bar"><i style="width:${pctDone}%"></i></div>
      <div class="rows" style="margin-top:4px">
        ${lv ? `<div><span>Now</span><span>${lv.season} · ${esc(PHASE_NAME[lv.phase] || "")}${lv.phase >= 1 && lv.phase <= 3 ? ` · ${lv.won}-${lv.lost}` : ""}</span></div>` : ""}
        <div><span>Elapsed</span><span>${fmtT(el)}${per ? ` · ${fmtT(per)} per season` : ""}${per && ap.running && target > done ? ` · ~${fmtT(per * (target - done))} left` : ""}</span></div>
      </div>
      ${done ? `<table class="sum" style="margin-top:6px"><tr><th>Season</th><th>Record</th><th>Result</th></tr>${ap.seasonLog.slice(-5).reverse().map((r) => `<tr><td>${r.season}${r.team ? ` <small>${esc(r.team)}</small>` : ""}</td><td>${r.won}-${r.lost}</td><td>${r.champion ? "🏆 " : ""}${esc(r.result)}</td></tr>`).join("")}</table>` : ""}
      ${recent.length ? `<div class="h" style="margin-top:8px">Latest moves</div><div class="log">${recent.map((e) => `<div><span>${linkText(e.text, e.pids)}</span></div>`).join("")}</div>` : ""}
    </div>`;
  }


  // ======================================================================
  // Front-office extras: loaded alongside the league model (owner mood, accuracy, watchlist, class history)
  // ======================================================================
  const lsKey = (k) => `${k}:${st.league || `lid${lidNow()}`}`;
  async function loadOwner(force) {
    const k = st.poll ? `${st.poll.season}:${st.poll.phase}:${Math.floor((st.poll.gp || 0) / 5)}` : "";
    if (!force && st.owner && st.ownerKey === k) return st.owner;
    try { st.owner = await B.ownerInfo(); st.ownerKey = k; } catch (e) { st.owner = null; }
    return st.owner;
  }
  /** Runs after every league-model build: job security, forecast records, draft-class history, watchlist alerts. */
  async function afterBuild(L) {
    if (!IN) return;
    try { st.job = IN.jobSecurity(L, await loadOwner()); } catch (e) { st.job = null; }
    // #16: record next-season forecasts once per season (regular season), grade them later.
    try {
      if (L.snap.phase === PH_.REGULAR_SEASON) {
        const acc = (await S.localGet(lsKey("acc"))) || {};
        if (!acc[L.snap.season]) {
          acc[L.snap.season] = { model: S.MODEL_VERSION, players: IN.forecastRecord(L) };
          for (const s of Object.keys(acc).map(Number).sort((a, b) => a - b).slice(0, -6)) delete acc[s]; // keep six seasons
          await S.localSet(lsKey("acc"), acc);
        }
        st.acc = acc;
      } else if (!st.acc) st.acc = (await S.localGet(lsKey("acc"))) || {};
    } catch (e) { /* storage full or unavailable */ }
    // #9: remember each draft class's strength (before the draft) to compare future classes against.
    try {
      const hist = (await S.localGet(lsKey("classes"))) || [];
      if (L.snap.phase <= PH_.DRAFT && !hist.some((h) => h.year === L.draftSeason)) {
        const cs = IN.classStats(L, L.draftSeason);
        if (cs && (L.snap.phase >= PH_.PLAYOFFS)) { hist.push(cs); await S.localSet(lsKey("classes"), hist.slice(-20)); }
      }
      IN.setClassHistory(hist);
    } catch (e) { /* ignore */ }
    // Realism automation when you play yourself (any tab); during Autopilot the run loop does it before planning.
    if (!st.ap.running) {
      try { if (await autoRealism(L)) { invalidate(); st.pending = null; st.trades.ideas = null; render(); } } catch (e) { /* logged inside */ }
    }
    // #17: watchlist alerts for pinned players in this league.
    try {
      const pins = (await S.getPins()).filter((p) => !p.league || p.league === st.league || p.lid === lidNow()).map((p) => Number(p.pid)).filter((x) => Number.isFinite(x));
      if (pins.length) {
        const prev = (await S.localGet(lsKey("watch"))) || {};
        const { alerts, state } = IN.watchAlerts(L, pins, prev);
        await S.localSet(lsKey("watch"), state);
        if (alerts.length) {
          const list = (await S.localGet(lsKey("alerts"))) || [];
          const stamp = `${L.snap.season} ${PHASE_NAME[L.snap.phase] || ""}`.trim();
          list.unshift(...alerts.map((a) => ({ ...a, when: stamp, t: Date.now() })));
          await S.localSet(lsKey("alerts"), list.slice(0, 40));
        }
        st.alerts = (await S.localGet(lsKey("alerts"))) || [];
      } else st.alerts = (await S.localGet(lsKey("alerts"))) || [];
    } catch (e) { /* ignore */ }
  }
  const PH_ = { EXPANSION_DRAFT: -2, FANTASY_DRAFT: -1, PRESEASON: 0, REGULAR_SEASON: 1, AFTER_TRADE_DEADLINE: 2, PLAYOFFS: 3, DRAFT_LOTTERY: 4, DRAFT: 5, AFTER_DRAFT: 6, RESIGN_PLAYERS: 7, FREE_AGENCY: 8 };
  const PHASE_NAME = { 0: "preseason", 1: "regular season", 2: "after the deadline", 3: "playoffs", 4: "before the draft", 5: "draft", 6: "after the draft", 7: "re-signing", 8: "free agency" };

  // ======================================================================
  // #19 Diagnostics: is everything Courtside needs still there in this version of BBGM?
  // ======================================================================
  const CAPS = {
    "Autopilot (play menu)": ["playMenu.day", "playMenu.week", "playMenu.untilRegularSeason", "playMenu.untilEndOfRound", "playMenu.untilDraft", "playMenu.untilResignPlayers", "playMenu.untilFreeAgency", "playMenu.untilPreseason", "playMenu.stop"],
    "Trades": ["main.getTradingBlockOffers", "main.createTrade", "main.proposeTrade", "main.tradeCounterOffer", "main.clearTrade"],
    "Signings and re-signing": ["main.acceptContractNegotiation", "main.cancelContractNegotiation", "main.releasePlayer"],
    "Lineup, minutes, finances": ["main.updatePlayingTime", "main.updateKeepRosterSorted", "main.updateBudget"],
    "Draft": ["main.draftUser"],
    "Fired → new team": ["main.switchTeam"],
    "Undo": ["undoLog.undo"],
  };
  async function runDiagnostics() {
    const d = { at: Date.now(), checks: [], groups: {} };
    const t0 = performance.now();
    try { const p = await B.poll(); d.checks.push({ name: "Data bridge (BBGM worker)", ok: !!p.inLeague, detail: p.inLeague ? `answered in ${Math.round(performance.now() - t0)} ms` : "not in a league" }); }
    catch (e) { d.checks.push({ name: "Data bridge (BBGM worker)", ok: false, detail: e.message }); }
    try {
      const all = Object.values(CAPS).flat();
      const r = await B.capabilities(all);
      for (const [g, names] of Object.entries(CAPS)) {
        const missing = names.filter((n) => !r.have[n]);
        d.groups[g] = !missing.length;
        d.checks.push({ name: g, ok: !missing.length, detail: missing.length ? `missing in this BBGM version: ${missing.join(", ")}` : "all actions available" });
      }
    } catch (e) { d.checks.push({ name: "Game actions", ok: false, detail: e.message }); }
    try { const t1 = performance.now(); const snap = await B.snapshot(); d.checks.push({ name: "League snapshot", ok: Array.isArray(snap.players) && snap.players.length > 0, detail: `${snap.players.length} players in ${Math.round(performance.now() - t1)} ms` }); }
    catch (e) { d.checks.push({ name: "League snapshot", ok: false, detail: e.message }); }
    try {
      const v = st.L && [...st.L.byPid.values()].find((x) => !x.prospect);
      d.checks.push({ name: "Simulation engine", ok: !!(v && v.fc && v.fc.meanPath && v.fc.meanPath.length > 1), detail: v ? `forecasts ready (${st.L.byPid.size} players)` : "league model not built yet" });
    } catch (e) { d.checks.push({ name: "Simulation engine", ok: false, detail: e.message }); }
    const sync = await S.status();
    d.checks.push({ name: "Settings sync", ok: sync.mode !== "error", detail: sync.text });
    const ga = (st.L && st.L.snap.ga) || {};
    const ch = ["challengeNoTrades", "challengeNoFreeAgents", "challengeNoDraftPicks", "challengeNoRatings", "challengeFiredLuxuryTax", "challengeFiredMissPlayoffs", "challengeLoseBestPlayer"].filter((k) => ga[k]);
    d.checks.push({ name: "Challenge modes", ok: true, detail: ch.length ? `on: ${ch.map((k) => k.replace("challenge", "")).join(", ")} (the manager follows them)` : "none" });
    st.diag = d;
    return d;
  }
  /** Before Autopilot starts: refuse if BBGM is missing what it needs (instead of failing mid-run). */
  async function preflight() {
    const d = await runDiagnostics().catch(() => null);
    if (!d) return null;
    if (d.groups["Autopilot (play menu)"] === false) return "this BBGM version is missing play-menu actions Autopilot needs (see Insights → Diagnostics)";
    return null;
  }

  // ======================================================================
  // Office tab: job security, upcoming decisions, re-sign risk, watchlist, objectives, compact mode
  // ======================================================================
  function officeBody() {
    const wait = needL();
    if (wait) return wait;
    const L = st.L;
    let html = "";
    const job = st.job;
    html += `<div class="h">Job security</div>`;
    if (!job) { html += `<div class="msg">Reading the owner's mood…</div>`; loadOwner(true).then((o) => { st.job = IN.jobSecurity(L, o); render(); }); }
    else {
      const label = { none: "God Mode: you can't be fired", grace: `Grace period until ${job.graceEnd}`, fired: "On pace to be FIRED at season's end", high: "High risk", medium: "Some risk", low: "Safe" }[job.risk];
      if (job.inGrace) html += `<div class="why" style="margin-top:0">The owner starts counting in ${job.graceEnd}. Until then this shows what the owner would think of this season.</div>`;
      const f2 = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
      html += `<div class="card"><div class="hd"><b>${job.security}%</b><span class="chip ${job.risk === "fired" || job.risk === "high" ? "over" : job.risk === "low" || job.risk === "none" ? "gem" : ""}">${esc(label)}</span></div>
        <div class="meter"><b style="left:${job.security}%"></b></div>
        <table><tr><th>Owner cares about</th><th>So far</th><th>${job.seasonDone ? "" : "This season (proj.)"}</th></tr>
        ${["wins", "playoffs", "money"].map((k) => `<tr><td>${k[0].toUpperCase() + k.slice(1)}</td><td>${f2(job.base[k])}</td><td>${job.deltas ? f2(job.deltas[k]) : ""}</td></tr>`).join("")}
        <tr><td><b>Total</b></td><td><b>${f2(job.now)}</b></td><td><b>${job.seasonDone ? "" : `→ ${f2(job.total)}`}</b></td></tr></table>
        <div class="why">BBGM fires you when the total drops below −1 at the end of a season (after the grace period). Each part is capped at +1, so you can't win the owner over with money alone.</div>
        ${job.tips.length ? `<ul>${job.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</div>`;
    }
    html += `<div class="h">Coming up</div>`;
    const dec = IN.decisions(L, { job });
    html += dec.length ? dec.map((x) => `<div class="dec${x.urgent ? " urgent" : ""}"><span class="when">${esc(x.when)}</span><span style="flex:1">${esc(x.text)}</span><a href="#" data-h="${on(() => { st.tab = x.tab; render(); onTabOpen(x.tab); })}">Go</a></div>`).join("") : `<div class="msg">Nothing urgent.</div>`;
    html += `<div class="h">Re-signing risk</div>`;
    const rr = IN.resignRisks(L);
    html += rr.length ? `<table><tr><th>Player</th><th>Willing</th><th>Asks</th></tr>${rr.map((r) => `<tr><td>${plink(r.pid, r.name)}${r.key ? ` <span class="chip">core</span>` : ""}<small>${r.age} yo · OVR ${r.ovr} · expires ${r.exp}${r.traits.length ? ` · ${esc(r.traits.map((t) => IN.TRAIT[t] || t).join(", "))}` : ""}</small></td>
      <td class="${r.risk === "high" ? "no" : r.risk === "low" ? "ok" : ""}">${r.probWilling == null ? "?" : Math.round(r.probWilling * 100) + "%"}</td><td>${r.ask ? F.fmtMoney(r.ask) : "–"}</td></tr>`).join("")}</table>
      <div class="why">BBGM's own willingness estimate (mood: facilities, winning, hype, playing time, trades, traits). It changes during the season; Autopilot shops core players who are unlikely to stay before the deadline${settings.teamMode === "winnow" || (L.strategy && L.strategy.key === "winnow") ? " (except while going all-in)" : ""}.</div>` : `<div class="msg">No contracts ending soon.</div>`;
    html += `<div class="h">Watchlist alerts</div>`;
    const al = st.alerts || [];
    html += al.length ? `<div class="log">${al.slice(0, 15).map((a) => `<div><span>${linkText(a.text, [a.pid])}</span><time>${esc(a.when || "")}</time></div>`).join("")}</div>` : `<div class="msg">Pin players (★ on their Outlook card) to get alerts when they break out, decline, move, hit free agency, get hurt or near the end of their contract.</div>`;
    // #13 Franchise objectives
    const ob = settings.objectives || {};
    html += `<div class="h">Franchise objectives</div><div class="card adv" style="margin-top:0">
      <label>Win a title by season <input type="number" data-obj="titleBy" min="0" max="3000" value="${Number(ob.titleBy) || 0}" title="0 = no deadline"></label>
      <label class="row"><input type="checkbox" data-obj="underTax"${isOn(ob.underTax) ? " checked" : ""}> Stay under the luxury tax</label>
      <label class="row"><input type="checkbox" data-obj="keepFirsts"${isOn(ob.keepFirsts) ? " checked" : ""}> Never trade first-round picks</label>
      <label class="row"><input type="checkbox" data-obj="starDraft"${isOn(ob.starDraft) ? " checked" : ""}> Draft for a future star (rank prospects by ceiling)</label>
      <div class="why">The manager and Autopilot follow these: the title deadline pushes Auto toward Contend / Win Now as it nears; the tax and pick goals rule out trades, signings and re-signings that break them.${Number(ob.titleBy) > 0 && Number(ob.titleBy) < L.snap.season ? " <b>The title deadline has passed.</b>" : ""}</div></div>`;
    // #18 Compact mode
    const metrics = settings.compactMetrics || [];
    html += `<div class="h">Compact mode</div><div class="card adv" style="margin-top:0">
      <label class="row"><input type="checkbox" data-set="compactMode"${isOn(settings.compactMode) ? " checked" : ""}> Show a mini panel with three metrics</label>
      <div class="why">Pick up to three:</div>
      ${Object.entries(METRICS).map(([k, m]) => `<label class="row"><input type="checkbox" data-cmetric="${k}"${metrics.includes(k) ? " checked" : ""}${!metrics.includes(k) && metrics.length >= 3 ? " disabled" : ""}> ${esc(m.label)}</label>`).join("")}</div>`;
    return html;
  }

  // ======================================================================
  // Insights tab: lineup synergy, playoff scout, draft class, rivals, legacy, accuracy, benchmark, diagnostics
  // ======================================================================
  function insightsBody() {
    const wait = needL();
    if (wait) return wait;
    const L = st.L;
    let html = "";
    // #7
    const syn = IN.lineupSynergy(L);
    html += `<div class="h">Lineup synergy</div>`;
    if (!syn) html += `<div class="msg">Not enough healthy players.</div>`;
    else {
      const bar = (x) => `<div class="bar"><i style="width:${Math.round(Math.min(1, x) * 100)}%"></i></div>`;
      const col = (t, x) => `<div><b>${t}</b><div class="why" style="margin:2px 0">${x.pids.map((p) => plink(p, LG.name(L, p))).join(", ")}</div>Offense ${bar(x.syn.off)}Defense ${bar(x.syn.def)}Rebounding ${bar(x.syn.reb)}</div>`;
      html += `<div class="lineup">${col("Your starters", syn.current)}${col("Best fit (top 9)", syn.best)}</div>`;
      html += syn.gain > 1 ? `<div class="banner acc" style="margin-top:6px">Start ${syn.swaps.in.map((p) => plink(p, LG.name(L, p))).join(", ")} over ${syn.swaps.out.map((p) => plink(p, LG.name(L, p))).join(", ")}: better skill fit (+${syn.gain.toFixed(1)} on the fit score). Set it in BBGM's Roster page with "Keep auto sorted" off.</div>`
        : `<div class="why">Your starting five already has the best skill fit available.</div>`;
      if (syn.missing.length) html += `<div class="why">Missing on the floor: ${esc(syn.missing.join(", "))}.</div>`;
      html += `<div class="why">BBGM's game simulation gives a bonus for skill combinations on the floor (shooters, ball handlers, passers, rim protection, rebounding, athleticism). Fit score = starters' OVR + 8 × synergy.</div>`;
    }
    // #8
    html += `<div class="h">Playoff matchup scout</div>`;
    if (L.snap.phase === PH_.PLAYOFFS && !st.bracket) B.playoffInfo().then((b) => { st.bracket = b; render(); }).catch(() => {});
    const ps = IN.playoffScout(L, L.snap.phase === PH_.PLAYOFFS ? st.bracket : null);
    const card = (m, title) => `<div class="card"><div class="hd"><b>${title} ${esc(m.name)}</b><span class="chip ${m.edge >= 0 ? "gem" : "over"}">${m.edge >= 0 ? "+" : ""}${m.edge.toFixed(1)} rating · ${Math.round(m.winProb * 100)}% per game</span></div>
      ${m.strengths.length ? `<div class="why"><span class="ok">Lean on:</span> ${esc(m.strengths.map((r) => r.label).join(", "))}</div>` : ""}
      ${m.weaknesses.length ? `<div class="why"><span class="no">Watch:</span> ${esc(m.weaknesses.map((r) => r.label).join(", "))}</div>` : ""}</div>`;
    if (ps.opponent) html += card(ps.opponent, "vs");
    else html += `<div class="why">${ps.inPlayoffs ? "You're out of the playoffs." : "During the playoffs this shows your opponent. Biggest threats now:"}</div>${ps.threats.map((m) => card(m, "")).join("")}`;
    html += `<div class="why">In the playoffs the manager tightens the rotation to 8 and gives stars more minutes, whatever the strategy.</div>`;
    // #9
    const cls = IN.draftClass(L);
    html += `<div class="h">Draft class strength</div>`;
    html += cls ? `<div class="card"><div class="hd"><b>${cls.now.year} class</b><span class="chip ${cls.verdict === "strong" ? "gem" : cls.verdict === "weak" ? "over" : ""}">${cls.verdict} · ${Math.round(cls.ratio * 100)}%</span></div>
      <div class="why">${esc(cls.advice)} Compared with ${esc(cls.basis)}. Top 5 avg value ${cls.now.top5.toFixed(1)}, lottery ${cls.now.top14.toFixed(1)}${cls.next ? `; next year's class: top 5 ${cls.next.top5.toFixed(1)}` : ""}.</div>
      <div class="why">The trade helper shops this year's picks more in weak classes and less in strong ones. Scouting fog applies to prospects.</div></div>` : `<div class="msg">Not enough prospects visible yet.</div>`;
    // #10
    html += `<div class="h">Rival GM tendencies</div>`;
    if (!st.rivals) { const go = on(async (el) => { el.disabled = true; el.textContent = "Reading…"; const ev = await B.tradeEvents().catch(() => null); st.rivals = IN.rivals(L, ev); render(); }); html += `<div class="actions"><button class="sm" data-h="${go}">Analyze AI teams</button></div>`; }
    else html += `<table><tr><th>Team</th><th>Style</th></tr>${st.rivals.slice(0, 30).map((r) => `<tr><td><b>${esc(r.abbrev)}</b><small>${r.strategy} · age ${r.age.toFixed(1)} · ${r.firsts} firsts${r.payPct != null ? ` · payroll ${Math.round(r.payPct * 100)}% of cap` : ""}</small></td><td style="text-align:left">${esc(r.tags.join("; ") || "—")}<small>${esc(r.shop)}</small></td></tr>`).join("")}</table>`;
    // #11
    html += `<div class="h">Franchise legacy</div>`;
    if (!st.legacy) { const go = on(async (el) => { el.disabled = true; el.textContent = "Reading history…"; try { st.legacy = IN.legacyView(L, await B.legacy()); } catch (e) { st.flash = e.message; } render(); }); html += `<div class="actions"><button class="sm" data-h="${go}">Load franchise history</button></div><div class="why">Reads every player who played for or was drafted by your team (can take a few seconds in long leagues).</div>`; }
    else html += `<table><tr><th>Player</th><th>With you</th><th>Now</th></tr>${st.legacy.rows.slice(0, 25).map((r) => `<tr><td>${plink(r.pid, r.name)}${r.drafted ? ` <span class="chip">drafted ${r.draft.year} #${r.draft.round === 1 ? r.draft.pick : `${r.draft.round}-${r.draft.pick}`}</span>` : ""}<small>${esc(r.awardsText || "")}${r.peak ? ` · peak OVR ${r.peak}` : ""}</small></td><td>${r.seasonsWithUs} yrs<small>${Math.round(r.ptsUs)} pts</small></td><td>${esc(r.where)}${r.ovrNow != null && !r.retired ? `<small>OVR ${r.ovrNow}</small>` : ""}</td></tr>`).join("")}</table>
      ${st.legacy.gone.length ? `<div class="why">Former players now elsewhere: ${st.legacy.gone.slice(0, 8).map((r) => `${esc(r.name)} (${esc(r.where)}${r.ovrNow != null ? `, OVR ${r.ovrNow}` : ""})`).join(", ")}.</div>` : ""}`;
    // #16
    html += `<div class="h">Prediction accuracy</div>`;
    const acc = IN.accuracy(L, st.acc || {});
    if (acc.overall) {
      html += `<div class="card"><div class="rows">
        <div><span>Average error (next-season OVR)</span><span>${acc.overall.mae.toFixed(2)}</span></div>
        <div><span>"No change" guess error, for comparison</span><span>${acc.overall.naiveMae.toFixed(2)}</span></div>
        <div><span>Inside the 80% range (target 80%)</span><span class="${Math.abs(acc.overall.coverage - 0.8) <= 0.08 ? "ok" : "no"}">${Math.round(acc.overall.coverage * 100)}%</span></div>
        <div><span>Bias (+ = too optimistic)</span><span>${num(acc.overall.bias, 2)}</span></div></div>
        <table class="sum"><tr><th>Season</th><th>Players</th><th>Error</th><th>In range</th></tr>${acc.seasons.map((x) => `<tr><td>${x.season} → ${x.season + 1}</td><td>${x.n}</td><td>${x.mae.toFixed(2)}</td><td>${Math.round(x.coverage * 100)}%</td></tr>`).join("")}</table></div>`;
    } else html += `<div class="msg">Courtside saves its forecasts each regular season and grades them once the next season's ratings exist.${acc.pending.length ? ` Waiting on ${acc.pending.join(", ")}.` : " Play into a regular season to start."}</div>`;
    // #12
    html += `<div class="h">Strategy benchmark</div>`;
    const bm = IN.benchmark(st.bench || []);
    if (!st.bench) S.localGet("bench").then((b) => { st.bench = b || []; if (st.tab === "insights") render(); });
    html += bm.length ? `<table class="sum"><tr><th>Strategy</th><th>Runs</th><th>Win%</th><th>Titles</th><th>Playoffs</th></tr>${bm.map((b) => `<tr><td>${esc(b.strategy)}</td><td>${b.runs} (${b.seasons} yrs)</td><td>${(b.winPct * 100).toFixed(1)}%</td><td>${b.titles}</td><td>${Math.round(b.playoffRate * 100)}%</td></tr>`).join("")}</table>` : "";
    html += `<div class="why">Every Autopilot run is recorded with its strategy setting. For a fair test, export your league (Tools → Export), import it as two copies, run Autopilot with a different strategy in each for the same number of seasons, and compare here. Courtside never copies or edits league files itself.</div>`;
    // #19
    html += `<div class="h">Diagnostics</div>`;
    const runD = on(async (el) => { el.disabled = true; el.textContent = "Checking…"; await runDiagnostics(); render(); });
    if (st.diag) html += `<div class="log">${st.diag.checks.map((c) => `<div><span><span class="${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "✗"}</span> ${esc(c.name)}<small class="mut" style="display:block">${esc(c.detail)}</small></span></div>`).join("")}</div>`;
    html += `<div class="actions"><button class="sm" data-h="${runD}">${st.diag ? "Check again" : "Run health check"}</button></div><div class="why">Checks that every BBGM action Courtside uses still exists in this version of the game. Autopilot runs this before it starts and refuses to start if something it needs is missing.</div>`;
    return html;
  }

  // ======================================================================
  // #18 Compact mode metrics
  // ======================================================================
  const METRICS = {
    rating: { label: "Team rating rank", get: (L) => { const r = 1 + L.snap.teams.filter((t) => t.tid !== L.snap.userTid && (L.movNow.get(t.tid) || 0) > (L.movNow.get(L.snap.userTid) || 0)).length; return [ordinal(r), "Rating"]; } },
    record: { label: "Record", get: (L) => [L.user ? `${L.user.won}-${L.user.lost}` : "–", "Record"] },
    job: { label: "Job security", get: () => [st.job ? `${st.job.security}%` : "…", "Job"] },
    cap: { label: "Cap space", get: (L) => [L.capInfo.type === "none" ? "—" : F.fmtMoney(L.capInfo.cap - L.capInfo.payroll), "Cap space"] },
    strategy: { label: "Strategy", get: (L) => [L.strategy ? L.strategy.label : "–", "Strategy"] },
    next: { label: "Next decision", get: (L) => { const d = IN.decisions(L, { job: st.job })[0]; return [d ? d.when : "—", "Next"]; } },
  };
  function compactBody() {
    if (!st.L) return needL() || "";
    const ms = (settings.compactMetrics || []).filter((k) => METRICS[k]).slice(0, 3);
    const open = on(async () => { settings.compactMode = false; await S.saveSettings({ compactMode: false }); render(); });
    const dec = IN.decisions(st.L, { job: st.job })[0];
    return `<div class="mini">${ms.map((k) => { const [v, l] = METRICS[k].get(st.L); return `<div><small>${esc(l)}</small><strong>${esc(v)}</strong></div>`; }).join("")}</div>
      ${dec ? `<div class="why">${esc(dec.text)}</div>` : ""}<div class="actions"><button class="sm" data-h="${open}">Full panel</button></div>`;
  }

  // ======================================================================
  // #14 Command bar (Alt+K)
  // ======================================================================
  function commands() {
    const lid = lidNow();
    const tab = (id, label) => ({ label: `Open ${label}`, hint: "Courtside tab", run: () => { settings.panelCollapsed = false; st.tab = id; render(); onTabOpen(id); } });
    const page = (path, label) => ({ label: `Go to ${label}`, hint: "BBGM page", run: () => goTo(`/l/${lid}/${path}`) });
    const list = TABS.filter(([, , en]) => en()).map(([id, label]) => tab(id, label));
    list.push(page("roster", "Roster"), page("trade", "Trade"), page("trading_block", "Trading Block"), page("free_agents", "Free Agents"), page("draft", "Draft"),
      page("standings", "Standings"), page("team_finances", "Team Finances"), page("settings", "League Settings"), page("inbox", "Inbox"));
    if (settings.features.autopilot) list.push(st.ap.running ? { label: "Stop Autopilot", hint: "action", run: () => stopAutopilot() } : { label: "Run Autopilot", hint: "action", run: () => { st.tab = "manager"; startAutopilot(); } });
    if (settings.features.trades) list.push({ label: "Find trades", hint: "action", run: () => { st.tab = "trades"; st.trades.ideas = null; render(); refreshTrades(); } });
    list.push({ label: "Re-plan manager moves", hint: "action", run: () => { st.tab = "manager"; st.pending = null; invalidate(); render(); refreshPending(); } });
    list.push({ label: "Run health check", hint: "action", run: async () => { st.tab = "insights"; render(); await runDiagnostics(); render(); } });
    list.push({ label: isOn(settings.compactMode) ? "Full panel" : "Compact panel", hint: "view", run: async () => { settings.compactMode = !isOn(settings.compactMode); await S.saveSettings({ compactMode: settings.compactMode }); render(); } });
    list.push({ label: "Reset panel position", hint: "view", run: async () => { settings.panelPos = null; await S.saveSettings({ panelPos: null }); render(); } });
    list.push({ label: settings.panelCollapsed ? "Open Courtside" : "Close Courtside", hint: "view", run: async () => { settings.panelCollapsed = !settings.panelCollapsed; await S.saveSettings({ panelCollapsed: settings.panelCollapsed }); render(); } });
    return list;
  }
  function openCommandBar() {
    if (document.getElementById("courtside-cmd")) return;
    // Its own host, so the dock re-rendering every few seconds doesn't close it.
    const cmdHost = document.createElement("div");
    cmdHost.id = "courtside-cmd";
    const root2 = cmdHost.attachShadow({ mode: "open" });
    root2.innerHTML = `<style>${CSS}</style>`;
    const el = document.createElement("div");
    el.className = "cmd";
    el.innerHTML = `<div class="box wrap${isDark() ? " dark" : ""}" style="position:static;width:min(520px, calc(100vw - 32px));max-height:none;display:block"><input placeholder="Type a command… (Esc to close)" aria-label="Command"><ul role="listbox"></ul></div>`;
    root2.appendChild(el);
    document.body.appendChild(cmdHost);
    const input = el.querySelector("input"), ul = el.querySelector("ul");
    let items = [], sel = 0;
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      items = commands().filter((c) => !q || q.split(/\s+/).every((w) => c.label.toLowerCase().includes(w)));
      sel = Math.min(sel, Math.max(0, items.length - 1));
      ul.innerHTML = items.map((c, i) => `<li role="option" data-i="${i}" class="${i === sel ? "sel" : ""}"><span>${esc(c.label)}</span><small>${esc(c.hint)}</small></li>`).join("") || `<li><small>No match</small></li>`;
    };
    const close = () => cmdHost.remove();
    const runIt = (i) => { const c = items[i]; close(); if (c) c.run(); };
    input.addEventListener("input", () => { sel = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter") runIt(sel);
    });
    ul.addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (li) runIt(Number(li.dataset.i)); });
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
    draw();
    input.focus();
  }
  document.addEventListener("keydown", (e) => {
    if (!enabled() || !isOn(settings.commandBar) || !lidNow()) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyK") { e.preventDefault(); openCommandBar(); }
  }, true);

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
  const SETTING_LABEL = { salaryCapType: "Salary cap type", luxuryTax: "Luxury tax", softCapTradeSalaryMatch: "Trade salary match", aiTradesFactor: "AI-to-AI trades factor",
    salaryCap: "Salary cap", luxuryPayroll: "Luxury tax threshold", minContract: "Min contract", maxContract: "Max contract", inflationAvg: "Inflation average",
    inflationStd: "Inflation std. dev.", injuryRate: "Injury rate", threePointTendencyFactor: "Three point tendency factor", pace: "Pace" };
  const fmtSetting = (k, v) => (v == null ? "–" : ["salaryCap", "luxuryPayroll", "minContract", "maxContract"].includes(k) ? F.fmtMoney(v) : k === "injuryRate" ? Number(v).toExponential(2) : String(v));
  /** Shows exactly what will change, turns on God Mode if needed (with your OK), then applies through BBGM. */
  async function confirmAndApply(patch, label) {
    const ga = (st.L && st.L.snap.ga) || {};
    const lines = Object.entries(patch).map(([k, v]) => `• ${SETTING_LABEL[k] || k}: ${fmtSetting(k, ga[k])} → ${fmtSetting(k, v)}`);
    const needGod = !ga.godMode;
    const msg = `Apply ${label}?\n\n${lines.join("\n")}${needGod ? "\n\nThis also turns on God Mode for this league (needed to change these settings; BBGM then disables achievements for it)." : ""}\n\nYou can undo it from the Realism tab.`;
    if (!window.confirm(msg)) { render(); return; }
    const prev = Object.fromEntries(Object.keys(patch).filter((k) => ga[k] != null).map((k) => [k, ga[k]]));
    const ok = await applyLeagueSettings(needGod ? { godMode: true, godModeInPast: true, ...patch } : patch, `Applied Realism settings (${label}): ${lines.map((l) => l.slice(2)).join("; ")}`, true);
    if (ok) st.realismUndo = { prev, label };
    render();
  }
  /**
   * Realism automation (setting "realismAuto" = "auto"): applies the Realism tab's suggested league settings in
   * the game by itself, once per season, from any tab and during Autopilot.
   *  - when: once the season is over (draft lottery onward), so a full season of numbers backs it and the changes
   *    are in place before free agency
   *  - what: every bounded setting the Realism tab would apply (see realism.js APPLY_BOUNDS), except switching the
   *    salary cap type, which reshapes every contract in the league and stays a manual click
   *  - God Mode: BBGM needs it to change league settings, so it's turned on with the first change (the setting says so)
   *  - every change is logged with the previous values and can be undone from the Realism tab
   * Returns true if it changed anything.
   */
  async function autoRealism(L) {
    if (!settings.features.realism || settings.realismAuto !== "auto" || !L || !R) return false;
    if (L.snap.phase < PH_.DRAFT_LOTTERY) return false;
    const key = lsKey("realismAuto");
    const done = await S.localGet(key);
    if (done && done.season >= L.snap.season) return false;
    let adv;
    try { adv = R.advise(L, await R.record(lidNow(), L)); } catch (e) { return false; }
    const patch = R.settingsToApply(adv.suggestions);
    delete patch.salaryCapType; // structural: manual only
    const ga = L.snap.ga || {};
    for (const k of Object.keys(patch)) if (ga[k] === patch[k]) delete patch[k];
    await S.localSet(key, { season: L.snap.season, at: Date.now(), applied: Object.keys(patch).length });
    if (!Object.keys(patch).length) return false;
    const prev = Object.fromEntries(Object.keys(patch).filter((k) => ga[k] != null).map((k) => [k, ga[k]]));
    const lines = Object.entries(patch).map(([k, v]) => `${SETTING_LABEL[k] || k}: ${fmtSetting(k, ga[k])} → ${fmtSetting(k, v)}`);
    const titles = adv.suggestions.filter((sg) => (sg.changes || []).some((c) => c.key && c.key in patch)).map((sg) => sg.title);
    try {
      await B.call("main", "updateGameAttributes", ga.godMode ? patch : { godMode: true, godModeInPast: true, ...patch });
    } catch (e) {
      await S.addLog({ kind: "error", text: `Realism automation couldn't change the league settings: ${e.message}` });
      return false;
    }
    st.realismUndo = { prev, label: `the ${L.snap.season} automatic Realism changes` };
    await S.addLog({ kind: "league", text: `Realism (automatic, ${L.snap.season}): ${lines.join("; ")}`,
      ex: { why: `Once a season, Courtside applies the Realism tab's suggestions: ${titles.join("; ")}.${ga.godMode ? "" : " God Mode was turned on (BBGM needs it to change league settings)."} Undo it from the Realism tab.`,
        benefits: lines, costs: [], strategy: "", basis: "observed" } });
    st.realism = null; st.log = await S.getLog();
    return true;
  }
  async function applyLeagueSettings(patch, logText, keepGod) {
    try {
      await B.call("main", "updateGameAttributes", patch);
      await S.addLog({ kind: "league", text: logText });
      st.flash = "League settings updated.";
      invalidate(); st.realism = null; st.log = await S.getLog();
      setTimeout(() => { st.flash = ""; render(); }, 4000);
      render();
      return true;
    } catch (e) {
      st.flash = `Couldn't change the settings: ${e.message}`; render();
      return false;
    }
  }
  function realismBody() {
    const wait = needL();
    if (wait) return wait;
    if (!st.realism || st.realism.key !== st.LKey) { refreshRealism(st.L).then(render); return `<div class="msg">Checking the league…</div>`; }
    if (st.realism.error) return `<div class="msg">${esc(st.realism.error)}</div>`;
    const { suggestions, rows, now } = st.realism;
    const open = on(() => goTo(`/l/${lidNow()}/settings`));
    const godMode = !!(st.L && st.L.snap.ga && st.L.snap.ga.godMode);
    const allPatch = R.settingsToApply(suggestions);
    const nAll = Object.keys(allPatch).length;
    const auto = settings.realismAuto === "auto";
    if (!st.realismAutoDone) S.localGet(lsKey("realismAuto")).then((d) => { st.realismAutoDone = d || { season: null }; if (st.tab === "realism") render(); });
    const last = st.realismAutoDone && st.realismAutoDone.season != null ? st.realismAutoDone : null;
    let html = `<div class="card adv" style="margin-top:0"><label>Automation<select data-set="realismAuto">
        <option value="off"${auto ? "" : " selected"}>Off: I press Apply</option>
        <option value="auto"${auto ? " selected" : ""}>Apply automatically once a season</option></select></label>
      <div class="why" style="margin-top:0">${auto
        ? `Once each season is over (from the draft lottery on), Courtside applies these suggestions in the game by itself, from any tab and during Autopilot, then the manager plans under the new settings. Switching the salary cap type stays manual. Every change is logged and can be undone here.${godMode ? "" : " <b>God Mode will be turned on</b> with the first change (BBGM needs it to change league settings, and then disables achievements for this league)."}${last ? ` Last checked: ${last.season}${last.applied ? `, ${last.applied} setting${last.applied === 1 ? "" : "s"} changed` : ", nothing needed"}.` : ""}`
        : `Nothing changes until you press <b>Apply</b>. Applying uses BBGM's own league-settings function, the same one the <a class="pl" href="/l/${lidNow()}/settings">League Settings</a> page uses.${godMode ? "" : " Most of these settings are locked unless God Mode is on, so applying will offer to turn it on (BBGM then disables achievements for this league)."}`}</div></div>`;
    if (st.realismUndo) {
      const undo = on(async (el) => { el.disabled = true; await applyLeagueSettings(st.realismUndo.prev, "Reverted the last Realism change", false); st.realismUndo = null; });
      html += `<div class="banner acc">Applied ${esc(st.realismUndo.label)}. <button class="sm" data-h="${undo}">Undo last change</button></div>`;
    }
    html += `<div class="h">Suggested tweaks</div>`;
    if (nAll) {
      const all = on(async (el) => { el.disabled = true; await confirmAndApply(allPatch, `${nAll} setting${nAll === 1 ? "" : "s"} from ${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"}`); });
      html += `<div class="actions" style="margin-top:0;margin-bottom:8px"><button class="pri" data-h="${all}">Apply all suggestions (${nAll} setting${nAll === 1 ? "" : "s"})</button></div>`;
    }
    html += suggestions.length ? suggestions.map((sg) => {
      const patch = R.settingsToApply([sg]);
      const n = Object.keys(patch).length;
      const one = n ? on(async (el) => { el.disabled = true; await confirmAndApply(patch, `"${sg.title}"`); }) : null;
      return `<div class="card"><div class="hd"><b>${esc(sg.title)}</b><span class="chip ${sg.severity === "high" ? "over" : ""}">${esc(sg.severity)}</span></div>
      <div class="why">${esc(sg.why)}</div>
      <table>${sg.changes.map((c) => `<tr><td>${esc(c.setting.join(" → "))}</td><td class="mut" style="white-space:nowrap">${c.current !== "" && c.current != null ? `${esc(String(c.current))} →` : "→"}</td><td><b>${esc(String(c.suggest))}</b>${c.key ? "" : `<small>advice only</small>`}</td></tr>`).join("")}</table>
      ${one ? `<div class="actions"><button class="sm pri" data-h="${one}">Apply</button></div>` : ""}</div>`;
    }).join("")
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
      await sleep(250);
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
    return false;
  }
  /**
   * Opens a BBGM page through the game's own router, the same as clicking a link in the game. Returns false
   * (and does nothing) if BBGM didn't handle the click, so the page is never reloaded mid-run.
   */
  function routeTo(path) {
    const a = document.createElement("a");
    a.href = path; a.hidden = true;
    let routed = false;
    // Registered after BBGM's own listener, so it runs last and can see whether BBGM took the click.
    const guard = (e) => { if (e.target !== a) return; routed = e.defaultPrevented; if (!routed) e.preventDefault(); };
    window.addEventListener("click", guard);
    document.body.appendChild(a);
    try { a.click(); } finally { window.removeEventListener("click", guard); a.remove(); }
    return routed;
  }
  /**
   * Opens every unread inbox message (the owner's "Annual performance evaluation" and the like) so they
   * don't pile up for you to click through after the run. BBGM marks a message read when its page is opened.
   * Returns how many were read.
   */
  async function autoReadMessages(poll) {
    const lid = lidNow();
    const mids = (poll && poll.unread) || [];
    if (!isOn(settings.apAutoReadMessages) || !lid || !mids.length || st.ap.readFailed) return 0;
    const back = location.pathname + location.search + location.hash;
    let read = 0;
    st.ap.status = `Reading ${mids.length} inbox message${mids.length === 1 ? "" : "s"}…`; render();
    for (const mid of mids.slice(0, 50)) {
      if (st.ap.stopReq) break;
      if (!routeTo(`/l/${lid}/message/${mid}`)) { st.ap.readFailed = true; break; }
      let done = false;
      for (let i = 0; i < 40 && !done; i++) {
        await sleep(150);
        const p = await B.poll().catch(() => null);
        done = !!p && !(p.unread || []).includes(mid);
      }
      if (!done) { st.ap.readFailed = true; break; }
      read++;
    }
    if (read) {
      routeTo(back);
      await S.addLog({ kind: "league", text: `Read ${read} inbox message${read === 1 ? "" : "s"} (owner evaluations and similar) so they don't pile up` });
    }
    if (st.ap.readFailed) await S.addLog({ kind: "error", text: "Couldn't open BBGM's inbox messages automatically. Autopilot keeps going; read them from BBGM's Play menu later." });
    return read;
  }
  /**
   * After being fired: takes over the strongest team on BBGM's New Team list (the five worst records unless
   * God Mode is on), judged by team rating now and in two seasons. Uses BBGM's own switchTeam action.
   */
  async function takeNewTeam(poll) {
    st.ap.status = "You were fired. Picking a new team…"; render();
    const opts = await B.newTeamOptions();
    if (!opts.teams.length) throw new Error("BBGM says you were fired, and there's no other team to take over");
    let L = null;
    try { L = await getL(true); } catch (e) { /* fall back to the list order */ }
    const score = (tid) => (L && L.movNow && L.mov2 ? 0.5 * (L.movNow.get(tid) ?? 0) + 0.5 * (L.mov2.get(tid) ?? 0) : 0);
    const ranked = opts.teams.map((t) => ({ ...t, score: score(t.tid) })).sort((a, b) => b.score - a.score);
    const pick = ranked[0];
    const oldTeam = L && L.teams && L.teams.get(poll.userTid);
    await B.call("main", "switchTeam", pick.tid);
    const p = await waitIdle();
    if (p.gameOver || p.userTid !== pick.tid) throw new Error("BBGM says you were fired, and switching to a new team didn't work. Pick a new team in BBGM, then start Autopilot again");
    st.ap.rosterStart = null; // roster turnover is measured from the new team
    st.ap.newTeams = (st.ap.newTeams || 0) + 1;
    invalidate(); st.trades.ideas = null; st.pending = null;
    await S.addLog({ kind: "league", text: `Fired${oldTeam ? ` by the ${oldTeam.region} ${oldTeam.name}` : ""}. Took over the ${pick.region} ${pick.name} (${pick.won}-${pick.lost})`,
      ex: { why: `BBGM offered ${ranked.length} team${ranked.length === 1 ? "" : "s"}${opts.godMode ? " (God Mode: every team)" : " (the worst records this season)"}. Picked the best team rating now and in two seasons: ${ranked.map((t) => `${t.abbrev} ${t.score.toFixed(1)}`).join(", ")}.`, benefits: [], costs: [], strategy: L && L.strategy ? L.strategy.label : "", basis: "projected" } });
  }
  /**
   * Live season tracking: when a season's playoffs end, read its result from BBGM's records, log it (and any
   * title), and count it as a completed season.
   */
  async function noteSeasonEnd(poll) {
    st.ap.live = { season: poll.season, phase: poll.phase, won: poll.won, lost: poll.lost, at: Date.now() };
    const prev = st.ap.lastPhase;
    st.ap.lastPhase = poll.phase;
    if (prev == null) return;
    // The playoffs just finished (BBGM moves on to the draft lottery).
    if (!(prev >= 0 && prev <= PH_.PLAYOFFS && poll.phase > PH_.PLAYOFFS)) return;
    const ended = poll.season;
    if (st.ap.seasonsSeen.has(ended)) return;
    st.ap.seasonsSeen.add(ended);
    const h = await B.history(ended, ended);
    const r = h.rows.find((x) => x.tid === h.userTid && x.season === ended);
    if (!r) return;
    const nr = h.nr;
    const res = r.prw < 0 ? "missed the playoffs" : r.prw >= nr ? "won the title" : r.prw === nr - 1 ? "lost in the finals" : `lost in playoff round ${r.prw + 1}`;
    const t = st.L && st.L.teams.get(h.userTid);
    const row = { season: ended, won: r.won, lost: r.lost + (r.otl || 0), result: res, champion: r.prw >= nr && nr > 0, team: t ? t.abbrev : "" };
    st.ap.seasonLog.push(row);
    await S.addLog({ kind: row.champion ? "title" : "season", text: `${row.champion ? "🏆 " : ""}Season ${ended}${row.team ? ` (${row.team})` : ""}: ${row.won}-${row.lost}, ${res}` });
    st.log = await S.getLog();
  }
  async function startAutopilot() {
    if (st.ap.running) return;
    const dialogTimer = setInterval(() => {
      if (!st.ap.running) return clearInterval(dialogTimer);
      const r = answerBBGMDialogs();
      if (r && r !== "answered" && !/Waiting for BBGM/.test(st.ap.status)) { st.ap.status = `Waiting for BBGM: it's showing a message that needs you ("${r.replace(/\s+/g, " ")}…")`; render(); }
    }, 1000);
    st.ap = { running: true, status: "Checking BBGM…", startSeason: null, stopReq: false, runStart: Date.now(), strategies: {}, rosterStart: null, seasonLog: [], seasonsSeen: new Set(), lastPhase: null };
    render();
    // #19: refuse to start if this BBGM version lacks what Autopilot needs (instead of failing mid-run).
    const bad = await preflight();
    if (bad) { st.ap.running = false; st.ap.status = `Didn't start: ${bad}`; clearInterval(dialogTimer); await S.addLog({ kind: "error", text: `Autopilot didn't start: ${bad}` }); render(); return; }
    st.ap.status = "Starting…";
    S.startRunLog();
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
        await noteSeasonEnd(poll).catch(() => {});
        if (await autoReadMessages(poll)) continue;
        if (poll.gameOver) {
          if (!isOn(settings.apAutoNewTeam)) throw new Error("BBGM says you were fired (game over). Pick a new team or league in BBGM, then start Autopilot again (or turn on \"Auto-pick a new team when fired\" in the Manager tab's Advanced settings)");
          await takeNewTeam(poll);
          continue;
        }
        const reason = F.stopHere(poll, settings, st.ap.startSeason);
        if (reason && stuck === 0 && st.ap.lastKey) { st.ap.status = `Finished: ${reason}.`; break; }
        // Loop guard: many manager rounds without the game moving means something keeps failing.
        const pk = progressKey(poll);
        idle = idleKey === pk ? idle + 1 : 0; idleKey = pk;
        if (idle >= 8) throw new Error("The game hasn't moved after several manager rounds; stopping to avoid a loop");
        st.poll = poll; st.pollKey = keyOf(poll);
        invalidate();
        st.ap.status = "Managing the team…"; render();
        let L = await getL(true);
        // Realism automation: apply this season's suggested league settings before planning, then rebuild the
        // model so every move below is planned under the new settings.
        if (await autoRealism(L)) { invalidate(); L = await getL(true); }
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
        if (td.due) await td.mark(planned.filter((a) => a.kind === "trade").length);
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
        // Free agency checker: during free agency, keep shopping day by day while it's worth it.
        let faCheck = null;
        if (poll.phase === PH_.FREE_AGENCY) { try { faCheck = F.freeAgencyCheck(L, s2, poll); st.faCheck = faCheck; } catch (e) { /* fall back to finishing free agency */ } }
        const [action, label] = F.nextPlayAction(poll, settings, faCheck);
        if (!action) throw new Error(`Unknown game phase (${poll.phase})`);
        if (poll.phase === 7 && poll.negs > 0) {
          // Players still unsigned (e.g. a Never-trade player who won't re-sign): BBGM will ask before free agency.
          await S.addLog({ kind: "letwalk", text: `${poll.negs} player${poll.negs === 1 ? "" : "s"} still unsigned at the end of re-signing; they become free agents` });
        }
        st.ap.status = `${label}…`; render();
        const before = progressKey(poll);
        st.ap.lastKey = before;
        await B.call("playMenu", action, undefined, 30 * 60 * 1000).catch((e) => { throw new Error(`${label} failed: ${e.message}`); });
        // BBGM's play actions resolve when the simulation is done, so there's no need for a long fixed pause;
        // waitIdle() still waits if BBGM is busy.
        await sleep(30);
        poll = await waitIdle();
        if (progressKey(poll) === before && poll.phase <= 3 && !st.ap.stopReq) {
          // Some steps can be no-ops (for example, between playoff rounds). Fall back to playing a single day.
          st.ap.status = "Playing one day…"; render();
          await B.call("playMenu", "day", undefined, 30 * 60 * 1000).catch(() => {});
          await sleep(30);
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
    // Messages created by the last step (e.g. the season-end owner evaluation).
    try { await autoReadMessages(await B.poll()); } catch (e) { /* not critical */ }
    if (st.ap.newTeams) st.ap.status += ` Took over ${st.ap.newTeams} new team${st.ap.newTeams === 1 ? "" : "s"} after being fired.`;
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
    const log = S.runLogEntries(); // the whole run, not limited by the activity log's size
    const end = (await B.evalJSON(`const ps = await bbgm.idb.cache.players.indexGetAll("playersByTid", bbgm.g.get("userTid")); console.log(JSON.stringify({ pids: ps.map((x) => x.pid) }));`, 15000)).pids;
    st.apSummary = SG.summarizeRun({ rows: hist.rows, userTid: hist.userTid, nr: hist.nr, from: st.ap.startSeason, to: p.season, log,
      strategies: st.ap.strategies, rosterStart: st.ap.rosterStart || [], rosterEnd: end });
    await S.localSet(`apSummary:${lidNow()}`, st.apSummary);
    // #12: record the run for the strategy benchmark (local only, last 50 runs).
    try {
      const sm = st.apSummary;
      if (sm && sm.seasons && sm.seasons.length) {
        const bench = (await S.localGet("bench")) || [];
        bench.unshift({ t: Date.now(), league: st.league || `lid${lidNow()}`, strategy: settings.teamMode || "auto", difficulty: L && L.difficulty ? L.difficulty.label : "",
          from: sm.from, seasons: sm.seasons.length, winPct: sm.winPct, titles: sm.titles, playoffApps: sm.playoffApps, payrollPerWin: sm.payrollPerWin });
        await S.localSet("bench", bench.slice(0, 50));
        st.bench = bench.slice(0, 50);
      }
    } catch (e) { /* ignore */ }
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
  // Keep the open player's Outlook and the inline badges current while games are played (by you, BBGM's play
  // menu or Autopilot): ratings change in preseason progression and during the season.
  let lastBadgeKey = "", lastBadgeAt = 0, liveBusy = false;
  function refreshLive(p) {
    const o = st.outlook;
    const pk = progressKey(p);
    // Only while someone can see it (Outlook tab open, page visible) or it feeds a pinned player; a hidden card
    // catches up as soon as it's shown again, because its key is still old.
    const seen = !document.hidden && st.tab === "outlook" && !settings.panelCollapsed;
    // While BBGM is simulating or Autopilot is running, check at most every 6 s; otherwise as soon as anything moved.
    const busy = p.gameSim || st.ap.running;
    if (o && o.result && !o.loading && !liveBusy && o.key !== pk && (seen || o.pinned) && (!busy || Date.now() - o.at > 6000)) {
      liveBusy = true;
      showPlayer(o.lid, o.pid, { quiet: true }).catch(() => {}).finally(() => { liveBusy = false; });
    }
    // Badges: after each game day, but at most every 15 s during Autopilot so long runs aren't slowed down.
    const bk = keyOf(p);
    if (bk !== lastBadgeKey && !p.gameSim && (!st.ap.running || Date.now() - lastBadgeAt > 15000)) {
      lastBadgeKey = bk;
      lastBadgeAt = Date.now();
      refreshBadges();
    }
  }

  let loopBusy = false;
  async function tick() {
    if (loopBusy || !enabled() || !lidNow() || (!needsBridge() && !st.outlook)) return;
    loopBusy = true;
    try {
      const p = await B.poll();
      st.poll = p;
      if (!p.inLeague) return;
      const k = keyOf(p);
      const changed = k !== st.pollKey;
      st.pollKey = k;
      if (changed) { invalidate(); st.current = null; }
      refreshLive(p);
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
        if (td.due) await td.mark(acts.filter((a) => a.kind === "trade").length);
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
    if (!enabled() || settings.badges === "off") return false;
    if (settings.badges === "draft") return DRAFT_RE.test(location.pathname);
    return LEAGUE_RE.test(location.pathname);
  }
  function clearBadges() {
    document.querySelectorAll(".bbgm-scout-badge").forEach((b) => b.remove());
  }

  // The game moved on: re-check the badges on this page and redraw the ones whose OVR/POT changed. Cached badges
  // for players not on this page are dropped (they're recalculated if you see them again), so the check stays
  // small however many pages you've visited.
  async function refreshBadges() {
    const lid = lidNow();
    if (!lid) return;
    const mine = [...badgeCache.keys()].filter((k) => k.startsWith(`${lid}:`));
    if (!mine.length) return;
    if (!badgesWanted()) { mine.forEach((k) => badgeCache.delete(k)); return; }
    const onPage = new Set([...document.querySelectorAll(".bbgm-scout-badge")].map((b) => b.dataset.pid).filter(Boolean).map(Number));
    const check = [];
    for (const k of mine) {
      const pid = Number(k.split(":")[1]);
      if (onPage.has(pid) && badgeCache.get(k)) check.push([k, pid]);
      else if (badgeCache.get(k)) badgeCache.delete(k); // off-page; retired/unknown (null) entries are kept so they aren't re-read every day
    }
    if (!check.length) return;
    try {
      const ctx = await D.load(lid, [...new Set(check.map(([, pid]) => pid))]);
      let n = 0;
      for (const [k, pid] of check) {
        const p = ctx.players.get(pid);
        const r = p && p.ratings && p.ratings[p.ratings.length - 1];
        if (!r || badgeCache.get(k).sig !== `${r.season}:${r.ovr}:${r.pot}`) { badgeCache.delete(k); n++; }
      }
      if (n) { clearBadges(); scheduleBadges(); }
    } catch (e) { /* league DB busy; try next time */ }
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
            try { s = A.analyze(ctx, p, settings, { nSims: 250, full: false }).summary; const r = p.ratings[p.ratings.length - 1]; s.sig = `${r.season}:${r.ovr}:${r.pot}`; } catch (e) { s = null; }
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
        b.dataset.pid = pid;
        b.textContent = `▲${s.peakOvr}`;
        b.title = `Courtside: projected peak ${s.peakOvr} OVR at age ${s.peakAge} · ceiling ${s.ceiling} · breakout ${Math.round(s.breakout * 100)}%`;
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
  .tip { position: fixed; z-index: 2147483001; width: 280px; pointer-events: none;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --bg:#fcf7ef; --fg:#21180f; --mut:#7b6a57; --line:#ecdcc4; --chip:#f5e9d6; --acc:#e0631d; --good:#1d8a4d; --bad:#c8372d; --warn:#b06f08; --board:#15202f; --boardfg:#ffb26b;
    background: var(--bg); color: var(--fg); border:1px solid var(--line); border-top:3px solid var(--acc); border-radius:12px;
    box-shadow:0 16px 36px -12px rgba(73,38,10,.4); padding:9px 11px; }
  .tip.dark { --bg:#0f1622; --fg:#edf1f7; --mut:#8e9ab0; --line:#223049; --chip:#18233a; --acc:#ff8a3d; --good:#4fd28f; --bad:#ff6f5e; --warn:#f6b544; --board:#060b14; --boardfg:#ffa95c;
    box-shadow:0 16px 40px -10px rgba(0,0,0,.75); }
  .hd { display:flex; justify-content:space-between; gap:6px; align-items:baseline; }
  b { font-size:13.5px; font-weight:800; } .mut { color:var(--mut); } .good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); }
  .chip { font-size:10.5px; font-weight:700; padding:1px 7px; border-radius:999px; background:var(--chip); white-space:nowrap; }
  .chip.gem { color:#fff; background:var(--good); } .chip.over { color:#fff; background:var(--bad); }
  .g { display:grid; grid-template-columns:repeat(3,1fr); gap:4px; margin:8px 0 6px; text-align:center; }
  .g div { background:var(--board); border-radius:8px; padding:4px 0 3px; }
  .g small { display:block; font-size:9px; color:#8fa0b8; text-transform:uppercase; letter-spacing:1px; font-weight:700; }
  .g strong { font-size:17px; font-weight:800; font-family:ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric:tabular-nums; color:var(--boardfg); text-shadow:0 0 8px color-mix(in srgb, var(--boardfg) 50%, transparent); }
  .r { display:flex; justify-content:space-between; gap:8px; padding:2px 0; font-variant-numeric:tabular-nums; border-bottom:1px dashed var(--line); }
  .r:last-of-type { border-bottom:0; }
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
    const next = ovrPredictions(r, 2);
    if (next.length) rows.push(["Predicted OVR", next.map((x) => `${x.season}: <b>${x.ovr}</b> <span class="mut">(${x.lo}–${x.hi})</span>`).join(" · ")]);
    rows.push(["Scout POT / BBGM POT", `<b>${s.peakOvr}</b> / ${s.pot}`]);
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
    if (!enabled() || !settings.features.hover) return;
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
    if (!enabled()) return; // re-enabling resets lastUrl, so the current page is picked up then
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
      if (shutDown) return; // a newer copy of the script is in charge (see "One live copy per page")
      if (protLid && changes[`protect:${protLid}`]) { await P.loadProtections(protLid); st.trades.ideas = null; st.pending = null; render(); }
      if (!changes.settings) return;
      const prev = settings;
      settings = await S.getSettings();
      // Master switch: off removes everything from the page and stops Autopilot; on brings the current page back.
      if ((prev.enabled !== false) !== enabled()) {
        if (!enabled()) {
          if (st.ap.running) await stopAutopilot();
          clearBadges(); hideTip();
          const cmd = document.getElementById("courtside-cmd"); if (cmd) cmd.remove();
          removeHost();
          return;
        }
        lastUrl = ""; onRoute(); tick();
      }
      const modelChanged = ["nSims", "respectFog", "bustMode", "bustMargin", "bustOvr", "teamMode", "riskPref", "managerStyle"].some((k) => prev[k] !== settings[k]);
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
    timers.push(setInterval(onRoute, 500)); // BBGM is a single-page app; watch for route changes.
    timers.push(setInterval(tick, 3000));
    tick();
    observer = new MutationObserver((muts) => {
      if (!enabled() || settings.badges === "off") return;
      if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !n.classList?.contains("bbgm-scout-badge") && n.id !== "bbgm-scout-host"))) scheduleBadges();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ======================================================================
  // One live copy per page. When the extension is updated or reloaded, Chrome leaves the old copy of this script
  // running in open tabs, cut off from the extension (it never hears the master switch or new settings), while
  // the new copy starts beside it. The old copy shuts itself down when it notices it's cut off, or when a newer
  // copy announces itself, so only one dock ever shows and the switch always works.
  // ======================================================================
  const INSTANCE = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const connected = () => { try { return !!(ext && ext.runtime && ext.runtime.id); } catch (e) { return false; } };
  function shutdown(reason) {
    if (shutDown) return;
    const wasOn = settings.enabled !== false;
    shutDown = true;
    // Cut off by an update or reload (not replaced by a newer copy on this page): say so, with a one-click refresh.
    if (reason === "disconnected" && wasOn && document.body) {
      const note = document.createElement("div");
      note.id = "courtside-updated";
      note.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:12px;background:#e0631d;color:#fff;font:600 13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 10px 30px -8px rgba(0,0,0,.45)";
      note.innerHTML = `<span>Courtside was updated. Refresh to load the new version.</span>`;
      const btn = document.createElement("button");
      btn.textContent = "Refresh";
      btn.style.cssText = "font:inherit;padding:4px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.6);background:rgba(255,255,255,.18);color:#fff;cursor:pointer";
      btn.onclick = () => location.reload();
      const x = document.createElement("button");
      x.textContent = "×"; x.title = "Dismiss";
      x.style.cssText = "font:inherit;padding:0 6px;border:0;background:none;color:#fff;cursor:pointer;font-size:16px";
      x.onclick = () => note.remove();
      note.append(btn, x);
      document.getElementById("courtside-updated")?.remove();
      document.body.appendChild(note);
    }
    st.ap.stopReq = true;
    timers.forEach(clearInterval);
    if (observer) observer.disconnect();
    document.removeEventListener("mouseover", onHoverIn, true);
    document.removeEventListener("mouseout", onHoverOut, true);
    window.removeEventListener("scroll", hideTip, true);
    settings = { ...settings, enabled: false }; // every remaining entry point now does nothing
    hideTip(); removeHost();
  }
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__courtside === "takeover" && e.data.id !== INSTANCE) shutdown();
  });
  timers.push(setInterval(() => { if (!connected()) shutdown("disconnected"); }, 2000));
  // Tell any older copy on this page to stop, and clear what it drew, before starting.
  window.postMessage({ __courtside: "takeover", id: INSTANCE }, location.origin);
  document.getElementById("bbgm-scout-host")?.remove();
  document.getElementById("courtside-updated")?.remove();
  document.querySelectorAll(".bbgm-scout-badge").forEach((b) => b.remove());

  init();
})();
