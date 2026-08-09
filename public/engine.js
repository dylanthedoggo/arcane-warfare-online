"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   ENGINE — shared by the browser and the server.

   This file is loaded two ways and must keep working in both:

     browser   <script src="engine.js"></script>, a classic (non-module) script.
               Top-level const/let/function live in the shared global lexical
               scope, so index.html's inline script sees `G`, `legalMovesFor`,
               `FORMS` and everything else by bare name, exactly as it did when
               this code lived inside that file.

     node      require("./public/engine.js") picks up the CommonJS footer at the
               bottom. `G` stays module-private; the server swaps it per room
               with setG() immediately before each synchronous applyAction().

   The rules therefore exist in exactly one place. A client that lies about a
   move is checked by the same code that drew the move dots for it.
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   CHECKERS ARCANE WARFARE
   The full ruleset — board geometry, forms, spells, turn cycle, referee.

   Board geometry
     12x12, index = r*12 + c. Pieces live on dark squares: (r+c) % 2 === 1,
     which yields exactly 6 per row / 72 total.
     Player 0 = GOLD, starts on rows 8-11, advances toward row 0.
     Player 1 = VIOLET, starts on rows 0-3, advances toward row 11.
     Rows 4-7 begin empty (the doc's "starting separation space").

   State discipline
     `G` (the game state) is plain, structured-cloneable data only. No DOM
     references, no class instances. This is what lets Chronos's Gaze and the
     undo system snapshot the entire game with structuredClone.
     All transient interface state lives in `UI`, which is never cloned.
   ══════════════════════════════════════════════════════════════════════════ */

const N = 12;                       // board is N x N
const CELLS = N * N;
const rc = (r, c) => r * N + c;
const rowOf = i => (i / N) | 0;
const colOf = i => i % N;
/* Where the edges are is decided by cellAt(), further down — it has to be a
   function of game state now that Wraparound can join the left and right
   edges, so there is deliberately no bare onBoard() predicate to reach for. */
const isDark = i => (rowOf(i) + colOf(i)) % 2 === 1;
const DIAG = [[-1,-1],[-1,1],[1,-1],[1,1]];
const ORTHO = [[-2,0],[2,0],[0,-2],[0,2]];   // Phaser: 2 squares, stays on dark

/* forward direction: Gold decreases row, Violet increases row */
const fwd = owner => (owner === 0 ? -1 : 1);
/* the row a pawn promotes on */
const promoRow = owner => (owner === 0 ? 0 : N - 1);
/* the player's own back row */
const homeRow = owner => (owner === 0 ? N - 1 : 0);
/* is index `i` on the opponent's half of the board, from `owner`'s view? */
const onEnemyHalf = (i, owner) => (owner === 0 ? rowOf(i) < N / 2 : rowOf(i) >= N / 2);

const PLAYERS = [
  { name: "Gold",   css: "p0", color: "#e8b84b" },
  { name: "Violet", css: "p1", color: "#a86ef0" },
];

/**
 * THE FOCUS POINT CEILING
 *
 * Income was continuous — 1 every turn, another for drawing, more for captures,
 * promotions and Alchemists — but spending is not. You get one action a turn,
 * transformations are capped by quantity, and a spell needs a CARD, which costs
 * a whole turn to draw. Unbounded, the pool therefore only ever grew: by the
 * midgame both players sat on more Focus than the rest of the game could
 * absorb, and every cost on every card stopped meaning anything.
 *
 * Two things hold it down now, and neither touches a printed cost.
 *
 * A ceiling, so the pool can never become a war chest: 10 holds the Alchemist
 * (6) plus change, or Chronos plus a transformation, and nothing like a game's
 * savings. Earning while full wastes the income, and the log says so.
 *
 * And a slower drip — see beginTurn. The ceiling on its own only bounds the
 * hoard; with income still outrunning spending every turn, both players simply
 * sat at the ceiling for the whole game, which is the same complaint wearing a
 * smaller number. Halving the passive income is what actually makes a cost a
 * decision, and it moves the economy onto captures and promotions, where the
 * game is actually being played.
 */
const FP_CAP = 10;

/* ─────────────────────────────────────────────────────────────────────────
   TRANSFORMATIONS
   `on` = which rank may take it. `cap` = quantity limit;
   scope "player" counts per player, "board" counts across both.
   ───────────────────────────────────────────────────────────────────────── */
const FORMS = {
  juggernaut: {
    name: "Juggernaut", glyph: "◆", on: "any", cost: 3, cap: null, consumesTurn: true,
    ability: "Must be captured twice. The first capture strips its armor (the pawn sacrificed beneath it).",
    penalty: "Sacrifice an adjacent friendly pawn as armor · cannot move next turn · consumes your whole turn.",
    viaSpell: true,
  },
  phaser: {
    name: "Phaser", glyph: "↯", on: "pawn", cost: 0, cap: 2, capScope: "board",
    ability: "In addition to normal movement, may shift 2 squares orthogonally, passing through an occupied square. Cannot land on a piece. A phase never captures.",
    penalty: "Disoriented on transform and after every phase — cannot move next turn.",
    viaSpell: true,
  },
  sentinel: {
    name: "Sentinel", glyph: "▓", on: "pawn", cost: 3, cap: 2, capScope: "player", consumesTurn: true,
    ability: "Solid terrain. Cannot move, capture, or be jumped over. An enemy that captures into a square adjacent to it must end its chain.",
    penalty: "Every friendly piece in the same column behind it is frozen next turn · consumes your whole turn.",
    viaSpell: true,
  },
  herald: {
    name: "Herald", glyph: "⚑", on: "pawn", cost: 3, cap: 1, capScope: "player",
    ability: "A friendly pawn landing adjacent to the Herald may advance one extra square. The bonus step cannot capture.",
    penalty: "The Herald is frozen next turn.",
    need: "Must be on the opponent's half of the board.",
    viaSpell: true,
  },
  enchanter: {
    name: "Enchanter", glyph: "⚛", on: "queen", cost: 3, cap: 1, capScope: "player",
    ability: "May swap places with any piece on the board, friendly or enemy.",
    penalty: "Frozen 2 turns on transform · frozen 1 turn after a friendly swap · discard a card after an enemy swap.",
    need: "Queen with at least one lifetime capture. Sacrifices an adjacent friendly queen, or 3 adjacent friendly pawns.",
    viaSpell: true,
  },
  alchemist: {
    name: "Alchemist", glyph: "⚗", on: "queen", cost: 6, cap: null,
    ability: "Can never move or capture again. Generates 1 FP at the start of each of your turns.",
    penalty: "Resource Contamination — no draw next turn, and no spell above 1 FP for 2 turns.",
    need: "Queen must be standing on your own back row. Sacrifices a friendly pawn.",
    viaSpell: true,
  },
};

/* ─────────────────────────────────────────────────────────────────────────
   SPELLS — an infinite, weighted draw pool. Every draw picks randomly across
   every currently-eligible id, weighted by `weight`. A card with `maxDraws`
   set can only ever be drawn that many times in the whole game — once every
   copy is drawn it drops out of the pool for good, the same scarcity a
   1- or 2-copy card used to have in the old finite deck. `oncePerGame`
   additionally removes a card the moment it is CAST, not merely drawn.

   `when`: "declare" | "end" | "any"  (which phase it may be cast in)
   `anyTurn`: castable on the opponent's turn as well
   `rarity`: what a card is worth being dealt — see RARITY below
   ───────────────────────────────────────────────────────────────────────── */

/**
 * RARITY — the authored knob. `weight` is derived from it just below, and the
 * draw itself never reads anything else.
 *
 * These are RELATIVE, not odds. A Common is 8x likelier to come up than a
 * Legendary; what that means as a percentage depends on how many cards are
 * eligible at the time, which changes as scarce cards run out and the Phaser
 * card parks itself. The rules screen therefore prints the real number rather
 * than a printed-on-the-card fiction.
 *
 * The scale is the one the pool was already using by hand — Evasive Maneuver
 * sat at 8, Temporal Cascade at 1 — so naming the tiers cost almost no
 * balance. Only Static Veil (5) and Eye For An Eye (3) moved, both to 4.
 */
const RARITY = { common: 8, uncommon: 4, rare: 2, legendary: 1 };

const SPELLS = {
  hopscotch: {
    name: "Hopscotch", cost: 3, rarity: "uncommon", when: "end", group: "Movement",
    text: "Return the piece that just captured to the square it jumped from. If the victim survived on armor, it is destroyed anyway.",
    penalty: "No spells next turn.",
    timing: "After a capture, before your opponent acts.",
  },
  evasive: {
    name: "Evasive Maneuver", cost: 3, rarity: "common", when: "declare", group: "Movement",
    text: "One of your pawns steps one square diagonally backward into an empty square. Cannot capture.",
    penalty: "That pawn cannot move next turn.",
    timing: "Declare Action phase only.",
  },
  mirror: {
    name: "Mirror Step", cost: 2, rarity: "uncommon", when: "any", group: "Movement",
    text: "A queen teleports to the mirrored square across the centreline — row r column c becomes row 11−r column 11−c. Wasted if the destination is occupied.",
    penalty: "Distortion Field — every friendly pawn adjacent to the queen after the jump skips its next move.",
    timing: "Before or after moving.",
  },
  veil: {
    name: "Static Veil", cost: 2, rarity: "uncommon", group: "Combat", when: "declare",
    text: "One enemy piece cannot capture for its next two turns. It may still move.",
    penalty: "Friendly fire — when the stun ends, your nearest free pawn to that piece falls sick and cannot move for a turn.",
    timing: "Declare Action phase only.",
  },
  mindcontrol: {
    name: "Mind Control", cost: 3, rarity: "uncommon", group: "Combat", when: "declare",
    text: "Take one movement with an enemy piece that has a legal move.",
    penalty: "Exhaustion — no more spells this turn or next, and discard a card.",
    timing: "Your turn only.",
  },
  eye: {
    name: "Eye For An Eye", cost: 3, rarity: "uncommon", group: "Combat", when: "declare",
    text: "Mark an untransformed friendly pawn. For your opponent's next 3 turns, anything that captures it dies with it.",
    penalty: "The marked pawn is Static next turn · no other spells next turn.",
    timing: "Declare Action phase only.",
  },
  chronos: {
    name: "Chronos's Gaze", cost: 4, rarity: "rare", maxDraws: 2, group: "Game Altering", when: "declare",
    flavor: "The past is flexible. Unmake your last mistake.",
    text: "Rewind the board, both Focus Point pools, and both hands to the start of one of your last 2 turns.",
    penalty: "Chronal Backlash — discard your hand down to a single card.",
    timing: "Start of your turn, right after your opponent finishes theirs.",
  },
  cascade: {
    name: "Temporal Cascade", cost: 5, rarity: "legendary", maxDraws: 1, group: "Game Altering", when: "declare",
    flavor: "The world holds its breath. Only you may move.",
    text: "Take 2 additional consecutive turns — 3 in a row in total.",
    penalty: "Discard your entire hand, sacrifice a pawn, and neither draw nor transform for 4 turns.",
    timing: "Declare Action phase. Removed from the game after use.",
    oncePerGame: true,
  },
  martyr: {
    name: "The Martyr's Pledge", cost: 3, rarity: "rare", maxDraws: 2, group: "Game Altering", when: "any",
    flavor: "Long live the queen.",
    text: "Revive one of your captured queens. Playable at any time, even on your opponent's turn.",
    penalty: "Your rearmost pawn is sacrificed and the queen takes its square. Consumes your turn.",
    timing: "Any time — including your opponent's turn.",
    anyTurn: true,
  },
  phaserSpell: {
    name: "Phaser", cost: 3, rarity: "uncommon", group: "Transformation", when: "declare",
    text: "Transform one of your pawns that has captured at least once into a Phaser.",
    penalty: "The pawn is disoriented and skips its next movement.",
    timing: "Declare Action phase. Set aside while a Phaser lives; returns to the pool when one dies.",
  },
  juggernautSpell: {
    name: "Juggernaut", cost: 3, rarity: "uncommon", group: "Transformation", when: "any",
    text: "Transform one of your pieces into a Juggernaut, sacrificing an adjacent friendly pawn as armor. Must be captured twice — the first capture strips the armor.",
    penalty: "Cannot move next turn · consumes your whole turn.",
    timing: "Either phase, on your own turn.",
  },
  sentinelSpell: {
    name: "Sentinel", cost: 3, rarity: "uncommon", group: "Transformation", when: "any",
    text: "Transform one of your pawns into a Sentinel — solid terrain that cannot move, capture, or be jumped over. Requires a turn in which you have neither moved nor cast another spell.",
    penalty: "Every friendly piece in the same column behind it is frozen next turn · consumes your whole turn.",
    timing: "Either phase, on your own turn, before any other action.",
  },
  heraldSpell: {
    name: "Herald", cost: 3, rarity: "uncommon", group: "Transformation", when: "any",
    text: "Transform a pawn standing on the opponent's half of the board into a Herald. A friendly pawn landing adjacent to it may advance one extra square (no capture).",
    penalty: "The Herald is frozen next turn.",
    timing: "Either phase, on your own turn.",
  },
  enchanterSpell: {
    name: "Enchanter", cost: 3, rarity: "rare", maxDraws: 2, group: "Transformation", when: "any",
    text: "Transform a queen that has captured at least once into an Enchanter, sacrificing an adjacent friendly queen or 3 adjacent friendly pawns. May swap places with any piece, friendly or enemy.",
    penalty: "Frozen 2 turns on transform · frozen 1 turn after a friendly swap · discard a card after an enemy swap.",
    timing: "Either phase, on your own turn.",
  },
  alchemistSpell: {
    name: "Alchemist", cost: 6, rarity: "legendary", maxDraws: 1, group: "Transformation", when: "any",
    text: "Transform a queen standing on your own back row into an Alchemist, sacrificing a friendly pawn. Can never move or capture again, but generates 1 FP at the start of each of your turns.",
    penalty: "Resource Contamination — no draw next turn, and no spell above 1 FP for 2 turns.",
    timing: "Either phase, on your own turn.",
  },

  /* ── the board itself ─────────────────────────────────────────────────
     These four do not touch a piece. They change the terms the game is
     played on — where the edges are, which squares exist, how far back the
     past reaches — and they last beyond the turn that paid for them.
     ─────────────────────────────────────────────────────────────────── */
  tactician: {
    name: "Tactician", cost: 1, rarity: "common", group: "Combat", when: "declare",
    flavor: "Count the throats before you cut one.",
    text: "Gain 1 FP for every capture currently available to you, whether or not you take it.",
    penalty: "You must take one of them this turn — the turn cannot be ended until you do.",
    timing: "Declare Action phase, before you move.",
  },
  rift: {
    name: "Rift", cost: 4, rarity: "uncommon", group: "Movement", when: "declare",
    text: "Choose two empty dark squares. Any piece, friendly or enemy, that lands on one is immediately carried to the other.",
    penalty: "The rift is inert for the rest of the turn that opened it.",
    timing: "Declare Action phase only.",
  },
  wraparound: {
    name: "Wraparound", cost: 4, rarity: "uncommon", group: "Game Altering", when: "declare",
    flavor: "The board was never flat.",
    text: "For 2 rounds the left and right edges join. A piece leaving one edge emerges on the other, on the same diagonal.",
    penalty: "It applies to your opponent exactly as much as to you.",
    timing: "Declare Action phase only.",
  },
  anchor: {
    name: "Anchor In Time", cost: 3, rarity: "uncommon", group: "Game Altering", when: "declare",
    flavor: "Some moments refuse to be unmade.",
    text: "Lock the present. For the rest of the game neither player may rewind past this turn with Chronos's Gaze or Echo.",
    penalty: "It binds you too — you lose those rewinds just as your opponent does.",
    timing: "Declare Action phase only.",
  },
  echo: {
    name: "Echo", cost: 4, rarity: "uncommon", group: "Game Altering", when: "declare",
    flavor: "It remembers standing there.",
    text: "Send one of your pieces back to the square it stood on 3 turns ago, if that square is empty now.",
    penalty: "It arrives wearing the freezes it wore then, including ones it has since shaken off. Removed from the game after use.",
    timing: "Declare Action phase. Once per game.",
    oncePerGame: true,
  },
  chokepoint: {
    name: "Chokepoint", cost: 4, rarity: "rare", group: "Game Altering", when: "declare",
    flavor: "Close the door they were all walking through.",
    text: "The busiest square in your opponent's position — the one most of their moves run through — is sealed permanently. Nothing may land on it or jump over it again.",
    penalty: "You cannot cast a spell for 2 turns.",
    timing: "Declare Action phase only.",
  },
};
const SPELL_IDS = Object.keys(SPELLS);

// Rarity is what the cards are authored with; `weight` is what the draw reads.
// Deriving it here rather than writing both by hand is what stops the two from
// ever disagreeing.
for (const id of SPELL_IDS) SPELLS[id].weight = RARITY[SPELLS[id].rarity];

/* ══════════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════════ */
let G = null;      // game state — cloneable

/**
 * Piece ids live on G rather than in a module global. They have to: the counter
 * must rewind with the board when Chronos's Gaze or an undo restores an earlier
 * snapshot, or newly-created pieces collide with revived ones — and `martyrWatch`
 * and the Enchanter's self-check both compare pieces by id. It also keeps two
 * games in the same server process from sharing a counter.
 */
function mkPiece(owner, rank, g = G) {
  return {
    id: g.seq++,
    owner,
    rank,                 // "pawn" | "queen"
    form: null,           // key of FORMS, or null
    armor: false,         // Juggernaut's sacrificed pawn
    captures: 0,          // lifetime captures, gates Phaser + Enchanter
    frozen: 0,            // turns this piece cannot move or capture
    noCapture: 0,         // Static Veil — may move, may not capture
    veilBy: null,         // who cast the veil (owed the friendly-fire penalty)
    eyeMark: 0,           // Eye For An Eye — opponent turns remaining
  };
}

function newPlayerState() {
  return {
    fp: 0,
    turnsTaken: 0,      // your own turns, which is what paces the Focus drip
    hand: [],
    noSpells: 0,        // turns during which no spell may be cast
    noDraw: 0,          // turns during which no card may be drawn
    noTransform: 0,     // turns during which no transformation may be made
    costCap: 0,         // turns during which spells above `costCapMax` are barred
    costCapMax: 1,
    extraTurns: 0,      // Temporal Cascade
    lostQueens: [],     // captured queens, revivable by Martyr's Pledge
    martyrBanned: false,// a revived queen died before a new one was crowned
    martyrWatch: null,  // id of a revived queen still on probation
  };
}

/** Every spell id currently eligible to be drawn — excludes cards removed
 *  (oncePerGame, used), set aside (Phaser, while one lives), or exhausted
 *  (maxDraws hit). */
function eligibleSpellIds() {
  return SPELL_IDS.filter((id) => {
    if (G.removed.includes(id)) return false;
    if (G.setAside.includes(id)) return false;
    const cap = SPELLS[id].maxDraws;
    if (cap != null && (G.drawCounts[id] || 0) >= cap) return false;
    return true;
  });
}

/* Seeded PRNG so a seed can be pinned in tests. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `opts.dev` opens the sandbox — see the DEV SANDBOX section below. It is a
 * third positional argument for one reason: the server builds its games with
 * `newGame(0)` and nothing on the socket path ever reaches this parameter, so
 * an online game cannot be talked into sandbox mode however a client lies.
 */
function newGame(firstPlayer = 0, seed = null, opts = {}) {
  const s = seed == null ? (Math.floor(Math.random() * 1e9)) : seed;

  const board = new Array(CELLS).fill(null);
  const g = {
    seq: 1,                 // next piece id — see mkPiece
    seed: s,
    board,
    players: [newPlayerState(), newPlayerState()],
    turn: firstPlayer,
    phase: "declare",       // "declare" | "end"
    hasActed: false,        // a move or transformation has been made this turn
    castThisTurn: 0,        // spells cast this turn
    drewThisTurn: false,
    turnNo: 1,
    chain: null,            // index of a piece mid-chain-jump; must keep capturing
    heraldBonus: null,      // index of a piece owed a Herald bonus step
    lastCapture: null,      // { from, to, victimIdx, victimSurvived } — Hopscotch's target
    lastMove: null,         // { from, to } for board highlighting
    drawCounts: {},         // id -> lifetime draw count, for maxDraws scarcity
    drawSeq: 0,              // monotonic; seeds each weighted draw's PRNG
    rift: null,             // Rift — { a, b, madeOn } linking two squares
    wrap: 0,                // Wraparound — rounds left with the edges joined
    anchor: null,           // Anchor In Time — { turnNo } no rewind may pass
    barriers: [],           // Chokepoint — permanently sealed square indices
    mustCapture: null,      // Tactician — { player } owes a capture this turn
    setAside: [],           // Phaser cards parked while a Phaser lives
    removed: [],            // Temporal Cascade after use
    log: [],
    fx: [],                 // presentation transcript — see the fx() section
    fxSeq: 1,               // monotonic; never rewinds, even through a restore
    over: null,             // { winner, reason }
    history: [],            // snapshots taken at the start of each turn
    mindControl: null,      // { piece } while a Mind Control move is pending
    owedDiscard: null,      // { player, n, why } — forced discard pending
    owedSacrifice: null,    // { player, candidates } — declined-capture forfeit pending
    dev: opts.dev === true, // the sandbox. Never true on a game the server owns.
  };

  // Violet on rows 0-3, Gold on rows 8-11 — dark squares only, 24 each.
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < N; c++)
      if (isDark(rc(r, c))) board[rc(r, c)] = mkPiece(1, "pawn", g);
  for (let r = N - 4; r < N; r++)
    for (let c = 0; c < N; c++)
      if (isDark(rc(r, c))) board[rc(r, c)] = mkPiece(0, "pawn", g);

  return g;
}

/* Snapshot/restore. `history` is stripped from the copy so snapshots do not
   nest exponentially, and `fx` because restore() discards it anyway — carrying
   forty copies of a transcript nobody will ever replay is pure weight.
   viewFor() puts a real `fx` back on the wire view; see there. */
function snapshot(g) {
  const { history, fx: _fx, ...rest } = g;
  return structuredClone(rest);
}
function restore(snap) {
  const history = G.history;
  // The effect counter survives the rewind and the transcript does not.
  //
  // Both halves matter. If `fxSeq` went backwards the client's high-water mark
  // would sit above it and silently swallow every effect until the counter
  // caught up again — a rewind would cost you the next several animations. And
  // the restored `fx` is a transcript of a past that is being unmade, so
  // replaying it would show the player moves that no longer happened.
  //
  // It also means the machine's search, which sandboxes speculative spells
  // behind snapshot/restore, throws away the effects it imagined for free.
  const fxSeq = G.fxSeq;
  G = structuredClone(snap);
  G.history = history;
  G.fxSeq = fxSeq;
  G.fx = [];
}

/* ══════════════════════════════════════════════════════════════════════════
   THE DEV SANDBOX

   `G.dev` turns the referee into a workbench: act as many times as you like in
   one turn, hold the whole spell book at once, transform without paying, and
   never run out of Focus. It is reached only from the opening menu on this
   device, and only through newGame's `opts.dev` — the server never passes it.

   Three rules keep it from becoming a second, divergent ruleset:

   1. IT LIVES HERE, not in the interface. The interface greys out cards and
      draws move dots with the same spellBlocker / transformBlocker the referee
      checks against. Relaxing a gate in one place and not the other would show
      you a card that then refuses to cast.

   2. IT RELAXES, IT DOES NOT REWRITE. Everything below removes a cost, a
      counter or a precondition. Nothing changes how a capture resolves or what
      a form does, so a position built in the sandbox behaves like a real one.
      Penalties still bite — a Juggernaut still freezes the piece it armors.
      Those are what the form DOES, not a toll on the way in, and a sandbox you
      cannot reproduce a real effect in is not much of a sandbox.

   3. WHAT IT KEEPS, IT KEEPS FOR A REASON. Pawn-forms stay on pawns, a piece
      holds one form, and a sacrifice must still be payable. Those are not
      costs, they are assumptions the rest of this file is built on; a queen
      wearing a pawn's form is a crash waiting for the right move.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Refill both pools and lift every lockout. It writes `fp` directly rather than
 * going through awardFP, which would announce the overflow as wasted income on
 * every single action.
 */
function devTopUp() {
  for (const P of G.players) {
    P.fp = FP_CAP;
    P.noSpells = 0; P.noDraw = 0; P.noTransform = 0; P.costCap = 0;
    P.p_noSpells = 0; P.p_noDraw = 0; P.p_noTransform = 0; P.p_costCap = 0;
    P.martyrBanned = false;
  }
}

/** Both hands hold one of everything, always. The deck is left alone. */
function devStockHands() {
  for (const P of G.players) P.hand = SPELL_IDS.slice();
}

/**
 * Reopen the turn after an action. An obligation is not an option, so a pending
 * chain-jump, Herald step, seized piece or owed forfeit still has to be settled
 * before the Declare phase comes back — otherwise you could walk away from a
 * half-finished capture and leave the board in a state no rule describes.
 */
function devUnlock() {
  devTopUp();
  devStockHands();
  G.hasActed = false;
  G.castThisTurn = 0;
  G.drewThisTurn = false;
  if (G.chain == null && G.heraldBonus == null && !G.mindControl
      && !G.owedSacrifice && !G.owedDiscard) G.phase = "declare";
}

/* ══════════════════════════════════════════════════════════════════════════
   LOGGING
   ══════════════════════════════════════════════════════════════════════════ */
function log(text, kind = "sys") {
  G.log.push({ text, kind });
  if (G.log.length > 400) G.log.shift();
}
const sq = i => String.fromCharCode(97 + colOf(i)) + (N - rowOf(i));
function pieceLabel(p) {
  if (!p) return "piece";
  const base = p.rank === "queen" ? "Queen" : "Pawn";
  return p.form ? `${FORMS[p.form].name} ${base}` : base;
}

/* ══════════════════════════════════════════════════════════════════════════
   PRESENTATION EVENTS

   The board rebuilds itself from scratch on every render, so the interface
   cannot tell a capture from a teleport by diffing squares — by the time it
   looks, the victim is simply gone. And online it never even sees the actions:
   the server sends whole-state snapshots, so a client that did not act has no
   idea what just happened.

   So the referee says so. `G.fx` is a short list of what it just did, written
   at the same moments as the log lines and, like everything else on G, plain
   cloneable data — which means viewFor() carries it across the wire for free
   and BOTH players see the same animation. Nothing here may ever be read by a
   rule; it is a transcript, not state.

   `fxSeq` is the client's high-water mark. It is deliberately monotonic and
   never rewinds — see restore(), which is what makes replaying idempotent when
   the same state arrives twice.

   Discipline: an event may carry only what the referee log already makes
   public. Casting a spell is announced, so naming one is fine. A discard is
   logged as a COUNT, so a discard event must never name the card.
   ══════════════════════════════════════════════════════════════════════════ */

const FX_KEEP = 48;          // a headless self-play game must not grow this forever

function fx(type, data) {
  if (!G || !G.fx) return;
  G.fx.push(Object.assign({ n: G.fxSeq++, type }, data));
  if (G.fx.length > FX_KEEP) G.fx.shift();
}

/** Enough of a piece to draw a convincing ghost of it after it is gone. */
const fxPiece = p =>
  p ? { owner: p.owner, rank: p.rank, form: p.form, armor: !!p.armor } : null;

/* ══════════════════════════════════════════════════════════════════════════
   RULES ENGINE  —  pure queries over state, zero interface knowledge.
   Everything the referee decides is derived here so the test suite can
   assert on it without touching the DOM.
   ══════════════════════════════════════════════════════════════════════════ */

const at = i => G.board[i];
const isEnemy = (p, owner) => p && p.owner !== owner;
const isAlly  = (p, owner) => p && p.owner === owner;

/* A Sentinel is terrain: it never acts and never gets jumped. */
const isSentinel = p => p && p.form === "sentinel";
/* The Alchemist trades mobility for income, permanently. */
const isImmobile = p => p && (p.form === "sentinel" || p.form === "alchemist");

/** Can this piece take a movement action at all right now? */
function canAct(p) {
  return !!p && !isImmobile(p) && p.frozen <= 0;
}
/** Can this piece perform a capture right now? */
function canCapture(p) {
  return canAct(p) && p.noCapture <= 0;
}

/** Diagonal directions this piece may travel. Pawns advance only. */
function moveDirs(p) {
  if (p.rank === "queen") return DIAG;
  const f = fwd(p.owner);
  return [[f, -1], [f, 1]];
}
/** Diagonal directions this piece may capture along. Same rule: pawns forward. */
function captureDirs(p) {
  return moveDirs(p);
}

/* ── where the edges are ──────────────────────────────────────────────────
   Every question of the form "is there a square that way?" goes through
   cellAt. It used to be nine separate `onBoard` guards, which was fine while
   the answer was always the same one; Wraparound makes the answer depend on
   game state, and nine copies of a rule that changes is eight too many.
   ─────────────────────────────────────────────────────────────────────── */

/**
 * The index of the square at (r, c), or -1 if there is no such square.
 *
 * Rows never wrap. The far row is where pawns are crowned and where an
 * advance runs out of board; a vertically wrapping board has neither, so the
 * spell only ever joins the left and right edges.
 *
 * Columns wrap only while Wraparound is running. Because N is even, wrapping
 * preserves square colour on its own — a diagonal step across the seam has
 * Δc = ∓11 and a Phaser's shift Δc = ∓10, and both leave (r + c) % 2 alone.
 * So pieces stay on dark squares with no special handling anywhere.
 */
function cellAt(r, c) {
  if (r < 0 || r >= N) return -1;
  if (c < 0 || c >= N) {
    if (!G || !G.wrap) return -1;
    c = ((c % N) + N) % N;
  }
  return rc(r, c);
}

/** Is index `i` diagonally adjacent to a piece matching `pred`? */
function adjacentTo(i, pred) {
  const r = rowOf(i), c = colOf(i);
  const out = [];
  for (const [dr, dc] of DIAG) {
    const j = cellAt(r + dr, c + dc);
    if (j < 0) continue;
    if (pred(G.board[j], j)) out.push(j);
  }
  return out;
}

/** Squares a pawn at `i` may step diagonally BACKWARD into — Evasive Maneuver's
 *  retreat. One definition, read by the targeting, the validator and the AI. */
function backStepsFrom(i, owner) {
  const r = rowOf(i), c = colOf(i), b = -fwd(owner);
  const out = [];
  for (const dc of [-1, 1]) {
    const j = cellAt(r + b, c + dc);
    if (j >= 0 && !G.board[j] && !isBarrier(j)) out.push(j);
  }
  return out;
}

/** Is this square sealed by a Chokepoint? Barriers are not pieces — see the
 *  `barriers` note in newGame — so every path has to ask separately. */
const isBarrier = (i) => G.barriers.includes(i);

/* ── movement ───────────────────────────────────────────────────────────── */

/** Non-capturing destinations for the piece at `i`. */
function simpleMoves(i) {
  const p = at(i);
  if (!canAct(p)) return [];
  const r = rowOf(i), c = colOf(i);
  const out = [];

  for (const [dr, dc] of moveDirs(p)) {
    const j = cellAt(r + dr, c + dc);
    if (j >= 0 && !G.board[j] && !isBarrier(j)) out.push({ to: j, kind: "step" });
  }

  // Phaser: 2 squares orthogonally, may pass through an occupied square but
  // never land on one. The 2-square distance keeps it on dark squares.
  if (p.form === "phaser") {
    for (const [dr, dc] of ORTHO) {
      const j = cellAt(r + dr, c + dc);
      if (j < 0) continue;
      if (!G.board[j] && !isBarrier(j)) out.push({ to: j, kind: "phase" });
    }
  }

  // Enchanter: its movement is a swap with any other piece on the board.
  if (p.form === "enchanter") {
    for (let j = 0; j < CELLS; j++)
      if (j !== i && G.board[j]) out.push({ to: j, kind: "swap" });
  }
  return out;
}

/** Capture jumps available to the piece at `i`. */
function captureMoves(i) {
  const p = at(i);
  if (!canCapture(p)) return [];
  const r = rowOf(i), c = colOf(i);
  const out = [];
  for (const [dr, dc] of captureDirs(p)) {
    // Both squares are resolved through cellAt. The victim's used to be
    // computed unguarded, which was safe only because a landing square off
    // the board always failed first — under Wraparound the landing wraps
    // back on, so an unwrapped victim index would read the wrong square.
    const mid = cellAt(r + dr, c + dc);          // the victim's square
    const land = cellAt(r + dr * 2, c + dc * 2); // the landing square
    if (mid < 0 || land < 0) continue;
    const victim = G.board[mid];
    if (!isEnemy(victim, p.owner)) continue;
    if (isSentinel(victim)) continue;           // Sentinels cannot be jumped
    if (isBarrier(mid)) continue;               // nor may a sealed square be crossed
    if (G.board[land] || isBarrier(land)) continue;   // landing must be empty
    out.push({ to: land, kind: "capture", victim: mid });
  }
  return out;
}

/** Every piece belonging to `owner` that has at least one capture available. */
function capturersFor(owner) {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (isAlly(p, owner) && captureMoves(i).length) out.push(i);
  }
  return out;
}

/** Every legal destination for the piece at `i`, honoring chain-jump lock-in. */
function legalMovesFor(i) {
  const p = at(i);
  if (!p) return [];
  // Mid-chain: only the chaining piece may act, and only by capturing.
  if (G.chain != null) return i === G.chain ? captureMoves(i) : [];
  // Owed a Herald bonus step: only that piece, only a plain forward step.
  if (G.heraldBonus != null) return i === G.heraldBonus ? legalHeraldSteps(i) : [];
  return [...captureMoves(i), ...simpleMoves(i)];
}

/** Does `owner` have any legal piece movement at all? (Used for blockade.) */
function hasAnyMove(owner) {
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (!isAlly(p, owner)) continue;
    if (captureMoves(i).length || simpleMoves(i).length) return true;
  }
  return false;
}

function countPieces(owner) {
  let n = 0;
  for (const p of G.board) if (isAlly(p, owner)) n++;
  return n;
}
function countForm(form, owner = null) {
  let n = 0;
  for (const p of G.board)
    if (p && p.form === form && (owner == null || p.owner === owner)) n++;
  return n;
}
function findPiece(pred) {
  for (let i = 0; i < CELLS; i++) if (G.board[i] && pred(G.board[i], i)) return i;
  return -1;
}

/* ── transformations ────────────────────────────────────────────────────── */

/** Why can't `owner` turn the piece at `i` into `form`? Returns null if legal. */
function transformBlocker(i, form, opts = {}) {
  const p = at(i);
  const F = FORMS[form];
  const P = G.players[p ? p.owner : 0];
  if (!p) return "No piece there.";
  if (p.form) return `Already a ${FORMS[p.form].name} — a piece may only ever hold one transformation.`;
  if (F.on === "pawn" && p.rank !== "pawn") return "Pawns only.";
  if (F.on === "queen" && p.rank !== "queen") return "Queens only.";
  // Sandbox: the cost, the caps, the timing and the earned preconditions all
  // go. What survives is whether the sacrifice can actually be paid — offering
  // a transformation the dispatcher would then refuse is worse than refusing it
  // here, and applyTransform would be handed an undefined victim either way.
  if (G.dev) return devSacrificeBlocker(i, form);
  if (!opts.skipTurnChecks) {
    if (P.noTransform > 0) return `Transformation barred for ${P.noTransform} more turn(s).`;
    if (P.fp < F.cost) return `Costs ${F.cost} FP — you have ${P.fp}.`;
  }
  if (F.cap != null) {
    const scope = F.capScope === "board" ? null : p.owner;
    const have = countForm(form, scope);
    if (have >= F.cap)
      return F.capScope === "board"
        ? `Only ${F.cap} ${F.name}(s) may exist on the board.`
        : `You may only have ${F.cap} ${F.name}(s).`;
  }

  switch (form) {
    case "juggernaut": {
      const pawns = adjacentTo(i, (q) => isAlly(q, p.owner) && q.rank === "pawn" && !q.form);
      if (!pawns.length) return "Needs an adjacent friendly pawn to sacrifice as armor.";
      break;
    }
    case "phaser":
      if (p.captures < 1) return "This pawn has never captured.";
      break;
    case "sentinel":
      if (G.hasActed || G.castThisTurn > 0)
        return "Requires a turn in which you neither move nor cast — declare it first.";
      break;
    case "herald":
      if (!onEnemyHalf(i, p.owner)) return "Must be on the opponent's half of the board.";
      break;
    case "enchanter": {
      if (p.captures < 1) return "This queen has never captured.";
      const queens = adjacentTo(i, (q) => isAlly(q, p.owner) && q.rank === "queen" && q.id !== p.id);
      const pawns = adjacentTo(i, (q) => isAlly(q, p.owner) && q.rank === "pawn");
      if (!queens.length && pawns.length < 3)
        return "Needs an adjacent friendly queen, or 3 adjacent friendly pawns, to sacrifice.";
      break;
    }
    case "alchemist": {
      if (rowOf(i) !== homeRow(p.owner)) return "The queen must be standing on your own back row.";
      if (findPiece((q) => isAlly(q, p.owner) && q.rank === "pawn") < 0)
        return "Needs a friendly pawn to sacrifice.";
      break;
    }
  }
  return null;
}

/**
 * Sandbox only. The one requirement a transformation cannot be talked out of:
 * something has to be given up. The pools are widened — any friendly pawn will
 * do, not merely an adjacent one — so this refuses only when the board has
 * genuinely run out of pieces to spend.
 */
function devSacrificeBlocker(i, form) {
  // Asked of the very same pools the dispatcher re-derives, so the menu and the
  // referee cannot disagree about what is payable.
  switch (form) {
    case "juggernaut":
      return juggernautArmorPool(i).length ? null : "No pawn left to sacrifice as armor.";
    case "alchemist":
      return friendlyPawns(at(i).owner).length ? null : "Needs a friendly pawn to sacrifice.";
    case "enchanter":
      return enchanterSacrificeOptions(i).length
        ? null
        : "Needs another friendly queen, or three friendly pawns, to sacrifice.";
    default:
      return null;
  }
}

/**
 * Friendly pieces that could take `form` right now, were its spell cast on
 * them — every transformation is reached through a spell (`FORMS[form].viaSpell`),
 * so this is the target-finder those spells' blockers and casts share. FP
 * cost and `noTransform` are the spell's own concern, checked by the caller;
 * `skipTurnChecks` here just keeps transformBlocker from re-checking a cost
 * that belongs to the spell, not the form.
 */
function transformSpellTargets(form, owner) {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    if (!isAlly(G.board[i], owner)) continue;
    if (!transformBlocker(i, form, { skipTurnChecks: true })) out.push(i);
  }
  return out;
}
const juggernautTargets = (owner) => transformSpellTargets("juggernaut", owner);
const sentinelTargets = (owner) => transformSpellTargets("sentinel", owner);
const heraldTargets = (owner) => transformSpellTargets("herald", owner);
const enchanterTargets = (owner) => transformSpellTargets("enchanter", owner);
const alchemistTargets = (owner) => transformSpellTargets("alchemist", owner);

/* ── spells ─────────────────────────────────────────────────────────────── */

/** Why can't the current player cast `id` right now? Returns null if legal. */
function spellBlocker(id, caster = G.turn) {
  const S = SPELLS[id];
  const P = G.players[caster];
  // Sandbox: the price, the lockouts and the phase window all go. The phase in
  // particular has to — devUnlock reopens the Declare phase after every action,
  // so an End Phase card like Hopscotch would otherwise never be castable at
  // all. What stays is the per-spell target check further down: a spell with
  // nothing to act on is not a rule being enforced, it is a crash being avoided.
  if (!G.dev) {
    if (!P.hand.includes(id)) return "Not in your hand.";
    if (P.noSpells > 0) return `No spells for ${P.noSpells} more turn(s).`;
    if (P.fp < S.cost) return `Costs ${S.cost} FP — you have ${P.fp}.`;
    if (P.costCap > 0 && S.cost > P.costCapMax)
      return `Resource Contamination — nothing above ${P.costCapMax} FP for ${P.costCap} more turn(s).`;
  }

  const myTurn = caster === G.turn;
  if (!myTurn && !S.anyTurn) return "Only on your own turn.";
  if (myTurn && !G.dev) {
    if (G.chain != null) return "Finish your chain-jump first.";
    if (S.when === "declare" && G.phase !== "declare") return "Declare Action phase only.";
    if (S.when === "end" && G.phase !== "end") return "End Phase only.";
  }
  // Even the sandbox will not let you walk away from a half-finished capture.
  if (myTurn && G.dev && G.chain != null) return "Finish your chain-jump first.";

  // Per-spell preconditions — checked here so the interface can grey out
  // cards that would fizzle rather than letting a player waste FP.
  switch (id) {
    case "hopscotch":
      if (!G.lastCapture) return "No capture to reverse.";
      break;
    case "evasive":
      if (!evasiveTargets(caster).length) return "No pawn can step backward.";
      break;
    case "mirror":
      if (!mirrorTargets(caster).length) return "No queen has a clear mirrored square.";
      break;
    case "veil":
      if (!veilTargets(caster).length) return "No enemy piece to stun.";
      break;
    case "mindcontrol":
      if (!mindControlTargets(caster).length) return "No enemy piece has a legal move.";
      break;
    case "eye":
      if (!eyeTargets(caster).length) return "No untransformed pawn to mark.";
      break;
    case "chronos":
      if (G.hasActed || G.castThisTurn > 0 || G.drewThisTurn)
        return "Only at the very start of your turn.";
      if (!chronosTargets(caster).length) return "There is no earlier turn to return to.";
      break;
    case "cascade":
      if (G.hasActed) return "Declare it before you act.";
      if (findPiece((q) => isAlly(q, caster) && q.rank === "pawn") < 0)
        return "Needs a pawn to sacrifice.";
      break;
    case "martyr":
      if (P.martyrBanned) return "A revived queen of yours already fell — this card is lost to you.";
      if (!P.lostQueens.length) return "You have no fallen queen.";
      if (findPiece((q) => isAlly(q, caster) && q.rank === "pawn") < 0)
        return "Needs a pawn to sacrifice.";
      break;
    case "phaserSpell":
      // The board-wide cap is the same kind of rule the sandbox drops for the
      // transformation caps, so it goes the same way.
      if (!G.dev && countForm("phaser") >= 2) return "Two Phasers already exist on the board.";
      if (!phaserTargets(caster).length) return "No pawn of yours has ever captured.";
      break;
    case "juggernautSpell":
      if (!G.dev && P.noTransform > 0) return `Transformation barred for ${P.noTransform} more turn(s).`;
      if (!juggernautTargets(caster).length) return "No piece can be armored as a Juggernaut.";
      break;
    case "sentinelSpell":
      if (!G.dev && P.noTransform > 0) return `Transformation barred for ${P.noTransform} more turn(s).`;
      if (!sentinelTargets(caster).length) return "No pawn can become a Sentinel.";
      break;
    case "heraldSpell":
      if (!G.dev && P.noTransform > 0) return `Transformation barred for ${P.noTransform} more turn(s).`;
      if (!heraldTargets(caster).length) return "No pawn can become a Herald.";
      break;
    case "enchanterSpell":
      if (!G.dev && P.noTransform > 0) return `Transformation barred for ${P.noTransform} more turn(s).`;
      if (!enchanterTargets(caster).length) return "No queen can become an Enchanter.";
      break;
    case "alchemistSpell":
      if (!G.dev && P.noTransform > 0) return `Transformation barred for ${P.noTransform} more turn(s).`;
      if (!alchemistTargets(caster).length) return "No queen can become an Alchemist.";
      break;

    case "tactician":
      if (G.hasActed) return "Count them before you move, not after.";
      if (!availableCaptures(caster)) return "You have no capture to count.";
      break;
    case "rift":
      if (G.rift) return "A rift is already open.";
      if (openSquares().length < 2) return "The board has no two empty squares to join.";
      break;
    case "wraparound":
      if (G.wrap > 0) return "The edges are already joined.";
      break;
    case "anchor":
      if (G.anchor) return "Time is already anchored.";
      break;
    case "echo":
      if (G.anchor) return "Time is anchored — nothing may reach back past it.";
      if (!echoTargets(caster).length) return "No piece of yours can return to where it stood.";
      break;
    case "chokepoint":
      if (chokepointTarget(caster) < 0) return "Your opponent has no move to seal off.";
      break;
  }
  return null;
}

/* target finders — shared by the blocker checks above and the targeting UI */
function evasiveTargets(owner) {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (!isAlly(p, owner) || p.rank !== "pawn" || isImmobile(p)) continue;
    if (backStepsFrom(i, owner).length) out.push(i);
  }
  return out;
}
function mirrorTargets(owner) {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (!isAlly(p, owner) || p.rank !== "queen" || isImmobile(p)) continue;
    if (!G.board[mirrorOf(i)]) out.push(i);
  }
  return out;
}
/**
 * Mirror across the centreline: (r, c) → (11−r, 11−c).
 *
 * Flipping the row alone would be the obvious reading, but on a 12x12 board
 * it inverts square colour — row 9 col 4 is dark, row 2 col 4 is light — so a
 * row-only mirror would teleport queens off the playable squares entirely.
 * Flipping both axes preserves colour, keeps the "cross into enemy territory"
 * intent, and is its own inverse.
 */
const mirrorOf = i => rc(N - 1 - rowOf(i), N - 1 - colOf(i));
function veilTargets(owner) {
  const out = [];
  for (let i = 0; i < CELLS; i++)
    if (isEnemy(G.board[i], owner) && G.board[i].noCapture <= 0 && !heraldShielded(i, owner)) out.push(i);
  return out;
}
/* Mind Control grants "one movement", not a capture — so the target needs a
   plain step available, per the card's own wording. */
function mindControlTargets(owner) {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (!isEnemy(p, owner) || heraldShielded(i, owner)) continue;
    if (simpleMoves(i).some((m) => m.kind === "step")) out.push(i);
  }
  return out;
}
function eyeTargets(owner) {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (isAlly(p, owner) && p.rank === "pawn" && !p.form && p.eyeMark <= 0) out.push(i);
  }
  return out;
}
function phaserTargets(owner) {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    // "Has captured at least once" is an earned precondition, the twin of the
    // one transformBlocker waives in the sandbox — so it is waived here too,
    // otherwise the Phaser card sits dead in a hand that holds everything.
    if (isAlly(p, owner) && p.rank === "pawn" && !p.form && (G.dev || p.captures >= 1)) out.push(i);
  }
  return out;
}
function enchanterSwapTargets(i) {
  const out = [];
  for (let j = 0; j < CELLS; j++) if (j !== i && G.board[j]) out.push(j);
  return out;
}
/**
 * The turnNo of each of `caster`'s own past turns Chronos's Gaze could return
 * to — most recent first, capped at 2. A turn's history entry is written at
 * its own start, so the CURRENT turn's entry (turnNo === G.turnNo) is not a
 * target; only turns already finished are.
 */
function chronosTargets(caster) {
  const out = [];
  for (let k = G.history.length - 1; k >= 0 && out.length < 2; k--) {
    const h = G.history[k];
    if (h.turn === caster && h.turnNo < G.turnNo && !anchoredAgainst(h.turnNo)) out.push(h.turnNo);
  }
  return out;
}

/* ── the board-altering four ────────────────────────────────────────────── */

/** Anchor In Time: is `turnNo` on the far side of the anchor, out of reach? */
const anchoredAgainst = (turnNo) => !!G.anchor && turnNo < G.anchor.turnNo;

/** Every capture `owner` could make right now, counted one per jump rather
 *  than one per piece — a pawn with two victims is two chances taken. */
function availableCaptures(owner) {
  let n = 0;
  for (const i of capturersFor(owner)) n += captureMoves(i).length;
  return n;
}

/** Empty dark squares, the pool Rift and Chokepoint both draw from. */
function openSquares() {
  const out = [];
  for (let i = 0; i < CELLS; i++)
    if (isDark(i) && !G.board[i] && !isBarrier(i)) out.push(i);
  return out;
}

/**
 * Echo: where the piece at `i` stood 3 of its owner's turns ago, or -1.
 *
 * History is one entry per turn taken by either player, so "3 turns ago" is
 * counted in the caster's OWN turns — otherwise the reach would halve every
 * time Temporal Cascade handed someone consecutive turns. Anchored turns are
 * out of reach, and the piece is found by id: a square is not an identity,
 * and the piece may well have moved since.
 */
function echoTarget(i, caster) {
  const p = G.board[i];
  if (!p || p.owner !== caster) return -1;
  let seen = 0;
  for (let k = G.history.length - 1; k >= 0; k--) {
    const h = G.history[k];
    if (h.turn !== caster || h.turnNo >= G.turnNo) continue;
    if (anchoredAgainst(h.turnNo)) return -1;
    if (++seen < 3) continue;
    const was = h.snap.board.findIndex((q) => q && q.id === p.id);
    if (was < 0 || was === i) return -1;
    if (G.board[was] || isBarrier(was)) return -1;    // the past is occupied
    return was;
  }
  return -1;
}

/** Pieces of `caster`'s that Echo could send back. */
function echoTargets(caster) {
  const out = [];
  for (let i = 0; i < CELLS; i++) if (echoTarget(i, caster) >= 0) out.push(i);
  return out;
}

/**
 * Chokepoint: the enemy square carrying the most traffic.
 *
 * "The most legal paths run through it" is not a quantity the doc defines, so
 * it is pinned down here: every enemy move that would LAND on a square or JUMP
 * OVER it counts as one path through it. Ties break toward the enemy's own
 * back row — sealing deep in their territory is worth more than sealing a
 * square they are about to leave — and then by index, so client and server
 * always name the same square.
 */
function chokepointTarget(caster) {
  const foe = 1 - caster;
  const traffic = new Map();
  const bump = (j) => traffic.set(j, (traffic.get(j) || 0) + 1);
  for (let i = 0; i < CELLS; i++) {
    if (!isAlly(G.board[i], foe)) continue;
    for (const m of simpleMoves(i)) bump(m.to);
    for (const m of captureMoves(i)) { bump(m.to); bump(m.victim); }
  }
  let best = -1, bestN = 0;
  for (const j of openSquares()) {
    const n = traffic.get(j) || 0;
    if (n === 0) continue;
    if (n > bestN
        || (n === bestN && best >= 0
            && Math.abs(rowOf(j) - homeRow(foe)) < Math.abs(rowOf(best) - homeRow(foe)))) {
      best = j; bestN = n;
    }
  }
  return best;
}

/* ══════════════════════════════════════════════════════════════════════════
   STATUS ENGINE

   Every "frozen", "disoriented", "sick" and "Static" effect in the rules is
   the same thing: a counter that ticks down at the END of the affected
   player's turn. Two setters keep the off-by-one honest:

     effNow  — active immediately, including the rest of the current turn.
               Correct for anything you inflict on your OPPONENT, since their
               turn hasn't started yet.
     effNext — parked in a pending slot and promoted when the current turn
               ends. Correct for penalties you take on YOURSELF, which the
               rules always word as "on your next turn".
   ══════════════════════════════════════════════════════════════════════════ */

function effNow(obj, key, turns) { obj[key] = Math.max(obj[key] || 0, turns); }
function effNext(obj, key, turns) {
  const pk = "p_" + key;
  obj[pk] = Math.max(obj[pk] || 0, turns);
}
function tickEffects(obj, keys) {
  for (const k of keys) {
    if (obj[k] > 0) obj[k]--;
    const pk = "p_" + k;
    if (obj[pk] > 0) { obj[k] = Math.max(obj[k] || 0, obj[pk]); obj[pk] = 0; }
  }
}

const PIECE_EFFECTS  = ["frozen", "noCapture"];
const PLAYER_EFFECTS = ["noSpells", "noDraw", "noTransform", "costCap"];

/** Freeze a piece for `turns` of its owner's turns, respecting who is acting. */
function freezePiece(p, turns, note) {
  if (!p) return;
  if (p.owner === G.turn) effNext(p, "frozen", turns);
  else effNow(p, "frozen", turns);
  if (note) log(note, "rule");
}

/* ══════════════════════════════════════════════════════════════════════════
   BOARD MUTATIONS
   ══════════════════════════════════════════════════════════════════════════ */

function awardFP(owner, n, why) {
  if (n <= 0) return;
  const P = G.players[owner];
  const gained = Math.min(n, Math.max(0, FP_CAP - P.fp));
  if (gained > 0) {
    P.fp += gained;
    log(`${PLAYERS[owner].name} +${gained} FP — ${why}.`, "p" + owner);
  }
  const wasted = n - gained;
  if (wasted > 0)
    log(`${PLAYERS[owner].name} is full at ${FP_CAP} FP — ${wasted} FP from ${why} is wasted. Spend it or lose it.`, "rule");
}

/**
 * Remove the piece at `i` from the board and run every consequence:
 * fallen-queen bookkeeping for Martyr's Pledge, the Phaser card returning to
 * the draw pool, and the probation on a revived queen.
 *
 * Every piece that ever leaves the board leaves through here, which makes this
 * the one place the death effect has to be recorded. `kind` is what tells the
 * interface whether it was killed or given up — the rules draw that line
 * sharply and so should the animation.
 */
function removePiece(i, why = "captured", kind = "capture") {
  const p = G.board[i];
  if (!p) return null;
  fx("death", { at: i, kind, piece: fxPiece(p) });
  G.board[i] = null;
  const P = G.players[p.owner];

  if (p.rank === "queen") {
    P.lostQueens.push({ form: p.form });
    if (P.martyrWatch === p.id) {
      P.martyrBanned = true;
      P.martyrWatch = null;
      log(`The Martyr's Pledge is lost to ${PLAYERS[p.owner].name} — the revived queen fell before a new one was crowned.`, "big");
    }
  }
  if (p.form === "phaser") {
    const k = G.setAside.indexOf("phaserSpell");
    if (k >= 0) {
      G.setAside.splice(k, 1);
      log("The Phaser card returns to the pool — its Phaser died.", "sys");
    }
  }
  log(`${PLAYERS[p.owner].name}'s ${pieceLabel(p)} at ${sq(i)} ${why}.`, "p" + p.owner);
  return p;
}

/** Promote a pawn standing on its promotion row. Returns true if it promoted. */
function promoteIfDue(i) {
  const p = G.board[i];
  if (!p || p.rank !== "pawn" || rowOf(i) !== promoRow(p.owner)) return false;
  p.rank = "queen";
  fx("promote", { at: i, owner: p.owner, form: p.form });
  awardFP(p.owner, 2, `a pawn was crowned at ${sq(i)}`);
  // A freshly crowned queen lifts the probation on a Martyr's Pledge revival.
  const P = G.players[p.owner];
  if (P.martyrWatch != null && P.martyrWatch !== p.id) P.martyrWatch = null;
  return true;
}

/**
 * Resolve a single capture jump. Handles Juggernaut armor and the Eye For An
 * Eye retaliation. Returns { destroyed, retaliated }.
 */
function resolveCapture(fromIdx, mv) {
  const attacker = G.board[fromIdx];
  const victim = G.board[mv.victim];
  let destroyed = false, retaliated = false;

  if (victim.armor) {
    victim.armor = false;
    fx("armor", { at: mv.victim, from: fromIdx });
    log(`${pieceLabel(victim)} at ${sq(mv.victim)} loses its armor but survives.`, "rule");
    awardFP(attacker.owner, 1, "armor stripped");
  } else {
    const wasMarked = victim.eyeMark > 0;
    const wasTransformed = !!victim.form;
    removePiece(mv.victim, "is captured");
    destroyed = true;
    awardFP(attacker.owner, wasTransformed ? 2 : 1, wasTransformed ? "captured a transformed piece" : "capture");
    if (wasMarked) retaliated = true;
  }

  // The attacker vacates its old square and lands beyond the victim.
  G.board[fromIdx] = null;
  G.board[mv.to] = attacker;
  attacker.captures++;

  if (retaliated) {
    // The tether is drawn from the square that was marked to the square the
    // killer landed on, so the animation can pull one back into the other.
    fx("eyeTether", { from: mv.victim, to: mv.to });
    removePiece(mv.to, "is dragged down by Eye For An Eye", "eye");
    log("Eye For An Eye — the capturer dies with its prey.", "big");
  }
  return { destroyed, retaliated };
}

/** Does a capturing piece that landed on `i` have to stop because of a Sentinel? */
function sentinelHalts(i, owner) {
  return adjacentTo(i, (q) => isEnemy(q, owner) && isSentinel(q)).length > 0;
}

/** Is the pawn at `i` standing next to a friendly Herald? */
function heraldAdjacent(i) {
  const p = G.board[i];
  if (!p || p.rank !== "pawn" || p.form === "herald") return false;
  return adjacentTo(i, (q) => isAlly(q, p.owner) && q.form === "herald").length > 0;
}

/**
 * Is the piece at `i` a friendly pawn or queen of its own Herald's escort,
 * shielded from a spell `caster` — who must be its opponent — is trying to
 * cast on it? A player's own spells still work on their own pieces near
 * their own Herald; this only blocks the enemy from reaching in.
 */
function heraldShielded(i, caster) {
  const p = G.board[i];
  if (!p || p.owner === caster) return false;
  return adjacentTo(i, (q) => isAlly(q, p.owner) && q.form === "herald").length > 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   THE MANDATORY CAPTURE RULE

   Skipping an available capture is legal but costs you the piece that should
   have taken it. You choose which one, so if several pieces could have
   captured, the interface asks before anything is removed.
   ══════════════════════════════════════════════════════════════════════════ */

function pendingSacrifice(owner) {
  if (G.chain != null || G.heraldBonus != null) return [];
  return capturersFor(owner);
}

/* ══════════════════════════════════════════════════════════════════════════
   MOVE EXECUTION
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Execute `mv` for the piece at `from`. Callers must have already settled any
 * forced-capture sacrifice. `opts.borrowed` marks a Mind Control move, which
 * belongs to the enemy piece's owner for FP purposes but is taken by us.
 */
function performMove(from, mv, opts = {}) {
  const p = G.board[from];
  if (!p) return;
  const owner = p.owner;
  G.lastMove = { from, to: mv.to };

  // Recorded before anything moves, while the squares still hold the pieces the
  // animation needs to draw. `chained` marks a hop that continues a sequence
  // rather than starting one, which is all the interface needs to count its own
  // way up and show a triple-jump building instead of repeating.
  fx("move", {
    from, to: mv.to, kind: mv.kind,
    piece: fxPiece(p),
    other: mv.kind === "swap" ? fxPiece(G.board[mv.to]) : null,
    chained: G.chain != null,
  });

  if (mv.kind === "capture") {
    const before = G.chain != null;
    const res = resolveCapture(from, mv);
    log(`${PLAYERS[owner].name} jumps ${sq(from)} → ${sq(mv.to)}.`, "p" + owner);
    G.lastCapture = { from, to: mv.to, victim: mv.victim, survived: !res.destroyed };

    if (res.retaliated) {           // the capturer is gone; nothing can chain
      G.chain = null;
      finishAction();
      return;
    }
    const promoted = promoteIfDue(mv.to);
    if (promoted) {
      log("Promotion ends the jump sequence.", "rule");
      G.chain = null;
      finishAction();
      return;
    }
    if (sentinelHalts(mv.to, owner)) {
      const walls = adjacentTo(mv.to, (q) => isEnemy(q, owner) && isSentinel(q));
      fx("sentinelHalt", { at: mv.to, walls });
      log(`A Sentinel adjacent to ${sq(mv.to)} forces the chain to stop.`, "rule");
      G.chain = null;
      // The Sentinel ends the JUMP SEQUENCE, not the move. The pawn is standing
      // on mv.to like any other, so pass it through — a Herald beside that
      // square still owes it a bonus step.
      finishAction(mv.to);
      return;
    }
    if (captureMoves(mv.to).length) {
      G.chain = mv.to;
      log("Chain-jump available — you must keep capturing.", "rule");
      G.hasActed = true;
      return;                        // turn continues, same piece locked in
    }
    G.chain = null;
    finishAction(mv.to);
    return;
  }

  // Enchanter swap — positions exchange, and the penalty depends on whose
  // piece was displaced.
  if (mv.kind === "swap") {
    const other = G.board[mv.to];
    G.board[mv.to] = p;
    G.board[from] = other;
    log(`${PLAYERS[owner].name}'s Enchanter swaps ${sq(from)} ↔ ${sq(mv.to)} with ${PLAYERS[other.owner].name}'s ${pieceLabel(other)}.`, "p" + owner);
    if (other.owner === owner) {
      effNext(p, "frozen", 1);
      log("Friendly swap — the Enchanter is frozen next turn.", "rule");
    } else {
      log("Enemy swap — you must discard a Spell Card.", "rule");
      G.owedDiscard = { player: owner, n: 1, why: "Enchanter enemy swap" };
    }
    promoteIfDue(mv.to);
    promoteIfDue(from);
    finishAction(null, true);
    return;
  }

  // Non-capturing movement
  G.board[from] = null;
  G.board[mv.to] = p;
  const verb = mv.kind === "phase" ? "phases" : mv.kind === "herald" ? "takes the Herald's bonus step" : "moves";
  log(`${PLAYERS[owner].name} ${verb} ${sq(from)} → ${sq(mv.to)}.`, "p" + owner);

  if (mv.kind === "phase") {
    // Phasing always disorients, and never captures anything it passes over.
    effNext(p, "frozen", 1);
    log("The Phaser is disoriented — it cannot move next turn.", "rule");
  }
  promoteIfDue(mv.to);

  if (mv.kind === "herald") { G.heraldBonus = null; finishAction(mv.to, true); return; }
  finishAction(mv.to);
}

/**
 * Close out a movement: offer the Herald bonus step if one is owed, otherwise
 * advance to the End Phase.
 */
function finishAction(landedAt = null, skipHerald = false) {
  G.hasActed = true;
  G.chain = null;
  // A rift swallows whatever finished its move on one end. Resolved here, at
  // the close of the movement, rather than mid-chain: a piece yanked across
  // the board halfway through a jump sequence has no sequence left to finish.
  const carried = riftCarry(landedAt);
  if (carried >= 0) landedAt = carried;
  if (!skipHerald && landedAt != null && heraldAdjacent(landedAt) && !G.heraldBonus) {
    const opts = legalHeraldSteps(landedAt);
    if (opts.length) {
      G.heraldBonus = landedAt;
      log("Herald's banner — this pawn may advance one more square (no capture).", "rule");
      return;
    }
  }
  G.heraldBonus = null;
  G.phase = "end";
}

/**
 * If a piece just finished its move on one end of the rift, carry it to the
 * other and return the square it arrived on. Returns -1 when nothing happens.
 *
 * The far end has to be empty — a rift is a door, not a weapon, and letting it
 * deliver a piece on top of another would need a capture rule nobody wrote.
 */
function riftCarry(landedAt) {
  if (landedAt == null || !G.rift) return -1;
  if (G.rift.madeOn === G.turnNo) return -1;        // inert on the turn it opened
  const { a, b } = G.rift;
  const to = landedAt === a ? b : landedAt === b ? a : -1;
  if (to < 0) return -1;
  const p = G.board[landedAt];
  if (!p || G.board[to]) return -1;
  G.board[landedAt] = null;
  G.board[to] = p;
  fx("riftCarry", { from: landedAt, to, piece: fxPiece(p) });
  log(`The rift takes ${PLAYERS[p.owner].name}'s ${pieceLabel(p)} from ${sq(landedAt)} to ${sq(to)}.`, "big");
  promoteIfDue(to);
  return to;
}

function legalHeraldSteps(i) {
  const p = G.board[i];
  if (!p) return [];
  const r = rowOf(i), c = colOf(i), f = fwd(p.owner);
  const out = [];
  for (const dc of [-1, 1]) {
    const j = cellAt(r + f, c + dc);
    if (j >= 0 && !G.board[j] && !isBarrier(j)) out.push({ to: j, kind: "herald" });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   TURN CYCLE
   ══════════════════════════════════════════════════════════════════════════ */

/** End-of-turn housekeeping for the player who just finished. */
function tickDownFor(player) {
  const P = G.players[player];
  tickEffects(P, PLAYER_EFFECTS);

  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (!p) continue;
    if (p.owner === player) {
      const wasVeiled = p.noCapture > 0;
      tickEffects(p, PIECE_EFFECTS);
      // Static Veil's delayed friendly fire lands the moment the stun expires.
      if (wasVeiled && p.noCapture <= 0 && p.veilBy != null) {
        resolveVeilBacklash(i, p.veilBy);
        p.veilBy = null;
      }
    } else if (p.eyeMark > 0) {
      // Eye For An Eye counts the OPPONENT's turns, so it ticks on theirs.
      p.eyeMark--;
      if (p.eyeMark === 0) log(`The mark on ${sq(i)} fades.`, "rule");
    }
  }
}

/** Static Veil: the caster's nearest free pawn to the stunned piece falls sick. */
function resolveVeilBacklash(veiledIdx, caster) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < CELLS; i++) {
    const q = G.board[i];
    if (!isAlly(q, caster) || q.rank !== "pawn" || q.form || q.frozen > 0) continue;
    const d = Math.abs(rowOf(i) - rowOf(veiledIdx)) + Math.abs(colOf(i) - colOf(veiledIdx));
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) { log("Static Veil's friendly fire finds no healthy pawn — it fizzles.", "rule"); return; }
  effNow(G.board[best], "frozen", 1);
  log(`Static Veil friendly fire lands — ${PLAYERS[caster].name}'s pawn at ${sq(best)} falls sick and cannot move next turn.`, "big");
}

/** How many enemy pieces still carry a veil `player` cast? Each owes them friendly fire. */
function veilBacklashPending(player) {
  let n = 0;
  for (const p of G.board) if (p && p.veilBy === player && p.noCapture > 0) n++;
  return n;
}

/**
 * Is every piece `owner` has left one that can never move again?
 *
 * A Sentinel is terrain and an Alchemist has traded its mobility away for
 * income — neither can ever move or capture, and no spell or transformation
 * puts a mobile piece back on the board for a side that has no pawn to
 * sacrifice. A side reduced to nothing but these has not merely been
 * blockaded for a turn; it can never act again, so the game is decided.
 */
function immobileWipeout(owner) {
  let any = false;
  for (const p of G.board) {
    if (!p || p.owner !== owner) continue;
    any = true;
    if (!isImmobile(p)) return false;
  }
  return any;
}

function checkGameOver() {
  if (G.over) return true;
  for (const side of [0, 1]) {
    if (countPieces(side) === 0) {
      G.over = { winner: 1 - side, reason: `${PLAYERS[side].name} has no pieces left` };
      return true;
    }
  }
  for (const side of [0, 1]) {
    if (immobileWipeout(side)) {
      const sent = countForm("sentinel", side), alch = countForm("alchemist", side);
      const what = !alch ? "nothing left but Sentinels"
                 : !sent ? "nothing left but Alchemists"
                 : "nothing left but Sentinels and Alchemists";
      G.over = {
        winner: 1 - side,
        reason: `${PLAYERS[side].name} has ${what} — not one piece that can ever move again`,
      };
      return true;
    }
  }
  return false;
}

/** Begin `player`'s turn: tick income, snapshot for Chronos, test for blockade. */
function beginTurn(player) {
  G.turn = player;
  G.phase = "declare";
  G.hasActed = false;
  G.castThisTurn = 0;
  G.drewThisTurn = false;
  G.chain = null;
  G.heraldBonus = null;
  G.lastCapture = null;
  G.mindControl = null;
  G.mustCapture = null;      // Tactician's debt dies with the turn that took it
  // Wraparound is measured in rounds and ticked here, so it costs both players
  // the same number of turns however the turn order is bent.
  if (G.wrap > 0 && --G.wrap === 0)
    log("Wraparound fades — the board has edges again.", "big");
  // Backstop: the action layer will not let a turn end while either of these is
  // outstanding, but a rewind or a resigned game can leave one behind.
  G.owedDiscard = null;
  G.owedSacrifice = null;
  G.turnNo++;

  // The sandbox tops up before the blockade test below, which is the point:
  // with a full hand and full Focus there is always something you could do, so
  // a workbench game can never end by running out of options.
  if (G.dev) { devTopUp(); devStockHands(); }

  if (checkGameOver()) return;

  // The passive drip: 1 FP every SECOND turn you take, counted per player so
  // Temporal Cascade's extra turns cannot break the rhythm. Your first turn
  // pays, then every other one. Everything faster than this comes from
  // fighting — captures, armor stripped, pawns crowned.
  const P = G.players[player];
  P.turnsTaken++;
  if (P.turnsTaken % 2 === 1) awardFP(player, 1, "start of turn");
  const alch = countForm("alchemist", player);
  if (alch > 0) awardFP(player, alch, `${alch} Alchemist${alch > 1 ? "s" : ""} transmuting`);

  // Blockade: you lose only if you cannot move AND cannot act your way out.
  if (!hasAnyMove(player)) {
    if (!hasTurnOption(player)) {
      G.over = { winner: 1 - player, reason: `${PLAYERS[player].name} is blockaded and cannot act` };
      return;
    }
    log(`${PLAYERS[player].name} has no piece movement available.`, "big");
  }

  // Snapshot the decision point — this is what Chronos's Gaze returns to.
  G.history.push({ turn: player, turnNo: G.turnNo, snap: snapshot(G) });
  if (G.history.length > 40) G.history.shift();
}

/**
 * Is there anything at all `player` could still do this turn other than end it?
 *
 * Read at two moments, which is the point of having one function for it:
 *   · the start of a turn, where a "no" is the blockade loss, and
 *   · after every action, where a "no" auto-passes the turn (autoPassIfStuck).
 *
 * Each clause mirrors the gate the matching action in dispatchAction enforces,
 * so this can never claim an option the referee would then refuse. Callers must
 * settle chain-jumps, Herald steps, Mind Control and owed debts first — those
 * are obligations rather than options, and this does not look at them.
 */
function hasTurnOption(player) {
  const P = G.players[player];
  // Moving a piece. Only ever available in the Declare Action phase.
  if (G.phase === "declare" && hasAnyMove(player)) return true;
  // Drawing, which spends the whole turn and so must be its first action.
  if (G.phase === "declare" && !G.hasActed && G.castThisTurn === 0 && !G.drewThisTurn
      && P.noDraw <= 0 && eligibleSpellIds().length > 0) return true;
  // A spell whose every precondition, the current phase included, is already
  // met — transformations are spells too now, so this alone covers them.
  if (P.hand.some((id) => !spellBlocker(id, player))) return true;
  return false;
}

/**
 * Finish the active player's turn and hand play over (or take an extra turn).
 * Returns { sameSeat } — true when Temporal Cascade kept the turn with the same
 * player, which is what tells the interface not to raise a pass-the-device
 * curtain. Presentation is the caller's job; this function only moves state.
 */
function endTurn() {
  if (G.over) return { sameSeat: false };
  const who = G.turn;
  tickDownFor(who);
  if (checkGameOver()) return { sameSeat: false };

  const P = G.players[who];
  if (P.extraTurns > 0) {
    P.extraTurns--;
    log(`Temporal Cascade — ${PLAYERS[who].name} takes another turn (${P.extraTurns} remaining after this).`, "big");
    beginTurn(who);
    return { sameSeat: true };
  }
  beginTurn(1 - who);
  return { sameSeat: false };
}

/**
 * Hand play over when the active player has run out of things to do.
 *
 * Sitting on an End Phase you cannot use is not a decision, it is a click, and
 * online it is a click your opponent has to wait for. So once nothing remains
 * but "End Turn", the referee presses it. Obligations — a chain-jump, a Herald
 * step, a seized piece, an owed discard or forfeit — are not options and must
 * be settled by the player first, so they suppress this entirely.
 *
 * Judged on the ACTIVE player, not on whoever acted: an opponent's any-turn
 * card can be what empties the active player's options.
 *
 * Returns endTurn()'s result, or null if the turn stands.
 */
/**
 * Does `seat` still owe Tactician a capture?
 *
 * The debt only binds while a capture is actually there to take. Clearing it
 * the moment the board runs out of them is what stops the card from wedging a
 * turn shut — the opponent can remove the last target between the payment and
 * the taking, and being paid for a capture that no longer exists is not a
 * reason to lose the game.
 */
function tacticianDebt(seat) {
  if (!G.mustCapture || G.mustCapture.player !== seat) return false;
  if (!capturersFor(seat).length) { G.mustCapture = null; return false; }
  return true;
}

function autoPassIfStuck() {
  if (G.over) return null;
  if (G.chain != null || G.heraldBonus != null || G.mindControl) return null;
  if (G.owedDiscard || G.owedSacrifice) return null;
  if (tacticianDebt(G.turn)) return null;
  const who = G.turn;
  if (hasTurnOption(who)) return null;
  log(`${PLAYERS[who].name} has nothing left to do — the turn passes automatically.`, "rule");
  return endTurn();
}

/* ══════════════════════════════════════════════════════════════════════════
   TRANSFORMATIONS

   `choices` carries anything the interface had to ask the player for — which
   pawn to sacrifice, which queen to give up. Every path here assumes
   transformBlocker() already returned null.
   ══════════════════════════════════════════════════════════════════════════ */

function applyTransform(i, form, choices = {}) {
  const p = G.board[i];
  const F = FORMS[form];
  const owner = p.owner;
  const P = G.players[owner];

  // The FP cost is paid once, generically, by castSpell — every form is now
  // reached only through its spell, and F.cost mirrors that spell's cost.
  p.form = form;
  fx("transform", { at: i, form, owner, rank: p.rank });
  log(`${PLAYERS[owner].name} transforms the ${p.rank} at ${sq(i)} into a ${F.name}.`, "p" + owner);

  switch (form) {
    case "juggernaut": {
      const victim = choices.sacrifice;
      removePiece(victim, "is sacrificed as Juggernaut armor", "sacrifice");
      p.armor = true;
      effNext(p, "frozen", 1);
      log("The Juggernaut is armored, cannot move next turn, and this consumes your turn.", "rule");
      break;
    }
    case "phaser":
      effNext(p, "frozen", 1);
      log("The Phaser is disoriented — it cannot move next turn.", "rule");
      break;
    case "sentinel": {
      // Everything of yours in the same column, behind the new Sentinel, freezes.
      const back = -fwd(owner);
      const col = colOf(i);
      let n = 0;
      for (let r = rowOf(i) + back; r >= 0 && r < N; r += back) {
        const q = G.board[rc(r, col)];
        if (isAlly(q, owner)) { effNext(q, "frozen", 1); n++; }
      }
      if (n) log(`${n} friendly piece(s) behind the Sentinel are frozen next turn.`, "rule");
      log("The Sentinel is now terrain — it can never move, capture, or be jumped.", "rule");
      break;
    }
    case "herald":
      effNext(p, "frozen", 1);
      log("The Herald is frozen next turn.", "rule");
      break;
    case "enchanter": {
      for (const idx of choices.sacrifices || []) removePiece(idx, "is sacrificed to the Enchanter", "sacrifice");
      effNext(p, "frozen", 2);
      log("The Enchanter is frozen for its next 2 turns.", "rule");
      break;
    }
    case "alchemist": {
      removePiece(choices.sacrifice, "is sacrificed to the Alchemist", "sacrifice");
      effNext(P, "noDraw", 1);
      effNext(P, "costCap", 2);
      P.costCapMax = 1;
      log("Resource Contamination — no draw next turn, and nothing above 1 FP for 2 turns.", "rule");
      break;
    }
  }

  if (F.consumesTurn) { G.hasActed = true; G.phase = "end"; }
  checkGameOver();
}

/* ══════════════════════════════════════════════════════════════════════════
   SPELLS

   castSpell() handles the shared bookkeeping — cost, card lifecycle, deck
   reshuffle — then dispatches to the individual effect. `payload` carries the
   targets the interface collected.
   ══════════════════════════════════════════════════════════════════════════ */

function consumeCard(id, caster) {
  const P = G.players[caster];
  const k = P.hand.indexOf(id);
  if (k >= 0) P.hand.splice(k, 1);

  // Sandbox: the hand is restocked from the full spell list after every
  // action, so once-per-game cards stay castable too — the sandbox is not
  // keeping score.
  if (G.dev) return;

  if (SPELLS[id].oncePerGame) {
    G.removed.push(id);
    log(`${SPELLS[id].name} is removed from the game.`, "sys");
  } else if (id === "phaserSpell") {
    // Parked out of the pool for as long as the Phaser it created survives.
    G.setAside.push(id);
  }
  // Everything else simply returns to being drawable — there is no physical
  // deck to return a copy to.
}

function discardCards(caster, ids, why) {
  const P = G.players[caster];
  for (const id of ids) {
    const k = P.hand.indexOf(id);
    if (k >= 0) P.hand.splice(k, 1);
  }
  if (ids.length) log(`${PLAYERS[caster].name} discards ${ids.length} card(s) — ${why}.`, "rule");
}

function castSpell(id, caster, payload = {}) {
  const S = SPELLS[id];
  const P = G.players[caster];
  P.fp -= S.cost;
  consumeCard(id, caster);
  if (caster === G.turn) G.castThisTurn++;
  fx("spell", { id, caster });
  log(`${PLAYERS[caster].name} casts ${S.name}. (−${S.cost} FP)`, "p" + caster);

  switch (id) {

    /* ── Movement ─────────────────────────────────────────────────────── */
    case "hopscotch": {
      const lc = G.lastCapture;
      const p = G.board[lc.to];
      if (p) {
        fx("hopscotch", { from: lc.to, to: lc.from, piece: fxPiece(p) });
        G.board[lc.to] = null;
        G.board[lc.from] = p;
      }
      log(`Hopscotch — the piece rebounds ${sq(lc.to)} → ${sq(lc.from)}.`, "rule");
      if (lc.survived) {
        // The victim only lived because of armor. Hopscotch strikes through it.
        const v = G.board[lc.victim];
        if (v) {
          removePiece(lc.victim, "is destroyed through its armor by Hopscotch");
          awardFP(caster, v.form ? 2 : 1, "Hopscotch finishes an armored target");
        }
      }
      G.lastCapture = null;
      G.lastMove = null;
      effNext(P, "noSpells", 1);
      log("No spells for you next turn.", "rule");
      break;
    }

    case "evasive": {
      const { from, to } = payload;
      const p = G.board[from];
      fx("evasive", { from, to, piece: fxPiece(p) });
      G.board[from] = null;
      G.board[to] = p;
      log(`Evasive Maneuver — pawn retreats ${sq(from)} → ${sq(to)}.`, "rule");
      // The retreat IS that pawn's movement, so it is spent for the rest of
      // this turn as well as barred from moving on the next one.
      effNow(p, "frozen", 1);
      effNext(p, "frozen", 1);
      log("That pawn has spent its movement — frozen for the rest of this turn and all of your next.", "rule");
      break;
    }

    case "mirror": {
      const from = payload.from, to = mirrorOf(from);
      const p = G.board[from];
      if (G.board[to]) { log("Mirror Step fizzles — the mirrored square is occupied.", "rule"); break; }
      G.board[from] = null;
      G.board[to] = p;
      log(`Mirror Step — the queen crosses the centerline ${sq(from)} → ${sq(to)}.`, "rule");
      const near = adjacentTo(to, (q) => isAlly(q, caster) && q.rank === "pawn");
      // `ripples` are the pawns the Distortion Field will freeze — shown on the
      // pieces that pay for the jump, in the same beat as the jump itself.
      fx("mirror", { from, to, piece: fxPiece(p), ripples: near });
      for (const j of near) effNext(G.board[j], "frozen", 1);
      if (near.length) log(`Distortion Field — ${near.length} adjacent friendly pawn(s) skip their next move.`, "rule");
      break;
    }

    /* ── Combat ───────────────────────────────────────────────────────── */
    case "veil": {
      const t = G.board[payload.target];
      fx("veil", { at: payload.target });
      effNow(t, "noCapture", 2);
      t.veilBy = caster;
      log(`Static Veil — ${PLAYERS[t.owner].name}'s ${pieceLabel(t)} at ${sq(payload.target)} cannot capture for 2 turns.`, "rule");
      // The friendly-fire penalty is deliberately delayed by the rules: it only
      // lands once the stun expires. Announce it now so it is not a surprise.
      log(`Friendly fire is queued — when that stun expires, ${PLAYERS[caster].name}'s nearest free pawn falls sick for a turn.`, "rule");
      break;
    }

    case "mindcontrol": {
      G.mindControl = { piece: payload.target };
      fx("mind", { at: payload.target, caster });
      log(`Mind Control — ${PLAYERS[caster].name} seizes the enemy ${pieceLabel(G.board[payload.target])} at ${sq(payload.target)} for one movement.`, "rule");
      effNow(P, "noSpells", 1);      // "this turn"
      effNext(P, "noSpells", 1);     // "...and the next"
      if (P.hand.length) G.owedDiscard = { player: caster, n: 1, why: "Mind Control exhaustion" };
      break;
    }

    case "eye": {
      const t = G.board[payload.target];
      t.eyeMark = 3;
      fx("eye", { at: payload.target });
      log(`Eye For An Eye — the pawn at ${sq(payload.target)} is marked for 3 of the opponent's turns.`, "rule");
      effNext(t, "frozen", 1);
      effNext(P, "noSpells", 1);
      log("That pawn is Static next turn, and you may cast nothing else next turn.", "rule");
      break;
    }

    /* ── Game altering ────────────────────────────────────────────────── */
    case "chronos": {
      // `payload.turnNo` names one of the caster's own last 2 turns (see
      // chronosTargets); default to the most recent if the caller left it out.
      const opts = chronosTargets(caster);
      const wantTurnNo = payload.turnNo != null ? payload.turnNo : opts[0];
      const stepsBack = opts.indexOf(wantTurnNo) + 1;      // 1 or 2, for the log
      let target = null;
      for (let k = G.history.length - 1; k >= 0; k--) {
        const h = G.history[k];
        if (h.turn === caster && h.turnNo === wantTurnNo) { target = h; G.history.length = k; break; }
      }
      if (!target) { log("Chronos's Gaze finds no earlier turn — it fizzles.", "rule"); break; }
      const keptLog = G.log.slice();
      // Which squares the rewind actually changes, by piece identity. A rewind
      // you cannot read is a rewind you cannot trust, so the interface gets to
      // point at what moved. Taken here because this is the only moment both
      // boards exist.
      const wasIds = G.board.map((q) => (q ? q.id : 0));
      restore(target.snap);
      G.log = keptLog;
      // restore() emptied the transcript along with everything else it rewound,
      // and rightly so — but this cast is happening NOW, not in the restored
      // past. Both events have to be written on the far side of it.
      fx("spell", { id, caster });
      const changed = [];
      for (let k = 0; k < CELLS; k++)
        if ((G.board[k] ? G.board[k].id : 0) !== wasIds[k]) changed.push(k);
      fx("chronos", { caster, changed });
      log(`Chronos's Gaze — the board, both Focus pools, and both hands return to the start of ${PLAYERS[caster].name}'s turn ${stepsBack > 1 ? "2 turns ago" : "1 turn ago"}.`, "big");
      // The card itself stays spent, and the backlash applies on top of the
      // restored hand — otherwise the rewind would hand it straight back.
      const hand = G.players[caster].hand;
      const ci = hand.indexOf("chronos");
      if (ci >= 0) hand.splice(ci, 1);
      if (hand.length > 1) {
        const drop = hand.splice(1);
        log(`Chronal Backlash — ${drop.length} card(s) discarded, one kept.`, "rule");
      }
      G.turn = caster;
      G.phase = "declare";
      G.hasActed = false;
      G.castThisTurn = 1;
      G.drewThisTurn = false;
      break;
    }

    case "cascade": {
      P.extraTurns = 2;
      fx("cascade", { caster });
      removePiece(payload.sacrifice, "is sacrificed to Temporal Cascade", "sacrifice");
      const rest = P.hand.slice();
      discardCards(caster, rest, "Temporal Cascade empties your hand");
      effNow(P, "noDraw", 4);
      effNow(P, "noTransform", 4);
      log("Temporal Cascade — 2 extra turns. No drawing and no transforming for 4 turns.", "big");
      break;
    }

    case "martyr": {
      // The rearmost friendly pawn is sacrificed and the queen takes its square.
      const spot = payload.sacrifice;
      removePiece(spot, "is sacrificed to The Martyr's Pledge", "sacrifice");
      P.lostQueens.pop();
      const q = mkPiece(caster, "queen");
      G.board[spot] = q;
      fx("martyr", { at: spot, owner: caster });
      P.martyrWatch = q.id;
      log(`The Martyr's Pledge — a queen rises at ${sq(spot)}. She is on probation until a new queen is crowned.`, "big");
      if (caster === G.turn) { G.hasActed = true; G.phase = "end"; }
      break;
    }

    case "phaserSpell": {
      applyTransform(payload.target, "phaser", {});
      break;
    }

    /* ── Transformation ───────────────────────────────────────────────── */
    case "juggernautSpell":
      applyTransform(payload.target, "juggernaut", { sacrifice: payload.sacrifice });
      break;
    case "sentinelSpell":
      applyTransform(payload.target, "sentinel", {});
      break;
    case "heraldSpell":
      applyTransform(payload.target, "herald", {});
      break;
    case "enchanterSpell":
      applyTransform(payload.target, "enchanter", { sacrifices: payload.sacrifices });
      break;
    case "alchemistSpell":
      applyTransform(payload.target, "alchemist", { sacrifice: payload.sacrifice });
      break;

    /* ── The board itself ─────────────────────────────────────────────── */
    case "tactician": {
      const n = availableCaptures(caster);
      awardFP(caster, n, `Tactician — ${n} capture(s) counted`);
      // The mandatory-capture rule already forfeits a piece for walking past a
      // jump. Tactician removes that escape: you were paid for these, so the
      // turn will not close until one is taken.
      G.mustCapture = { player: caster };
      log("You have been paid for those captures — one of them must be taken this turn.", "rule");
      break;
    }

    case "rift": {
      G.rift = { a: payload.a, b: payload.b, madeOn: G.turnNo };
      fx("rift", { a: payload.a, b: payload.b, caster });
      log(`Rift — ${sq(payload.a)} and ${sq(payload.b)} are joined. Anything landing on one is carried to the other.`, "big");
      log("It stays inert for the rest of this turn.", "rule");
      break;
    }

    case "wraparound": {
      // Two ROUNDS, and a round is both players — so four turns, ticked down
      // in beginTurn. Set to 5 here because the caster's own beginTurn has
      // already run for this turn and will not tick it again.
      G.wrap = 5;
      fx("wraparound", { caster });
      log("Wraparound — the left and right edges are joined for 2 rounds. It cuts both ways.", "big");
      break;
    }

    case "anchor": {
      G.anchor = { turnNo: G.turnNo };
      fx("anchor", { caster });
      log(`Anchor In Time — the game is pinned at turn ${G.turnNo}. Neither player may rewind past it again.`, "big");
      break;
    }

    case "echo": {
      const from = payload.target, to = echoTarget(from, caster);
      if (to < 0) { log("Echo finds no square to return to — it fizzles.", "rule"); break; }
      const p = G.board[from];
      const past = echoPastPiece(from, caster);
      G.board[from] = null;
      G.board[to] = p;
      fx("echo", { from, to, piece: fxPiece(p) });
      log(`Echo — the ${pieceLabel(p)} returns to ${sq(to)}, where it stood 3 turns ago.`, "big");
      // It arrives wearing the freezes it wore then, cleared ones included.
      if (past) {
        p.frozen = Math.max(p.frozen, past.frozen || 0);
        p.noCapture = Math.max(p.noCapture, past.noCapture || 0);
        if (past.frozen > 0 || past.noCapture > 0)
          log("It brought its old wounds back with it.", "rule");
      }
      promoteIfDue(to);
      break;
    }

    case "chokepoint": {
      // Derived here, not read from the payload. The square is the ENGINE's
      // choice by definition, and this is the one path both the referee and
      // the machine's own casts go through — the machine calls castSpell
      // directly, so a target that only dispatchAction supplied would arrive
      // undefined and seal square `undefined`.
      const at = chokepointTarget(caster);
      if (at < 0) { log("Chokepoint finds nothing to seal — it fizzles.", "rule"); break; }
      G.barriers.push(at);
      fx("chokepoint", { at, caster });
      log(`Chokepoint — ${sq(at)} is sealed for good. Nothing may land on it or cross it again.`, "big");
      effNow(P, "noSpells", 2);
      effNext(P, "noSpells", 2);
      log("Sealing it costs you every spell for 2 turns.", "rule");
      break;
    }
  }

  checkGameOver();
}

/** The Echo snapshot's copy of the piece at `i` — what it was 3 turns ago. */
function echoPastPiece(i, caster) {
  const p = G.board[i];
  if (!p) return null;
  let seen = 0;
  for (let k = G.history.length - 1; k >= 0; k--) {
    const h = G.history[k];
    if (h.turn !== caster || h.turnNo >= G.turnNo) continue;
    if (++seen < 3) continue;
    return h.snap.board.find((q) => q && q.id === p.id) || null;
  }
  return null;
}

/**
 * Draw a card. This is a whole turn — the doc's Spell Decision step.
 *
 * It used to pay 1 FP on top of the card. That was backwards: cards are the
 * scarce resource that Focus is spent THROUGH, so paying Focus for one made the
 * cheapest turn in the game also the most profitable one, and fed the very
 * surplus the ceiling now caps. The card is the reward.
 */
function drawSpell(player) {
  const P = G.players[player];
  const pool = eligibleSpellIds();
  if (!pool.length) return false;        // the caller decides how to say so
  // Seeded per draw off the game seed and a monotonic counter, so hot-seat,
  // online and replay all land on the same card from the same state.
  const rng = mulberry32((G.seed + G.turnNo * 7919 + G.drawSeq++) | 0);
  const totalWeight = pool.reduce((sum, id) => sum + SPELLS[id].weight, 0);
  let roll = rng() * totalWeight;
  let id = pool[pool.length - 1];
  for (const candidate of pool) {
    roll -= SPELLS[candidate].weight;
    if (roll <= 0) { id = candidate; break; }
  }
  G.drawCounts[id] = (G.drawCounts[id] || 0) + 1;
  P.hand.push(id);
  G.drewThisTurn = true;
  log(`${PLAYERS[player].name} draws a spell — this ends the turn.`, "p" + player);
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
   ACTION LAYER

   The single doorway through which player input mutates G. Everything above
   this line trusts its arguments — `performMove` assumes the move is legal,
   `castSpell` assumes the targets are valid — because until now those
   arguments came from modals the player could not lie to.

   Over a socket they can lie about everything. So this layer re-derives every
   decision from G using the same query functions that drew the move dots:
   legalMovesFor, spellBlocker, transformBlocker, and the target finders. A
   client that edits its own copy of G changes nothing the server believes.

   Two properties worth relying on:

     Transactional. A snapshot is taken before dispatch and restored if the
     action fails, so a rejected action can never leave G half-mutated. Handlers
     are free to mutate first and validate after, which is what the
     declined-mandatory-capture path needs.

     Same code both sides. The browser calls applyAction() directly for hot-seat
     and vs-machine games; the server calls it for online ones. A validation bug
     shows up offline, where it is easy to see.
   ══════════════════════════════════════════════════════════════════════════ */

const OK = { ok: true };
const fail = (err) => ({ ok: false, err });

/* ── sacrifice pools ─────────────────────────────────────────────────────
   Lifted out of the old modal code so the validator and the interface agree
   on what counts as an eligible victim by construction.
   ─────────────────────────────────────────────────────────────────────── */

/** Every friendly pawn — what Temporal Cascade and the Alchemist may eat. */
function friendlyPawns(owner) {
  const out = [];
  for (let j = 0; j < CELLS; j++) if (isAlly(G.board[j], owner) && G.board[j].rank === "pawn") out.push(j);
  return out;
}

/** Adjacent untransformed friendly pawns — the Juggernaut's armor. */
function juggernautArmorPool(i) {
  const p = at(i);
  if (!p) return [];
  // Sandbox: adjacency is a condition, and conditions are what the sandbox
  // drops. Any untransformed pawn of yours will do.
  if (G.dev)
    return friendlyPawns(p.owner).filter((j) => j !== i && !G.board[j].form);
  return adjacentTo(i, (q) => isAlly(q, p.owner) && q.rank === "pawn" && !q.form);
}

/**
 * The Enchanter's price: one adjacent friendly queen, or any three adjacent
 * friendly pawns. Returned as a list of index-sets, one per legal payment.
 */
function enchanterSacrificeOptions(i) {
  const p = at(i);
  if (!p) return [];
  const owner = p.owner;
  if (G.dev) {
    // Sandbox: the whole board, not just the neighbours. Every triple of
    // twenty-four pawns is two thousand menu entries, so the triples are taken
    // in sliding order from the pawns furthest from promotion — the ones you
    // would pick anyway — and capped at something a person can read.
    const out = [];
    for (let j = 0; j < CELLS; j++) {
      const q = G.board[j];
      if (isAlly(q, owner) && q.rank === "queen" && q.id !== p.id) out.push([j]);
    }
    const pawns = friendlyPawns(owner)
      .filter((j) => j !== i)
      .sort((a, b) => Math.abs(rowOf(b) - promoRow(owner)) - Math.abs(rowOf(a) - promoRow(owner)));
    for (let a = 0; a + 2 < pawns.length && out.length < 12; a++)
      out.push([pawns[a], pawns[a + 1], pawns[a + 2]]);
    return out;
  }
  const queens = adjacentTo(i, (q) => isAlly(q, owner) && q.rank === "queen" && q.id !== p.id);
  const pawns = adjacentTo(i, (q) => isAlly(q, owner) && q.rank === "pawn");
  const out = queens.map((q) => [q]);
  for (let a = 0; a < pawns.length; a++)
    for (let b = a + 1; b < pawns.length; b++)
      for (let c = b + 1; c < pawns.length; c++) out.push([pawns[a], pawns[b], pawns[c]]);
  return out;
}

/** The Martyr's Pledge takes your rearmost pawn; ties are the player's choice. */
function martyrSacrificePool(caster) {
  let best = Infinity, pool = [];
  for (let j = 0; j < CELLS; j++) {
    const q = G.board[j];
    if (!isAlly(q, caster) || q.rank !== "pawn") continue;
    const d = Math.abs(rowOf(j) - homeRow(caster));
    if (d < best) { best = d; pool = [j]; }
    else if (d === best) pool.push(j);
  }
  return pool;
}

/** Empty squares an Evasive Maneuver could retreat the pawn at `from` into. */
const evasiveDests = (from, owner) => backStepsFrom(from, owner);

/* ── mind control ───────────────────────────────────────────────────────── */

/**
 * Walk the seized enemy piece. Deliberately not a `performMove` call: a borrowed
 * step is the spell resolving, not the caster's movement, so it sets neither
 * `hasActed` nor the End Phase and the caster may still move afterwards.
 */
function performMindControlMove(from, mv) {
  const p = G.board[from];
  fx("move", { from, to: mv.to, kind: "mind", piece: fxPiece(p), chained: false });
  G.board[from] = null;
  G.board[mv.to] = p;
  log(`Mind Control — ${PLAYERS[p.owner].name}'s ${pieceLabel(p)} is walked ${sq(from)} → ${sq(mv.to)}.`, "rule");
  promoteIfDue(mv.to);
  G.mindControl = null;
  G.lastMove = { from, to: mv.to };
}

/* ── undo ───────────────────────────────────────────────────────────────── */

/** The snapshot an undo from `seat` would rewind to, or null if there is none. */
function undoTarget() {
  const acted = G.hasActed || G.castThisTurn > 0 || G.drewThisTurn;
  const t = acted ? G.history[G.history.length - 1] : G.history[G.history.length - 2];
  return t || null;
}

/** Rewind to `target`, keeping the referee log so the rewind itself is on record. */
function applyUndoTo(target) {
  const keptLog = G.log.slice();
  const idx = G.history.indexOf(target);
  restore(target.snap);
  G.log = keptLog;
  G.history.length = Math.max(0, idx);
  G.history.push({ turn: G.turn, turnNo: G.turnNo, snap: snapshot(G) });
  log(`Undo — rewound to the start of ${PLAYERS[G.turn].name}'s turn ${G.turnNo}.`, "big");
  G.owedDiscard = null;
  G.owedSacrifice = null;
}

/* ── validation helpers ─────────────────────────────────────────────────── */

const isIdx = (v) => Number.isInteger(v) && v >= 0 && v < CELLS;

/**
 * The engine's own move object for `to`, or null. The client's `kind` is checked
 * when supplied but never trusted for detail — a capture's victim always comes
 * from captureMoves(), never from the wire.
 */
function findLegalMove(from, to, kind) {
  if (!isIdx(from) || !isIdx(to)) return null;
  const moves = legalMovesFor(from);
  return moves.find((m) => m.to === to && (kind == null || m.kind === kind)) || null;
}

/** Shared preconditions for anything taken on your own turn. */
function turnGate(seat) {
  if (G.over) return "The game is over.";
  if (seat !== G.turn) return "It is not your turn.";
  if (G.owedSacrifice) return "Choose the piece forfeited for the declined capture first.";
  if (G.owedDiscard) return "Resolve your discard first.";
  if (G.mindControl) return "Move the mind-controlled piece first.";
  return null;
}

/* ── the dispatcher ─────────────────────────────────────────────────────── */

/**
 * Validate and apply one action on behalf of `seat`. Returns {ok:true} — with
 * `sameSeat` set when the turn passed back to the same player via Temporal
 * Cascade — or {ok:false, err} with G untouched.
 */
function applyAction(seat, a) {
  if (seat !== 0 && seat !== 1) return fail("Not a seat.");
  if (!a || typeof a !== "object" || typeof a.t !== "string") return fail("Malformed action.");

  const before = snapshot(G);
  const histBefore = G.history.slice();
  // Effects the interface may not have played yet. The rollback below rewinds
  // the whole game, which would take them with it — and a refused action should
  // cost you an error message, not the animation of the move before it.
  const fxBefore = (G.fx || []).slice();
  let res;
  try {
    res = dispatchAction(seat, a);
  } catch (e) {
    res = fail("The referee choked on that action.");
    if (typeof console !== "undefined") console.error("applyAction threw:", a, e);
  }
  if (!res || !res.ok) {
    restore(before);
    G.history = histBefore;
    G.fx = fxBefore;
    return res || fail("No result.");
  }

  // The action stood. If it left the active player with nothing further to do,
  // pass the turn for them. Actions that already handed play over (draw,
  // endTurn) report `sameSeat` and are left alone — their turn is gone.
  if (!("sameSeat" in res)) {
    // One hook is the whole of "act as many times as you like": reopen the turn
    // here rather than unpicking the gate in every case below, so the sandbox
    // cannot drift out of step with a rule added later.
    if (G.dev) devUnlock();
    const auto = autoPassIfStuck();
    if (auto) return { ok: true, sameSeat: auto.sameSeat, autoPassed: true };
  }
  return res;
}

function dispatchAction(seat, a) {
  switch (a.t) {

    /* ── movement ───────────────────────────────────────────────────────── */
    case "move": {
      const g = turnGate(seat);
      if (g) return fail(g);
      if (G.phase !== "declare" && G.chain == null && G.heraldBonus == null)
        return fail("You have already acted this turn.");
      const p = at(a.from);
      if (!p) return fail("There is no piece on that square.");
      if (p.owner !== seat) return fail("That is not your piece.");

      const mv = findLegalMove(a.from, a.to, a.kind);
      if (!mv) return fail("That is not a legal move for that piece.");

      // Captures are mandatory. Moving elsewhere is allowed but forfeits one of
      // the pieces that could have jumped — recorded before the move, since the
      // move itself changes who can jump.
      // Sandbox: no forfeit. Losing a piece for walking past a jump is a price,
      // and on a workbench where you move as often as you like it would just
      // quietly eat the position you were building.
      const capturers = pendingSacrifice(seat);
      const skipping = !G.dev && capturers.length > 0 && mv.kind !== "capture"
        && G.chain == null && G.heraldBonus == null;

      performMove(a.from, mv);

      if (skipping) {
        // A capturer that was the moving piece now stands at the destination;
        // one that died in the process is no longer a candidate.
        const pool = capturers.map((c) => (c === a.from ? mv.to : c)).filter((c) => G.board[c]);
        if (pool.length === 1) {
          removePiece(pool[0], "is sacrificed for the skipped capture", "sacrifice");
          log("A mandatory capture was declined — that piece is forfeit.", "big");
        } else if (pool.length > 1) {
          G.owedSacrifice = { player: seat, candidates: pool };
          log("A mandatory capture was declined — one of the pieces that could have jumped is forfeit.", "rule");
        }
      }
      checkGameOver();
      return OK;
    }

    case "sacrifice": {
      const os = G.owedSacrifice;
      if (!os) return fail("No sacrifice is owed.");
      if (os.player !== seat) return fail("That choice is not yours to make.");
      if (!os.candidates.includes(a.i)) return fail("That piece could not have jumped.");
      removePiece(a.i, "is sacrificed for the skipped capture", "sacrifice");
      log("A mandatory capture was declined — that piece is forfeit.", "big");
      G.owedSacrifice = null;
      checkGameOver();
      return OK;
    }

    case "heraldSkip": {
      if (G.over) return fail("The game is over.");
      if (seat !== G.turn) return fail("It is not your turn.");
      if (G.heraldBonus == null) return fail("No Herald bonus step is owed.");
      G.heraldBonus = null;
      G.phase = "end";
      log("The Herald's bonus step is declined.", "rule");
      return OK;
    }

    case "mindMove": {
      if (G.over) return fail("The game is over.");
      if (seat !== G.turn) return fail("It is not your turn.");
      if (!G.mindControl) return fail("No piece is under your control.");
      if (a.from !== G.mindControl.piece) return fail("Move the piece you seized.");
      const mv = simpleMoves(a.from).filter((m) => m.kind === "step").find((m) => m.to === a.to);
      if (!mv) return fail("That is not a legal step for the seized piece.");
      performMindControlMove(a.from, mv);
      checkGameOver();
      return OK;
    }

    /* ── spells ─────────────────────────────────────────────────────────── */
    case "cast": {
      if (G.over) return fail("The game is over.");
      if (G.owedSacrifice) return fail("Choose the piece forfeited for the declined capture first.");
      if (G.owedDiscard) return fail("Resolve your discard first.");
      if (G.mindControl) return fail("Move the mind-controlled piece first.");
      if (!SPELLS[a.id]) return fail("No such spell.");

      // Covers hand contents, FP, cost caps, phase, chain lock, whose turn it is
      // (including the anyTurn exception), and every per-spell precondition.
      const blocker = spellBlocker(a.id, seat);
      if (blocker) return fail(blocker);

      const want = a.payload || {};
      const payload = {};
      switch (a.id) {
        case "evasive": {
          if (!evasiveTargets(seat).includes(want.from)) return fail("That pawn cannot step backward.");
          if (!evasiveDests(want.from, seat).includes(want.to)) return fail("That is not a backward retreat.");
          payload.from = want.from; payload.to = want.to;
          break;
        }
        case "mirror":
          if (!mirrorTargets(seat).includes(want.from)) return fail("That queen has no clear mirrored square.");
          payload.from = want.from;
          break;
        case "veil":
          if (!veilTargets(seat).includes(want.target)) return fail("That is not a legal target to stun.");
          payload.target = want.target;
          break;
        case "mindcontrol":
          if (!mindControlTargets(seat).includes(want.target)) return fail("That enemy piece has no legal move to seize.");
          payload.target = want.target;
          break;
        case "eye":
          if (!eyeTargets(seat).includes(want.target)) return fail("That is not an untransformed pawn of yours.");
          payload.target = want.target;
          break;
        case "cascade":
          if (!friendlyPawns(seat).includes(want.sacrifice)) return fail("Temporal Cascade must be paid with one of your pawns.");
          payload.sacrifice = want.sacrifice;
          break;
        case "martyr":
          if (!martyrSacrificePool(seat).includes(want.sacrifice)) return fail("The Martyr's Pledge takes your rearmost pawn.");
          payload.sacrifice = want.sacrifice;
          break;
        case "phaserSpell":
          if (!phaserTargets(seat).includes(want.target)) return fail("That pawn has never captured.");
          payload.target = want.target;
          break;
        case "chronos": {
          const opts = chronosTargets(seat);
          if (!opts.includes(want.turnNo)) return fail("That is not one of your last 2 turns.");
          payload.turnNo = want.turnNo;
          break;
        }
        // hopscotch takes no target; spellBlocker already proved there is a
        // capture to reverse.

        case "juggernautSpell": {
          if (!juggernautTargets(seat).includes(want.target)) return fail("That piece cannot become a Juggernaut.");
          if (!juggernautArmorPool(want.target).includes(want.sacrifice))
            return fail(G.dev
              ? "The armor must be an untransformed friendly pawn."
              : "The armor must be an adjacent untransformed friendly pawn.");
          payload.target = want.target; payload.sacrifice = want.sacrifice;
          break;
        }
        case "sentinelSpell":
          if (!sentinelTargets(seat).includes(want.target)) return fail("That pawn cannot become a Sentinel.");
          payload.target = want.target;
          break;
        case "heraldSpell":
          if (!heraldTargets(seat).includes(want.target)) return fail("That pawn cannot become a Herald.");
          payload.target = want.target;
          break;
        case "enchanterSpell": {
          if (!enchanterTargets(seat).includes(want.target)) return fail("That queen cannot become an Enchanter.");
          const given = Array.isArray(want.sacrifices) ? want.sacrifices.slice().sort((x, y) => x - y) : null;
          if (!given) return fail("The Enchanter demands a sacrifice.");
          const match = enchanterSacrificeOptions(want.target)
            .some((opt) => opt.length === given.length
              && opt.slice().sort((x, y) => x - y).every((v, k) => v === given[k]));
          if (!match) return fail("That is not a legal Enchanter sacrifice.");
          payload.target = want.target; payload.sacrifices = given;
          break;
        }
        case "alchemistSpell":
          if (!alchemistTargets(seat).includes(want.target)) return fail("That queen cannot become an Alchemist.");
          if (!friendlyPawns(seat).includes(want.sacrifice))
            return fail("The Alchemist must be paid with one of your pawns.");
          payload.target = want.target; payload.sacrifice = want.sacrifice;
          break;

        case "rift": {
          const open = openSquares();
          if (!open.includes(want.a) || !open.includes(want.b))
            return fail("A rift joins two empty dark squares.");
          if (want.a === want.b) return fail("A rift needs two different squares.");
          payload.a = want.a; payload.b = want.b;
          break;
        }
        case "echo":
          if (!echoTargets(seat).includes(want.target))
            return fail("That piece cannot return to where it stood.");
          payload.target = want.target;
          break;
        // chokepoint takes no payload either — castSpell derives the square, so
        // there is nothing here for an edited client to choose.
        // tactician, wraparound and anchor take no target: spellBlocker has
        // already proved there is something to count, join or pin.
      }

      castSpell(a.id, seat, payload);
      return OK;
    }

    case "discard": {
      const od = G.owedDiscard;
      if (!od) return fail("No discard is owed.");
      if (od.player !== seat) return fail("That discard is not yours.");
      if (!G.players[seat].hand.includes(a.id)) return fail("That card is not in your hand.");
      discardCards(seat, [a.id], od.why);
      od.n--;
      G.owedDiscard = od.n > 0 && G.players[seat].hand.length ? od : null;
      return OK;
    }

    /* ── turn flow ──────────────────────────────────────────────────────── */
    case "draw": {
      const g = turnGate(seat);
      if (g) return fail(g);
      if (G.phase !== "declare") return fail("You may only draw in the Declare Action phase.");
      if (G.hasActed) return fail("You have already acted this turn.");
      if (G.castThisTurn > 0) return fail("You have already cast this turn.");
      if (G.drewThisTurn) return fail("You have already drawn this turn.");
      if (G.chain != null || G.heraldBonus != null) return fail("Finish your movement first.");
      const P = G.players[seat];
      if (P.noDraw > 0) return fail(`Drawing is barred for ${P.noDraw} more turn(s).`);
      if (!eligibleSpellIds().length) return fail("No spell can be drawn right now.");
      drawSpell(seat);
      // Sandbox: the card was the cost of the turn, and the sandbox does not
      // charge. Returning plain OK leaves the turn open — and leaves the result
      // without `sameSeat`, which is what routes it through devUnlock above.
      if (G.dev) return OK;
      return { ok: true, sameSeat: endTurn().sameSeat };   // drawing spends the whole turn
    }

    case "endTurn": {
      const g = turnGate(seat);
      if (g) return fail(g);
      if (G.chain != null) return fail("You must continue the chain-jump.");
      if (G.heraldBonus != null) return fail("Resolve the Herald's bonus step first.");
      if (tacticianDebt(seat))
        return fail("Tactician paid you for those captures — take one before you end the turn.");
      if (G.phase === "declare" && !G.hasActed && pendingSacrifice(seat).length)
        log("Turn ended without moving — no sacrifice is owed.", "rule");
      return { ok: true, sameSeat: endTurn().sameSeat };
    }

    case "resign": {
      if (G.over) return fail("The game is already over.");
      G.over = { winner: 1 - seat, reason: `${PLAYERS[seat].name} resigned` };
      log(`${PLAYERS[seat].name} resigns.`, "big");
      return OK;
    }

    default:
      return fail(`Unknown action "${a.t}".`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   VIEWS — what a seat is allowed to know

   G holds both hands, the deck in order, and forty full snapshots. None of that
   may cross the wire. viewFor() is the only thing the server ever serialises.
   ══════════════════════════════════════════════════════════════════════════ */

const HIDDEN_CARD = "?";
const VIEW_LOG_TAIL = 80;

function viewFor(g, seat, extra = {}) {
  const v = snapshot(g);                   // deep clone, already strips `history`
  const foe = 1 - seat;
  // Hand SIZE is public — the machine has always been allowed to read it.
  // Hand CONTENTS are not. There is no physical deck order left to hide —
  // the draw pool's weights and each scarce card's remaining count are
  // public, the same way a consumed once-per-game card's status already was.
  v.players[foe].hand = v.players[foe].hand.map(() => HIDDEN_CARD);

  // The snapshots are the secret; the shape of the past is not. Keeping the
  // stubs means spellBlocker's "is there an earlier turn?" test for Chronos's
  // Gaze still answers correctly on the client.
  v.history = g.history.map((h) => ({ turn: h.turn, turnNo: h.turnNo }));

  if (v.log.length > VIEW_LOG_TAIL) v.log = v.log.slice(-VIEW_LOG_TAIL);

  // snapshot() drops the effect transcript; the wire is the one place it is the
  // whole point. This is how a player who did not act still sees the capture.
  // It says nothing the referee log has not already announced to both seats.
  v.fx = structuredClone(g.fx || []);

  v.youAre = seat;
  return Object.assign(v, extra);
}

/* ══════════════════════════════════════════════════════════════════════════
   NODE EXPORT

   The browser needs none of this — it loads the file as a classic script and
   picks everything up from the global lexical scope.

   `G` is module-private under Node. The server owns one game per room and calls
   setG(room.G) immediately before each applyAction(). That is safe only because
   Node is single-threaded and applyAction never awaits, so no second room can
   interleave. Do not make anything on this path async.
   ══════════════════════════════════════════════════════════════════════════ */

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    // constants
    N, CELLS, PLAYERS, FORMS, SPELLS, SPELL_IDS, FP_CAP, RARITY,
    // geometry
    rc, rowOf, colOf, isDark, sq, mirrorOf,
    // lifecycle
    newGame, beginTurn, endTurn, snapshot, restore, checkGameOver, log,
    setG: (g) => { G = g; },
    getG: () => G,
    // the doorway
    applyAction, viewFor, undoTarget, applyUndoTo,
    // queries, for the test suite
    legalMovesFor, simpleMoves, captureMoves, capturersFor, pendingSacrifice,
    hasAnyMove, hasTurnOption, immobileWipeout, heraldAdjacent, heraldShielded, legalHeraldSteps,
    countPieces, countForm, spellBlocker, transformBlocker, eligibleSpellIds,
    evasiveTargets, evasiveDests, mirrorTargets, veilTargets, mindControlTargets,
    eyeTargets, phaserTargets, chronosTargets, friendlyPawns, martyrSacrificePool,
    juggernautArmorPool, enchanterSacrificeOptions,
    juggernautTargets, sentinelTargets, heraldTargets, enchanterTargets, alchemistTargets,
    cellAt, isBarrier, backStepsFrom, openSquares, availableCaptures,
    echoTarget, echoTargets, chokepointTarget, tacticianDebt, anchoredAgainst,
  };
}
