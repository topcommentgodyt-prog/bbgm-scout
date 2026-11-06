/*
 * Courtside – page-world bridge.
 *
 * Runs in the BBGM page itself so it can reach the game's own `bbgm.toWorker`
 * function (the same one BBGM's UI uses to talk to its game engine). The
 * extension asks for actions via window.postMessage; only the actions listed
 * below are forwarded. Everything goes through BBGM's normal API, so trades,
 * signings and picks follow the game's rules and show up in its undo log.
 */
(function () {
  "use strict";
  const ALLOWED = new Set([
    "main.evalOnWorker", // read-only snapshot scripts written by the extension
    "main.idbCacheFlush",
    "main.getTradingBlockOffers",
    "main.createTrade",
    "main.clearTrade",
    "main.tradeCounterOffer",
    "main.proposeTrade",
    "main.draftUser",
    "main.acceptContractNegotiation",
    "main.releasePlayer",
    "main.updateBudget",
    "main.autoSortRoster",
    "main.updateKeepRosterSorted",
    "main.updatePlayingTime",
    "main.cancelContractNegotiation",
    "undoLog.undo",
    // Expansion / relocation votes and the expansion draft, used only by Autopilot
    "main.expandVote",
    "main.relocateVote",
    "main.updateProtectedPlayers",
    "main.startExpansionDraft",
    // Taking over a new team after being fired, used only by Autopilot when "Auto-pick a new team" is on
    "main.switchTeam",
    // League settings, only when you press "Apply suggestions" in the Realism tab (keys are checked there)
    "main.updateGameAttributes",
    // Play menu, used only by Autopilot when you turn it on
    "playMenu.stop",
    "playMenu.day",
    "playMenu.week",
    "playMenu.untilRegularSeason",
    "playMenu.untilPlayoffs",
    "playMenu.untilEndOfRound",
    "playMenu.untilEndOfPlayIn",
    "playMenu.throughPlayoffs",
    "playMenu.untilDraft",
    "playMenu.onePick",
    "playMenu.untilYourNextPick",
    "playMenu.untilEnd",
    "playMenu.untilResignPlayers",
    "playMenu.untilFreeAgency",
    "playMenu.untilPreseason",
  ]);

  window.addEventListener("message", async (e) => {
    if (e.source !== window || !e.data || e.data.__bbgmScout !== "req") return;
    const { id, cat, name, param } = e.data;
    const reply = (msg) => window.postMessage({ __bbgmScout: "res", id, ...msg }, location.origin);
    try {
      if (!ALLOWED.has(`${cat}.${name}`)) throw new Error(`Action not allowed: ${cat}.${name}`);
      const tw = window.bbgm && window.bbgm.toWorker;
      if (typeof tw !== "function") throw new Error("BBGM is still loading");
      const result = await tw(cat, name, param);
      reply({ ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  });
  window.postMessage({ __bbgmScout: "ready" }, location.origin);
})();
