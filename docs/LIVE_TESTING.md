# Live testing checklist (run on a copied league)

Courtside has been tested against a mock of BBGM's engine, and its scripts have been run on the live site in a test league (not as an installed extension). Before trusting automation in a league you care about, run this once on a copy. It takes about 20–30 minutes.

## Setup

1. In BBGM, open your league → **Tools → Export** and save the file. Then **New League → Upload league file** to make a copy. Or just start a new random league.
2. Load the extension (`chrome://extensions` → Developer mode → Load unpacked).
3. In the popup → **Features**, turn on everything, but leave **Auto Team Management on "Suggest"** for now.
4. Open **Chrome DevTools → Console** on the BBGM tab and keep it open. Note any red errors that mention Courtside.

For each step, mark ✅ / ❌ and note what happened.

## A. Reading the league

- [ ] The dock appears in the bottom-right corner; ▼ Close / ▲ Open works; ◐ switches the theme.
- [ ] Open a player page: the Outlook tab shows numbers (no "Waiting for BBGM…" stuck for more than 10 s).
- [ ] Hover over a player name in a roster table: a card appears; moving away hides it.
- [ ] Click a player name in the dock: the page changes to that player **in the same tab, without a full reload**.
- [ ] The AI, Needs, Plan, FA, Targets and Realism tabs all load.

## B. Suggestions only (nothing changes yet)

- [ ] Trades tab → **Search again** finishes. Note how long it takes: ______ s.
- [ ] Open BBGM's trade screen, add players to a deal: the Trades tab grades it.
- [ ] Manager tab lists suggested moves. **Don't approve anything yet.** Do the suggestions make sense?
- [ ] Manager dashboard: Strategy shows **Auto (…)** with a strategy name; expanding it lists the reasons (team rating percentiles, core age, picks, cap room). Does the pick match your team?
- [ ] Expand **Why** on a few suggestions: each shows a reason, benefits and costs, the strategy, and "projected".
- [ ] Switch Strategy to **Rebuild**, then **Win Now**: the Trades and Targets headers change, and the suggested trades change. Set it back to **Auto**.
- [ ] **Advanced settings** is collapsed by default and opens; changing Trade cooldown or Minimum trade improvement sticks after a page reload.

## C. One action at a time

- [ ] Plan tab: set one player to **Never trade** and one pick to **Ask first**. Search trades again: neither appears on the "You give" side without a warning.
- [ ] Propose one suggested trade. BBGM shows the trade as accepted, and **Undo** in the Manager log reverses it.
- [ ] Sign a free agent from the FA tab. The player appears on your roster, and Undo works.
- [ ] Approve one playing-time suggestion. Check the player's playing time on BBGM's roster page.
- [ ] Approve the budget suggestion. Check Finances.

## D. Automatic manager

- [ ] Switch Auto Team Management to **Fully automatic**. Play one day with BBGM's own Play button. The log shows what the manager did; nothing involving your Never-trade player.
- [ ] An **Ask first** move shows up in the Manager tab as "Needs your OK" and was **not** done automatically.

## D2. Move memory and payroll plan (v2.4)

- [ ] Approve one suggested trade, then press **Re-plan** right away: no new suggestion trades away a player you just received, and none sends one back to his old team.
- [ ] If BBGM rejects a proposed trade, the same deal isn't proposed again in the next few game days.
- [ ] In a league over the luxury tax (or with a hard cap), Free-agent signings beyond minimum contracts stop before the payroll plan's limit; the signing's **Why** shows the payroll line.
- [ ] Re-signing phase: a young player (25 or under) projected to start is re-signed unless clearly overpriced; the **Why** says "young core".

## E. Phases (most important)

Use BBGM's Play menu yourself for these, with the manager in automatic mode:

- [ ] Play until the trade deadline passes: no trade attempts afterward (no errors in the log).
- [ ] Playoffs → draft lottery → draft: with Auto Drafter on "Pick automatically", your picks happen when you're on the clock.
- [ ] Re-signing phase: players worth it are re-signed, the rest are let go. A Never-trade player who won't re-sign is left for you to decide.
- [ ] Free agency → preseason: the roster ends up between the minimum and maximum size.

## F. Autopilot

- [ ] Set Autopilot to **1 season**, step = day. Start it from the Manager tab during the regular season.
- [ ] Press **Stop** partway through: it stops after the current step.
- [ ] Start it again: it continues and finishes at the next preseason, or pauses with a clear reason.
- [ ] Interrupt a sim: start Autopilot, then click BBGM's own Stop or open another page. Autopilot stops with a message rather than looping.
- [ ] Afterward, the roster is legal (BBGM lets you play a game) and the log lists every move.
- [ ] After the run, **Last Autopilot run** appears in the Manager tab with titles, playoff appearances, win %, salary per win, trades and moves; **Season by season** expands to a table.
- [ ] Press Stop while Autopilot is managing the team (not simming): it finishes the current move, then stops. No move appears twice in the log.
- [ ] With "Moves that need your OK" on **Autopilot makes them** (default), Autopilot goes from re-signing through free agency to the next preseason without any click, even with many free agents in the pool.
- [ ] Expansion (optional, in a copy): in God Mode set the league's expansion probability to 100%. After the playoffs, Autopilot votes, protects players (Never trade first) and runs the expansion draft without stopping.
- [ ] Run Autopilot for 2+ seasons with Strategy on **Auto**: if the strategy changes, the log has a "Strategy (Auto): X → Y" entry with reasons, at most once per checkpoint.

## G. What to send back if something fails

- The step letter and number (for example, "E3").
- The red Console errors (copy the text).
- The last 10 lines of the Manager tab's activity log.
- Your BBGM version (shown at the bottom of BBGM's page) and browser.
