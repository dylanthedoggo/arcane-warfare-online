/* ══════════════════════════════════════════════════════════════════════════
   DO THE TWO COPIES OF THE MACHINE AGREE?

       npm run agreement            compare Node against the recorded browser
       npm run agreement -- --print the snippet to paste into a browser console
       npm run agreement -- --write record what Node does (see the warning)

   ── WHAT THIS IS FOR ──────────────────────────────────────────────────────

   ai.js is loaded two ways: as a script tag, where it shares one scope with
   engine.js, and through tools/bootstrap.js, where it is handed a G that only
   looks like a shared variable. A bridge that is subtly wrong does not throw.
   It produces a machine that runs perfectly well and plays a DIFFERENT game,
   and every number tuned against it afterwards would be tuned against a
   phantom. Nothing else in this repository would notice.

   So: one recipe, run in both places, compared byte for byte. The recipe lives
   here as a single string rather than as two copies of a procedure, because two
   copies of a procedure is exactly the failure this is meant to detect.

   ── WHY EXACT COMPARISON IS FAIR ──────────────────────────────────────────

   It is only fair because two things were fixed first, and if either regresses
   this check will start failing for that reason rather than for a broken
   bridge — so it is worth knowing which is which:

     1. The machine's dice are seeded (ai.js aiRng). Before that, any level with
        noise above zero — that is, Novice and Skilled — chose differently on
        every run, in the same browser, let alone across two of them.
     2. The search is budgeted in NODES, not milliseconds (ai.js "what a search
        may spend"). A wall clock makes the reachable depth a fact about the
        machine and the moment: the same position at Skilled reached depths
        2, 3, 4, 4, 4 in five consecutive runs on one laptop. Two different
        JavaScript engines had no chance at all. aiPlayGame turns this on.

   The recipe pins the budget knobs explicitly rather than relying on those
   defaults, so that a change to what aiPlayGame assumes shows up here as a
   mismatch instead of quietly moving both sides at once.
   ══════════════════════════════════════════════════════════════════════════ */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { ROOT } = require("./bootstrap.js");

const FIXTURE = path.join(ROOT, "test", "fixtures", "agreement.browser.txt");
const FIXTURE_REL = "test/fixtures/agreement.browser.txt";

/* ══════════════════════════════════════════════════════════════════════════
   THE RECIPE

   Deliberately dull JavaScript — no optional chaining, no modules, nothing that
   needs a build step — because it has to be pasteable into a browser console
   and evaluated by vm here, and be the same text in both.

   Short games on purpose. The engine's log keeps the last 400 lines and drops
   the rest, so a long game would compare its tail and quietly stop comparing
   its opening; the recipe checks for that rather than assuming it.
   ══════════════════════════════════════════════════════════════════════════ */

const RECIPE = `(function () {
  var SEED = 20260810;
  var GAMES = [
    ["skilled",  "novice",  30],
    ["ruthless", "skilled", 24],
    ["skilled",  "random",  30],
    ["novice",   "novice",  30]
  ];
  var out = [];
  out.push("agreement recipe v1 seed=" + SEED);

  for (var g = 0; g < GAMES.length; g++) {
    var gold = GAMES[g][0], violet = GAMES[g][1], turns = GAMES[g][2];
    // Pinned rather than defaulted: if aiPlayGame's idea of a headless game
    // changes, this should fail here rather than move on both sides at once.
    var r = aiPlayGame(gold, violet, turns, SEED + g, { fast: true, scale: 1 });

    out.push("");
    out.push("== " + gold + " (Gold) vs " + violet + " (Violet), seed " + (SEED + g) + " ==");
    out.push("result winner=" + r.winner + " turns=" + r.turns
      + " gold=" + r.gold + " violet=" + r.violet + " reason=" + r.reason);

    // The board, square by square. Two runs that made every same move but
    // resolved one card differently would still part company here.
    var fp = [];
    for (var i = 0; i < G.board.length; i++) {
      var p = G.board[i];
      if (!p) continue;
      fp.push(i + ":" + p.owner + p.rank.charAt(0) + (p.form ? p.form.charAt(0) : "-")
        + (p.armor ? "A" : "") + (p.frozen ? "F" + p.frozen : "")
        + (p.hollow ? "H" : "") + (p.quantum != null ? "Q" : ""));
    }
    out.push("board " + fp.join(" "));
    out.push("focus " + G.players[0].fp + "/" + G.players[1].fp
      + " hand " + G.players[0].hand.length + "/" + G.players[1].hand.length);

    // The move sequence itself. Every movement, capture, cast, draw and
    // penalty writes a line, so this IS the transcript.
    if (G.log.length >= 400) {
      out.push("!! the log hit its 400-line cap; this game is only being compared "
        + "from its tail onwards. Shorten it.");
    }
    for (var k = 0; k < G.log.length; k++) out.push("log " + G.log[k].text);
  }
  return out.join("\\n");
})()`;

/* ══════════════════════════════════════════════════════════════════════════
   RUNNING IT
   ══════════════════════════════════════════════════════════════════════════ */

/** Play the recipe in this process, in the scope bootstrap.js prepared. */
const runHere = () => vm.runInThisContext(RECIPE, { filename: "agreement:recipe" });

/**
 * Two independent 32-bit hashes and a length.
 *
 * This exists because of a practical problem, not a cryptographic one: the
 * recipe returns some nine thousand characters, and getting that out of a
 * browser console and into a file without a stray newline or a smart quote is
 * the step at which a check like this quietly stops being re-recorded. A
 * digest is three short numbers you can read off a screen and compare by eye.
 *
 * Two hashes rather than one because they are weak and homemade. Agreement on
 * FNV-1a, on djb2 AND on the length is not proof the way SHA-256 would be, but
 * these are transcripts of chess-like games, not an adversary choosing inputs.
 * When it matters, compare the files.
 */
function digestOf(s) {
  let fnv = 0x811c9dc5 >>> 0, djb = 5381 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    fnv = Math.imul(fnv ^ c, 16777619) >>> 0;
    djb = ((Math.imul(djb, 33) + c) | 0) >>> 0;
  }
  return { chars: s.length, lines: s.split("\n").length,
    fnv: fnv.toString(16), djb: djb.toString(16) };
}

const digestLine = (d) => `${d.chars} chars, ${d.lines} lines, fnv=${d.fnv} djb=${d.djb}`;

/** The same arithmetic, as something pasteable after the recipe has been run. */
const DIGEST_SNIPPET = `(function (s) {
  var fnv = 0x811c9dc5 >>> 0, djb = 5381 >>> 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    fnv = Math.imul(fnv ^ c, 16777619) >>> 0;
    djb = ((Math.imul(djb, 33) + c) | 0) >>> 0;
  }
  return s.length + " chars, " + s.split("\\n").length + " lines, fnv="
    + fnv.toString(16) + " djb=" + djb.toString(16);
})(THE_STRING_THE_RECIPE_RETURNED)`;

/** What a browser recorded, or null if nobody has recorded one. */
const recorded = () =>
  (fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n").trimEnd() : null);

module.exports = { RECIPE, runHere, recorded, digestOf, digestLine, FIXTURE, FIXTURE_REL };

// Everything below is the command line. The suite requires this file for
// RECIPE and must not set a tournament going by doing so.
if (require.main !== module) return;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

if (has("--help") || has("-h")) {
  console.log("usage:  npm run agreement [-- --print | --digest | --write]");
  console.log("        (no flag)  run the recipe here and compare with the recorded browser run");
  console.log("        --print    print the snippet to paste into a browser console");
  console.log("        --digest   three short numbers, to compare with a browser by eye");
  console.log("        --write    overwrite the fixture with what Node does — read the warning first");
  process.exit(0);
}

if (has("--digest")) {
  const here = digestOf(runHere());
  const there = recorded();
  console.log(`node:     ${digestLine(here)}`);
  console.log(`recorded: ${there === null ? "(nothing recorded yet)" : digestLine(digestOf(there))}`);
  console.log("");
  console.log("To take the same reading in a browser, run the recipe there");
  console.log("(npm run agreement -- --print), keep what it returned, and then:");
  console.log("");
  console.log(DIGEST_SNIPPET);
  process.exit(0);
}

if (has("--print")) {
  // Nothing but the snippet on stdout, so that `> recipe.js` gives you
  // something you can paste without editing. The instructions go to stderr.
  console.error("── Paste stdout into the console of public/index.html ─────────────");
  console.error("   Any page will do; ?test=1 is convenient, having already loaded");
  console.error("   everything. It takes a minute or so and returns a string.");
  console.error("");
  console.error(`   Save that string — exactly, without the enclosing quotes and`);
  console.error(`   with \\n turned back into real newlines — to`);
  console.error(`   ${FIXTURE_REL}, then run:  npm run agreement`);
  console.error("──────────────────────────────────────────────────────────────────");
  console.log(RECIPE);
  process.exit(0);
}

console.error("running the recipe under Node...");
const mine = runHere();

if (has("--write")) {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, mine.endsWith("\n") ? mine : mine + "\n");
  console.log(`Wrote ${FIXTURE_REL} from THIS run, under Node.`);
  console.log("");
  console.log("Be clear about what that did. The point of this check is that the");
  console.log("browser and Node agree, and a fixture recorded here compares Node");
  console.log("with Node — it will pass whatever the bridge is doing. Use this to");
  console.log("start a fixture off, then replace it with a browser recording");
  console.log("(--print) before trusting a pass. If you have just used it to make");
  console.log("a failure go away, you have deleted the check, not fixed anything.");
  process.exit(0);
}

if (!fs.existsSync(FIXTURE)) {
  console.error(`No recorded browser run at ${FIXTURE_REL}.`);
  console.error("Make one:  npm run agreement -- --print");
  process.exit(2);
}

const theirs = fs.readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n").trimEnd();
const ours = mine.replace(/\r\n/g, "\n").trimEnd();

if (ours === theirs) {
  const lines = ours.split("\n").length;
  console.log(`The browser and Node agree, line for line — ${lines} lines, `
    + `${ours.length.toLocaleString("en-US")} characters.`);
  process.exit(0);
}

/* ── they differ ─────────────────────────────────────────────────────────── */

const a = theirs.split("\n"), b = ours.split("\n");
let i = 0;
while (i < a.length && i < b.length && a[i] === b[i]) i++;

console.error("");
console.error("THE BROWSER AND NODE PLAYED DIFFERENT GAMES.");
console.error("");
console.error(`First difference at line ${i + 1} of ${FIXTURE_REL}:`);
console.error(`  browser: ${a[i] === undefined ? "(end of file)" : a[i]}`);
console.error(`  node:    ${b[i] === undefined ? "(end of output)" : b[i]}`);
console.error("");
console.error(`  ${a.length} lines recorded, ${b.length} produced here.`);
console.error("");
console.error("Do not tune anything against this. In order of likelihood:");
console.error("  - the G bridge is handing ai.js a copy instead of a view, so the");
console.error("    search is mutating one game and reading another. tools/bootstrap.js");
console.error("    proves both halves of that on load, so check that it still does.");
console.error("  - something in ai.js has gone back to Math.random or to the wall");
console.error("    clock. Two runs in a row HERE would then differ too — check that");
console.error("    first, it takes a minute and it tells you which half is wrong.");
console.error("  - the recipe or aiPlayGame changed and the fixture is simply stale.");
console.error("    Re-record it from a browser (--print), not from here.");
process.exit(1);
