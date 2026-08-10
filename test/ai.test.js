"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   STRENGTH REGRESSION SUITE

       npm run test:ai

   NOT part of `npm test`, deliberately. The cheat-rejection suite next door
   proves the referee refuses cheating and runs in under a second, so it can run
   on every save and does. This one plays several dozen games of checkers and
   takes minutes. Folded together, the fast one would stop being run.

   ── WHAT IS MISSING WITHOUT IT ────────────────────────────────────────────

   Nothing in this repository has ever asserted that the machine plays WELL. The
   engine suite proves it cannot cheat; the browser suite proves the search is
   consistent, that the evaluator's numbers have not drifted and that a headless
   game finishes on a legal board. A change that left every one of those passing
   and made the opponent markedly weaker would have shipped without comment.

   ── WHY THE NUMBERS BELOW ARE ALLOWED TO BE EXACT ─────────────────────────

   Because they cannot wander. Given a seed, the machine is deterministic — its
   dice are seeded (ai.js aiRng) and its search is budgeted in nodes rather than
   in wall-clock milliseconds (ai.js "what a search may spend"). So a threshold
   here is not a bet about a distribution; the same code gives the same record
   every time, on any machine.

   That is worth saying plainly because it inverts the usual advice. A gate over
   a noisy measurement has to be set loose enough to survive a bad afternoon,
   which makes it too loose to catch anything; the plan this file comes from
   warned that such a gate gets switched off within a month. This one cannot
   fail at random, so the margins below are about leaving room for honest
   changes to the machine, and nothing else.

   If a threshold here fails, the machine's play changed. That may well be
   deliberate — then move the number, and say in the commit which way it went
   and why. What must not happen is the numbers drifting quietly.
   ══════════════════════════════════════════════════════════════════════════ */

const boot = require("../tools/bootstrap.js");
const agreement = require("../tools/agreement.js");

const { ai, engine, standInCalls, checkSeam, SEAM_OPEN, SEAM_CLOSE } = boot;

/* ── the same very small harness the engine suite uses ────────────────────
   Same reasons: a build step should not need a framework, and `node test/...`
   has to work on a bare container.
   ─────────────────────────────────────────────────────────────────────── */

let passed = 0;
const failures = [];
let group = "";

const describe = (name) => { group = name; console.log(`\n  ${name}`); };

function it(name, fn) {
  const started = Date.now();
  try {
    fn();
    passed++;
    const took = Date.now() - started;
    console.log(`    ok   ${name}${took > 2000 ? `   (${(took / 1000).toFixed(0)}s)` : ""}`);
  } catch (e) {
    failures.push({ group, name, message: e.message });
    console.log(`    FAIL ${name}\n         ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

/**
 * Play a tournament without its running commentary.
 *
 * aiTournament narrates every game, which is what you want from a console and
 * not what you want from a suite. The lines are kept rather than thrown away:
 * on a failure they are the whole of the evidence, and a bare "22 wins, wanted
 * 24" tells you nothing about which games went the other way.
 */
function quietTournament(a, b, games, turns, seed, opts) {
  const said = [];
  const realLog = console.log;
  console.log = (...args) => said.push(args.join(" "));
  try {
    return { rec: ai.aiTournament(a, b, games, turns, seed, opts), said };
  } finally {
    console.log = realLog;
  }
}

/** A failure message with the games attached, because the record is the point. */
const withGames = (msg, said) => `${msg}\n${said.map((l) => `           ${l}`).join("\n")}`;

/**
 * Total pieces `a` finished ahead by, across every game.
 *
 * The win count is the headline and this is the sensitive instrument behind it.
 * Every Ruthless-against-Novice game below runs out of turns rather than ending,
 * so its "win" is a material lead — and a lead of one piece is counted exactly
 * like a lead of twenty. A change costing the machine two pawns a game could
 * move all eight results without moving a single verdict. The margin notices
 * that while the tally is still saying six-one.
 *
 * Skilled against random is the other case and needs it less: those games end
 * by one side running out of pieces, so the tally is already emphatic. The
 * margin is still worth having there as the thing that would show a rout
 * turning into a scrape before it turns into a loss.
 */
const marginFor = (rec, a, b) => rec.games.reduce((sum, g) => sum + (g[a] - g[b]), 0);

/* ══════════════════════════════════════════════════════════════════════════
   THE BRIDGE

   Everything below this depends on ai.js seeing the engine's real game rather
   than a copy of one, so this comes first. bootstrap.js proves it on load —
   requiring it above has already run proveBridge() — and these re-state it here
   so that a failure names itself instead of arriving as a stack trace from
   inside a require.
   ══════════════════════════════════════════════════════════════════════════ */

describe("the bridge to the engine");

it("re-proves itself on demand", () => {
  boot.proveBridge();          // throws, loudly and specifically, if it does not
});

it("hands ai.js a live view of G, not a snapshot of one", () => {
  engine.setG(engine.newGame(0, 4242, { mode: "ai" }));
  engine.beginTurn(0);
  const before = boot.read("G.turn");
  engine.endTurn();
  assert(boot.read("G.turn") !== before,
    `G.turn read as ${before} on both sides of an endTurn() — ai.js is holding a copy`);
});

it("...and lets it assign a whole new game back", () => {
  // The half that fails in SILENCE. ai.js is evaluated in sloppy mode exactly
  // as a script tag is, and sloppy mode discards a write to a getter-only
  // property without throwing — so a getter-only bridge would leave aiPlayGame
  // measuring whatever game happened to be loaded.
  boot.read('(G = newGame(0, 31337, { mode: "ai" }), 0)');
  assert(engine.getG().seed === 31337,
    `the engine still holds seed ${engine.getG().seed} — the assignment went nowhere`);
});

/* ══════════════════════════════════════════════════════════════════════════
   THE SEAM

   A guard nobody has watched fail is a guard nobody should trust, so these hand
   checkSeam doctored files and insist it objects. `toast` is used as the stray
   because it is on no allowlist; `render` would be passed over on purpose.
   ══════════════════════════════════════════════════════════════════════════ */

describe("the seam between the machine and the web page");

const sourceWith = (before, after) => [
  before,
  `/* ${SEAM_OPEN} */`,
  after,
  `/* ${SEAM_CLOSE} */`,
].join("\n");

const rejects = (src, why) => {
  let threw = null;
  try { checkSeam(src); } catch (e) { threw = e; }
  assert(threw, `checkSeam accepted a file that ${why}`);
  return threw.message;
};

it("accepts a page call inside the browser-only band", () => {
  checkSeam(sourceWith("function think() { return 1; }", "function paint() { toast('hi'); }"));
});

it("refuses one outside it", () => {
  const msg = rejects(sourceWith("function think() { toast('hi'); }", "function paint() {}"),
    "calls a page function from the thinking half");
  assert(/toast/.test(msg) && /ai\.js:1/.test(msg),
    `the complaint should name the stray and its line; it said: ${msg}`);
});

it("is not fooled by the name appearing in a comment", () => {
  checkSeam(sourceWith("/* toast() is a page thing */ function think() {}", "function paint() {}"));
});

it("...nor in a string", () => {
  checkSeam(sourceWith('function think() { return "toast"; }', "function paint() {}"));
});

it("refuses a file with no banners at all", () => {
  rejects("function think() { toast('hi'); }", "has lost its banners");
});

it("...and one with them the wrong way round", () => {
  rejects([`/* ${SEAM_CLOSE} */`, "function paint() {}", `/* ${SEAM_OPEN} */`].join("\n"),
    "has its banners reversed");
});

it("the real public/ai.js still passes it", () => {
  const seam = checkSeam(require("fs").readFileSync(boot.AI_PATH, "utf8"));
  assert(seam.browserOnlyLines > 0 && seam.browserOnlyLines < 400,
    `the browser-only band is ${seam.browserOnlyLines} lines, which is not a band, it is a file`);
});

/* ══════════════════════════════════════════════════════════════════════════
   REPRODUCIBILITY

   The foundation every threshold further down stands on. If this group fails,
   the ones below it are meaningless rather than merely wrong, so read the
   failure here first and ignore everything after it.
   ══════════════════════════════════════════════════════════════════════════ */

describe("the same seed plays the same game");

it("a seeded game returns the same result twice", () => {
  const a = ai.aiPlayGame("skilled", "novice", 30, 7);
  const b = ai.aiPlayGame("skilled", "novice", 30, 7);
  assert(JSON.stringify(a) === JSON.stringify(b),
    `${JSON.stringify(a)}\n         vs ${JSON.stringify(b)}`);
});

it("...and the same transcript, line for line", () => {
  const play = () => {
    ai.aiPlayGame("skilled", "novice", 30, 7);
    return engine.getG().log.map((l) => l.text);
  };
  const a = play(), b = play();
  const i = a.findIndex((l, k) => l !== b[k]);
  assert(a.length === b.length && i === -1,
    i === -1 ? `${a.length} lines vs ${b.length}` : `line ${i + 1}: "${a[i]}" vs "${b[i]}"`);
});

it("...at the level that blunders most, which is where it used to fail", () => {
  // Novice carries noise 38, the loudest dice in the game. Before the machine's
  // randomness was seeded this pair of games agreed roughly never, and Ruthless
  // — the level anyone would test first — reproduced perfectly, because noise 0
  // multiplies the sample to zero. Hence checking here rather than there.
  const a = ai.aiPlayGame("novice", "novice", 30, 11);
  const b = ai.aiPlayGame("novice", "novice", 30, 11);
  assert(JSON.stringify(a) === JSON.stringify(b),
    `${JSON.stringify(a)}\n         vs ${JSON.stringify(b)}`);
});

it("the noiseless level is untouched by any of it", () => {
  // Ruthless never draws from the stream at all, so this is the check that the
  // seeding work left the strongest level bit-for-bit as it was.
  const a = ai.aiPlayGame("ruthless", "ruthless", 16, 5150);
  const b = ai.aiPlayGame("ruthless", "ruthless", 16, 5150);
  assert(JSON.stringify(a) === JSON.stringify(b), JSON.stringify({ a, b }));
});

/* ══════════════════════════════════════════════════════════════════════════
   NODE AND THE BROWSER
   ══════════════════════════════════════════════════════════════════════════ */

describe("Node and the browser play the same game");

it("matches the transcript recorded in a browser", () => {
  const theirs = agreement.recorded();
  assert(theirs !== null,
    `nothing recorded at ${agreement.FIXTURE_REL} — see npm run agreement -- --print`);
  const ours = agreement.runHere().replace(/\r\n/g, "\n").trimEnd();
  if (ours === theirs) return;

  const a = theirs.split("\n"), b = ours.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  throw new Error(
    `diverged at line ${i + 1} of ${a.length}\n`
    + `           browser: ${a[i] === undefined ? "(end)" : a[i]}\n`
    + `           node:    ${b[i] === undefined ? "(end)" : b[i]}\n`
    + "           A bridge that is subtly wrong plays a different game without ever\n"
    + "           throwing. Run npm run agreement for the full diagnosis.");
});

/* ══════════════════════════════════════════════════════════════════════════
   STRENGTH

   ── WHY THE OPPONENT IS A COPY OF THE MACHINE ITSELF ──────────────────────

   The obvious gate, and the one this file was originally written with, is
   "Ruthless beats Novice by a good margin". It does — 6-1-1 over these eight
   seeds. It is also very nearly useless, and that was worth finding out by
   experiment rather than by argument. Two deliberate regressions were built and
   run against it:

     Ruthless cut from depth 10 to depth 2      7-1, +31 pieces   PASSES
     Ruthless given noise 60 — blundering
       harder than Novice itself does           6-1, +40 pieces   PASSES

   Both of those are the machine being gutted, and both sail through, one of
   them with a BETTER record than the real thing. The reason is not subtle once
   seen: Novice is so much weaker that Ruthless beats it comfortably in any
   condition, so the measurement is saturated and has no resolution left to
   spend on the question actually being asked.

   The fix is to make the opponent track the thing under test. A handicapped
   copy of Ruthless — same level in every respect but one — is exactly as strong
   as Ruthless in all the ways that are not being measured, so the whole of the
   difference lands on the one knob that moved. The same two regressions, put
   against their own kind:

     depth 10 vs depth 2, all else equal        5-0, 3 tied, +19 pieces
     noise 0 vs noise 60, all else equal        5-1, 2 tied, +18 pieces

   Those separate. So the gates below are self-play against a hobbled twin, and
   the Ruthless-against-Novice game is kept only for what it can honestly say:
   that the difficulty ladder faces the right way up.

   ── AND THE GATE WAS WATCHED FAILING ──────────────────────────────────────

   The same two regressions were then run against the gates as they now stand.
   Both are caught. Note which assertion does the catching:

                              ahead of twin?   wins >= 3?   margin >= 8?
     depth 10 -> 2               3-4  FAILS     3  passes    0   FAILS
     noise 0 -> 60               2-5  FAILS     2   FAILS    1   FAILS

   The margin is the sharp instrument and the win count is the blunt one — a
   hobbled twin is a copy of a hobbled Ruthless, so the two become the same
   engine, and the same engine playing itself splits the games roughly evenly
   while finishing level on material. The win count can survive that on a lucky
   split, as it did in the first row. The margin cannot. Keep all three.

   ── ON THE BUDGET ─────────────────────────────────────────────────────────

   `scale` is what a level is given to think with, as a fraction of its own
   figures. Without it every budget is clamped to 40 ms, which makes Ruthless's
   3000 and Novice's 250 the same number. At scale 0.05 Ruthless reaches depth 6
   on the opening position; at scale 1 it reaches its ceiling of 10 and costs
   twenty times as much to say so.
   ══════════════════════════════════════════════════════════════════════════ */

describe("the machine still plays well");

/**
 * Eight games of a hundred and forty turns each, from seed 70000.
 *
 * THE TURN LIMIT IS THE SIGNAL, and it took some measuring to believe that.
 * Almost nothing here ends in a win — pieces come off this board slowly, and
 * every game below runs out of turns — so the verdict is a material count, and
 * a material count needs the game to have gone somewhere first. The same eight
 * seeds, same budgets, only the limit moved:
 *
 *     60 turns    Ruthless 5-1, two tied, +11 pieces      3 seconds a game
 *    100 turns    Ruthless 5-1, two tied, +21 pieces     13 seconds a game
 *    140 turns    see the thresholds below               19 seconds a game
 *
 * At 60 the two are still shuffling about a piece apart and the sample says
 * almost nothing. It is not a cheaper measurement of the same thing; it is a
 * cheaper measurement of less.
 *
 * The seeds start at 70000 rather than at aiTournament's default of 1000 so
 * that this gate is not measuring the same games anybody tuning the levels
 * would have been staring at.
 */
const GATE = { games: 8, turns: 140, seed: 70000 };

/* ── the thresholds, and what each was measured at ──────────────────────────

   Ruthless against a copy of itself cut to depth 2, at scale 0.05:
       5 wins, 0 losses, 3 tied        +19 pieces        145 seconds

   Ruthless against a copy of itself given noise 60, at scale 0.05:
       5 wins, 1 loss, 2 tied          +18 pieces        145 seconds

   Ruthless against Novice, four games, at scale 0.05:
       3 wins, 0 losses, 1 tied        +17 pieces         75 seconds

   Skilled against a player choosing uniformly at random, on the shoestring:
       8 wins, every one of them by     +133 pieces        44 seconds
       taking the last enemy piece

   The gap between each pair of numbers is the tolerance, and it is not there to
   absorb noise — there is none — but so that an honest change to the machine
   does not have to come and edit this file to get through.
   ─────────────────────────────────────────────────────────────────────────── */

const SHALLOW_WINS_MIN = 3, SHALLOW_WINS_MEASURED = 5;
const SHALLOW_MARGIN_MIN = 8, SHALLOW_MARGIN_MEASURED = 19;
const NOISY_WINS_MIN = 3, NOISY_WINS_MEASURED = 5;
const NOISY_MARGIN_MIN = 8, NOISY_MARGIN_MEASURED = 18;
const LADDER_MARGIN_MIN = 6, LADDER_MARGIN_MEASURED = 17;
const SKILLED_WINS_MIN = 7, SKILLED_WINS_MEASURED = 8;
const SKILLED_MARGIN_MIN = 90, SKILLED_MARGIN_MEASURED = 133;

// Across every game this file plays — some two thousand turns. Measured at
// zero, and the browser suite allows three across a hundred and eighty turns,
// so ten here is loose on purpose: this is a net, not a routine.
const ABANDON_MAX = 10, ABANDON_MEASURED = 0;

/** Run a tournament at most once, however many assertions want to read it. */
const once = (fn) => { let v = null; return () => (v || (v = fn())); };

// Half the size of the others, because it is a sanity check rather than a
// measurement — see the note on why it cannot be more than that.
const LADDER_GAMES = 4;
const ruthlessVsNovice = once(() => quietTournament(
  "ruthless", "novice", LADDER_GAMES, GATE.turns, GATE.seed, { fast: false, scale: 0.05 }));

// Random needs no budget at all, so this one runs on the shoestring.
const skilledVsRandom = once(() => quietTournament(
  "skilled", "random", GATE.games, GATE.turns, GATE.seed));

/**
 * Ruthless with exactly one thing taken away from it.
 *
 * Registered on AI_LEVELS the way the browser suite registers its own throwaway
 * levels, and taken off again at the end of this group, so nothing outside this
 * file ever sees a fourth difficulty.
 */
const HANDICAPS = {
  __shallow: { depth: 2, name: "Shallow" },     // the search
  __noisy: { noise: 60, name: "Noisy" },        // the choice among what it found
};
for (const [key, diff] of Object.entries(HANDICAPS))
  ai.AI_LEVELS[key] = Object.assign({}, ai.AI_LEVELS.ruthless, diff);

/** Ruthless against one of its own hobbled twins. */
const versusTwin = (key) => once(() => quietTournament(
  "ruthless", key, GATE.games, GATE.turns, GATE.seed, { fast: false, scale: 0.05 }));

const shallowRun = versusTwin("__shallow");
const noisyRun = versusTwin("__noisy");

/**
 * The real one has to finish ahead of the hobbled one. Three readings of the
 * same tournament: that it came out ahead at all, that it did so by enough
 * games, and that it did so by enough pieces.
 */
function beatsItsTwin(key, winsMin, winsMeasured, marginMin, marginMeasured, run) {
  const { rec, said } = run();
  const margin = marginFor(rec, "ruthless", key);
  assert(rec.ruthless > rec[key],
    withGames(`Ruthless took ${rec.ruthless} and ${key} took ${rec[key]}. Finishing ahead `
      + "of its own hobbled copy is the entire claim.", said));
  assert(rec.ruthless >= winsMin,
    withGames(`Ruthless took ${rec.ruthless} of ${GATE.games} and this asks for `
      + `${winsMin}; measured at ${winsMeasured}.`, said));
  assert(margin >= marginMin,
    withGames(`Ruthless finished ${margin} pieces up and this asks for ${marginMin}; `
      + `measured at ${marginMeasured}.`, said));
}

it("a deeper search beats a shallower one, all else held equal", () => {
  // Catches a broken iterative deepening, a mis-set depth ceiling, a
  // transposition table that has started returning wrong scores — anything
  // that stops the extra plies being worth having. The Novice gate could not
  // see any of it.
  beatsItsTwin("__shallow", SHALLOW_WINS_MIN, SHALLOW_WINS_MEASURED,
    SHALLOW_MARGIN_MIN, SHALLOW_MARGIN_MEASURED, shallowRun);
});

it("...and choosing the best move it found beats choosing sloppily", () => {
  // The other half. A search can be perfect and still throw the answer away at
  // the root, which is what noise does on purpose at the easier levels — so
  // this is the check that the ranking is still being used.
  beatsItsTwin("__noisy", NOISY_WINS_MIN, NOISY_WINS_MEASURED,
    NOISY_MARGIN_MIN, NOISY_MARGIN_MEASURED, noisyRun);
});

it("the difficulty ladder faces the right way up", () => {
  // Kept small and read narrowly. This says Ruthless is not WEAKER than Novice,
  // which is a claim a player can feel and worth holding on to. It is not
  // evidence that the machine is playing well — see the note above; two gutted
  // versions of Ruthless passed a larger version of this same test.
  const { rec, said } = ruthlessVsNovice();
  assert(rec.ruthless > rec.novice,
    withGames(`Ruthless ${rec.ruthless}, Novice ${rec.novice} — the ladder is inverted.`, said));
  assert(marginFor(rec, "ruthless", "novice") >= LADDER_MARGIN_MIN,
    withGames(`Ruthless finished ${marginFor(rec, "ruthless", "novice")} pieces up over `
      + `${LADDER_GAMES} games and this asks for ${LADDER_MARGIN_MIN}; measured at `
      + `${LADDER_MARGIN_MEASURED}.`, said));
});

it("Skilled beats a player choosing at random, near enough always", () => {
  // The floor of the whole thing. Whatever else has changed, a machine that
  // searches four plies must not be losing to a coin. This is the assertion
  // that would catch a search wired up backwards — the sort of break that
  // leaves every other test in this file passing.
  const { rec, said } = skilledVsRandom();
  assert(rec.skilled >= SKILLED_WINS_MIN,
    withGames(`Skilled took ${rec.skilled} of ${GATE.games} and this asks for `
      + `${SKILLED_WINS_MIN}; measured at ${SKILLED_WINS_MEASURED}.`, said));
});

it("...and strips it of most of its pieces doing so", () => {
  const { rec, said } = skilledVsRandom();
  const margin = marginFor(rec, "skilled", "random");
  assert(margin >= SKILLED_MARGIN_MIN,
    withGames(`Skilled finished ${margin} pieces up across ${GATE.games} games and this `
      + `asks for ${SKILLED_MARGIN_MIN}; measured at ${SKILLED_MARGIN_MEASURED}.`, said));
});

it("the hobbled twins were only ever visible in here", () => {
  // Registered on the shared AI_LEVELS, so they have to be taken off it again.
  // A fourth difficulty surviving into the browser would be a real bug and an
  // extremely confusing one.
  for (const key of Object.keys(HANDICAPS)) delete ai.AI_LEVELS[key];
  assert(Object.keys(ai.AI_LEVELS).join(",") === "novice,skilled,ruthless",
    `AI_LEVELS is now ${Object.keys(ai.AI_LEVELS).join(", ")}`);
});

it("the levels are ordered, by their knobs as well as their results", () => {
  const ladder = ["novice", "skilled", "ruthless"].map((k) => ai.AI_LEVELS[k]);
  const rises = (f, what) => assert(
    ladder.every((L, i) => i === 0 || f(L) > f(ladder[i - 1])),
    `${what}: ${ladder.map(f).join(" then ")}`);
  rises((L) => L.depth, "each level should search deeper than the last");
  rises((L) => L.timeMs, "...and be given longer to do it");
  assert(ladder.every((L, i) => i === 0 || L.noise < ladder[i - 1].noise),
    `...and blunder less: ${ladder.map((L) => L.noise).join(" then ")}`);
  assert(ai.AI_LEVELS.ruthless.noise === 0, "only Ruthless should be noiseless");
});

/* ══════════════════════════════════════════════════════════════════════════
   THE SEAM, AT RUNTIME

   The check at the top of this file reads the text of ai.js. This one watches
   what actually happened over every game played above: each stand-in counts its
   own calls, so a page function reached from the thinking half shows up here as
   a number that should have been zero.

   Last, because it is a verdict on everything before it.
   ══════════════════════════════════════════════════════════════════════════ */

describe("the page was never needed");

it("nothing but the turn-ender and freshUI was ever reached for", () => {
  const strayed = Object.entries(standInCalls)
    .filter(([name]) => name !== "endTurnLocal" && name !== "freshUI");
  assert(strayed.length === 0,
    `${strayed.map(([n, c]) => `${n} was called ${c} time(s)`).join(", ")}.\n`
    + "           Headless, those do nothing; in the browser they draw. The two copies\n"
    + "           of the machine have started to differ. See tools/bootstrap.js.");
});

it("...and the turn-ender was, hundreds of times", () => {
  // The other side of it: a tally of zero would mean the games above never
  // happened, and every threshold in this file passed by not running.
  assert(standInCalls.endTurnLocal > 100,
    `endTurnLocal was called ${standInCalls.endTurnLocal || 0} times, which is too few `
    + "for the games this file claims to have played");
});

it("the machine hardly ever has to abandon a plan", () => {
  // Not a failure on its own — the concealment cards can legitimately outrun a
  // plan — but a number that climbs steeply means the search and the referee
  // have drifted apart. See ai.js aiAbandonPlan.
  assert(ai.abandoned() <= ABANDON_MAX,
    `${ai.abandoned()} plans abandoned across this suite, and this allows `
    + `${ABANDON_MAX}. Measured at ${ABANDON_MEASURED}.`);
});

/* ── report ───────────────────────────────────────────────────────────── */

console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.log(`  ${f.group} — ${f.name}\n    ${f.message}\n`);
  console.log("The machine's play has changed. If you meant it, move the number and say"
    + "\nin the commit message which way it went.\n");
  process.exit(1);
}
console.log(`✓ ${passed} strength checks passed\n`);
