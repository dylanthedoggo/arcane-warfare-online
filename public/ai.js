/* ══════════════════════════════════════════════════════════════════════════
   ARCANE WARFARE — THE MACHINE

   The opponent, lifted out of index.html and into a file of its own. Nothing
   here changed in the move: this is the same code, in the same order, with the
   same comments, and both test suites pass identically either side of it.

   HOW IT IS LOADED, AND WHY THAT MATTERS. This is a classic script, loaded
   after engine.js and fx.js and before the page's own inline script:

       <script src="engine.js"></script>
       <script src="fx.js"></script>
       <script src="ai.js"></script>
       <script> ...the interface, and the self-test suite... </script>

   Top-level `let` and `const` in a classic script live in a lexical scope that
   every classic script on the page shares. So this file reads `G` — declared
   `let G = null` in engine.js — as a live binding rather than a copy, which is
   exactly what a search that mutates the board in place and puts it back needs.
   The same goes the other way: the interface and the tests below call into
   searchBestMove, aiTakeTurn and the rest without importing anything.

   What this file expects to find already in that shared scope:

     from engine.js   G, CELLS, rc, rowOf, colOf, cellAt, isDark, isBarrier,
                      DIAG, ORTHO, FORMS, SPELLS, PLAYERS, mkPiece, snapshot,
                      restore, mulberry32, log, and the rules predicates —
                      legalMovesFor, captureMoves, capturersFor, simpleMoves,
                      canAct, canCapture, isAlly, isEnemy, promoRow, homeRow,
                      countPieces, performMove, castSpell, drawSpell,
                      discardCards, spellBlocker, and the various *Targets()
     from fx.js       FX
     from index.html  UI, NET, render, endTurnLocal, clearSelection,
                      announceWinner, sq, pieceLabel, toast

   Every one of those is referenced from inside a function body, never at the
   top level of this file, so it does not matter that index.html's own
   declarations run after this script does — by the time anything here is
   called, they exist.

   ON RUNNING THIS UNDER NODE. It does not, yet, and the reason is worth
   writing down because it is not obvious. In Node, engine.js is a CommonJS
   module and its `G` is module-local; `require()` hands back a snapshot of the
   exported values, not live bindings. This file says `G.board[i]` in several
   hundred places, and every one of them would be reading a `G` frozen at the
   moment of import. engine.js anticipates this and offers setG/getG, and a
   Node shim could bridge it with an accessor property on globalThis — but the
   driver would still be missing endTurnLocal, render and UI, which live in the
   page. Headless self-play is therefore still a browser-only affair. Getting
   it into Node is a real piece of work and a separate one; this file being its
   own file is the half of it that had to happen first.
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   THE MACHINE  —  a tier-2 opponent

   Alpha-beta over piece movement, with spells and transformations chosen by a
   separate policy layer that scores each candidate by simulating it and running
   a shallow search on the result.

   Two invariants this code must never break:

   1. IT DOES NOT CHEAT. Everything the evaluation reads is information a human
      opponent can also see: piece positions, Focus Points, hand SIZE, deck size.
      It never inspects the contents of the other player's hand. `spellBlocker`
      is only ever called with the machine's own seat.

   2. IT PLAYS THROUGH THE REAL RULES. Moves are executed with the same
      performMove / castSpell / applyTransform the interface uses, so captures,
      promotions, penalties and logging behave identically to a human's turn.
      The fast make/unmake below is used ONLY inside the search tree.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every knob a level owns. The first row governs the piece-move search; the
 * second and third govern the POLICY layer — spells and transformations — which
 * used to run off hardcoded constants and so gave Ruthless exactly Skilled's
 * judgement about its own hand. In a game this spell-heavy that was most of the
 * gap between the machine and a good human.
 *
 *   depth         ceiling on iterative deepening; `timeMs` is what usually stops it
 *   timeMs        wall-clock for one root search — also the page freeze, since
 *                 the search runs on the main thread
 *   spells        "basic" prunes the candidate list hard and disables Chronos
 *   noise         root-only score jitter; the whole of "blunders on purpose"
 *   pace          animation pacing between driver beats. Cosmetic, not strength.
 *   policyDepth   plies for the shallow search that prices one spell/transform
 *   policyMs      wall-clock for ONE such pricing search
 *   policyBudget  wall-clock for a whole policy decision, across all candidates
 *   castEdge      how much a spell must beat standing pat by before it is cast
 *   transformEdge the same margin for a transformation
 *   chronosEdge   the same margin for Chronos's Gaze, which rewinds the game
 *   width         multiplier on the candidate shortlists
 *   qply          depth cap on the captures-only quiescence search
 */
const AI_LEVELS = {
  novice:   { name: "Novice",   depth: 3,  timeMs: 250,  spells: "basic", noise: 38, pace: 380,
              policyDepth: 2, policyMs: 90,  policyBudget: 400,  castEdge: 30, transformEdge: 35,
              chronosEdge: 140, width: 1, qply: 6 },
  skilled:  { name: "Skilled",  depth: 4,  timeMs: 800,  spells: "full",  noise: 12, pace: 300,
              policyDepth: 3, policyMs: 90,  policyBudget: 550,  castEdge: 25, transformEdge: 30,
              chronosEdge: 140, width: 1, qply: 6 },
  ruthless: { name: "Ruthless", depth: 10, timeMs: 3000, spells: "full",  noise: 0,  pace: 220,
              policyDepth: 4, policyMs: 140, policyBudget: 1000, castEdge: 12, transformEdge: 18,
              chronosEdge: 100, width: 2, qply: 8 },
};

/**
 * Skilled's policy figures are the old hardcoded constants exactly — 3 plies,
 * 90 ms, 550 ms, +25 / +30 / +140 — so the self-play regression tests below,
 * which are all played at Skilled, keep measuring the same machine they always
 * did. Novice's policyDepth is pinned at 2 rather than derived: the old code
 * said Math.min(3, depth), and raising its depth to 3 would otherwise have
 * quietly upgraded its spell play as a side effect.
 */

/** Shortlist caps, widened for the levels that have the budget to score more. */
const aiWide = (n) => Math.round(n * aiCfg().width);

/**
 * `gen` is a generation counter. Every scheduled beat of the machine's turn
 * captures it, and a beat whose generation is stale aborts instead of running.
 * Without it a pending setTimeout from an abandoned turn — the human hit New
 * Game, resigned, or took an undo mid-think — would wake up and mutate the
 * fresh game.
 */
let AI = {
  on: false, side: 1, level: "skilled", thinking: false, gen: 0,
  // Budget the search in nodes rather than in wall-clock milliseconds, so that
  // the same seeded game plays out the same way twice. Off here and never
  // turned on by the page; the headless tools set it. `fast`, its older
  // neighbour, is set the same ad-hoc way and clamps the budget rather than
  // changing its currency. See "what a search may spend".
  deterministic: false,
};

/** Abandon whatever the machine was doing; any in-flight beat becomes a no-op. */
function aiCancel() { AI.gen++; AI.thinking = false; AI.moveSteps = null; }
const aiCfg = () => AI_LEVELS[AI.level];
const isAISeat = (s) => AI.on && s === AI.side;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the machine's own randomness ───────────────────────────────────────────
   Two things here are decided by a coin flip: the root jitter that makes the
   easier levels beatable, and the "random" opponent self-play is measured
   against. Both used to call Math.random(), and that made a nonsense of the
   engine's care about seeds. Every draw, every quantum roll and every refereed
   timeout derives from G.seed, which is what makes a game replayable — and the
   seed reached the referee and stopped there. Two runs of the same seeded game
   picked different moves.

   Worse, it was invisible from Ruthless, which is where anyone would look
   first: noise 0 multiplies the sample to zero, so the one level that never
   jitters reproduced perfectly and the two that do never did.

   So both are seeded the way drawSpell is — off the game seed, the turn number
   and a monotonic counter — each with a multiplier of its own so the two
   streams cannot fall into step with each other or with the draw stream.

   THE COUNTER LIVES ON G, which is deliberate on both counts: a snapshot
   carries it, and a rewind takes it back. Chronos's Gaze and the policy layer's
   simulations both put the game back to an earlier state, and a stream that
   kept running through a rewind would make the replay of a rewound game diverge
   from the game itself.

   IT ADVANCES PER CALL, not per turn. Sixteen searches of one position must not
   all blunder identically — see the "varies from run to run" test in the page's
   suite, which is the check that a per-turn counter would silently break.
   ─────────────────────────────────────────────────────────────────────────── */

const AI_SALT_JITTER = 5279;      // root-move jitter
const AI_SALT_RANDOM = 3001;      // the "random" opponent choosing its move

/**
 * A seeded stream for one decision. `salt` names which stream.
 *
 * The guard is not decoration. `G.aiSeq` is declared in newGame, so any game
 * this file plays has it — but a game restored from a state written before that
 * field existed would not, and `undefined++` is NaN, which sticks: every later
 * call would seed identically and the machine would blunder the same way
 * forever without once throwing. Silent, and exactly the kind of thing seeding
 * exists to rule out.
 */
function aiRng(salt) {
  if (typeof G.aiSeq !== "number") G.aiSeq = 0;
  return mulberry32((G.seed + G.turnNo * salt + G.aiSeq++) | 0);
}

const MATE = 1e6;
let AI_NODES = 0, AI_DEADLINE = 0, AI_TIMEUP = false, AI_NODE_DEADLINE = 0;

/* ── fast make / unmake (search only — no logging, no FP, no penalties) ──── */

/**
 * A Hollow's shell the search is entitled to know about.
 *
 * The machine may reason about its OWN shells — it cast them — and it has to,
 * or a shell it paid 3 Focus for would be worth nothing to it. It may NOT
 * reason about the opponent's: a search that steers around a shelled enemy
 * pawn has read a field viewFor deletes, and the card is dead. So the machine
 * jumps into enemy shells exactly like a person does, and finds out the same
 * way — by spending the jump.
 *
 * (canCapture still reads `hollow` on both sides, so the search can infer an
 * enemy shell from a pawn that declines a jump it plainly has. That leak is
 * older than this function and is documented at engine.js canCapture. Named
 * here so it is not rediscovered as something new.)
 */
const aiOwnShell = (v) => !!v.hollow && v.owner === AI.side;

/* ── position hashing ───────────────────────────────────────────────────────
   A single number that names the position, so the search can recognise one it
   has already scored. With whole-turn moves and chain jumps, the same position
   is reached by different routes constantly — two pawns advancing in either
   order, a chain that could have started at either end — and without a name for
   it, every one of those is searched again from nothing.

   ZOBRIST HASHING is the standard trick: give every (square, attribute) pair a
   fixed random number and XOR together the ones that are true. XOR is its own
   inverse, so a piece leaving a square is undone by XORing the very same value
   back in, which is what makes the hash cheap to keep up to date.

   THE NUMBERS ARE SEEDED, not random. mulberry32 with a fixed seed gives the
   same table on every page load, which is what lets a noiseless level pick the
   same move twice — see the determinism test. Math.random() here would make the
   machine's play depend on when the tab was opened.

   WHAT IS NOT IN IT. `quantumReal` never appears, and neither does `hollow` on
   an enemy piece. Those are the two things the machine is not entitled to see,
   and a cache key is a back door into exactly that: two positions differing
   only in a secret would get different keys, and the search would be steering
   by information it is supposed to be guessing at. Own shells ARE included,
   because applyStep already reasons about those and must not confuse one with
   a bare pawn. See aiOwnShell.

   Everything sideScore reads is in here. That is not decoration — a field the
   evaluator prices but the key ignores means two positions that score
   differently share a name, and the table hands back the wrong answer.
   ─────────────────────────────────────────────────────────────────────────── */

const ZW = 24;                                   // hash channels per square
const ZOB = (() => {
  const rng = mulberry32(0x5eed1234);
  const t = new Int32Array(CELLS * ZW);
  for (let i = 0; i < t.length; i++) t[i] = (rng() * 0x100000000) | 0;
  return t;
})();
const ZOB_SIDE = (() => { const rng = mulberry32(0x0dd51de); return (rng() * 0x100000000) | 0; })();
const FORM_SLOT = {};
Object.keys(FORMS).forEach((k, i) => { FORM_SLOT[k] = i; });

/** The hash contribution of the piece `p` standing on square `i`. */
function pieceHash(p, i) {
  const b = i * ZW;
  let h = ZOB[b + p.owner * 2 + (p.rank === "queen" ? 1 : 0)];
  if (p.form) h ^= ZOB[b + 4 + (FORM_SLOT[p.form] || 0)];
  if (p.armor) h ^= ZOB[b + 12];
  if (p.hollow && p.owner === AI.side) h ^= ZOB[b + 13];   // ours only — see above
  if (p.quantum) h ^= ZOB[b + 14];                         // the LINK is public
  if (p.twin) h ^= ZOB[b + 15];
  if (p.frozen > 0) h ^= ZOB[b + 16 + (p.frozen > 1 ? 1 : 0)];
  if (p.p_frozen > 0) h ^= ZOB[b + 18];
  if (p.noCapture > 0) h ^= ZOB[b + 19];
  if (p.eyeMark > 0) h ^= ZOB[b + 20];
  return h;
}

/** The whole board from scratch. Once per search, never per node. */
function boardHash() {
  let h = 0;
  for (let i = 0; i < CELLS; i++) { const p = G.board[i]; if (p) h ^= pieceHash(p, i); }
  return h;
}

let AI_HASH = 0;

/* The squares one step can disturb. Reused rather than allocated: applyStep
   runs millions of times a search, and it never re-enters itself between
   filling this and reading it back — expandChain recurses AROUND applyStep,
   not through it.

   Being generous with what goes in here costs nothing at all. A square whose
   occupant does not change is XORed out and then straight back in, and XOR
   undoes itself. Being STINGY is what would cost, so the list is built from
   what a step could touch rather than what it will. */
const ZTOUCH = new Int32Array(8);
let ZTN = 0;
function ztAdd(i) {
  if (i < 0) return;
  for (let k = 0; k < ZTN; k++) if (ZTOUCH[k] === i) return;   // never twice: XOR would cancel
  ZTOUCH[ZTN++] = i;
}

/**
 * One life between two bodies: when a twinned body leaves the board, the other
 * half goes with it. This is removePiece's tail and severTwin, minus the
 * logging and the animation — see engine.js removePiece.
 *
 * Both ends of the link are cleared and both are recorded, because undoStep has
 * to put the `twin` id back on the survivor as well as on the body that died.
 * A pair is rare enough that the allocation here is never on the hot path.
 *
 * `G.twinStep` is deliberately NOT touched. The engine clears it when the
 * partner owed a movement, but the search has no concept of that obligation —
 * it explores one movement per turn per side — so there is nothing here to
 * clear. The live driver still takes the second movement; see aiFinishMove.
 */
function aiSeverTwin(host, hostIdx, rec) {
  const id = host.twin;
  if (!id) return;
  const j = twinPartner(id, hostIdx);
  host.twin = 0;
  const partner = j >= 0 ? G.board[j] : null;
  if (partner) { partner.twin = 0; G.board[j] = null; }
  (rec.severed || (rec.severed = [])).push({ host, id, idx: j, piece: partner });
}

/**
 * Execute one hop on the live board, fast, and return what undoStep needs to
 * put it back. No logging, no Focus, no penalties — this is the search's
 * private copy of the referee, and it has to agree with the real one about
 * WHAT ENDS UP ON THE BOARD or the tree is scoring positions that cannot occur.
 *
 * Two of the cards need a word about how they are modelled here.
 *
 * TEMPORAL TWIN is unambiguous and entirely public, so it is simply obeyed: a
 * jump that kills one body kills both, and so does a coronation. Anything less
 * and the search undervalues every capture on a twinned pawn by a whole pawn.
 *
 * QUANTUM PAWN cannot be obeyed, because obeying it would mean reading
 * `quantumReal` — which half is the real pawn — and that field is the entire
 * card. So the jump is modelled by what is true in BOTH outcomes and no more:
 *
 *   - The struck body always leaves the board. If it was real it was captured;
 *     if it was not, collapseQuantum nulls the square anyway. Either way that
 *     square is empty afterwards.
 *   - The partner is left exactly as it stands, link and all. Half of a
 *     superposition is already priced at half a pawn in sideScore, and half a
 *     pawn is precisely the expected value of a body that is a whole pawn half
 *     the time and nothing the other half. The existing discount IS the model.
 *   - The chain stops. This is the part the old code got wrong and the part
 *     that actually costs games: a jump into a superposition may whiff, and a
 *     whiff takes nothing and continues nothing (engine.js performMove). A
 *     search that plans four hops through a superposition is planning on a coin
 *     landing its way, and it should not be allowed to.
 *
 * Two consequences are left deliberately unmodelled, both coin flips the
 * machine has no right to resolve: the lifetime capture tally is incremented as
 * though the jump connected (it only gates the Phaser), and an Eye For An Eye
 * mark on a superposed body does not drag the attacker down.
 */
function applyStep(from, mv) {
  const p = G.board[from];
  const rec = {
    from, to: mv.to, kind: mv.kind, piece: p,
    prevRank: p.rank, prevCaptures: p.captures,
    victimIdx: -1, victimPiece: null, victimKeptArmor: false, victimKeptShell: false,
    victimFledTo: -1, victimHome: -1,
    attackerDied: false, swapped: null, promoted: false,
    quantumHalt: false, severed: null, prevHash: AI_HASH,
  };

  // Everything this step could disturb, XORed out of the hash now and back in
  // at the bottom. undoStep does not reverse any of it — it just restores
  // prevHash, which is both cheaper and impossible to get subtly wrong.
  ZTN = 0;
  ztAdd(from); ztAdd(mv.to);
  if (p.twin) ztAdd(twinPartner(p.twin, from));         // a promotion severs it
  if (mv.kind === "capture") {
    const v0 = G.board[mv.victim];
    ztAdd(mv.victim);
    if (v0.hollowHome >= 0) ztAdd(v0.hollowHome);       // where a shell retreats to
    if (v0.twin) ztAdd(twinPartner(v0.twin, mv.victim));
  }
  let zh = AI_HASH;
  for (let k = 0; k < ZTN; k++) { const q = G.board[ZTOUCH[k]]; if (q) zh ^= pieceHash(q, ZTOUCH[k]); }

  if (mv.kind === "capture") {
    const v = G.board[mv.victim];
    rec.victimIdx = mv.victim;
    rec.victimPiece = v;
    // The superposition is settled before anything else looks at the victim,
    // in the same order resolveCapture settles it — armor, the shell and the
    // Eye's mark all assume there is a piece there to reason about.
    if (v.quantum) { G.board[mv.victim] = null; rec.quantumHalt = true; }
    else if (v.armor) { v.armor = false; rec.victimKeptArmor = true; }
    else if (aiOwnShell(v)) {
      rec.victimKeptShell = true;
      rec.victimHome = v.hollowHome;
      v.hollow = false; v.hollowHome = -1;
    }
    else { G.board[mv.victim] = null; aiSeverTwin(v, mv.victim, rec); }
    G.board[from] = null;
    G.board[mv.to] = p;
    // The retreat, mirroring breakShell — and for the same reason it is done
    // here and not before the landing: home may BE the landing square, and an
    // occupied home means the pawn stays put.
    if (rec.victimKeptShell) {
      const h = rec.victimHome;
      if (h >= 0 && h !== mv.victim && !G.board[h] && !isBarrier(h)) {
        G.board[mv.victim] = null;
        G.board[h] = v;
        rec.victimFledTo = h;
      }
    }
    // A jump that broke on a shell took nothing, so it must not count toward
    // the lifetime tally that gates the Phaser — same as the engine.
    if (!rec.victimKeptShell) p.captures++;
    // Eye For An Eye drags the capturer down with its prey. Nothing died to a
    // shell, so nothing is avenged and the mark is not spent — and a jump at a
    // superposition avenges nothing it can be sure of, so it is left alone.
    if (!rec.victimKeptArmor && !rec.victimKeptShell && !rec.quantumHalt && v.eyeMark > 0) {
      G.board[mv.to] = null; rec.attackerDied = true;
      // The attacker's own pair, if it had one, dies with it.
      aiSeverTwin(p, mv.to, rec);
    }
  } else if (mv.kind === "swap") {
    const other = G.board[mv.to];
    rec.swapped = other;
    G.board[mv.to] = p;
    G.board[from] = other;
  } else {
    G.board[from] = null;
    G.board[mv.to] = p;
  }

  if (!rec.attackerDied && p.rank === "pawn" && rowOf(mv.to) === promoRow(p.owner)) {
    p.rank = "queen";
    rec.promoted = true;
    // A twin cannot be in two ranks at once, so promoteIfDue severs the pair
    // before it crowns anybody: the crown is worth the other body. Without this
    // the search would happily promote its way out of a twin for free.
    aiSeverTwin(p, mv.to, rec);
  }

  // Last, after the promotion — the rank is part of what a square hashes to.
  for (let k = 0; k < ZTN; k++) { const q = G.board[ZTOUCH[k]]; if (q) zh ^= pieceHash(q, ZTOUCH[k]); }
  AI_HASH = zh;
  return rec;
}

function undoStep(rec) {
  const p = rec.piece;
  p.rank = rec.prevRank;
  p.captures = rec.prevCaptures;
  AI_HASH = rec.prevHash;
  // Severed partners come back FIRST, mirroring an engine that takes them
  // LAST: removePiece clears the body it was called on and only then reaches
  // for the other half. Ordering is a matter of reading rather than of
  // correctness here — a partner cannot have been standing on the square the
  // attacker left, the square it landed on, or the square it took — but a
  // make/unmake pair that mirrors its engine is one fewer thing to re-derive.
  if (rec.severed) {
    for (let k = rec.severed.length - 1; k >= 0; k--) {
      const s = rec.severed[k];
      s.host.twin = s.id;
      if (s.piece) { s.piece.twin = s.id; G.board[s.idx] = s.piece; }
    }
  }
  if (rec.kind === "capture") {
    // The fled square is cleared FIRST, before the attacker goes back. A
    // retreat can land on the square the attacker jumped FROM — it was empty by
    // then — and clearing afterwards would erase the attacker we had just put
    // back there.
    if (rec.victimFledTo >= 0) G.board[rec.victimFledTo] = null;
    G.board[rec.to] = null;
    G.board[rec.from] = p;
    if (rec.victimKeptArmor) rec.victimPiece.armor = true;
    if (rec.victimKeptShell) {
      rec.victimPiece.hollow = true;
      rec.victimPiece.hollowHome = rec.victimHome;
    }
    G.board[rec.victimIdx] = rec.victimPiece;
  } else if (rec.kind === "swap") {
    G.board[rec.from] = p;
    G.board[rec.to] = rec.swapped;
  } else {
    G.board[rec.to] = null;
    G.board[rec.from] = p;
  }
}

const applySeq = (steps) => steps.map((s) => applyStep(s.from, s.mv));
const undoSeq = (recs) => { for (let k = recs.length - 1; k >= 0; k--) undoStep(recs[k]); };

/* ── whole-turn move generation ─────────────────────────────────────────────
   A search "move" is an ENTIRE turn action: a complete capture sequence, or a
   single quiet move. Generating half a chain-jump would let the search evaluate
   positions that can never actually occur.
   ─────────────────────────────────────────────────────────────────────────── */

function expandChain(origin, at, steps, out, owner) {
  const caps = captureMoves(at);
  if (!caps.length) { out.push({ steps: steps.slice(), capture: true, from: origin, to: at }); return; }
  for (const mv of caps) {
    const rec = applyStep(at, mv);
    steps.push({ from: at, mv });
    const stillThere = !rec.attackerDied && G.board[mv.to];
    // `quantumHalt` is the jump that may have found nothing. The engine ends
    // the sequence there whether it did or not — a chain is a chain of
    // CAPTURES, and half the time that was not one — so the search must not
    // keep extending past it and plan on the coin landing its way.
    //
    // The Sentinel used to add a fourth way to halt here and no longer exists;
    // promotion is now the only thing that stops a sequence the attacker
    // survived. performMove agrees — see engine.js.
    const halt = !stillThere || rec.promoted || rec.quantumHalt;
    if (halt) out.push({ steps: steps.slice(), capture: true, from: origin, to: mv.to });
    else expandChain(origin, mv.to, steps, out, owner);
    steps.pop();
    undoStep(rec);
  }
}

/**
 * Every legal turn action for `owner`.
 * Captures are mandatory, so when any exist the machine only considers those —
 * declining one costs a piece, which is almost never worth it.
 */
function turnMoves(owner) {
  const out = [];
  const capturers = capturersFor(owner);
  if (capturers.length) {
    for (const i of capturers) expandChain(i, i, [], out, owner);
    return out;
  }
  for (let i = 0; i < CELLS; i++) {
    if (!isAlly(G.board[i], owner)) continue;
    for (const mv of simpleMoves(i))
      out.push({ steps: [{ from: i, mv }], capture: false, from: i, to: mv.to, kind: mv.kind });
  }
  return out;
}

/**
 * The same list, minus anything Stutter has forbidden — what the machine may
 * actually choose from at the ROOT of its search.
 *
 * Only at the root. Deeper plies are later turns, where the ban has long since
 * been spent, so filtering inside turnMoves would quietly delete legal replies
 * from every branch of the tree.
 *
 * The machine does not end its turn through the referee, so the refusal in
 * dispatchAction never binds it. Without this it would replay the very move
 * that was unmade, be refused online, and offline simply take it — getting
 * away with what a player cannot.
 */
function rootMoves(owner) {
  const moves = turnMoves(owner);
  if (!G.stutter || G.stutter.player !== owner || !G.stutter.banned) return moves;
  const legal = moves.filter((m) =>
    !stutterBans(owner, { t: "move", from: m.from, to: m.to, kind: m.kind }));
  // If the banned move was the only one, the ban has already stopped binding
  // and stutterBans says so — but be explicit rather than returning an empty
  // list and leaving the machine with nothing to play.
  return legal.length ? legal : moves;
}

/* ── evaluation ─────────────────────────────────────────────────────────────
   Public information only. Reading the opponent's hand would be cheating, so
   only hand SIZE is ever consulted.
   ─────────────────────────────────────────────────────────────────────────── */

const VAL_PAWN = 100, VAL_QUEEN = 250;
const VAL_FORM = { juggernaut: 35, phaser: 55, herald: 55, enchanter: 130, alchemist: 95 };
const VAL_ARMOR = 60;

/**
 * Focus Points and cards with DIMINISHING RETURNS, which matters more than it
 * sounds. With flat values the machine discovers that drawing (+1 FP, +1 card)
 * always scores better than any quiet move, and simply draws every turn
 * forever. In truth a turn only lets you spend so much: the ninth Focus Point
 * and the fourth card are nearly dead weight, so their marginal value has to
 * fall below the worth of actually developing the position.
 */
function resourceValue(fp, cards) {
  // Focus past the ceiling is not merely worth less, it does not exist: the
  // referee refuses to bank it. Clamping here is what stops the machine paying
  // a real tempo cost for income it can never collect.
  const banked = Math.min(fp, FP_CAP);
  return Math.min(banked, 6) * 14 + Math.max(0, banked - 6) * 4
       + Math.min(cards, 3) * 20 + Math.max(0, cards - 3) * 4;
}

/* ── the mobility term ──────────────────────────────────────────────────────
   How many quiet moves a piece has, counted rather than listed.

   This is the same number `simpleMoves(i).length` gives — the pinned-evaluation
   tests exist to keep it that way — but it is arrived at without building an
   array of move objects for every piece on the board at every leaf of the
   search. Measured on a 46-piece midgame: the mobility term was 2.24µs of
   sideScore's 3.68µs, and sideScore itself was between a third and two fifths
   of the entire search.

   The Enchanter is the reason this has its own function rather than being a
   tighter loop in place. Its move is a SWAP WITH ANY PIECE ANYWHERE, so
   simpleMoves walks all 144 squares for it — and the answer it walks 144
   squares to compute is "how many pieces are on the board, less itself". One
   Enchanter cost about 1.3µs of every evaluation in the game. Now it costs a
   subtraction, and the count it subtracts from is gathered once per side
   rather than once per Enchanter.
   ─────────────────────────────────────────────────────────────────────────── */
/* How many squares are occupied, gathered at most once per sideScore call and
   only when something actually asks. Almost no position has an Enchanter in
   it, and every position would otherwise pay for the count. Module-level
   rather than a closure for the same reason ZTOUCH is: a closure here is an
   allocation, and this runs twice per leaf. sideScore never re-enters itself,
   so one scratch value is safe. */
let AI_OCC = -1;
function aiOccupied() {
  if (AI_OCC < 0) { let n = 0; for (let j = 0; j < CELLS; j++) if (G.board[j]) n++; AI_OCC = n; }
  return AI_OCC;
}

/** How many of `side`'s pieces stand diagonally beside `i`. adjacentTo without
 *  the array — same answer, no allocation. */
function aiAdjacentAllies(i, side) {
  const r = rowOf(i), c = colOf(i);
  let n = 0;
  for (const [dr, dc] of DIAG) {
    const j = cellAt(r + dr, c + dc);
    if (j >= 0 && isAlly(G.board[j], side)) n++;
  }
  return n;
}

function aiMobility(i, p) {
  if (!canAct(p)) return 0;                      // exactly simpleMoves' own guard
  const r = rowOf(i), c = colOf(i);
  let n = 0;
  for (const [dr, dc] of moveDirs(p)) {
    const j = cellAt(r + dr, c + dc);
    if (j >= 0 && !G.board[j] && !isBarrier(j)) n++;
  }
  if (p.form === "phaser") {
    for (const [dr, dc] of ORTHO) {
      const j = cellAt(r + dr, c + dc);
      if (j >= 0 && !G.board[j] && !isBarrier(j)) n++;
    }
  }
  if (p.form === "enchanter") n += aiOccupied() - 1;
  return n;
}

/* WHAT WAS MEASURED, AND WHAT WAS LEFT ALONE. On a 48-piece board this costs
   about 4.2µs, and evaluate() calls it twice at every leaf — between a third
   and two fifths of an entire Ruthless search. Of that 4.2µs, roughly 3.0 is
   the mobility loop, 1.1 the per-piece material and position, and 0.08 the
   tail below (Focus, hands, the board-altering spells).

   Keeping a running material total in applyStep/undoStep was considered and
   not done. It can only ever reach that 1.1µs — about a tenth of the search —
   and it would put a second, silently-desynchronisable copy of the evaluator
   inside the make/unmake path, which is the one place in this file where a
   quiet mistake is invisible until the machine starts playing badly. The
   mobility loop was the expensive part and it was cheap to fix.

   Caching the tail per search was also considered. It is 2% of this function,
   and it would need invalidating against a G that tests and the policy layer
   both replace underneath it. Not worth the trap. */
function sideScore(side) {
  let s = 0, mobility = 0;
  AI_OCC = -1;
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (!p || p.owner !== side) continue;
    s += p.rank === "queen" ? VAL_QUEEN : VAL_PAWN;
    if (p.armor) s += VAL_ARMOR;
    if (p.form) s += VAL_FORM[p.form] || 0;
    // Half of a superposition is worth half a pawn, because half of it is not
    // there. Reading `quantum` is fair — the link is public, and both players
    // can count the bodies — but `quantumReal` is never touched, here or
    // anywhere else the machine looks. That is the blindness contract.
    if (p.quantum) s -= VAL_PAWN / 2;
    // A twinned body is a whole pawn — both are real — but the pair shares one
    // life, so a single jump collects both. Priced on each half, which comes to
    // roughly a third of the pair.
    //
    // applyStep now takes both bodies when either dies, so within the horizon
    // the search prices a shared life for itself and this term is only the
    // standing risk beyond it. Left where it is: a pair the search cannot
    // currently reach is still a pair worth less than two pawns, and a term
    // that vanished as soon as a capture came into view would make the machine
    // value its own twins differently depending on how far it could see.
    if (p.twin) s -= 34;
    if (p.rank === "pawn") {
      // Closer to the crown is worth more; the last two rows sharply so.
      // Weighted heavily enough that developing beats sitting still.
      const dist = Math.abs(rowOf(i) - promoRow(side));
      s += Math.max(0, (11 - dist)) * 7;
      if (dist <= 2) s += 30;
    }
    // Holding your own back row denies the enemy a crowning square.
    if (rowOf(i) === homeRow(side)) s += 8;
    if (p.frozen > 0) s -= 20 * Math.min(p.frozen, 2);
    if (p.p_frozen > 0) s -= 12;                // a penalty already owed
    if (p.noCapture > 0) s -= 14;
    if (p.eyeMark > 0) s += 18;                 // a deterrent the enemy must respect
    if (!isImmobile(p)) mobility += aiMobility(i, p);
  }
  const P = G.players[side];
  s += resourceValue(P.fp, P.hand.length);      // hand SIZE only — never contents
  s += P.extraTurns * 90;
  s += mobility * 3;
  // Being locked out of your own options is a real cost, so price it.
  s -= Math.min(P.noSpells, 2) * 16;
  s -= Math.min(P.noDraw, 3) * 7;
  s -= Math.min(P.noTransform, 3) * 6;
  if (P.costCap > 0) s -= 10;

  // The board-altering spells leave their effect in fields of their own rather
  // than on any piece. Without a term here the evaluator cannot see the
  // difference the cast made, aiSimValue returns roughly the baseline, and the
  // machine quietly decides every one of them is worthless — so each gets
  // priced, however roughly.
  //
  // The mobility loop above already reflects a Chokepoint's seal and a live
  // Wraparound, since both change what simpleMoves returns; these are the
  // things it CANNOT see.
  if (G.mustCapture && G.mustCapture.player === side) s -= 12;   // an obligation, not an option
  // Stutter, priced as a cost to its VICTIM — which evaluate() turns into the
  // caster's gain for free. This is only half the judgement, and deliberately
  // the flat half: what a stutter is worth depends almost entirely on the
  // position, and that part is measured once per turn by aiStutterGap() rather
  // than guessed at again on every leaf. See STUTTER_DENIAL for the numbers.
  // Constant across a search once it is set, so it moves the decision to cast
  // and nothing else.
  if (G.stutter && G.stutter.player === side)
    s -= G.stutter.banned ? STUTTER_DENIAL + 20 : STUTTER_DENIAL;
  if (G.rift) {
    // A rift is worth most to whoever has a piece near a mouth, and it is
    // open to both sides — so price proximity, not ownership.
    //
    // Counted rather than collected, for the reason aiMobility is: adjacentTo
    // builds an array, and the only thing wanted from it here is how long it
    // is. Measured at 0.43µs of every evaluation for as long as a rift stands
    // open, which is a tenth of the evaluator for a term worth a few points.
    s += 6 * (aiAdjacentAllies(G.rift.a, side) + aiAdjacentAllies(G.rift.b, side));
  }
  return s;
}

function evaluate(owner) { return sideScore(owner) - sideScore(1 - owner); }

/* ── search ─────────────────────────────────────────────────────────────── */

/* ── move-ordering memory ───────────────────────────────────────────────────
   Alpha-beta only prunes when a good move is tried early, so what follows is
   pure ordering: it never changes what a position is WORTH, only how soon the
   search can stop looking. Both tables are wiped at the start of each machine
   turn and again at the top of searchBestMove, so a killer learned on a board
   that no longer exists can never mislead the next one. Within a single search
   they are shared freely — that sharing is the entire point.

   A move here is a whole turn action, so its identity is the piece's origin,
   its final square, and how many hops it took. Two different chains from the
   same square to the same square with the same length are close enough to the
   same idea for an ordering hint.
   ─────────────────────────────────────────────────────────────────────────── */

const moveKey = (m) => `${m.from}:${m.to}:${m.steps.length}`;
let KILLERS = [];          // KILLERS[ply] = [keyA, keyB], most recent first
let HISTORY = new Map();   // key -> how often, and how deep, it caused a cutoff

/* ── the transposition table ────────────────────────────────────────────────
   "I have scored this exact position to at least this depth before, and here is
   the answer." Unlike the two tables above, this one is NOT a pure ordering
   hint — it returns scores, and a wrong entry is a wrong move. So the rules
   about when an entry may be trusted are the whole of the design.

   THE HASH COVERS THE BOARD. The evaluation does not: resourceValue reads Focus
   and hand size, and there are terms for G.stutter, G.rift, G.mustCapture and
   P.extraTurns, none of which are pieces on squares. That is sound only for as
   long as those cannot change, which within a single search they cannot —
   applyStep moves pieces and nothing else.

   Between searches they very much can, and the POLICY layer changes them on
   purpose: aiSimValue casts a spell on a snapshot and searches the result, so
   the same board with the same pieces is genuinely worth something different.
   Hence AI_EPOCH — a counter bumped at the start of every search, stamped on
   every entry, and checked on every probe. An entry from a previous epoch is
   not evicted, it is simply invisible, which costs nothing and means no array
   ever has to be cleared.

   AI_TT switches the whole thing off. The tests use it to prove the table
   changes what the search COSTS and not what it CONCLUDES.
   ─────────────────────────────────────────────────────────────────────────── */

const TT_BITS = 16, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
const TT_KEY = new Int32Array(TT_SIZE);
const TT_SCORE = new Int32Array(TT_SIZE);
const TT_DEPTH = new Int8Array(TT_SIZE);
const TT_FLAG = new Int8Array(TT_SIZE);
const TT_EPOCH = new Int32Array(TT_SIZE);
let AI_EPOCH = 0;
let AI_TT = true;

/* Mate scores are counted from the ROOT — that is what makes a faster win score
   higher — but the same position can sit at different distances from the root
   down two different branches. So a mate is converted to a distance from THIS
   node on the way in and back again on the way out. Without it the table hands
   a mate-in-two to a node that is really five plies further along, and the
   machine goes hunting for a win that is not there yet. */
const ttIn = (s, ply) => (s > MATE / 2 ? s + ply : s < -MATE / 2 ? s - ply : s);
const ttOut = (s, ply) => (s > MATE / 2 ? s - ply : s < -MATE / 2 ? s + ply : s);

/**
 * Begin a search: nothing remembered from the last one may be trusted, and the
 * hash has to be built from the board in front of us.
 *
 * Every place that sets AI_DEADLINE for a fresh search calls this, because
 * those are exactly the places where the off-board state may have moved.
 */
function aiNewSearch() {
  AI_EPOCH++;
  AI_HASH = boardHash();
}

function clearOrderingMemory() {
  KILLERS = []; HISTORY = new Map();
  // And the transposition table with them. It must never outlive a turn: the
  // hash says nothing about Focus, hands, chokepoints or anchors, and all of
  // those move between one turn and the next.
  AI_EPOCH++;
}

/** Remember a move that just caused a beta cutoff. Captures are already first. */
function rememberCutoff(m, ply, depth) {
  const key = moveKey(m);
  HISTORY.set(key, (HISTORY.get(key) || 0) + depth * depth);
  if (m.capture) return;                    // the static ordering already finds these
  const slot = KILLERS[ply] || (KILLERS[ply] = []);
  if (slot[0] === key) return;
  slot.unshift(key);
  slot.length = Math.min(slot.length, 2);
}

function orderMoves(moves, ply = 0) {
  const killers = KILLERS[ply];
  for (const m of moves) {
    let k = 0;
    if (m.capture) k += 1000 + m.steps.length * 500;
    const p = G.board[m.from];
    if (p && p.rank === "pawn" && rowOf(m.to) === promoRow(p.owner)) k += 800;
    if (p && p.rank === "pawn") k += (11 - Math.abs(rowOf(m.to) - promoRow(p.owner))) * 3;
    if (killers || HISTORY.size) {
      const key = moveKey(m);
      // A killer outranks every quiet move but never jumps ahead of a capture.
      if (killers) { const j = killers.indexOf(key); if (j >= 0) k += 700 - j * 100; }
      // History is a tiebreaker, capped so it can never drown the tactics above.
      k += Math.min(HISTORY.get(key) || 0, 400);
    }
    m._k = k;
  }
  return moves.sort((a, b) => b._k - a._k);
}

/* ── quiescence ─────────────────────────────────────────────────────────────
   Captures only, so the search never stops in the middle of a trade.

   THERE IS NO STAND-PAT HERE, and that is the one thing about this function
   worth knowing. "Standing pat" is the chess technique of assuming the side to
   move can simply decline to capture and bank the position as it stands, which
   puts a floor under the score: no sequence of trades can make things worse
   than not trading at all.

   In chess that is true. Here it is false — captures are compulsory, which is
   why turnMoves offers nothing else when one exists, and why the referee
   refuses a quiet move with a jump on the board. A side that is forced into a
   losing exchange has no walking away from it, and a floor under the score is
   simply a lie about a position the machine has looked directly at. It was
   worth a piece to it, repeatedly: every trap that works by making a bad
   capture mandatory read as free.

   So the capture list is fetched FIRST, and the floor is only laid down when
   the list is empty — when declining really is an option because there is
   nothing to decline.
   ─────────────────────────────────────────────────────────────────────────── */
function quiesce(owner, alpha, beta, ply, base = 0) {
  // Capture chains can fan out badly in a crowded midgame, so this honours the
  // clock too — without it a single quiescence call could run unbounded.
  if ((++AI_NODES & 511) === 0 && aiOutOfBudget()) AI_TIMEUP = true;

  /* A board swept clean is a WIN, not a large material lead, and alphabeta has
     always said so. Quiescence did not, so the one place a forced win is most
     likely to be found — in the middle of a capture flurry, which is the only
     thing this function looks at — was the one place it came back priced as an
     ordinary material edge, and therefore tradeable against one.

     `base` is the caller's distance from the root, and it is threaded through
     so the mate distance stays root-relative, exactly as alphabeta's own
     -MATE + ply is. Counting only the quiescence ply would make a win found
     five plies deep score HIGHER than one found two plies deep, purely because
     the flurry it was found in started later — and the machine would take the
     slower kill. */
  if (countPieces(owner) === 0) return -MATE + base + ply;
  if (countPieces(1 - owner) === 0) return MATE - base - ply;

  const stand = evaluate(owner);
  if (AI_TIMEUP) return stand;

  // Hoisted above the stand-pat rather than fetched twice: this is a leaf
  // function, and it runs at every leaf of every search.
  const caps = capturersFor(owner);

  if (!caps.length) {
    // Genuinely quiet. Nothing to take, so the static score is the answer and
    // the usual bound bookkeeping applies.
    if (stand >= beta) return beta;
    return stand > alpha ? stand : alpha;
  }

  // The horizon, and it is a horizon rather than a claim about legality: the
  // side to move still owes a capture here, but the search has run out of the
  // budget it was given to follow one. A static estimate is the honest answer
  // to "I stopped looking", where the stand-pat above would be the dishonest
  // answer to "I looked and it was fine".
  if (ply > aiCfg().qply) return stand;

  const moves = [];
  for (const i of caps) expandChain(i, i, [], moves, owner);
  // Quiescence sees captures only, which the static ordering already ranks
  // first, so it takes no killer slot — passing -1 keeps its cutoffs out of the
  // main tree's per-ply tables.
  let best = -Infinity;
  for (const m of orderMoves(moves, -1)) {
    const recs = applySeq(m.steps);
    const v = -quiesce(1 - owner, -beta, -alpha, ply + 1, base);
    undoSeq(recs);
    if (v > best) best = v;
    if (best >= beta) return beta;
    if (best > alpha) alpha = best;
    if (AI_TIMEUP) break;
  }
  // The best of the captures, with no floor under it. Every one of them was
  // compulsory, so if they all lose material, losing material is the score.
  return best;
}

/**
 * Negamax with alpha-beta pruning and a transposition table.
 *
 * CALLERS MUST CALL aiNewSearch() FIRST. It is what stamps a fresh epoch on the
 * table and rebuilds AI_HASH from the board actually in front of us; without it
 * this reads a hash left over from somewhere else and probes the table with a
 * name that belongs to another position.
 */
function alphabeta(owner, depth, alpha, beta, ply = 0) {
  if ((++AI_NODES & 511) === 0 && aiOutOfBudget()) AI_TIMEUP = true;
  if (AI_TIMEUP) return evaluate(owner);

  if (countPieces(owner) === 0) return -MATE + ply;
  if (countPieces(1 - owner) === 0) return MATE - ply;
  // `ply` goes in as the base so a mate found down in the flurry is measured
  // from the ROOT, on the same scale as the two lines above.
  if (depth <= 0) return quiesce(owner, alpha, beta, 0, ply);

  // Side to move is part of the position: the same board is worth the negative
  // of itself to the other player.
  const key = owner ? (AI_HASH ^ ZOB_SIDE) : AI_HASH;
  const slot = key & TT_MASK;
  const alphaOrig = alpha;
  if (AI_TT && TT_EPOCH[slot] === AI_EPOCH && TT_KEY[slot] === key && TT_DEPTH[slot] >= depth) {
    const s = ttOut(TT_SCORE[slot], ply);
    const f = TT_FLAG[slot];
    // EXACT is the answer. LOWER and UPPER are bounds from a search that got
    // cut off, and all they can do is narrow the window — which is often
    // enough to close it entirely.
    if (f === TT_EXACT) return s;
    if (f === TT_LOWER) { if (s > alpha) alpha = s; }
    else if (s < beta) beta = s;
    if (alpha >= beta) return s;
  }

  const moves = turnMoves(owner);
  // No movement at all is a loss by blockade unless a spell can rescue it —
  // scored just short of mate so the search still prefers a real capture win.
  if (!moves.length) return -(MATE - 1000) + ply;

  let best = -Infinity;
  for (const m of orderMoves(moves, ply)) {
    const recs = applySeq(m.steps);
    const v = -alphabeta(1 - owner, depth - 1, -beta, -alpha, ply + 1);
    undoSeq(recs);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) { rememberCutoff(m, ply, depth); break; }
    if (AI_TIMEUP) break;
  }

  // Always-replace, which is simpler than replace-if-deeper and very nearly as
  // good. What is NOT stored is a score from a search the clock cut short —
  // that number is whatever the evaluator happened to say when the alarm went
  // off, and it would sit in the table poisoning every later probe.
  if (AI_TT && !AI_TIMEUP) {
    TT_KEY[slot] = key;
    TT_EPOCH[slot] = AI_EPOCH;
    TT_DEPTH[slot] = depth;
    TT_SCORE[slot] = ttIn(best, ply);
    TT_FLAG[slot] = best <= alphaOrig ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
  }
  return best;
}

/**
 * Iterative deepening with a wall-clock cap. Returns { move, score, depth }.
 *
 * THE JITTER IS NOT PART OF THE SEARCH, and keeping those two things apart is
 * most of what this function is careful about. "Search honestly, then choose
 * sloppily" is the intended shape of a level that blunders on purpose; the
 * blunder is meant to be a wrong CHOICE among moves it understood, not a
 * misunderstanding of the moves.
 *
 * It used to be the second thing, in three separate ways:
 *
 *   - the noised value became `alpha`, the "nothing worse than this is worth
 *     looking at" threshold, so one lucky roll on the first move quietly
 *     dismissed later moves for reasons unrelated to the intended blunder rate;
 *   - the noise was added to values that came back through a NARROW window,
 *     where a move that fails low returns an upper bound rather than a score —
 *     and a jittered bound is not a number that means anything, so a move
 *     already proven bad could be promoted;
 *   - it re-rolled at every deepening iteration, so the chosen move flipped at
 *     random between depths and the deepest search did not necessarily decide.
 *
 * So: alpha comes from the raw score, the levels that jitter pay for it with a
 * full root window, and the sampling happens once, at the end, on the finished
 * ranking. Ruthless has noise 0 and none of it applies to it at all.
 *
 * The sample is drawn from a seeded stream, not Math.random — see aiRng.
 */
function searchBestMove(owner) {
  const cfg = aiCfg();
  AI_NODES = 0;
  aiStartBudget(cfg.timeMs);
  clearOrderingMemory();
  aiNewSearch();

  const moves = rootMoves(owner);
  if (!moves.length) return null;
  if (moves.length === 1) return { move: moves[0], score: 0, depth: 0, nodes: 0, forced: true };

  let best = { move: moves[0], score: -Infinity, depth: 0 };
  let ranked = null;               // the last COMPLETED iteration, honestly scored
  for (let d = 1; d <= cfg.depth; d++) {
    let alpha = -Infinity;
    const ordered = orderMoves(moves, 0);
    // The previous pass already told us which move it liked. Searching that one
    // first sets a high alpha immediately, so every sibling gets refuted with a
    // fraction of the work — without this the deepening restarts blind each
    // time and re-discovers the same answer the slow way.
    if (best.depth) {
      const j = ordered.indexOf(best.move);
      if (j > 0) { ordered.splice(j, 1); ordered.unshift(best.move); }
    }
    const round = [];
    for (const m of ordered) {
      const recs = applySeq(m.steps);
      // A narrow window is the right trade when only the BEST move is wanted:
      // anything worse than alpha comes back as a bound and nobody cares what
      // it really was. A level that jitters needs every move to carry a real
      // number, so it buys them with a full window. Novice and Skilled search
      // shallowly enough to afford losing root pruning; Ruthless never gets
      // here, because Ruthless does not blunder.
      const v = cfg.noise
        ? -alphabeta(1 - owner, d - 1, -Infinity, Infinity, 1)
        : -alphabeta(1 - owner, d - 1, -Infinity, -alpha, 1);
      undoSeq(recs);
      if (AI_TIMEUP) break;
      round.push({ move: m, score: v });
      if (v > alpha) alpha = v;    // the RAW score, always. Never the jittered one.
    }
    if (AI_TIMEUP) break;          // half an iteration is not a ranking
    ranked = round;
    let top = round[0];
    for (const r of round) if (r.score > top.score) top = r;
    best = { move: top.move, score: top.score, depth: d };
    // Tested against the honest score, so a jitter can never fake a mate and
    // stop the deepening early.
    if (Math.abs(best.score) > MATE / 2) break;
  }

  // And now, once, on the finished ranking: choose sloppily. One sample per
  // move for the whole search rather than one per move per depth, so the choice
  // cannot flip at random between iterations. Moves sharing a moveKey share a
  // sample — the ordering tables already treat those as the same idea.
  if (cfg.noise && ranked && ranked.length > 1) {
    // One stream per search, drawn from only when a level actually jitters —
    // so a noiseless level does not so much as advance the counter, and
    // Ruthless's play is bit-for-bit what it was before any of this.
    const rng = aiRng(AI_SALT_JITTER);
    const jitter = new Map();
    let pick = null, pickV = -Infinity;
    for (const r of ranked) {
      const key = moveKey(r.move);
      let j = jitter.get(key);
      if (j === undefined) { j = (rng() - 0.5) * 2 * cfg.noise; jitter.set(key, j); }
      const v = r.score + j;
      if (v > pickV) { pickV = v; pick = r; }
    }
    // Reported with its OWN honest score, not the jittered one it won by. The
    // number is logged to the player and read by the tests; it should mean what
    // it says.
    if (pick) best = { move: pick.move, score: pick.score, depth: best.depth };
  }
  best.nodes = AI_NODES;
  return best;
}

/* ── policy layer: spells and transformations ───────────────────────────────
   Rather than hand-written "if threatened then Veil" rules, each candidate is
   SIMULATED on a snapshot and scored by a shallow search of the resulting
   position. The FP cost and the penalty are already reflected in the
   evaluation, so a spell is only cast when it genuinely pays for itself.
   ─────────────────────────────────────────────────────────────────────────── */

/* ── what a search may spend ────────────────────────────────────────────────
   Every search here stops on a budget rather than on its depth ceiling: the
   ceiling is where it would get to given forever, and forever is not on offer
   on the main thread of a web page.

   The budget is normally WALL-CLOCK, which is the right currency for the
   browser — a page that freezes for 800 ms has frozen for 800 ms whatever the
   machine underneath it was doing. It is the wrong currency for anything you
   mean to reproduce, and that is not a small effect: the opening position, at
   Skilled, five searches running, reached depths 2, 3, 4, 4, 4. The first two
   paid for the JIT that the last three then spent. Nothing about that is
   seeded, so seeding the dice does not touch it, and a self-play run that still
   wanders once the dice are pinned is no more use than one that never was.

   So `AI.deterministic` changes the currency to NODES. Same shape — a budget
   that can stop a search mid-iteration, and an iteration stopped that way is
   thrown away rather than half-believed — but counted in a quantity the machine
   cannot vary. Off by default; nothing in the page turns it on.

   THE RATE below is nominal, not measured. Its job is to keep the level knobs
   meaning what they say, so a level given twice the milliseconds still gets
   twice the search; 120 nodes/ms is roughly what a warmed-up V8 manages here,
   which lands a deterministic run near the depth a warm clock-bounded one
   reaches rather than somewhere unrecognisable.

   What this buys is agreement, not portability of strength. A number measured
   this way is a number about THIS budget — but the budget is now written down,
   instead of being however fast the laptop felt that afternoon.
   ─────────────────────────────────────────────────────────────────────────── */

/** Wall-clock budget for one search. Headless self-play runs on a shoestring. */
const aiBudget = (ms) => (AI.fast ? Math.min(ms, 40) : ms);

/**
 * The same budget in nodes. The floor is one check's worth: the counter's low
 * bits are what throttles the budget test (see aiOutOfBudget), so a budget
 * finer than 512 nodes is a budget that never gets looked at.
 */
const AI_NODES_PER_MS = 120;
const aiNodes = (ms) => Math.max(512, Math.round(ms * AI_NODES_PER_MS));

/**
 * Open a budget for a search that is about to start. `ms` is the level's own
 * figure; the fast clamp and the node conversion both happen here, so no call
 * site has to remember either of them.
 */
function aiStartBudget(ms) {
  const budget = aiBudget(ms);
  AI_TIMEUP = false;
  AI_DEADLINE = performance.now() + budget;
  AI_NODE_DEADLINE = AI_NODES + aiNodes(budget);
}

/**
 * Spent? Read once per 512 nodes rather than once per node — the counter's low
 * bits are the throttle, and this is called from the two hottest lines in the
 * file.
 */
const aiOutOfBudget = () =>
  AI.deterministic ? AI_NODES > AI_NODE_DEADLINE : performance.now() > AI_DEADLINE;

function aiSearchValue(owner, depth) {
  aiStartBudget(aiCfg().policyMs);
  // Every call arrives on a different board — usually one with a spell already
  // simulated onto it — so nothing the last one cached applies here. This is
  // the call site the transposition table's epoch exists for.
  aiNewSearch();
  return alphabeta(owner, Math.max(1, depth), -Infinity, Infinity, 0);
}

/**
 * Policy decisions score many candidates, each with its own small search. This
 * caps the whole decision so one beat of the live driver can never block the
 * page for seconds on a crowded board.
 */
const aiPolicyBudget = () => (AI.fast ? 180 : aiCfg().policyBudget);

/**
 * The same budget in the same two currencies, but spanning a whole policy
 * decision rather than one search. Opened once and then asked; the pair exists
 * because the caller has to hold the mark across a loop.
 */
const aiOpenPolicyBudget = () => (AI.deterministic
  ? AI_NODES + aiNodes(aiPolicyBudget())
  : performance.now() + aiPolicyBudget());
const aiPolicySpent = (mark) =>
  (AI.deterministic ? AI_NODES > mark : performance.now() > mark);

/**
 * Apply `mutate` to a throwaway copy of the game, score the result, then put
 * everything back exactly as it was.
 *
 * `G.history` needs explicit care: Chronos's Gaze truncates that array in
 * place, and restore() re-attaches the same array object rather than a copy —
 * so without this the simulation would permanently eat real history entries.
 * Owed discards and sacrifices need no such care: they live on G now, so the
 * snapshot carries them.
 */
function aiSimValue(mutate, movesNext, depth) {
  const snap = snapshot(G);
  const savedHistory = G.history.slice();
  let v = -Infinity;
  try {
    mutate();
    v = movesNext === AI.side
      ? aiSearchValue(AI.side, depth)
      : -aiSearchValue(1 - AI.side, depth - 1);
  } catch (err) {
    v = -Infinity;                                  // a candidate that throws is unplayable
    // The catch stays — one broken candidate must not take the whole turn down
    // with it — but it is not allowed to be SILENT. Scoring a throw as
    // -Infinity makes a genuine bug in a spell path look exactly like a card
    // the machine considered and sensibly declined, and a card that quietly
    // stopped working would never be noticed.
    console.error("AI: a spell candidate threw while being priced; scored as unplayable.", err);
  }
  restore(snap);
  G.history.length = 0;
  for (const h of savedHistory) G.history.push(h);
  return v;
}

const aiEnemyThreats = (owner) => capturersFor(1 - owner);

/** Squares of `owner`'s pieces that the enemy can capture right now. */
function aiAttackedPieces(owner) {
  const hit = new Set();
  for (const i of capturersFor(1 - owner)) for (const mv of captureMoves(i)) hit.add(mv.victim);
  return [...hit];
}

/** Candidate (target, destination) pairs where walking an enemy piece helps us. */
function aiMindControlCandidates() {
  const out = [];
  for (const i of mindControlTargets(AI.side)) {
    for (const mv of simpleMoves(i)) {
      if (mv.kind !== "step") continue;
      const rec = applyStep(i, mv);
      const gain = capturersFor(AI.side).length;
      undoStep(rec);
      if (gain) out.push({ target: i, to: mv.to });
    }
  }
  return out.slice(0, aiWide(6));
}

/** A pruned shortlist of plausible casts — never every legal target. */
function aiSpellCandidates(phaseName) {
  const P = G.players[AI.side];
  const have = (id) => P.hand.includes(id);
  const basicOnly = aiCfg().spells === "basic";
  const out = [];
  const attacked = aiAttackedPieces(AI.side);

  if (phaseName === "end") {
    if (have("hopscotch") && G.lastCapture) out.push({ id: "hopscotch", payload: {} });
    if (!basicOnly && have("mirror"))
      for (const q of mirrorTargets(AI.side).slice(0, aiWide(3))) out.push({ id: "mirror", payload: { from: q } });
    return out;
  }

  // Stun whatever is actually threatening us, plus enemy queens.
  if (have("veil")) {
    const threats = aiEnemyThreats(AI.side);
    const juicy = threats.concat(
      veilTargets(AI.side).filter((i) => G.board[i].rank === "queen" || G.board[i].form));
    for (const t of [...new Set(juicy)].slice(0, aiWide(6))) out.push({ id: "veil", payload: { target: t } });
  }
  // Retreat a pawn that is about to be taken.
  if (have("evasive")) {
    const safe = new Set(evasiveTargets(AI.side));
    for (const i of attacked.filter((i) => safe.has(i)).slice(0, aiWide(4)))
      for (const to of evasiveDests(i, AI.side)) out.push({ id: "evasive", payload: { from: i, to } });
  }
  // Transformations — cast like any other spell now. Considered regardless of
  // `basicOnly`, matching how the old direct transform action was never gated
  // by the AI's spell-tactics setting.
  /* The sacrifice-bearing spells offer two choices of victim, not one.
     Which pawn you spend can matter more than whether you cast at all — a
     Juggernaut armored with a pawn two squares from its crown is a bad trade
     wearing a good card — and the simulation is perfectly able to tell the
     difference if it is given both to look at. Two rather than all of them:
     each extra option is a full clone-and-search, and the pool is ordered
     sensibly enough that the third is rarely the answer. */
  if (have("juggernautSpell"))
    for (const i of juggernautTargets(AI.side).slice(0, aiWide(3)))
      for (const s of juggernautArmorPool(i).slice(0, 2))
        out.push({ id: "juggernautSpell", payload: { target: i, sacrifice: s } });
  if (have("heraldSpell"))
    for (const i of heraldTargets(AI.side).slice(0, aiWide(3)))
      out.push({ id: "heraldSpell", payload: { target: i } });
  if (have("enchanterSpell"))
    for (const i of enchanterTargets(AI.side).slice(0, aiWide(3)))
      for (const opt of enchanterSacrificeOptions(i).slice(0, 2))
        out.push({ id: "enchanterSpell", payload: { target: i, sacrifices: opt } });
  if (have("alchemistSpell"))
    for (const i of alchemistTargets(AI.side).slice(0, aiWide(3))) {
      // The furthest from promotion and the furthest back are usually the same
      // pawn and occasionally are not; when they differ, the difference is
      // exactly the judgement worth making.
      for (const spot of new Set([aiCheapestPawn(AI.side), aiRearmostPawn(AI.side)]))
        if (spot >= 0) out.push({ id: "alchemistSpell", payload: { target: i, sacrifice: spot } });
    }
  if (basicOnly) return out;

  if (have("mirror"))
    for (const q of mirrorTargets(AI.side).slice(0, aiWide(3))) out.push({ id: "mirror", payload: { from: q } });
  if (have("eye"))
    for (const i of eyeTargets(AI.side).filter((i) => attacked.includes(i)).slice(0, aiWide(4)))
      out.push({ id: "eye", payload: { target: i } });
  if (have("mindcontrol"))
    for (const c of aiMindControlCandidates())
      out.push({ id: "mindcontrol", payload: { target: c.target }, follow: c });
  if (have("phaserSpell"))
    for (const i of phaserTargets(AI.side).slice(0, aiWide(3))) out.push({ id: "phaserSpell", payload: { target: i } });
  if (have("martyr") && P.lostQueens.length) {
    const spot = aiRearmostPawn(AI.side);
    if (spot >= 0) out.push({ id: "martyr", payload: { sacrifice: spot } });
  }
  if (have("cascade")) {
    const spot = aiCheapestPawn(AI.side);
    if (spot >= 0) out.push({ id: "cascade", payload: { sacrifice: spot } });
  }

  /* ── the board-altering four ──────────────────────────────────────────
     Each is offered with the payload the referee will demand, and priced by
     the same simulate-and-search pass as everything else. Tactician is the
     one worth pruning hard: it pays for captures the machine was going to
     take anyway, so it is only a candidate when there is real money in it. */
  if (have("tactician") && !G.hasActed && availableCaptures(AI.side) >= 2)
    out.push({ id: "tactician", payload: {} });
  if (have("chokepoint") && chokepointTarget(AI.side) >= 0)
    out.push({ id: "chokepoint", payload: {} });
  // Hollow is a shield now, and most of what a shield is worth the search can
  // see for itself: applyStep keeps the machine's own shelled pawn alive under
  // an enemy jump, so the leaf position simply holds more material. What it
  // CANNOT see is the concealment — the jumps the opponent never makes because
  // they cannot tell which pawn is carrying the shell — and that is the part
  // that rides in on `bonus`, the same way Stutter's does. It stays out of
  // sideScore, which would price the OPPONENT's shells too and hand the
  // machine a secret it is not entitled to. See STUTTER_DENIAL and aiOwnShell.
  //
  // What can be judged here is which pawn to spend it on: one that is already
  // under the axe, and one with no capture of its own to give up — the
  // no-capture price is permanent, so shelling a live threat throws the threat
  // away to save the pawn.
  if (have("hollow")) {
    const doomed = new Set(attacked);
    for (const c of hollowTargets(AI.side)
      .filter((i) => !captureMoves(i).length)
      .map((i) => ({ i, hot: doomed.has(i), near: adjacentTo(i, (q) => isEnemy(q, AI.side)).length }))
      .filter((c) => c.hot || c.near > 0)
      .sort((a, b) => (b.hot - a.hot) || (b.near - a.near))
      .slice(0, aiWide(3)))
      out.push({ id: "hollow", payload: { target: c.i }, bonus: HOLLOW_SHELL + (c.hot ? 24 : 8 * c.near) });
  }

  // Two spots offered rather than the first that came to hand: where the
  // second body stands is the whole of what these two cards do afterwards.
  if (have("twin") && !G.hasActed)
    for (const i of twinTargets(AI.side).slice(0, aiWide(3)))
      for (const spot of quantumSpots(i).slice(0, 2))
        out.push({ id: "twin", payload: { target: i, spot }, bonus: TWIN_TEMPO });

  if (have("quantum"))
    for (const i of quantumTargets(AI.side).slice(0, aiWide(3)))
      for (const spot of quantumSpots(i).slice(0, 2))
        out.push({ id: "quantum", payload: { target: i, spot }, bonus: QUANTUM_GAMBIT });

  if (have("stutter") && !G.stutter) {
    const gap = aiStutterGap();
    // sideScore prices STUTTER_DENIAL of this flatly, because that much is
    // true of any stutter. The excess is what THIS position is worth, and it
    // rides along as a bonus rather than being guessed at on every leaf.
    if (gap >= STUTTER_DENIAL)
      out.push({ id: "stutter", payload: {}, bonus: gap - STUTTER_DENIAL });
  }
  if (have("echo"))
    for (const i of echoTargets(AI.side).slice(0, aiWide(3)))
      out.push({ id: "echo", payload: { target: i } });
  if (have("wraparound") && !G.wrap)
    out.push({ id: "wraparound", payload: {} });
  // An anchor pins the game at the turn it was cast, so a LATER one pins it
  // further forward and shortens every rewind again. The referee only refuses
  // a second anchor on the very turn the first was cast, so neither may this.
  if (have("anchor") && (!G.anchor || G.anchor.turnNo < G.turnNo))
    out.push({ id: "anchor", payload: {} });
  if (have("rift") && G.rift) {
    // Sealing. The same card does both, and with a rift already open the open
    // rift IS the target — castSpell reads no payload at all. One candidate,
    // no geometry to search.
    out.push({ id: "rift", payload: {} });
  } else if (have("rift")) {
    // Only rifts worth walking into: one mouth beside a piece of ours, the
    // other deep in enemy ground. Every pair would be thousands of candidates.
    const open = openSquares();
    const near = open.filter((j) => adjacentTo(j, (q) => isAlly(q, AI.side)).length);
    const far = open.filter((j) => Math.abs(rowOf(j) - promoRow(AI.side)) <= 2);
    for (const a of near.slice(0, aiWide(2)))
      for (const b of far.slice(0, aiWide(2)))
        if (a !== b) out.push({ id: "rift", payload: { a, b } });
  }
  return out;
}

/* ── which candidates are worth the pricing ─────────────────────────────────
   Pricing ONE candidate costs a structuredClone of the whole game plus a
   shallow search of the result. On a crowded board with a full hand there are
   more candidates than there is budget, so some of them will not be looked at.
   The only question is which.

   It used to be whichever came last, and the order was the order the finder
   happens to build the list in — which is by card type. Veil, Evasive, the
   transformations, Mirror, Eye, Mind Control, Phaser, Martyr, Cascade,
   Tactician, Chokepoint, Hollow, Twin, Quantum, Stutter, Echo, Wraparound,
   Anchor, Rift. Everything from Stutter onwards was, in practice, never
   priced at all. The machine was not judging Rift badly; it had never once
   looked at it.

   Two rules fix that, and the second matters more than the first.

   1. A CHEAP PRE-SCORE, so the budget is spent on the promising end. These
      weights never reach the evaluator and are not comparable with its
      numbers — they only decide what gets measured properly, and being
      roughly right is all that is asked of them.

   2. ONE SLOT PER CARD BEFORE ANY CARD GETS TWO. A card that generates six
      targets could otherwise crowd out a card that generates one, and the
      question "is a Rift worth casting here?" would go unasked because Veil
      had a lot of targets. Every card that offers anything at all gets its
      best offer measured.

   The Tactician gate below is the same reasoning with cheaper arithmetic: it
   pays for captures that were going to happen anyway, so it is not even
   offered unless there are two on the board. Where a static test that sharp
   exists, it belongs in the finder; where it does not, it belongs here.
   ─────────────────────────────────────────────────────────────────────────── */

function aiPreScore(cands) {
  const attacked = new Set(aiAttackedPieces(AI.side));
  for (const c of cands) {
    const pay = c.payload || {};
    const t = pay.target != null ? pay.target : (pay.from != null ? pay.from : -1);
    const p = t >= 0 ? G.board[t] : null;
    // The finder already measured something real for Stutter, Hollow, Twin and
    // Quantum. Nothing here is a better guess than that, so it leads.
    let v = c.bonus || 0;
    if (p) {
      if (attacked.has(t)) v += 60;      // answering a live threat, not a hypothetical
      if (p.rank === "queen") v += 40;   // and answering it on behalf of something worth saving
      if (p.form) v += 25;
      if (p.armor) v += 10;
    }
    // A sacrifice is a pawn out of our own pocket. It can still be the right
    // move, but it should not be measured ahead of something that costs nothing.
    if (pay.sacrifice != null || pay.sacrifices != null) v -= 30;
    // Mind Control candidates are only built when walking the piece hands us a
    // capture, so the finder has already done the hard part.
    if (c.follow) v += 35;
    c.pre = v;
  }
  return cands;
}

/**
 * The candidates that will actually be priced, best first, capped.
 *
 * Capped explicitly rather than by the clock. Letting the budget decide made
 * the shortlist depend on how busy the machine was, which meant a card could
 * be considered in a quiet position and silently skipped in a sharp one — the
 * exact positions where getting it right matters.
 */
function aiShortlist(cands) {
  aiPreScore(cands);
  cands.sort((a, b) => b.pre - a.pre);
  const seen = new Set(), firstOfEach = [], rest = [];
  for (const c of cands) {
    if (seen.has(c.id)) rest.push(c);
    else { seen.add(c.id); firstOfEach.push(c); }
  }
  /* The cap is a bound on the worst case, NOT a tighter budget. Measured on a
     full sandbox hand: 10 cards offer 56 candidates and one costs about 10ms
     to price, so Skilled's 550ms affords roughly 54 and Ruthless's 1000ms
     roughly 98. A cap below those would throw away work the machine had time
     to do — so it sits above them, and in ordinary positions the clock is what
     binds. It earns its place in the crowded position where the candidate
     count runs away, and both it and the clock now say so out loud.

     Never below one-per-card, whatever the arithmetic says: that guarantee is
     the entire point, and a cap that could cut into it would quietly bring
     back the bug this replaced. */
  const cap = Math.max(firstOfEach.length, aiWide(60));
  return firstOfEach.concat(rest).slice(0, cap);
}

/* ── Stutter's worth ────────────────────────────────────────────────────────
   Every other card here is priced by a flat term in sideScore. Stutter cannot
   be, and measuring it is what shows why.

   Sampling best-minus-second-best over a real game, in this evaluator's own
   units: the MEDIAN gap is 0, the 75th percentile is 3, the 90th is 10 — and
   the maximum is 490. Three quarters of the time, denying somebody their best
   turn costs them nothing at all, because their second-best is just as good. A
   flat term would therefore be wrong in both directions at once: far too
   generous in the ordinary position, and nowhere near generous enough in the
   one position out of ten where their reply is close to forced and taking it
   away is worth two pieces.

   So the position-dependent half of the judgement lives here, in the gate,
   where it is computed ONCE per turn rather than at every leaf of the search;
   and the flat half lives in sideScore, priced at this same constant, so that
   a candidate which clears the gate is one the search will also agree to pay
   for. Tactician's `availableCaptures >= 2` gate is the same idea with cheaper
   arithmetic.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * What denying the opponent their best turn is worth right now.
 *
 * Roughly 7 Focus — the card plus its strain — is what the machine gives up,
 * which comes to a little under 80 points of resourceValue. Set at 90 so a
 * cast has to be clearly, not marginally, worth it.
 */
const STUTTER_DENIAL = 90;

/**
 * And what a Hollow's concealment is worth, on the same terms — only the
 * concealment, because the shell itself is no longer invisible to the search.
 *
 * The old number here was 62, roughly what the cast costs, and it was set that
 * way for a reason that has since stopped being true: back when the card was a
 * pure bluff, NO position after the cast could score better than the position
 * before it, so the bonus had to carry the entire case for playing it. It does
 * not any more. applyStep keeps a shelled pawn alive under an enemy jump, so
 * the search now prices the saved pawn on its own. Leaving this at 62 would
 * count the card twice and the machine would spam it.
 *
 * What is left for this constant to cover is the half the search still cannot
 * reach at depth: the opponent declining a jump because they do not know which
 * pawn is shelled. 24 is "worth playing in a quiet position, not worth paying
 * a tempo for" — and the premium at the call site is the part with a real
 * argument behind it: a shell nobody is swinging at has not saved anything.
 */
const HOLLOW_SHELL = 24;

/**
 * And a Quantum Pawn's, on the same footing and for the same reason.
 *
 * The board after the cast is worth roughly what it was before it — an extra
 * body, discounted by half in sideScore because half of it is not there — so
 * the evaluator sees the 5 Focus and the card go out and nothing come back.
 * What comes back is a jump the opponent may spend on empty air, which is a
 * coin flip on a whole tempo plus whatever they gave up to reach it. Set to
 * cover the cast so the machine will make the gamble in a quiet position and
 * will not pay a real positional price for it.
 */
const QUANTUM_GAMBIT = 92;

/**
 * Temporal Twin is the one of the three the evaluator can mostly see for
 * itself: both bodies are real pawns and they show up as material, with the
 * shared life priced against them in sideScore. What it cannot see is the
 * TEMPO — two movements every turn for as long as the pair survives — because
 * the search still explores one movement per turn per side. This covers that,
 * and nothing else.
 */
const TWIN_TEMPO = 45;

function aiStutterGap() {
  // Measured on the position as it stands, which is a turn early: the real
  // stutter lands after this turn finishes. Close enough to tell a forced
  // reply from a free choice, and far cheaper than simulating our own turn
  // first only to measure theirs.
  const foe = 1 - AI.side;
  const moves = orderMoves(turnMoves(foe), 0).slice(0, aiWide(14));
  if (moves.length < 2) return 0;      // nothing to deny, or nothing to deny it with
  // Its own budget. Every alphabeta call reads the shared one, so without this
  // the measurement inherits whatever the last search left behind — usually a
  // deadline already in the past, which makes every reply score the same and
  // quietly reports a gap of zero from every position.
  aiStartBudget(aiCfg().policyMs);
  aiNewSearch();
  let best = -Infinity, second = -Infinity;
  for (const m of moves) {
    const recs = applySeq(m.steps);
    const v = -alphabeta(1 - foe, 1, -Infinity, Infinity, 1);
    undoSeq(recs);
    if (v > best) { second = best; best = v; }
    else if (v > second) { second = v; }
  }
  // A measurement that ran out of time part-way compared an arbitrary subset,
  // so it is not a reason to spend 7 Focus.
  if (AI_TIMEUP) return 0;
  return second === -Infinity ? 0 : best - second;
}

function aiRearmostPawn(owner) {
  let best = -1, bestD = Infinity;
  for (let j = 0; j < CELLS; j++) {
    const q = G.board[j];
    if (!isAlly(q, owner) || q.rank !== "pawn") continue;
    const d = Math.abs(rowOf(j) - homeRow(owner));
    if (d < bestD) { bestD = d; best = j; }
  }
  return best;
}
function aiCheapestPawn(owner) {
  let best = -1, bestD = -1;
  for (let j = 0; j < CELLS; j++) {
    const q = G.board[j];
    if (!isAlly(q, owner) || q.rank !== "pawn" || q.form) continue;
    const d = Math.abs(rowOf(j) - promoRow(owner));      // furthest from promotion
    if (d > bestD) { bestD = d; best = j; }
  }
  return best;
}

/** Cast a candidate for real, including any follow-up the card demands. */
function aiExecuteSpell(c) {
  castSpell(c.id, AI.side, c.payload);
  if (c.id === "mindcontrol" && G.mindControl && c.follow) {
    const from = G.mindControl.piece, to = c.follow.to;
    const p = G.board[from];
    if (p && !G.board[to]) {
      G.board[from] = null;
      G.board[to] = p;
      log(`Mind Control — ${PLAYERS[p.owner].name}'s ${pieceLabel(p)} is walked ${sq(from)} → ${sq(to)}.`, "rule");
      promoteIfDue(to);
      G.lastMove = { from, to };
    }
    G.mindControl = null;
  }
  if (G.owedDiscard && G.owedDiscard.player === AI.side) aiResolveDiscard();
}

function aiResolveDiscard() {
  const od = G.owedDiscard;
  if (!od) return;
  while (od.n > 0) {
    const P = G.players[AI.side];
    if (!P.hand.length) break;
    // Shed what we can least use: the priciest card we cannot currently afford,
    // otherwise the cheapest thing in hand.
    const byCost = [...new Set(P.hand)].sort((a, b) => SPELLS[b].cost - SPELLS[a].cost);
    const drop = byCost.find((id) => SPELLS[id].cost > P.fp) || byCost[byCost.length - 1];
    discardCards(AI.side, [drop], od.why);
    od.n--;
  }
  G.owedDiscard = null;
}

/* ── the turn driver ────────────────────────────────────────────────────── */

/* Pauses exist only so a human can watch the machine move. Headless self-play
   skips them at the call site (`if (!AI.fast) await …`) rather than awaiting an
   already-resolved promise, so the fast path never touches the event loop. */
const aiRender = () => { if (!AI.fast) render(); };

function aiConsiderChronos() {
  const cfg = aiCfg();
  if (cfg.spells === "basic") return false;
  if (spellBlocker("chronos", AI.side)) return false;
  // Furthest back available (up to 2 turns) — undoing more is never worse.
  const opts = chronosTargets(AI.side);
  const turnNo = opts[opts.length - 1];
  const d = cfg.policyDepth;
  const base = aiSearchValue(AI.side, d);
  const v = aiSimValue(() => castSpell("chronos", AI.side, { turnNo }), AI.side, d);
  if (v > base + cfg.chronosEdge) { castSpell("chronos", AI.side, { turnNo }); return true; }
  return false;
}

/**
 * Drawing costs the whole turn for 1 FP and a card. Rather than guess a rule,
 * price it against actually moving: search both and take the better. This is
 * the tempo judgement humans tend to get wrong.
 */
function aiShouldDraw() {
  const P = G.players[AI.side];
  if (P.noDraw > 0 || !eligibleSpellIds().length) return false;
  if (G.drewThisTurn || G.hasActed || G.castThisTurn > 0) return false;
  if (capturersFor(AI.side).length) return false;        // never pass up a capture
  // A drawn turn that Stutter unmade may not simply be drawn again. rootMoves
  // does this for movements; the machine never goes through the referee, so
  // without this it would redraw where a player is refused. See rootMoves.
  if (stutterBans(AI.side, { t: "draw" })) return false;
  const d = aiCfg().policyDepth;
  const base = aiSearchValue(AI.side, d);
  const v = aiSimValue(() => drawSpell(AI.side), 1 - AI.side, d);
  return v > base + 10;
}

/**
 * Consider casting ONE spell. Returns true if it cast something, so the caller
 * can offer it another go. Synchronous by design — see aiStep().
 */
function aiCastOnce(phaseName) {
  if (G.over || G.players[AI.side].noSpells > 0) return false;
  const movesNext = phaseName === "end" ? 1 - AI.side : AI.side;
  // Stutter's ban binds the machine exactly as it binds a player: a cast it
  // unmade may not simply be repeated. Same reasoning as rootMoves — the
  // refusal lives in the referee, and the machine never goes through it.
  const offered = aiSpellCandidates(phaseName).filter((c) =>
    !spellBlocker(c.id, AI.side) && !stutterBans(AI.side, { t: "cast", id: c.id }));
  if (!offered.length) return false;
  const cands = aiShortlist(offered);
  // Silent truncation reads as "everything was considered" when it was not, so
  // say so. Not during headless self-play, which would drown the console.
  if (cands.length < offered.length && !AI.fast)
    console.warn(`AI: pricing ${cands.length} of ${offered.length} spell candidates `
      + `(${offered.length - cands.length} past the shortlist cap).`);
  const cfg = aiCfg();
  const d = cfg.policyDepth;
  const base = phaseName === "end"
    ? -aiSearchValue(1 - AI.side, d - 1)
    : aiSearchValue(AI.side, d);
  let best = null, bestV = base + cfg.castEdge;          // demand a real improvement
  const stop = aiOpenPolicyBudget();
  let priced = 0;
  for (const c of cands) {
    priced++;
    // `bonus` is what a candidate is worth BEYOND anything the evaluator can
    // see from the resulting position. Almost nothing needs it — a Veil's
    // value shows up as a stunned piece, a transformation's as a form — but
    // Stutter's does not: the whole effect is a turn that will not be taken,
    // and no static term can tell a position where that is free from one where
    // it is worth a queen. So the finder measures it and hands the number over
    // rather than teaching sideScore to guess. See STUTTER_DENIAL.
    const v = aiSimValue(() => aiExecuteSpell(c), movesNext, d) + (c.bonus || 0);
    if (v > bestV) { bestV = v; best = c; }
    if (aiPolicySpent(stop)) break;
  }
  if (priced < cands.length && !AI.fast)
    console.warn(`AI: the clock stopped the policy after ${priced} of ${cands.length} candidates.`);
  if (!best) return false;
  aiExecuteSpell(best);
  return true;
}

/**
 * Discharge a Tactician debt before the machine hands over.
 *
 * The referee blocks `endTurn` while the debt stands, but the machine does not
 * end its turn through the referee — aiStep calls endTurnLocal() directly. So
 * the one place the rule would bind is the one place the machine never goes,
 * and without this it could take the Focus and walk away from the captures it
 * was paid for. Captures are already all but mandatory here, so this fires
 * rarely; it exists so the machine cannot get away with what a player cannot.
 */
function aiPayTacticianDebt() {
  let guard = 0;
  while (tacticianDebt(AI.side) && !G.over && guard++ < 12) {
    const from = capturersFor(AI.side)[0];
    const caps = captureMoves(from);
    if (!caps.length) break;
    performMove(from, caps[0]);
    aiFinishMove();
  }
}

/** Tidy up after the last jump of a move: finish any chain, take a Herald step. */
function aiFinishMove() {
  let guard = 0;
  while (G.chain != null && !G.over && guard++ < 12) {
    const caps = captureMoves(G.chain);
    if (!caps.length) { G.chain = null; G.phase = "end"; break; }
    performMove(G.chain, caps[0]);
  }
  if (G.heraldBonus != null && !G.over) {
    const opts = legalHeraldSteps(G.heraldBonus);
    if (opts.length) {
      const at = G.heraldBonus;
      let bestO = opts[0], bestV = -Infinity;
      for (const o of opts) {
        const v = aiSimValue(() => performMove(at, o), 1 - AI.side, 2);
        if (v > bestV) { bestV = v; bestO = o; }
      }
      performMove(at, bestO);
    } else {
      G.heraldBonus = null;
      G.phase = "end";
    }
  }
  // The second half of a Temporal Twin. The referee refuses to end a turn
  // while this is owed, and the machine does not end its turn through the
  // referee — so without this it would simply never take the move the card
  // exists to give it.
  while (twinDebt(AI.side) && !G.over && guard++ < 12) {
    const at = G.twinStep;
    const opts = legalMovesFor(at);
    if (!opts.length) { G.twinStep = null; break; }
    let bestO = opts[0], bestV = -Infinity;
    for (const o of opts) {
      const v = aiSimValue(() => performMove(at, o), 1 - AI.side, 2);
      if (v > bestV) { bestV = v; bestO = o; }
    }
    performMove(at, bestO);
  }
}

/* ── the plan versus the board ──────────────────────────────────────────────
   A turn is CHOSEN under applyStep's model of the rules and PLAYED OUT under
   performMove's. Modelling Temporal Twin and Quantum Pawn closed most of the
   distance between those two, but they will never agree perfectly and they do
   not have to: a quantum whiff, an Eye For An Eye retaliation, an enemy Hollow
   shell the machine is not entitled to see, or an early promotion can each end
   a sequence the search expected to continue. What is left in the plan then
   describes hops from squares that are now empty.

   Nothing crashes if those are played — performMove returns immediately when
   handed an empty square — so the failure is silent, and what the player sees
   is the machine taking half a turn for no stated reason.

   Worse, one case is not silent at all. A promotion closes the SEQUENCE while
   leaving the jump sitting there on the board, still perfectly playable — as
   the Sentinel's halt also did, before that card was retired. Replaying the
   plan through one of those would take a second action in one turn, which no
   player can do. The referee would refuse it; the machine does not go through
   the referee.
   ─────────────────────────────────────────────────────────────────────────── */

/** Is a step the search planned still something the rules allow, right now? */
function aiStepStillLegal(s) {
  const p = G.board[s.from];
  if (!p || p.owner !== AI.side) return false;
  // What authorises this movement at all? Either an open chain, standing at
  // this very square, or the turn's single action still unspent. There is no
  // third answer, and this is the line that keeps a halted sequence from being
  // replayed as a fresh one.
  if (G.chain != null) { if (G.chain !== s.from) return false; }
  else if (G.hasActed) return false;
  return legalMovesFor(s.from).some((o) =>
    o.to === s.mv.to && o.kind === s.mv.kind
    && (s.mv.kind !== "capture" || o.victim === s.mv.victim));
}

/**
 * How often a plan has been abandoned. Not a failure — the board outrunning the
 * plan is a legitimate thing for the concealment cards to cause — but a number
 * that climbs steeply means the search and the referee have drifted apart
 * again, so the self-play tests watch it.
 */
let AI_ABANDONED = 0;

/**
 * Abandon the rest of a plan the board has outrun. To the console rather than
 * the game log: a player has nothing to do with this, but it should be visible
 * to whoever is looking at why the machine stopped short.
 */
function aiAbandonPlan(s) {
  AI_ABANDONED++;
  console.warn(`AI: planned ${s.mv.kind} ${sq(s.from)} → ${sq(s.mv.to)} is no longer legal; `
    + "finishing the turn from the board as it stands.");
  AI.moveSteps = [];
}

/** The whole turn, synchronously. Used by headless self-play. */
function aiRunTurn() {
  if (!AI.on || G.over || G.turn !== AI.side) return;
  AI.thinking = true;
  clearOrderingMemory();
  try {
    if (G.owedDiscard && G.owedDiscard.player === AI.side) aiResolveDiscard();
    aiConsiderChronos();
    if (aiShouldDraw()) { drawSpell(AI.side); AI.thinking = false; endTurnLocal(); return; }
    for (let i = 0; i < 3 && aiCastOnce("declare"); i++);
    if (!G.over && !G.hasActed) {
      const res = searchBestMove(AI.side);
      if (res) for (const s of res.move.steps) {
        if (G.over) break;
        // The same re-check the live driver makes between beats; see
        // aiStepStillLegal. aiFinishMove below closes out whatever is left.
        if (!aiStepStillLegal(s)) { aiAbandonPlan(s); break; }
        performMove(s.from, s.mv);
      }
      aiFinishMove();
    }
    for (let i = 0; i < 3 && !G.over && aiCastOnce("end"); i++);
    aiPayTacticianDebt();
  } catch (err) {
    log(`The machine hit an internal error and passes: ${err.message}`, "big");
    console.error(err);
  } finally {
    AI.thinking = false;
  }
  if (!G.over) endTurnLocal();
}

/* ── the live driver ────────────────────────────────────────────────────────
   A setTimeout state machine rather than one long async function. Each beat
   does a chunk of synchronous work, paints, and schedules the next. Nothing
   depends on promise continuations, so a backgrounded tab or a slow search
   cannot leave a turn half-finished with the board frozen.
   ─────────────────────────────────────────────────────────────────────────── */

const AI_STAGES = ["discard", "chronos", "draw", "castDeclare", "move", "castEnd", "finish"];

function aiTakeTurn() {
  if (!AI.on || G.over || G.turn !== AI.side || AI.thinking) return;
  AI.thinking = true;
  clearOrderingMemory();
  AI.stage = 0;
  AI.moveSteps = null;
  clearSelection();
  UI.targeting = null;
  render();
  const gen = AI.gen;
  setTimeout(() => aiStep(gen), aiCfg().pace);
}

function aiStep(gen) {
  // A beat from an abandoned turn must not touch the current game. A stale
  // generation was already cleaned up by aiCancel; anything else means this
  // turn can no longer proceed, so release the lock rather than leaving
  // AI.thinking stuck true, which would freeze the game permanently.
  if (gen !== AI.gen) return;
  if (!AI.on || G.over || G.turn !== AI.side) { AI.thinking = false; render(); return; }
  let wait = aiCfg().pace;
  try {
    switch (AI_STAGES[AI.stage]) {
      case "discard":
        if (G.owedDiscard && G.owedDiscard.player === AI.side) aiResolveDiscard();
        AI.stage++; wait = 0; break;

      case "chronos":
        aiConsiderChronos();
        AI.stage++; wait = 0; break;

      case "draw":
        if (aiShouldDraw()) {
          drawSpell(AI.side);
          AI.thinking = false;
          render();
          setTimeout(() => { if (gen === AI.gen && !G.over) endTurnLocal(); }, aiCfg().pace);
          return;
        }
        AI.stage++; wait = 0; break;

      case "castDeclare":
        if (!aiCastOnce("declare")) { AI.stage++; wait = 0; }
        break;

      case "move": {
        if (!AI.moveSteps) {
          if (G.hasActed) { AI.moveSteps = []; }
          else {
            const res = searchBestMove(AI.side);
            AI.moveSteps = res ? res.move.steps.slice() : [];
            if (res && res.depth)
              log(`The machine looked ${res.depth} plies ahead (${res.nodes.toLocaleString()} positions).`, "sys");
          }
        }
        if (AI.moveSteps.length && !G.over) {
          const s = AI.moveSteps.shift();
          // Re-checked against the live board, not trusted from the search that
          // planned it a moment ago. See aiStepStillLegal.
          if (aiStepStillLegal(s)) {
            performMove(s.from, s.mv);
            wait = Math.max(110, aiCfg().pace * 0.7);
          } else {
            aiAbandonPlan(s);
            aiFinishMove();
            AI.stage++; wait = 0;
          }
        } else {
          aiFinishMove();
          AI.stage++; wait = 0;
        }
        break;
      }

      case "castEnd":
        if (!aiCastOnce("end")) { AI.stage++; wait = 0; }
        break;

      case "finish":
        aiPayTacticianDebt();
        AI.thinking = false;
        render();
        if (!G.over) endTurnLocal(); else announceWinner();
        return;
    }
  } catch (err) {
    log(`The machine hit an internal error and passes: ${err.message}`, "big");
    console.error(err);
    AI.thinking = false;
    render();
    if (!G.over) endTurnLocal();
    return;
  }

  render();
  if (G.over) { AI.thinking = false; announceWinner(); return; }
  // Never outrun the animation of the beat just taken — otherwise a machine
  // chain-jump fires its second hop while the first is still in the air.
  setTimeout(() => aiStep(gen), Math.max(wait, FX.busyMs()));
}

/**
 * Called at every turn handover. Decides who — or what — acts next.
 * `sameSeat` is true for a Temporal Cascade extra turn, where the device does
 * not change hands and a "pass to the other player" curtain would be nonsense.
 */
function afterHandoff(sameSeat) {
  if (G.over) { render(); announceWinner(); return; }
  if (AI.fast) return;                                   // headless self-play drives itself
  // The sandbox has one person driving both chairs in turn. There is no hand to
  // hide from them, so a pass-the-device curtain would just be a click.
  if (G.dev) { UI.revealed = true; render(); return; }
  if (NET.on) { UI.revealed = true; render(); return; }  // each device shows one hand already
  // The machine is the third thing that waits for an animation, for the same
  // reason as the curtain and the win sheet: your capture is still in the air
  // when your turn ends, and a machine that starts thinking on a fixed 40ms
  // timer renders its own move on top of it. That reads as your capture
  // arriving a turn late. It only bites the seat that hands over TO the
  // machine — as Violet you get your own thinking time and never see it.
  // FX.then fires immediately when nothing is playing, so this costs an
  // effects-off game nothing.
  if (isAISeat(G.turn)) {
    UI.revealed = true; render();
    FX.then(() => setTimeout(aiTakeTurn, 40));
    return;
  }
  if (AI.on) { UI.revealed = true; render(); return; }   // one human: nothing to hide
  if (sameSeat) { render(); return; }
  raiseCurtain();
}

/* ── self-play harness (used to measure strength; open the console) ─────────
   aiTournament("skilled", "random", 20)  ->  win/loss record
   ─────────────────────────────────────────────────────────────────────────── */

function aiRandomTurn(side) {
  const moves = turnMoves(side);
  if (moves.length) {
    // Seeded, like the referee's own random turn — a "random" opponent whose
    // choices cannot be replayed makes every number measured against it a
    // one-off. The Math.min guard mirrors playRandomTurn's.
    const rng = aiRng(AI_SALT_RANDOM);
    const m = moves[Math.min(moves.length - 1, (rng() * moves.length) | 0)];
    for (const s of m.steps) { if (G.over) break; performMove(s.from, s.mv); }
    let g = 0;
    while (G.chain != null && !G.over && g++ < 12) {
      const caps = captureMoves(G.chain);
      if (!caps.length) { G.chain = null; G.phase = "end"; break; }
      performMove(G.chain, caps[0]);
    }
    if (G.heraldBonus != null && !G.over) {
      const o = legalHeraldSteps(G.heraldBonus);
      if (o.length) performMove(G.heraldBonus, o[0]);
      else { G.heraldBonus = null; G.phase = "end"; }
    }
  }
  if (!G.over) endTurnLocal();
}

/** One headless game. `gold`/`violet` are level names or the string "random". */
function aiPlayGame(gold, violet, maxTurns = 300, seed = null) {
  const saved = { ...AI };
  // "ai", not the default "local" — self-play is how the machine's handling of
  // the concealment cards gets measured, and in a local-mode game it would
  // never be dealt one.
  G = newGame(0, seed, { mode: "ai" });
  UI = freshUI();
  G.turnNo = 0;
  // `fast` so no pacing applies, and `deterministic` for the same kind of
  // reason one notch further on: this function is the measuring instrument, and
  // an instrument that gives a different reading each time it is picked up is
  // not one. With the clock as the budget, the same seeded game came out
  // 17v18 and then 17v17 — see "what a search may spend".
  AI.on = true; AI.fast = true; AI.deterministic = true; AI.thinking = false;
  beginTurn(0);
  let turns = 0;
  while (!G.over && turns < maxTurns) {
    turns++;
    const who = G.turn;
    const brain = who === 0 ? gold : violet;
    if (brain === "random") { aiRandomTurn(who); }
    else { AI.side = who; AI.level = brain; aiRunTurn(); }
  }
  const res = {
    winner: G.over ? G.over.winner : null,
    reason: G.over ? G.over.reason : "turn limit reached",
    turns, gold: countPieces(0), violet: countPieces(1),
  };
  Object.assign(AI, saved);
  return res;
}

/**
 * Plays `n` games with colours swapped each round so first-move bias cancels.
 * Games that hit the turn limit are awarded on material — a side with twice the
 * pieces left has won in every sense that matters.
 */
function aiTournament(a, b, n = 10, maxTurns = 200) {
  const rec = { [a]: 0, [b]: 0, ties: 0, games: [] };
  for (let i = 0; i < n; i++) {
    const aIsGold = i % 2 === 0;
    const r = aiPlayGame(aIsGold ? a : b, aIsGold ? b : a, maxTurns, 1000 + i);
    const aP = aIsGold ? r.gold : r.violet, bP = aIsGold ? r.violet : r.gold;
    let w;
    if (r.winner != null) w = (r.winner === 0) === aIsGold ? a : b;
    else w = aP > bP ? a : bP > aP ? b : "ties";
    rec[w]++;
    rec.games.push({ g: i + 1, winner: w, turns: r.turns, [a]: aP, [b]: bP, how: r.reason });
    console.log(`game ${i + 1}: ${w} (${r.turns} turns, ${aP}v${bP}, ${r.reason})`);
  }
  console.log(`${a} ${rec[a]} — ${rec[b]} ${b}  (${rec.ties} tied)`);
  return rec;
}
