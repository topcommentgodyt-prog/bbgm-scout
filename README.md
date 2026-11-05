# BBGM Scout

A small browser extension for Basketball GM. It shows a player's development outlook on their page, adds projected-peak badges beside players on draft pages, and syncs your settings, pinned players and saved reports across devices.

![Panel](docs/panel-dark.png)

## What it shows

| Metric | How it's calculated |
|---|---|
| **Peak age** | Median age of the player's career-high OVR across simulated careers (the middle-50% range is shown below it) |
| **Peak OVR** | Median career-high OVR (the 10th percentile is shown as "low") |
| **Ceiling** | 90th-percentile career-high OVR |
| **Breakout chance** | P(gain ≥ 5 OVR next season) |
| **Decline risk** | P(lose ≥ 5 OVR next season) |
| **Bust risk** | P(peak OVR stays below the benchmark). The default benchmark is POT − 5, or you can set a fixed OVR in Settings |
| **Development trend** | Actual OVR change over the last 3 seasons vs. what BBGM's progression rules expected, given the player's ratings and age at the time |
| **Confidence** | 0–100. Goes down when the outcome range is wide, scouting fog applies, the player has little history, or real-player determinism is on |

## How the model works

BBGM Scout doesn't use a guessed age curve. Each season it applies BBGM's own progression rules to the player's 15 individual ratings: the age-based base change, the random noise, each rating's age modifiers and change limits, and the coaching-budget effect. It then recomputes OVR with BBGM's formula, and runs about 1,000 simulated careers per player through age 36. Because it starts from the full ratings vector, two players with the same OVR but different builds get different forecasts. For example, a player whose OVR is mostly athleticism will age worse than one whose OVR is mostly IQ.

**Scouting fog.** On by default. For players outside your team, the forecast starts from the fuzzed ratings BBGM shows you and averages over the uncertainty implied by your scouting budget. It never peeks at true ratings. You can turn this off in Settings.

**Development trend is descriptive.** In BBGM, each year's progression is independent of past years, so a player who over-developed last year isn't more likely to do it again. The trend row tells you how the player got here; it doesn't shift the forecast.

This is an independent re-implementation of BBGM's published mechanics for personal use. BBGM's source is available to read but is not open source, so don't redistribute this extension as if it were affiliated with BBGM.

## Install

**Chrome / Edge / Brave / Arc (Mac, Windows, Linux):**
1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `bbgm-scout` folder.

**Firefox:** go to `about:debugging` → This Firefox → **Load Temporary Add-on**, then pick `manifest.json`. For a permanent install, sign the extension through addons.mozilla.org as an unlisted add-on.

**Safari (Mac):** run `xcrun safari-web-extension-converter bbgm-scout/` and build the generated Xcode project.

You'll need to install it on each browser you use. There's no hosted web version.

## Cloud sync

Settings, pinned players and saved reports are stored in the browser's built-in sync storage (`chrome.storage.sync` or Firefox Sync). They follow you to any device where you're signed in to the same browser profile with extension sync turned on. The header shows **Synced**, or **Local only** if sync is unavailable.

- Chrome's sync quota is 100 KB. Reports are capped at 60, notes at 1,500 characters, and pins at 40.
- Pins refresh themselves whenever you open that player's page.
- **League data is never uploaded or synced.** The extension reads your league's local IndexedDB (`league<id>`) in read-only mode, only for the players on the current page, and closes the connection right away.

## Notes and limits

- **Data freshness.** BBGM writes to its database periodically. If a player was just generated (for example, a new draft class), the panel may say they aren't saved yet. Advance a day or phase and try again.
- Basketball GM only. The other ZenGM sports use different rating systems.
- Leagues with real-player determinism are flagged as lower confidence, because real career data overrides random progression there.
- Coaching effect uses the team's current coaching budget level. BBGM uses a 3-season average, so the effect can differ slightly after budget changes.

## Development

```
node --test tests/engine.test.js
```

Files: `src/engine.js` (simulation), `src/data.js` (IndexedDB reader), `src/analyze.js` (player to summary), `src/content.js` (panel and badges), `src/storage.js` (sync), `popup/` (pins, reports, settings).
