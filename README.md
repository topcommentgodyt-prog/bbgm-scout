# Courtside

*Formerly BBGM Scout.* The all-in-one GM toolkit for Basketball GM.

A browser extension for Basketball GM: player development outlooks, a hidden-gem assistant, trade help, free-agent and draft tools, automatic team management, and an Autopilot that sims seasons while managing your team. Settings, pins and reports sync across devices.

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

**OVR and potential predictions.** On any player's page, the Outlook tab predicts OVR for each of the next four seasons (expected value and 80% range) and shows **Scout POT**: the most likely career-high OVR from 1,000 simulations of BBGM's progression rules, next to BBGM's own 20-simulation POT. Hover cards show the next two seasons. An **Attributes** table shows every rating with ▲/▼ changes since last season and since you opened the player, and it refreshes by itself as you play, so progression shows up live.

**Share to Reddit.** Player outlooks and Autopilot run summaries have a **Share to Reddit** button. It opens Reddit's post form (r/BasketballGM by default, changeable in Settings) already filled in; you review it and press Post yourself. The extension never sees your Reddit login.

## Tools (each can be turned on or off in the popup's Features tab)

**Master switch (v3.2):** click the Courtside icon in your toolbar and flip the switch in the popup's header. Off means nothing appears on BBGM pages (no dock, hover cards, badges or command bar), Autopilot and the automatic manager stop, and the icon shows "OFF". Your settings are kept, and switching it back on brings everything back on the page you're on, with no reload. (Updating from 3.2.0 or earlier? Refresh open BBGM tabs once after updating, so the old copy of Courtside in them is replaced.)

The dock in the bottom corner of every BBGM league page has one tab per tool. Click its header (or ▼ Close / ▲ Open) to collapse or expand it. The ◐ button switches between Auto, Light and Dark mode; the popup has the same button.

- **Move it anywhere:** press and drag the ball logo / "Courtside" name. It remembers the spot (and works while Autopilot is simming). Double-click the logo to put it back in the corner.
- **Command bar (Alt+K):** type to jump to any tab or BBGM page, or to run Autopilot, a trade search, a re-plan or the health check.
- **Compact mode** (Office tab): a mini panel with the three metrics you pick (team rating rank, record, job security, cap space, strategy, next decision).

**Hover cards** (on by default): hover over any player's name anywhere in BBGM to see their outlook, hidden-gem verdict, value to your team, contract or asking price, draft rank, playing time and injury.

| Tab | What it does | Default |
|---|---|---|
| **Outlook** | The development card above, on any player page | On |
| **AI** | Says whether a player is a **hidden gem**, overvalued or fair, and why. Also lists the best hidden gems around the league. Optional **Ask Claude** box for free-form questions | On (Ask Claude off) |
| **Trades** | Shops your players and picks to every AI team using BBGM's own trading-block AI, so every offer is one they'd accept. Ranks the offers by how much they raise your **team rating**. Refreshes every game day and grades whatever deal is on the trade screen | On |
| **Targets** | Players on other teams worth adding. "Ask" runs BBGM's "What would make this work?" and grades the answer | On |
| **FA** | Free agents ranked by value for the money (forecast value minus asking salary), with Sign buttons and the reason when you can't sign someone | On |
| **Draft** | Draft board ranked by the Scout model next to BBGM's own ranking, grouped into **tiers** of prospects whose forecasts overlap. **Trade-down advice** when your tier is deep: it asks teams picking later what they'd add, and suggests a deal only if a same-tier prospect should still be there. Auto Drafter can suggest or make your pick, and can trade up or down automatically | Off |
| **Manager** | Auto Team Management and Autopilot (below). A **live Autopilot section** (seasons completed of your target, current season and record, season results, latest moves, time per season), an **action queue** (tick suggested moves and run them together; each is re-checked first), and a **timeline** of everything it did, filterable by trades, signings, draft, seasons, strategy and problems, with Undo | Off |
| **Office** | **Job security** (BBGM's own owner-mood formula: wins, playoffs, money; projected for this season; firing line at −1), **coming up** (trade deadline, expiring contracts, draft, re-signing, free agency, roster limits), **re-signing risk** (each expiring player's chance of re-signing, from BBGM's mood), **watchlist alerts** for pinned players (breakout, decline, traded, free agent, injury, expiring), **franchise objectives** and compact mode | On |
| **Insights** | **Lineup synergy** (BBGM's on-court skill bonus for your five vs the best-fitting five), **playoff matchup scout** (your opponent's strengths and weaknesses, or the top threats), **draft class strength** (vs past classes in this league), **rival GM tendencies** (buyers, sellers, pick hoarders, cap-strapped), **franchise legacy** (players you drafted or who played for you, awards, where they are now), **prediction accuracy** (Courtside's forecasts graded a season later), **strategy benchmark** and a **health check** | On |
| **Needs** | **Injury stress test** (what your team rating and skill ranks lose if your best players, top rim protector or ball handler miss time, with affordable backups) plus the team needs scanner: your three biggest weaknesses compared with every team (outside shooting, inside scoring, ball handling & passing, perimeter defense, rim protection, rebounding, athleticism, bench depth, star power), each linked to the best trade target, free agent and draft prospect to fix it, with Ask / Sign buttons | On |
| **Plan** | The next three seasons: projected team rating and league rank, committed payroll, cap space, expiring contracts and your picks, with warnings (stars declining before prospects are ready, a closing window, a cap crunch, no first-rounders). Also where you set **Never trade / Ask first / Available** for every player and pick | On |
| **Moneyball** | Value per dollar, in BBGM's team rating: payroll efficiency for every team, your roster by value per dollar (overpaid / bargain), the best value-per-dollar players available, **market inefficiencies** (skills, ages and builds BBGM's AI under- or over-values), age arbitrage (buy before the peak, sell before the decline), and cheaper swaps that make you better | On |
| **Realism** | Records league-wide numbers every season (stars per team, parity, payrolls vs. the cap, max contracts, long injuries, scoring, three-point rate) and suggests God Mode / league setting tweaks as the years go on. For example: a hard cap or higher luxury tax when dynasties form, inflation when the cap never changes, a different Three Point Tendency Factor when the style drifts from the modern NBA. **Apply** or **Apply all suggestions** sets them for you through BBGM's own settings function, after a confirmation listing every change, with **Undo**. Most need God Mode, which applying offers to turn on. **Automation (v3.1, off by default):** "Apply automatically once a season" applies the suggestions in the game by itself once each season ends (draft lottery onward), from any tab and during Autopilot, before the manager plans its moves. It turns God Mode on with the first change, logs every change and can be undone; switching the salary cap type stays manual | On |

**Franchise strategy.** The Manager tab's Strategy menu has **Auto**, **Rebuild**, **Develop**, **Contend** and **Win Now**. Each has one multi-season objective: how much this season counts against the next two, how future value is discounted, and how much it penalizes giving up young players or picks, or taking on aging players.
- **Auto** looks at your team rating now and projected in two seasons (league percentiles), your record once enough games are played, the age of your top five, your first-round picks, young players projected to start, and next season's cap room.
- It re-decides only at three checkpoints a season (start, mid-season around the trade deadline, offseason). It needs a clear margin to switch, so a hot or cold streak doesn't flip the plan. Each switch is logged with its reasons, and the decision syncs with your settings.
- Pick a strategy yourself to override Auto. (The old "Balanced" setting becomes Develop.)
- **Real title shot (v3.0).** Auto goes Win Now only within about 2.5 team-rating points (~7 wins) of the best team; otherwise a strong team stays on Contend.
- **Job on the line (v3.0).** If the owner's mood projects a firing, Auto won't choose a multi-season rebuild.
- **Franchise objectives (v3.0, Office tab):** win a title by a season (Auto goes all-in as the deadline nears, or says it's out of reach), stay under the luxury tax, never trade first-round picks, draft for a future star (prospects ranked by ceiling). Trades, signings and re-signings that break them are ruled out.
- **Difficulty-aware (v3.0).** Every strategy adjusts to the league's BBGM difficulty. On Hard and Insane the trade AI asks more and players are less willing to sign with you, so young players, picks and long-term value you own count more. Contend and Win Now accept smaller real gains, because good trades are rarer, and Auto needs a stronger roster before it contends. Easy is the reverse. The strategy's reasons say how difficulty changed the plan.

**Team rating and trades.** Trades are judged with BBGM's own team-rating formula: predicted margin of victory from your top 10 OVRs, where 1 point is about 2.7 wins over 82 games. Each trade gets one score for the active strategy, combining:
- team rating now and in each of the next two seasons
- long-term value
- payroll over the next three seasons against your league's hard cap or tax line
- draft picks given up
- young talent given up (heavily penalized when rebuilding)
- expected decline of players 30 and older (priced in for Win Now)
- roster limits
- **fit (v3.0):** how the deal changes your weakest areas compared with the league (shooting, rim protection, playmaking and so on), your best five's skill synergy and, when you're close to the top, your best player. Recomputed every game day; worth at most ±0.6 points, and it counts more the more the strategy is about now. Each move's "Why" names the weakness it fixes.

The manager only makes a trade that clears your minimum improvement and the strategy's own checks, and that BBGM's trade AI actually accepts. Before the deadline it also shops core players who are unlikely to re-sign (BBGM's own willingness estimate), so they don't leave for nothing, and it shops this year's picks harder in a weak draft class.

**Move memory.** A deal BBGM rejected isn't proposed again for 10 game days, and the same players (with only the picks changed) aren't retried after two rejections, unless the gain is big. Moves that fail three times are paused for a while. Never trade is never overridden. (The trade cooldown on newly acquired players was removed in v3.0.)

**Challenge modes.** BBGM's challenge modes are respected: no trades with "No trades", only minimum contracts with "No free agents".

**Auto Team Management.** Each part has its own switch. Choose "Suggest" (you approve each move) or "Fully automatic".
- **Finances:** budget style (win now, balanced or profit) and auto ticket price.
- **Lineup:** keeps the roster auto-sorted.
- **Playing time:** gives more minutes to your best players when contending, and to young high-upside players when rebuilding. Gives fewer minutes to the end of the bench, and benches injured players and anyone below the rotation. Optional tanking. In BBGM, minutes don't affect progression, but they do affect player mood. **Playoff mode (v3.0):** in the playoffs the rotation tightens to 8, stars play more whatever the strategy, and there are no development minutes or tanking.
- **Re-signing (smarter in v3.0):** it doesn't re-sign everyone. It keeps players worth their asking price, and young players (25 and under) projected to start unless clearly overpriced. It lets walk anyone projected outside next season's rotation (bench depth is cheap), anyone a cheaper free agent at least as good can replace, and deals that break the three-season payroll plan or the luxury-tax objective. **Contract length is chosen for you,** since BBGM asks the same salary for any length: long deals for rising young players, 2–3 years in the prime, 1 year for veterans 31+ (and for anyone 27+ while rebuilding). In hard-cap leagues it lets players walk first, then re-signs best value first while each one still fits under the cap.
- **Go over the cap when needed (v3.0, on by default):** under a soft cap, BBGM lets you exceed the cap to re-sign your own players and to sign minimum contracts. The payroll plan then doesn't block a positive-value re-signing while contending (or a clearly valuable one at any time). A hard cap is never broken.
- **Roster cuts:** when the roster is over the limit, releases the players worth least to you. Released salary is still owed in BBGM, so salary isn't a reason to cut, and young players' long-run value counts unless you're going for Win Now.
- **Free agency checker (v3.1):** the Manager tab shows roster size against BBGM's limits, cap room (or "minimum deals only"), free-agency days left and the best fits, with any problem flagged. During free agency, Autopilot goes day by day (week by week on the weekly step) while you have open spots and players worth signing, because asking prices fall over the 30 days. Otherwise it finishes free agency in one step. The roster is always brought to the minimum before games.
- **Free agents:** ranked by value plus fit (v3.0). Signs players to fill the roster, within the cap and a **three-season payroll plan**. The plan covers contracts already signed, room to re-sign young players projected to start, and rookie deals for your first-round picks, measured against your league's hard cap or luxury-tax line (from the league settings, not hard-coded defaults).
- **Trades:** as described above.
- **Every move is explained.** Expand "Why" on a suggestion or log entry to see the reason, the measurable benefits and costs, the strategy it served, and whether the numbers were projected at the time.

**Risk preference.** Conservative, Balanced or Upside, separate from the team timeline (Auto: reliable when contending, upside when rebuilding). Two players with the same expected value can carry very different risk. Conservative weights each player's 10th-percentile outcome, Upside their 90th. It affects trades, free agents, targets, the draft board and the manager.

**Protected assets and contract rules.** Mark any player or pick as *Never trade*, *Ask first* or *Big return only* (Plan tab, or the Outlook card for your own players). Protections are synced per league.
- *Big return only (v3.0):* tradable only in a deal that scores at least 3× your minimum improvement and adds long-term value. It doesn't affect re-signing or cuts.
- *Never trade:* no automated feature will trade, cut or let that asset walk, and the Trade Helper never shops it or offers it.
- *Ask first:* automated features may propose a move involving it, but it always waits for your approval, even in fully automatic mode and in Autopilot.

You can also set the longest contract the manager may give and how much cap space to always keep free. Signings, re-signings and trades that break these rules are skipped or flagged.

**Autopilot.** Like BBGM's Auto Play, but your team keeps being managed by the rules above instead of the game's AI. It plays a day (or a week) at a time through the regular season, playoffs, draft, re-signing, free agency and preseason. Before every step it runs the manager and the Auto Drafter. It stops after the number of seasons you choose (a 1–100 dropdown in the Manager tab), at an optional checkpoint, when you press Stop, or if BBGM needs your attention.
- **Fully automatic (v2.4.1, default):** Autopilot no longer waits for you.
  - It also makes moves involving *Ask first* players or picks, and moves that break your contract rules. Switch "Moves that need your OK" to "Pause for me" to get the old behavior. *Never trade* is still respected: those players are never traded, cut or let go by Autopilot.
  - Every expiring contract is decided before free agency, so BBGM's "players remain unsigned" prompt doesn't appear. If it does (for example, a Never-trade player who refuses to re-sign), Autopilot answers it and logs it.
  - It votes on league expansion (yes) and team relocation (no); the league still decides by vote.
  - Before an expansion draft it protects your players: Never trade first, then Ask first, then the most valuable for your strategy, up to the league's limit. Then it runs the expansion draft, and fantasy drafts too.
  - Any other BBGM dialog is left for you, and the Manager tab says so.
- **Auto-pick a new team when fired (v3.0, off by default):** when BBGM fires you, Autopilot takes over the strongest team on BBGM's New Team list (the five worst records, or any team in God Mode), judged by team rating now and in two seasons, and keeps playing. Off: Autopilot stops so you can choose.
- **Auto-read owner messages (v3.0, on by default):** opens unread inbox messages, like the owner's "Annual performance evaluation", during and after the run, so you don't have to click through them before BBGM lets you play again. If BBGM doesn't open them, Autopilot keeps going and logs it.
- **Safeguards:** before each move it checks that BBGM is idle and still at the game state the plan was made for, so a stale plan is never acted on. The same move is never repeated at the same game state, even after a re-render or retry. Stop takes effect between moves, never in the middle of one. It stops itself if the game doesn't advance or the manager keeps going in circles.
- **Run summary:** when a run ends, the Manager tab shows championships, playoff appearances, regular-season win %, salary spent per win (with the league average for context), trades and other moves, draft picks, strategy changes, roster turnover, and a season-by-season table. These are observed results from BBGM's records. The summary doesn't claim Autopilot caused them; there's no comparison against what would have happened otherwise.

The Manager tab opens with a compact dashboard (Strategy, Seasons, approvals waiting, Run/Stop). Advanced settings are collapsed underneath: manager mode, step size, checkpoint, minimum trade improvement, trade cooldown, and how often to search for trades.

**How actions happen.** A small script in the BBGM page calls the same internal functions BBGM's own buttons use (`bbgm.toWorker`). Only an allow-listed set of actions is possible. The game enforces its rules (cap, roster limits, trade deadline, player willingness) and records undo entries. Read-only league snapshots go through BBGM's official worker-console mechanism. Nothing writes to the league database directly.

**Ask Claude.** Off by default. Add your Anthropic API key in Features. The key is stored only on this device and never synced. Pick any current Claude model (Claude Opus 5.5 is the default). Your question and a short summary of the relevant players are sent to the Claude API, billed to your account. Your league file is never sent.

## How the model works

Courtside doesn't use a guessed age curve. Each season it applies BBGM's own progression rules to the player's 15 individual ratings: the age-based base change, the random noise, each rating's age modifiers and change limits, and the coaching-budget effect. It then recomputes OVR with BBGM's formula, and runs about 1,000 simulated careers per player through age 36. Because it starts from the full ratings vector, two players with the same OVR but different builds get different forecasts. For example, a player whose OVR is mostly athleticism will age worse than one whose OVR is mostly IQ.

**Scouting fog.** On by default. For players outside your team, the forecast starts from the fuzzed ratings BBGM shows you and averages over the uncertainty implied by your scouting budget. It never peeks at true ratings. You can turn this off in Settings.

**Development trend is descriptive.** In BBGM, each year's progression is independent of past years, so a player who over-developed last year isn't more likely to do it again. The trend row tells you how the player got here; it doesn't shift the forecast.

This is an independent re-implementation of BBGM's published mechanics for personal use. BBGM's source is available to read but is not open source, so don't redistribute this extension as if it were affiliated with BBGM.

## Works with any league

Open any Basketball GM league in the browser and Courtside attaches to it automatically. It reads the league number from the page address and the game's live state every few seconds. That includes random leagues, real-player leagues, custom and uploaded leagues, and leagues mid-season or mid-sim. Settings, pins and reports are shared across leagues; protections, the Realism history and trade timing are kept per league.

**Synced data follows the right league on every device.** BBGM numbers leagues per browser, so "league 1" on one computer can be a different league on another. Courtside gives each league a fingerprint built from facts that never change and travel with an exported league file: its starting season and its first players' names and birth years. Pins, reports and protections are stored under that fingerprint. Each device remembers which local league number matches it, and pins for a league you haven't opened on a device yet are shown without a link until you do. Things to know:
- Only leagues on play.basketball-gm.com (or beta.basketball-gm.com) in a browser where the extension is installed. It can't reach leagues on another device or in the mobile app.
- Multi-team mode and spectator mode: the scouting tools work, but leave the Manager and Autopilot off (they assume you control one team).
- Real-player leagues with "real player development" on are flagged as lower confidence, because real careers override BBGM's random progression.

## Download

- **Chrome / Edge / Brave / Arc:** [bbgm-scout.zip](https://github.com/topcommentgodyt-prog/bbgm-scout/raw/main/dist/bbgm-scout.zip)
- **Firefox:** [bbgm-scout-firefox.zip](https://github.com/topcommentgodyt-prog/bbgm-scout/raw/main/dist/bbgm-scout-firefox.zip)

These always match the latest version on `main`.

## Install

**Chrome / Edge / Brave / Arc (Mac, Windows, Linux):**
1. Download and unzip `bbgm-scout.zip` (above).
2. Go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped `bbgm-scout` folder.

**Firefox:** download the `-firefox` ZIP from Releases (or, in the source folder, rename `manifest.firefox.json` to `manifest.json`). Then go to `about:debugging` → This Firefox → **Load Temporary Add-on** and pick `manifest.json`. For a permanent install, sign the extension through addons.mozilla.org as an unlisted add-on.

**Safari (Mac):** run `xcrun safari-web-extension-converter bbgm-scout/` and build the generated Xcode project.

You'll need to install it on each browser you use. There's no hosted web version.

## Cloud sync

Settings, pinned players and saved reports are stored in the browser's built-in sync storage (`chrome.storage.sync` or Firefox Sync). They follow you to any device where you're signed in to the same browser profile with extension sync turned on. The header shows **Synced**, or **Local only** if sync is unavailable.

- Chrome's sync quota is 100 KB. Reports are capped at 60, notes at 1,500 characters, and pins at 40.
- Pins refresh themselves whenever you open that player's page.
- **League data is never uploaded or synced.** The extension reads your league's local IndexedDB (`league<id>`) in read-only mode, only for the players on the current page, and closes the connection right away.

## Notes and limits

- **Run the live checklist first:** [docs/LIVE_TESTING.md](docs/LIVE_TESTING.md) walks through a copied league step by step.
- **How it's been tested.** Version 2.4.0 was run on the live BBGM site (play.basketball-gm.com, a new random-players league). The scripts were loaded into the page with a stand-in for the extension's storage, not installed as an extension, and Firefox wasn't tested. Every tab loaded, and a one-season Autopilot run finished with explanations and a summary. Unit tests cover the strategy, trade scoring, pick values, move memory and summary. A backtest harness compares versions on a simplified mock league (see Development). Try it on a copy of a league first (Tools → Export, or a new league) and start the Manager in Suggest mode.
- BBGM's internal API isn't a public contract. If a BBGM update renames something, the affected tool shows an error in its tab and the log, and the rest keep working.
- Trade searches ask every AI team to build an offer, which takes a few seconds per player shopped. If day-by-day sims feel slow, raise "Search for trades every N game days".
- If BBGM shows a dialog (a roster or cap error, for example), Autopilot stops and says so.
- Basketball GM only. The other ZenGM sports use different rating systems.
- Leagues with real-player determinism are flagged as lower confidence, because real career data overrides random progression there.
- Coaching effect uses the team's current coaching budget level. BBGM uses a 3-season average, so the effect can differ slightly after budget changes.

## Development

```
node --test tests/
node tests/backtest/run.js --seasons 3 --seeds 3 --long 15 --out tests/backtest/results.json
```

The backtest runs the Manager and Autopilot loop of two versions (by default v2.3.0 and your working tree) on a seeded mock league. The mock implements the parts of BBGM's API the extension uses, with simplified rules. It uses identical starting states and several scenarios: default, rebuilding, contender, expensive aging roster, injury-heavy, and custom rules (hard cap, small rosters, 40 games). It records win %, titles, playoff appearances, end roster value, payroll, failed actions, rule violations, stalls and runtime. The mock isn't BBGM: use it to compare versions with each other, not to predict real leagues. The latest results are in `tests/backtest/results.md`.

Files: `src/engine.js` (simulation), `src/strategy.js` (Strategy Brain, trade scoring, pick uncertainty, move memory, run summary), `src/analyze.js` (player to summary), `src/league.js` (league-wide values, pick values, team rating), `src/features.js` (assistant, trades, targets, FA, drafter, manager, autopilot rules), `src/bridge-main.js` + `src/bridge.js` (allow-listed link to BBGM's engine), `src/content.js` (dock, autopilot loop, badges), `src/background.js` (Ask Claude), `src/data.js` (IndexedDB reader), `src/storage.js` (sync and device-only log), `popup/` (pins, reports, features, settings).

## License

[MIT](LICENSE) © 2026 topcommentgodyt-prog. The license covers Courtside's own code. Basketball GM is a separate product by ZenGM; Courtside isn't affiliated with or endorsed by it.
