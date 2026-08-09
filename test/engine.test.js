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
  FORMS, SPELLS, SPELL_IDS, SECRET_PIECE_FIELDS,
  rc, isDark,
  newGame, beginTurn, log, applyAction, viewFor, setG, getG,
  legalMovesFor, captureMoves, capturersFor,
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
    pool: JSON.stringify(g.drawCounts) + "|" + g.removed.slice().sort().join(",") + "|" + g.setAside.slice().sort().join(","),
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

/**
 * A game whose opening seat can still afford a transformation. The referee
 * auto-passes a turn once nothing but "End Turn" remains, so a test that wants
 * to prove an action is refused for its own reason has to leave the seat
 * something else it could have done. Transformations are cast like any other
 * spell now, so this also has to leave a card in hand — the full spell list,
 * so some transformation is affordable no matter which piece the test moves.
 */
function solventGame() {
  const g = freshGame();
  g.players[0].fp = 8;
  g.players[1].fp = 8;
  g.players[0].hand = SPELL_IDS.slice();
  g.players[1].hand = SPELL_IDS.slice();
  return g;
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

it("refuses the old direct-transform action entirely — every form now requires its spell", () => {
  const g = freshGame();
  assert(Object.keys(FORMS).every((f) => FORMS[f].viaSpell), "every form should now be spell-only");
  const mine = anyPieceOf(g, 0);
  refused(applyAction(0, { t: "transform", i: mine, form: "sentinel" }));
});

it("refuses a transformation cast for a piece that is not yours", () => {
  const g = solventGame();
  g.players[0].hand = ["juggernautSpell"];
  load(g);
  const theirs = anyPieceOf(g, 1);
  refused(applyAction(0, { t: "cast", id: "juggernautSpell", payload: { target: theirs, sacrifice: emptySquare(g) } }));
});

it("refuses a transformation cast for an empty square", () => {
  const g = solventGame();
  g.players[0].hand = ["sentinelSpell"];
  load(g);
  refused(applyAction(0, { t: "cast", id: "sentinelSpell", payload: { target: emptySquare(g) } }));
});

it("refuses a transformation whose sacrifice was not paid", () => {
  const g = solventGame();
  g.players[0].hand = ["juggernautSpell"];
  load(g);
  const mine = anyPieceOf(g, 0);
  // Name a sacrifice square that holds nothing of yours to give.
  refused(applyAction(0, { t: "cast", id: "juggernautSpell", payload: { target: mine, sacrifice: emptySquare(g) } }));
});

/* The board-altering cards validate squares rather than pieces, which is a
   different shape of lie: not "that is not yours" but "that is not a square you
   may name". Chokepoint is the interesting one — the engine picks its own
   target, so there is deliberately nothing on the wire to tamper with. */

it("refuses a rift that is not two distinct empty dark squares", () => {
  const g = solventGame();
  g.players[0].hand = ["rift"];
  load(g);
  const occupied = anyPieceOf(g, 0);
  const empty = emptySquare(g);
  refused(applyAction(0, { t: "cast", id: "rift", payload: { a: occupied, b: empty } }));
  refused(applyAction(0, { t: "cast", id: "rift", payload: { a: empty, b: empty } }),
    "two different squares");
  refused(applyAction(0, { t: "cast", id: "rift", payload: { a: empty, b: 9999 } }));
});

it("refuses an Echo on a piece with nowhere to return to", () => {
  const g = solventGame();
  g.players[0].hand = ["echo"];
  load(g);
  // A brand-new game has no 3-turns-ago for anything.
  refused(applyAction(0, { t: "cast", id: "echo", payload: { target: anyPieceOf(g, 0) } }));
});

it("does not let a client choose Chokepoint's square", () => {
  const g = solventGame();
  g.players[0].hand = ["chokepoint"];
  load(g);
  const before = getG().barriers.slice();
  const mine = anyPieceOf(g, 0);
  // Name a square of our own choosing; the engine must ignore it entirely.
  const res = applyAction(0, { t: "cast", id: "chokepoint", payload: { target: mine } });
  if (res.ok) {
    const now = getG().barriers;
    equal(now.length, before.length + 1, "exactly one square is sealed");
    assert(now[now.length - 1] !== mine, "the client's square must not be the one sealed");
    assert(!getG().board[now[now.length - 1]], "a barrier never lands on an occupied square");
  }
});

it("refuses a transformation spell that is not in your hand", () => {
  const g = solventGame();
  g.players[0].hand = [];
  load(g);
  const mine = anyPieceOf(g, 0);
  refused(applyAction(0, { t: "cast", id: "sentinelSpell", payload: { target: mine } }), "Not in your hand");
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
    { t: "cast", id: "juggernautSpell", payload: { target: theirs, sacrifice: mine } },
    { t: "transform", i: mine, form: "sentinel" },
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
   8b. A STUTTERED TURN CANNOT SIMPLY BE TAKEN AGAIN

   Stutter's whole effect is a refusal, which puts it squarely in this file.
   The rewind itself is a rule and is tested in the browser; what matters here
   is that a client which has just watched its turn evaporate cannot send the
   identical action back down the wire and have it stand.
   ══════════════════════════════════════════════════════════════════════════ */

describe("a stuttered turn cannot simply be taken again");

/** A piece of `seat`'s with at least two legal moves, and both of them. */
function twoMovesFor(g, seat) {
  load(g);
  for (let i = 0; i < g.board.length; i++) {
    const p = g.board[i];
    if (!p || p.owner !== seat) continue;
    const ms = legalMovesFor(i);
    if (ms.length >= 2) return { from: i, a: ms[0], b: ms[1] };
  }
  throw new Error(`seat ${seat} should have a piece with two opening moves`);
}

it("refuses the exact move that was unmade", () => {
  const g = freshGame();
  const { from, move } = movablePieceOf(g, 0);
  getG().stutter = { player: 0, banned: { t: "move", from, to: move.to, kind: move.kind } };
  const before = fingerprint(getG());
  refused(applyAction(0, { t: "move", from, to: move.to, kind: move.kind }), "Stutter");
  equal(fingerprint(getG()), before, "a refusal must not move the piece");
});

it("...and refuses it however the client labels the move", () => {
  // findLegalMove treats a missing `kind` as "any", so the ban is compared
  // against the ENGINE's resolved move rather than the client's claim.
  const g = freshGame();
  const { from, move } = movablePieceOf(g, 0);
  getG().stutter = { player: 0, banned: { t: "move", from, to: move.to, kind: move.kind } };
  refused(applyAction(0, { t: "move", from, to: move.to }), "Stutter");
  refused(applyAction(0, { t: "move", from, to: move.to, kind: undefined }), "Stutter");
});

it("...but accepts a different one", () => {
  const g = freshGame();
  const { from, a, b } = twoMovesFor(g, 0);
  getG().stutter = { player: 0, banned: { t: "move", from, to: a.to, kind: a.kind } };
  allowed(applyAction(0, { t: "move", from, to: b.to, kind: b.kind }));
});

it("refuses a repeated draw as readily as a repeated move", () => {
  const g = freshGame();
  load(g);
  getG().stutter = { player: 0, banned: { t: "draw" } };
  refused(applyAction(0, { t: "draw" }), "Stutter");
});

it("refuses a repeated cast", () => {
  const g = freshGame();
  load(g);
  getG().players[0].hand = ["wraparound"];
  getG().players[0].fp = 9;
  getG().stutter = { player: 0, banned: { t: "cast", id: "wraparound" } };
  refused(applyAction(0, { t: "cast", id: "wraparound", payload: {} }), "Stutter");
  equal(getG().wrap, 0, "and the spell did not resolve on the way to being refused");
});

it("binds only the seat that was stuttered", () => {
  const g = freshGame();
  const { from, move } = movablePieceOf(g, 0);
  // The same move, banned against the OTHER seat. Seat 0 is untouched by it.
  getG().stutter = { player: 1, banned: { t: "move", from, to: move.to, kind: move.kind } };
  allowed(applyAction(0, { t: "move", from, to: move.to, kind: move.kind }));
});

it("will not stack a second Stutter on a pending one", () => {
  const g = freshGame();
  load(g);
  getG().players[0].hand = ["stutter"];
  getG().players[0].fp = 9;
  getG().stutter = { player: 1, banned: null };
  refused(applyAction(0, { t: "cast", id: "stutter", payload: {} }), "already waiting");
});

/* ══════════════════════════════════════════════════════════════════════════
   8c. THE CLOCK CANNOT WEDGE A ROOM

   Pressure is the only card that makes the server act on its own, and
   playRandomTurn is what it calls. Its contract is narrow and absolute: from
   ANY state a player can walk away from, it takes a turn and hands over.

   That matters more than which move it picks. A player can abandon a turn
   mid-chain-jump, holding a seized enemy piece, or owing a forfeit — and every
   one of those refuses to let a turn end. If the clock could leave one
   standing, the room would be stuck for good with no player able to fix it.
   ══════════════════════════════════════════════════════════════════════════ */

describe("the clock always finds a turn to take");

const { playRandomTurn } = engine;

/** Build a board from scratch with `pieces` = [index, owner, rank?] triples. */
function staged(pieces, first = 0) {
  const g = newGame(first, SEED, { mode: "online" });
  load(g);
  g.turnNo = 0;
  beginTurn(first);
  const live = getG();
  // Cloned from a piece the engine itself made, rather than written out here:
  // a literal goes stale the moment a card adds a field, and it goes stale
  // silently — the field reads `undefined` and every test still passes until
  // one of them happens to look at it.
  const shape = live.board.find(Boolean);
  live.board = new Array(live.board.length).fill(null);
  for (const [i, owner, rank] of pieces) {
    live.board[i] = Object.assign({}, shape,
      { id: live.seq++, owner, rank: rank || "pawn", everAdjacent: false });
  }
  live.turn = first;
  live.phase = "declare";
  live.hasActed = false;
  return live;
}

it("takes an ordinary turn and hands over", () => {
  const g = staged([[rc(9, 4), 0], [rc(2, 3), 1]]);
  equal(playRandomTurn(0), true, "it reports that it acted");
  equal(getG().turn, 1, "and play moved on");
});

it("takes a capture rather than forfeiting a piece to the mandatory-capture rule", () => {
  // Walking past an available jump costs you the piece that could have taken
  // it. The referee must never hand a player that bill.
  const g = staged([[rc(7, 4), 0], [rc(6, 5), 1], [rc(9, 0), 0], [rc(0, 1), 1]]);
  playRandomTurn(0);
  const after = getG();
  assert(!after.board[rc(6, 5)], "the jump was taken");
  equal(after.board[rc(9, 0)] ? 1 : 0, 1, "and no piece of ours was forfeited");
});

it("finishes a chain-jump somebody walked away from", () => {
  const g = staged([[rc(7, 4), 0], [rc(6, 5), 1], [rc(4, 7), 1], [rc(0, 1), 1]]);
  load(g);
  // Take the first hop by hand, leaving the chain lock set — exactly the state
  // a player who closed the tab mid-jump leaves behind.
  applyAction(0, { t: "move", from: rc(7, 4), to: rc(5, 6), kind: "capture" });
  assert(getG().chain != null, "the fixture really does leave a chain outstanding");
  playRandomTurn(0);
  equal(getG().chain, null, "the chain was finished, not abandoned");
  equal(getG().turn, 1, "and the turn ended");
});

it("discharges an owed discard instead of leaving the turn unclosable", () => {
  const g = staged([[rc(9, 4), 0], [rc(2, 3), 1]]);
  getG().players[0].hand = ["evasive", "mirror"];
  getG().owedDiscard = { player: 0, n: 1, why: "test" };
  playRandomTurn(0);
  equal(getG().owedDiscard, null, "the debt is gone");
  equal(getG().players[0].hand.length, 1, "and a card actually left the hand");
  equal(getG().turn, 1);
});

it("moves a seized piece rather than holding it for ever", () => {
  const g = staged([[rc(9, 4), 0], [rc(2, 3), 1], [rc(0, 5), 1]]);
  getG().mindControl = { piece: rc(2, 3) };
  playRandomTurn(0);
  equal(getG().mindControl, null, "Mind Control was resolved");
  equal(getG().turn, 1);
});

it("hands over even from a position with nothing to do at all", () => {
  // Both pawns sealed in by barriers: no move, no card, no draw.
  const g = staged([[rc(0, 1), 1], [rc(9, 4), 0]], 1);
  const live = getG();
  live.barriers.push(rc(1, 0), rc(1, 2));
  live.players[1].hand = [];
  live.players[1].noDraw = 9;
  playRandomTurn(1);
  assert(getG().turn === 0 || getG().over, "the turn passed, or the game ended");
});

it("gives the same turn from the same state, so a replay does not diverge", () => {
  const a = staged([[rc(9, 4), 0], [rc(9, 6), 0], [rc(9, 8), 0], [rc(2, 3), 1]]);
  playRandomTurn(0);
  const first = getG().board.map((p) => (p ? p.owner : ".")).join("");
  const b = staged([[rc(9, 4), 0], [rc(9, 6), 0], [rc(9, 8), 0], [rc(2, 3), 1]]);
  playRandomTurn(0);
  equal(getG().board.map((p) => (p ? p.owner : ".")).join(""), first,
    "a seeded roll, not Math.random() — the same game must replay the same way");
});

it("respects a Stutter's ban rather than replaying the unmade turn", () => {
  const g = staged([[rc(9, 4), 0], [rc(9, 6), 0], [rc(2, 3), 1]]);
  const live = getG();
  live.stutter = { player: 0, banned: { t: "move", from: rc(9, 4), to: rc(8, 3), kind: "step" } };
  playRandomTurn(0);
  const after = getG();
  assert(!(after.board[rc(8, 3)] && !after.board[rc(9, 4)]),
    "the referee must not take the one turn the rules just forbade");
});

/* ── the card itself ──────────────────────────────────────────────────── */

describe("Pressure is online-only and puts both players on the clock");

it("is undrawable anywhere the server is not holding the clock", () => {
  for (const mode of ["local", "ai"])
    assert(!engine.modeSpellIds(newGame(0, SEED, { mode })).includes("pressure"),
      `a card that needs a server clock cannot be dealt in ${mode}`);
  assert(engine.modeSpellIds(newGame(0, SEED, { mode: "online" })).includes("pressure"));
});

it("times the opponent's next turn and the caster's turn after it", () => {
  const g = newGame(0, SEED, { mode: "online" });
  load(g);
  g.turnNo = 0;
  beginTurn(0);
  const live = getG();
  live.players[0].hand = ["pressure"];
  live.players[0].fp = 9;
  allowed(applyAction(0, { t: "cast", id: "pressure", payload: {} }));

  const after = getG();
  equal(after.players[1].timed, 1, "their turn starts on the clock immediately");
  equal(after.players[0].p_timed, 1, "and ours is parked until this turn ends");
  equal(after.players[0].timed, 0, "the turn being played now is not retroactively timed");
});

it("will not stack a second clock on a player already under one", () => {
  const g = newGame(0, SEED, { mode: "online" });
  load(g);
  g.turnNo = 0;
  beginTurn(0);
  getG().players[0].hand = ["pressure"];
  getG().players[0].fp = 9;
  getG().players[1].timed = 1;
  refused(applyAction(0, { t: "cast", id: "pressure", payload: {} }), "already on the clock");
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

it("does not hide the draw pool's scarcity bookkeeping — there is no secret order left to redact", () => {
  const g = freshGame();
  g.drawCounts.chronos = 1;
  const view = viewFor(g, 0, {});
  equal(view.drawCounts.chronos, 1, "remaining-draw counts are public, the same way a spent once-per-game card already was");
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

/* ── the three channels ───────────────────────────────────────────────────
   A concealment card is hidden only if the board field, the effect transcript
   and the referee log all agree to keep quiet. Two out of three is not a
   partial success, it is a leak — so each channel is asserted on its own, and
   then all three together the way a real card would use them.

   These are deliberately written against the MACHINERY rather than against any
   one card: they are what a future card gets for free by using `only` and
   SECRET_PIECE_FIELDS, and what catches the card that forgets to.
   ─────────────────────────────────────────────────────────────────────── */

it("strips a secret piece field from every piece that is not yours", () => {
  const g = freshGame();
  // Stand in for a real concealment card. Registering the field is the whole
  // opt-in — a card whose field is missing from this list leaks silently, and
  // this test is the reason that failure is loud instead.
  //
  // Restored by splicing out what was added, NOT by emptying the array: this
  // is the game's real list, and truncating it would quietly switch off the
  // redaction every later test depends on.
  const had = SECRET_PIECE_FIELDS.includes("hollow");
  if (!had) SECRET_PIECE_FIELDS.push("hollow");
  try {
    const mine = anyPieceOf(g, 0), theirs = anyPieceOf(g, 1);
    g.board[mine].hollow = true;
    g.board[theirs].hollow = true;

    const view = viewFor(g, 0, {});
    equal(view.board[mine].hollow, true, "you may read your own concealed piece");
    assert(!("hollow" in view.board[theirs]),
      "the field must be DELETED, not blanked — a client testing for the key must not tell the two apart");
    assert(g.board[theirs].hollow === true, "and the real game keeps it");
  } finally {
    if (!had) SECRET_PIECE_FIELDS.splice(SECRET_PIECE_FIELDS.indexOf("hollow"), 1);
  }
});

it("drops an fx event addressed to the other seat", () => {
  const g = freshGame();
  g.fx = [
    { n: 1, type: "spell", id: "veil", caster: 0 },
    { n: 2, type: "reveal", at: 5, only: 0 },
  ];
  const mine = viewFor(g, 0, {}).fx, theirs = viewFor(g, 1, {}).fx;
  equal(mine.length, 2, "seat 0 sees the public event and its own private one");
  equal(theirs.length, 1, "seat 1 sees only the public event");
  assert(theirs.every((e) => e.type !== "reveal"),
    "an unredacted event would animate the secret on the wrong screen");
});

it("drops a log line addressed to the other seat", () => {
  const g = freshGame();
  load(g);
  log("something everybody may read", "sys");
  log("the pawn at e5 is a decoy", "rule", 0);

  const mine = viewFor(g, 0, {}).log.map((l) => l.text).join("|");
  const theirs = viewFor(g, 1, {}).log.map((l) => l.text).join("|");
  assert(mine.includes("decoy"), "the seat it was written for reads it");
  assert(!theirs.includes("decoy"), "and nobody else does");
  assert(theirs.includes("something everybody may read"),
    "filtering must not swallow the public lines around it");
});

it("filters the log before taking the tail, not after", () => {
  // Slicing first would let another seat's unreadable lines take up room in
  // the window and push this seat's own history off the end of it.
  const g = freshGame();
  load(g);
  for (let k = 0; k < 200; k++) log(`private ${k}`, "sys", 1);
  log("the line seat 0 is waiting for", "big");

  const mine = viewFor(g, 0, {}).log;
  assert(mine.some((l) => l.text === "the line seat 0 is waiting for"),
    "seat 0's own line survived a flood of lines it cannot read");
  assert(mine.every((l) => !l.text.startsWith("private ")), "and none of theirs came through");
});

it("keeps a secret out of all three channels at once", () => {
  // What a real concealment card does on the turn it is cast: mark a piece,
  // announce it to one seat, and animate it for that seat only.
  const g = freshGame();
  const had = SECRET_PIECE_FIELDS.includes("hollow");
  if (!had) SECRET_PIECE_FIELDS.push("hollow");
  try {
    load(g);
    const decoy = anyPieceOf(g, 1);
    g.board[decoy].hollow = true;
    log(`the pawn at ${engine.sq(decoy)} is hollow`, "rule", 1);
    g.fx.push({ n: 999, type: "hollow", at: decoy, only: 1 });

    const foe = viewFor(g, 0, {});
    assert(!("hollow" in foe.board[decoy]), "channel 1: the board says nothing");
    assert(foe.fx.every((e) => e.type !== "hollow"), "channel 2: the transcript says nothing");
    assert(foe.log.every((l) => !l.text.includes("hollow")), "channel 3: the log says nothing");

    const owner = viewFor(g, 1, {});
    equal(owner.board[decoy].hollow, true, "and the owner still knows all three");
    assert(owner.fx.some((e) => e.type === "hollow"));
    assert(owner.log.some((l) => l.text.includes("hollow")));
  } finally {
    if (!had) SECRET_PIECE_FIELDS.splice(SECRET_PIECE_FIELDS.indexOf("hollow"), 1);
  }
});

/* ── Hollow, the first card that actually depends on all this ───────────── */

describe("a Hollow is hidden from the seat it is hidden from");

/** An online game with `seat` holding Hollow and able to pay for it. */
function hollowReady(seat = 0) {
  const g = newGame(0, SEED, { mode: "online" });
  load(g);
  g.turnNo = 0;
  beginTurn(0);
  const live = getG();
  live.turn = seat;
  live.phase = "declare";
  live.hasActed = false;
  live.players[seat].hand = ["hollow"];
  live.players[seat].fp = 9;
  return live;
}

it("keeps the decoy out of the board, the transcript and the log at once", () => {
  const g = hollowReady(0);
  const at = engine.hollowTargets(0)[0];
  allowed(applyAction(0, { t: "cast", id: "hollow", payload: { target: at } }));
  const live = getG();
  equal(live.board[at].hollow, true, "the game itself knows");

  const foe = viewFor(live, 1, {});
  assert(!("hollow" in foe.board[at]),
    "the field must not merely be false on their copy — it must be absent");
  assert(foe.fx.every((e) => e.type !== "hollow"), "nor may the effect reach them");
  assert(foe.log.every((l) => !/decoy/i.test(l.text)), "nor a log line naming it");

  const mine = viewFor(live, 0, {});
  equal(mine.board[at].hollow, true, "while the owner sees all three");
  assert(mine.fx.some((e) => e.type === "hollow"));
  assert(mine.log.some((l) => /decoy/i.test(l.text)));
});

it("still tells the opponent that SOME pawn is now a decoy", () => {
  // The bluff only works if they know there is one. What is hidden is which.
  const g = hollowReady(0);
  const at = engine.hollowTargets(0)[0];
  applyAction(0, { t: "cast", id: "hollow", payload: { target: at } });
  const foe = viewFor(getG(), 1, {});
  assert(foe.log.some((l) => /casts Hollow/.test(l.text)),
    "casting a card is public — it is the target that is not");
});

it("cannot be cast on somebody else's pawn, or on a piece already disguised", () => {
  const g = hollowReady(0);
  const theirs = anyPieceOf(getG(), 1);
  refused(applyAction(0, { t: "cast", id: "hollow", payload: { target: theirs } }), "pawn of yours");

  const mine = engine.hollowTargets(0)[0];
  getG().board[mine].hollow = true;
  refused(applyAction(0, { t: "cast", id: "hollow", payload: { target: mine } }), "pawn of yours");
});

it("can never capture", () => {
  const g = staged([[rc(7, 4), 0], [rc(6, 5), 1], [rc(0, 1), 1]]);
  const live = getG();
  assert(engine.captureMoves(rc(7, 4)).length > 0, "the fixture really does offer a jump");
  live.board[rc(7, 4)].hollow = true;
  equal(engine.captureMoves(rc(7, 4)).length, 0, "and a decoy cannot take it");
  equal(engine.capturersFor(0).length, 0,
    "so the mandatory-capture rule does not bill it for walking away either");
});

it("is revealed, and the spell wasted, when an enemy spell picks it out", () => {
  // Deliberately NOT filtered out of the target list: an option that silently
  // vanishes is itself an answer, and the client could not compute the same
  // list without knowing the secret.
  const g = staged([[rc(7, 4), 0], [rc(2, 3), 1], [rc(0, 1), 1]], 1);
  const live = getG();
  live.board[rc(7, 4)].hollow = true;
  live.players[1].hand = ["veil"];
  live.players[1].fp = 9;
  assert(engine.veilTargets(1).includes(rc(7, 4)),
    "the decoy must still appear in the enemy's target list");

  allowed(applyAction(1, { t: "cast", id: "veil", payload: { target: rc(7, 4) } }));
  const after = getG();
  equal(after.board[rc(7, 4)].hollow, false, "the disguise came off");
  equal(after.board[rc(7, 4)].noCapture, 0, "and the stun never landed");
  assert(after.log.some((l) => /was a Hollow/.test(l.text)), "the reveal is announced");
  assert(after.log.filter((l) => /was a Hollow/.test(l.text)).every((l) => l.only == null),
    "and announced to BOTH seats — the reveal is the payoff, not another secret");
});

it("is revealed by the crown", () => {
  const g = staged([[rc(1, 2), 0], [rc(9, 4), 1]]);
  getG().board[rc(1, 2)].hollow = true;
  allowed(applyAction(0, { t: "move", from: rc(1, 2), to: rc(0, 1), kind: "step" }));
  const p = getG().board[rc(0, 1)];
  equal(p.rank, "queen");
  equal(p.hollow, false, "nothing below carries a secret queen");
});

it("is revealed by the capture that kills it", () => {
  const g = staged([[rc(7, 4), 0], [rc(6, 5), 1], [rc(0, 1), 1]], 1);
  getG().board[rc(7, 4)].hollow = true;
  allowed(applyAction(1, { t: "move", from: rc(6, 5), to: rc(8, 3), kind: "capture" }));
  assert(getG().log.some((l) => /was a Hollow/.test(l.text)),
    "the opponent finds out what they spent the jump on");
});

/* ── Quantum Pawn ────────────────────────────────────────────────────────── */

describe("a superposition is public, but which half is real is not");

/** Cast Quantum Pawn for `seat` and hand back [gameState, squareA, squareB]. */
function superposed(seat = 0) {
  const g = newGame(0, SEED, { mode: "online" });
  load(g);
  g.turnNo = 0;
  beginTurn(0);
  const live = getG();
  live.turn = seat; live.phase = "declare"; live.hasActed = false;
  live.players[seat].hand = ["quantum"];
  live.players[seat].fp = 9;
  const at = engine.quantumTargets(seat)[0];
  const spot = engine.quantumSpots(at)[0];
  allowed(applyAction(seat, { t: "cast", id: "quantum", payload: { target: at, spot } }));
  return [getG(), at, spot];
}

it("shows both bodies to both players but tells only the owner which is which", () => {
  const [g, a, b] = superposed(0);
  equal(g.board[a].quantum, g.board[b].quantum, "the two squares share a link");
  assert(g.board[a].quantum !== 0, "and it is a real link, not zero");
  equal(g.board[a].quantumReal !== g.board[b].quantumReal, true, "exactly one of them is real");

  const foe = viewFor(g, 1, {});
  equal(foe.board[a].quantum, foe.board[b].quantum, "the opponent can see the pair — that much is public");
  assert(!("quantumReal" in foe.board[a]) && !("quantumReal" in foe.board[b]),
    "but not which of them the pawn is");
  assert(foe.log.every((l) => !/real pawn is/.test(l.text)), "and the log does not say either");
  assert(viewFor(g, 0, {}).log.some((l) => /real pawn is/.test(l.text)), "while the owner is told");
});

it("neither half can capture", () => {
  const [g, a, b] = superposed(0);
  load(g);
  equal(captureMoves(a).length, 0);
  equal(captureMoves(b).length, 0);
});

it("refuses a pawn that has already stood beside an enemy", () => {
  const g = newGame(0, SEED, { mode: "online" });
  load(g);
  g.turnNo = 0;
  beginTurn(0);
  const live = getG();
  live.players[0].hand = ["quantum"];
  live.players[0].fp = 9;
  const at = engine.quantumTargets(0)[0];
  const spot = engine.quantumSpots(at)[0];
  live.board[at].everAdjacent = true;
  refused(applyAction(0, { t: "cast", id: "quantum", payload: { target: at, spot } }),
    "stood beside an enemy");
});

it("refuses a second square that is not an empty dark square beside the first", () => {
  const g = newGame(0, SEED, { mode: "online" });
  load(g);
  g.turnNo = 0;
  beginTurn(0);
  getG().players[0].hand = ["quantum"];
  getG().players[0].fp = 9;
  const at = engine.quantumTargets(0)[0];
  for (const bad of [at, emptySquare(getG()), anyPieceOf(getG(), 1)])
    refused(applyAction(0, { t: "cast", id: "quantum", payload: { target: at, spot: bad } }),
      "beside the first");
});

it("a jump at the empty half takes nothing and pays nothing", () => {
  // Staged by hand so the answer is known: the struck square is the ghost.
  // Violet advances down the board, so its attacker sits ABOVE the pair.
  const g = staged([[rc(5, 4), 0], [rc(5, 6), 0], [rc(4, 5), 1], [rc(0, 1), 1]], 1);
  const live = getG();
  live.board[rc(5, 4)].quantum = 77; live.board[rc(5, 4)].quantumReal = true;
  live.board[rc(5, 6)].quantum = 77; live.board[rc(5, 6)].quantumReal = false;
  live.players[1].fp = 0;

  // Violet jumps the GHOST at rc(5,6), landing on rc(6,7).
  allowed(applyAction(1, { t: "move", from: rc(4, 5), to: rc(6, 7), kind: "capture" }));
  const after = getG();
  equal(after.board[rc(5, 6)], null, "the ghost is gone");
  assert(after.board[rc(5, 4)], "and the real pawn is untouched");
  equal(after.board[rc(5, 4)].quantum, 0, "the superposition is over for good");
  equal(after.board[rc(6, 7)] && after.board[rc(6, 7)].owner, 1, "the attacker completed the jump");
  equal(after.players[1].fp, 0, "and was paid nothing for it");
  equal(after.board[rc(6, 7)].captures, 0, "it does not even count as a capture");
  equal(after.lastCapture, null, "so there is nothing for Hopscotch to reverse");
});

it("a jump at the real half captures it and the ghost vanishes", () => {
  const g = staged([[rc(5, 4), 0], [rc(5, 6), 0], [rc(4, 5), 1], [rc(0, 1), 1]], 1);
  const live = getG();
  live.board[rc(5, 4)].quantum = 77; live.board[rc(5, 4)].quantumReal = false;
  live.board[rc(5, 6)].quantum = 77; live.board[rc(5, 6)].quantumReal = true;
  live.players[1].fp = 0;

  allowed(applyAction(1, { t: "move", from: rc(4, 5), to: rc(6, 7), kind: "capture" }));
  const after = getG();
  equal(after.board[rc(5, 6)], null, "the real pawn was taken");
  equal(after.board[rc(5, 4)], null, "and the ghost went with it");
  assert(after.players[1].fp > 0, "this one really was a capture, and was paid for");
});

it("the collapse is announced to both seats — there is nothing left to hide", () => {
  const g = staged([[rc(5, 4), 0], [rc(5, 6), 0], [rc(4, 5), 1], [rc(0, 1), 1]], 1);
  const live = getG();
  live.board[rc(5, 4)].quantum = 77; live.board[rc(5, 4)].quantumReal = true;
  live.board[rc(5, 6)].quantum = 77; live.board[rc(5, 6)].quantumReal = false;
  applyAction(1, { t: "move", from: rc(4, 5), to: rc(6, 7), kind: "capture" });
  const after = getG();
  const lines = after.log.filter((l) => /never occupied|all along/.test(l.text));
  assert(lines.length > 0, "the collapse is on the record");
  assert(lines.every((l) => l.only == null), "and on both players' record");
});

it("gives the same answer from the same state, so a rewind cannot reroll it", () => {
  const [a] = superposed(0);
  const first = a.board.map((p) => (p && p.quantum ? (p.quantumReal ? "R" : "g") : ".")).join("");
  const [b] = superposed(0);
  equal(b.board.map((p) => (p && p.quantum ? (p.quantumReal ? "R" : "g") : ".")).join(""), first,
    "a seeded flip — the machine's search rewinds through this constantly");
});

it("records having stood beside an enemy, which is a fact about the past", () => {
  // Gold advances UP the board, toward row 0 — so it closes on a Violet piece
  // sitting at a lower row number, not a higher one.
  const g = staged([[rc(5, 4), 0], [rc(3, 2), 1], [rc(0, 1), 1]]);
  equal(getG().board[rc(5, 4)].everAdjacent, false, "not yet recorded at setup");
  assert(engine.quantumTargets(0).includes(rc(5, 4)), "and it is a legal target while untouched");

  allowed(applyAction(0, { t: "move", from: rc(5, 4), to: rc(4, 3), kind: "step" }));
  const p = getG().board[rc(4, 3)];
  equal(p.everAdjacent, true, "it walked up beside one, and that does not un-happen");
  load(getG());
  assert(!engine.quantumTargets(0).includes(rc(4, 3)), "so it can never be split again");
});

/* ── Temporal Twin ───────────────────────────────────────────────────────── */

describe("a Temporal Twin owes two movements and shares one life");

/** Twin the pawn at the first legal target and hand back [state, a, b]. */
function twinned(seat = 0, pieces = null) {
  const g = pieces ? staged(pieces, seat) : (() => {
    const gg = newGame(0, SEED, { mode: "local" });
    load(gg); gg.turnNo = 0; beginTurn(0);
    return getG();
  })();
  const live = getG();
  live.turn = seat; live.phase = "declare"; live.hasActed = false;
  live.players[seat].hand = ["twin"];
  live.players[seat].fp = 9;
  const at = engine.twinTargets(seat)[0];
  const spot = engine.quantumSpots(at)[0];
  allowed(applyAction(seat, { t: "cast", id: "twin", payload: { target: at, spot } }));
  return [getG(), at, spot];
}

it("is drawable in hot-seat, because nothing about it is secret", () => {
  assert(engine.modeSpellIds(newGame(0, SEED)).includes("twin"),
    "both bodies are real and both players see them — there is nothing to conceal");
});

it("puts two real bodies on the board, sharing one link", () => {
  const [g, a, b] = twinned(0);
  equal(g.board[a].twin, g.board[b].twin);
  assert(g.board[a].twin !== 0);
  const foe = viewFor(g, 1, {});
  equal(foe.board[a].twin, foe.board[b].twin, "and the opponent sees the pair in full");
});

it("owes the second body a move, and refuses to end the turn until it goes", () => {
  const [g, a, b] = twinned(0, [[rc(5, 4), 0], [rc(1, 6), 1], [rc(1, 8), 1]]);
  const first = engine.twinTargets(0).length === 0 ? a : a;   // the cast target
  const mv = legalMovesFor(first)[0];
  allowed(applyAction(0, { t: "move", from: first, to: mv.to, kind: mv.kind }));

  const mid = getG();
  equal(mid.turn, 0, "the turn has not passed");
  assert(mid.twinStep != null, "the other body owes a move");
  refused(applyAction(0, { t: "endTurn" }), "Temporal Twin");
});

it("lets only the owed body make that second movement", () => {
  const [g] = twinned(0, [[rc(5, 4), 0], [rc(9, 0), 0], [rc(1, 6), 1], [rc(1, 8), 1]]);
  const a = getG().board.findIndex((p) => p && p.twin);
  const mv = legalMovesFor(a)[0];
  applyAction(0, { t: "move", from: a, to: mv.to, kind: mv.kind });

  const owed = getG().twinStep;
  assert(owed != null, "something is owed");
  // The unrelated pawn at rc(9,0) is not it.
  refused(applyAction(0, { t: "move", from: rc(9, 0), to: rc(8, 1), kind: "step" }));
  equal(getG().twinStep, owed, "and the refusal did not discharge the debt");
});

it("hands over once both bodies have moved, and not before", () => {
  const [g] = twinned(0, [[rc(5, 4), 0], [rc(1, 6), 1], [rc(1, 8), 1]]);
  const a = getG().board.findIndex((p) => p && p.twin);
  let mv = legalMovesFor(a)[0];
  applyAction(0, { t: "move", from: a, to: mv.to, kind: mv.kind });
  const owed = getG().twinStep;
  mv = legalMovesFor(owed)[0];
  applyAction(0, { t: "move", from: owed, to: mv.to, kind: mv.kind });

  const after = getG();
  equal(after.twinStep, null, "the debt is discharged");
  equal(after.turn, 1, "and play moved on — two movements, one turn");
});

it("does not owe a third movement — the pair does not hand it back and forth", () => {
  const [g] = twinned(0, [[rc(5, 4), 0], [rc(1, 6), 1], [rc(1, 8), 1]]);
  const a = getG().board.findIndex((p) => p && p.twin);
  let mv = legalMovesFor(a)[0];
  applyAction(0, { t: "move", from: a, to: mv.to, kind: mv.kind });
  const owed = getG().twinStep;
  mv = legalMovesFor(owed)[0];
  applyAction(0, { t: "move", from: owed, to: mv.to, kind: mv.kind });
  equal(getG().twinStep, null, "twinDone is what stops this looping for ever");
});

it("raises no obligation the second body could not discharge", () => {
  // Buried behind barriers: the far body cannot move at all, so owing it a
  // move would be a turn nobody could end.
  const g = staged([[rc(5, 4), 0], [rc(1, 6), 1], [rc(1, 8), 1]]);
  const live = getG();
  live.players[0].hand = ["twin"];
  live.players[0].fp = 9;
  const spot = rc(4, 3);
  live.barriers.push(rc(3, 2), rc(3, 4));            // seal the far body in
  allowed(applyAction(0, { t: "cast", id: "twin", payload: { target: rc(5, 4), spot } }));
  const mv = legalMovesFor(rc(5, 4)).find((m) => m.to !== spot);
  allowed(applyAction(0, { t: "move", from: rc(5, 4), to: mv.to, kind: mv.kind }));
  assert(getG().twinStep == null || legalMovesFor(getG().twinStep).length > 0,
    "an obligation was only raised if it could actually be met");
});

it("loses both bodies to one capture", () => {
  const g = staged([[rc(5, 4), 0], [rc(5, 6), 0], [rc(4, 5), 1], [rc(0, 1), 1]], 1);
  const live = getG();
  live.board[rc(5, 4)].twin = 55; live.board[rc(5, 6)].twin = 55;
  allowed(applyAction(1, { t: "move", from: rc(4, 5), to: rc(6, 7), kind: "capture" }));
  const after = getG();
  equal(after.board[rc(5, 6)], null, "the captured body is gone");
  equal(after.board[rc(5, 4)], null, "and the other went with it");
});

it("loses the other body to the crown", () => {
  const g = staged([[rc(1, 2), 0], [rc(5, 6), 0], [rc(9, 4), 1]]);
  const live = getG();
  live.board[rc(1, 2)].twin = 56; live.board[rc(5, 6)].twin = 56;
  allowed(applyAction(0, { t: "move", from: rc(1, 2), to: rc(0, 1), kind: "step" }));
  const after = getG();
  equal(after.board[rc(0, 1)].rank, "queen", "the crown stands");
  equal(after.board[rc(0, 1)].twin, 0, "the pairing is over");
  equal(after.board[rc(5, 6)], null, "and it cost the other body");
});

it("loses the other body to a transformation", () => {
  const g = staged([[rc(5, 4), 0], [rc(5, 6), 0], [rc(6, 5), 0], [rc(0, 1), 1]]);
  const live = getG();
  live.board[rc(5, 4)].twin = 57; live.board[rc(5, 6)].twin = 57;
  live.players[0].hand = ["juggernautSpell"];
  live.players[0].fp = 9;
  allowed(applyAction(0, {
    t: "cast", id: "juggernautSpell", payload: { target: rc(5, 4), sacrifice: rc(6, 5) },
  }));
  const after = getG();
  equal(after.board[rc(5, 4)].form, "juggernaut");
  equal(after.board[rc(5, 6)], null, "the other body did not survive it");
});

it("cannot be twinned twice, nor stacked on a superposition", () => {
  const [g, a] = twinned(0);
  load(getG());
  assert(!engine.twinTargets(0).includes(a), "an already-twinned pawn is not a target");
});

/* ══════════════════════════════════════════════════════════════════════════
   9b. THE MODE GATE

   A card whose effect is that your opponent cannot see something is worth
   nothing across a shared screen, so hot-seat is not dealt one. That gate is a
   property of the DRAW POOL rather than of any card's rules, which means the
   test for it belongs with the rest of the disclosure surface: the pool is how
   a secret gets into a game in the first place.
   ══════════════════════════════════════════════════════════════════════════ */

describe("the draw pool respects the shape of the game");

it("defaults to hot-seat when nobody says otherwise", () => {
  equal(newGame(0).mode, "local", "the server's old call shape must not silently deal secrets");
  equal(newGame(0, SEED, {}).mode, "local");
  equal(newGame(0, SEED, { mode: "nonsense" }).mode, "local", "an unrecognised mode is not a mode");
});

it("takes the mode the caller asked for", () => {
  equal(newGame(0, SEED, { mode: "online" }).mode, "online");
  equal(newGame(0, SEED, { mode: "ai" }).mode, "ai");
});

it("keeps a hidden card out of a hot-seat game and lets it into the other two", () => {
  // Borrow a real card rather than invent one: the gate has to work on the
  // actual SPELLS table, not on a fixture shaped to suit it.
  SPELLS.veil.hidden = true;
  try {
    assert(!engine.modeSpellIds(newGame(0, SEED)).includes("veil"),
      "hot-seat must never be dealt a concealment card");
    assert(engine.modeSpellIds(newGame(0, SEED, { mode: "ai" })).includes("veil"),
      "the machine is genuinely blinded, so it works there");
    assert(engine.modeSpellIds(newGame(0, SEED, { mode: "online" })).includes("veil"),
      "and online is what it was written for");
  } finally {
    delete SPELLS.veil.hidden;
  }
});

it("keeps an online-only card out of both offline modes", () => {
  SPELLS.veil.onlineOnly = true;
  try {
    for (const mode of ["local", "ai"])
      assert(!engine.modeSpellIds(newGame(0, SEED, { mode })).includes("veil"),
        `a card that needs the server's clock cannot be dealt in ${mode}`);
    assert(engine.modeSpellIds(newGame(0, SEED, { mode: "online" })).includes("veil"));
  } finally {
    delete SPELLS.veil.onlineOnly;
  }
});

it("the drawable pool never offers what the mode forbids", () => {
  SPELLS.veil.hidden = true;
  try {
    const g = newGame(0, SEED);
    load(g);
    g.turnNo = 0;
    beginTurn(0);
    assert(!engine.eligibleSpellIds().includes("veil"),
      "eligibleSpellIds is the one list the draw reads — the gate has to hold there, not just in modeSpellIds");
  } finally {
    delete SPELLS.veil.hidden;
  }
});

it("...but the sandbox is exempt, because a workbench you cannot test a card in is useless", () => {
  // This is the opposite of what shipped first, and deliberately so. Gating the
  // sandbox on the concealment rule left Hollow, Quantum Pawn and Pressure as
  // the only three cards in the game that could not be tried out anywhere.
  SPELLS.veil.hidden = true;
  SPELLS.mirror.onlineOnly = true;
  try {
    const s = newGame(0, SEED, { dev: true });
    load(s);
    s.turnNo = 0;
    beginTurn(0);
    equal(getG().players[0].hand.length, SPELL_IDS.length,
      "the workbench holds every card there is, whatever the mode would say");
    assert(getG().players[0].hand.includes("veil"), "including a concealment card");
    assert(getG().players[0].hand.includes("mirror"), "and one that needs the server");
  } finally {
    delete SPELLS.veil.hidden;
    delete SPELLS.mirror.onlineOnly;
  }
});

it("every card this phase added can actually be reached from the sandbox", () => {
  // The regression itself, named. Reported from a real session: three cards
  // were missing from the one mode built for trying cards out.
  const s = newGame(0, SEED, { dev: true });
  load(s);
  s.turnNo = 0;
  beginTurn(0);
  const hand = getG().players[0].hand;
  for (const id of ["stutter", "pressure", "hollow", "quantum", "twin"])
    assert(hand.includes(id), `the sandbox must be able to reach ${id}`);
});

/* ══════════════════════════════════════════════════════════════════════════
   10. THE DEV SANDBOX CANNOT BE REACHED FROM THE WIRE

   G.dev relaxes almost every gate in this file at once — unlimited actions,
   a hand holding every card, free transformations, endless Focus. That is
   exactly the set of things the other nine groups exist to refuse, so the flag
   is only as safe as the one thing standing between it and a socket:
   newGame's third argument, which server.js never passes.

   These tests hold that line from both sides. The sandbox must work when it is
   asked for locally, and must be unreachable when it is not.
   ══════════════════════════════════════════════════════════════════════════ */

describe("the dev sandbox cannot be reached from the wire");

it("a game built the way the server builds one is not a sandbox", () => {
  // server.js:  G: newGame(0)
  const g = newGame(0);
  assert(!g.dev, "an ordinary game must never carry the sandbox flag");
  assert("dev" in g, "the flag must exist and be false, not be missing");
});

it("the sandbox only opens when it is asked for by name", () => {
  assert(newGame(0, SEED, {}).dev === false, "an empty options object is not a request");
  assert(newGame(0, SEED, { dev: "yes" }).dev === false, "only true means true");
  assert(newGame(0, SEED, { dev: true }).dev === true, "the local path must still work");
});

it("an action cannot smuggle the flag in alongside a move", () => {
  const g = solventGame();
  const { from, move } = movablePieceOf(g, 0);

  applyAction(0, { t: "move", from, to: move.to, kind: move.kind, dev: true });
  assert(!getG().dev, "a field on the action must not become a field on the game");

  refused(applyAction(0, { t: "move", from: emptySquare(getG()), to: 0, kind: "step" }));
  assert(!getG().dev, "and a refusal must not set it either");
});

it("without the sandbox a second action in one turn is still refused", () => {
  // The relaxation is one hook in applyAction. If it ever fires on an ordinary
  // game this is the test that notices. The seat is given Focus first so it
  // still has a transformation available afterwards — otherwise the referee
  // auto-passes a turn with nothing left in it and the second move would be
  // refused for the wrong reason.
  const g = solventGame();
  const { from, move } = movablePieceOf(g, 0);
  allowed(applyAction(0, { t: "move", from, to: move.to, kind: move.kind }));
  equal(getG().turn, 0, "the turn did not auto-pass, so this really tests the gate");
  equal(getG().hasActed, true, "an ordinary move consumes the turn");
  equal(getG().phase, "end", "and closes the Declare phase behind it");

  const second = movablePieceOf(getG(), 0);
  refused(applyAction(0, { t: "move", from: second.from, to: second.move.to, kind: second.move.kind }),
    "already acted");
});

it("without the sandbox a card still has to be in your hand", () => {
  const g = freshGame();
  g.players[0].hand = [];
  g.players[0].fp = 99;
  refused(applyAction(0, { t: "cast", id: "veil", payload: { target: 0 } }), "Not in your hand");
});

it("without the sandbox a card still has to be paid for", () => {
  // A separate game: the refusal above rolls the state back, which REPLACES the
  // engine's G, so anything set on the old object is gone.
  const g = freshGame();
  g.players[0].hand = ["cascade"];
  g.players[0].fp = 0;
  refused(applyAction(0, { t: "cast", id: "cascade", payload: {} }), "FP");
});

it("without the sandbox a transformation still costs FP and respects its caps", () => {
  const g = freshGame();
  const pawn = anyPieceOf(g, 0);
  g.players[0].hand = ["sentinelSpell"];
  g.players[0].fp = 0;
  refused(applyAction(0, { t: "cast", id: "sentinelSpell", payload: { target: pawn } }), "FP");
});

it("the sandbox really does relax what it claims to", () => {
  // The other side of the same line: if this stops passing, the flag has been
  // rendered inert and the menu's Space knock now opens an ordinary game.
  const g = newGame(0, SEED, { dev: true });
  load(g);
  g.turnNo = 0;
  beginTurn(0);

  equal(getG().players[0].hand.length, SPELL_IDS.length,
    "the sandbox hand holds one of everything there is");
  equal(getG().players[0].fp, engine.FP_CAP, "and the pool starts full");

  const first = movablePieceOf(getG(), 0);
  allowed(applyAction(0, { t: "move", from: first.from, to: first.move.to, kind: first.move.kind }));
  const second = movablePieceOf(getG(), 0);
  allowed(applyAction(0, { t: "move", from: second.from, to: second.move.to, kind: second.move.kind }));
  equal(getG().turn, 0, "two moves in, the turn is still yours");
  equal(getG().players[0].fp, engine.FP_CAP, "and the pool has topped itself back up");
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
