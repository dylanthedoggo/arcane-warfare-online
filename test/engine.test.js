"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   CHEAT-REJECTION SUITE

   Run at build time by `npm test`; a failure here fails the deploy instead of
   shipping a referee that can be talked into things.

   What this file is for. The browser copy of the game is a rendering — a
   player can open the console and edit it freely. The only thing standing
   between that and a ruined game is applyAction() refusing what it is sent.
   So every test below plays the part of a tampered client: it calls
   applyAction directly with the kind of object an edited page would emit, and
   asserts the referee says no AND that the game is unchanged afterwards.

   A refusal that still moves a piece is worse than no refusal at all, so the
   rollback group matters as much as the individual rejections.

   These tests never touch the network. applyAction is the whole doorway —
   server.js adds seating, rate limiting and redaction on top, but nothing that
   can make an illegal action legal.

   The rules themselves are covered separately, in the browser, by
   public/index.html?test=1. This file is only about refusal.
   ══════════════════════════════════════════════════════════════════════════ */

const engine = require("../public/engine.js");
const {
  FORMS, SPELL_IDS,
  rc, isDark,
  newGame, beginTurn, log, applyAction, viewFor, setG, getG,
  legalMovesFor,
} = engine;

/* ── a very small harness ─────────────────────────────────────────────────
   No framework: a build step should not need one, and `node test/...` has to
   work on a bare Render container.
   ─────────────────────────────────────────────────────────────────────── */

let passed = 0;
const failures = [];
let group = "";

const describe = (name) => { group = name; console.log(`\n  ${name}`); };

function it(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ok   ${name}`);
  } catch (e) {
    failures.push({ group, name, message: e.message });
    console.log(`    FAIL ${name}\n         ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function equal(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(`${msg || "values differ"}\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
}

/** The referee refused, and said why. */
function refused(res, because) {
  assert(res && res.ok === false,
    `expected a refusal, got ${JSON.stringify(res)}`);
  assert(typeof res.err === "string" && res.err.length > 0,
    "a refusal must carry a reason for the player");
  if (because)
    assert(res.err.includes(because),
      `refusal reason should mention "${because}"\n         actual: "${res.err}"`);
  return res;
}

const allowed = (res) => {
  assert(res && res.ok === true, `expected the action to stand, got ${JSON.stringify(res)}`);
  return res;
};

/* ── fixtures ─────────────────────────────────────────────────────────────
   A fixed seed keeps the deck order identical run to run, so a failure here
   is always reproducible. Boot exactly the way server.js does in "create",
   including the turnNo=0 dance, so the state under test is the state a real
   room holds.
   ─────────────────────────────────────────────────────────────────────── */

const SEED = 20260807;

function freshGame() {
  const g = newGame(0, SEED);        // seat 0 is Gold, and Gold opens
  setG(g);
  g.turnNo = 0;
  log("test game", "sys");
  beginTurn(0);
  return getG();
}

/** Install a game as the engine's current one and hand it back. */
function load(g) { setG(g); return g; }

/** The parts of the state a cheat would be trying to change. */
function fingerprint(g) {
  return JSON.stringify({
    board: g.board.map((p) => (p ? `${p.owner}:${p.form}:${p.id}` : null)),
    turn: g.turn,
    turnNo: g.turnNo,
    phase: g.phase,
    hasActed: g.hasActed,
    over: g.over,
    fp: [g.players[0].fp, g.players[1].fp],
    hands: [g.players[0].hand.slice(), g.players[1].hand.slice()],
    deckSize: g.deck.length,
  });
}

/** Any square holding a piece owned by `seat`. */
function anyPieceOf(g, seat) {
  const i = g.board.findIndex((p) => p && p.owner === seat);
  assert(i >= 0, `the opening position should contain a piece for seat ${seat}`);
  return i;
}

/** A square with a piece of `seat`'s that has at least one legal move. */
function movablePieceOf(g, seat) {
  load(g);
  for (let i = 0; i < g.board.length; i++) {
    const p = g.board[i];
    if (!p || p.owner !== seat) continue;
    const moves = legalMovesFor(i);
    if (moves && moves.length) return { from: i, move: moves[0] };
  }
  throw new Error(`seat ${seat} should have a legal opening move`);
}

const emptySquare = (g) => {
  const i = g.board.findIndex((p, k) => !p && isDark(k));
  assert(i >= 0, "the opening position should have an empty dark square");
  return i;
};

/* ══════════════════════════════════════════════════════════════════════════
   1. THE DOORWAY ITSELF

   Before any rule is consulted, applyAction has to survive being handed
   garbage. A socket delivers whatever the sender typed.
   ══════════════════════════════════════════════════════════════════════════ */

describe("the doorway rejects malformed input");

it("refuses a seat that is not 0 or 1", () => {
  const g = freshGame();
  for (const seat of [2, -1, 1.5, "0", null, undefined, {}])
    refused(applyAction(seat, { t: "endTurn" }), "Not a seat");
  equal(fingerprint(getG()), fingerprint(g), "a bad seat must not change the game");
});

it("refuses a missing or non-object action", () => {
  freshGame();
  for (const a of [null, undefined, 42, "endTurn", [], true])
    refused(applyAction(0, a), "Malformed action");
});

it("refuses an action with no type", () => {
  freshGame();
  for (const a of [{}, { t: 7 }, { t: null }, { from: 1, to: 2 }])
    refused(applyAction(0, a), "Malformed action");
});

it("refuses an action type that does not exist", () => {
  freshGame();
  const res = refused(applyAction(0, { t: "winTheGame" }));
  assert(res.err.includes("winTheGame"), "the refusal should name the unknown action");
});

it("does not crash on an action carrying junk fields", () => {
  const g = freshGame();
  refused(applyAction(0, { t: "move", from: {}, to: [], kind: 999, extra: "ignored" }));
  equal(fingerprint(getG()), fingerprint(g), "junk fields must not change the game");
});

/* ══════════════════════════════════════════════════════════════════════════
   2. TURN ORDER

   The seat is decided by the server from the socket, never read off the
   action — so the interesting cheat is acting out of turn, not lying about
   who you are.
   ══════════════════════════════════════════════════════════════════════════ */

describe("turn order is enforced");

it("refuses to let the waiting player move", () => {
  const g = freshGame();
  equal(g.turn, 0, "Gold opens");
  const { from, move } = movablePieceOf(g, 1);
  refused(applyAction(1, { t: "move", from, to: move.to, kind: move.kind }), "not your turn");
});

it("refuses to let the waiting player end the turn", () => {
  freshGame();
  refused(applyAction(1, { t: "endTurn" }), "not your turn");
});

it("refuses to let the waiting player draw", () => {
  freshGame();
  refused(applyAction(1, { t: "draw" }), "not your turn");
});

it("hands the turn over after a draw, and will not draw twice", () => {
  const g = freshGame();
  allowed(applyAction(0, { t: "draw" }));
  equal(getG().turn, 1, "drawing spends the whole turn");
  refused(applyAction(0, { t: "draw" }), "not your turn");
});

it("refuses a second action once the mover has acted", () => {
  const g = freshGame();
  const { from, move } = movablePieceOf(g, 0);
  allowed(applyAction(0, { t: "move", from, to: move.to, kind: move.kind }));
  const again = movablePieceOf(getG(), 0);
  refused(applyAction(0, { t: "move", from: again.from, to: again.move.to, kind: again.move.kind }));
});

/* ══════════════════════════════════════════════════════════════════════════
   3. MOVING PIECES YOU DO NOT OWN, OR THAT DO NOT EXIST

   This is the console cheat from DEPLOY.md: `G.board[45] = G.board[97]`, then
   move the piece you just invented. The server never read that board.
   ══════════════════════════════════════════════════════════════════════════ */

describe("pieces cannot be invented or borrowed");

it("refuses to move from an empty square", () => {
  const g = freshGame();
  const empty = emptySquare(g);
  refused(applyAction(0, { t: "move", from: empty, to: empty + 13, kind: "step" }),
    "no piece on that square");
});

it("refuses to move a piece belonging to the opponent", () => {
  const g = freshGame();
  const theirs = anyPieceOf(g, 1);
  const res = refused(applyAction(0, { t: "move", from: theirs, to: theirs + 13, kind: "step" }));
  assert(/not your piece|not a legal move/i.test(res.err),
    `expected an ownership or legality refusal, got "${res.err}"`);
});

it("refuses a move to a square off the board", () => {
  const g = freshGame();
  const { from } = movablePieceOf(g, 0);
  for (const to of [-1, 144, 9999, 1.5, NaN, "44"])
    refused(applyAction(0, { t: "move", from, to, kind: "step" }));
});

it("refuses a teleport across the board", () => {
  const g = freshGame();
  const { from } = movablePieceOf(g, 0);
  const empty = emptySquare(g);
  refused(applyAction(0, { t: "move", from, to: empty, kind: "step" }), "not a legal move");
});

it("refuses a move onto one of your own pieces", () => {
  const g = freshGame();
  const from = movablePieceOf(g, 0).from;
  const ownOther = g.board.findIndex((p, k) => p && p.owner === 0 && k !== from);
  refused(applyAction(0, { t: "move", from, to: ownOther, kind: "step" }), "not a legal move");
});

it("refuses a capture that is claimed but not available", () => {
  const g = freshGame();
  const { from, move } = movablePieceOf(g, 0);
  // Same destination, relabelled as a jump. There is nothing to jump on turn 1.
  refused(applyAction(0, { t: "move", from, to: move.to, kind: "capture" }), "not a legal move");
});

/* ══════════════════════════════════════════════════════════════════════════
   4. SPELLS

   The other console cheat from DEPLOY.md: `G.players[G.turn].fp = 99`, then
   cast something expensive. Focus Points live on the server; the edited number
   never crosses the wire, and the card is not in the server's copy of the hand.
   ══════════════════════════════════════════════════════════════════════════ */

describe("spells cannot be conjured");

it("refuses a spell id that does not exist", () => {
  freshGame();
  for (const id of ["instantWin", "", null, 42, undefined])
    refused(applyAction(0, { t: "cast", id }), "No such spell");
});

/* Inherited Object properties are truthy on any plain-object lookup, so
   `SPELLS["__proto__"]` finds Object.prototype and walks past the "No such
   spell" guard. Nothing is castable — the hand check behind it still refuses —
   but the guard is weaker than it reads, so pin the behaviour here. If the
   membership test is ever hardened (Object.hasOwn), this test should keep
   passing and the reason will simply become the better one. */
it("refuses inherited Object properties dressed up as spell ids", () => {
  const g = freshGame();
  const before = fingerprint(g);
  for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    refused(applyAction(0, { t: "cast", id }));
    equal(fingerprint(getG()), before, `casting "${id}" must change nothing`);
  }
});

it("refuses a real spell that is not in your hand", () => {
  const g = freshGame();
  equal(g.players[0].hand.length, 0, "a new game deals no opening hand");
  const res = refused(applyAction(0, { t: "cast", id: SPELL_IDS[0] }));
  assert(res.err.length > 0, "the refusal should explain itself");
});

it("ignores Focus Points asserted by the client", () => {
  const g = freshGame();
  const before = g.players[0].fp;
  // A tampered client sends its inflated numbers along with the action.
  refused(applyAction(0, { t: "cast", id: SPELL_IDS[0], fp: 99, cost: 0, payload: { fp: 99 } }));
  equal(getG().players[0].fp, before, "the server's Focus Point count is the only one that counts");
});

it("refuses a spell held by the opponent rather than by you", () => {
  const g = freshGame();
  const id = SPELL_IDS[0];
  g.players[1].hand.push(id);          // the other seat holds it
  load(g);
  refused(applyAction(0, { t: "cast", id }));
});

it("refuses a discard when none is owed", () => {
  freshGame();
  refused(applyAction(0, { t: "discard", id: SPELL_IDS[0] }), "No discard is owed");
});

/* ══════════════════════════════════════════════════════════════════════════
   5. TRANSFORMATIONS
   ══════════════════════════════════════════════════════════════════════════ */

describe("transformations are checked");

it("refuses a form that does not exist", () => {
  const g = freshGame();
  const mine = anyPieceOf(g, 0);
  refused(applyAction(0, { t: "transform", i: mine, form: "godking" }), "No such transformation");
});

it("refuses a form that is only reachable through its spell", () => {
  const g = freshGame();
  const mine = anyPieceOf(g, 0);
  const viaSpell = Object.keys(FORMS).find((f) => FORMS[f].viaSpell);
  assert(viaSpell, "at least one form should be spell-only");
  refused(applyAction(0, { t: "transform", i: mine, form: viaSpell }), "only reached through its spell");
});

it("refuses transforming a piece that is not yours", () => {
  const g = freshGame();
  const theirs = anyPieceOf(g, 1);
  const form = Object.keys(FORMS).find((f) => !FORMS[f].viaSpell);
  refused(applyAction(0, { t: "transform", i: theirs, form }), "not your piece");
});

it("refuses transforming an empty square", () => {
  const g = freshGame();
  const form = Object.keys(FORMS).find((f) => !FORMS[f].viaSpell);
  refused(applyAction(0, { t: "transform", i: emptySquare(g), form }), "no piece on that square");
});

it("refuses a transformation whose sacrifice was not paid", () => {
  const g = freshGame();
  const mine = anyPieceOf(g, 0);
  // Name a sacrifice square that holds nothing of yours to give.
  refused(applyAction(0, { t: "transform", i: mine, form: "juggernaut", choices: { sacrifice: emptySquare(g) } }));
});

/* ══════════════════════════════════════════════════════════════════════════
   6. OBLIGATIONS THAT WERE NEVER INCURRED

   Each of these actions resolves a debt the game can owe a player. Claiming
   one that was never owed is a way to act out of turn.
   ══════════════════════════════════════════════════════════════════════════ */

describe("unowed obligations cannot be claimed");

it("refuses a sacrifice when none is owed", () => {
  const g = freshGame();
  refused(applyAction(0, { t: "sacrifice", i: anyPieceOf(g, 0) }), "No sacrifice is owed");
});

it("refuses a Herald skip when no bonus step is owed", () => {
  freshGame();
  refused(applyAction(0, { t: "heraldSkip" }), "No Herald bonus step is owed");
});

it("refuses a mind-control move when nothing is seized", () => {
  const g = freshGame();
  const theirs = anyPieceOf(g, 1);
  refused(applyAction(0, { t: "mindMove", from: theirs, to: theirs + 13 }), "No piece is under your control");
});

/* ══════════════════════════════════════════════════════════════════════════
   7. A FINISHED GAME STAYS FINISHED
   ══════════════════════════════════════════════════════════════════════════ */

describe("a finished game accepts nothing further");

it("records a resignation against the resigning seat", () => {
  const g = freshGame();
  allowed(applyAction(0, { t: "resign" }));
  const now = getG();
  assert(now.over, "resigning should end the game");
  equal(now.over.winner, 1, "the other seat wins");
});

it("refuses every action once the game is over", () => {
  const g = freshGame();
  allowed(applyAction(0, { t: "resign" }));
  const after = fingerprint(getG());
  const mine = anyPieceOf(getG(), 0);

  refused(applyAction(1, { t: "move", from: anyPieceOf(getG(), 1), to: mine, kind: "capture" }));
  refused(applyAction(0, { t: "draw" }));
  refused(applyAction(0, { t: "endTurn" }));
  refused(applyAction(0, { t: "cast", id: SPELL_IDS[0] }));
  refused(applyAction(0, { t: "heraldSkip" }), "game is over");
  refused(applyAction(0, { t: "resign" }), "already over");

  equal(fingerprint(getG()), after, "nothing may change after the game ends");
});

/* ══════════════════════════════════════════════════════════════════════════
   8. ROLLBACK

   The one that matters most. applyAction snapshots before dispatching and
   restores on refusal — if that ever regresses, a rejected action could leave
   a piece half-moved or a card half-spent, and the refusal message would be
   a lie. Everything above proves the referee says no; this proves that saying
   no costs the game nothing.
   ══════════════════════════════════════════════════════════════════════════ */

describe("a refused action leaves the game untouched");

it("survives a barrage of illegal actions with the position intact", () => {
  const g = freshGame();
  const before = fingerprint(g);
  const mine = anyPieceOf(g, 0);
  const theirs = anyPieceOf(g, 1);
  const empty = emptySquare(g);

  const attempts = [
    { t: "move", from: theirs, to: empty, kind: "step" },
    { t: "move", from: empty, to: mine, kind: "capture" },
    { t: "move", from: mine, to: 9999, kind: "step" },
    { t: "cast", id: SPELL_IDS[0] },
    { t: "cast", id: "instantWin" },
    { t: "transform", i: theirs, form: "juggernaut" },
    { t: "transform", i: mine, form: "godking" },
    { t: "sacrifice", i: mine },
    { t: "discard", id: SPELL_IDS[0] },
    { t: "heraldSkip" },
    { t: "mindMove", from: theirs, to: empty },
    { t: "nonsense" },
    {},
  ];

  for (const a of attempts) {
    refused(applyAction(0, a));
    equal(fingerprint(getG()), before, `"${a.t}" was refused but still changed the game`);
  }
});

it("does not consume the turn when an action is refused", () => {
  const g = freshGame();
  refused(applyAction(0, { t: "move", from: emptySquare(g), to: 0, kind: "step" }));
  equal(getG().turn, 0, "the mover keeps the turn after a refusal");
  equal(getG().hasActed, false, "a refused action is not an action");

  // And the legal move that follows still works.
  const { from, move } = movablePieceOf(getG(), 0);
  allowed(applyAction(0, { t: "move", from, to: move.to, kind: move.kind }));
});

/* ══════════════════════════════════════════════════════════════════════════
   9. WHAT CROSSES THE WIRE

   Refusing illegal actions is only half the referee's job. The other half is
   not handing a player information they could use to play perfectly — the
   opponent's hand and the order of the draw pile. viewFor() is the only thing
   server.js ever serialises, so this is the whole disclosure surface.
   ══════════════════════════════════════════════════════════════════════════ */

describe("the view hides what a seat may not know");

it("masks the opponent's hand while showing its size", () => {
  const g = freshGame();
  g.players[0].hand = ["evasive", "chronos"];
  g.players[1].hand = ["mirror", "veil", "cascade"];

  const view = viewFor(g, 0, {});
  assert(view.players[0].hand.every((c) => c !== "?"), "you can see your own cards");
  equal(view.players[0].hand.join(","), "evasive,chronos", "your own hand comes through intact");
  assert(view.players[1].hand.every((c) => c === "?"), "the opponent's cards are masked");
  equal(view.players[1].hand.length, 3, "the SIZE of the opponent's hand is public");
});

it("masks the hand of whichever seat is looking", () => {
  const g = freshGame();
  g.players[0].hand = ["evasive"];
  g.players[1].hand = ["mirror"];
  const view = viewFor(g, 1, {});
  assert(view.players[0].hand.every((c) => c === "?"), "seat 1 must not read seat 0's hand");
  equal(view.players[1].hand[0], "mirror", "seat 1 sees its own");
});

it("hides the order of the draw pile", () => {
  const g = freshGame();
  const view = viewFor(g, 0, {});
  equal(view.deck.length, g.deck.length, "the deck's size is public");
  assert(view.deck.every((c) => c === "?"), "the deck's order is not");
});

it("strips the history snapshots but keeps their shape", () => {
  const g = freshGame();
  const view = viewFor(g, 0, {});
  assert(Array.isArray(view.history), "the view should still describe the past");
  for (const h of view.history) {
    assert(!("snap" in h), "a snapshot would hand over both hands and the deck order");
    assert(typeof h.turn === "number" && typeof h.turnNo === "number",
      "the stubs Chronos's Gaze needs must survive");
  }
});

it("tells each seat which one it is", () => {
  const g = freshGame();
  equal(viewFor(g, 0, {}).youAre, 0);
  equal(viewFor(g, 1, {}).youAre, 1);
});

it("does not hand back the live state object", () => {
  const g = freshGame();
  const view = viewFor(g, 0, {});
  assert(view !== g, "the view must be a copy");
  assert(view.board !== g.board, "editing a view must not edit the game");
  view.players[0].fp = 99;
  assert(g.players[0].fp !== 99, "the view is not a window onto the real state");
});

/* ── report ───────────────────────────────────────────────────────────── */

console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.log(`  ${f.group} — ${f.name}\n    ${f.message}\n`);
  console.log("The referee is not refusing something it should. Deploy stopped.\n");
  process.exit(1);
}
console.log(`✓ ${passed} cheat-rejection checks passed\n`);
