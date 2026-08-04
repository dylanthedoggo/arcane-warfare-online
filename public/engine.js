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
const onBoard = (r, c) => r >= 0 && r < N && c >= 0 && c < N;
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
  },
  herald: {
    name: "Herald", glyph: "⚑", on: "pawn", cost: 3, cap: 1, capScope: "player",
    ability: "A friendly pawn landing adjacent to the Herald may advance one extra square. The bonus step cannot capture.",
    penalty: "The Herald is frozen next turn.",
    need: "Must be on the opponent's half of the board.",
  },
  enchanter: {
    name: "Enchanter", glyph: "⚛", on: "queen", cost: 3, cap: 1, capScope: "player",
    ability: "May swap places with any piece on the board, friendly or enemy.",
    penalty: "Frozen 2 turns on transform · frozen 1 turn after a friendly swap · discard a card after an enemy swap.",
    need: "Queen with at least one lifetime capture. Sacrifices an adjacent friendly queen, or 3 adjacent friendly pawns.",
  },
  alchemist: {
    name: "Alchemist", glyph: "⚗", on: "queen", cost: 6, cap: null,
    ability: "Can never move or capture again. Generates 1 FP at the start of each of your turns.",
    penalty: "Resource Contamination — no draw next turn, and no spell above 1 FP for 2 turns.",
    need: "Queen must be standing on your own back row. Sacrifices a friendly pawn.",
  },
};

/* ─────────────────────────────────────────────────────────────────────────
   SPELLS — one shared 37-card deck
   `when`: "declare" | "end" | "any"  (which phase it may be cast in)
   `anyTurn`: castable on the opponent's turn as well
   ───────────────────────────────────────────────────────────────────────── */
const SPELLS = {
  hopscotch: {
    name: "Hopscotch", cost: 3, count: 4, when: "end", group: "Movement",
    text: "Return the piece that just captured to the square it jumped from. If the victim survived on armor, it is destroyed anyway.",
    penalty: "No spells next turn.",
    timing: "After a capture, before your opponent acts.",
  },
  evasive: {
    name: "Evasive Maneuver", cost: 3, count: 8, when: "declare", group: "Movement",
    text: "One of your pawns steps one square diagonally backward into an empty square. Cannot capture.",
    penalty: "That pawn cannot move next turn.",
    timing: "Declare Action phase only.",
  },
  mirror: {
    name: "Mirror Step", cost: 2, count: 4, when: "any", group: "Movement",
    text: "A queen teleports to the mirrored square across the centreline — row r column c becomes row 11−r column 11−c. Wasted if the destination is occupied.",
    penalty: "Distortion Field — every friendly pawn adjacent to the queen after the jump skips its next move.",
    timing: "Before or after moving.",
  },
  veil: {
    name: "Static Veil", cost: 2, count: 5, group: "Combat", when: "declare",
    text: "One enemy piece cannot capture for its next two turns. It may still move.",
    penalty: "Friendly fire — when the stun ends, your nearest free pawn to that piece falls sick and cannot move for a turn.",
    timing: "Declare Action phase only.",
  },
  mindcontrol: {
    name: "Mind Control", cost: 3, count: 4, group: "Combat", when: "declare",
    text: "Take one movement with an enemy piece that has a legal move.",
    penalty: "Exhaustion — no more spells this turn or next, and discard a card.",
    timing: "Your turn only.",
  },
  eye: {
    name: "Eye For An Eye", cost: 3, count: 3, group: "Combat", when: "declare",
    text: "Mark an untransformed friendly pawn. For your opponent's next 3 turns, anything that captures it dies with it.",
    penalty: "The marked pawn is Static next turn · no other spells next turn.",
    timing: "Declare Action phase only.",
  },
  chronos: {
    name: "Chronos's Gaze", cost: 4, count: 2, group: "Game Altering", when: "declare",
    flavor: "The past is flexible. Unmake your last mistake.",
    text: "Rewind the board, both Focus Point pools, and both hands to the start of your previous turn.",
    penalty: "Chronal Backlash — discard your hand down to a single card.",
    timing: "Start of your turn, right after your opponent finishes theirs.",
  },
  cascade: {
    name: "Temporal Cascade", cost: 5, count: 1, group: "Game Altering", when: "declare",
    flavor: "The world holds its breath. Only you may move.",
    text: "Take 2 additional consecutive turns — 3 in a row in total.",
    penalty: "Discard your entire hand, sacrifice a pawn, and neither draw nor transform for 4 turns.",
    timing: "Declare Action phase. Removed from the game after use.",
    oncePerGame: true,
  },
  martyr: {
    name: "The Martyr's Pledge", cost: 3, count: 2, group: "Game Altering", when: "any",
    flavor: "Long live the queen.",
    text: "Revive one of your captured queens. Playable at any time, even on your opponent's turn.",
    penalty: "Your rearmost pawn is sacrificed and the queen takes its square. Consumes your turn.",
    timing: "Any time — including your opponent's turn.",
    anyTurn: true,
  },
  phaserSpell: {
    name: "Phaser", cost: 3, count: 4, group: "Game Altering", when: "declare",
    text: "Transform one of your pawns that has captured at least once into a Phaser.",
    penalty: "The pawn is disoriented and skips its next movement.",
    timing: "Declare Action phase. Set aside while a Phaser lives; returns to the deck when one dies.",
  },
};
const SPELL_IDS = Object.keys(SPELLS);

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

function buildDeck() {
  const deck = [];
  for (const id of SPELL_IDS) for (let n = 0; n < SPELLS[id].count; n++) deck.push(id);
  return deck;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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

function newGame(firstPlayer = 0, seed = null) {
  const s = seed == null ? (Math.floor(Math.random() * 1e9)) : seed;
  const rng = mulberry32(s);

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
    deck: shuffle(buildDeck(), rng),
    setAside: [],           // Phaser cards parked while a Phaser lives
    removed: [],            // Temporal Cascade after use
    castsSinceShuffle: 0,
    log: [],
    over: null,             // { winner, reason }
    history: [],            // snapshots taken at the start of each turn
    mindControl: null,      // { piece } while a Mind Control move is pending
    owedDiscard: null,      // { player, n, why } — forced discard pending
    owedSacrifice: null,    // { player, candidates } — declined-capture forfeit pending
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
   nest exponentially. */
function snapshot(g) {
  const { history, ...rest } = g;
  return structuredClone(rest);
}
function restore(snap) {
  const history = G.history;
  G = structuredClone(snap);
  G.history = history;
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

/** Is index `i` diagonally adjacent to a piece matching `pred`? */
function adjacentTo(i, pred) {
  const r = rowOf(i), c = colOf(i);
  const out = [];
  for (const [dr, dc] of DIAG) {
    const nr = r + dr, nc = c + dc;
    if (!onBoard(nr, nc)) continue;
    const j = rc(nr, nc);
    if (pred(G.board[j], j)) out.push(j);
  }
  return out;
}

/* ── movement ───────────────────────────────────────────────────────────── */

/** Non-capturing destinations for the piece at `i`. */
function simpleMoves(i) {
  const p = at(i);
  if (!canAct(p)) return [];
  const r = rowOf(i), c = colOf(i);
  const out = [];

  for (const [dr, dc] of moveDirs(p)) {
    const nr = r + dr, nc = c + dc;
    if (onBoard(nr, nc) && !G.board[rc(nr, nc)]) out.push({ to: rc(nr, nc), kind: "step" });
  }

  // Phaser: 2 squares orthogonally, may pass through an occupied square but
  // never land on one. The 2-square distance keeps it on dark squares.
  if (p.form === "phaser") {
    for (const [dr, dc] of ORTHO) {
      const nr = r + dr, nc = c + dc;
      if (!onBoard(nr, nc)) continue;
      const j = rc(nr, nc);
      if (!G.board[j]) out.push({ to: j, kind: "phase" });
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
    const mr = r + dr, mc = c + dc;             // the victim's square
    const lr = r + dr * 2, lc = c + dc * 2;     // the landing square
    if (!onBoard(lr, lc)) continue;
    const mid = rc(mr, mc), land = rc(lr, lc);
    const victim = G.board[mid];
    if (!isEnemy(victim, p.owner)) continue;
    if (isSentinel(victim)) continue;           // Sentinels cannot be jumped
    if (G.board[land]) continue;                // landing square must be empty
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
  if (G.heraldBonus != null) {
    if (i !== G.heraldBonus) return [];
    const r = rowOf(i), c = colOf(i), f = fwd(p.owner);
    const out = [];
    for (const dc of [-1, 1]) {
      const nr = r + f, nc = c + dc;
      if (onBoard(nr, nc) && !G.board[rc(nr, nc)]) out.push({ to: rc(nr, nc), kind: "herald" });
    }
    return out;
  }
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

/** Forms the piece at `i` could take right now, each with its blocker (if any). */
function transformOptions(i) {
  const p = at(i);
  if (!p) return [];
  return Object.keys(FORMS)
    .filter((f) => !FORMS[f].viaSpell)     // Phaser is reached through its spell
    .map((f) => ({ form: f, blocker: transformBlocker(i, f) }));
}

/* ── spells ─────────────────────────────────────────────────────────────── */

/** Why can't the current player cast `id` right now? Returns null if legal. */
function spellBlocker(id, caster = G.turn) {
  const S = SPELLS[id];
  const P = G.players[caster];
  if (!P.hand.includes(id)) return "Not in your hand.";
  if (P.noSpells > 0) return `No spells for ${P.noSpells} more turn(s).`;
  if (P.fp < S.cost) return `Costs ${S.cost} FP — you have ${P.fp}.`;
  if (P.costCap > 0 && S.cost > P.costCapMax)
    return `Resource Contamination — nothing above ${P.costCapMax} FP for ${P.costCap} more turn(s).`;

  const myTurn = caster === G.turn;
  if (!myTurn && !S.anyTurn) return "Only on your own turn.";
  if (myTurn) {
    if (G.chain != null) return "Finish your chain-jump first.";
    if (S.when === "declare" && G.phase !== "declare") return "Declare Action phase only.";
    if (S.when === "end" && G.phase !== "end") return "End Phase only.";
  }

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
      if (!G.history.length) return "There is no earlier turn to return to.";
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
      if (countForm("phaser") >= 2) return "Two Phasers already exist on the board.";
      if (!phaserTargets(caster).length) return "No pawn of yours has ever captured.";
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
    const r = rowOf(i), c = colOf(i), b = -fwd(owner);
    for (const dc of [-1, 1])
      if (onBoard(r + b, c + dc) && !G.board[rc(r + b, c + dc)]) { out.push(i); break; }
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
  for (let i = 0; i < CELLS; i++) if (isEnemy(G.board[i], owner) && G.board[i].noCapture <= 0) out.push(i);
  return out;
}
/* Mind Control grants "one movement", not a capture — so the target needs a
   plain step available, per the card's own wording. */
function mindControlTargets(owner) {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (!isEnemy(p, owner)) continue;
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
    if (isAlly(p, owner) && p.rank === "pawn" && !p.form && p.captures >= 1) out.push(i);
  }
  return out;
}
function enchanterSwapTargets(i) {
  const out = [];
  for (let j = 0; j < CELLS; j++) if (j !== i && G.board[j]) out.push(j);
  return out;
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
  G.players[owner].fp += n;
  log(`${PLAYERS[owner].name} +${n} FP — ${why}.`, "p" + owner);
}

/**
 * Remove the piece at `i` from the board and run every consequence:
 * fallen-queen bookkeeping for Martyr's Pledge, the Phaser card returning to
 * the deck, and the probation on a revived queen.
 */
function removePiece(i, why = "captured") {
  const p = G.board[i];
  if (!p) return null;
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
      G.deck.push("phaserSpell");
      shuffleDeck("a Phaser died — its card returns to the deck");
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
    removePiece(mv.to, "is dragged down by Eye For An Eye");
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
      log(`A Sentinel adjacent to ${sq(mv.to)} forces the chain to stop.`, "rule");
      G.chain = null;
      finishAction();
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
function legalHeraldSteps(i) {
  const p = G.board[i];
  if (!p) return [];
  const r = rowOf(i), c = colOf(i), f = fwd(p.owner);
  const out = [];
  for (const dc of [-1, 1]) {
    const nr = r + f, nc = c + dc;
    if (onBoard(nr, nc) && !G.board[rc(nr, nc)]) out.push({ to: rc(nr, nc), kind: "herald" });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   TURN CYCLE
   ══════════════════════════════════════════════════════════════════════════ */

function shuffleDeck(why) {
  G.deck = shuffle(G.deck, mulberry32((G.seed + G.turnNo * 7919 + G.deck.length) | 0));
  G.castsSinceShuffle = 0;
  log(`The spell deck is shuffled — ${why}.`, "sys");
}

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

function checkGameOver() {
  if (G.over) return true;
  for (const side of [0, 1]) {
    if (countPieces(side) === 0) {
      G.over = { winner: 1 - side, reason: `${PLAYERS[side].name} has no pieces left` };
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
  // Backstop: the action layer will not let a turn end while either of these is
  // outstanding, but a rewind or a resigned game can leave one behind.
  G.owedDiscard = null;
  G.owedSacrifice = null;
  G.turnNo++;

  if (checkGameOver()) return;

  awardFP(player, 1, "start of turn");
  const alch = countForm("alchemist", player);
  if (alch > 0) awardFP(player, alch, `${alch} Alchemist${alch > 1 ? "s" : ""} transmuting`);

  // Blockade: you lose only if you cannot move AND cannot act your way out.
  if (!hasAnyMove(player)) {
    const canSpell = G.players[player].hand.some((id) => !spellBlocker(id, player));
    const canDraw = G.players[player].noDraw <= 0 && G.deck.length > 0;
    const canTransform = anyTransformPossible(player);
    if (!canSpell && !canDraw && !canTransform) {
      G.over = { winner: 1 - player, reason: `${PLAYERS[player].name} is blockaded and cannot act` };
      return;
    }
    log(`${PLAYERS[player].name} has no piece movement available.`, "big");
  }

  // Snapshot the decision point — this is what Chronos's Gaze returns to.
  G.history.push({ turn: player, turnNo: G.turnNo, snap: snapshot(G) });
  if (G.history.length > 40) G.history.shift();
}

function anyTransformPossible(owner) {
  for (let i = 0; i < CELLS; i++) {
    if (!isAlly(G.board[i], owner)) continue;
    for (const f of Object.keys(FORMS)) {
      if (FORMS[f].viaSpell) continue;
      if (!transformBlocker(i, f)) return true;
    }
  }
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

  P.fp -= F.cost;
  p.form = form;
  log(`${PLAYERS[owner].name} transforms the ${p.rank} at ${sq(i)} into a ${F.name}. (−${F.cost} FP)`, "p" + owner);

  switch (form) {
    case "juggernaut": {
      const victim = choices.sacrifice;
      removePiece(victim, "is sacrificed as Juggernaut armor");
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
      for (const idx of choices.sacrifices || []) removePiece(idx, "is sacrificed to the Enchanter");
      effNext(p, "frozen", 2);
      log("The Enchanter is frozen for its next 2 turns.", "rule");
      break;
    }
    case "alchemist": {
      removePiece(choices.sacrifice, "is sacrificed to the Alchemist");
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

  if (SPELLS[id].oncePerGame) {
    G.removed.push(id);
    log(`${SPELLS[id].name} is removed from the game.`, "sys");
  } else if (id === "phaserSpell") {
    // Parked out of the deck for as long as the Phaser it created survives.
    G.setAside.push(id);
  } else {
    G.deck.push(id);                     // used cards go to the bottom
  }
  G.castsSinceShuffle++;
  if (G.castsSinceShuffle >= 5) shuffleDeck("5 spells have been used");
}

function discardCards(caster, ids, why) {
  const P = G.players[caster];
  for (const id of ids) {
    const k = P.hand.indexOf(id);
    if (k >= 0) { P.hand.splice(k, 1); G.deck.push(id); }
  }
  if (ids.length) log(`${PLAYERS[caster].name} discards ${ids.length} card(s) — ${why}.`, "rule");
}

function castSpell(id, caster, payload = {}) {
  const S = SPELLS[id];
  const P = G.players[caster];
  P.fp -= S.cost;
  consumeCard(id, caster);
  if (caster === G.turn) G.castThisTurn++;
  log(`${PLAYERS[caster].name} casts ${S.name}. (−${S.cost} FP)`, "p" + caster);

  switch (id) {

    /* ── Movement ─────────────────────────────────────────────────────── */
    case "hopscotch": {
      const lc = G.lastCapture;
      const p = G.board[lc.to];
      if (p) { G.board[lc.to] = null; G.board[lc.from] = p; }
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
      for (const j of near) effNext(G.board[j], "frozen", 1);
      if (near.length) log(`Distortion Field — ${near.length} adjacent friendly pawn(s) skip their next move.`, "rule");
      break;
    }

    /* ── Combat ───────────────────────────────────────────────────────── */
    case "veil": {
      const t = G.board[payload.target];
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
      log(`Mind Control — ${PLAYERS[caster].name} seizes the enemy ${pieceLabel(G.board[payload.target])} at ${sq(payload.target)} for one movement.`, "rule");
      effNow(P, "noSpells", 1);      // "this turn"
      effNext(P, "noSpells", 1);     // "...and the next"
      if (P.hand.length) G.owedDiscard = { player: caster, n: 1, why: "Mind Control exhaustion" };
      break;
    }

    case "eye": {
      const t = G.board[payload.target];
      t.eyeMark = 3;
      log(`Eye For An Eye — the pawn at ${sq(payload.target)} is marked for 3 of the opponent's turns.`, "rule");
      effNext(t, "frozen", 1);
      effNext(P, "noSpells", 1);
      log("That pawn is Static next turn, and you may cast nothing else next turn.", "rule");
      break;
    }

    /* ── Game altering ────────────────────────────────────────────────── */
    case "chronos": {
      // Find the snapshot taken at the start of the caster's PREVIOUS turn.
      let target = null;
      for (let k = G.history.length - 1; k >= 0; k--) {
        const h = G.history[k];
        if (h.turn === caster && h.turnNo < G.turnNo) { target = h; G.history.length = k; break; }
      }
      if (!target) { log("Chronos's Gaze finds no earlier turn — it fizzles.", "rule"); break; }
      const keptLog = G.log.slice();
      restore(target.snap);
      G.log = keptLog;
      log(`Chronos's Gaze — the board, both Focus pools, and both hands return to the start of ${PLAYERS[caster].name}'s previous turn.`, "big");
      // The card itself stays spent, and the backlash applies on top of the
      // restored hand — otherwise the rewind would hand it straight back.
      const hand = G.players[caster].hand;
      const ci = hand.indexOf("chronos");
      if (ci >= 0) { hand.splice(ci, 1); G.deck.push("chronos"); }
      if (hand.length > 1) {
        const drop = hand.splice(1);
        for (const d of drop) G.deck.push(d);
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
      removePiece(payload.sacrifice, "is sacrificed to Temporal Cascade");
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
      removePiece(spot, "is sacrificed to The Martyr's Pledge");
      P.lostQueens.pop();
      const q = mkPiece(caster, "queen");
      G.board[spot] = q;
      P.martyrWatch = q.id;
      log(`The Martyr's Pledge — a queen rises at ${sq(spot)}. She is on probation until a new queen is crowned.`, "big");
      if (caster === G.turn) { G.hasActed = true; G.phase = "end"; }
      break;
    }

    case "phaserSpell": {
      applyTransform(payload.target, "phaser", {});
      break;
    }
  }

  checkGameOver();
}

/** Draw a card. This is a whole turn — the doc's Spell Decision step. */
function drawSpell(player) {
  const P = G.players[player];
  if (!G.deck.length) return false;      // the caller decides how to say so
  const id = G.deck.shift();
  P.hand.push(id);
  G.drewThisTurn = true;
  awardFP(player, 1, "drawing a spell");
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
function evasiveDests(from, owner) {
  const r = rowOf(from), c = colOf(from), b = -fwd(owner);
  const out = [];
  for (const dc of [-1, 1])
    if (onBoard(r + b, c + dc) && !G.board[rc(r + b, c + dc)]) out.push(rc(r + b, c + dc));
  return out;
}

/* ── mind control ───────────────────────────────────────────────────────── */

/**
 * Walk the seized enemy piece. Deliberately not a `performMove` call: a borrowed
 * step is the spell resolving, not the caster's movement, so it sets neither
 * `hasActed` nor the End Phase and the caster may still move afterwards.
 */
function performMindControlMove(from, mv) {
  const p = G.board[from];
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
  }
  return res || fail("No result.");
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
      const capturers = pendingSacrifice(seat);
      const skipping = capturers.length > 0 && mv.kind !== "capture"
        && G.chain == null && G.heraldBonus == null;

      performMove(a.from, mv);

      if (skipping) {
        // A capturer that was the moving piece now stands at the destination;
        // one that died in the process is no longer a candidate.
        const pool = capturers.map((c) => (c === a.from ? mv.to : c)).filter((c) => G.board[c]);
        if (pool.length === 1) {
          removePiece(pool[0], "is sacrificed for the skipped capture");
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
      removePiece(a.i, "is sacrificed for the skipped capture");
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

    /* ── transformation ─────────────────────────────────────────────────── */
    case "transform": {
      const g = turnGate(seat);
      if (g) return fail(g);
      if (G.chain != null) return fail("Finish your chain-jump first.");
      if (G.heraldBonus != null) return fail("Resolve the Herald's bonus step first.");
      if (!isIdx(a.i)) return fail("No such square.");
      const p = at(a.i);
      if (!p) return fail("There is no piece on that square.");
      if (p.owner !== seat) return fail("That is not your piece.");
      const F = FORMS[a.form];
      if (!F) return fail("No such transformation.");
      if (F.viaSpell) return fail("That form is only reached through its spell.");
      const blocker = transformBlocker(a.i, a.form);
      if (blocker) return fail(blocker);

      // The old modals guaranteed a valid sacrifice; the wire does not.
      const want = a.choices || {};
      const choices = {};
      if (a.form === "juggernaut") {
        if (!juggernautArmorPool(a.i).includes(want.sacrifice))
          return fail("The armor must be an adjacent untransformed friendly pawn.");
        choices.sacrifice = want.sacrifice;
      } else if (a.form === "alchemist") {
        if (!friendlyPawns(seat).includes(want.sacrifice))
          return fail("The Alchemist must be paid with one of your pawns.");
        choices.sacrifice = want.sacrifice;
      } else if (a.form === "enchanter") {
        const given = Array.isArray(want.sacrifices) ? want.sacrifices.slice().sort((x, y) => x - y) : null;
        if (!given) return fail("The Enchanter demands a sacrifice.");
        const match = enchanterSacrificeOptions(a.i)
          .some((opt) => opt.length === given.length
            && opt.slice().sort((x, y) => x - y).every((v, k) => v === given[k]));
        if (!match) return fail("That is not a legal Enchanter sacrifice.");
        choices.sacrifices = given;
      }

      applyTransform(a.i, a.form, choices);
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
        // hopscotch and chronos take no targets; spellBlocker already proved
        // there is a capture to reverse / a turn to return to.
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
      if (!G.deck.length) return fail("The spell deck is empty.");
      drawSpell(seat);
      return { ok: true, sameSeat: endTurn().sameSeat };   // drawing spends the whole turn
    }

    case "endTurn": {
      const g = turnGate(seat);
      if (g) return fail(g);
      if (G.chain != null) return fail("You must continue the chain-jump.");
      if (G.heraldBonus != null) return fail("Resolve the Herald's bonus step first.");
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
  // Hand CONTENTS are not, and neither is the order of the draw pile.
  v.players[foe].hand = v.players[foe].hand.map(() => HIDDEN_CARD);
  v.deck = v.deck.map(() => HIDDEN_CARD);

  // The snapshots are the secret; the shape of the past is not. Keeping the
  // stubs means spellBlocker's "is there an earlier turn?" test for Chronos's
  // Gaze still answers correctly on the client.
  v.history = g.history.map((h) => ({ turn: h.turn, turnNo: h.turnNo }));

  if (v.log.length > VIEW_LOG_TAIL) v.log = v.log.slice(-VIEW_LOG_TAIL);

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
    N, CELLS, PLAYERS, FORMS, SPELLS, SPELL_IDS,
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
    hasAnyMove, countPieces, countForm, spellBlocker, transformBlocker,
    evasiveTargets, evasiveDests, mirrorTargets, veilTargets, mindControlTargets,
    eyeTargets, phaserTargets, friendlyPawns, martyrSacrificePool,
    juggernautArmorPool, enchanterSacrificeOptions,
  };
}
