/*
 * BBGM Scout – synced storage.
 *
 * Uses the browser's built-in sync storage (chrome.storage.sync / Firefox
 * Sync), so settings, pinned players and saved reports follow your browser
 * profile across your Mac and other devices. Only small summaries are stored;
 * league databases are never synced or uploaded.
 *
 * Limits (Chrome): 100 KB total, 8 KB per key, 512 keys. Each report gets its
 * own key so one large note can't break the rest.
 */
(function (root) {
  "use strict";

  const api = root.chrome || root.browser;
  const sync = api && api.storage && api.storage.sync;
  const local = api && api.storage && api.storage.local;

  const MODEL_VERSION = "bbgm-progs-2025.1";
  const MAX_REPORTS = 60;
  const MAX_PINS = 40;

  const DEFAULT_SETTINGS = {
    nSims: 1000,
    respectFog: true,
    bustMode: "pot", // "pot" => peak below POT - bustMargin, "fixed" => peak below bustOvr
    bustMargin: 5,
    bustOvr: 55,
    badges: "draft", // "off" | "draft" | "everywhere"
    panelCollapsed: false,
    panelSide: "right",
    theme: "auto", // "auto" (follow BBGM / system) | "light" | "dark"
    teamMode: "auto", // "auto" (Strategy Brain) | "rebuild" | "develop" | "contend" | "winnow" (legacy "balanced" = develop)
    riskPref: "auto", // "auto" | "conservative" | "balanced" | "upside" (separate from the timeline)
    draftTradeDown: false, // "auto" (follow BBGM's team strategy) | "contend" | "balanced" | "rebuild"
    features: { hover: true, assistant: true, trades: true, targets: true, freeAgents: true, drafter: false, manager: false, autopilot: false, realism: true, needs: true, plan: true, moneyball: true },
    tradeOnGameDay: true,
    tradeOnTradePage: true,
    draftMode: "suggest", // "suggest" | "auto"
    draftTradeUp: false,
    managerMode: "suggest", // "suggest" (you approve each action) | "auto"
    manage: { finances: true, roster: true, minutes: true, resign: true, signings: true, releases: true, trades: true },
    financeStyle: "balanced", // "win" | "balanced" | "profit"
    tradeMinMov: 0.5, // minimum team-rating (MOV) improvement for an automatic trade
    tradeEveryDays: 1,
    tradeCooldownDays: 30, // game days before a newly acquired player can be traded again (big opportunities excepted)
    maxContractYears: 0, // 0 = no limit
    minCapReserve: 0, // $ millions of cap space to keep free
    rotationSize: 10,
    tank: false,
    apStep: "day", // "day" | "week"
    apSeasons: 1,
    apAutoApprove: true, // Autopilot also makes Ask-first / contract-rule moves itself (Never trade is still respected)
    apStopAt: "never", // "never" | "playoffs" | "draft" | "freeAgency"
    claudeEnabled: false,
    claudeModel: "claude-opus-5-5",
  };

  let lastError = null;

  async function store() {
    // Fall back to local storage if sync is disabled/unavailable (e.g. not signed in to the browser).
    return sync || local;
  }

  async function get(keys) {
    const s = await store();
    try {
      return await s.get(keys);
    } catch (e) {
      lastError = e;
      return {};
    }
  }
  async function set(obj) {
    const s = await store();
    try {
      await s.set(obj);
      lastError = null;
      return true;
    } catch (e) {
      lastError = e;
      return false;
    }
  }

  async function getSettings() {
    const { settings } = await get("settings");
    const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    s.features = { ...DEFAULT_SETTINGS.features, ...((settings && settings.features) || {}) };
    s.manage = { ...DEFAULT_SETTINGS.manage, ...((settings && settings.manage) || {}) };
    if (s.teamMode === "balanced") s.teamMode = "develop"; // v2.4: "Balanced" became the Develop strategy
    return s;
  }
  async function saveSettings(patch) {
    const cur = await getSettings();
    return set({ settings: { ...cur, ...patch }, modelVersion: MODEL_VERSION });
  }

  async function getPins() {
    const { pins } = await get("pins");
    return Array.isArray(pins) ? pins : [];
  }
  // Pins, reports and protections are keyed by a league's stable identity (see data.js fingerprint),
  // not BBGM's local league number, which can point to a different league on another device.
  const leagueOf = (x) => x.league || `lid${x.lid}`;
  const pinKey = (league, pid) => `${league}:${pid}`;
  async function isPinned(league, pid) {
    return (await getPins()).some((p) => p.key === pinKey(league, pid));
  }
  async function togglePin(summary) {
    const pins = await getPins();
    const key = pinKey(leagueOf(summary), summary.pid);
    const i = pins.findIndex((p) => p.key === key);
    if (i >= 0) pins.splice(i, 1);
    else pins.unshift({ key, ...summary });
    await set({ pins: pins.slice(0, MAX_PINS) });
    return i < 0;
  }
  async function refreshPin(summary) {
    const pins = await getPins();
    const i = pins.findIndex((p) => p.key === pinKey(leagueOf(summary), summary.pid));
    if (i < 0) return;
    pins[i] = { ...pins[i], ...summary };
    await set({ pins });
  }

  async function listReports() {
    const all = await get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith("report:"))
      .map(([, v]) => v)
      .sort((a, b) => b.savedAt - a.savedAt);
  }
  async function saveReport(report) {
    const reports = await listReports();
    const reportId = (r) => `report:${leagueOf(r)}:${r.pid}:${r.season}`;
    const id = reportId(report);
    // Keep the newest MAX_REPORTS; drop the oldest beyond that.
    const extra = reports.filter((r) => reportId(r) !== id).slice(MAX_REPORTS - 1);
    const s = await store();
    if (extra.length) await s.remove(extra.map(reportId));
    const note = (report.note || "").slice(0, 1500);
    return set({ [id]: { ...report, note, modelVersion: MODEL_VERSION } });
  }
  async function deleteReport(r) {
    const s = await store();
    await s.remove(`report:${leagueOf(r)}:${r.pid}:${r.season}`);
  }

  async function status() {
    if (!sync) return { mode: "local", text: "Local only", detail: "Browser sync storage unavailable" };
    if (lastError) return { mode: "error", text: "Sync error", detail: String(lastError.message || lastError) };
    let used = null;
    try { used = await sync.getBytesInUse(null); } catch (e) { /* Firefox may not support */ }
    return { mode: "sync", text: "Synced", detail: used != null ? `${(used / 1024).toFixed(1)} KB of 100 KB used` : "" };
  }

  // ---- Device-only storage (never synced): action log, API key, bookkeeping ----
  const localGet = async (k) => { try { return (await local.get(k))[k]; } catch (e) { return undefined; } };
  const localSet = async (k, v) => { try { await local.set({ [k]: v }); } catch (e) { /* ignore */ } };
  async function addLog(entry) {
    const log = (await localGet("actionLog")) || [];
    // Unique, increasing timestamps (they identify entries for Undo).
    log.unshift({ t: Math.max(Date.now(), ((log[0] && log[0].t) || 0) + 1), ...entry });
    await localSet("actionLog", log.slice(0, 200));
  }
  const getLog = async () => (await localGet("actionLog")) || [];
  const clearLog = () => localSet("actionLog", []);
  /** Marks a log entry (by its timestamp) as undone, so its Undo button goes away. */
  async function markUndone(t) {
    const log = (await localGet("actionLog")) || [];
    await localSet("actionLog", log.map((e) => (e.t === t ? { ...e, undone: true } : e)));
  }

  // ---- Strategy decisions (synced, tiny: one key per league) ----
  async function getStrategy(league) { return (await get(`strategy:${league}`))[`strategy:${league}`] || null; }
  async function setStrategy(league, decision) { return set({ [`strategy:${league}`]: decision }); }

  // ---- League identity: which local league number each league has on THIS device ----
  async function rememberLeague(league, lid) {
    const map = (await localGet("leagueMap")) || {};
    if (map[league] !== lid) { map[league] = lid; await localSet("leagueMap", map); }
  }
  const leagueMap = async () => (await localGet("leagueMap")) || {};
  /** The identity this device already knows for local league `lid`, if any. */
  async function knownLeague(lid) {
    const map = await leagueMap();
    const hit = Object.entries(map).find(([, v]) => v === lid);
    return hit ? hit[0] : null;
  }
  /** Local URL for a pin/report on this device, or null if that league hasn't been opened here. */
  function localUrl(map, item) {
    const lid = item.league ? map[item.league] : item.lid;
    if (lid == null) return null;
    return `/l/${lid}/player/${item.pid}`;
  }
  /**
   * One-time upgrade for data saved before league identities existed: pins, reports and
   * protections saved under local league number `lid` move to the league's identity.
   * Runs once per local league number on each device; data that already has a league identity is untouched.
   */
  async function migrateLeague(lid, league) {
    const doneKey = `migrated:${lid}`;
    if (await localGet(doneKey)) return;
    {
      const pins = await getPins();
      let changed = false;
      for (const p of pins) if (!p.league && p.lid === lid) { p.league = league; p.key = pinKey(league, p.pid); changed = true; }
      if (changed) await set({ pins });
      const s = await store();
      const all = await get(null);
      for (const [k, r] of Object.entries(all)) {
        if (k.startsWith("report:") && !r.league && r.lid === lid) {
          await s.remove(k);
          await set({ [`report:${league}:${r.pid}:${r.season}`]: { ...r, league } });
        }
      }
      const oldProt = all[`protect:${lid}`];
      if (oldProt && !all[`protect:${league}`]) { await set({ [`protect:${league}`]: oldProt }); await s.remove(`protect:${lid}`); }
    }
    await localSet(doneKey, true);
  }
  /** Remember which local league numbers this device has saved data under (for migration). */
  async function markSaved(lid) {
    const mine = (await localGet("savedLids")) || [];
    if (!mine.includes(lid)) { mine.push(lid); await localSet("savedLids", mine); }
  }

  function onChange(cb) {
    if (api && api.storage && api.storage.onChanged) api.storage.onChanged.addListener(cb);
  }

  root.BBGMScoutStorage = {
    MODEL_VERSION, DEFAULT_SETTINGS, getSettings, saveSettings, getPins, isPinned, togglePin, refreshPin,
    listReports, saveReport, deleteReport, status, onChange, localGet, localSet, addLog, getLog, clearLog, markUndone, getStrategy, setStrategy,
    rememberLeague, leagueMap, knownLeague, localUrl, migrateLeague, markSaved,
  };
})(globalThis);
