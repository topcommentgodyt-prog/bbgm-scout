# BBGM Scout: notes for Claude

## Always publish changes
The owner wants GitHub updated every time they ask for a change. After any change:
1. Bump `version` in **both** `manifest.json` and `manifest.firefox.json` (patch for fixes, minor for features).
2. Run the tests: `node --test tests/engine.test.js`.
3. Rebuild the downloads: `./scripts/build.sh` (writes `dist/bbgm-scout.zip` and `dist/bbgm-scout-firefox.zip`).
4. Commit everything, including `dist/`, and `git push origin main`. Don't ask first; this is standing permission for this repo.
5. Report the commit and the download link: https://github.com/topcommentgodyt-prog/bbgm-scout/raw/main/dist/bbgm-scout.zip

GitHub Releases can't be created from Claude's cloud sessions. The owner publishes those manually; offer release notes when versions change.

## Project facts
- Chrome manifest uses `background.service_worker` only (`background.scripts` triggers a Chrome warning). Firefox uses `manifest.firefox.json` with `background.scripts`.
- Page-world bridge: `src/bridge-main.js` allow-lists every BBGM `toWorker` action. Add new actions there.
- Autopilot progress detection must use `progressKey` (playoff round/wins, schedule length, daysLeft), not just regular-season games played.
- Docs to keep in sync with features: `README.md`, `docs/FEATURES.md`, `docs/LIVE_TESTING.md`.
- The extension is tested against a mock BBGM engine (unit tests, backtest) and, since v3.0, by loading the scripts into the live BBGM site with a stand-in for extension storage. It hasn't been tested installed as a real extension or in Firefox; say so when relevant.
- `src/insights.js` (v3.0) holds the win engine (`winContext` / `fitGain`) plus the Office and Insights analysis; it loads after `planning.js` (both manifests).
- On Windows, `scripts/build.sh` needs `zip`, which Git Bash doesn't include; build the zips with .NET `ZipArchive` using the same layout (a `bbgm-scout/` folder in both zips) and forward-slash entry names.
