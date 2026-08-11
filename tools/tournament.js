"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   SELF-PLAY TOURNAMENT  —  node tools/tournament.js

   Plays two levels against each other, colours swapped every round so the
   first-move advantage cancels, and reports the record plus how the games were
   actually played.

   WHY THIS EXISTS AS A NODE TOOL. The machine used to be measurable only from
   a browser console, which meant a hidden tab throttled its timers to roughly
   one tick a second and a harness timeout cut every run short at thirty
   seconds. Neither limit applies here, so a strength question can be answered
   with the dozens of games it actually needs. ai.js gained a Node bridge for
   this; see the top of that file.

     node tools/tournament.js ruthless skilled --games 20
     node tools/tournament.js skilled random --games 10 --turns 150
     node tools/tournament.js skilled skilled --games 8 --full
     node tools/tournament.js ruthless skilled --games 40 --full --jobs 3

   --full plays at the search budgets a real game uses. Without it, games run
   on the shoestring budget the in-page regression tests use — EVERY search
   capped at 40ms regardless of level, which is a materially weaker machine, so
   never compare a --full run against one without it. A default run of Ruthless
   is not Ruthless.

   HOW LONG THIS TAKES, MEASURED. A --full Ruthless-vs-Skilled game that goes
   the distance costs around four and a half minutes, nearly all of it inside
   alpha-beta. Twenty of them is therefore an hour and a half single-threaded,
   which is the reason for --jobs: the games are independent, so they can be
   played several at a time on different cores.

   Expect somewhat less than the job count. On four cores, --jobs 3 turned
   268.9s a game into 114.1s a game — 2.36x, not 3x. The shortfall is not the
   searches being starved: those kept their full budget and their full node
   counts. It is the work BETWEEN searches — move generation, snapshot and
   restore, logging — which is not time-bounded and so just runs slower when
   three cores are busy. An individual game stretched from 269s to 342s while
   playing exactly as hard.

   NO RUN IS REPRODUCIBLE, AND --jobs IS NOT WHY. It is tempting to read the
   --seed flag as making a run replayable. It does not, and this was true long
   before there were any workers: two identical `--jobs 1` runs of the same
   command produce different games. The seed fixes the deal and the root-score
   jitter, but every search stops on the WALL CLOCK, and how much thinking fits
   in 3000ms varies with whatever else the machine is doing. Measured on the
   same position twice in a row, alone: 154,112 nodes and then 169,472 — a ten
   percent swing, easily enough to change which move comes back.

   So a tournament is a sample, not a recording. Judge a change by the record
   over enough games that the noise cancels, never by whether one game came out
   the same. Making runs replayable would mean bounding the search by node
   count rather than by time, which is a real change to the machine and not one
   this tool can make on its own.

   WHAT --jobs COSTS. Nothing measurable, up to about one worker per spare
   core. Three simultaneous 3000ms searches on this four-core machine each got
   through as many positions as one search running alone, so the workers were
   not stealing thinking time from each other. Push --jobs past the core count
   and that stops being true: searches keep their 3000ms but get less CPU
   inside it, which quietly makes the machine weaker. If you do that, do not
   compare the result against a run that did not.

   THE TURN LIMIT IS NOT A DRAW. A game that reaches it is awarded on material,
   because a side with twice the pieces left has won in every sense that
   matters. Games decided that way are reported separately, since a tournament
   that is mostly turn-limit verdicts is measuring endgame conversion rather
   than strength.
   ══════════════════════════════════════════════════════════════════════════ */

const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");

/* ── arguments ──────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const BOOL = new Set(["full", "quiet"]);       // flags that take no value
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const t = argv[i];
  if (!t.startsWith("--")) { positional.push(t); continue; }
  const name = t.slice(2);
  if (BOOL.has(name)) flags[name] = true;
  else flags[name] = argv[++i];                // consume the value, so it is not positional
}
const flag = (name, fallback) => (name in flags ? Number(flags[name]) : fallback);
const has = (name) => flags[name] === true;

// Levels are read from a child-free require purely to validate arguments. This
// also installs ai.js's Node bridge in the parent, which is harmless: the
// parent never plays a game unless --jobs 1 asks it to.
const ai = require(path.join(__dirname, "..", "public", "ai.js"));

const LEVELS = new Set([...ai.AI_ORDER, "random"]);
const a = positional[0] || "skilled";
const b = positional[1] || "random";
for (const name of [a, b]) {
  if (!LEVELS.has(name)) {
    console.error(`unknown level "${name}". choose from: ${[...LEVELS].join(", ")}`);
    process.exit(2);
  }
}

const games = flag("games", 10);
const maxTurns = flag("turns", 200);
const seed0 = flag("seed", 1000);
const full = has("full");
const quiet = has("quiet");

// One core left for the OS and for whatever else is running, since a worker
// pegs a core for minutes at a time and a machine with none spare gets
// unpleasant to use. Never more workers than there are games to play.
const defaultJobs = Math.max(1, Math.min(os.cpus().length - 1, games));
const jobs = Math.max(1, Math.min(flag("jobs", defaultJobs), games));

/* ── accounting ─────────────────────────────────────────────────────────── */

// Counted as first-named vs second-named rather than by level name, because in
// a mirror those two names are the same string and an object keyed by them
// would silently collapse into one column.
const rec = { a: 0, b: 0, ties: 0 };
const mirror = a === b;
const rows = [];
const totals = { casts: 0, transforms: 0, draws: 0, wasted: 0, turns: 0, byMaterial: 0 };

/** Which colour the first-named level takes in game `i`. */
const aIsGoldIn = (i) => i % 2 === 0;

/** Folds one finished game into the running record and returns its row. */
function record(i, r) {
  const aIsGold = aIsGoldIn(i);
  const aP = aIsGold ? r.gold : r.violet;
  const bP = aIsGold ? r.violet : r.gold;
  let side, decided;                            // "a", "b" or "ties"
  if (r.winner != null) {
    side = (r.winner === 0) === aIsGold ? "a" : "b";
    decided = "board";
  } else {
    side = aP > bP ? "a" : bP > aP ? "b" : "ties";
    decided = "material";
    totals.byMaterial++;
  }
  rec[side]++;
  const winner = side === "ties" ? "ties" : side === "a" ? a : b;

  for (const k of ["casts", "transforms", "draws", "wasted", "turns"]) totals[k] += r[k];
  const row = { g: i + 1, gold: aIsGold ? a : b, winner, decided, turns: r.turns,
                aP, bP, casts: r.casts, transforms: r.transforms, draws: r.draws,
                wasted: r.wasted, how: r.reason };
  rows.push(row);
  return row;
}

function printRow(row) {
  if (quiet) return;
  console.log(`  ${String(row.g).padStart(3)}.  ${row.winner === "ties" ? "tie" : row.winner.padEnd(8)}`
    + ` ${String(row.aP).padStart(2)}v${String(row.bP).padEnd(2)}`
    + ` ${String(row.turns).padStart(3)}t`
    + `  casts ${String(row.casts).padStart(2)} (${row.transforms} form)`
    + `  draws ${String(row.draws).padStart(2)}`
    + `  wasted ${String(row.wasted).padStart(3)}`
    + `  ${row.decided === "material" ? "on material" : row.how}`);
}

/** The job description for game `i`. Seed depends on i alone, so which worker
    picks it up does not change the deal — though it does not make the game
    replayable either; see the header on why. */
const jobFor = (i) => ({
  i,
  gold: aIsGoldIn(i) ? a : b,
  violet: aIsGoldIn(i) ? b : a,
  maxTurns, seed: seed0 + i, fast: !full,
});

/* ── playing them ───────────────────────────────────────────────────────── */

/**
 * Plays every game in this process, in order. Kept for --jobs 1: a stack trace
 * from a crash lands in the tournament rather than in a worker, which makes
 * debugging the machine itself much easier than chasing it across threads.
 */
function runSerial() {
  for (let i = 0; i < games; i++) {
    const j = jobFor(i);
    printRow(record(i, ai.aiPlayGame(j.gold, j.violet, j.maxTurns, j.seed, { fast: j.fast })));
  }
}

/**
 * Plays them across `jobs` workers, handing each worker a new game as it
 * finishes its last one, so a short game does not leave a core idle while a
 * long one runs.
 *
 * Results arrive out of order and are buffered until every earlier game has
 * been recorded. That costs a little memory and buys a report that reads the
 * same as a serial one — which matters, because the per-game lines are the
 * evidence somebody is going to compare against a previous run.
 */
function runParallel() {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "tournament-worker.js");
    const pool = [];
    let next = 0;            // next game to hand out
    let done = 0;            // games recorded
    let cursor = 0;          // next game index allowed to print
    const held = new Map();  // i -> result, waiting for its turn to be recorded
    let failed = false;

    const shutdown = () => { for (const w of pool) w.terminate(); };

    const drain = () => {
      while (held.has(cursor)) {
        printRow(record(cursor, held.get(cursor)));
        held.delete(cursor);
        cursor++;
      }
    };

    const feed = (w) => {
      if (next < games) w.postMessage(jobFor(next++));
      else w.postMessage("stop");
    };

    for (let k = 0; k < jobs; k++) {
      const w = new Worker(workerPath);
      pool.push(w);
      w.on("message", (msg) => {
        if (failed) return;
        if (msg.error) {
          failed = true; shutdown();
          reject(new Error(`game ${msg.i + 1} crashed in a worker:\n${msg.error}`));
          return;
        }
        held.set(msg.i, msg.r);
        done++;
        drain();
        if (done === games) { shutdown(); resolve(); return; }
        feed(w);
      });
      w.on("error", (err) => {
        if (failed) return;
        failed = true; shutdown(); reject(err);
      });
      feed(w);
    }
  });
}

/* ── the report ─────────────────────────────────────────────────────────── */

function report(elapsedMs) {
  const elapsed = elapsedMs / 1000;
  const avg = (k) => (totals[k] / games).toFixed(1);
  console.log(`\n  ── record ──`);
  if (mirror) {
    console.log(`  ${a} mirror — both sides are the same player, so this is the seed`);
    console.log(`  spread and not a strength signal: ${rec.a} — ${rec.b}${rec.ties ? `, ${rec.ties} tied` : ""}.`);
    console.log(`  Read the per-game numbers below instead.`);
  } else {
    console.log(`  ${a} ${rec.a} — ${rec.b} ${b}${rec.ties ? `  (${rec.ties} tied)` : ""}`);
    const played = rec.a + rec.b;
    if (played) console.log(`  ${a} win rate: ${((100 * rec.a) / played).toFixed(0)}%`);
  }
  console.log(`\n  ── how they played (per game) ──`);
  console.log(`  turns          ${avg("turns")}`);
  console.log(`  spells cast    ${avg("casts")}   of which transformations ${avg("transforms")}`);
  console.log(`  cards drawn    ${avg("draws")}`);
  console.log(`  turns wasting Focus at the cap  ${avg("wasted")}`);
  if (totals.byMaterial)
    console.log(`\n  ${totals.byMaterial} of ${games} hit the turn cap and were awarded on material.`);
  // With workers in play the second figure is throughput, not the cost of a
  // game — a game still takes what it takes. Said plainly so nobody reads a
  // --jobs 4 run as having made the machine four times faster.
  console.log(`\n  ${elapsed.toFixed(1)}s total, ${(elapsed / games).toFixed(1)}s a game`
    + `${jobs > 1 ? ` at ${jobs} at a time` : ""}.`);
}

/* ── main ───────────────────────────────────────────────────────────────── */

(async () => {
  console.log(`${a} vs ${b} — ${games} games, ${maxTurns} turn cap, `
    + `${full ? "full" : "shoestring"} budgets, `
    + `${jobs === 1 ? "one at a time" : `${jobs} at a time`}\n`);

  const started = Date.now();
  if (jobs === 1) runSerial();
  else await runParallel();
  report(Date.now() - started);
})().catch((err) => {
  console.error(`\ntournament aborted: ${err.message}`);
  process.exit(1);
});
