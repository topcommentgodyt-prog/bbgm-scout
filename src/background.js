/*
 * BBGM Scout – background script: optional "Ask Claude" calls.
 *
 * Off by default. When you turn it on and paste an Anthropic API key, the
 * assistant sends your question plus a compact summary of the relevant
 * players to the Claude Messages API. The key stays in this device's local
 * extension storage and is never synced.
 */
const api = globalThis.chrome || globalThis.browser;

const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5 (default)", fallback: true },
  "claude-fable-5-1": { label: "Claude Fable 5.1 (most capable)", fallback: true },
  "claude-fable-5": { label: "Claude Fable 5" },
  "claude-opus-5": { label: "Claude Opus 5", fallback: true },
  "claude-opus-4-8": { label: "Claude Opus 4.8" },
  "claude-opus-4-7": { label: "Claude Opus 4.7" },
  "claude-opus-4-6": { label: "Claude Opus 4.6" },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", fallback: true },
  "claude-sonnet-5": { label: "Claude Sonnet 5" },
  "claude-sonnet-4-6": { label: "Claude Sonnet 4.6" },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5 (cheapest)" },
  "claude-haiku-4-5": { label: "Claude Haiku 4.5", legacy: true },
};

const SYSTEM = `You are the scouting assistant inside BBGM Scout, a browser extension for the game Basketball GM.
You get JSON with the user's team, league context and player forecasts from BBGM Scout's model, which simulates BBGM's real progression rules.
Field notes: ovr/pot are BBGM ratings as shown to the user; peakOvr is the median career-high OVR; ceiling is the 90th percentile; breakout/decline are next-season probabilities; gemScore > 15 means the Scout model rates the player well above BBGM's own valuation.
Answer the user's question directly, using only the data given. Give a clear recommendation first, then the 2-4 facts from the data that support it. Keep it under 200 words unless asked for more. If the data can't answer the question, say what's missing.`;

async function askClaude({ question, context, model }) {
  const { claudeKey } = await api.storage.local.get("claudeKey");
  if (!claudeKey) return { error: "Add your Anthropic API key in BBGM Scout settings first." };
  const m = MODELS[model] ? model : "claude-opus-5-5";
  const body = {
    model: m,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content: `League data:\n${JSON.stringify(context)}\n\nQuestion: ${question}` }],
  };
  if (!MODELS[m].legacy) {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: "low" }; // quick Q&A; keeps answers fast and cheap
  }
  const headers = {
    "content-type": "application/json",
    "x-api-key": claudeKey,
    "anthropic-version": "2026-10-21",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (MODELS[m].fallback) {
    // If a safety classifier declines the request, let the API re-run it on its recommended fallback model.
    body.fallbacks = "default";
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    return { error: `Couldn't reach the Claude API (${e.message}).` };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || res.statusText;
    if (res.status === 401) return { error: "That API key was rejected. Check it in settings." };
    if (res.status === 429) return { error: "Rate limited by the Claude API. Try again in a moment." };
    if (res.status >= 500) return { error: `Claude API is having trouble (${res.status}). Try again shortly.` };
    return { error: `Claude API error ${res.status}: ${msg}` };
  }
  if (data.stop_reason === "refusal") return { error: "Claude declined to answer this question." };
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return { text: text || "(No answer returned.)", model: data.model, truncated: data.stop_reason === "max_tokens" };
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "bbgmScout:askClaude") {
    askClaude(msg).then(sendResponse, (e) => sendResponse({ error: String(e.message || e) }));
    return true; // async response
  }
  if (msg && msg.type === "bbgmScout:models") {
    sendResponse(Object.entries(MODELS).map(([id, v]) => ({ id, label: v.label })));
    return false;
  }
  return false;
});
