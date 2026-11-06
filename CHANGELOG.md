# Changelog

## 3.0.0

The whole roadmap in one release, plus a smarter manager. Everything was tested on the live BBGM site (play.basketball-gm.com, v2026.10.30) in a random-players league on Hard, over several Autopilot seasons.

### Manager: wins more
- **Win engine inside every decision.** Each trade and free-agent signing now gets a *fit* score, recomputed every game day:
  - how it changes your weakest areas compared with the league (shooting, rim protection, playmaking…)
  - how it changes your best five's skill synergy (BBGM's on-court bonus)
  - near the top, how it changes your best player
  
  It adds at most ±0.6 team-rating points to the trade score, and the "Why" on each move names the weakness it fixes.
- **Fixed: offseason trades overrated.** Empty roster spots used to count as 0 OVR, so with a short offseason roster any one player looked like +10 team rating. They now count as a replacement-level player.
- **Real title shot.** Auto goes Win Now only within ~2.5 team-rating points of the best team.
- **Job-aware.** If the owner's mood projects a firing, Auto won't pick a long rebuild.
- **Walk-risk trades.** Before the deadline it shops core players who are unlikely to re-sign, so they don't leave for nothing.
- **Playoff mode.** In the playoffs the rotation tightens to 8 and stars get more minutes, whatever the strategy.
- **Draft class aware.** It shops this year's picks harder in a weak class and keeps them in a strong one.
- **Challenge modes respected:** "No trades" (no trades) and "No free agents" (minimum contracts only).

### Re-signing: doesn't re-sign everyone
- It lets walk players who'd be outside next season's rotation, anyone a cheaper free agent at least as good can replace, and deals that break the three-season payroll plan or the luxury-tax objective.
- **It picks the contract length** (BBGM asks the same salary for any length): long deals for rising young players, short ones for veterans.
- **Go over the cap when needed** (on by default): under a soft cap, BBGM lets you exceed the cap to re-sign your own players and sign minimum contracts. The payroll plan no longer blocks those when they're worth it. A hard cap is never broken.

### New: Office tab
- **Job security:** BBGM's exact owner-mood formula (wins, playoffs, money), the running total and this season's projection. You're fired below −1 after the grace period.
- **Coming up:** trade deadline countdown, expiring contracts, draft, re-signing, free agency and roster limits, each with a shortcut.
- **Re-signing risk:** each expiring player's chance of re-signing, from BBGM's own mood model.
- **Watchlist alerts** for pinned players: breakout, decline, traded, free agent, injured, contract expiring.
- **Franchise objectives:** title by a season, stay under the luxury tax, never trade first-round picks, draft for a future star.
- **Compact mode:** a mini panel with three metrics you pick.

### New: Insights tab
- **Lineup synergy:** your starting five vs the best-fitting five, and what's missing on the floor.
- **Playoff matchup scout:** your opponent's strengths and weaknesses, or the top threats before the playoffs.
- **Draft class strength:** compared with past classes in this league.
- **Rival GM tendencies:** buyers, sellers, pick hoarders, cap-strapped teams, active traders, and what to offer each.
- **Franchise legacy:** players you drafted or who played for you, their awards, and where they are now.
- **Prediction accuracy:** Courtside's next-season forecasts graded a season later (error vs a "no change" guess, 80%-range coverage, bias). Other teams' players are graded against the OVR you can see, so scouting fog is never leaked.
- **Strategy benchmark:** Autopilot runs grouped by strategy, for A/B tests on exported copies of a league.
- **Health check:** confirms every BBGM action Courtside uses still exists. Autopilot runs it before starting and refuses to start if something it needs is missing.

### Manager tab
- **Autopilot live:** seasons completed out of your target, current season, phase and record, season results (🏆 for titles), latest moves, time per season and time left.
- **Action queue:** tick suggested moves and run them together. Each is re-checked against the game state first.
- **Timeline:** the activity log with filters (trades, signings, draft, seasons, strategy, problems). Every finished season is logged with its record and playoff result.

### Interface
- **Drag the dock anywhere** by its logo and name, even while Autopilot is simming. The position is saved, and a double-click resets it.
- **Command bar (Alt+K):** jump to any tab or BBGM page, or run Autopilot, a trade search, a re-plan or the health check.
- Cleaner collapsible cards, consistent spacing, and ordinal fixes ("83rd percentile", not "83th").

### Changed
- **"Big return only" protection level:** the asset can be traded only in a deal scoring 3× your minimum and adding long-term value.
- **Trade cooldown removed.** Newly acquired players can be traded again right away. Rejected deals still aren't re-proposed for 10 game days, and the same players aren't retried after two rejections.
- Move memory has a hard size limit, so 100-season runs can't grow it without bound.

### Fixed
- A 2.7.1 change replaced the dock's link helper, which could block navigation from player links. It's renamed and the original behavior is restored.
- Franchise legacy no longer shows "undefined" awards.

### Known limits
- Lineup synergy recommends a starting five but doesn't set it. BBGM's auto-sort orders by OVR, so set it on BBGM's Roster page with "Keep auto sorted" off.
- After a team switch, the Autopilot summary's season table shows the new team's record for every season of the run. The live season log shows the right team.
- Prediction accuracy needs one full season of play before it can grade anything.

## 2.7.1

### New
- **Auto-pick a new team when fired** (Autopilot, off by default). When BBGM fires you (game over), Autopilot no longer stops. It takes over the strongest team BBGM offers on its New Team page and keeps playing. That's the five worst records this season, or any team in God Mode. "Strongest" means team rating now and in two seasons. The switch is logged with every team it considered and their scores. Turn it on in the Manager tab's Advanced settings or the popup's Features tab. When it's off, Autopilot stops as before, and the message now points to the toggle.
- **Auto-read owner messages** (Autopilot, on by default). Unread inbox messages, such as the owner's "Annual performance evaluation", are opened automatically during and after an Autopilot run. You no longer have to click "Read new message" for every season before BBGM lets you play again. It uses BBGM's own message page, so nothing writes to the league directly. If BBGM doesn't handle the link, Autopilot keeps going, logs it, and never reloads the page mid-run.

### Improved
- **Difficulty-aware manager.** All strategies (Auto, Rebuild, Develop, Contend, Win Now) now adjust to the league's BBGM difficulty:
  - Hard / Insane: young players and picks you give up count 15% / 60% more, and so does long-term value lost in a trade. Develop and Contend may give up less long-term value per deal. Contend and Win Now accept a 6% / 25% smaller minimum gain, since the trade AI rarely offers good deals.
  - Easy: the reverse. Talent is cheap to buy, so youth and picks count 15% less, and each trade must clear a 6% higher bar.
  - Auto needs a stronger roster before it chooses Contend or Win Now on harder difficulties (slightly weaker on Easy).
  - The strategy's reasons in the Manager tab now include how difficulty changed the plan.

### Under the hood
- League snapshots now read BBGM's `difficulty` setting.
- The game poll now reports unread inbox messages.
- New allow-listed BBGM action: `main.switchTeam`. Autopilot uses it only when "Auto-pick a new team when fired" is on.
- Checkboxes in the Manager tab's Advanced settings are now supported.

### Known limits
- After a team switch, the run summary's season table shows the new team's record for every season of the run.
- Re-signing and free-agent decisions don't get a separate difficulty adjustment. They already use BBGM's asking prices, which include difficulty.
