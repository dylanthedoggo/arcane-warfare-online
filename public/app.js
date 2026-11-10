"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   ARCANE WARFARE — the interface

   Everything the player sees and clicks: the board, the hand, the menus, the
   hot-seat curtain, the online client and the rules reference. The rules are
   in engine.js and the machine is in ai.js; nothing in this file decides what
   is legal.

   A classic script, loaded after engine.js, fx.js and ai.js. All of them share
   one scope, so this file reads `G` and calls the engine by bare name.
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   INTERFACE STATE  —  never cloned, never part of G

   `G` itself is declared in engine.js. Everything here is presentation: what is
   selected, what the curtain is hiding, which modal is open. None of it may ever
   affect a rule, which is what lets the server run engine.js without a DOM.
   ══════════════════════════════════════════════════════════════════════════ */

let UI = null;

/**
 * Online session. `on` is the switch the whole interface reads: when it is true
 * the client stops applying its own moves and G is whatever the server last
 * said it was. See the ONLINE section further down.
 */
const NET = {
  on: false,
  socket: null,
  seat: 0,             // which player you are — 0 Gold, 1 Violet
  room: null,          // four-letter code
  token: null,         // your claim on the seat, so a refresh gets it back
  oppConnected: false,
  // Pressure's clock. The server owns it; these two are only what it last
  // said, plus the local moment we heard — so the countdown drawn here ticks
  // smoothly without ever becoming a second source of truth about the game.
  clockMs: null,       // ms remaining when the last state arrived, or null
  clockSeat: null,     // whose turn is being counted
  clockAt: 0,          // performance.now() when that number was received
  clockTick: null,     // the interval redrawing it
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

function freshUI() {
  return {
    sel: null,           // selected board index
    moves: [],           // legal destinations for the selection
    targeting: null,     // { label, valid:Set, onPick, onCancel }
    heraldNoted: null,   // index of the Herald bonus already announced
    revealed: true,      // has the active player lifted the curtain?
    waitingRoom: false,  // the host's share-the-code sheet is up
    modalOpen: false,
    modalTag: null,      // which screen the open modal is, when it matters
    logOpen: UI ? UI.logOpen : true,   // survives a new game
  };
}

let CELL_NODES = [];
let BOARD_FLIPPED = null;          // the orientation the DOM is currently built for

/**
 * Which way up to draw the board.
 *
 * Board index order puts row 0 at the top, and row 0 is where Violet starts, so
 * the raw layout is Gold's point of view. Nobody should have to play a game
 * backwards, watching their own army march away from them up the screen. So the
 * board faces whichever seat the interface is currently showing a hand for, and
 * `viewSeat` already answers exactly that question for all three modes.
 *
 * The `UI.revealed` gate is what times the hot-seat turn-around. Online and
 * against the machine that flag is pinned true (see afterHandoff), so those
 * boards are set once and never move. Hot-seat is the case it exists for: while
 * the pass-the-device curtain is up the board holds its old orientation, and it
 * swings round at the moment the incoming player lifts it — not before, when
 * the player handing the device over would be the one watching it spin.
 */
const boardFlipped = () => {
  // The very first buildBoard() runs from the entry point, before `G` and `UI`
  // exist. Reaching through either of them there throws before wire() has run,
  // which kills the page silently — no handlers, no game, just an empty grid.
  if (!G || !UI) return false;
  // Watching two machines, viewSeat() follows the turn — and a board that
  // faced it would spin a full half-turn every time the machines handed over.
  // A spectator is not marching anywhere, so it is simply pinned.
  if (isDuel()) return false;
  return (NET.on || UI.revealed) && viewSeat() === 1;
};

function buildBoard() {
  const flip = boardFlipped();
  const board = $("board");
  board.innerHTML = "";
  CELL_NODES = [];
  for (let i = 0; i < CELLS; i++) {
    const c = el("div", "cell " + (isDark(i) ? "dark" : "light"));
    c.dataset.i = i;
    c.appendChild(el("div", "marker"));
    if (isDark(i)) c.addEventListener("click", () => onCellClick(i));
    CELL_NODES.push(c);
  }
  // CELL_NODES stays indexed by BOARD index — every lookup elsewhere is
  // CELL_NODES[i] and none of them need to know about this. Only the order the
  // cells are laid out in changes. Reversing it is a 180° turn, which keeps
  // every diagonal a diagonal and every dark square dark: nothing but the
  // viewpoint moves, and no rule ever sees it.
  for (let k = 0; k < CELLS; k++) board.appendChild(CELL_NODES[flip ? CELLS - 1 - k : k]);
  BOARD_FLIPPED = flip;
}

function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show " + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = kind; }, 2400);
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════════════════════════ */

function render() {
  renderTopbar();
  renderBoard();
  renderPlayers();
  renderHand();
  renderActions();
  renderLog();
}

function renderTopbar() {
  const badge = $("turnbadge");
  const dot = badge.querySelector(".dot");
  const nm = badge.querySelector(".nm");
  $("devchip").hidden = !G.dev;
  if (G.over) {
    dot.style.color = "#4bd6a0";
    nm.textContent = `${PLAYERS[G.over.winner].name} wins`;
    $("phasechip").textContent = G.over.reason;
    return;
  }
  dot.style.color = PLAYERS[G.turn].color;
  dot.style.background = PLAYERS[G.turn].color;
  nm.textContent = `${PLAYERS[G.turn].name} to act`;

  let phase = G.phase === "declare" ? "Declare Action" : "End Phase";
  // In an exhibition both chairs are machines, so "Ruthless is thinking" would
  // not say which one. Name the side as well.
  if (isDuel() && AI.paused) phase = "Paused";
  else if (isDuel()) phase = `${PLAYERS[G.turn].name} · ${aiNameFor(G.turn)} is thinking…`;
  else if (AI.thinking) phase = `${AI_LEVELS[AI.level].name} is thinking…`;
  else if (G.chain != null) phase = "Chain-jump — must continue";
  else if (G.heraldBonus != null) phase = "Herald bonus step";
  else if (G.twinStep != null) phase = "Temporal Twin — move the other body";
  else if (G.mindControl) phase = "Mind Control — move an enemy piece";
  else if (G.owedSacrifice) phase = "Declined capture — a piece is forfeit";
  else if (G.owedDiscard) phase = "Discard owed";
  else if (NET.on && !NET.oppConnected) phase = "Opponent disconnected";
  // Pressure. Announced on both screens, because a turn being timed changes
  // how the player NOT on the clock should be thinking too.
  const left = NET.on ? netClockLeft() : null;
  if (left != null)
    phase = NET.clockSeat === NET.seat
      ? `Under Pressure — ${left}s to act`
      : `${PLAYERS[NET.clockSeat].name} is under Pressure — ${left}s`;
  $("phasechip").textContent = phase;
}

function renderBoard() {
  // Which way up the board goes is decided by things that happen long after the
  // first build: taking a seat online, or lifting the curtain hot-seat.
  //
  // On a hot-seat handover this fires twice — act() renders once with the new
  // turn while the curtain has not gone up yet, and raiseCurtain() renders
  // again once it has. Both are in one synchronous task, so the browser paints
  // only the final state and the intermediate flip is never seen. Do not
  // "optimise" that away by hoisting the guard out of the render path: the
  // wasted rebuild is one cheap 144-node pass, and the alternative is a real
  // flash of the opponent's viewpoint on the way to the curtain.
  if (BOARD_FLIPPED !== boardFlipped()) buildBoard();

  const showMoveDots = UI.revealed && !G.over;
  for (let i = 0; i < CELLS; i++) {
    const node = CELL_NODES[i];
    const p = G.board[i];
    node.className = "cell " + (isDark(i) ? "dark" : "light");
    node.querySelector(".marker").innerHTML = "";

    // keep only the marker child, rebuild the piece
    while (node.childNodes.length > 1) node.removeChild(node.lastChild);

    if (p) {
      const d = el("div", "piece " + PLAYERS[p.owner].css);
      if (p.rank === "queen") d.classList.add("queen");
      if (p.armor) d.classList.add("armored");
      if (p.frozen > 0) d.classList.add("frozen");
      // An Alchemist can never move or capture again. fx.css gives it a slow
      // shimmer so it stops reading as an ordinary queen.
      if (p.form === "alchemist") d.classList.add("alchemist");
      if (p.eyeMark > 0) d.classList.add("marked");
      if (p.noCapture > 0) d.classList.add("veiled");
      // Only ever true on a piece this device is entitled to know about:
      // viewFor deletes the field outright from every enemy piece, and against
      // the machine the field is only ever set on pieces the player owns or
      // the machine does — which is why this asks whose seat is looking.
      if (p.hollow && (G.dev || spectating() || p.owner === viewSeat())) d.classList.add("hollow");
      // A superposition is public — both players can see the two bodies. Which
      // one is the pawn is not, so the second class is owner-only and rests on
      // a field viewFor has already deleted from the other seat's copy.
      // Wholly public: both bodies are real and both players see the pair.
      if (p.twin) d.classList.add("twinned");
      if (p.quantum) {
        d.classList.add("quantum");
        if (G.dev || spectating() || p.owner === viewSeat()) d.classList.add(p.quantumReal ? "qreal" : "qghost");
      }
      // A penalty that has been paid but has not landed yet is otherwise
      // invisible, which reads as "the penalty never happened". Show it.
      const pend = (p.p_frozen || 0) + (p.p_noCapture || 0);
      if (pend > 0) { d.classList.add("pending"); d.appendChild(el("span", "pendring")); }
      const glyph = p.form ? FORMS[p.form].glyph : (p.rank === "queen" ? "♛" : "");
      if (glyph) d.appendChild(el("span", "glyph", glyph));

      const bs = el("div", "badge-stack");
      const dots = (n, cls) => { for (let k = 0; k < Math.min(n, 3); k++) bs.appendChild(el("i", cls)); };
      dots(p.frozen, null);
      dots(p.noCapture, "veil");
      dots(p.p_frozen || 0, "pend");
      dots(p.p_noCapture || 0, "pend");
      if (bs.children.length) d.appendChild(bs);
      // A ghost is in flight to (or from) this square. Showing the real piece
      // as well would double it — FX puts the mask back the moment it lands.
      if (FX.hidden.has(i)) d.style.visibility = "hidden";
      node.appendChild(d);
      node.title = describePiece(p, i);
    } else {
      node.title = "";
    }

    if (isDark(i)) node.classList.add("playable");
    if (G.lastMove && i === G.lastMove.from) node.classList.add("lastfrom");
    if (G.lastMove && i === G.lastMove.to) node.classList.add("lastto");
    // Chokepoint's seal and the two ends of a Rift are board features, not
    // pieces — they have to be drawn by the square rather than by its occupant.
    if (isBarrier(i)) { node.classList.add("barrier"); node.title = "Sealed by Chokepoint — nothing may land here or cross it."; }
    if (G.rift && (i === G.rift.a || i === G.rift.b)) {
      node.classList.add("riftend");
      node.title = `Rift — anything landing here is carried to ${sq(i === G.rift.a ? G.rift.b : G.rift.a)}.`;
    }
  }

  // Where each of YOUR shells will put its pawn back. The retreat is the whole
  // card and it is invisible on the board otherwise — without this the caster
  // has to hover the pawn to remember which square they are playing toward.
  //
  // Gated exactly like the shell ring above, and on the same field: viewFor
  // deletes hollowHome from every enemy piece, so online the marker cannot be
  // drawn for the opponent even by accident. The viewSeat() half is what covers
  // the modes where this device holds the whole game — against the machine, the
  // full state is right here and only the seat asking may read it.
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (!p || !p.hollow || !(p.hollowHome >= 0) || p.hollowHome === i) continue;
    if (!(G.dev || p.owner === viewSeat())) continue;
    const home = CELL_NODES[p.hollowHome];
    home.classList.add("hollowhome");
    if (G.board[p.hollowHome]) home.classList.add("blocked");
    home.title = G.board[p.hollowHome]
      ? `Your Hollow at ${sq(i)} wants to come back here — but this square is occupied, so it would have to stand its ground instead.`
      : `Your Hollow at ${sq(i)} steps back out here when its shell breaks.`;
  }

  // The Herald's banner reaches exactly one diagonal step — a friendly pawn
  // landing adjacent to it may advance one extra square. That is a real rule
  // with real consequences and the board never said a word about it, so the
  // squares it covers are lit for as long as the Herald lives. adjacentTo()
  // already returns exactly the on-board diagonal neighbours.
  for (let i = 0; i < CELLS; i++) {
    const p = G.board[i];
    if (!p || p.form !== "herald") continue;
    for (const j of adjacentTo(i, () => true)) CELL_NODES[j].classList.add("heraldzone");
  }

  // Temporal Cascade's stolen turns are otherwise a line in the log and nothing
  // else. While they last, the board itself runs cold.
  $("board").classList.toggle("fx-cascade",
    !G.over && G.players[G.turn].extraTurns > 0);

  if (UI.targeting) {
    for (const i of UI.targeting.valid) CELL_NODES[i].classList.add("spelltarget");
    FX.pump();
    return;
  }
  if (UI.sel != null) {
    CELL_NODES[UI.sel].classList.add("selected");
    if (showMoveDots)
      for (const m of UI.moves)
        CELL_NODES[m.to].classList.add(m.kind === "capture" ? "captarget" : "movetarget");
  }

  // Last, once the board is telling the truth: play whatever the referee just
  // recorded on top of it. This is the only call site — every path that changes
  // the game ends in a render, in all three modes.
  FX.pump();
}

function describePiece(p, i) {
  /**
   * May this device read `p`'s secrets — the concealment-card fields?
   *
   * Online the question is already settled: viewFor deleted them, so the
   * branches below simply do not fire. It is the OFFLINE modes this exists for.
   * Against the machine the client holds the whole game, enemy fields and all,
   * so a tooltip that just tested `p.hollow` would cheerfully announce the
   * machine's own Hollow to the player hovering it — the board stopped doing
   * that at the `.hollow` class and the tooltip was still doing it.
   */
  const mayRead = G.dev || spectating() || p.owner === viewSeat();
  const bits = [`${PLAYERS[p.owner].name} ${pieceLabel(p)} · ${sq(i)}`];
  if (p.form) bits.push(FORMS[p.form].ability);
  if (p.armor) bits.push("Armored — survives the first capture.");
  if (p.frozen > 0) bits.push(`Frozen for ${p.frozen} more turn(s).`);
  if (p.noCapture > 0) bits.push(`Static Veil — cannot capture for ${p.noCapture} more turn(s).`);
  if (p.p_frozen > 0) bits.push(`PENALTY PENDING — will be frozen for ${p.p_frozen} turn(s) starting next turn.`);
  if (p.p_noCapture > 0) bits.push(`PENALTY PENDING — will be unable to capture for ${p.p_noCapture} turn(s).`);
  if (p.twin) bits.push("TEMPORAL TWIN — both bodies are real and both move each turn. Whatever ends either one ends both.");
  // The superposition itself is public — both bodies are plainly on the board.
  // WHICH of them is the pawn is not, so that half needs the same gate.
  if (p.quantum)
    bits.push(mayRead && p.quantumReal === true ? "SUPERPOSED — and this is the real pawn. Neither square can capture."
      : mayRead && p.quantumReal === false ? "SUPERPOSED — this square is the empty half. Neither can capture."
      : "SUPERPOSED — one of these two squares holds the pawn. Neither can capture.");
  if (p.hollow && mayRead)
    bits.push(`HOLLOW — a shell. Your opponent sees an ordinary pawn. The first enemy jump or enemy spell aimed at it breaks on the shell, takes nothing, and this pawn steps back out at ${p.hollowHome >= 0 ? sq(p.hollowHome) : "its old square"}${p.hollowHome >= 0 && G.board[p.hollowHome] ? " — which is occupied right now, so it would have to stand its ground instead" : ""}. It cannot capture until then, and it will not save this pawn from a sacrifice you choose yourself.`);
  if (p.eyeMark > 0) bits.push(`Eye For An Eye — marked for ${p.eyeMark} more enemy turn(s).`);
  if (p.veilBy != null && p.noCapture > 0)
    bits.push(`${PLAYERS[p.veilBy].name} owes friendly fire when this stun expires.`);
  if (p.captures) bits.push(`Lifetime captures: ${p.captures}.`);
  return bits.join("\n");
}

function renderPlayers() {
  const wrap = $("players");
  wrap.innerHTML = "";
  for (let s = 0; s < 2; s++) {
    const P = G.players[s];
    const row = el("div", "pstrip" + (s === G.turn && !G.over ? " active" : ""));
    row.style.color = PLAYERS[s].color;
    const sw = el("div", "swatch");
    sw.style.background = PLAYERS[s].color;
    row.appendChild(sw);

    const mid = el("div");
    mid.style.flex = "1";
    mid.style.minWidth = "0";
    // aiNameFor(s), never AI.level: in an exhibition AI.level answers for
    // whichever machine is thinking, so both strips would wear one name.
    mid.appendChild(el("div", "nm", PLAYERS[s].name + (isAISeat(s) ? ` · ${aiNameFor(s)}` : AI.on ? " · you" : "")));
    // Hand SIZE is public information; the contents are not.
    const bits = [`${countPieces(s)} pieces`, `${P.hand.length} cards`];
    if (P.lostQueens.length) bits.push(`${P.lostQueens.length} fallen ♛`);
    mid.appendChild(el("div", "meta", bits.join(" · ")));

    const effs = el("div", "efflist");
    const push = (t, cls) => effs.appendChild(el("div", "eff " + (cls || ""), t));
    if (P.noSpells > 0) push(`no spells ${P.noSpells}`);
    if (P.noDraw > 0) push(`no draw ${P.noDraw}`);
    if (P.noTransform > 0) push(`no transform ${P.noTransform}`);
    if (P.costCap > 0) push(`≤${P.costCapMax} FP spells ${P.costCap}`);
    if (P.extraTurns > 0) push(`+${P.extraTurns} turns`);
    if (P.martyrBanned) push("Martyr lost");
    // Penalties already paid for but not yet in effect.
    if (P.p_noSpells > 0) push(`no spells next turn`, "pend");
    if (P.p_noDraw > 0) push(`no draw next turn`, "pend");
    if (P.p_noTransform > 0) push(`no transform next turn`, "pend");
    if (P.p_costCap > 0) push(`≤${P.costCapMax} FP spells, ${P.p_costCap} turns`, "pend");
    const owed = veilBacklashPending(s);
    if (owed) push(`friendly fire owed ×${owed}`, "pend");
    let pendingPieces = 0;
    for (const q of G.board) if (q && q.owner === s && (q.p_frozen > 0 || q.p_noCapture > 0)) pendingPieces++;
    if (pendingPieces) push(`${pendingPieces} piece penalt${pendingPieces === 1 ? "y" : "ies"} pending`, "pend");
    if (effs.children.length) mid.appendChild(effs);
    row.appendChild(mid);

    // A spectator is owed both pools: watching two machines trade spells with
    // one of the two budgets blanked out makes half the game unreadable.
    const mine = spectating() || s === viewSeat();
    const fp = el("div", "fp" + (mine && !G.dev && P.fp >= FP_CAP ? " full" : ""));
    if (mine) {
      fp.textContent = G.dev ? "∞" : P.fp;
      fp.appendChild(el("small", null, G.dev ? "FP" : `/${FP_CAP} FP`));
      fp.title = G.dev
        ? "Dev sandbox — the pool refills after every action, so nothing is ever unaffordable."
        : P.fp >= FP_CAP
        ? `Full. Every Focus Point earned from here is wasted until some is spent.`
        : `Focus Points. The pool is capped at ${FP_CAP} — income above that is lost.`;
    } else {
      fp.textContent = "—";
      fp.appendChild(el("small", null, "FP"));
      fp.title = "Your opponent's Focus Points are hidden.";
    }
    row.appendChild(fp);
    wrap.appendChild(row);
  }
}

/**
 * Which of the two card colours `id` wears. A transformation spell reshapes
 * one of your pieces permanently; everything else resolves and is gone. The
 * hand and the rules reference both read this, so they can never disagree
 * about what a card is.
 */
const spellKind = (id) => (SPELLS[id].group === "Transformation" ? "form" : "arcane");

function renderHand() {
  const wrap = $("hand");
  wrap.innerHTML = "";
  const seat = viewSeat();
  const P = G.players[seat];
  const owner = $("handowner");
  const bothHands = spectating();
  const total = G.players[0].hand.length + G.players[1].hand.length;
  const shown = bothHands ? total : P.hand.length;
  owner.textContent = bothHands ? "Both Hands" : (AI.on || NET.on) ? "Your Hand" : `${PLAYERS[seat].name}'s Hand`;
  owner.style.color = bothHands ? "var(--ink)" : PLAYERS[seat].color;
  $("handcount").textContent = `${shown} card${shown === 1 ? "" : "s"}`;
  const scarceLeft = SPELL_IDS.reduce((sum, id) => {
    const cap = SPELLS[id].maxDraws;
    return cap != null ? sum + Math.max(0, cap - (G.drawCounts[id] || 0)) : sum;
  }, 0);
  $("deckcount").textContent = `weighted, ${scarceLeft} scarce draw${scarceLeft === 1 ? "" : "s"} left`;

  // Nobody at this device holds a hand — so instead of showing one seat's, show
  // both. Neither machine can read the screen, and the bluff a Hollow Shell is
  // running is the whole reason to watch a game you are not playing.
  if (bothHands) {
    for (let s = 0; s < 2; s++) {
      const row = el("div", "handside");
      row.style.color = PLAYERS[s].color;
      row.appendChild(el("span", null, `${PLAYERS[s].name} · ${aiNameFor(s)}`));
      row.appendChild(el("small", null, `${G.players[s].hand.length} card${G.players[s].hand.length === 1 ? "" : "s"}`));
      wrap.appendChild(row);
      renderHandCards(wrap, s);
    }
    return;
  }

  if (!UI.revealed) {
    wrap.appendChild(el("div", "empty", "Hidden until you lift the curtain."));
    return;
  }
  renderHandCards(wrap, seat);
}

/** One seat's hand as a stack of cards, appended to `wrap`. */
function renderHandCards(wrap, seat) {
  const P = G.players[seat];
  if (!P.hand.length) {
    wrap.appendChild(el("div", "empty", "No cards. Spend a turn drawing one."));
    return;
  }
  // Group identical cards so a hand of six Evasive Maneuvers reads as one row.
  const counts = {};
  for (const id of P.hand) counts[id] = (counts[id] || 0) + 1;

  for (const id of Object.keys(counts)) {
    const S = SPELLS[id];
    const blocker = spellBlocker(id, seat);
    const b = el("button", "card " + spellKind(id));
    // spellBlocker already refuses everything but an anyTurn card off-turn, so
    // the off-turn online player's Martyr's Pledge stays live and nothing else does.
    b.disabled = !!blocker || !!G.over || !!G.owedDiscard || !!G.owedSacrifice
      || AI.thinking || isAISeat(G.turn) || (NET.on && !NET.oppConnected);
    const head = el("div", "cname");
    head.appendChild(el("span", null, S.name + (counts[id] > 1 ? ` ×${counts[id]}` : "")));
    head.appendChild(el("span", "ccost", S.cost + " FP"));
    b.appendChild(head);
    b.appendChild(el("div", "cwhen", blocker || S.timing));
    b.title = `${S.text}\n\nPENALTY: ${S.penalty}\nTIMING: ${S.timing}`;
    if (!b.disabled) b.addEventListener("click", () => beginCast(id, seat));
    wrap.appendChild(b);
  }
}

function renderActions() {
  const wrap = $("actions");
  wrap.innerHTML = "";
  const P = G.players[G.turn];

  /**
   * `key` tags the button with a shortcut. The keyboard handler finds it by
   * that tag and clicks it, which is the point: every condition worked out
   * below — the disabled states, and the many branches where a button is not
   * rendered at all — applies to the keyboard automatically. There is no second
   * copy of "may I draw right now?" to drift out of step with this one.
   */
  const add = (label, hint, cls, enabled, fn, key) => {
    const b = el("button", "abtn " + (cls || ""));
    const head = el("span", "lbl");
    head.appendChild(el("span", null, label));
    if (key) {
      b.dataset.key = key;
      const cap = ACTION_KEYS.find((k) => k.action === key);
      if (cap) head.appendChild(el("kbd", "kbd", cap.cap));
    }
    b.appendChild(head);
    if (hint) b.appendChild(el("span", "hint", hint));
    b.disabled = !enabled;
    if (enabled) b.addEventListener("click", fn);
    wrap.appendChild(b);
    return b;
  };

  if (G.over) {
    add("New Game", "start over", "primary", true, startNewGame);
    return;
  }
  // Watching two machines, this panel is a remote control rather than a turn:
  // there is no action here that belongs to anyone at this device.
  if (isDuel()) {
    if (AI.paused)
      add("Resume", `${PLAYERS[G.turn].name} · ${aiNameFor(G.turn)} is to act`, "primary", true, duelResume);
    else
      add("Pause", "", "primary", true, duelPause);
    const sp = WATCH_SPEEDS[AI.watch];
    add(`Speed · ${sp.label}`, sp.hint, "", true, watchCycle);
    add("Stop watching", "back to the menu", "", true, startNewGame);
    return;
  }
  if (AI.thinking || isAISeat(G.turn)) {
    add(`${AI_LEVELS[AI.level].name} is thinking…`, "searching for its move", "", false, null);
    return;
  }
  if (!UI.revealed) {
    add("Reveal my hand", "curtain is up", "primary", true, () => { UI.revealed = true; $("curtain").hidden = true; render(); });
    return;
  }
  if (G.owedSacrifice) {
    if (iDrive(G.owedSacrifice.player))
      add("Choose the piece you forfeit", "you declined a mandatory capture", "danger", true, promptOwedSacrifice);
    else
      add("Waiting…", `${PLAYERS[G.owedSacrifice.player].name} is choosing a forfeit`, "", false, null);
    return;
  }
  if (G.owedDiscard) {
    if (iDrive(G.owedDiscard.player))
      add("Choose a card to discard", G.owedDiscard.why, "danger", true, promptOwedDiscard);
    else
      add("Waiting…", `${PLAYERS[G.owedDiscard.player].name} owes a discard`, "", false, null);
    return;
  }
  if (UI.targeting) {
    add("Cancel targeting", UI.targeting.label, "danger", true, () => { UI.targeting = null; render(); });
    return;
  }
  // Online, the off-turn player still needs their panel — an any-turn card is
  // live in their hand and the connection banner belongs somewhere.
  if (NET.on && G.turn !== NET.seat) {
    add(`${PLAYERS[G.turn].name} is thinking…`, NET.oppConnected ? "their turn" : "opponent disconnected", "", false, null);
    return;
  }
  if (G.chain != null) {
    add("Chain-jump in progress", "you must keep capturing", "", false, null);
    return;
  }
  if (G.heraldBonus != null) {
    // The board already lights the square, but one green dot in a crowded
    // position is easy to miss, and an actions panel whose only button was
    // "skip" made the Herald read as an ability that does nothing. Offer the
    // step itself, by name.
    const from = G.heraldBonus;
    for (const s of legalHeraldSteps(from))
      add(`⚑ Advance to ${sq(s.to)}`, "the Herald's extra square", "primary", true,
        () => act({ t: "move", from, to: s.to, kind: "herald" }));
    add("Skip the bonus step", "leave the pawn where it is", "", true,
      () => act({ t: "heraldSkip" }));
    return;
  }
  if (G.mindControl) {
    add("Mind Control active", "move the seized enemy piece", "", false, null);
    return;
  }

  const canDraw = G.phase === "declare" && !G.hasActed && G.castThisTurn === 0 && !G.drewThisTurn
    && P.noDraw <= 0 && eligibleSpellIds().length > 0
    && !stutterBans(G.turn, { t: "draw" });
  add("Draw a Spell Card",
    canDraw ? (G.dev ? "one card · costs you nothing here" : "one card · ends your turn") : drawWhy(P),
    "", canDraw, () => act({ t: "draw" }), "draw");

  const capturers = pendingSacrifice(G.turn);
  if (capturers.length && G.phase === "declare" && !G.hasActed)
    add("Capture available", `${capturers.length} piece(s) must jump`, "danger", false, null);

  add("End Turn",
    G.dev ? "take the other side"
      : G.phase === "declare" && !G.hasActed ? "you have not acted"
      : "pass to your opponent",
    "primary", true, () => act({ t: "endTurn" }), "endTurn");
}

function drawWhy(P) {
  if (P.noDraw > 0) return `barred for ${P.noDraw} turn(s)`;
  if (!eligibleSpellIds().length) return "no spell can be drawn";
  if (G.drewThisTurn) return "already drew";
  if (G.hasActed || G.castThisTurn) return "must be your first action";
  if (G.phase !== "declare") return "Declare phase only";
  // Last, because the others describe the turn and this one describes the turn
  // BEFORE it — the one Stutter unmade, which was spent on exactly this.
  if (stutterBans(G.turn, { t: "draw" })) return "Stutter — you already took that turn";
  return "";
}

/**
 * The referee log as the seat at this device is entitled to read it.
 *
 * Online the server has already filtered it — viewFor() drops another seat's
 * private lines before they ever leave the process. This exists for the game
 * against the MACHINE, where there is no wire and no view: the browser holds
 * the real G, secret lines and all, and rendering it raw would hand the
 * machine's concealed pieces straight to the player it is concealing them
 * from. Doing it in both places costs nothing and means neither has to be the
 * one that remembers.
 */
function visibleLog() {
  // The sandbox has one person in both chairs, so there is nobody to keep a
  // line from — and a workbench that hides half of what it just did is not
  // much of a workbench.
  if (G.dev || spectating()) return G.log;
  const me = viewSeat();
  return G.log.filter((e) => e.only == null || e.only === me);
}

function renderLog() {
  const zone = $("logzone");
  const lines = visibleLog();
  zone.classList.toggle("collapsed", !UI.logOpen);
  $("logToggle").setAttribute("aria-expanded", String(!!UI.logOpen));
  $("logcount").textContent = UI.logOpen ? "" : `${lines.length} entries`;
  if (!UI.logOpen) return;
  const wrap = $("log");
  wrap.innerHTML = "";
  for (const e of lines.slice(-90)) wrap.appendChild(el("div", "logline " + e.kind, e.text));
  wrap.scrollTop = wrap.scrollHeight;
}

/* ══════════════════════════════════════════════════════════════════════════
   MODALS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * `tag` names the screen for anything that needs to know WHICH modal is up.
 * Only the opening menu uses it, and only so the Space knock below can be sure
 * it is listening on the title screen and nowhere else.
 */
function showModal({ title, sub, items = [], buttons = [], tag = null }) {
  UI.modalOpen = true;
  UI.modalTag = tag;
  $("mTitle").textContent = title;
  $("mSub").innerHTML = sub || "";
  const list = $("mList"); list.innerHTML = "";
  for (const it of items) {
    const b = el("button", "bigbtn " + (it.cls || ""));
    b.appendChild(el("span", null, it.label));
    if (it.desc) b.appendChild(el("span", "d", it.desc));
    b.disabled = !!it.disabled;
    if (!it.disabled) b.addEventListener("click", () => { closeModal(); it.onClick(); });
    list.appendChild(b);
  }
  const row = $("mRow"); row.innerHTML = "";
  for (const bt of buttons) {
    const b = el("button", "bigbtn " + (bt.cls || ""), bt.label);
    b.addEventListener("click", () => { closeModal(); bt.onClick && bt.onClick(); });
    row.appendChild(b);
  }
  $("modal").hidden = false;
}
function closeModal() {
  $("modal").hidden = true;
  UI.modalOpen = false;
  UI.modalTag = null;
  devKnock.n = 0;                     // leaving the title screen forgets the knock
}

/* ══════════════════════════════════════════════════════════════════════════
   ACTION DISPATCH

   Nothing in the interface mutates G directly any more. Every player decision
   becomes a plain object — {t:"move", from, to, kind} and friends — and goes
   through act(), which either applies it here (hot-seat, vs-machine) or ships it
   to the server (online) and waits for the authoritative state to come back.

   The point is that both paths validate through the same applyAction(), so the
   rules cannot drift apart, and a bug in the online validator is a bug you can
   reproduce offline.
   ══════════════════════════════════════════════════════════════════════════ */

/** Is `seat` driven by the person sitting at this device? */
const iDrive = (seat) => (NET.on ? seat === NET.seat : !isAISeat(seat));

function act(action, seat = G.turn) {
  if (NET.on) { netSend(action); return true; }

  const res = applyAction(seat, action);
  if (!res.ok) { toast(res.err, "bad"); clearSelection(); render(); return false; }

  clearSelection();
  UI.targeting = null;
  // draw and endTurn hand play over, and so does any action that leaves the
  // player with nothing else to do. All of them report whether Temporal Cascade
  // kept the turn on the same seat.
  if ("sameSeat" in res) {
    if (res.autoPassed) toast("Nothing left to do — your turn passed automatically.", "");
    render();
    afterHandoff(res.sameSeat);
  }
  else afterAction();
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
   INPUT
   ══════════════════════════════════════════════════════════════════════════ */

function onCellClick(i) {
  if (G.over || UI.modalOpen || !UI.revealed) return;
  // The four game-altering spells hold the board while they resolve. Nothing
  // else does — an ordinary capture is clickable through its own animation.
  if (FX.lock > 0) return;
  if (isDuel()) { toast("You are watching this one — the machines are playing it.", ""); return; }
  if (AI.thinking || isAISeat(G.turn)) { toast("Wait for the machine to move.", ""); return; }

  if (UI.targeting) {
    if (UI.targeting.valid.has(i)) { const f = UI.targeting.onPick; UI.targeting = null; f(i); }
    else toast("Not a legal target for this spell.", "bad");
    return;
  }
  if (G.owedSacrifice) { toast("Choose which piece is forfeit first.", "bad"); return; }
  if (G.owedDiscard) { toast("Resolve your discard first.", "bad"); return; }
  if (NET.on && G.turn !== NET.seat) { toast("Wait for your opponent.", ""); return; }

  // Mind Control: the seized enemy piece is the only thing that may move.
  if (G.mindControl) {
    const src = G.mindControl.piece;
    if (i === src) { selectPiece(src, simpleMoves(src).filter((m) => m.kind === "step")); return; }
    if (UI.sel === src) {
      const mv = UI.moves.find((m) => m.to === i);
      if (mv) { act({ t: "mindMove", from: src, to: mv.to }); return; }
    }
    toast("Move the mind-controlled piece.", "bad");
    return;
  }

  const p = G.board[i];

  // Committing a move for the current selection
  if (UI.sel != null) {
    const mv = UI.moves.find((m) => m.to === i);
    if (mv) { attemptMove(UI.sel, mv); return; }
  }

  if (!p) {
    // While the rules have you locked to one piece — mid chain-jump, or owed a
    // Herald step — a stray click on an empty square used to drop the
    // selection, taking the only highlight of what you are meant to do with it.
    const locked = G.chain != null ? G.chain : G.heraldBonus != null ? G.heraldBonus : G.twinStep;
    if (locked != null && G.board[locked]) { selectPiece(locked, legalMovesFor(locked)); return; }
    clearSelection(); render(); return;
  }
  if (p.owner !== G.turn) { toast(describePiece(p, i).split("\n")[0], ""); return; }

  if (G.chain != null && i !== G.chain) { toast("You must continue the chain-jump.", "bad"); return; }
  if (G.heraldBonus != null && i !== G.heraldBonus) { toast("Resolve the Herald's bonus step first.", "bad"); return; }

  const moves = legalMovesFor(i);
  selectPiece(i, moves);
  if (!moves.length && G.phase === "declare") {
    if (p.frozen > 0) toast(`Frozen for ${p.frozen} more turn(s).`, "bad");
    else if (isImmobile(p)) toast(`${FORMS[p.form].name}s never move.`, "bad");
    else toast("No legal moves for this piece.", "");
  }
}

function selectPiece(i, moves) { UI.sel = i; UI.moves = moves; render(); }
function clearSelection() { UI.sel = null; UI.moves = []; }

/**
 * Warn about the mandatory-capture rule, then send the move.
 *
 * Which piece pays for a declined capture is decided *after* the move lands —
 * the referee records the choice on G.owedSacrifice and promptOwedSacrifice()
 * collects it, rather than the interface guessing at the candidates up front.
 */
function attemptMove(from, mv) {
  if (G.phase !== "declare" && G.chain == null && G.heraldBonus == null) {
    toast("You have already acted this turn.", "bad");
    return;
  }
  const capturers = pendingSacrifice(G.turn);
  const skipping = capturers.length > 0 && mv.kind !== "capture" && G.chain == null && G.heraldBonus == null;
  const send = () => { clearSelection(); act({ t: "move", from, to: mv.to, kind: mv.kind }); };

  if (!skipping) { send(); return; }

  showModal({
    title: "That skips a mandatory capture",
    sub: `${capturers.length} of your pieces can jump right now. Moving elsewhere costs you one of them — you pick which. <br><br>Ending your turn without moving, or drawing a card, would avoid the penalty entirely.`,
    buttons: [
      { label: "Move anyway", cls: "no", onClick: send },
      { label: "Cancel", onClick: () => { render(); } },
    ],
  });
}

/** Collect the forfeit owed for a declined mandatory capture. */
function promptOwedSacrifice() {
  const os = G.owedSacrifice;
  if (!os) { render(); return; }
  showModal({
    title: "You declined a mandatory capture",
    sub: "One of the pieces that could have jumped is forfeit. <b>You choose which.</b>",
    items: os.candidates.filter((c) => G.board[c]).map((c) => ({
      label: `${pieceLabel(G.board[c])} at ${sq(c)}`,
      desc: describePiece(G.board[c], c).split("\n").slice(1).join(" ") || "No special properties.",
      cls: "no",
      onClick: () => act({ t: "sacrifice", i: c }, os.player),
    })),
  });
}

function afterAction() {
  if (checkGameOver()) { render(); announceWinner(); return; }
  if (G.owedSacrifice && iDrive(G.owedSacrifice.player)) { render(); promptOwedSacrifice(); return; }

  // Announce the Herald's banner once per bonus. It is the one thing that
  // happens to a piece you did not just click, so nothing else draws the eye.
  if (G.heraldBonus == null) UI.heraldNoted = null;
  else if (UI.heraldNoted !== G.heraldBonus) {
    UI.heraldNoted = G.heraldBonus;
    if (iDrive(G.turn)) toast("Herald's banner — this pawn may advance one more square.", "good");
  }

  // When the rules lock the player into a specific piece — mid chain-jump, or
  // owed a Herald step — select it for them so the legal squares light up
  // without a hunt for which piece the referee means.
  const locked = G.chain != null ? G.chain : G.heraldBonus;
  if (locked != null && G.board[locked]) { selectPiece(locked, legalMovesFor(locked)); return; }
  render();
}

/** Local-game turn handover: move the state first, then the presentation. */
function endTurnLocal() {
  const r = endTurn();
  render();
  afterHandoff(r.sameSeat);
}

function pickOne(indices, title, sub, fn) {
  if (!indices.length) { toast("No valid choice.", "bad"); render(); return; }
  if (indices.length === 1) { fn(indices[0]); return; }
  showModal({
    title, sub,
    items: indices.map((j) => ({
      label: `${pieceLabel(G.board[j])} at ${sq(j)}`,
      desc: describePiece(G.board[j], j).split("\n").slice(1).join(" "),
      onClick: () => fn(j),
    })),
    buttons: [{ label: "Cancel", onClick: () => render() }],
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   SPELL CASTING FLOW  —  collects targets, then sends one cast action

   The target lists offered here are the same ones applyAction() validates the
   payload against, so a legitimately-collected target always passes.
   ══════════════════════════════════════════════════════════════════════════ */

function target(label, valid, onPick) {
  clearSelection();
  UI.targeting = { label, valid: new Set(valid), onPick };
  render();
  toast(label);
}

function beginCast(id, caster) {
  const blocker = spellBlocker(id, caster);
  if (blocker) { toast(blocker, "bad"); return; }
  const S = SPELLS[id];
  const finish = (payload) => act({ t: "cast", id, payload }, caster);

  const confirmFirst = (body, onYes) => showModal({
    title: S.name,
    sub: `${S.flavor ? `<i>${S.flavor}</i><br><br>` : ""}${body}<br><br><b>Penalty:</b> ${S.penalty}`,
    buttons: [
      { label: `Cast for ${S.cost} FP`, cls: "go", onClick: onYes },
      { label: "Cancel", onClick: () => render() },
    ],
  });

  switch (id) {
    case "hopscotch":
      confirmFirst(S.text, () => finish({}));
      return;

    case "evasive":
      target("Choose a pawn to step backward", evasiveTargets(caster), (from) => {
        target("Choose the square to retreat to", evasiveDests(from, caster),
          (to) => finish({ from, to }));
      });
      return;

    case "mirror": {
      const qs = mirrorTargets(caster);
      target("Choose a queen to mirror across the centerline", qs, (from) => finish({ from }));
      return;
    }

    case "veil":
      target("Choose an enemy piece to stun", veilTargets(caster), (t) => finish({ target: t }));
      return;

    case "mindcontrol":
      target("Choose an enemy piece to seize", mindControlTargets(caster), (t) => finish({ target: t }));
      return;

    case "eye":
      target("Choose one of your untransformed pawns to mark", eyeTargets(caster), (t) => finish({ target: t }));
      return;

    case "chronos": {
      const opts = chronosTargets(caster);
      confirmFirst(S.text, () => {
        if (opts.length === 1) { finish({ turnNo: opts[0] }); return; }
        showModal({
          title: "Chronos's Gaze",
          sub: "Choose how far back to rewind.",
          items: opts.map((turnNo, k) => ({
            label: k === 0 ? "Rewind 1 turn" : "Rewind 2 turns",
            desc: "The board, both Focus pools, and both hands return to that turn's start.",
            onClick: () => finish({ turnNo }),
          })),
          buttons: [{ label: "Cancel", onClick: () => render() }],
        });
      });
      return;
    }

    case "cascade":
      confirmFirst(S.text, () =>
        target("Choose the pawn to sacrifice", friendlyPawns(caster),
          (j) => finish({ sacrifice: j })));
      return;

    case "martyr": {
      // The rearmost pawn pays. Ties are the player's choice, per the doc.
      const pool = martyrSacrificePool(caster);
      confirmFirst(S.text, () => {
        if (pool.length === 1) finish({ sacrifice: pool[0] });
        else pickOne(pool, "Choose the pawn to sacrifice",
          "Several of your pawns are equally far back. The revived queen takes its square.",
          (j) => finish({ sacrifice: j }));
      });
      return;
    }

    case "phaserSpell":
      target("Choose a pawn that has captured at least once", phaserTargets(caster),
        (t) => finish({ target: t }));
      return;

    case "juggernautSpell":
      target("Choose a piece to transform into a Juggernaut", juggernautTargets(caster), (i) => {
        pickOne(juggernautArmorPool(i), "Choose the pawn to sacrifice as armor",
          "It is placed beneath the Juggernaut and absorbs the first capture.",
          (j) => finish({ target: i, sacrifice: j }));
      });
      return;

    case "heraldSpell":
      target("Choose a pawn on the opponent's half to transform into a Herald", heraldTargets(caster),
        (t) => finish({ target: t }));
      return;

    case "enchanterSpell":
      target("Choose a queen to transform into an Enchanter", enchanterTargets(caster), (i) => {
        const options = enchanterSacrificeOptions(i);
        showModal({
          title: "The Enchanter demands a sacrifice",
          sub: "An adjacent friendly <b>queen</b>, or <b>three</b> adjacent friendly pawns.",
          items: options.map((idxs) => ({
            label: idxs.length === 1
              ? `Sacrifice the adjacent queen at ${sq(idxs[0])}`
              : `Sacrifice 3 adjacent pawns: ${idxs.map(sq).join(", ")}`,
            onClick: () => finish({ target: i, sacrifices: idxs }),
          })),
          buttons: [{ label: "Cancel", onClick: () => render() }],
        });
      });
      return;

    case "alchemistSpell":
      target("Choose a queen on your back row to transform into an Alchemist", alchemistTargets(caster), (i) => {
        pickOne(friendlyPawns(caster), "Choose the pawn to sacrifice", "The Alchemist demands one pawn.",
          (j) => finish({ target: i, sacrifice: j }));
      });
      return;

    /* ── the board itself ───────────────────────────────────────────── */
    case "tactician":
      confirmFirst(`${S.text}<br><br>You have <b>${availableCaptures(caster)}</b> capture(s) available.`,
        () => finish({}));
      return;

    case "rift":
      // A rift already open makes this the sealing half of the card, and there
      // is nothing to point at — the open rift is the target.
      if (G.rift) {
        confirmFirst(`A rift is open at <b>${sq(G.rift.a)}</b> and <b>${sq(G.rift.b)}</b>.<br><br>`
          + "Casting Rift now <b>seals</b> it. Nothing will be carried between those squares again.",
          () => finish({}));
        return;
      }
      target("Choose the first end of the rift", openSquares(), (a) => {
        target("Choose the far end", openSquares().filter((j) => j !== a),
          (b) => finish({ a, b }));
      });
      return;

    case "wraparound":
      confirmFirst(S.text, () => finish({}));
      return;

    case "anchor":
      confirmFirst(`${S.text}<br><br>`
        + (G.anchor
          ? `Time is already pinned at turn <b>${G.anchor.turnNo}</b>. This drags the pin forward to <b>turn ${G.turnNo}</b>.`
          : `Pins the game at <b>turn ${G.turnNo}</b>.`), () => finish({}));
      return;

    case "echo":
      target("Choose a piece to send back 3 turns", echoTargets(caster), (t) => finish({ target: t }));
      return;

    case "chokepoint": {
      // The engine picks the square; naming it up front is the difference
      // between a considered 4 FP and a coin flip.
      const at = chokepointTarget(caster);
      confirmFirst(`${S.text}<br><br>The engine has found <b>${sq(at)}</b>.`, () => finish({}));
      return;
    }

    case "twin":
      target("Choose a pawn to stand on two squares at once", twinTargets(caster), (from) => {
        target("Choose its second square — both are real, and both move every turn",
          quantumSpots(from), (spot) => finish({ target: from, spot }));
      });
      return;

    case "quantum":
      target("Choose a pawn that has never stood beside an enemy", quantumTargets(caster), (from) => {
        target("Choose the second square it will also stand on",
          quantumSpots(from), (spot) => finish({ target: from, spot }));
      });
      return;

    case "hollow":
      target("Choose a pawn to close a shell over — it is the square it comes back to, and your opponent will not be told which",
        hollowTargets(caster), (t) => finish({ target: t }));
      return;

    case "pressure":
      confirmFirst(`${S.text}<br><br>Your own next turn is timed too — this is a card you have to be ready for.`,
        () => finish({}));
      return;

    case "stutter":
      // No target: it is aimed at a turn, not at a square. The real price is
      // worth naming out loud, because 4 FP on the card and 3 more in strain
      // is most of a full pool.
      confirmFirst(`${S.text}<br><br>Costs <b>${S.cost} FP</b> now and <b>3 more</b> in strain — ${
        Math.max(0, G.players[caster].fp - S.cost - 3)} FP would be left.`, () => finish({}));
      return;
  }
}

function promptOwedDiscard() {
  const od = G.owedDiscard;
  if (!od) { render(); return; }
  const P = G.players[od.player];
  if (!P.hand.length) { render(); return; }
  const uniq = [...new Set(P.hand)];
  showModal({
    title: "Discard a Spell Card",
    sub: `${od.why} — ${PLAYERS[od.player].name} must discard ${od.n} card.`,
    items: uniq.map((id) => ({
      label: `${SPELLS[id].name} (${SPELLS[id].cost} FP)`,
      desc: SPELLS[id].text,
      onClick: () => {
        if (!act({ t: "discard", id }, od.player)) return;
        if (!NET.on && G.owedDiscard) promptOwedDiscard();
      },
    })),
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   HOT-SEAT SHELL
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The curtain is one of the two things in the game that waits for an animation.
 * It has to: it is a full-screen sheet, and dropping it the instant a turn ends
 * would land on top of the capture that ended it. FX.then fires immediately
 * when nothing is playing, so this costs a hot-seat game nothing when effects
 * are off.
 */
function raiseCurtain() {
  if (G.over) return;
  FX.then(() => {
    if (G.over) return;               // a watchdog-length wait can outlive the game
    UI.revealed = false;
    clearSelection();
    UI.targeting = null;
    $("curtainWho").textContent = PLAYERS[G.turn].name;
    $("curtainWho").style.color = PLAYERS[G.turn].color;
    const P = G.players[G.turn];
    $("curtainSub").textContent =
      `${P.fp} FP · ${P.hand.length} card${P.hand.length === 1 ? "" : "s"} · turn ${G.turnNo}`;
    $("curtain").hidden = false;
    render();
  });
}

/** The other one. Same reason: a win sheet must not cover the winning blow. */
function announceWinner() {
  if (!G.over) return;
  FX.then(() => announceWinnerNow());
}

function announceWinnerNow() {
  if (!G.over) return;
  const w = G.over.winner;
  showModal({
    // An exhibition is a match between two brains, so the result is about them
    // and not about the colours they happened to be sitting behind.
    title: isDuel() ? `${PLAYERS[w].name} wins — ${aiNameFor(w)} beats ${aiNameFor(1 - w)}`
                    : `${PLAYERS[w].name} wins`,
    sub: G.over.reason + ".",
    buttons: [{ label: "New Game", cls: "go", onClick: startNewGame }, { label: "Review the board", onClick: () => render() }],
  });
}

function applyUndo(target) {
  aiCancel();
  applyUndoTo(target);
  clearSelection();
  render();
}

function requestUndo() {
  if (G.over) { toast("The game is over.", "bad"); return; }
  // Undo rewinds a turn on behalf of whoever took it. In an exhibition that is
  // never the person asking, so there is nothing here to give back.
  if (isDuel()) { toast("You are watching — neither turn is yours to take back.", "bad"); return; }
  if (AI.thinking) { toast("Wait for the machine to finish its move.", "bad"); return; }

  if (NET.on) {
    // The rewind itself happens on the server, once the opponent agrees.
    const target = G.history[G.hasActed || G.castThisTurn > 0 || G.drewThisTurn
      ? G.history.length - 1 : G.history.length - 2];
    if (!target) { toast("Nothing to undo yet.", "bad"); return; }
    netSocket().emit("undoRequest");
    toast("Undo requested — waiting for your opponent.", "");
    return;
  }

  if (AI.on) {
    // Vs the machine there is nobody to ask. Rewind to the start of your own
    // most recent turn, undoing the machine's reply along with your move.
    for (let k = G.history.length - 1; k >= 0; k--) {
      const h = G.history[k];
      if (h.turn !== AI.side && (h.turnNo < G.turnNo || G.hasActed || G.castThisTurn > 0 || G.drewThisTurn)) {
        applyUndo(h);
        return;
      }
    }
    toast("Nothing to undo yet.", "bad");
    return;
  }

  const target = G.hasActed || G.castThisTurn > 0 || G.drewThisTurn
    ? G.history[G.history.length - 1]
    : G.history[G.history.length - 2];
  if (!target) { toast("Nothing to undo yet.", "bad"); return; }

  const asker = G.turn, foe = 1 - asker;
  showModal({
    title: "Undo requested",
    sub: `<b>${PLAYERS[asker].name}</b> wants to rewind to the start of ${PLAYERS[target.turn].name}'s turn ${target.turnNo}.<br><br>
          Hand the device to <b>${PLAYERS[foe].name}</b> — this needs their consent.`,
    buttons: [
      {
        label: `${PLAYERS[foe].name}: allow it`, cls: "go", onClick: () => {
          applyUndo(target);
          raiseCurtain();
        }
      },
      { label: `${PLAYERS[foe].name}: refuse`, cls: "no", onClick: () => { toast("Undo refused.", "bad"); render(); } },
    ],
  });
}

function resign() {
  if (G.over) return;
  // The same argument as the undo above: neither side is yours to concede. The
  // button's honest meaning while watching is "I have seen enough", so it says
  // that — and holds the exhibition still while the sheet is up, rather than
  // letting two more turns go by behind it.
  if (isDuel()) {
    const wasPaused = AI.paused;
    duelPause();
    showModal({
      title: "Stop watching?",
      sub: "Neither of these players is yours to resign for. This abandons the exhibition and goes back to the menu.",
      buttons: [
        { label: "Yes, back to the menu", cls: "no", onClick: startNewGame },
        { label: "Keep watching", onClick: () => { if (wasPaused) render(); else duelResume(); } },
      ],
    });
    return;
  }
  const who = NET.on ? NET.seat : G.turn;
  showModal({
    title: "Resign?",
    sub: `${PLAYERS[who].name} concedes the game to ${PLAYERS[1 - who].name}.`,
    buttons: [
      {
        label: "Yes, resign", cls: "no", onClick: () => {
          aiCancel();
          act({ t: "resign" }, who);
        }
      },
      { label: "Keep playing", onClick: () => render() },
    ],
  });
}

function startNewGame() {
  // An exhibition left running behind the menu would keep thinking, keep
  // animating and keep burning a search's worth of CPU per turn. Every route to
  // this screen — the topbar, the actions panel, the win sheet — comes through
  // here, so stopping it here covers all of them.
  if (isDuel()) duelPause();
  showModal({
    tag: "mainMenu",                  // the one screen the Space knock listens on
    title: "Checkers Arcane Warfare",
    sub: "12×12 · 24 pieces each.",
    items: [
      {
        label: "Play online", cls: "gold",
        desc: "Two devices, one referee.",
        onClick: openOnlineMenu,
      },
      {
        label: "2 players — one device", cls: "gold",
        onClick: pickFirstPlayer,
      },
      {
        label: "Play the machine", cls: "violet",
        desc: "A searching opponent. It reads only what you can see — board, Focus Points, and how many cards you hold.",
        onClick: pickDifficulty,
      },
      {
        label: "Watch two machines", cls: "violet",
        desc: "Give each side a brain — the same one twice for an even match — and watch. You referee nothing, and both hands are face up to you.",
        onClick: pickDuel,
      },
    ],
  });
}

function pickFirstPlayer() {
  showModal({
    title: "Who opens?",
    sub: "By the rulebook, <b>the older player takes the first turn.</b>",
    items: [
      { label: "Gold moves first", cls: "gold", desc: "Gold starts on the bottom four rows and advances upward.", onClick: () => boot(0) },
      { label: "Violet moves first", cls: "violet", desc: "Violet starts on the top four rows and advances downward.", onClick: () => boot(1) },
    ],
    buttons: [{ label: "Back", onClick: startNewGame }],
  });
}

function pickDifficulty() {
  showModal({
    title: "How hard should it play?",
    sub: "Higher levels search deeper and use the whole spell book.",
    items: [
      { label: "Novice", desc: "Looks about 3 moves ahead. A gentle way to learn the rules.", onClick: () => pickSide("novice") },
      { label: "Skilled", desc: "Looks about 4 moves ahead and prices every spell and transformation before casting one. Moves in well under a second.", onClick: () => pickSide("skilled") },
      { label: "Ruthless", desc: "Thinks for up to three seconds a move, searching as deep as that allows, weighs its whole hand just as hard, and never blunders. Expect to lose for a while.", onClick: () => pickSide("ruthless") },
    ],
    buttons: [{ label: "Back", onClick: startNewGame }],
  });
}

function pickSide(level) {
  showModal({
    title: "Which side do you want?",
    sub: `You are playing <b>${AI_LEVELS[level].name}</b>. Gold always opens.`,
    items: [
      { label: "I'll take Gold", cls: "gold", desc: "You move first, from the bottom four rows.", onClick: () => boot(0, { ai: true, aiSide: 1, level }) },
      { label: "I'll take Violet", cls: "violet", desc: "The machine opens as Gold; you answer from the top.", onClick: () => boot(0, { ai: true, aiSide: 0, level }) },
    ],
    buttons: [{ label: "Back", onClick: pickDifficulty }],
  });
}

/* ── the exhibition ─────────────────────────────────────────────────────────
   The three mirrors come first and the uneven match is tucked behind a fourth
   item, because "the same difficulty on both sides" is what an exhibition is
   usually for: a fair fight is the one that tells you something about the
   machine. An uneven one mostly tells you which level you picked.
   ─────────────────────────────────────────────────────────────────────────── */

/** One line per level, written for someone watching rather than playing. */
const DUEL_BLURB = {
  novice:   "Three moves ahead, the obvious spells only, and the occasional deliberate blunder.",
  skilled:  "Four moves ahead, and it prices every card in its hand before casting one.",
  ruthless: "Up to three seconds a move, the whole spell book, and no deliberate mistakes.",
};

function pickDuel() {
  showModal({
    title: "Which two machines?",
    sub: "Both chairs are played by the machine. Nothing here is yours to move — but every hand is face up to you, which is not true in any game you are actually in.",
    items: [
      {
        label: "Novice vs Novice",
        desc: "Loose, quick and full of mistakes. The fastest game to watch, and the easiest to follow.",
        onClick: () => bootDuel("novice", "novice"),
      },
      {
        label: "Skilled vs Skilled",
        desc: "The even match. A move lands about every second, and both sides use the whole spell book.",
        onClick: () => bootDuel("skilled", "skilled"),
      },
      {
        label: "Ruthless vs Ruthless",
        desc: "The best game the machine has in it — and the slowest. It thinks for up to three seconds a move, on both sides of the board.",
        onClick: () => bootDuel("ruthless", "ruthless"),
      },
      {
        label: "Uneven match…",
        desc: "Give each side a different brain, and watch how far the gap between two levels actually goes.",
        onClick: pickDuelGold,
      },
    ],
    buttons: [{ label: "Back", onClick: startNewGame }],
  });
}

/** Level items for one seat of an uneven match. */
const duelLevelItems = (cls, onPick) =>
  AI_ORDER.map((lvl) => ({
    label: AI_LEVELS[lvl].name, cls, desc: DUEL_BLURB[lvl], onClick: () => onPick(lvl),
  }));

function pickDuelGold() {
  showModal({
    title: "Who plays Gold?",
    sub: "Gold opens, from the bottom four rows.",
    items: duelLevelItems("gold", (gold) => pickDuelViolet(gold)),
    buttons: [{ label: "Back", onClick: pickDuel }],
  });
}

function pickDuelViolet(gold) {
  showModal({
    title: "And who answers as Violet?",
    sub: `Gold is <b>${AI_LEVELS[gold].name}</b>. Violet plays from the top four rows.`,
    items: duelLevelItems("violet", (violet) => bootDuel(gold, violet)),
    buttons: [{ label: "Back", onClick: pickDuelGold }],
  });
}

/** Gold always opens an exhibition — there is nobody to offer the choice to. */
const bootDuel = (gold, violet) => boot(0, { duel: [gold, violet] });

function boot(first, opts = {}) {
  aiCancel();                       // kill any beat still pending from a prior game
  netLeave();                       // and drop any online game still attached
  FX.reset();                       // and anything still in the air from it
  // Against the machine concealment works — the machine is genuinely blinded.
  // Hot-seat it does not, because both hands share one screen, so "local"
  // keeps those cards out of the pool entirely. See MODE in engine.js. An
  // exhibition is "ai" for the same reason a single machine is, twice over:
  // neither side can read the other's hand, so the cards that hide one are
  // worth playing — and watching one machine bluff another is most of the
  // point of the mode.
  const duel = opts.duel || null;
  G = newGame(first, null, { dev: !!opts.dev, mode: (opts.ai || duel) ? "ai" : "local" });
  UI = freshUI();
  AI.duel = duel;
  AI.paused = false;
  AI.on = !!(opts.ai || duel);
  // In an exhibition these two are not settings but a cursor: they name the
  // chair being thought about, and aiTakeSeat moves them each turn. Seeding
  // them with the opening seat keeps the first render honest.
  AI.side = duel ? first : opts.aiSide != null ? opts.aiSide : 1;
  AI.level = duel ? duel[first] : opts.level || "skilled";
  AI.thinking = false;
  AI.fast = false;
  // Assigned on every boot, not only on a duel, so the sped-up animations of
  // an exhibition cannot follow you into the next real game.
  watchApply();
  G.turnNo = 0;
  if (G.dev) {
    log("Dev sandbox. Act as often as you like, hold every card, transform for free, and never run out of Focus.", "big");
    log("End Turn hands you the other side. Nothing here is a real game — start a new one from the menu when you are done.", "sys");
  } else {
    log("A new game begins. Pieces hold the dark squares; the four centre rows are the separation space.", "sys");
  }
  if (duel) {
    log(`An exhibition: ${PLAYERS[0].name} is played by ${AI_LEVELS[duel[0]].name}, ${PLAYERS[1].name} by ${AI_LEVELS[duel[1]].name}.`, "sys");
    log("Both hands are open to you, and so is the whole referee log — neither machine can read this screen, and you are not in the game.", "sys");
  } else if (AI.on)
    log(`You face the machine — ${AI_LEVELS[AI.level].name}, playing ${PLAYERS[AI.side].name}.`, "sys");
  beginTurn(first);
  render();
  afterHandoff(false);
}

/**
 * The sandbox. Deliberately not on the menu: it is a workbench, and finding it
 * by accident mid-game would be baffling. Space three times on the title screen.
 */
function bootDev() {
  boot(0, { dev: true });
  toast("Dev sandbox — no costs, no limits, both sides yours.", "good");
}

/**
 * The seat whose hand the interface should show. Online it is your seat and
 * nothing else — the other hand never even reaches this machine. Vs the
 * machine, always yours. Hot-seat, whoever is holding the device.
 *
 * Watching two machines there is no such seat, because nobody at this device
 * holds a hand at all. It answers "the side on move" so that everything reading
 * it has a defensible seat to work from — but the things that would REDACT on
 * the strength of it check spectating() first and redact nothing. See below.
 */
const viewSeat = () => (NET.on ? NET.seat : isDuel() ? G.turn : AI.on ? 1 - AI.side : G.turn);

/**
 * Is this device watching rather than playing?
 *
 * Concealment exists to keep one PLAYER from reading another's secrets. Both
 * halves of that are absent here: the two machines genuinely cannot read each
 * other (they never touch the hand contents or the marker fields — see the
 * invariants at the top of ai.js), and the person watching is not in the game,
 * so there is nothing they could do with what they learn. Redacting a hollow
 * shell from a spectator hides it from the only pair of eyes in the room and
 * from nobody else, which is the same argument the sandbox already won.
 *
 * So a spectator sees everything, and every redaction in the interface is
 * spelled `G.dev || spectating() || ...`.
 */
const spectating = () => isDuel();

/* ══════════════════════════════════════════════════════════════════════════
   ONLINE

   The client is a thin one. It never applies its own moves: it sends an action
   and waits for the server's version of the board to come back. That round trip
   is imperceptible in a turn-based game, and it is the whole reason editing G
   in a console achieves nothing — the copy in this tab is a rendering, not the
   game.

   G still arrives here as a real game state, so every query the interface
   already uses (legalMovesFor for the move dots, spellBlocker for greying out
   cards) keeps working. What it is missing is exactly what you are not entitled
   to know: the opponent's hand and the snapshots behind Chronos's Gaze. See
   viewFor() in engine.js.
   ══════════════════════════════════════════════════════════════════════════ */

const SESSION_KEY = "caw.session";

/**
 * Take the server's word for how long is left, and redraw locally until the
 * next state arrives.
 *
 * The interval only repaints; it never decides anything. Every turn the clock
 * actually decides is decided on the server, which is the only place that can
 * be trusted with it — a client whose tab was throttled, or whose own clock
 * runs fast, must not be able to forfeit somebody's turn.
 */
function netSetClock(ms, seat) {
  NET.clockMs = typeof ms === "number" ? ms : null;
  NET.clockSeat = typeof seat === "number" ? seat : null;
  NET.clockAt = performance.now();
  if (NET.clockTick) { clearInterval(NET.clockTick); NET.clockTick = null; }
  if (NET.clockMs != null) NET.clockTick = setInterval(renderTopbar, 250);
}

/** Seconds left on the clock as this device sees it, or null. */
function netClockLeft() {
  if (NET.clockMs == null) return null;
  return Math.max(0, Math.ceil((NET.clockMs - (performance.now() - NET.clockAt)) / 1000));
}

function netSocket() { return NET.socket; }
function netSend(action) {
  if (!NET.socket) return;
  clearSelection();
  UI.targeting = null;
  NET.socket.emit("action", action);
}

/** Socket.IO ships from the server, so it is only fetched once you go online —
 *  opening index.html straight off the disk stays a working offline game. */
function loadSocketIO() {
  if (window.io) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/socket.io/socket.io.js";
    s.onload = () => (window.io ? resolve() : reject(new Error("socket.io failed to initialise")));
    s.onerror = () => reject(new Error("Could not reach the game server"));
    document.head.appendChild(s);
  });
}

function netLeave() {
  if (NET.socket) { try { NET.socket.emit("leave"); NET.socket.disconnect(); } catch (e) {} }
  NET.on = false; NET.socket = null; NET.room = null; NET.oppConnected = false;
  netSetClock(null, null);          // and stop the countdown redrawing forever
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}

function netToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (saved && saved.token) return saved.token;
  } catch (e) {}
  return (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
}

function netRemember() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ room: NET.room, token: NET.token }));
  } catch (e) {}
}

/** Wire up the handlers that run for the life of a connection. */
function netAttach(socket) {
  NET.socket = socket;

  socket.on("state", (view) => {
    const hadTargeting = !!(UI && UI.targeting);
    NET.oppConnected = !!view.oppConnected;
    netSetClock(view.clockMs, view.clockSeat);
    G = view;
    if (!UI) UI = freshUI();
    UI.revealed = true;
    clearSelection();
    if (hadTargeting) { UI.targeting = null; toast("Your opponent acted — targeting cancelled.", ""); }
    afterAction();
  });

  socket.on("presence", ({ oppConnected, clockMs, clockSeat }) => {
    const was = NET.oppConnected;
    NET.oppConnected = !!oppConnected;
    netSetClock(clockMs, clockSeat);
    if (was !== NET.oppConnected)
      toast(NET.oppConnected ? "Your opponent is here." : "Your opponent dropped — waiting for them.",
        NET.oppConnected ? "good" : "bad");
    // The host is sitting behind the share-the-code sheet; take it away the
    // moment there is somebody to play against.
    if (NET.oppConnected && UI.waitingRoom) { UI.waitingRoom = false; closeModal(); }
    render();
  });

  socket.on("rejected", ({ err }) => toast(err, "bad"));
  socket.on("info", ({ text, kind }) => toast(text, kind || ""));

  socket.on("undoOffer", ({ turn, turnNo }) => {
    showModal({
      title: "Your opponent asks for an undo",
      sub: `<b>${PLAYERS[1 - NET.seat].name}</b> wants to rewind to the start of ${PLAYERS[turn].name}'s turn ${turnNo}.<br><br>This needs your consent.`,
      buttons: [
        { label: "Allow it", cls: "go", onClick: () => socket.emit("undoRespond", { accept: true }) },
        { label: "Refuse", cls: "no", onClick: () => socket.emit("undoRespond", { accept: false }) },
      ],
    });
  });
  socket.on("undoResult", ({ accepted }) =>
    toast(accepted ? "Undo granted." : "Your opponent refused the undo.", accepted ? "good" : "bad"));

  socket.on("roomClosed", ({ reason }) => {
    netLeave();
    showModal({
      title: "The game ended",
      sub: reason,
      buttons: [{ label: "New Game", cls: "go", onClick: startNewGame }],
    });
  });

  socket.on("disconnect", () => { NET.oppConnected = false; toast("Connection lost — reconnecting…", "bad"); render(); });
  socket.on("connect", () => {
    // Socket.IO reconnected us on a fresh socket id; reclaim the seat.
    if (NET.room) socket.emit("hello", { room: NET.room, token: NET.token }, (res) => {
      if (!res || !res.ok) { netLeave(); toast("Your game is no longer on the server.", "bad"); startNewGame(); }
    });
  });
}

/** Join or create; `req` is {t:"create"} or {t:"join", room}. */
async function netStart(req) {
  toast("Contacting the server…", "");
  try {
    await loadSocketIO();
  } catch (e) {
    showModal({
      title: "No server to talk to",
      sub: "This page was opened straight from disk, or the server is asleep. Online play needs the app served by its Node server — the offline modes still work.",
      buttons: [{ label: "Back", onClick: startNewGame }],
    });
    return;
  }

  aiCancel();
  AI.on = false;
  NET.token = netToken();

  const socket = NET.socket || window.io({ transports: ["websocket", "polling"] });
  if (!NET.socket) netAttach(socket);

  socket.emit(req.t, { room: req.room, token: NET.token }, (res) => {
    if (!res || !res.ok) {
      showModal({
        title: "Could not join",
        sub: (res && res.err) || "The server said no.",
        buttons: [{ label: "Back", onClick: openOnlineMenu }],
      });
      return;
    }
    NET.on = true;
    NET.seat = res.seat;
    NET.room = res.room;
    NET.oppConnected = !!res.oppConnected;
    netRemember();
    // A different game's transcript, with its own counter. Start listening from
    // the state we are handed rather than replaying whatever it happens to
    // carry — joining a room mid-game is not a reason to watch the last move.
    FX.reset();
    if (res.state && res.state.fx && res.state.fx.length)
      FX.seen = res.state.fx[res.state.fx.length - 1].n;
    UI = freshUI();
    UI.revealed = true;
    if (res.state) G = res.state;
    render();
    if (!NET.oppConnected) showWaitingRoom();
  });
}

function showWaitingRoom() {
  const url = `${location.origin}${location.pathname}?room=${NET.room}`;
  UI.waitingRoom = true;
  showModal({
    title: `Room ${NET.room}`,
    sub: `You are <b style="color:${PLAYERS[NET.seat].color}">${PLAYERS[NET.seat].name}</b>. Send your opponent this link, or just the code.
          <div class="netcode">${NET.room}</div>
          <div class="netlink">${url}</div>`,
    buttons: [
      { label: "Copy the link", cls: "go", onClick: () => {
          navigator.clipboard?.writeText(url).then(
            () => toast("Link copied.", "good"),
            () => toast("Copy failed — select the link by hand.", "bad"));
          showWaitingRoom();
        } },
      { label: "Wait here", onClick: () => { UI.waitingRoom = false; render(); } },
    ],
  });
}

function openOnlineMenu() {
  showModal({
    title: "Play online",
    sub: "One of you hosts and shares a four-letter code; the other joins with it. The server keeps the real board and checks every move against the rulebook.",
    items: [
      { label: "Host a game", cls: "gold", desc: "You take Gold and move first. You get a code and a link to send.", onClick: () => netStart({ t: "create" }) },
      { label: "Join with a code", cls: "violet", desc: "You take Violet. Type the four letters your opponent sent you.", onClick: promptRoomCode },
    ],
    buttons: [{ label: "Back", onClick: startNewGame }],
  });
}

function promptRoomCode(prefill = "") {
  showModal({
    title: "Join a game",
    sub: `Enter the code your opponent sent you.
          <input id="joinCode" class="netinput" maxlength="4" autocomplete="off"
                 spellcheck="false" placeholder="ABCD" value="${prefill}">`,
    buttons: [
      { label: "Join", cls: "go", onClick: () => {
          const code = ($("joinCode").value || "").trim().toUpperCase();
          if (code.length !== 4) { toast("A room code is four letters.", "bad"); promptRoomCode(code); return; }
          netStart({ t: "join", room: code });
        } },
      { label: "Back", onClick: openOnlineMenu },
    ],
  });
  const box = $("joinCode");
  if (box) { box.focus(); box.addEventListener("keydown", (e) => { if (e.key === "Enter") $("mRow").firstChild.click(); }); }
}

/**
 * Decide what to show on load: a shared ?room= link, a game this browser was in
 * before a refresh, or the ordinary menu.
 */
function netBootstrap() {
  const code = (new URLSearchParams(location.search).get("room") || "").trim().toUpperCase();
  if (code.length === 4) { netStart({ t: "join", room: code }); return; }

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) {}
  if (!saved || !saved.room) { startNewGame(); return; }

  // Try to walk back into the game silently; fall through to the menu if the
  // server has forgotten it (a free-tier restart will do that).
  loadSocketIO().then(() => {
    const socket = window.io({ transports: ["websocket", "polling"] });
    NET.token = saved.token;
    NET.room = saved.room;
    netAttach(socket);
    socket.emit("hello", { room: saved.room, token: saved.token }, (res) => {
      if (!res || !res.ok) { netLeave(); startNewGame(); return; }
      NET.on = true;
      NET.seat = res.seat;
      NET.oppConnected = !!res.oppConnected;
      UI = freshUI();
      UI.revealed = true;
      if (res.state) G = res.state;
      render();
      toast("Welcome back — your game is still here.", "good");
    });
  }).catch(() => startNewGame());
}

/* ══════════════════════════════════════════════════════════════════════════
   RULES REFERENCE
   ══════════════════════════════════════════════════════════════════════════ */

const RULE_TABS = ["Basics", "Focus Points", "Spells"];
let ruleTab = "Basics";

function renderRules() {
  const tabs = $("ruleTabs"); tabs.innerHTML = "";
  for (const t of RULE_TABS) {
    const b = el("button", "tab" + (t === ruleTab ? " on" : ""), t);
    b.addEventListener("click", () => { ruleTab = t; renderRules(); });
    tabs.appendChild(b);
  }
  const body = $("ruleBody"); body.innerHTML = "";
  const card = (h, ps, tag, kind) => {
    const c = el("div", "rulecard" + (kind ? " " + kind : ""));
    c.appendChild(el("h4", null, h));
    for (const p of ps) c.appendChild(el("p", null, p));
    if (tag) c.appendChild(el("div", "tag", tag));
    body.appendChild(c);
  };

  if (ruleTab === "Basics") {
    card("Winning", [
      "Capture all enemy pieces, blockade your opponent so they cannot act at all, or accept their resignation.",
      "A side left with nothing but pieces that can never move again — Alchemists — has lost on the spot. Terrain cannot win a war.",
    ]);
    card("Movement", [
      "Pawns step one square diagonally forward. Reaching the far row crowns them Queen.",
      "Queens move and capture one square diagonally in any direction.",
    ]);
    card("Capture", [
      "Jump an adjacent enemy piece into the empty square beyond it. Pawns capture forward only.",
      "Captures are mandatory. Moving a different piece instead forfeits one of the pieces that could have jumped — you choose which. Ending your turn without moving, or drawing a card, carries no penalty.",
      "Land a capture with another available and you must keep jumping. A promotion ends the sequence.",
    ]);
    card("The turn", [
      "Start — gain 1 FP every second turn, plus 1 for each of your Alchemists every turn.",
      "Spell Decision — you may draw a card. That ends your turn; the card is the payment.",
      "Declare Action — cast, move, or transform. Casting does not stop you moving afterward.",
      "End Phase — a last window to cast before your opponent begins.",
      "If nothing is left that you could legally do, the turn ends itself and passes over. You never have to click through a phase you cannot use.",
    ]);
  }
  if (ruleTab === "Focus Points") {
    card("Earning FP", [
      "+1 at the start of every second turn — the slow drip.",
      "+1 per capture · +2 for capturing a transformed piece · +1 for stripping armor.",
      "+2 for promoting a pawn · +1 per Alchemist each turn.",
      "Most of your Focus comes from fighting, not from waiting. A player who trades and pushes for the crown can afford roughly twice what a player who sits still can.",
    ]);
    card("The ceiling", [
      `Your pool stops at ${FP_CAP} FP. Anything earned while full is wasted, and the log says so.`,
      "Focus is spend-it-or-lose-it, not savings. A pool you never touch is income you threw away — and the Alchemist, which prints Focus you cannot bank, is a worse bargain than it looks.",
    ]);
    card("Spending FP", ["Transformations are cast like any other spell, for the same 3 FP most cards cost — except the Alchemist at 6 and the Phaser, which is free once its 3 FP spell is paid.", "Spell costs range from 2 to 6 FP."]);
  }
  if (ruleTab === "Spells") {
    card("Two kinds of card", [
      "Transformation spells reshape one of your own pieces for the rest of the game. They are the blue ones.",
      "Every other spell resolves once and is gone. Those are the violet ones.",
    ]);
    // Transformations first, so the two colours read as two blocks rather than
    // as a stripe that changes every other card.
    const byKind = SPELL_IDS.slice().sort((a, b) =>
      (spellKind(a) === "form" ? 0 : 1) - (spellKind(b) === "form" ? 0 : 1));
    // The real odds, not the printed ones: what a card is worth being dealt
    // depends on how many others are still eligible, and that shrinks as
    // scarce cards run out.
    const pool = (typeof G !== "undefined" && G) ? eligibleSpellIds() : SPELL_IDS;
    const total = pool.reduce((s, id) => s + SPELLS[id].weight, 0);
    for (const k of byKind) {
      const S = SPELLS[k];
      const odds = pool.includes(k) && total
        ? `1 in ${Math.round(total / S.weight)} draws`
        : "not in the pool";
      const scarcity = S.maxDraws
        ? ` · ${Math.max(0, S.maxDraws - (G?.drawCounts?.[k] || 0))} of ${S.maxDraws} left`
        : "";
      card(`${S.name} — ${S.cost} FP`,
        [...(S.flavor ? [S.flavor] : []), S.text, "Penalty: " + S.penalty],
        `${S.rarity} · ${odds}${scarcity} · ${S.timing}`,
        spellKind(k));
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   WIRING
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   KEYBOARD

   The two actions worth reaching for without the mouse: ending a turn, and
   drawing a card. One table, read from both ends — renderActions() takes `cap`
   to print the keycap on the button, and onActionKey() takes `match` to find
   the button again.

   Nothing here re-decides whether an action is legal. It finds the button and
   clicks it, so a key can never do something the button would have refused.
   ══════════════════════════════════════════════════════════════════════════ */

const ACTION_KEYS = [
  // "Spacebar" is the old Edge/IE name for the same key; harmless to accept.
  { action: "endTurn", cap: "Space", match: (k) => k === " " || k === "Spacebar" },
  { action: "draw",    cap: "1",     match: (k) => k === "1" },
];

function onActionKey(ev) {
  if (ev.defaultPrevented || ev.repeat) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;   // leave browser shortcuts alone

  // Never take a key away from something being typed into — the room-code box
  // is a text field — or from a control that already handles it: Space on a
  // focused button is a click, and handling it here too would fire twice.
  const t = ev.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName))) return;

  const hit = ACTION_KEYS.find((k) => k.match(ev.key));
  if (!hit || !G || !UI) return;

  // Anything covering the board owns the keyboard. Returning without
  // preventDefault leaves Space free to scroll a long modal, which is what a
  // player pressing it there actually meant.
  if (UI.modalOpen || !UI.revealed) return;
  if (!$("modal").hidden || !$("curtain").hidden || !$("rules").hidden) return;

  ev.preventDefault();                                  // Space must not scroll the board away
  if (FX.lock > 0) return;                              // a game-altering spell is resolving
  const btn = $("actions").querySelector(`[data-key="${hit.action}"]`);
  if (btn && !btn.disabled) btn.click();
}

/* ── the knock ──────────────────────────────────────────────────────────────
   Space three times on the title screen opens the dev sandbox. It needs its own
   listener because onActionKey above deliberately stands down whenever a modal
   is up — on the title screen there is no board to end a turn on, and Space
   there belongs to whoever is scrolling a long sheet.

   The window is what keeps it from being an accident: three presses inside a
   second and a half each, on the main menu and nowhere else. Wandering off the
   screen forgets the count (see closeModal).
   ─────────────────────────────────────────────────────────────────────────── */

const DEV_KNOCK_MS = 1500;
let devKnock = { n: 0, at: 0 };

function onDevKnock(ev) {
  if (ev.defaultPrevented || ev.repeat) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key !== " " && ev.key !== "Spacebar") return;
  if (!UI || UI.modalTag !== "mainMenu" || $("modal").hidden) return;
  // A menu button that has been tabbed to already treats Space as a click, and
  // taking the key here as well would both fire the button and count the knock.
  const t = ev.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName))) return;

  ev.preventDefault();
  const now = performance.now();
  devKnock.n = now - devKnock.at > DEV_KNOCK_MS ? 1 : devKnock.n + 1;
  devKnock.at = now;

  if (devKnock.n === 2) toast("…", "");                 // enough of a nudge to be findable
  if (devKnock.n >= 3) { devKnock.n = 0; closeModal(); bootDev(); }
}

/** The FX button carries its own state, since it cycles three ways. */
function renderFxButton() {
  const b = $("btnFx");
  b.textContent = FX.mode === "full" ? "FX" : FX.mode === "reduced" ? "FX ·" : "FX ✕";
  b.title = FX.mode === "full" ? "Animations: full — click for reduced"
    : FX.mode === "reduced" ? "Animations: reduced — click to turn off"
    : "Animations: off — click for full";
  b.style.color = FX.mode === "off" ? "var(--ink-faint)" : "";
}

function wire() {
  window.addEventListener("keydown", onActionKey);
  window.addEventListener("keydown", onDevKnock);
  $("curtainGo").addEventListener("click", () => {
    UI.revealed = true;
    $("curtain").hidden = true;
    render();
  });
  $("logToggle").addEventListener("click", () => { UI.logOpen = !UI.logOpen; renderLog(); });
  $("btnFx").addEventListener("click", () => {
    const order = ["full", "reduced", "off"];
    FX.setMode(order[(order.indexOf(FX.mode) + 1) % order.length]);
    renderFxButton();
    toast(`Animations: ${FX.mode}.`, "");
  });
  renderFxButton();
  $("btnRules").addEventListener("click", () => { renderRules(); $("rules").hidden = false; });
  $("rulesClose").addEventListener("click", () => { $("rules").hidden = true; });
  $("btnUndo").addEventListener("click", requestUndo);
  $("btnResign").addEventListener("click", resign);
  $("btnNew").addEventListener("click", startNewGame);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("rules").hidden) { $("rules").hidden = true; return; }
      if (UI && UI.targeting) { UI.targeting = null; render(); return; }
      if (UI && UI.sel != null) { clearSelection(); render(); }
    }
  });
}

/* The machine lives in ai.js now, loaded above this script. It reads G, UI and
   the interface functions out of the scope every classic script on this page
   shares, so nothing had to be passed to it — see the note at the top of that
   file for what it expects to find here. */
