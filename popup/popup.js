(async function () {
  "use strict";
  const S = globalThis.BBGMScoutStorage;
  const $ = (id) => document.getElementById(id);
  const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };
  const BBGM = "https://play.basketball-gm.com";

  // Tabs
  document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll("section").forEach((s) => (s.hidden = s.id !== b.dataset.tab));
  }));

  async function renderSync() {
    const st = await S.status();
    $("sync").className = `sync ${st.mode}`;
    $("syncText").textContent = st.text;
    $("sync").title = st.detail;
  }

  async function renderPins() {
    const pins = await S.getPins();
    $("pinsEmpty").hidden = pins.length > 0;
    $("pinTable").hidden = pins.length === 0;
    const best = (k) => Math.max(...pins.map((p) => p[k] ?? -Infinity));
    const bPeak = best("peakOvr"), bCeil = best("ceiling"), bBrk = best("breakout");
    const bBust = Math.min(...pins.map((p) => p.bust ?? Infinity));
    $("pinTable").querySelector("tbody").innerHTML = pins.map((p, i) => `
      <tr>
        <td><a href="${BBGM}${esc(p.url)}" target="_blank">${esc(p.name)}</a><small>${esc(p.label || "")} · ${p.season} · L${p.lid} · ${ago(p.savedAt)}</small></td>
        <td>${p.age}</td><td>${p.ovr}</td>
        <td class="${pins.length > 1 && p.peakOvr === bPeak ? "best" : ""}">${p.peakOvr}</td>
        <td class="${pins.length > 1 && p.ceiling === bCeil ? "best" : ""}">${p.ceiling}</td>
        <td>${p.peakAge}</td>
        <td class="${pins.length > 1 && p.breakout === bBrk ? "best" : ""}">${pct(p.breakout)}</td>
        <td class="${pins.length > 1 && p.bust === bBust ? "best" : ""}">${pct(p.bust)}</td>
        <td><button class="x" data-i="${i}" title="Unpin">×</button></td>
      </tr>`).join("");
    $("pinTable").querySelectorAll(".x").forEach((b) => (b.onclick = async () => {
      await S.togglePin(pins[Number(b.dataset.i)]);
      renderPins(); renderSync();
    }));
  }

  async function renderReports() {
    const reps = await S.listReports();
    $("reportsEmpty").hidden = reps.length > 0;
    $("reportList").innerHTML = reps.map((r, i) => `
      <li>
        <div class="top"><a href="${BBGM}${esc(r.url)}" target="_blank"><b>${esc(r.name)}</b></a><button class="x" data-i="${i}" title="Delete">×</button></div>
        <div class="meta">${r.season} · age ${r.age} · OVR ${r.ovr}/${r.pot} → peak ${r.peakOvr} @ ${r.peakAge}, ceiling ${r.ceiling} · breakout ${pct(r.breakout)} · bust ${pct(r.bust)} · ${esc(r.trend || "")} · ${esc(r.confidence || "")} confidence · ${new Date(r.savedAt).toLocaleDateString()}</div>
        ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
      </li>`).join("");
    $("reportList").querySelectorAll(".x").forEach((b) => (b.onclick = async () => {
      await S.deleteReport(reps[Number(b.dataset.i)]);
      renderReports(); renderSync();
    }));
  }

  async function renderSettings() {
    const s = await S.getSettings();
    $("nSims").value = String(s.nSims);
    $("respectFog").checked = s.respectFog;
    $("bustMode").value = s.bustMode;
    $("bustMargin").value = s.bustMargin;
    $("bustOvr").value = s.bustOvr;
    $("badges").value = s.badges;
    $("panelSide").value = s.panelSide;
    $("marginWrap").hidden = s.bustMode !== "pot";
    $("ovrWrap").hidden = s.bustMode !== "fixed";
    $("model").textContent = `Model: ${S.MODEL_VERSION} (Monte Carlo of BBGM's yearly progression rules)`;
  }
  const save = async (patch) => { await S.saveSettings(patch); renderSettings(); renderSync(); };
  $("nSims").onchange = (e) => save({ nSims: Number(e.target.value) });
  $("respectFog").onchange = (e) => save({ respectFog: e.target.checked });
  $("bustMode").onchange = (e) => save({ bustMode: e.target.value });
  $("bustMargin").onchange = (e) => save({ bustMargin: Math.max(0, Math.min(30, Number(e.target.value) || 0)) });
  $("bustOvr").onchange = (e) => save({ bustOvr: Math.max(30, Math.min(80, Number(e.target.value) || 55)) });
  $("badges").onchange = (e) => save({ badges: e.target.value });
  $("panelSide").onchange = (e) => save({ panelSide: e.target.value });

  // ---- Features tab: every element with data-k is bound to a (possibly nested) setting ----
  const ext = globalThis.chrome || globalThis.browser;
  const getPath = (o, k) => k.split(".").reduce((x, p) => (x == null ? x : x[p]), o);
  async function renderFeatures() {
    const s = await S.getSettings();
    document.querySelectorAll("[data-k]").forEach((el) => {
      const v = getPath(s, el.dataset.k);
      if (el.type === "checkbox") el.checked = !!v;
      else if (document.activeElement !== el) el.value = v ?? "";
    });
    document.querySelectorAll("[data-show]").forEach((el) => (el.hidden = !getPath(s, el.dataset.show)));
  }
  document.querySelectorAll("[data-k]").forEach((el) => {
    el.addEventListener("change", async () => {
      const s = await S.getSettings();
      const [top, sub] = el.dataset.k.split(".");
      let v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
      if (el.type === "number") v = Math.max(Number(el.min || -1e9), Math.min(Number(el.max || 1e9), v || 0));
      await S.saveSettings(sub ? { [top]: { ...s[top], [sub]: v } } : { [top]: v });
      renderFeatures(); renderSync();
    });
  });
  // Claude models come from the background script, so there's one list to maintain.
  try {
    const models = await ext.runtime.sendMessage({ type: "bbgmScout:models" });
    $("claudeModel").innerHTML = (models || []).map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join("");
  } catch (e) { /* background not ready */ }
  try {
    const { claudeKey } = await ext.storage.local.get("claudeKey");
    if (claudeKey) $("claudeKey").placeholder = "Key saved (enter a new one to replace)";
  } catch (e) { /* ignore */ }
  $("claudeKey").addEventListener("change", async (e) => {
    const k = e.target.value.trim();
    await ext.storage.local.set({ claudeKey: k });
    e.target.value = "";
    e.target.placeholder = k ? "Key saved (enter a new one to replace)" : "sk-ant-…";
  });
  renderFeatures();

  S.onChange(() => { renderPins(); renderReports(); renderSync(); renderFeatures(); });
  renderSync(); renderPins(); renderReports(); renderSettings();
})();
