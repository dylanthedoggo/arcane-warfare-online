"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   TOURNAMENT WORKER  —  one process's worth of self-play

   Not run directly. tools/tournament.js starts a few of these and feeds each
   one game at a time.

   WHY A WORKER AND NOT JUST A LOOP. A full-budget game costs minutes, almost
   all of it inside alpha-beta on a single thread, and the games in a
   tournament have nothing to say to each other. So the only way to answer a
   strength question in an afternoon rather than overnight is to play several
   at once on different cores.

   Each worker gets its own copy of the module registry, which is what makes
   this safe: engine.js's `G` and ai.js's `AI` are module-level state, and two
   games sharing them would corrupt each other. Separate workers cannot.

   WHAT A WORKER DOES NOT CHANGE. Seeds are handed down from the parent, so
   game 7 is dealt the same cards whichever worker picks it up. That is not the
   same as game 7 playing out the same way: the search stops on the wall clock,
   so no run of this tool is reproducible, workers or not. The parent's header
   explains why, and why it does not undermine the measurement.
   ══════════════════════════════════════════════════════════════════════════ */

const path = require("path");
const { parentPort } = require("worker_threads");

// Loading ai.js also installs its Node bridge — the live `G` accessor and the
// stand-ins for the page. Paid once per worker, not once per game.
const ai = require(path.join(__dirname, "..", "public", "ai.js"));

parentPort.on("message", (job) => {
  if (job === "stop") { parentPort.close(); return; }
  const { i, gold, violet, maxTurns, seed, fast } = job;
  try {
    const r = ai.aiPlayGame(gold, violet, maxTurns, seed, { fast });
    parentPort.postMessage({ i, r });
  } catch (err) {
    // A crashed game must not look like a legitimate result, and must not
    // silently shrink the sample either — the parent reports it and exits.
    parentPort.postMessage({ i, error: err && err.stack ? err.stack : String(err) });
  }
});
