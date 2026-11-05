# Live testing checklist (run on a copied league)

BBGM Scout has been tested against a mock of BBGM's engine. Before trusting automation in a league you care about, run this once on a copy. It takes about 20–30 minutes.

## Setup

1. In BBGM, open your league → **Tools → Export** and save the file. Then **New League → Upload league file** to make a copy. Or just start a new random league.
2. Load the extension (`chrome://extensions` → Developer mode → Load unpacked).
3. In the popup → **Features**, turn on everything, but leave **Auto Team Management on "Suggest"** for now.
4. Open **Chrome DevTools → Console** on the BBGM tab and keep it open. Note any red errors that mention BBGM Scout.

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

## C. One action at a time

- [ ] Plan tab: set one player to **Never trade** and one pick to **Ask first**. Search trades again: neither appears on the "You give" side without a warning.
- [ ] Propose one suggested trade. BBGM shows the trade as accepted, and **Undo** in the Manager log reverses it.
- [ ] Sign a free agent from the FA tab. The player appears on your roster, and Undo works.
- [ ] Approve one playing-time suggestion. Check the player's playing time on BBGM's roster page.
- [ ] Approve the budget suggestion. Check Finances.

## D. Automatic manager

- [ ] Switch Auto Team Management to **Fully automatic**. Play one day with BBGM's own Play button. The log shows what the manager did; nothing involving your Never-trade player.
- [ ] An **Ask first** move shows up in the Manager tab as "Needs your OK" and was **not** done automatically.

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

## G. What to send back if something fails

- The step letter and number (for example, "E3").
- The red Console errors (copy the text).
- The last 10 lines of the Manager tab's activity log.
- Your BBGM version (shown at the bottom of BBGM's page) and browser.
