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
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }
  async function saveSettings(patch) {
    const cur = await getSettings();
    return set({ settings: { ...cur, ...patch }, modelVersion: MODEL_VERSION });
  }

  async function getPins() {
    const { pins } = await get("pins");
    return Array.isArray(pins) ? pins : [];
  }
  const pinKey = (lid, pid) => `${lid}:${pid}`;
  async function isPinned(lid, pid) {
    return (await getPins()).some((p) => p.key === pinKey(lid, pid));
  }
  async function togglePin(summary) {
    const pins = await getPins();
    const key = pinKey(summary.lid, summary.pid);
    const i = pins.findIndex((p) => p.key === key);
    if (i >= 0) pins.splice(i, 1);
    else pins.unshift({ key, ...summary });
    await set({ pins: pins.slice(0, MAX_PINS) });
    return i < 0;
  }
  async function refreshPin(summary) {
    const pins = await getPins();
    const i = pins.findIndex((p) => p.key === pinKey(summary.lid, summary.pid));
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
    const id = `report:${report.lid}:${report.pid}:${report.season}`;
    // Keep the newest MAX_REPORTS; drop the oldest beyond that.
    const extra = reports.filter((r) => `report:${r.lid}:${r.pid}:${r.season}` !== id).slice(MAX_REPORTS - 1);
    const s = await store();
    if (extra.length) await s.remove(extra.map((r) => `report:${r.lid}:${r.pid}:${r.season}`));
    const note = (report.note || "").slice(0, 1500);
    return set({ [id]: { ...report, note, modelVersion: MODEL_VERSION } });
  }
  async function deleteReport(r) {
    const s = await store();
    await s.remove(`report:${r.lid}:${r.pid}:${r.season}`);
  }

  async function status() {
    if (!sync) return { mode: "local", text: "Local only", detail: "Browser sync storage unavailable" };
    if (lastError) return { mode: "error", text: "Sync error", detail: String(lastError.message || lastError) };
    let used = null;
    try { used = await sync.getBytesInUse(null); } catch (e) { /* Firefox may not support */ }
    return { mode: "sync", text: "Synced", detail: used != null ? `${(used / 1024).toFixed(1)} KB of 100 KB used` : "" };
  }

  function onChange(cb) {
    if (api && api.storage && api.storage.onChanged) api.storage.onChanged.addListener(cb);
  }

  root.BBGMScoutStorage = {
    MODEL_VERSION, DEFAULT_SETTINGS, getSettings, saveSettings, getPins, isPinned, togglePin, refreshPin,
    listReports, saveReport, deleteReport, status, onChange,
  };
})(globalThis);
