# Backtest results: v2.3.0 vs v2.4.0 (mock league)

Command: `node tests/backtest/run.js --seasons 3 --seeds 3 --long 15 --out tests/backtest/results.json`

Both versions ran the same Manager/Autopilot loop (fully automatic, Strategy on Auto, one-week steps, trade search every 7 game days). Each scenario used the same three seeded starting leagues, and the long run used one. Values are mean ± sample standard deviation across seeds.

**The mock is not Basketball GM.** It's a 20-team league with simplified games, progression, AI trading (AI teams don't trade with each other), contracts and a two-round draft. Use these numbers to compare the two versions with each other, not to predict results in a real league.

| Scenario | Version | Win % | Titles | Playoff apps | Roster value (end) | Avg payroll ($k) | Failed actions | Rule violations | Stalls | Early stops | Runtime (s) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| default (3 seeds × 3 seasons) | v2.3.0 (4c20e5d) | 0.549 ± 0.199 | 0.00 ± 0.00 | 1.33 ± 1.53 | 579 ± 8 | 144567 ± 33957 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 17.3 ± 0.1 |
| default (3 seeds × 3 seasons) | candidate (working tree) | 0.528 ± 0.174 | 0.00 ± 0.00 | 1.33 ± 1.53 | 591 ± 35 | 145901 ± 33141 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 17.3 ± 0.3 |
| rebuilding (3 seeds × 3 seasons) | v2.3.0 (4c20e5d) | 0.270 ± 0.176 | 0.00 ± 0.00 | 0.33 ± 0.58 | 622 ± 5 | 101172 ± 37869 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 17.3 ± 0.2 |
| rebuilding (3 seeds × 3 seasons) | candidate (working tree) | 0.268 ± 0.167 | 0.00 ± 0.00 | 0.67 ± 1.15 | 619 ± 7 | 95794 ± 33546 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 17.1 ± 0.2 |
| contender (3 seeds × 3 seasons) | v2.3.0 (4c20e5d) | 0.954 ± 0.029 | 3.00 ± 0.00 | 3.00 ± 0.00 | 637 ± 15 | 348933 ± 52372 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 17.2 ± 0.1 |
| contender (3 seeds × 3 seasons) | candidate (working tree) | 0.951 ± 0.025 | 3.00 ± 0.00 | 3.00 ± 0.00 | 662 ± 42 | 345967 ± 53341 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 17.0 ± 0.2 |
| aging (3 seeds × 3 seasons) | v2.3.0 (4c20e5d) | 0.806 ± 0.075 | 1.67 ± 0.58 | 2.67 ± 0.58 | 531 ± 16 | 331028 ± 58171 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 17.2 ± 0.1 |
| aging (3 seeds × 3 seasons) | candidate (working tree) | 0.757 ± 0.131 | 1.67 ± 0.58 | 2.67 ± 0.58 | 552 ± 28 | 314187 ± 58712 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 17.1 ± 0.1 |
| injuries (3 seeds × 3 seasons) | v2.3.0 (4c20e5d) | 0.545 ± 0.099 | 0.33 ± 0.58 | 2.00 ± 1.00 | 591 ± 25 | 149213 ± 32123 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 17.6 ± 0.2 |
| injuries (3 seeds × 3 seasons) | candidate (working tree) | 0.524 ± 0.065 | 0.00 ± 0.00 | 2.00 ± 1.00 | 578 ± 8 | 145108 ± 25612 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 17.4 ± 0.2 |
| custom (3 seeds × 3 seasons) | v2.3.0 (4c20e5d) | 0.431 ± 0.068 | 0.00 ± 0.00 | 0.67 ± 0.58 | 560 ± 20 | 110921 ± 16610 | 3.3 ± 3.1 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 16.7 ± 0.1 |
| custom (3 seeds × 3 seasons) | candidate (working tree) | 0.442 ± 0.044 | 0.00 ± 0.00 | 0.67 ± 0.58 | 554 ± 25 | 113168 ± 16509 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 16.8 ± 0.2 |
| long (15 seasons, 1 seed) | v2.3.0 (4c20e5d) | 0.507 ± 0.000 | 0.00 ± 0.00 | 7.00 ± 0.00 | 570 ± 0 | 149746 ± 0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 114.0 ± 0.0 |
| long (15 seasons, 1 seed) | candidate (working tree) | 0.679 ± 0.000 | 6.00 ± 0.00 | 12.00 ± 0.00 | 578 ± 0 | 184527 ± 0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 | 111.9 ± 0.0 |

## Reading the results

- **Failed actions:** v2.3.0 had 3.3 ± 3.1 failed actions per run in the custom hard-cap league, all of them re-signings rejected as "Over the hard cap". v2.4.0 had none in any scenario. This is the one difference the tests clearly pin down: it comes from a specific, deterministic rule fix, and `tests/manager.test.js` checks it directly.
- **Rule violations, stalls, early stops:** none for either version.
- **Runtime:** about the same for both versions.
- **Win %, titles, playoff appearances, roster value, payroll:** in the 3-season scenarios, the two versions' averages are within about one standard deviation of each other. With 3 seeds that's not enough evidence to say either version is better.
- **15-season run:** v2.4.0 finished with a higher win % (0.679 vs 0.507), more titles (6 vs 0) and more playoff appearances (12 vs 7), with higher average payroll. That's a single seed, so it's an anecdote, not a measured improvement. More seeds of long runs would be needed before claiming one.
