# Courtside: complete feature reference

Courtside is a browser extension (Chrome/Edge/Brave/Arc, Firefox; Safari via Xcode conversion) for **Basketball GM** (play.basketball-gm.com), the single-player basketball franchise simulation. It adds scouting forecasts, decision support and optional automation to the game. It runs entirely in the browser. League data never leaves your device, except for the optional "Ask Claude" feature, which sends a short player summary to the Claude API using your own key.

This document describes every feature as it exists today (v2), how each one works, its settings, and its known limits.

---

## 1. Architecture (what the extension can see and do)

- **Reading data.** There are two ways:
  1. It reads the league's IndexedDB database (`league<id>`) read-only. Before reading, it asks BBGM to save its in-memory state to that database, so the numbers are current.
  2. It runs read-only snapshot scripts inside BBGM's game engine (a SharedWorker), through BBGM's official "evalOnWorker" mechanism (the same one behind BBGM's Danger Zone Worker Console). A snapshot includes:
     - Every active player: last 4 seasons of ratings, contract, BBGM's internal value, injury, draft info, playing-time setting, and mood/asking price for free agents.
     - Teams: record, payroll, budget, strategy (contending or rebuilding).
     - Draft picks, the live draft order, the trade currently on the trade screen, league settings, and league-wide team stat totals.
- **Taking actions.** A small script running in the BBGM page calls `bbgm.toWorker`, the same function BBGM's own buttons use. Only an allow-listed set of actions can be called:
  - Create, propose, clear or counter a trade; get trading-block offers.
  - Draft a player; sign or re-sign (accept a contract negotiation); cancel a negotiation; release a player.
  - Update the budget; keep the roster sorted / auto-sort; change a player's playing time.
  - Undo an action; flush the cache.
  - Play menu steps: day, week, until regular season, until end of playoff round, until draft, until your next pick, until end of draft, until re-signing, until free agency, until preseason, stop.

  Because everything goes through BBGM's own API, the game enforces its rules (salary cap, roster limits, trade deadline, player willingness to sign), and trades and signings get entries in BBGM's undo log.
- **The dock.** A panel in the bottom-right corner of every BBGM league page (it can move to bottom-left). It has one tab per enabled tool: Outlook, AI, Trades, Targets, FA, Draft, Manager, Needs, Plan, Moneyball, Realism.
  - It opens and collapses with a "▼ Close / ▲ Open" button or by clicking the header.
  - A ◐ button cycles Auto, Light and Dark mode. Auto follows BBGM's own theme.
  - Tab labels show badges: number of trade ideas, number of pending manager suggestions, and "!" when you're on the clock in the draft.
- **Popup** (click the toolbar icon): Pinned players (comparison table), Saved reports, Features (on/off switches and options for every tool), Settings, and the same theme button.
- **Sync.** Settings, pinned players and saved reports sync across devices through the browser's built-in sync storage (Chrome sync / Firefox Sync), within Chrome's 100 KB quota. The action log, your Claude API key, realism history and other bookkeeping stay on the device and are never synced.

---

## 2. The forecasting engine (behind everything)

- Courtside doesn't use a guessed age curve. It **re-implements Basketball GM's actual yearly player progression rules**:
  - The age-based base change, with the same noise distribution BBGM uses: bounded normal noise, wider for ages 23 and under.
  - Each of the 15 ratings' own age modifiers and change limits (height, strength, speed, jumping, endurance, inside, dunk, free throw, field goal, three-point, offensive IQ, defensive IQ, dribbling, passing, rebounding).
  - The coaching-budget effect.
  - BBGM's exact OVR formula, including its "fudge factor".
- It runs a **Monte Carlo simulation**: 500, 1,000 (default) or 3,000 simulated careers per player through age 36, using a seeded random number generator so a player's forecast is stable across reloads.
- Two players with the same OVR but different builds get different forecasts. For example, an athleticism-heavy player declines faster after 27 than an IQ/shooting-heavy one.
- **Scouting fog** (on by default): BBGM shows you blurred ("fuzzed") ratings for players not on your team. The forecast starts from the ratings you can actually see, and averages over the uncertainty implied by your scouting budget. It never uses the hidden true ratings.
- **Key fact used throughout:** in BBGM, each year's progression is independent of past years, and playing time doesn't affect development. The tool reflects this. Past over- or under-performance is shown as descriptive only, and minutes decisions are justified by winning and player mood, never by development.

---

## 3. Outlook tab and hover cards (player scouting)

**Outlook tab** (on any player's page):
- Header: name (as a link to their page), outlook label, age, OVR, POT, **Scout POT** and position. If the AI Assistant is on, a hidden-gem chip.
- **Scout POT (v2.4.3):** the forecast's most likely career-high OVR (median of the simulations), shown next to BBGM's POT. BBGM's POT comes from only 20 simulations, so it can be noisy. Green when Scout POT is 3+ above BBGM's, red when 3+ below. It's usually above the year-by-year predictions, because each simulated career peaks in a different season.
- **Predicted OVR (v2.4.3):** a table for each of the next four seasons with age, expected OVR (average of the simulations), the 80% range (10th–90th percentile) and the change from today. Hover cards show the next two seasons, plus Scout POT vs BBGM POT. Predictions use only ratings you can see; scouting fog widens the range.
- **Attributes with live changes (v2.7):** every rating (height, strength, speed … rebounding) plus OVR, with ▲/▼ for the change since the end of last season and a **Live** column for the change since you first opened that player in this browser session. The card refreshes on its own as games are played, whether you use BBGM's Play menu, play one day at a time, or run Autopilot (about every 6 seconds while BBGM is simulating or Autopilot is running, right away when it stops), so preseason progression shows up without reloading. It only refreshes while the Outlook tab is open and the page is visible (or the player is pinned); otherwise it catches up as soon as you look at it again (v2.7.1). Changed rows flash briefly. Fog of war is applied the same way BBGM shows other teams' ratings.
- **Inline badges refresh (v2.7):** after each phase or game day, badges for players whose OVR or POT changed are recalculated. Only badges on the current page are checked, and during Autopilot at most every 15 seconds, so long runs aren't slowed down (v2.7.1).
- Outlook labels: High upside, Rising, Near peak, At peak, Declining.
- **Peak age:** median age at which the player hits their career-high OVR, with the middle-50% range.
- **Peak OVR:** median career-high OVR, with the 10th percentile shown as "low".
- **Ceiling:** 90th-percentile career-high OVR.
- **Breakout chance:** probability of gaining 5+ OVR next season.
- **Decline risk:** probability of losing 5+ OVR next season.
- **Bust risk:** probability that the peak OVR stays below a benchmark. The benchmark is configurable: "POT minus N" (default N = 5) or a fixed OVR (default 55).
- **Development trend:** for each of the last 3 seasons, compares the actual OVR change with what BBGM's rules expected from that player's ratings and age at the time. Shows "Above expected", "As expected", "Below expected" or "Not enough history", with a per-season tooltip. Descriptive only.
- **Confidence** (0–100, High/Medium/Low), with reasons. It goes down for:
  - a wide range of outcomes
  - scouting fog
  - 0–1 seasons of history
  - real-player determinism (real-players leagues)
  - Locked ratings in God Mode give High confidence (no development).
- **Mini chart:** past OVR, the average forecast path, the peak point and the ceiling line.
- **Pin** (adds the player to the synced comparison table) and **Save report** (a snapshot plus an optional note of up to 1,500 characters, synced, newest 60 kept).

**Inline peak badges:** a small "▲62" projected-peak badge beside every player link. Options: on draft pages only (default), all league pages, or off. Uses 250 simulations for speed.

**Hover cards** (on by default): hover over any player's name anywhere in BBGM and, after about 0.3 s, a card appears. It shows:
- Name, team (or "Free agent" / "Draft prospect"), age, OVR, POT, position
- Peak age, peak OVR, ceiling
- Breakout and decline chance, bust risk, development trend, confidence
- **Value to your team** (for your current timeline)
- Contract, or the free agent's asking price and whether they'll sign with you
- Scout draft rank vs. BBGM draft rank (prospects)
- Playing-time setting (your players)
- Injury
- Hidden-gem verdict and its main reason

The card doesn't capture the mouse (it never blocks clicks), hides on scroll or when the mouse leaves, and follows the theme.

**Player links:** every player name inside the tool (dock tabs, trade cards, manager suggestions, activity log, popup pins and reports) links to that player's BBGM page. Links always open **in the same tab**, through BBGM's own router (no page reload), even with Ctrl/Cmd-click or middle-click. They're styled to stay out of the way: normal text color, a faint underline that brightens on hover.

---

## 4. League valuation model (shared by the AI, trade, FA, draft and manager tools)

Built from the live snapshot.

- **Franchise strategy (v2.4):** Rebuild, Develop, Contend or Win Now, chosen by the Strategy Brain in Auto mode (default) or by you. See §10a. Each strategy sets the value discount: Rebuild 0.9, Develop 0.8, Contend 0.65, Win Now 0.5. Rebuild maps to the old "rebuild" timeline, Develop to "balanced", and Contend and Win Now to "contend" for the parts of the tools that use the three-way timeline (minutes, which assets the trade search shops).
- **Win value per season** for a player is convex in OVR, so one 70-OVR player is worth far more than two 55s, with ~44 OVR treated as replacement level.
- **Talent** = sum over the next 8 seasons of (expected win value × discount^year), with the strategy's discount. Prospects use at least 0.85.
- **Cost** = discounted salary over the remaining contract, scaled against the max contract.
- **Surplus / value to you** = talent − cost. This is what signings, re-signings, cuts and per-asset trade values optimize.
- **Market value** = BBGM's own internal player value (fuzzed when fog applies), which is what the AI teams use.
- **Percentiles** are computed within comparable pools: all active players, or each draft class.
- **Draft pick values (v2.4, uncertainty-aware):**
  - A pick is worth the k-th best prospect, by the Scout model, in the class it will select from. Future classes are blended 50/50 with this year's class as an "average class", because they aren't fully known yet.
  - When the slot isn't known, the projected slot comes from the original team's strength, blending its record (weighted by how much of the season is played) with its roster's team rating now and in two seasons.
  - The value is the average over a normal distribution of slots around that projection. Its spread grows with years out and early in a season, and is wider for lottery-range picks, because projected standings don't guarantee a lottery position.
  - Future picks use the long-horizon draft discount (at least 0.85 per year), not the strategy's player discount, so contenders don't treat future firsts as nearly worthless.
  - During a live draft, pick values use the remaining board.
- **Team rating:** BBGM's own team-rating formula, predicted margin of victory (MOV) from the top 10 OVRs with exponentially decaying weights. 1 point of MOV ≈ 2.7 wins over an 82-game season. Trade impact is measured now (current OVRs, excluding players injured long-term) and in each of the next two seasons (forecast OVRs).
- **Performance on long runs:** forecasts are cached per player and season; entries from past seasons are dropped so 100-season Autopilot runs don't grow memory without limit.

---

## 5. AI tab (AI Assistant: hidden gems)

- **"Is this player a hidden gem?"** on any player page.
  - Verdict: Hidden gem (score ≥ 15), Undervalued (≥ 7), Fairly valued, or Overvalued (≤ −10).
  - **Gem score** = (Scout model percentile − BBGM market percentile) + half of the contract bargain/burden effect.
  - Plain-language reasons, for example:
    - The Scout percentile vs. BBGM's percentile.
    - Skill/IQ-heavy profiles that age well vs. athleticism-heavy ones that drop off after 27–28.
    - A high breakout chance.
    - Ceiling above the displayed POT (BBGM's POT comes from only 20 simulations, so it's noisy), or a POT that looks optimistic.
    - Bargain or expensive contract.
    - Scouting-fog caveat; current injury.
- **Hidden gems around the league:** the top 8 non-user players (other teams, free agents, draft prospects) by gem score weighted by talent, each with team, age, OVR/POT, peak, ceiling and reasons.
- **Ask Claude** (optional, off by default):
  - A free-form question box ("Who should I build around?", "Is this player worth a first-round pick?").
  - Sends your question plus a compact JSON summary to the Claude Messages API, with your own Anthropic API key (stored on the device only). The summary covers your team, mode, record, cap situation, the focus player and verdict, your roster, the top hidden gems and the top free agents.
  - Model picker with every current Claude model (Opus 5.5 default; Fable 5.1/5, Opus 5/4.8/4.7/4.6, Sonnet 5.5/5/4.6, Haiku 5.5/4.5).
  - Uses adaptive thinking at low effort for quick answers, plus server-side refusal fallback on the models that support it.
  - Clear error messages for a bad key, rate limits and outages. Answers follow a set format: recommendation first, then 2–4 supporting facts from the data.

---

## 6. Trades tab (Trade Helper)

- **Suggested trades:**
  - Picks up to 3 of your assets to shop, based on your mode:
    - Contend: draft picks and prospects outside the top-8 rotation, for help now.
    - Rebuild: veterans aged 27+ that the market values more than your timeline does; keeps young players.
    - Balanced: whatever BBGM values more than the Scout model does.
  - Shops each asset with BBGM's **trading-block AI**, which asks every AI team to build an offer. Every suggestion is therefore one that AI team would actually accept.
  - Offers with salary-cap or roster warnings are discarded.
  - The rest are ranked by **team-rating improvement** for your mode (now, next two seasons, or both). Each card shows team rating now and future, approximate wins, long-term value, and an "improves your team" flag.
  - Each card has **Propose** (creates the trade and proposes it through BBGM) and **Open in trade screen**.
- **Deal grader:** on BBGM's trade screen, it grades whatever deal you've built ("Improves your team", "Marginal" or "Makes your team worse"), with the team-rating impact and a per-asset value breakdown (get/give).
- **Refresh:** every game day (option) and whenever you open the trade screen (option), plus a "Search again" button.
- Trades are blocked automatically after the trade deadline and during the playoffs (BBGM's rule).
- Known side effect: searching uses BBGM's trading block, so the game's Trading Block page shows the last asset shopped.

---

## 7. Targets tab (players worth adding)

- Up to 12 players on other teams with positive value to you, ranked by surplus and boosted by gem score. Each row shows team, contract, age, OVR, projected peak and value.
- **Ask** puts the player in a trade and runs BBGM's own "What would make this deal work?". It shows the AI GM's reply and what they want, with the same team-rating and value grading, and Propose / Open in trade screen buttons.

---

## 8. FA tab (free agents)

- Banner: roster size vs. max, payroll vs. cap, cap type.
- Top 15 free agents by **value for the money**: forecast value minus the cost of their actual asking price. The asking price comes from BBGM's mood system toward your team.
- Each row shows position, gem tag, age, OVR, peak, asking amount and years, value, and a **Sign** button.
- When a player can't be signed, it says why: signing closed in this phase, refuses to sign with you, roster full, or over the cap. The cap check handles soft, hard and no-cap rules, including the minimum-contract exception.

---

## 9. Draft tab (Auto Drafter)

- **Draft board** for the current or upcoming class, ranked by the Scout model's draft value (long-horizon). Shows the Scout rank, age, OVR, peak, ceiling and **BBGM's own rank** (highlighted when the Scout model rates a prospect 5+ spots higher), plus gem tags.
- When you're on the clock: a banner with the best available player and a **Draft** button (Suggest mode), or an automatic pick (Auto mode).
- **Trade up** (option, auto mode):
  - When your top target would probably be taken before your pick (their BBGM rank is ahead of your slot), it offers your next pick to the team on the clock and asks what they want.
  - It accepts only if the target's value exceeds the cost, then drafts the target immediately. It tries once per pick.
- Every pick is logged with the Scout rank vs. BBGM rank, peak and ceiling.

---

## 10. Manager tab: Auto Team Management

**Dashboard (v2.4).** The tab opens with Strategy (Auto + the four strategies, showing Auto's current pick and its reasons), Seasons (1–100), approvals waiting, and Run/Stop. Advanced settings are collapsed underneath: manager mode, Autopilot step, stop-at checkpoint, the Autopilot switches, and (since v3.3) a read-only view of the automatic trade bar and next trade search. Expandable sections (Advanced settings, the strategy's reasons, "Why" and the run summary) stay open or closed as you left them, and the panel keeps its scroll position while you change settings (v2.4.2).

Choose a mode: **Suggest** (a list of proposed moves, each with Do it / Skip, plus "Do all") or **Fully automatic** (runs after every game day and phase change). Each area has its own switch:

1. **Finances:** budget style:
   - Win now: coaching 100, health 100, facilities 75, scouting 1
   - Balanced: 75 / 50 / 50 / 34
   - Profit: 50 / 34 / 34 / 1

   Turns on auto ticket price. Changes are made only when the current budget differs.
2. **Lineup:** turns on BBGM's "Keep auto sorted" so starters always follow the best available players.
3. **Playing time:** sets BBGM's playing-time setting per player (0 / − / normal / + / ++), with a reason for each change:
   - Injured players: 0, until healed.
   - Players ranked beyond rotation size + 2 (rotation size is configurable, default 10): 0 ("shouldn't play").
   - End of bench: −.
   - Contending: + for the top 2 players when they're clearly better than the 3rd.
   - Rebuilding: + for young (≤ 23), high-ceiling bench players, to keep them happy. Playing time affects player mood, not progression.
   - Optional tanking when rebuilding: − for veterans in the top 3.
   - A player right at a cutoff keeps his current setting while it's what he'd get one spot up or down, so minutes don't flip back and forth from day to day.
   - Since v2.4.3, injured players are left alone (BBGM already keeps them out of games), short injuries (10 games or fewer) don't reshuffle the depth chart, and a star keeps "+" until his lead over the 3rd-best player drops below 2 OVR (it takes 4 to get it). These stop the daily back-and-forth seen in a 5-season test.
4. **Re-signing** (re-signing phase): re-signs players whose value exceeds their asking price and lets the rest walk. Since v2.4.3, once the roster is full (counting this year's draft picks), marginal players (value under +8, not young core or Never trade) aren't re-signed, because they'd only be released later with their salary still owed. "Unwilling to re-sign" is also handled. Since v2.4 it also keeps players 25 and under who are projected to start within two seasons, unless they're clearly overpriced (value worse than −25% of their talent) or the strategy is Win Now. In hard-cap leagues, players who'll walk are released first (freeing their salary), then re-signings are made best value first while each still fits under the cap, using the same payroll BBGM checks (which still includes unsigned expiring contracts). Before v2.4 the manager could attempt re-signings BBGM would reject over a hard cap.
5. **Roster cuts:** when the roster is over the limit (preseason, regular season or free agency), releases the players worth least to you. Released salary is still owed in BBGM, so salary doesn't make a player more cuttable. Players 23 and under also count part of their long-run value (half for Rebuild/Develop, a quarter for Contend, none for Win Now). It doesn't cut right after the draft, because expiring contracts leave at re-signing time and usually free the spots.
6. **Free-agent signings:** fills the roster toward the target size (max − 1 in the offseason, the minimum during the season), with positive-value, cap-legal, willing free agents. Below the minimum roster it signs the best available even at break-even. Up to 3 signings per cycle. Since v2.4 each signing must also fit the **three-season payroll plan**:
   - committed contracts
   - reserves to re-sign players 25 and under projected to start when their deals run out (estimated from projected OVR)
   - rookie deals for your first-round picks (about 2.5% of the cap each)

   The plan is checked against the hard cap, or the luxury-tax line otherwise, taken from your league settings and grown by inflation. Minimum contracts always fit outside hard-cap leagues, and Win Now gets 5% of the cap of extra room.
7. **Trades: no fixed cap.** A trade is made only when its **strategy score** clears your minimum (default 0.5 MOV), BBGM's trade AI accepts it, and the strategy's own checks pass:
   - Score = w_now × rating change now + w_future × average change over the next two seasons + 0.004 × long-term value − penalties for young talent given up, draft picks given up, aging (expected OVR decline of players 30+ received), roster overflow and new payroll above the cap/tax line over three seasons.
   - Weights (now / future / youth / picks / aging): Rebuild 0.1 / 0.9 / 1 / 1 / 0.2, Develop 0.35 / 0.65 / 0.6 / 0.5 / 0.4, Contend 0.65 / 0.35 / 0.25 / 0.25 / 0.6, Win Now 0.9 / 0.1 / 0 / 0 / 1.
   - Checks: Rebuild needs the future not to get worse and value to improve; Develop allows only small short-term or value losses; Contend needs help now (at least half the minimum) without wrecking the future; Win Now needs at least the minimum now. Never over the roster maximum, and in hard-cap leagues never over the cap (counting signings planned in the same round).
   - **Move memory** (per league, on this device): a rejected deal isn't proposed again for 10 game days, and the same players (only the picks changed) aren't retried after two rejections unless the score is at least 3× the minimum. Moves that fail three times are paused for about 60 game days. The memory has a hard size limit. Never trade is never overridden. (v3.0 removed the trade cooldown on newly acquired players.)
   - **Fit (v3.0):** see section 15.

   If BBGM's AI rejects a proposed deal, the manager asks "What would make this work?" once (v2.4.3). It takes the counter-offer only if it still clears the strategy's bar, fits the roster and contract rules, and asks for no protected assets. The log shows BBGM's reason for any rejection.

   Each accepted trade must strictly improve the team, so the manager can't trade back and forth. It skips trades that would push the roster past the maximum (counting signings planned in the same round); the Trades tab warns when a suggested deal would leave you over the limit. The trade search runs every N game days (default 1) and on every phase change, because searching is slow.
- **Activity log:** the last 200 actions with timestamps, player-name links and **Undo** buttons where BBGM provides an undo entry (trades, signings). An undone entry is marked "(undone)" and loses its button. Stored on the device.
- **Explanations (v2.4):** every suggestion and log entry from the manager has a "Why" section: the reason, measurable benefits and costs (team rating now and later, value, picks, young talent, aging, payroll, roster size), the strategy it served, and "projected" (numbers are forecasts made at decision time). Strategy changes are logged with the features behind them.

## 10a. Franchise Strategy Brain (v2.4)

- **Strategies:** Rebuild (maximize team rating two or more seasons out; collect young talent and picks), Develop (grow the young core without giving up the future), Contend (this season and next), Win Now (this season's title chances, with aging risk still priced in).
- **Auto inputs** (all from information the game shows you):
  - your team rating now and projected in two seasons, as league percentiles
  - your record, which counts up to 20% once half the season is played
  - the average age of your top five
  - your own first-round picks in the next two drafts
  - young players projected to start
  - next season's cap room
- **Choosing:**
  - Strength = (0.7 − w) × percentile now + 0.3 × percentile in two seasons + w × win %.
  - Cutoffs: below 0.38 Rebuild, 0.55 Develop, 0.72 Contend; above that, Win Now if the window is closing (projected to get worse, or a core over about 29), otherwise Contend.
  - A rising young team (projected 25+ percentiles better, with two or more young starters-to-be) develops instead of rebuilding.
- **Hysteresis:** the current strategy's band is widened by 0.05 on each side, so the team has to clear it clearly before switching.
- **Checkpoints:** re-evaluated only when the checkpoint changes: start of season (preseason and first half), mid-season (second half through the playoffs, which includes the trade deadline), and offseason (lottery onward).
- The decision is stored per league in synced storage (a few hundred bytes). Choosing a strategy yourself overrides Auto. The old "Balanced" setting is read as Develop.

---

## 11. Manager tab: Autopilot

- **Seasons to play:** a dropdown in the Manager dashboard (1–100 seasons; also in the popup).
- **Fully automatic (v2.4.1, default on):**
  - "Moves that need your OK" (Advanced settings, and the popup) defaults to "Autopilot makes them". Moves involving Ask-first assets or breaking contract rules are made automatically; moves that would trade, cut or let go a Never-trade player still wait for you. Set it to "Pause for me" for the previous behavior.
  - **Re-signing:** contract demands are read for every player you're negotiating with, not just the top 80 free agents. Any player whose demands still can't be read is let go, so every negotiation is decided before free agency. Before v2.4.1, a low-value expiring player could be skipped, and BBGM's "N of your players remain unsigned" confirmation waited for a click. If that prompt still appears (for example, a Never-trade player who won't re-sign), Autopilot clicks Proceed and logs it.
  - **League events,** handled the way BBGM's own Auto Play does:
    - expansion vote (votes yes) and relocation vote (votes no)
    - expansion-draft protection: Never trade, then Ask first, then highest value for the strategy, up to the league's limit; then it starts the expansion draft
    - expansion and fantasy drafts are simmed to the end
  - No trades during fantasy or expansion drafts. If BBGM reports that you were fired, Autopilot stops and says so. Any other BBGM dialog is reported in the Manager tab.
- While it runs, Autopilot makes every manager move itself; the Manager list only shows moves that need your OK (Ask-first assets or contract-rule breaks).
- Like BBGM's built-in Auto Play, but your team keeps being run by the manager rules above (with re-signing, cuts and signings forced on so the game never stops to ask you), instead of BBGM's AI.
- Before every step it re-reads the league, runs the manager (finances, lineup, minutes, re-signings, cuts, signings, trades) and the Auto Drafter, then advances:
  - Preseason → start the regular season
  - Regular season → one day or one week (option)
  - Playoffs → end of the current round
  - Draft lottery → draft
  - Draft → until your next pick (then drafts), or until the end
  - After the draft → re-signing
  - Re-signing → free agency, after deciding on every negotiation so BBGM's "unsigned players" confirmation never blocks
  - Free agency → preseason, where player development happens
- Stops after the number of seasons you set, at an optional checkpoint (playoffs, draft or free agency), when you press Stop, or when the game doesn't advance two steps in a row (for example, when BBGM is showing a message that needs you).
- Safety:
  - Waits while BBGM is simulating or drafting, and retries briefly if BBGM's worker is busy. Since v2.4.3 there's no fixed pause after each step: BBGM's play actions return when the sim is done, so a 0.6-second wait per game day was removed. Day-by-day runs are about twice as fast.
  - **State validation (v2.4):** before each action it checks that BBGM is idle and still at the game state the plan was made for. If not, the rest of that plan is dropped and re-planned. "Do it" / "Do all" in Suggest mode do the same check.
  - **Idempotent actions (v2.4):** each action has a signature, and the same action at the same game state is never repeated (re-renders, retries, double clicks).
  - **Stop** takes effect between actions, never in the middle of one, so no workflow is left half-done.
  - Limits repeated manager rounds per game day to 3. A loop guard stops Autopilot if the game state doesn't change across 8 manager rounds. It also stops when the game doesn't advance two steps in a row.
  - Actions that keep failing are paused (see move memory). Multi-team and spectator leagues are refused.
  - Logs why it stopped.
- **Run summary (v2.4):** when a run ends, the Manager tab shows an expandable summary:
  - championships, playoff appearances and regular-season win %
  - salary spent per win, with the league average for context
  - trades (with their projected impact at the time, summed), signings, re-signings, players let go and released, failed moves
  - draft picks, strategy changes and roster turnover
  - a season-by-season table (record, playoff result, strategy)

  Results come from BBGM's own season records. It deliberately makes no claim that Autopilot caused them, because there's no baseline run to compare against. The last summary is kept on this device per league.

---

## 12. Realism tab (God Mode / league settings advisor)

- **Records league-wide numbers each season** on the device, up to 60 seasons: 70+ and 60+ OVR players per team, top OVR, parity (spread of team MOV), win% spread and best record, median payroll ÷ cap, share of teams over the luxury tax, share of max contracts, share of players out 20+ games, average age of the top 50, points per game, three-point attempt rate.
- **Suggests specific setting changes, with current → suggested values,** using the exact names from BBGM's Settings page:
  - **Talent concentrating / dynasties** (parity > 8.5 or a 78%+ team in 2 of 3 seasons): Salary Cap Type → hard, higher Luxury Tax, lower Trade Salary Match, lower AI-to-AI Trades Factor.
  - **Every team the same:** the opposite adjustments.
  - **Payrolls outgrew the cap:** raise Salary Cap and Luxury Tax Threshold by about 10%. **Lots of unused cap space:** lower the cap, raise Min Contract.
  - **Too many max contracts** (> 10%): raise Max Contract.
  - **The cap never changes** (4+ seasons, no inflation): Inflation Average 3%, Standard Deviation 2%.
  - **Ratings inflating or stars disappearing** compared with the first recorded season: draft-class guidance.
  - **Too many long-term injuries:** lower Injury Rate by 25%.
  - **Style vs. the modern NBA:** three-point attempt rate outside 33–47% (target ~40%) → new Three Point Tendency Factor; points per game outside 104–124 (target ~114) → new Pace.
- Severity tags (high, medium, low), a "League over the years" table, and a button that opens BBGM's League Settings. Early in a season, it judges from the last completed season.
- **Apply suggestions (v2.5):** each suggestion with exact values has an **Apply** button, and there's **Apply all suggestions** at the top. Advice-only items (for example, "import draft classes") are marked and never applied.
  - A confirmation lists every change (current → new) before anything happens.
  - Changes go through BBGM's own `updateGameAttributes`, the same function as the League Settings page. Only these settings can be changed, each within sane bounds: salary cap type, luxury tax, trade salary match, AI-to-AI trades factor, salary cap, luxury tax threshold, min/max contract, inflation average/std, injury rate, three-point tendency factor, pace.
  - Most of these settings are locked unless God Mode is on. If it's off, the confirmation says so and applying turns it on, which disables achievements for that league in BBGM.
  - **Undo last change** restores the previous values; God Mode stays on. Each apply and undo is logged.
  - Nothing changes unless you press a button, or turn on automation (below).
- **Automation (v3.1, `realismAuto`, off by default):** "Apply automatically once a season" runs `autoRealism` in `content.js`:
  - once per season per league (stored locally), from the draft lottery on, so a full season backs it
  - from any tab when you play yourself (after each league-model build), and inside the Autopilot loop before the manager plans, after which the model is rebuilt so every move is planned under the new settings
  - it applies `settingsToApply(advise(...))` except `salaryCapType` (structural, manual only), skips values that are already set, and turns God Mode on with the first change
  - each change is logged with its reasons, and **Undo last change** in the Realism tab restores the previous values

---

## 12b. Needs tab (team needs scanner)

- Profiles every team's top 10 players, weighted the way BBGM's team rating weights them, in 9 areas. Each area is a weighted average of the relevant BBGM ratings:
  - Outside shooting (3PT/FG/FT, skill tag "3")
  - Inside scoring (inside/dunk/height, "Po")
  - Ball handling & passing (dribbling/passing/OIQ, "B/Ps")
  - Perimeter defense (DIQ/speed/jumping, "Dp")
  - Rim protection (height/DIQ/jumping, "Di")
  - Rebounding (rebounding/height/strength, "R")
  - Athleticism (speed/jumping/endurance, "A")
  - Bench depth (OVR of players 6–10)
  - Star power (best player's OVR)
- Shows your rank in each area and your **three biggest weaknesses** (below league average by a meaningful margin).
- For each weakness, the best **trade target** (with an Ask button that runs BBGM's "What would make this work?"), **free agent** (with a Sign button, respecting cap, roster and contract rules) and **draft prospect** (judged on projected OVR in 2 years). Each fix shows "+N" for how much it would raise that area, and a different player is chosen for each weakness.
- Uses scouted (fuzzed) ratings for other teams' players when scouting fog is on.

## 12c. Plan tab (three-season view and protections)

- A table for this season (or next, in the offseason) plus the two after it: projected **team rating (MOV)** and **league rank** (every team's current roster projected with the forecasts), **committed payroll**, **cap space** (with inflation if set), **contracts expiring** after each season, and **your draft picks**.
- **Warnings**:
  - Your top three are projected to lose 3+ OVR by year three, while your best young player won't reach starter level. The window closes before the prospects are ready.
  - Top-4 now but falling 4+ places.
  - Rising 4+ places.
  - Next season's payroll already over the cap.
  - 3+ rotation players expiring.
  - No first-round picks in the next two drafts.
  - Much of next season's strength comes from players without contracts.

  A young player projected to match your current best player is flagged as good news.
- **Roster outlook:** each player's projected OVR for all three seasons, contract end, and a protection selector.
- **Picks:** each pick's Scout value and a protection selector.

## 12d. Protected assets and contract rules (respected by every automated feature)

- Per-league, synced protection levels for players and picks: **Never trade**, **Ask first**, Available.
- **Never trade:**
  - The Trade Helper never shops the asset, and discards AI offers that include it.
  - Targets offers that include it can't be proposed.
  - The Auto Drafter won't trade that pick.
  - The manager never cuts the player.
  - In re-signing, a Never-trade player who is willing is re-signed even if they look overpaid. One who refuses is left for you to decide, and nobody is let walk automatically.
- **Ask first:** any automated move involving the asset is shown as "Needs your OK" and waits, even in fully automatic mode. Autopilot skips those moves, and pauses with an explanation if re-signing can't finish without your decision.
- **Contract rules** (Features → Auto Team Management):
  - **Longest contract** (years; 0 = no limit): free agents asking for longer deals are marked "Breaks your rules", and longer re-signings need approval.
  - **Minimum cap space to keep free** ($ millions): signings and salary-adding trades that would cut into it are skipped or flagged. A minimum contract is still allowed when the roster is below the minimum size.

## 12e. Draft tiers and trade-down (Draft tab)

- **Tiers:** a prospect stays in the current tier if their ceiling (90th-percentile peak) reaches the tier leader's median peak and their value is within 20% of the leader; otherwise a new tier starts. Within a tier, the differences are mostly noise. The board shows each prospect's tier, and a banner reports how many similar prospects are left in tier 1.
- **Trade-down advice** (you're on the clock and tier 1 has 3+ players): offers your pick to teams picking within the tier's depth and runs BBGM's "What would make this work?", so the AI adds assets to balance. A deal is suggested only if a tier-1 prospect is still expected at the new slot and you gain value: expected prospect + extras received − extras given − best prospect now. "Check trade-down offers" button; optional automatic trade-down in auto mode. Respects protected picks.

## 12f. Risk preference

- Settings: Auto (Conservative when contending, Upside when rebuilding, Balanced otherwise), Conservative, Balanced, Upside. Separate from the team timeline.
- The engine records each season's 10th and 90th percentile OVR. Risk-adjusted value per season = 0.6 × expected value + 0.4 × the floor (Conservative) or ceiling (Upside) value; Balanced uses the expected value. This feeds the valuations used by trades, free agents, targets, the draft board and the manager. The hidden-gem comparison stays risk-neutral.

## 12g. Injury stress test (Needs tab)

- Scenarios: your best player, second-best player, top rim protector and top ball handler missing time.
- For each: the drop in team rating (MOV), roughly how many wins a 20-game absence costs, and the skill area that falls furthest in league rank.
- Affordable backups that recover the most: free agents you can sign now (asking up to max(3 × minimum contract, 5% of the cap)) and low-salary trade targets (≤ 8% of the cap).

## 12h. Moneyball tab (value per dollar)

- **Payroll efficiency:** every team's projected wins (from today's team rating) and payroll per projected win, ranked; your rank in the banner.
- **Moneyball swaps:** for your worst value-per-dollar players (not protected), the best same-or-cheaper replacement (free agent or trade target) that adds at least +0.3 team rating, with the savings. Sign or "Ask about a swap" (builds the trade and runs BBGM's "What would make this work?").
- **Best value per dollar available:** free agents you can sign and tradeable players, ranked by team rating added to your team per $1M of salary (asking price for free agents), with 2-year growth flagged.
- **Market inefficiencies:** compares the Scout model's percentile with BBGM's market percentile for groups of players: the top 20% in each skill area, age bands, athleticism-heavy vs skill/IQ-heavy builds. Shows which groups the market undervalues (cheap to acquire) and overvalues.
- **Age arbitrage:** buy ages 21–25 projected to gain 3+ OVR in two years that the market undervalues; sell your 28+ players projected to lose 2+ OVR that the market still overvalues.
- **Your roster by value per dollar:** team rating each player adds, salary per point of team rating, Overpaid/Bargain tags.

## 12i. League identity for synced data

- Each league gets a fingerprint (starting season plus the first players' IDs, names and birth years), the same on every device and after export/import. Pins, reports and protections are stored under it. Each device keeps a local map from fingerprint to its own league number for links.
- A device reuses the fingerprint it already knows for a league, so the identity stays stable even after deleting old data.
- Data saved before this change moves to the fingerprint the first time that league is opened.

## 13. Popup and settings

- **Master switch (v3.2, `enabled`, default on):** a switch in the popup's header.
  - When off, `content.js` removes the dock (`render` → `removeHost`), clears badges, hides hover cards and the command bar, stops Autopilot, and skips the background loop (`tick`), routing, badges, hover and Alt+K.
  - It reacts to the storage change, so no page reload is needed either way. Turning it on resets the route, so the current page is picked up again.
  - The toolbar icon shows an "OFF" badge: the popup sets it, and `background.js` restores it at browser startup.
  - Checked on the live BBGM site: dock, 22 badges and a running Autopilot all stopped; back on, the dock returned with all tabs.
- **One live copy per page (v3.2.1).** After an extension update or reload, Chrome keeps the old content script running in open tabs, cut off from the extension. Each copy of `content.js` therefore:
  - announces itself with a `takeover` window message; an older copy that hears it shuts down (clears its timers, observer and listeners, removes its dock, stops Autopilot, ignores storage changes)
  - checks every 2 s that `chrome.runtime.id` still exists, and shuts itself down if it doesn't
  
  Copies from before 3.2.1 lack this, so a tab still running one needs a single refresh after updating.

- **Works with any league:** the extension attaches to whichever BBGM league is open, reads its live state every few seconds, and keeps protections, Realism history and trade timing separate per league.
- **Pinned:** a comparison table (age, OVR, peak, ceiling, peak age, breakout, bust) with the best value in each column highlighted. Pins refresh when you open that player's page.
- **Reports:** saved snapshots with notes, synced, deletable.
- **Features:** an on/off switch and options for every tool:
  - Hover cards, AI Assistant (+ Ask Claude, model, API key), Trade Helper (game-day and trade-screen refresh), Targets, Free Agents
  - Auto Drafter (suggest/auto, trade up)
  - Auto Team Management (mode, each area, budget style, rotation size, tanking, minimum trade improvement, search frequency)
  - Autopilot (step size, seasons, checkpoint)
  - Realism advisor
  - Franchise strategy (Auto, Rebuild, Develop, Contend, Win Now) (also in the Manager dashboard)
  - v3.0: auto-pick a new team when fired, auto-read owner messages, go over the cap when needed, Office and Insights tabs, command bar
- **Settings:** simulations per player, respect scouting fog, bust benchmark, inline badges, theme, panel position, model version.
- **Defaults:** scouting tools on; Auto Drafter, Auto Team Management and Autopilot off.

---

## 13b. Share to Reddit (v2.6)

- **Share to Reddit** buttons on a player's Outlook and on the Autopilot run summary. Each opens Reddit's post form (old.reddit.com) in a new tab, pre-filled with a title and a formatted post (prediction table, Scout POT, risks; or the season-by-season Autopilot table) plus a one-line footer linking to Courtside.
- The subreddit defaults to r/BasketballGM and can be changed in the popup → Settings.
- Nothing is posted automatically: you review the post on Reddit and press Post yourself. No Reddit login, password or token is handled by the extension.

## 13a. Look and name (v2.5)

- Renamed from BBGM Scout to **Courtside**. Internal names, storage keys, the repo and download links are unchanged, so settings, pins, reports and protections carry over.
- A "courtside" theme:
  - hardwood tones in light mode, arena navy in dark mode, with a basketball-orange accent
  - an orange header with a basketball icon
  - scoreboard-style stat tiles and pill buttons
- Tabs are a single sliding row of icon pills; the active tab is kept in view. Since v2.5.1 there are several ways to scroll the row:
  - ‹ › arrow buttons at the edges, shown only where more tabs are hidden
  - the mouse wheel or trackpad, scrolling sideways
  - click and drag (a drag doesn't open a tab)
  - ← → keys between tabs
  - swiping on touch screens
  Edge fades appear only on sides with hidden tabs.
- The forecast chart is a fan chart with the 80% range, and the predicted OVR table has range ribbons.
- Hover cards and the popup use the same palette.

## 14. Testing and known limits

- Unit tests cover the progression engine, OVR formula, coaching and fog effects, trend, confidence, team rating and performance (1,000 simulations of a 19-year-old in well under 250 ms). Since v2.4 they also cover the Strategy Brain (clear cases, rising teams, hysteresis, checkpoints, manual override, legacy setting), trade scoring and checks, pick-value uncertainty, move memory (rejected and nearly identical deals, big-opportunity exception, failure counts, pruning, size cap), the game clock and the run summary. Since v3.0 also difficulty profiles, the title-shot and job-risk rules, and fit in the trade score.
- **v3.0 was tested on the live BBGM site** (play.basketball-gm.com v2026.10.30, a random-players league on Hard) by loading the scripts into the page with a stand-in for the extension storage API, over about five Autopilot seasons with no script errors. Checked there:
  - BBGM's real New Team list after a firing, `switchTeam`, the owner-mood formula and the difficulty values
  - auto-read of the owner's evaluation message
  - every Office and Insights section, and the health check (all actions present)
  - prediction accuracy (463 players graded)
  - the live Autopilot section, the action queue, the timeline and the command bar
  - dragging the dock while Autopilot runs
  - re-signing decisions and offseason trade scores
  
  It wasn't installed as a real extension, and Firefox wasn't tested.
- **Backtest harness (v2.4):** `node tests/backtest/run.js` runs the Manager/Autopilot loop of v2.3.0 and the working tree side by side on a seeded mock league.
  - Scenarios: default, rebuilding, contender, expensive aging roster, injury-heavy, and custom rules (hard cap, 13/10 roster limits, 40 games, different contract limits). Both versions start from identical states, over several seeds, plus an optional long run.
  - It records win %, titles, playoff appearances, roster value, payroll, failed actions, rule violations, stalls, early stops and runtime.
  - The mock is a simplification: AI teams don't trade with each other, games use the team-rating formula, AI trade logic is approximate. Compare versions with each other only. Results: `tests/backtest/results.md`.
  - Latest run (3 seeds × 3 seasons per scenario, plus one 15-season run): v2.4.0 had no failed actions; v2.3.0 had re-signings rejected over the hard cap in the custom-rules league. Neither version had rule violations or stalls. Differences in win %, titles and roster value were within seed-to-seed noise in the short runs. The single 15-season run favored v2.4.0, but one seed isn't evidence of an improvement.
- End-to-end browser tests ran against a mock of BBGM's engine API, written from BBGM's source code: a full simulated season with trades, signings, draft picks, minutes changes, cuts, re-signings and free agency, plus the popup switches, open/close, theme, hover cards and same-tab links. Versions 2.3.0 and 2.4.0 were also checked on the live BBGM site (play.basketball-gm.com, a new random-players league) by loading the scripts into the page with a stand-in for the extension storage API: every tab loaded, signings, a proposed trade and Undo worked, and Autopilot played a full season (playoffs, draft, re-signing, free agency) to the next preseason. For 2.4.0: the new dashboard, Auto strategy, explanations, a rejected-trade memory entry and a one-season Autopilot run with its summary, with no script errors. It wasn't installed as a real extension there, Firefox wasn't tested, and the AI tab's Claude questions weren't tried. Use a copy of a league and Suggest mode first.
- BBGM's internal API isn't a public contract. A BBGM update could rename something, in which case the affected tool shows an error and the others keep working.
- Basketball GM only; the other ZenGM sports use different rating systems.
- The coaching effect uses the current budget level; BBGM uses a 3-season average.
- Trade searches take a few seconds per asset, because every AI team builds an offer.

## 13c. Updates (v3.5)

- **Chrome Web Store:** `.github/workflows/publish-chrome-web-store.yml` runs on every published GitHub release (or by hand, with an upload-only option).
  - Steps: zip `manifest.json`, `src`, `popup`, `icons` and `LICENSE` with the manifest at the root, check the manifest version against the tag, get an OAuth access token from the refresh token, upload, then publish.
  - Upload: `POST https://chromewebstore.googleapis.com/upload/v2/publishers/{publisherId}/items/{itemId}:upload`. While `uploadState` is `IN_PROGRESS`, it polls `:fetchStatus` (`lastAsyncUploadState`) and needs `SUCCEEDED`.
  - Publish: `POST …/v2/publishers/{publisherId}/items/{itemId}:publish` with `publishType: DEFAULT_PUBLISH`, which goes live after review.
  - Secrets: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_PUBLISHER_ID`. Without them the job skips with a notice.
- **Unpacked installs:**
  - `background.js` checks every 10 minutes (`alarms`) and at startup whether the on-disk `manifest.json` is a newer version than the running one, and if so calls `runtime.reload()`. This only happens when `management.getSelf().installType === "development"`.
  - `scripts/auto-update.ps1` (installed as a 30-minute scheduled task by `scripts/install-auto-update.ps1`) fast-forwards a `git clone` to `origin/main`, skipping on local changes or a diverged history. It logs to `%LOCALAPPDATA%\Courtside\auto-update.log`.
  - An open tab's old content script that loses its extension shows "Courtside was updated" with a Refresh button.

## 14a. v3.4: Moneyball manager style

- **Setting:** `managerStyle` (`standard` | `moneyball`), on the Manager dashboard and in the popup. Changing it rebuilds the league model.
- **Market rate:** `league.js` sets `L.moneyRate` with each build.
  - `perWin` = (average payroll − minRosterSize × minContract) ÷ (0.3 × games): marginal $ per win above a replacement-level team
  - `perPoint` = perWin × 0.033 × games: $ per point of team rating (MOV)
- **Trades:** `tradeImpact` adds `money` = −(average payroll change over the next three seasons) ÷ perPoint to the trade score (`strategy.tradeScore`), and `isNecessary` refuses a Moneyball deal with now < −0.3 unless rebuilding. Shopping adds edge for overpaid (surplus ≤ −5) and expensive-per-OVR contracts. Explanations show the dollars and their rating value.
- **Signings:** sorted by (rating added + 0.5 × fit) per $M. A signing is skipped when the ask exceeds 1.15 × rating added × perPoint (minimum contracts and reaching the roster minimum excepted).
- **Re-signing:** a player walks when the ask exceeds 1.1 × the market rate for his next-season rating contribution, unless he's young core or Never trade.
- Standard style is unchanged (`money` is 0).
- Checked on the live BBGM site: $15.5M per point ($5.7M per win) in a new random league; a Moneyball trade logged "saves $2.0M a season … worth +0.13". There's a unit test for the market rate and the money term in both directions.

## 14b. v3.1: free agency checker, header

- **Free agency checker** (`features.js` `freeAgencyCheck`):
  - roster vs `minRosterSize` / `maxRosterSize`, the target (max − 1 in free agency and the preseason, the minimum otherwise), open spots
  - cap space, or "minimum deals only" when under 2× the minimum contract of room is left
  - free-agency days left (BBGM `daysLeft`), and the top five free agents by value + 20 × fit
  - issues (below the minimum, over the maximum, open spots with nobody signable)
  - `keepShopping` during free agency while there are days left, open spots and a free agent worth signing
  
  `nextPlayAction(poll, settings, fa)` then plays a day (or a week) instead of `untilPreseason`. BBGM's `playMenu.day` advances free-agency days (checked on the live site: 30 → 29). The Manager tab shows it as a card during re-signing, free agency and the preseason, or whenever there's an issue.
- **Header:** the theme button is icon-only, the sync label hides when space is tight (always while Autopilot runs), and Open / Close never shrinks. In compact mode the dock is 280px and Close is just ▼. Checked on the live site: normal, collapsed, Autopilot running, compact, and compact with Autopilot running.

## 15. v3.0: win engine, Office, Insights

- **Win engine** (`src/insights.js` `winContext` / `fitGain`, used by `league.js` `tradeImpact` and the manager's free-agent ranking). It's recomputed with every league-model build:
  - your rotation's areas (CATS in `planning.js`) as z-scores against every team; areas below −0.3 count as weak, weighted by how far below
  - a trade or signing adds 0.04 × change × weight for each weak area, plus the change in the best five's BBGM synergy (offense + defense + rebounding, BBGM's game-sim formula)
  - when contending within 3 rating points of the top three, it also adds 0.08 per OVR point on the best player
  
  The total is capped at ±0.6 team-rating points and enters `tradeScore` weighted 0.4 + 0.6 × the strategy's "now" weight.
- **Team rating in trade decisions** pads empty roster spots with a replacement-level 42 OVR (`REPLACEMENT_OVR`), not 0. BBGM's own formula (`teamMov` with no pad) is unchanged everywhere else.
- **Strategy:** `titleGap` (rating points behind the best team) is required for Win Now (≤ 2.5 to enter, ≤ 3.5 to stay), and `jobRisk` rules out Rebuild. Franchise objectives are applied after `resolve` in `league.js`.
- **Re-signing:**
  - contract length by age and trajectory (5 / 3 / 2 / 1 years), capped by league and user limits
  - lets walk bench filler (outside next season's rotation), replaceable players (a free agent at least as good for under 80% of the ask), deals that break the payroll plan (unless "over the cap when needed" applies) and deals that break the luxury-tax objective
- **Office:** job security uses BBGM's `updateOwnerMood`: wins 0.25 × (W − G/2)/(G/2), playoffs −0.2 to +0.2, money (profit − $15M)/$100M scaled by cap/$90M, each capped at +1. Fired below −1 after `gracePeriodEnd`.
- **Insights:**
  - lineup synergy: best five out of the top 9, fit = OVR + 8 × synergy
  - playoff scout: per-game win chance from the rating gap
  - draft class: top-5 and lottery value vs stored past classes
  - rivals: BBGM team strategy, age, picks, payroll and trade events
  - legacy: `getCopies.players` with `activeAndRetired`
  - accuracy: forecasts stored each regular season and graded against next season's visible OVR, so fog is never leaked
  - benchmark and health check (`bbgm.api` function presence for every allow-listed action)
- **Allow-list:** `main.switchTeam` (auto-pick a new team when fired).
