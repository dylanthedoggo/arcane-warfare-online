/* ══════════════════════════════════════════════════════════════════════════
   ARCANE WARFARE — THE MACHINE

   A classic script, loaded after engine.js and fx.js and before app.js. Classic
   scripts share one scope, so this file reads the engine's live `G` and calls
   the engine and the interface by bare name. Every such name is used inside a
   function body, never at the top level, so load order does not matter.

   It expects:
     from engine.js   G and the rules (performMove, castSpell, captureMoves, …)
     from fx.js       FX
     from app.js      UI, NET, render, endTurnLocal, clearSelection,
                      announceWinner, toast, raiseCurtain

   Under Node, tools/bootstrap.js supplies the same scope. In a live game the
   slow work also runs in ai-worker.js, which loads this same file.
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
 *   timeMs        wall-clock for one root search. In a live game it runs on a
 *                 worker thread (see aiThink), so the page stays responsive
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
 * The self-play tests are played at Skilled, so changing Skilled's figures
 * changes what those tests measure. Novice's policyDepth is pinned at 2 on
 * purpose: deriving it from `depth` would upgrade its spell play by accident.
 */

/**
 * WHAT THE KNOBS ARE WORTH (measured with `npm run selfplay`)
 *
 * - `depth` is only a ceiling. The budget (`timeMs`) usually stops the search
 *   first, so raising `depth` alone does nothing. Ruthless reaches its depth
 *   of 10 only on its full 3000 ms (about 360,000 nodes).
 * - `noise` is a weak lever. The jitter can only swap moves whose scores are
 *   close, so it never throws material away. Ruthless with noise 60 scored
 *   level with Ruthless with none.
 * - The difficulty lives in `timeMs` and the policy figures. Novice is
 *   beatable because of its shallow search and small budget, not its jitter.
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
  duel: null,        // exhibition: a level name per seat, or null in a normal game
  paused: false,     // the watcher stopped the exhibition between beats
  watch: 0,          // index into WATCH_SPEEDS — playback speed, never strength
  // Budget the search in nodes rather than in wall-clock milliseconds, so that
  // the same seeded game plays out the same way twice. Off here and never
  // turned on by the page; the headless tools set it. `fast`, its older
  // neighbour, is set the same ad-hoc way and clamps the budget rather than
  // changing its currency. See "what a search may spend".
  deterministic: false,
  // Multiplier on every search budget; 1 is each level's own figure. `fast`
  // cannot do this job: it clamps every level to the same 40 ms, which removes
  // most of the difference between the levels being measured.
  budgetScale: 1,
  // How many turns in a row this seat has spent drawing. Per SEAT, not one
  // counter, because a duel runs both chairs through this same object and a
  // shared streak would have each machine serving the other's sentence. See
  // aiShouldDraw for what it is guarding against.
  drawStreak: [0, 0],
};

/**
 * How many turns running the machine may spend drawing before it is made to
 * play.
 *
 * THIS NUMBER IS A BACKSTOP AND NOT THE MAIN GUARD, and it is worth being clear
 * about that because the obvious small value here is wrong. Drawing several
 * turns in a row is how the card game is actually played: from a position that
 * is not under threat you draw, and draw, and keep drawing until the hand is
 * deep enough to answer whatever comes, and only then go back to moving pieces.
 * A cap of three would forbid that outright and leave the machine dribbling out
 * one card between moves, which is neither the standoff it was meant to prevent
 * nor anything a strong player does.
 *
 * What actually ends a legitimate burst is the hand filling up — past
 * HAND_VALUED the curve is flat and drawing stops scoring. That is the real
 * terminator, and it is the gate in aiShouldDraw doing the work. This counter
 * only bounds the case where both machines burst at each other out of mutual
 * zugzwang, so that the worst standoff left in the game is finite and short
 * rather than the hundred and forty turns that prompted all of this. Set to the
 * size of a real burst: allow the whole thing, then insist on a move.
 */
const DRAW_STREAK_MAX = 13;

/** Abandon whatever the machine was doing; any in-flight beat becomes a no-op,
 *  and a thought still running on the worker thread is thrown away. */
function aiCancel() { AI.gen++; AI.thinking = false; AI.moveSteps = null; aiDropThought(); }
const aiCfg = () => AI_LEVELS[AI.level];
/* ── DUEL — both chairs are machines ────────────────────────────────────────
   The search is written around ONE machine (`AI.side`, `AI.level`). A duel
   keeps that: `AI.duel` holds a level per seat, and aiTakeSeat() repoints
   side and level at the top of every turn.

   The trap: "how hard does SEAT s play?" must go through aiLevelFor(s).
   AI.level answers for whoever is thinking, not for the seat asked about.
   ─────────────────────────────────────────────────────────────────────────── */

/** The ladder, weakest first. The menus and the ordering test both read it. */
const AI_ORDER = ["novice", "skilled", "ruthless"];

const isDuel = () => AI.on && !!AI.duel;
/** How hard `s` plays — the per-seat answer, which is not always AI.level. */
const aiLevelFor = (s) => (AI.duel ? AI.duel[s] : AI.level);
const aiNameFor = (s) => AI_LEVELS[aiLevelFor(s)].name;
const isAISeat = (s) => AI.on && (AI.duel ? AI.duel[s] != null : s === AI.side);

/** Put the brain that owns the seat on move into the chair. A no-op off duel. */
function aiTakeSeat() {
  if (!AI.duel) return;
  AI.side = G.turn;
  AI.level = aiLevelFor(G.turn);
}

/* ── how fast to play an exhibition back ────────────────────────────────────
   "Faster" scales PRESENTATION ONLY: the pauses between beats and the length
   of the animations. It must never touch a search or policy budget — a
   machine that thinks less because the watcher is impatient is a weaker one.
   ─────────────────────────────────────────────────────────────────────────── */

const WATCH_SPEEDS = [
  { label: "1×", rate: 1,    hint: "" },
  { label: "2×", rate: 0.5,  hint: "half the pauses, the same thinking" },
  { label: "4×", rate: 0.25, hint: "as fast as the board stays readable" },
];

/** The scale on every cosmetic wait. 1 outside an exhibition, always. */
const watchRate = () => (AI.duel ? WATCH_SPEEDS[AI.watch].rate : 1);

/* watchApply and watchCycle touch FX and the interface, so they live inside
   the browser-only seam below rather than here. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the machine's own randomness ───────────────────────────────────────────
   Two coin flips: the root jitter of the easier levels, and the "random"
   opponent of self-play. Both are seeded from the game seed, the turn number
   and a counter, like drawSpell — Math.random() would make a seeded game
   unrepeatable. Each has its own multiplier so the streams never fall in step.

   The counter (G.aiSeq) lives on G so a snapshot carries it and a rewind takes
   it back. It advances per CALL, not per turn: sixteen searches of one
   position must not all blunder the same way.
   ─────────────────────────────────────────────────────────────────────────── */

const AI_SALT_JITTER = 5279;      // root-move jitter
const AI_SALT_RANDOM = 3001;      // the "random" opponent choosing its move

/**
 * A seeded stream for one decision. `salt` names which stream.
 * The guard matters: a game saved before `aiSeq` existed has none, and
 * `undefined++` is NaN, which would seed every later call identically.
 */
function aiRng(salt) {
  if (typeof G.aiSeq !== "number") G.aiSeq = 0;
  return mulberry32((G.seed + G.turnNo * salt + G.aiSeq++) | 0);
}

const MATE = 1e6;
let AI_NODES = 0, AI_DEADLINE = 0, AI_TIMEUP = false, AI_NODE_DEADLINE = 0;

/* ── fast make / unmake (search only — no logging, no FP, no penalties) ──── */

/**
 * A Hollow's shell the search is entitled to know about: its OWN. It may not
 * reason about an enemy shell — viewFor deletes that field for a person, and
 * the machine plays by the same rule. It finds out by spending the jump.
 *
 * (canCapture reads `hollow` on both sides, so an enemy shell can still be
 * inferred from a pawn that declines a jump. Known; see engine.js canCapture.)
 */
const aiOwnShell = (v) => !!v.hollow && v.owner === AI.side;

/* ── position hashing ───────────────────────────────────────────────────────
   One number that names the position, so the search can recognise a position
   it already scored. Zobrist hashing: every (square, attribute) pair has a
   fixed number, and the hash is the XOR of the ones that are true. XOR undoes
   itself, so the hash is cheap to keep up to date.

   The numbers are SEEDED, so a noiseless level picks the same move twice.

   NOT in the hash: `quantumReal`, and `hollow` on an enemy piece. The machine
   may not see those, and a cache key would be a back door to them.

   Everything sideScore reads IS in it. A field the evaluator prices but the
   key ignores gives two different positions one name.
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

/* The squares one step can disturb. Reused, not allocated: applyStep runs
   millions of times a search and never re-enters itself. Listing a square that
   does not change costs nothing (XORed out and back in); missing one corrupts
   the hash, so the list is built from what a step COULD touch. */
const ZTOUCH = new Int32Array(8);
let ZTN = 0;
function ztAdd(i) {
  if (i < 0) return;
  for (let k = 0; k < ZTN; k++) if (ZTOUCH[k] === i) return;   // never twice: XOR would cancel
  ZTOUCH[ZTN++] = i;
}

/**
 * One life between two bodies: when a twinned body leaves the board, the other
 * half goes with it (engine.js removePiece). Both ends are recorded so
 * undoStep can restore the pair.
 *
 * `G.twinStep` is NOT touched: the search explores one movement per turn, so
 * it has no second movement to cancel. The live driver takes it; see
 * aiFinishMove.
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
 * put it back. No logging, no Focus, no penalties. It must agree with the
 * referee about WHAT ENDS UP ON THE BOARD — test/ai.test.js compares the two
 * jump by jump.
 *
 * TEMPORAL TWIN is public, so it is obeyed: a jump or a crown that removes one
 * body removes both.
 *
 * QUANTUM PAWN cannot be obeyed without reading `quantumReal`, which is the
 * whole card. So a jump at a superposition is modelled by what is true either
 * way: the struck square ends up empty, the partner is left alone (sideScore
 * already prices it at half a pawn), and the chain stops, because the jump
 * may have found nothing.
 *
 * Not modelled, as coin flips the machine may not resolve: the capture tally
 * is raised as if the jump connected, and an Eye For An Eye mark on a
 * superposed body does not kill the attacker.
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
    //
    // WHICH of shell / armor / kill it is comes from the engine's jumpOutcome,
    // not from a second list of checks here. Only the board update is ours.
    if (v.quantum) { G.board[mv.victim] = null; rec.quantumHalt = true; }
    else {
      const outcome = jumpOutcome(v, aiOwnShell(v));
      if (outcome === "shell") {
        rec.victimKeptShell = true;
        rec.victimHome = v.hollowHome;
        v.hollow = false; v.hollowHome = -1;
      }
      else if (outcome === "armor") { v.armor = false; rec.victimKeptArmor = true; }
      else { G.board[mv.victim] = null; aiSeverTwin(v, mv.victim, rec); }
    }
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
    // The engine's own rule decides whether the chain goes on — the same
    // function performMove asks. `quantumHalt` stands in for a whiff: the jump
    // MAY have found nothing, and the search may not plan on the coin.
    const halt = jumpEndsChain(rec.quantumHalt, rec.victimKeptShell, rec.attackerDied, rec.promoted);
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
 * turnMoves minus anything Stutter has forbidden — what the machine may choose
 * from at the ROOT. Only at the root: deeper plies are later turns, where the
 * ban is spent. The machine does not go through the referee, so without this
 * it could replay a move a player would be refused.
 *
 * The ban is compared with the FIRST STEP of a turn, because that is what the
 * engine records (performMove → noteTurnAction).
 */
function banAction(m) {
  const s = m.steps[0];
  return { t: "move", from: s.from, to: s.mv.to, kind: s.mv.kind };
}

function rootMoves(owner) {
  const moves = turnMoves(owner);
  if (!G.stutter || G.stutter.player !== owner || !G.stutter.banned) return moves;
  const legal = moves.filter((m) => !stutterBans(owner, banAction(m)));
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

/* ── how much of a hand is worth having ─────────────────────────────────────
   These three numbers are the shape of the card curve, and the reason there
   are three of them rather than one is a mistake this file used to make.

   THE OLD NUMBER WAS FIVE, and it was five for a defensible reason: a turn
   buys at most three casts, the pool's costs run 2 to 6 against a Focus
   ceiling of 10, so nobody SPENDS more than about three cards before running
   dry. Everything past the fifth, the argument went, is a card you will still
   be holding when the game ends.

   That argument prices a hand as though its only job were to be spent, and
   that is not what a hand is for. Most of these twenty-five cards do nothing
   at all until the board hands them a use — Chokepoint wants a corridor, the
   Rift wants a piece near a mouth, Stutter wants an opponent with a plan worth
   unmaking. Holding one is not stockpiling fuel, it is holding the ANSWER to a
   question that has not been asked yet, and the way you get the right answer is
   to hold many. A human who plays this game well carries about thirteen.

   So the curve has two regimes and a tail:

     up to HAND_CORE      the cards you can plausibly spend soon — full price
     up to HAND_VARIETY   variety: the answer, held before the question — most
                          of full price, because a card you cannot yet use is
                          still worth having, just not as much as one you can
     beyond               a tail, because the pool is twenty-five and by the
                          thirteenth card the odds that the fourteenth adds an
                          answer you do not already hold have gone thin

   HAND_VALUED is where the curve stops entirely, and it is also the only thing
   HAND_USEFUL's hard refusal in aiShouldDraw still does. The rest of that
   refusal's old job — stopping two machines drawing at each other forever —
   has moved to DRAW_STREAK_MAX, which is a better guard for it. See the essay
   above aiShouldDraw for why the hand size was the wrong place to put it.
   ─────────────────────────────────────────────────────────────────────────── */
const HAND_CORE = 5;
const HAND_VARIETY = 13;
const HAND_VALUED = 16;

/**
 * What a cast costs on average, over the twenty-five-card pool: the mean of
 * SPELLS[*].cost, which is 3.4. Used to ask how many casts a given pile of
 * Focus could actually pay for. Written down rather than computed because
 * resourceValue runs at every leaf of the search and this is a constant.
 */
const AVG_SPELL_COST = 3.4;

/**
 * Focus Points and cards, with DIMINISHING RETURNS and a hard clamp.
 *
 * With flat values the machine finds that drawing (+1 FP, +1 card) beats every
 * quiet move and draws forever. So each extra card is worth less than the
 * one before (see the curve above), Focus with no card to spend it on is
 * worth little, and cards past HAND_VALUED are worth nothing. aiShouldDraw
 * holds the other half of this.
 */
function resourceValue(fp, cards) {
  // Focus past the ceiling is not merely worth less, it does not exist: the
  // referee refuses to bank it. Clamping here is what stops the machine paying
  // a real tempo cost for income it can never collect.
  const banked = Math.min(fp, FP_CAP);
  const held = Math.min(cards, HAND_VALUED);

  // 1. OPTION VALUE — what the hand is worth as variety, independent of whether
  //    any of it can be paid for this turn. See the curve's essay above.
  let s = Math.min(held, HAND_CORE) * 30
        + Math.max(0, Math.min(held, HAND_VARIETY) - HAND_CORE) * 20
        + Math.max(0, held - HAND_VARIETY) * 5;

  // 2. SPEND VALUE — and this is the term the old evaluator did not have.
  //
  //    Focus and cards were priced independently and then added, which reads as
  //    obviously fine and is the whole bug. They are COMPLEMENTS: neither does
  //    anything without the other. A card with no Focus behind it is a coaster,
  //    and Focus with no card to spend it on is the position the machine
  //    actually kept reaching — measured over three Ruthless mirrors it sat on
  //    an average of 7.35 Focus of a possible 10 while its hand size piled up at
  //    exactly three, because the fourth card was priced at 4 and one square of
  //    pawn advance is worth 7. It was declining to go and get the thing that
  //    would have let it spend what it was hoarding, and no additive pricing of
  //    the two halves can ever notice that, because in an additive world the
  //    hoard is already scoring well.
  //
  //    So price the PAIRING separately: how many casts this hand and this pool
  //    could between them actually buy.
  const castable = Math.min(held, Math.floor(banked / AVG_SPELL_COST));
  s += castable * 25;

  // 3. What is left of the Focus. Still worth something — income arrives before
  //    the card that spends it does — but sharply less once no card in hand
  //    could pay it out.
  const spendable = Math.min(banked, held * AVG_SPELL_COST);
  s += spendable * 12 + (banked - spendable) * 3;

  return s;
}

/* ── the mobility term ──────────────────────────────────────────────────────
   How many quiet moves a piece has — the same number as
   `simpleMoves(i).length` (the pinned-evaluation tests keep it so), but
   counted without building an array at every leaf. This loop was most of
   sideScore's cost.

   The Enchanter swaps with ANY piece, so its count is "pieces on the board,
   less itself" — a subtraction, not a walk of all 144 squares.
   ─────────────────────────────────────────────────────────────────────────── */
/* Occupied squares, counted at most once per sideScore call and only when an
   Enchanter asks. Module-level, not a closure: this runs twice per leaf and
   sideScore never re-enters itself. */
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

/* sideScore is a third or more of the whole search; most of that was the
   mobility loop, now fixed. A running material total in applyStep/undoStep was
   considered and NOT done: it would save about a tenth of the search and put a
   second copy of the evaluator inside make/unmake, where a mistake is
   invisible. */
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
    // A twinned body is a whole pawn, but the pair shares one life. applyStep
    // takes both bodies when one dies, so the search prices that inside its
    // horizon; this term is the standing risk beyond it.
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

  // The board-altering spells leave their effect in fields of their own, not
  // on a piece. Without a term here the evaluator cannot see what the cast
  // did, and the machine decides every one of them is worthless. Chokepoint
  // and Wraparound already show up in mobility; these do not.
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
    // Open to both sides, so price proximity to a mouth, not ownership.
    // Counted, not collected — adjacentTo builds an array.
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
   "I have scored this exact position to at least this depth before." Unlike
   the ordering tables this returns SCORES, so a wrong entry is a wrong move.

   The hash covers the board. The evaluation also reads Focus, hand size,
   G.stutter, G.rift, G.mustCapture and extra turns. Within one search those
   cannot change. Between searches they do — the policy layer casts a spell
   and searches the result — so every entry carries AI_EPOCH, bumped at the
   start of each search. An entry from an older epoch is simply not seen.

   AI_TT switches the table off; the tests use it to prove the table changes
   what a search COSTS and not what it CONCLUDES.
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

   THERE IS NO STAND-PAT while a capture exists. In chess the side to move may
   decline to capture, which puts a floor under the score. Here captures are
   compulsory, so a side forced into a losing exchange cannot walk away, and a
   floor would be a lie. The capture list is fetched FIRST and the floor is
   used only when the list is empty.
   ─────────────────────────────────────────────────────────────────────────── */
function quiesce(owner, alpha, beta, ply, base = 0) {
  // Capture chains can fan out badly in a crowded midgame, so this honours the
  // clock too — without it a single quiescence call could run unbounded.
  if ((++AI_NODES & 511) === 0 && aiOutOfBudget()) AI_TIMEUP = true;

  /* A board swept clean is a WIN, not a material lead. `base` is the caller's
     distance from the root, so the mate distance stays root-relative and a
     faster win scores higher — the same scale as alphabeta's -MATE + ply. */
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
 * Iterative deepening with a budget. Returns { move, score, depth, nodes }.
 *
 * THE JITTER IS NOT PART OF THE SEARCH. A level that blunders on purpose must
 * search honestly and then choose sloppily. So alpha always comes from the
 * raw score, a level that jitters searches every root move with a full window
 * (a bound is not a score, and must not be jittered), and the sampling happens
 * once, at the end, on the last completed ranking. Ruthless has noise 0 and
 * none of this applies to it.
 *
 * The sample comes from a seeded stream — see aiRng.
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
   Every search stops on a budget, not on its depth ceiling.

   The budget is normally WALL-CLOCK: the right currency for a person waiting.
   It is the wrong one for anything to be reproduced — the same search reaches
   a different depth on a cold and a warm engine. So `AI.deterministic` counts
   the budget in NODES instead. Off by default; the headless tools turn it on.

   AI_NODES_PER_MS is nominal, not measured. It keeps the level knobs meaning
   what they say: twice the milliseconds is twice the search.
   ─────────────────────────────────────────────────────────────────────────── */

/** Wall-clock budget for one search. Headless self-play runs on a shoestring. */
const aiBudget = (ms) => (AI.fast ? Math.min(ms, 40) : ms) * AI.budgetScale;

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
const aiPolicyBudget = () => (AI.fast ? 180 : aiCfg().policyBudget) * AI.budgetScale;

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
  // Transformations are cast like any other spell, and are considered at
  // every spell-tactics setting.
  /* The sacrifice-bearing spells offer two choices of victim: which pawn is
     spent can matter more than whether to cast. Two, not all — each option is
     a full clone-and-search. */
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
  // Hollow. The search already sees the shell save the pawn (applyStep). What
  // it cannot see is the concealment — the jumps the opponent never makes —
  // and that rides in on `bonus`. It stays out of sideScore, which would price
  // the OPPONENT's shells too. See STUTTER_DENIAL and aiOwnShell.
  //
  // Which pawn to spend it on: one already under attack, and one with no
  // capture of its own — the no-capture price is permanent.
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
   Pricing ONE candidate costs a clone of the whole game plus a shallow search.
   A crowded board has more candidates than budget, so some are not priced.
   Two rules decide which:

   1. A CHEAP PRE-SCORE, so the budget goes to the promising end. These weights
      never reach the evaluator; they only decide what gets measured properly.

   2. ONE SLOT PER CARD BEFORE ANY CARD GETS TWO. A card with six targets must
      not crowd out a card with one. Every card that offers anything gets its
      best offer measured.

   Where a sharp static test exists (Tactician needs two captures on the
   board), it belongs in the finder; otherwise it belongs here.
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
  /* The cap bounds the worst case; it is NOT a tighter budget. It sits above
     what the clock affords in ordinary positions (about 54 candidates for
     Skilled, 98 for Ruthless), and never below one per card. */
  const cap = Math.max(firstOfEach.length, aiWide(60));
  return firstOfEach.concat(rest).slice(0, cap);
}

/* ── Stutter's worth ────────────────────────────────────────────────────────
   Stutter cannot be priced by a flat term. Measured over a real game, denying
   somebody their best turn costs them nothing three times in four (the second
   best is as good) and up to two pieces in the rest.

   So the position-dependent half is computed here, ONCE per turn, in the gate;
   the flat half is in sideScore at this same constant, so a candidate that
   clears the gate is one the search also agrees to pay for.
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
 * What a Hollow's CONCEALMENT is worth — only the concealment. The search
 * already prices the saved pawn (applyStep keeps a shelled pawn alive), so a
 * larger number would count the card twice. This covers what the search cannot
 * reach: the opponent declining a jump because they do not know which pawn is
 * shelled. 24 is "worth playing in a quiet position, not worth a tempo".
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
 * price it against moving: search both and take the better.
 *
 * THE HARD LIMIT is there because drawing is also a PASS. In a standoff every
 * move loses a pawn, so passing really is best, and two machines will draw at
 * each other forever. Pricing cannot fix that — the comparison is answering
 * correctly. So something must refuse without asking the search.
 *
 * That limit is the DRAW STREAK, not the hand size. A good player holds about
 * thirteen cards, so a cap on the hand forbids good play. What is wrong in a
 * standoff is that the machine passes again and again, so count that: after
 * DRAW_STREAK_MAX drawn turns in a row it must move. Any other turn resets the
 * count.
 *
 * HAND_VALUED is still a gate, but only as bookkeeping: past it the card curve
 * is flat, so a draw cannot beat standing pat.
 */
function aiShouldDraw() {
  const P = G.players[AI.side];
  if (P.noDraw > 0 || !eligibleSpellIds().length) return false;
  if (G.drewThisTurn || G.hasActed || G.castThisTurn > 0) return false;
  if (capturersFor(AI.side).length) return false;        // never pass up a capture
  if (P.hand.length >= HAND_VALUED) return false;        // the curve is flat past here
  if (AI.drawStreak[AI.side] >= DRAW_STREAK_MAX) return false;   // see above
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
  // say so. Not during headless self-play, which would drown the console —
  // and `deterministic` is what marks a run as self-play now. It used to be
  // `fast`, which was the same thing until a self-play run could ask for real
  // budgets; then a --scale run started printing forty lines a game.
  if (cands.length < offered.length && !AI.deterministic)
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
  if (priced < cands.length && !AI.deterministic)
    console.warn(`AI: the budget stopped the policy after ${priced} of ${cands.length} candidates.`);
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
   A turn is CHOSEN under applyStep's model and PLAYED OUT under performMove.
   They agree on everything the machine may know (test/ai.test.js checks it),
   but a quantum whiff or an enemy Hollow shell can end a sequence the search
   expected to continue. The rest of the plan then describes hops from empty
   squares — or, after a promotion, a jump that is still on the board but
   would be a second action in one turn. So every planned step is re-checked
   before it is played.
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

/* ── the draw streak ────────────────────────────────────────────────────────
   Two functions rather than one `AI.drawStreak[side]++` at each site, because
   there are two drivers — the synchronous one below and the staged one the page
   uses — and the counter is only a guard if BOTH of them keep it. A site that
   forgot to reset would leave the machine permanently barred from drawing, and
   a site that forgot to increment would leave the standoff guard doing nothing;
   neither failure announces itself. Named calls at least make the omission
   visible to anyone reading the turn.
   ─────────────────────────────────────────────────────────────────────────── */

/** This turn was spent drawing. */
function aiNoteDraw() { AI.drawStreak[AI.side]++; }

/** This turn was spent on something else, so the streak is over. */
function aiNoteActed() { AI.drawStreak[AI.side] = 0; }

/** The whole turn, synchronously. Used by headless self-play. */
function aiRunTurn() {
  if (!AI.on || G.over) return;
  aiTakeSeat();
  if (G.turn !== AI.side) return;
  AI.thinking = true;
  clearOrderingMemory();
  try {
    if (G.owedDiscard && G.owedDiscard.player === AI.side) aiResolveDiscard();
    aiConsiderChronos();
    if (aiShouldDraw()) {
      drawSpell(AI.side); aiNoteDraw();
      AI.thinking = false; endTurnLocal(); return;
    }
    aiNoteActed();
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

/* ── jobs: the thinking, one named piece at a time ──────────────────────────
   Every slow decision of a turn, by name. The live driver hands a name to
   aiThink(), which runs the job on a worker thread so the page stays
   responsive, and falls back to running it right here. Headless play
   (aiRunTurn) calls the same functions directly.

   A job runs on whatever G is loaded, may change it, and returns plain data —
   it has to survive a trip between threads. It is the SAME code on either
   side of that trip, which is the whole point: a worker with its own copy of
   the thinking would be a second machine.
   ─────────────────────────────────────────────────────────────────────────── */

const AI_JOBS = {
  chronos: () => aiConsiderChronos(),
  draw: () => aiShouldDraw(),
  cast: (phaseName) => aiCastOnce(phaseName),
  search: () => {
    const res = searchBestMove(AI.side);
    return res ? { steps: res.move.steps, depth: res.depth, nodes: res.nodes } : null;
  },
  finishMove: () => { aiFinishMove(); return true; },
};

/* ══════════════════════════════════════════════════════════════════════════
   SEAM: BROWSER-ONLY BEGINS

   Everything between this banner and its closing pair is the web page. It
   paints, it paces itself with setTimeout so a person can watch, and it hides
   hands between two people sharing a screen. tools/bootstrap.js runs the rest
   of this file under Node and gives these lines' dependencies — render, UI, FX,
   NET, clearSelection, announceWinner, raiseCurtain — stand-ins that do
   nothing, on the grounds that with no screen there is nothing for them to do.

   THE BANNERS ARE CHECKED, not decorative. The bootstrap reads this file, finds
   this pair, and refuses to start if a page name is used outside them. That is
   the one failure mode this arrangement has: a render() added to the thinking
   half would go on working under Node — silently, because the stand-in is a
   no-op — and the two copies of the machine would drift apart with nothing to
   say so. A line number in a document does not hold. This does.

   To move the seam, move the banners. To widen it, add the name to the
   bootstrap's allowlist along with the reason it is allowed.
   ══════════════════════════════════════════════════════════════════════════ */

/** Push the current speed at the effects player. Call after changing AI.watch. */
function watchApply() { FX.rate = watchRate(); }

/** Cycle 1× → 2× → 4× → 1×. The choice outlives the game, within the session. */
function watchCycle() {
  AI.watch = (AI.watch + 1) % WATCH_SPEEDS.length;
  watchApply();
  render();
}

/* ── pause and resume ───────────────────────────────────────────────────────
   Pause stops the exhibition where it stands rather than at the end of the
   turn, because a Ruthless mirror spends three seconds a move and a button that
   took that long to answer would read as broken.

   Stopping mid-turn is safe. aiCancel only invalidates the SCHEDULED beats;
   nothing is half-applied, because each beat finishes its own chunk of work
   synchronously before scheduling the next. The board is left after some legal
   prefix of a turn, which the driver can already re-enter: resuming runs
   aiTakeTurn from stage 0 and every stage no-ops when its work is done. That
   re-entrancy exists for the mid-turn undo; pause leans on it.
   ─────────────────────────────────────────────────────────────────────────── */

function duelPause() {
  if (!isDuel()) return;
  AI.paused = true;
  aiCancel();
  render();
}

function duelResume() {
  if (!isDuel()) return;
  AI.paused = false;
  render();
  if (!G.over && isAISeat(G.turn)) aiTakeTurn();
}


/* ── the thinking thread ────────────────────────────────────────────────────
   A Ruthless search takes three seconds. On the page's own thread that is
   three seconds in which nothing paints and no button answers. So the live
   driver sends each job (see AI_JOBS) to a worker — ai-worker.js, which loads
   engine.js and this file — together with the game, and takes the game back
   when the job is done.

   THE WHOLE GAME GOES OVER AND COMES BACK. The jobs change G: they cast, they
   write the log, they advance the seeded dice. Sending G and adopting the
   answer keeps every one of those, with no list of "fields the machine
   touches" to fall out of date.

   WHILE A JOB IS OUT, THE PAGE MUST NOT MOVE THE GAME, because the answer
   replaces it. Input is already refused while AI.thinking is set. As a second
   lock, aiBoardMark() is taken when a job leaves and checked when it returns;
   if the game moved anyway, the answer is dropped and the turn starts over.

   NO WORKER IS NOT AN ERROR. A page opened straight from a file cannot start
   one, and the suite's quick games (AI.fast) must stay synchronous. Both run
   the job on this thread, exactly as the driver always did.
   ─────────────────────────────────────────────────────────────────────────── */

let AI_WORKER = null;        // the worker, once one is running
let AI_WORKER_OK = true;     // false once one has failed: think on this thread
let AI_PENDING = null;       // the job in flight: { id, gen, job, arg, done, mark }
let AI_JOB_ID = 0;

/** A cheap fingerprint of "has the game moved?" — see the note above. */
const aiBoardMark = () => [
  G.turnNo, G.turn, G.fxSeq, G.history.length, G.over ? 1 : 0, G.log.length,
  G.log.length ? G.log[G.log.length - 1].text : "",
].join("|");

function aiWorker() {
  if (AI_WORKER || !AI_WORKER_OK) return AI_WORKER;
  try {
    AI_WORKER = new Worker("ai-worker.js");
  } catch (err) {
    AI_WORKER_OK = false;
    return null;
  }
  AI_WORKER.onmessage = (ev) => aiThought(ev.data);
  // The worker failed to load or died. Finish the job in flight on this thread
  // and stop asking for one.
  AI_WORKER.onerror = (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    console.warn("AI: no worker thread; the machine will think on the page.");
    AI_WORKER_OK = false;
    if (AI_WORKER) { AI_WORKER.terminate(); AI_WORKER = null; }
    const p = AI_PENDING;
    AI_PENDING = null;
    if (p && p.gen === AI.gen) aiGuarded(() => p.done(AI_JOBS[p.job](p.arg)));
  };
  return AI_WORKER;
}

/** Throw away a job in flight. The worker is busy with it, so the worker goes
 *  too; the next job starts a new one. Called by aiCancel. */
function aiDropThought() {
  if (!AI_PENDING) return;
  AI_PENDING = null;
  if (AI_WORKER) { AI_WORKER.terminate(); AI_WORKER = null; }
}

/**
 * Run the job named `job` and hand its result to `done`.
 *
 * `done` is called at once when the job runs on this thread, and later when it
 * ran on the worker — so nothing may follow a call to this in its caller.
 */
function aiThink(job, arg, gen, done) {
  const w = (AI.fast || AI.deterministic) ? null : aiWorker();
  if (!w) { done(AI_JOBS[job](arg)); return; }
  AI_PENDING = { id: ++AI_JOB_ID, gen, job, arg, done, mark: aiBoardMark() };
  w.postMessage({
    id: AI_PENDING.id, job, arg, G,
    fresh: AI.fresh === true,
    ai: { on: true, side: AI.side, level: AI.level, duel: AI.duel,
          fast: false, deterministic: false, budgetScale: AI.budgetScale,
          drawStreak: AI.drawStreak },
  });
  AI.fresh = false;
}

/** The worker answered. */
function aiThought(msg) {
  const p = AI_PENDING;
  if (!p || !msg || msg.id !== p.id) return;       // nobody is waiting for this
  AI_PENDING = null;
  if (p.gen !== AI.gen) return;                    // the turn was abandoned
  if (aiBoardMark() !== p.mark) {
    // The game moved while the job was out. Its answer is about a board that
    // no longer exists; start the turn again from the board that does.
    aiCancel();
    render();
    if (!G.over && isAISeat(G.turn) && !AI.paused) aiTakeTurn();
    return;
  }
  if (msg.error) { aiStepFailed(new Error(msg.error)); return; }
  G = msg.G;
  aiGuarded(() => p.done(msg.out));
}

/** The machine's turn cannot go on. Say so, and pass. */
function aiStepFailed(err) {
  log(`The machine hit an internal error and passes: ${err.message}`, "big");
  console.error(err);
  AI.thinking = false;
  render();
  if (!G.over) endTurnLocal();
}

const aiGuarded = (fn) => { try { fn(); } catch (err) { aiStepFailed(err); } };

/* ── the live driver ────────────────────────────────────────────────────────
   A setTimeout state machine rather than one long async function. Each beat
   does one piece of work, paints, and schedules the next. The slow pieces go
   through aiThink and the beat ends there; the answer schedules the next beat.
   Nothing depends on promise continuations, so a backgrounded tab or a slow
   search cannot leave a turn half-finished with the board frozen.
   ─────────────────────────────────────────────────────────────────────────── */

const AI_STAGES = ["discard", "chronos", "draw", "castDeclare", "move", "castEnd", "finish"];

function aiTakeTurn() {
  if (!AI.on || G.over || AI.thinking || AI.paused) return;
  aiTakeSeat();                          // duel: the chair changes hands each turn
  if (G.turn !== AI.side) return;
  AI.thinking = true;
  clearOrderingMemory();
  AI.fresh = true;                       // ...and the worker's copy of it, on its first job
  AI.stage = 0;
  AI.moveSteps = null;
  clearSelection();
  UI.targeting = null;
  render();
  const gen = AI.gen;
  setTimeout(() => aiStep(gen), aiCfg().pace * watchRate());
}

function aiStep(gen) {
  // A beat from an abandoned turn must not touch the current game. A stale
  // generation was already cleaned up by aiCancel; anything else means this
  // turn can no longer proceed, so release the lock rather than leaving
  // AI.thinking stuck true, which would freeze the game permanently.
  if (gen !== AI.gen) return;
  if (!AI.on || G.over || G.turn !== AI.side) { AI.thinking = false; render(); return; }
  const pace = aiCfg().pace;

  // How every beat but the last one ends: paint, then schedule the next.
  const next = (wait) => {
    render();
    if (G.over) { AI.thinking = false; announceWinner(); return; }
    // Never outrun the animation of the beat just taken — otherwise a machine
    // chain-jump fires its second hop while the first is still in the air.
    setTimeout(() => aiStep(gen), Math.max(wait * watchRate(), FX.busyMs()));
  };
  const advance = () => { AI.stage++; next(0); };

  // Play one planned hop, or close the movement out when none is left.
  const playStep = () => {
    if (AI.moveSteps.length && !G.over) {
      const s = AI.moveSteps.shift();
      // Re-checked against the live board, not trusted from the search that
      // planned it a moment ago. See aiStepStillLegal.
      if (aiStepStillLegal(s)) {
        performMove(s.from, s.mv);
        next(Math.max(110, pace * 0.7));
        return;
      }
      aiAbandonPlan(s);
    }
    aiThink("finishMove", null, gen, advance);
  };

  aiGuarded(() => {
    switch (AI_STAGES[AI.stage]) {
      case "discard":
        if (G.owedDiscard && G.owedDiscard.player === AI.side) aiResolveDiscard();
        advance();
        return;

      case "chronos":
        aiThink("chronos", null, gen, advance);
        return;

      case "draw":
        aiThink("draw", null, gen, (yes) => {
          if (!yes) { aiNoteActed(); advance(); return; }
          drawSpell(AI.side);
          aiNoteDraw();
          AI.thinking = false;
          render();
          setTimeout(() => { if (gen === AI.gen && !G.over) endTurnLocal(); }, pace * watchRate());
        });
        return;

      case "castDeclare":
        aiThink("cast", "declare", gen, (cast) => { if (cast) next(pace); else advance(); });
        return;

      case "move":
        if (AI.moveSteps) { playStep(); return; }
        if (G.hasActed) { AI.moveSteps = []; playStep(); return; }
        aiThink("search", null, gen, (res) => {
          AI.moveSteps = res ? res.steps.slice() : [];
          if (res && res.depth)
            log(`The machine looked ${res.depth} plies ahead (${res.nodes.toLocaleString()} positions).`, "sys");
          playStep();
        });
        return;

      case "castEnd":
        aiThink("cast", "end", gen, (cast) => { if (cast) next(pace); else advance(); });
        return;

      case "finish":
        aiPayTacticianDebt();
        AI.thinking = false;
        render();
        if (!G.over) endTurnLocal(); else announceWinner();
        return;
    }
  });
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
    if (AI.paused) return;               // an exhibition the watcher has stopped
    FX.then(() => setTimeout(aiTakeTurn, 40));
    return;
  }
  if (AI.on) { UI.revealed = true; render(); return; }   // one human: nothing to hide
  if (sameSeat) { render(); return; }
  raiseCurtain();
}

/* ══════════════════════════════════════════════════════════════════════════
   SEAM: BROWSER-ONLY ENDS
   ══════════════════════════════════════════════════════════════════════════ */

/* ── self-play harness (measures strength) ──────────────────────────────────
   From a browser console:   aiTournament("skilled", "random", 20)
   From a terminal:          npm run selfplay -- skilled random 20

   Both run the same code on the same seeds and get the same answer; that is
   what tools/agreement.js exists to keep true.
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

/**
 * One headless game. `gold`/`violet` are level names or the string "random".
 *
 * `opts` decides what the two of them are given to think with:
 *
 *   fast    true (the default) is the page's own shoestring — every budget
 *           clamped to 40 ms, which is what keeps the self-test suite's games
 *           down to seconds. It also flattens the levels against each other;
 *           see AI.budgetScale.
 *   scale   multiplier on the budgets, applied after `fast`. `{ fast: false,
 *           scale: 1 }` is the machine as a player meets it, and is slow.
 */
function aiPlayGame(gold, violet, maxTurns = 300, seed = null, opts = {}) {
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
  // The harness picks the brain per turn itself, below. Leaving a live duel
  // pairing in place would have aiRunTurn re-point the seat underneath it.
  AI.duel = null; AI.paused = false;
  // A fresh array, not a reset of the old one: `saved` above is a shallow copy,
  // so mutating in place would reach through it and the streak would survive
  // the restore into the next game of a tournament.
  AI.drawStreak = [0, 0];
  AI.on = true; AI.thinking = false; AI.deterministic = true;
  AI.fast = opts.fast !== false;
  AI.budgetScale = opts.scale == null ? 1 : opts.scale;
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
 *
 * THE SEED IS PRINTED, and that is worth more than it looks: a surprising game
 * is only worth arguing about if it can be played again, and `aiPlayGame` takes
 * a seed. `seed0` moves the whole block, so a second opinion can be had on a
 * hundred games nobody has looked at yet rather than the same hundred.
 *
 * That promise rests entirely on the machine being seeded — see aiRng — and on
 * the budget being counted in something the machine cannot vary, which is what
 * aiPlayGame turns on. Without both, a printed seed is a promise the output
 * does not keep.
 */
function aiTournament(a, b, n = 10, maxTurns = 200, seed0 = 1000, opts = {}) {
  const rec = { [a]: 0, [b]: 0, ties: 0, games: [] };
  for (let i = 0; i < n; i++) {
    const aIsGold = i % 2 === 0;
    const seed = seed0 + i;
    const r = aiPlayGame(aIsGold ? a : b, aIsGold ? b : a, maxTurns, seed, opts);
    const aP = aIsGold ? r.gold : r.violet, bP = aIsGold ? r.violet : r.gold;
    let w;
    if (r.winner != null) w = (r.winner === 0) === aIsGold ? a : b;
    else w = aP > bP ? a : bP > aP ? b : "ties";
    rec[w]++;
    rec.games.push({ g: i + 1, seed, winner: w, turns: r.turns, [a]: aP, [b]: bP, how: r.reason });
    console.log(`game ${i + 1} (seed ${seed}, ${aIsGold ? a : b} is Gold): ${w} `
      + `— ${r.turns} turns, ${aP}v${bP}, ${r.reason}`);
  }
  console.log(`${a} ${rec[a]} — ${rec[b]} ${b}  (${rec.ties} tied)`);
  return rec;
}
