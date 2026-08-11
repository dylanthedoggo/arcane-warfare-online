/* ══════════════════════════════════════════════════════════════════════════
   THE MACHINE, UNDER NODE

   public/ai.js is written for a browser and stays that way. This file is the
   one place that knows how to run it anywhere else, and it exists so that the
   strangeness lives somewhere marked strange rather than being spread through a
   file with two audiences.

   Requiring it gives you the machine on a terminal:

       const { engine, ai } = require("./tools/bootstrap.js");
       ai.aiTournament("ruthless", "novice", 20);

   ── WHY THIS IS NOT JUST AN EXPORT LINE ───────────────────────────────────

   In the browser, every <script> on the page shares one lexical scope. When
   ai.js writes G.board[i] it is reading the same live variable engine.js
   declared. Node does not work that way: each file is sealed, and require()
   hands back the values as they were at the moment of import. ai.js mentions G
   several hundred times, and under a naive port every one of them would read a
   game frozen at import while the search mutated the real one somewhere out of
   sight. It would not crash. It would quietly play nonsense, which is worse.

   So G is defined below as an ACCESSOR — a property backed by a pair of
   functions rather than a stored value. Reading it calls engine.getG(), which
   re-asks the engine every single time; writing it calls engine.setG(). That is
   the whole trick, and both halves of it are load-bearing:

       getter only   ->  `G = newGame(...)` is DISCARDED, silently, because
                         ai.js is evaluated in sloppy mode exactly as a script
                         tag is, and sloppy mode does not throw on a write to a
                         getter-only property. Self-play would then run against
                         whatever game happened to be loaded and produce
                         entirely plausible numbers about the wrong board.
       getter+setter ->  the engine receives the new game.

   aiPlayGame opens every game with exactly that assignment, so the read-only
   version of this accessor — the obvious first thing to write — reintroduces
   the frozen-G bug inside the mechanism built to kill it. proveBridge() below
   tests both halves, separately, and is run every time this file is required.

   ── HOW ai.js IS LOADED ───────────────────────────────────────────────────

   With vm.runInThisContext, which evaluates it against this realm's global
   scope, mimicking a script tag. The alternative was an export footer on ai.js
   plus a require, which is more conventional but means edits inside ai.js and a
   second way of resolving names for a reader to hold in their head alongside
   the browser way. ai.js is a single-audience file and this keeps it one.

   One consequence worth knowing: a script's top-level `let`/`const` become
   global LEXICAL bindings, not properties of globalThis. So `AI` and
   `AI_LEVELS` cannot be read off globalThis after loading — they are pulled out
   by evaluating an expression in the same scope. Function declarations do
   become properties, which is why most of `ai` below is a plain pick.
   ══════════════════════════════════════════════════════════════════════════ */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const AI_PATH = path.join(ROOT, "public", "ai.js");

const engine = require(path.join(ROOT, "public", "engine.js"));

/* ══════════════════════════════════════════════════════════════════════════
   THE SEAM CHECK

   ai.js carries a pair of banner comments around the band that is inherently
   the web page. Everything outside them is meant to run in both places, and the
   stand-ins further down make sure that the inside band does not stop this file
   loading. The danger is the other direction: a render() added to the thinking
   half would keep working here, because the stand-in does nothing, and the two
   copies of the machine would quietly stop agreeing.

   So the page names are checked against the banners before ai.js is loaded at
   all. This is a text scan and it knows nothing about scope — it is a smoke
   alarm, not a type system — but it fails loudly, at the moment the seam moves,
   which is the property a line number written down in a document never had.
   ══════════════════════════════════════════════════════════════════════════ */

const SEAM_OPEN = "SEAM: BROWSER-ONLY BEGINS";
const SEAM_CLOSE = "SEAM: BROWSER-ONLY ENDS";

/**
 * Names that only mean something with a screen. Each is given a stand-in below;
 * none of them may appear outside the seam except where this says so.
 *
 * The allowlist is deliberately specific about WHY, because a vague entry is
 * how a list like this stops meaning anything. `render` is the interesting one:
 * aiRender guards it behind `!AI.fast`, and self-play always sets fast — but
 * the reference is there in the text, above the seam, so it is named here
 * rather than quietly tolerated.
 */
const PAGE_NAMES = {
  render: "aiRender's guarded call, above the seam",
  UI: "aiPlayGame resets it at the start of each headless game",
  freshUI: "the same line",
  endTurnLocal: "aiRunTurn and aiRandomTurn both end turns with it",
  FX: null,
  NET: null,
  clearSelection: null,
  announceWinner: null,
  toast: null,
  raiseCurtain: null,
};

/**
 * Blank out comments and string literals, so a name in prose is not mistaken
 * for a use of it. Every character is replaced by a space and every newline
 * kept, so the result is the same LENGTH as the original — offsets into it are
 * offsets into the file, which is what lets the seam test and the reported line
 * numbers mean anything.
 */
function codeOnly(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, blank);
}

function checkSeam(src) {
  const open = src.indexOf(SEAM_OPEN);
  const close = src.indexOf(SEAM_CLOSE);
  if (open < 0 || close < 0)
    throw new Error(
      `bootstrap: public/ai.js is missing a seam banner (${SEAM_OPEN} / ${SEAM_CLOSE}). `
      + "Whoever removed it also removed the only check that the browser-only band "
      + "is still where this file thinks it is.");
  if (close < open)
    throw new Error("bootstrap: the seam banners in public/ai.js are the wrong way round.");

  // Line numbers so a failure points somewhere, computed off the original text.
  const lineOf = (idx) => src.slice(0, idx).split("\n").length;
  const openLine = lineOf(open), closeLine = lineOf(close);

  const bare = codeOnly(src);
  const inSeam = (idx) => idx > open && idx < close;
  const strays = [];
  for (const [name, allowed] of Object.entries(PAGE_NAMES)) {
    const re = new RegExp(`\\b${name}\\b`, "g");
    let m;
    while ((m = re.exec(bare)) !== null) {
      if (inSeam(m.index) || allowed) continue;
      strays.push(`${name} at ai.js:${lineOf(m.index)}`);
    }
  }
  if (strays.length)
    throw new Error(
      "bootstrap: public/ai.js uses a page-only name outside the browser-only seam:\n"
      + strays.map((s) => `    ${s}`).join("\n")
      + "\n  Under Node that call reaches a stand-in that does nothing, so it would have"
      + "\n  worked here and behaved differently in the browser. Either move it inside the"
      + "\n  seam, or add the name to PAGE_NAMES in tools/bootstrap.js with its reason.");

  return { openLine, closeLine, browserOnlyLines: closeLine - openLine };
}

/* ══════════════════════════════════════════════════════════════════════════
   THE GLOBAL SCOPE ai.js EXPECTS
   ══════════════════════════════════════════════════════════════════════════ */

// 1. G, live in both directions. Everything else about this file is ordinary.
Object.defineProperty(globalThis, "G", {
  get: () => engine.getG(),
  set: (v) => engine.setG(v),
  configurable: true,
  enumerable: true,
});

// 2. The rest of the engine, as plain values. setG/getG stay reachable by name
//    for anything that would rather be explicit than go through the accessor.
for (const [name, value] of Object.entries(engine)) {
  if (name === "G") continue;
  globalThis[name] = value;
}

/* ── the page stand-ins ─────────────────────────────────────────────────────
   Every one of these is a PRESENTATION concern, and that is the test that says
   faking them is honest rather than convenient: none of them can change what is
   legal or what the search decides. If one of them ever needed real logic to
   make self-play behave, the finding would not be "the stand-in is too simple",
   it would be "a game rule has leaked into the web page" — worth knowing, and
   worth stopping to fix.

   pieceLabel is the case where that test was applied and came back the other
   way. It reads like a presentation function; it is engine code, index.html has
   no copy of it, and a "minimal text version for Node" would have forked a
   piece of the engine into a second implementation that drifts. It is exported
   from engine.js instead, and is not on this list.

   They count their calls. The seam check above is static and can only see the
   text; the tally is what a run can actually show you, and self-play prints it.
   ─────────────────────────────────────────────────────────────────────────── */

const standInCalls = Object.create(null);
const noted = (name, fn) => (...args) => {
  standInCalls[name] = (standInCalls[name] || 0) + 1;
  return fn(...args);
};

/** The headless turn-ender. index.html's is `endTurn(); render(); afterHandoff()`
 *  — and with no screen, render and the pass-the-device curtain are both
 *  nothing, so what is left is the first third of it. */
globalThis.endTurnLocal = noted("endTurnLocal", () => engine.endTurn());

globalThis.render = noted("render", () => {});
globalThis.clearSelection = noted("clearSelection", () => {});
globalThis.toast = noted("toast", () => {});
globalThis.announceWinner = noted("announceWinner", () => {});
globalThis.raiseCurtain = noted("raiseCurtain", () => {});

/** Effects. `busyMs` is how long to wait for an animation — nothing is playing,
 *  so nothing to wait for — and `then` runs its callback immediately. */
globalThis.FX = {
  busyMs: noted("FX.busyMs", () => 0),
  then: noted("FX.then", (f) => f()),
};

/** No socket. The interface reads `on` to decide whether the server owns the
 *  game; here nothing does. */
globalThis.NET = { on: false };

/** Interface state. Only the two fields the machine touches are real; the rest
 *  of index.html's freshUI is about selection and modals, which need a mouse. */
globalThis.freshUI = noted("freshUI", () => ({ targeting: null, revealed: true }));
globalThis.UI = globalThis.freshUI();

/* ══════════════════════════════════════════════════════════════════════════
   LOAD
   ══════════════════════════════════════════════════════════════════════════ */

const src = fs.readFileSync(AI_PATH, "utf8");
const seam = checkSeam(src);

// The filename is what keeps stack traces readable — without it a throw inside
// the search reports "evalmachine.<anonymous>" and the line number of nothing.
vm.runInThisContext(src, { filename: AI_PATH });

/**
 * Pull the top-level `let`/`const` bindings out of the scope ai.js was loaded
 * into. They are global lexical bindings, not properties of globalThis, so
 * there is no other way to reach them from module code by name.
 */
const read = (expr) => vm.runInThisContext(`(${expr})`, { filename: "bootstrap:read" });

const ai = {
  // mutated in place and never reassigned, so one reference is enough
  AI: read("AI"),
  AI_LEVELS: read("AI_LEVELS"),
  // the whole turn, synchronously — the headless entry point
  aiRunTurn: globalThis.aiRunTurn,
  searchBestMove: globalThis.searchBestMove,
  aiRandomTurn: globalThis.aiRandomTurn,
  aiPlayGame: globalThis.aiPlayGame,
  aiTournament: globalThis.aiTournament,
  aiCancel: globalThis.aiCancel,
  // a `let` that climbs during play, so it has to be re-read rather than held
  abandoned: () => read("AI_ABANDONED"),
};

/* ══════════════════════════════════════════════════════════════════════════
   THE PROOF

   Two assertions, because the read half and the write half of the accessor
   break independently and only the second catches the silent discard described
   at the top. Run on every require: this costs a millisecond, it is the one
   thing in the port that fails quietly if it is wrong, and a proof kept in a
   file nobody runs is not a proof.
   ══════════════════════════════════════════════════════════════════════════ */

function proveBridge() {
  const fail = (msg) => {
    throw new Error(
      `bootstrap: the G bridge is broken — ${msg}\n`
      + "  Do not run self-play against this. Every number it produced would be "
      + "about a board\n  the search was not looking at. See tools/bootstrap.js.");
  };

  // 1. The getter is live: a change made through the engine must be visible
  //    through the bare name.
  engine.setG(engine.newGame(0, 4242, { mode: "ai" }));
  engine.beginTurn(0);
  const before = globalThis.G.turn;
  engine.endTurn();
  if (globalThis.G.turn === before)
    fail(`G is a snapshot, not a view — turn stayed ${before} across an endTurn()`);

  // 2. The setter reaches the engine. This is the one that catches sloppy
  //    mode throwing an assignment away, and it has to be done the way ai.js
  //    does it — by assigning to the bare name — or it proves nothing.
  vm.runInThisContext('G = newGame(0, 4242, { mode: "ai" });', { filename: "bootstrap:prove" });
  if (engine.getG().seed !== 4242)
    fail(`an assignment to G never arrived — the engine still holds seed ${engine.getG().seed}`);

  engine.setG(null);
}

proveBridge();

module.exports = {
  engine, ai, read, proveBridge, standInCalls, seam, ROOT,
  AI_PATH,
  // exported so the suite can hand it a doctored file and check that it
  // objects — a guard nobody has watched fail is a guard nobody should trust
  checkSeam, SEAM_OPEN, SEAM_CLOSE,
};
