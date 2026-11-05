/*
 * Courtside – read-only access to the league's local IndexedDB.
 *
 * BBGM stores each league in an IndexedDB database named `league<lid>` on
 * this device. We open it read-only, read only the records we need (one
 * player, a handful of game attributes, teams), and close it right away.
 * Nothing here is ever uploaded.
 */
(function (root) {
  "use strict";

  const PLAYER = { FREE_AGENT: -1, UNDRAFTED: -2, RETIRED: -3, UNDRAFTED_2: -4, UNDRAFTED_3: -5 };

  function openLeague(lid) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(`league${lid}`);
      // If the DB doesn't exist, opening would create an empty one. Abort instead.
      req.onupgradeneeded = () => {
        req.transaction.abort();
      };
      req.onerror = () => reject(new Error(`League ${lid} not found on this device`));
      req.onblocked = () => reject(new Error("League database is busy"));
      req.onsuccess = () => {
        const db = req.result;
        // Never block BBGM's own schema upgrades.
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }

  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  // Some game attributes are stored "with history": [{start, value}, ...]
  function unwrapGA(v) {
    if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "start" in v[0]) return v[v.length - 1].value;
    return v;
  }

  // Budget items were numbers (levels) in newer leagues, {amount, rank} objects in old ones.
  function budgetLevel(team, item) {
    const b = team && team.budget && team.budget[item];
    if (typeof b === "number") return b;
    if (b && typeof b.level === "number") return b.level;
    return undefined;
  }

  /**
   * Load what the scouting panel needs for a set of player ids.
   * Returns { season, userTid, godMode, multiTeam, realPlayerDeterminism, teams, players: Map<pid, player> }.
   */
  async function load(lid, pids) {
    const db = await openLeague(lid);
    try {
      const stores = ["players", "gameAttributes", "teams"].filter((s) => db.objectStoreNames.contains(s));
      const tx = db.transaction(stores, "readonly");
      const ga = tx.objectStore("gameAttributes");
      const keys = ["season", "phase", "userTid", "userTids", "godMode", "realPlayerDeterminism"];
      const gaVals = await Promise.all(keys.map((k) => reqP(ga.get(k)).then((r) => (r ? unwrapGA(r.value) : undefined))));
      const attrs = Object.fromEntries(keys.map((k, i) => [k, gaVals[i]]));
      const teams = stores.includes("teams") ? await reqP(tx.objectStore("teams").getAll()) : [];
      const ps = tx.objectStore("players");
      const list = await Promise.all(pids.map((pid) => reqP(ps.get(pid))));
      const players = new Map();
      list.forEach((p) => p && players.set(p.pid, p));
      return {
        season: attrs.season,
        phase: attrs.phase,
        userTid: attrs.userTid,
        godMode: !!attrs.godMode,
        multiTeam: Array.isArray(attrs.userTids) && attrs.userTids.length > 1,
        realPlayerDeterminism: Number(attrs.realPlayerDeterminism) || 0,
        teams: new Map(teams.map((t) => [t.tid, t])),
        players,
      };
    } finally {
      db.close();
    }
  }

  /**
   * A stable identity for a league that is the same on every device (and survives export/import),
   * unlike BBGM's local league number. Built from the league's starting season and its first
   * players' names and birth years, which never change.
   */
  async function fingerprint(lid) {
    const db = await openLeague(lid);
    try {
      const tx = db.transaction(["players", "gameAttributes"], "readonly");
      const ss = await reqP(tx.objectStore("gameAttributes").get("startingSeason"));
      const first = await new Promise((res, rej) => {
        const out = [];
        const c = tx.objectStore("players").openCursor();
        c.onsuccess = () => { const cur = c.result; if (!cur || out.length >= 5) return res(out); out.push(cur.value); cur.continue(); };
        c.onerror = () => rej(c.error);
      });
      if (!first.length) return null;
      const raw = [ss ? unwrapGA(ss.value) : "", ...first.map((p) => `${p.pid}|${p.firstName}|${p.lastName}|${p.born && p.born.year}`)].join("#");
      let h1 = 0x811c9dc5, h2 = 0x01000193;
      for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 + c, 2654435761) >>> 0; }
      return `L${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
    } finally {
      db.close();
    }
  }

  root.BBGMScoutData = { load, budgetLevel, fingerprint, PLAYER };
})(globalThis);
