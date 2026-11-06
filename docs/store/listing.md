# Chrome Web Store listing: Courtside

## Store listing tab

**Title** (from the package): Courtside

**Summary** (from the package): The all-in-one GM toolkit for Basketball GM: scouting, OVR predictions, trades, contracts, draft, team management and Autopilot.

**Category:** Games (under Lifestyle; if Games isn't offered, choose Entertainment)

**Language:** English

**Store icon:** `icons/icon128.png` (128×128)

**Screenshots** (640×400, 24-bit PNG):
1. `docs/store/screenshot-1-outlook.png`: the Outlook card on a player page
2. `docs/store/screenshot-2-autopilot.png`: the Manager tab during an Autopilot run

**Global promo video:** leave empty (optional).

**Description:** paste everything between the lines.

---
Courtside is a front-office toolkit for Basketball GM (play.basketball-gm.com). It adds a panel to every league page that scouts players, values trades and contracts, runs your draft, and can manage your team for you, even for 100 seasons at a time.

SCOUT SMARTER
• Outlook: 1,000 simulated careers per player using Basketball GM's own progression rules. See peak age, peak OVR, ceiling, breakout, decline and bust risk, and a four-season OVR forecast with ranges.
• Hover any player's name for a quick card: outlook, value to your team, contract and injury.
• Hidden gems: who's undervalued or overvalued around the league, and why.
• Scouting fog is respected: forecasts for other teams use only the ratings you can see.

MAKE BETTER MOVES
• Trades: shops your players and picks to every AI team and ranks the offers they would actually accept by how much they improve your team rating, now and over the next two seasons.
• Free agents ranked by value for the money and by how well they fit your roster's weak spots.
• Draft board with tiers, trade-down advice and an optional Auto Drafter.
• Team needs, an injury stress test, a three-season payroll plan and a Moneyball value-per-dollar view.

LET IT RUN YOUR TEAM
• Manager: lineup, minutes, re-signing (including contract length), roster cuts, free agency and trades, each move explained, with Undo.
• Strategies: Auto, Rebuild, Develop, Contend and Win Now, adjusted for the league's difficulty.
• Autopilot: sims 1–100 seasons while managing your team, with a live view of seasons completed, results and moves. It can pick a new team if you're fired and clears the owner's messages.
• Protect any player or pick (Never trade, Ask first, Big return only) and set franchise goals such as "title by 2030" or "stay under the luxury tax".

KEEP YOUR LEAGUE REALISTIC
• Realism tracks your league season by season and suggests league-setting tweaks. Apply them yourself, or let Courtside apply them automatically once a season.

FRONT OFFICE AND INSIGHTS
• Job security from the owner's mood, upcoming decisions, re-signing risk and watchlist alerts.
• Lineup synergy, playoff matchup scouting, draft class strength, rival GM tendencies, franchise history and a prediction-accuracy report.

PRIVACY
Courtside works inside your browser. It reads your league only to show its analysis, and makes changes only through Basketball GM's own functions, the same ones its buttons use. Settings sync through your browser's own sync. Nothing is sent anywhere, with one exception: the optional "Ask Claude" feature (off by default) sends your question and a short player summary to Anthropic's API, using your own API key.

Courtside is an independent, unofficial extension. It isn't affiliated with or endorsed by Basketball GM or ZenGM.
---

## Privacy tab (next page of the form): suggested answers

**Single purpose:** Courtside adds scouting, team-management and simulation tools to Basketball GM league pages (play.basketball-gm.com).

**Permission justifications:**
- `storage`: saves your settings, pinned players, reports and per-league protections (synced through the browser's own sync).
- Host permission `https://api.anthropic.com/*`: used only by the optional "Ask Claude" feature, which is off by default, to send the user's question with their own API key.
- Content scripts on `play.basketball-gm.com` / `beta.basketball-gm.com`: show the panel and read the open league.

**Remote code:** No. All code ships in the package. The scripts it runs inside Basketball GM's own engine are fixed strings in the package.

**Data usage:** it doesn't collect or sell user data. The only data that leaves the browser is the optional Ask Claude question, sent to Anthropic at the user's request. Tick the certifications that apply.
