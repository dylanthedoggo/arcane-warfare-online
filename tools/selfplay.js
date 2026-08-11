/* ══════════════════════════════════════════════════════════════════════════
   SELF-PLAY, FROM A TERMINAL

       npm run selfplay -- ruthless novice 100
       npm run selfplay -- skilled random 40 --turns 120 --seed 5000

   Two levels, a number of games, and a record. Colours swap each round so
   first-move bias cancels; every game prints the seed it was played on, so a
   surprising one can be played again on its own:

       node -e 'const {ai}=require("./tools/bootstrap.js"); \
                console.log(ai.aiPlayGame("ruthless","novice",200,1037))'

   ── ON THE OUTPUT BEING REPRODUCIBLE ──────────────────────────────────────

   Two runs of the same command print the same bytes. That is the whole point of
   the thing and it is not free — it rests on the machine's dice being seeded
   (ai.js aiRng) and on the search being budgeted in nodes rather than in
   milliseconds (ai.js "what a search may spend"), which aiPlayGame turns on.

   So STDOUT carries only things that are the same every time. Anything that is
   a fact about this afternoon and this laptop — how long it took, how fast it
   went — goes to stderr, where it is still on your screen and still out of a
   diff. `npm run selfplay -- ... > a.txt` twice and compare them; if they
   differ, something has come unseeded and no number below it means anything.
   ══════════════════════════════════════════════════════════════════════════ */

"use strict";

const { ai, read, standInCalls } = require("./bootstrap.js");

const LEVELS = Object.keys(ai.AI_LEVELS).concat("random");

function usage(problem) {
  const out = problem ? console.error : console.log;
  if (problem) out(`selfplay: ${problem}\n`);
  out("usage:  npm run selfplay -- <a> <b> [games] [--turns N] [--seed N] [--scale S]");
  out(`        a, b     ${LEVELS.join(" | ")}`);
  out("        games    default 20");
  out("        --turns  turn limit per game, default 200");
  out("        --seed   seed of the first game; each later one takes the next, default 1000");
  out("        --scale  how much thinking each level gets, as a fraction of its own");
  out("                 figures. Omit for the page's shoestring: every budget clamped");
  out("                 to 40 ms, which is fast and which flattens the levels against");
  out("                 each other — Ruthless's 3000 ms and Novice's 250 become the");
  out("                 same number. Any --scale drops the clamp and multiplies the");
  out("                 real figures instead, so the rungs keep their distance.");
  out("                 --scale 1 is the machine as a player meets it, and is slow.");
  process.exit(problem ? 2 : 0);
}

/* ── arguments ───────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) usage(null);

const flags = { turns: 200, seed: 1000, scale: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--turns" || arg === "--seed") {
    const v = Number(argv[++i]);
    if (!Number.isInteger(v)) usage(`${arg} wants a whole number, got ${JSON.stringify(argv[i])}`);
    flags[arg.slice(2)] = v;
  } else if (arg === "--scale") {
    const v = Number(argv[++i]);
    if (!(v > 0)) usage(`--scale wants a positive number, got ${JSON.stringify(argv[i])}`);
    flags.scale = v;
  } else if (arg.startsWith("--")) {
    usage(`unknown option ${arg}`);
  } else {
    positional.push(arg);
  }
}

const [a, b, gamesArg] = positional;
if (!a || !b) usage("two levels are needed");
for (const name of [a, b]) if (!LEVELS.includes(name)) usage(`no such level: ${name}`);
const games = gamesArg === undefined ? 20 : Number(gamesArg);
if (!Number.isInteger(games) || games < 1) usage(`games wants a whole number, got ${gamesArg}`);
if (flags.turns < 1) usage("--turns must be at least 1");

/* ── the run ─────────────────────────────────────────────────────────────── */

// What the numbers below are numbers ABOUT. Printed rather than assumed,
// because a strength figure without its budget beside it is a figure that will
// be compared with one measured differently.
const fast = flags.scale === null;
const scale = flags.scale === null ? 1 : flags.scale;
const nodesPerMs = read("AI_NODES_PER_MS");

/** The same arithmetic aiBudget and aiNodes do, so the header cannot lie. */
const nodesFor = (ms) => Math.max(512, Math.round((fast ? Math.min(ms, 40) : ms) * scale * nodesPerMs));
const budget = (name) => {
  const L = ai.AI_LEVELS[name];
  if (!L) return "picks uniformly at random — no search at all";
  return `depth<=${L.depth}, ${nodesFor(L.timeMs).toLocaleString("en-US")} nodes/move, `
    + `noise ${L.noise}`;
};

console.log(`${a} vs ${b} — ${games} game${games === 1 ? "" : "s"}, `
  + `turn limit ${flags.turns}, seeds ${flags.seed}..${flags.seed + games - 1}`);
console.log(`budget: nodes, not milliseconds (${nodesPerMs} nodes/ms nominal), `
  + (fast ? "clamped to the page's 40 ms shoestring" : `each level's own figures × ${scale}`));
console.log(`  ${a}: ${budget(a)}`);
console.log(`  ${b}: ${budget(b)}`);
if (fast && ai.AI_LEVELS[a] && ai.AI_LEVELS[b]
    && ai.AI_LEVELS[a].timeMs !== ai.AI_LEVELS[b].timeMs)
  console.log("  (the clamp has made these two budgets equal; pass --scale to keep them apart)");
console.log("");

const abandonedBefore = ai.abandoned();
const startedAt = Date.now();

const rec = ai.aiTournament(a, b, games, flags.turns, flags.seed, { fast, scale });

const elapsed = Date.now() - startedAt;

/* ── the summary ─────────────────────────────────────────────────────────── */

const decided = rec.games.filter((g) => g.how !== "turn limit reached").length;
const pct = (n) => `${((n / games) * 100).toFixed(1)}%`;

console.log("");
console.log(`${a}: ${rec[a]} (${pct(rec[a])})   ${b}: ${rec[b]} (${pct(rec[b])})   tied: ${rec.ties}`);
console.log(`${decided} of ${games} ended in a win rather than on the turn limit.`);

// Not a failure — the board outrunning a plan is a legitimate thing for the
// concealment cards to cause — but a number that climbs steeply means the
// search and the referee have drifted apart. See ai.js aiAbandonPlan.
const abandoned = ai.abandoned() - abandonedBefore;
console.log(`plans abandoned mid-turn: ${abandoned}`);

// The seam, checked at runtime rather than in the text. Anything here beyond
// endTurnLocal and freshUI means the thinking half of ai.js reached for the web
// page and got a stand-in that did nothing. See tools/bootstrap.js.
const strayed = Object.entries(standInCalls)
  .filter(([name]) => name !== "endTurnLocal" && name !== "freshUI");
if (strayed.length) {
  console.log(`page stand-ins reached from the headless path: `
    + strayed.map(([n, c]) => `${n}×${c}`).join(", "));
  console.log("  ^ that is the seam leaking. See tools/bootstrap.js.");
}

// Facts about this laptop this afternoon. Deliberately not on stdout.
console.error(`\n[${(elapsed / 1000).toFixed(1)}s, `
  + `${(elapsed / games / 1000).toFixed(2)}s/game — timing is not part of the output]`);
