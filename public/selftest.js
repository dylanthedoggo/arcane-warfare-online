"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   ARCANE WARFARE — the in-browser self-test.  Open index.html?test=1

   Loaded after app.js, whose scope it shares. main.js calls runTests().
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   SELF-TEST SUITE   —   open index.html?test=1

   These assert the rules engine directly. They never touch the DOM, so a
   failure here points at a rule, not at the interface.
   ══════════════════════════════════════════════════════════════════════════ */

function runTests() {
  const out = el("div");
  out.id = "testout";
  document.body.appendChild(out);
  out.appendChild(el("h1", null, "Checkers Arcane Warfare — rules engine self-test"));

  let pass = 0, fail = 0;
  const group = (t) => out.appendChild(el("div", "grp", t));
  const ok = (name, cond, detail) => {
    const line = el("div", cond ? "ok" : "fail",
      `${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : "  →  " + detail}`);
    out.appendChild(line);
    cond ? pass++ : fail++;
  };

  // Silence the interface so the engine can be driven headlessly.
  render = () => {}; raiseCurtain = () => {}; toast = () => {}; announceWinner = () => {};

  // `opts` reaches newGame, which is how a test asks for a mode other than
  // hot-seat — the concealment cards are undrawable in "local" and several
  // groups below need a game that can actually hold one.
  const blank = (first = 0, opts = {}) => {
    G = newGame(first, 42, opts);
    UI = freshUI();
    G.board = new Array(CELLS).fill(null);
    return G;
  };
  const countHollow = (owner) => G.board.filter((p) => p && p.owner === owner && p.hollow).length;
  const put = (i, owner, rank = "pawn", extra = {}) => {
    const p = mkPiece(owner, rank);
    Object.assign(p, extra);
    G.board[i] = p;
    return p;
  };

  /* ── setup ─────────────────────────────────────────────────────────── */
  group("Starting position");
  G = newGame(0, 42); UI = freshUI();
  ok("Gold has 24 pieces", countPieces(0) === 24, countPieces(0));
  ok("Violet has 24 pieces", countPieces(1) === 24, countPieces(1));
  ok("every piece stands on a dark square",
    G.board.every((p, i) => !p || isDark(i)));
  ok("the four centre rows are empty",
    [4, 5, 6, 7].every((r) => Array.from({ length: N }, (_, c) => G.board[rc(r, c)]).every((p) => !p)));
  ok("Gold occupies rows 8-11", [8, 9, 10, 11].every((r) =>
    Array.from({ length: N }, (_, c) => G.board[rc(r, c)]).filter(Boolean).every((p) => p.owner === 0)));
  ok("Violet occupies rows 0-3", [0, 1, 2, 3].every((r) =>
    Array.from({ length: N }, (_, c) => G.board[rc(r, c)]).filter(Boolean).every((p) => p.owner === 1)));
  ok("exactly 6 dark squares per row",
    Array.from({ length: N }, (_, r) =>
      Array.from({ length: N }, (_, c) => isDark(rc(r, c))).filter(Boolean).length).every((n) => n === 6));

  /* ── movement ──────────────────────────────────────────────────────── */
  group("Movement");
  blank();
  put(rc(6, 5), 0);
  let mv = simpleMoves(rc(6, 5));
  ok("a pawn has 2 forward steps mid-board", mv.length === 2, mv.length);
  ok("Gold advances toward row 0", mv.every((m) => rowOf(m.to) === 5));

  blank();
  put(rc(6, 5), 1);
  ok("Violet advances toward row 11", simpleMoves(rc(6, 5)).every((m) => rowOf(m.to) === 7));

  blank();
  put(rc(6, 5), 0, "queen");
  ok("a queen moves in all 4 diagonal directions", simpleMoves(rc(6, 5)).length === 4);

  /* ── capture ───────────────────────────────────────────────────────── */
  group("Capture and chain-jumping");
  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1);
  let caps = captureMoves(rc(7, 4));
  ok("a jump is found over an adjacent enemy", caps.length === 1 && caps[0].to === rc(5, 6));
  ok("the capturer is listed as forced", capturersFor(0).length === 1);

  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(5, 6), 1);
  ok("a blocked landing square cancels the jump", captureMoves(rc(7, 4)).length === 0);

  blank();
  put(rc(6, 5), 0); put(rc(5, 4), 1);
  ok("a pawn cannot capture backward",
    captureMoves(rc(6, 5)).length === 1 && captureMoves(rc(6, 5))[0].to === rc(4, 3));
  blank();
  put(rc(6, 5), 0); put(rc(7, 4), 1);
  ok("a pawn ignores an enemy behind it", captureMoves(rc(6, 5)).length === 0);
  blank();
  put(rc(6, 5), 0, "queen"); put(rc(7, 4), 1);
  ok("a queen captures backward", captureMoves(rc(6, 5)).length === 1);

  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(4, 5), 1);
  performMove(rc(7, 4), captureMoves(rc(7, 4))[0]);
  ok("a second jump locks the piece into a chain", G.chain === rc(5, 6), G.chain);
  ok("only the chaining piece may act", legalMovesFor(rc(5, 6)).length === 1);
  performMove(rc(5, 6), captureMoves(rc(5, 6))[0]);
  ok("the chain resolves and the turn advances", G.chain === null && G.phase === "end");
  ok("both victims are gone", !G.board[rc(6, 5)] && !G.board[rc(4, 5)]);
  ok("two captures paid 2 FP", G.players[0].fp === 2, G.players[0].fp);

  /* ── promotion ─────────────────────────────────────────────────────── */
  group("Promotion");
  blank();
  put(rc(1, 2), 0);
  performMove(rc(1, 2), simpleMoves(rc(1, 2))[0]);
  ok("a Gold pawn reaching row 0 is crowned",
    G.board[rc(0, 1)] && G.board[rc(0, 1)].rank === "queen");
  ok("promotion pays 2 FP", G.players[0].fp === 2, G.players[0].fp);

  blank();
  put(rc(2, 3), 0); put(rc(1, 2), 1);
  performMove(rc(2, 3), captureMoves(rc(2, 3))[0]);
  ok("promoting by jump ends the sequence", G.chain === null && G.phase === "end");

  /* ── forced capture ────────────────────────────────────────────────── */
  group("The mandatory capture rule");
  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(9, 0), 0);
  ok("a skipped capture is detected", pendingSacrifice(0).length === 1);
  ok("the piece that must jump is identified", pendingSacrifice(0)[0] === rc(7, 4));
  blank();
  put(rc(7, 4), 0); put(rc(9, 0), 0);
  ok("no capture available means no penalty", pendingSacrifice(0).length === 0);

  /* ── Phaser ────────────────────────────────────────────────────────── */
  group("Phaser");
  blank();
  put(rc(5, 4), 0, "pawn", { form: "phaser", captures: 1 });
  const ph = simpleMoves(rc(5, 4)).filter((m) => m.kind === "phase");
  ok("the Phaser has 4 orthogonal options", ph.length === 4, ph.length);
  ok("every phase destination is a dark square", ph.every((m) => isDark(m.to)));
  ok("phase distance is exactly 2 squares", ph.every((m) =>
    Math.abs(rowOf(m.to) - 5) + Math.abs(colOf(m.to) - 4) === 2));
  put(rc(3, 4), 1);
  ok("the Phaser cannot land on an occupied square",
    !simpleMoves(rc(5, 4)).some((m) => m.to === rc(3, 4)));
  // The trap-escape case the ability exists for.
  blank();
  put(rc(5, 4), 0, "pawn", { form: "phaser", captures: 1 });
  for (const [dr, dc] of DIAG) put(rc(5 + dr, 4 + dc), 1);
  ok("a diagonally surrounded Phaser can still escape orthogonally",
    simpleMoves(rc(5, 4)).some((m) => m.kind === "phase"));

  /* ── Juggernaut ────────────────────────────────────────────────────── */
  group("Juggernaut");
  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1, "pawn", { armor: true });
  performMove(rc(7, 4), captureMoves(rc(7, 4))[0]);
  ok("armor absorbs the first capture", !!G.board[rc(6, 5)]);
  ok("the armor is stripped", G.board[rc(6, 5)].armor === false);
  ok("the attacker still lands beyond", !!G.board[rc(5, 6)]);
  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1, "pawn", { armor: false, form: "juggernaut" });
  performMove(rc(7, 4), captureMoves(rc(7, 4))[0]);
  ok("an unarmored Juggernaut dies to the next capture", !G.board[rc(6, 5)]);
  ok("capturing a transformed piece pays 2 FP", G.players[0].fp === 2, G.players[0].fp);

  /* ── Herald / Alchemist / Enchanter ────────────────────────────────── */
  group("Transformations");
  blank();
  put(rc(6, 5), 0, "queen", { form: "alchemist" });
  put(rc(9, 2), 0);                                  // an army that can still march…
  put(rc(1, 0), 1);                                  // …against one that exists
  ok("an Alchemist never moves", simpleMoves(rc(6, 5)).length === 0);
  G.players[0].fp = 0; G.turnNo = 0;
  beginTurn(0);
  ok("an Alchemist generates 1 FP on top of the turn income", G.players[0].fp === 2, G.players[0].fp);

  blank();
  put(rc(6, 5), 0, "queen", { form: "enchanter" });
  put(rc(1, 0), 1);
  const swaps = simpleMoves(rc(6, 5)).filter((m) => m.kind === "swap");
  ok("the Enchanter can swap with any piece on the board", swaps.length === 1 && swaps[0].to === rc(1, 0));
  performMove(rc(6, 5), swaps[0]);
  ok("the swap exchanges both squares",
    G.board[rc(1, 0)].form === "enchanter" && G.board[rc(6, 5)].owner === 1);

  blank();
  put(rc(5, 4), 0);
  put(rc(4, 3), 0, "pawn", { form: "herald" });
  ok("a pawn beside a friendly Herald qualifies for the bonus step", heraldAdjacent(rc(5, 4)));
  ok("the Herald's bonus step never captures",
    legalHeraldSteps(rc(5, 4)).every((m) => m.kind === "herald" && !G.board[m.to]));
  put(rc(4, 3), 1, "pawn", { form: "herald" });
  ok("an enemy Herald grants nothing", !heraldAdjacent(rc(5, 4)));

  blank();
  G.players[0].fp = 9;
  put(rc(2, 3), 0);            // on Violet's half — Herald is legal there
  ok("Herald requires the enemy half", transformBlocker(rc(2, 3), "herald") === null);
  put(rc(9, 2), 0);
  ok("Herald is refused on your own half", transformBlocker(rc(9, 2), "herald") !== null);
  applyTransform(rc(2, 3), "herald", {});
  put(rc(2, 5), 0);
  ok("only one Herald per player", transformBlocker(rc(2, 5), "herald") !== null);

  blank();
  G.players[0].fp = 9;
  put(rc(6, 5), 0, "pawn", { captures: 1 });
  ok("a captured-once pawn may become a Phaser", transformBlocker(rc(6, 5), "phaser") === null);
  put(rc(6, 7), 0, "pawn", { captures: 0 });
  ok("a pawn that never captured may not", transformBlocker(rc(6, 7), "phaser") !== null);
  applyTransform(rc(6, 5), "phaser", {});
  ok("a transformed piece refuses a second transformation",
    transformBlocker(rc(6, 5), "juggernaut") !== null);
  blank();
  G.players[0].fp = 9; G.players[1].fp = 9;
  put(rc(6, 5), 0, "pawn", { form: "phaser" });
  put(rc(6, 7), 1, "pawn", { form: "phaser" });
  put(rc(8, 1), 0, "pawn", { captures: 1 });
  ok("the Phaser cap of 2 counts across the whole board",
    transformBlocker(rc(8, 1), "phaser") !== null);

  /* ── the Herald's banner, end to end ───────────────────────────────── */
  group("The Herald's banner");
  const broke = () => { G.players[0].fp = 0; G.players[0].hand = []; };

  blank();
  put(rc(5, 4), 0, "pawn", { form: "herald" });
  put(rc(7, 4), 0);
  put(rc(0, 1), 1);
  G.turn = 0; G.phase = "declare"; broke();
  applyAction(0, { t: "move", from: rc(7, 4), to: rc(6, 5), kind: "step" });
  ok("landing beside a friendly Herald offers the bonus step", G.heraldBonus === rc(6, 5), G.heraldBonus);
  ok("...and the turn is held open for it", G.turn === 0 && !G.over);
  ok("...with every other piece locked out",
    legalMovesFor(rc(5, 4)).length === 0 && legalMovesFor(rc(6, 5)).length === 1);
  const hsteps = legalHeraldSteps(rc(6, 5));
  ok("...the step never lands on the Herald itself", hsteps.every((m) => m.to !== rc(5, 4)));
  const hres = applyAction(0, { t: "move", from: rc(6, 5), to: hsteps[0].to, kind: "herald" });
  ok("...the step is accepted", hres.ok === true, JSON.stringify(hres));
  ok("...the pawn actually advances", !!G.board[hsteps[0].to] && !G.board[rc(6, 5)]);
  ok("...and the obligation clears", G.heraldBonus === null);

  // Regression: a capture that ends the JUMP SEQUENCE still owes the Herald's
  // bonus. The halt path used to drop the landing square and swallow it.
  blank();
  put(rc(5, 4), 0, "pawn", { form: "herald" });
  put(rc(8, 3), 0);
  put(rc(7, 4), 1);
  put(rc(0, 1), 1);
  G.turn = 0; G.phase = "declare"; broke();
  applyAction(0, { t: "move", from: rc(8, 3), to: rc(6, 5), kind: "capture" });
  ok("a chain that ends beside the Herald still gets its bonus",
    G.heraldBonus === rc(6, 5), `${G.heraldBonus} — ${G.log.slice(-2).map((l) => l.text).join(" / ")}`);

  blank();
  put(rc(5, 4), 1, "pawn", { form: "herald" });
  put(rc(5, 6), 1);
  put(rc(11, 0), 0);
  G.turn = 1; G.phase = "declare";
  G.players[1].fp = 0; G.players[1].hand = [];
  applyAction(1, { t: "move", from: rc(5, 6), to: rc(6, 5), kind: "step" });
  ok("the banner works the same way for Violet", G.heraldBonus === rc(6, 5), G.heraldBonus);
  ok("...and points down the board, the way Violet advances",
    legalHeraldSteps(rc(6, 5)).every((m) => rowOf(m.to) === 7));

  /* ── status timing ─────────────────────────────────────────────────── */
  group("Status effect timing");
  blank();
  const self = put(rc(6, 5), 0);
  G.turn = 0;
  freezePiece(self, 1);                       // penalty taken on your own turn
  ok("a self-inflicted freeze is not active this turn", self.frozen === 0);
  tickDownFor(0);
  ok("...it is active on your next turn", self.frozen === 1);
  ok("...and that piece cannot move", simpleMoves(rc(6, 5)).length === 0);
  tickDownFor(0);
  ok("...and clears after exactly one turn", self.frozen === 0);
  ok("...restoring movement", simpleMoves(rc(6, 5)).length === 2);

  blank();
  const foe = put(rc(6, 5), 1);
  put(rc(7, 4), 0);                           // in front of Violet, so jumpable
  G.turn = 0;
  effNow(foe, "noCapture", 2);                // Static Veil on an enemy
  ok("Static Veil blocks capture on the victim's 1st turn",
    captureMoves(rc(6, 5)).length === 0 && simpleMoves(rc(6, 5)).length > 0);
  tickDownFor(1);
  ok("...still blocked on the 2nd turn", foe.noCapture === 1 && captureMoves(rc(6, 5)).length === 0);
  tickDownFor(1);
  ok("...free on the 3rd turn", foe.noCapture === 0 && captureMoves(rc(6, 5)).length === 1);

  /* ── spell penalties actually landing ──────────────────────────────── */
  group("Evasive Maneuver penalty");
  blank();
  G.players[0].fp = 20; G.players[0].hand = ["evasive"];
  const ev = put(rc(5, 4), 0);
  put(rc(1, 0), 1);
  G.turn = 0; G.phase = "declare";
  castSpell("evasive", 0, { from: rc(5, 4), to: rc(6, 5) });
  ok("the pawn retreats one square backward", !G.board[rc(5, 4)] && G.board[rc(6, 5)] === ev);
  ok("it is frozen at once, so it cannot also move normally this turn",
    ev.frozen === 1 && simpleMoves(rc(6, 5)).length === 0);
  tickDownFor(0);
  ok("...still frozen through your whole next turn",
    ev.frozen === 1 && simpleMoves(rc(6, 5)).length === 0);
  tickDownFor(0);
  ok("...and recovers the turn after", ev.frozen === 0 && simpleMoves(rc(6, 5)).length === 2);

  group("Static Veil friendly fire");
  blank();
  G.players[0].fp = 20; G.players[0].hand = ["veil"];
  put(rc(6, 5), 1);                    // the stunned enemy
  put(rc(9, 4), 0);                    // caster's nearest free pawn
  put(rc(11, 0), 0);                   // a further one, should be spared
  G.turn = 0; G.phase = "declare";
  castSpell("veil", 0, { target: rc(6, 5) });
  ok("the caster is flagged as owing friendly fire", veilBacklashPending(0) === 1);
  ok("no friendly pawn is sick yet", G.board[rc(9, 4)].frozen === 0);
  endTurnLocal();                           // Gold ends
  endTurnLocal();                           // Violet's 1st stunned turn ends
  ok("stun still running after the victim's 1st turn", G.board[rc(6, 5)].noCapture === 1);
  ok("friendly fire has not landed early", G.board[rc(9, 4)].frozen === 0);
  endTurnLocal();                           // Gold ends
  endTurnLocal();                           // Violet's 2nd stunned turn ends -> backlash
  ok("the stun expires after exactly 2 of the victim's turns", G.board[rc(6, 5)].noCapture === 0);
  ok("friendly fire freezes the caster's NEAREST free pawn", G.board[rc(9, 4)].frozen === 1);
  ok("...and spares the distant one", G.board[rc(11, 0)].frozen === 0);
  ok("the debt is cleared once paid", veilBacklashPending(0) === 0);
  ok("the landing is announced in the log",
    G.log.some((l) => l.text.includes("friendly fire lands")));

  /* ── Eye For An Eye ────────────────────────────────────────────────── */
  group("Eye For An Eye");
  blank();
  put(rc(6, 5), 0, "pawn", { eyeMark: 3 });
  put(rc(5, 6), 1);                                  // Violet advances toward row 11
  performMove(rc(5, 6), captureMoves(rc(5, 6))[0]);
  ok("the marked pawn is captured", !G.board[rc(6, 5)]);
  ok("the capturer dies with it", !G.board[rc(7, 4)]);
  blank();
  put(rc(6, 5), 0, "pawn", { eyeMark: 0 });
  put(rc(5, 6), 1);
  performMove(rc(5, 6), captureMoves(rc(5, 6))[0]);
  ok("an unmarked pawn takes no one with it", !!G.board[rc(7, 4)]);

  /* ── Mirror Step ───────────────────────────────────────────────────── */
  group("Mirror Step");
  ok("the mirror crosses the centreline", rowOf(mirrorOf(rc(2, 5))) === 9);
  ok("the mirror is its own inverse", mirrorOf(mirrorOf(rc(2, 5))) === rc(2, 5));
  ok("EVERY mirrored square stays a dark square",
    Array.from({ length: CELLS }, (_, i) => i).filter(isDark).every((i) => isDark(mirrorOf(i))));
  blank();
  G.players[0].fp = 9; G.players[0].hand = ["mirror"];
  put(rc(9, 4), 0, "queen");
  put(rc(8, 3), 0); put(rc(8, 5), 0);
  G.turn = 0; G.phase = "declare";
  const dest = mirrorOf(rc(9, 4));
  castSpell("mirror", 0, { from: rc(9, 4) });
  ok("the queen teleports across the centreline", !!G.board[dest] && !G.board[rc(9, 4)]);
  ok("Distortion Field spares pawns that are no longer adjacent",
    !G.board[rc(8, 3)].frozen && !G.board[rc(8, 3)].p_frozen);
  blank();
  G.players[0].fp = 9; G.players[0].hand = ["mirror"];
  put(rc(9, 4), 0, "queen");
  put(rc(3, 6), 0);                                  // diagonally adjacent to (2,7)
  G.turn = 0; G.phase = "declare";
  castSpell("mirror", 0, { from: rc(9, 4) });
  ok("Distortion Field freezes pawns adjacent AFTER the jump",
    G.board[rc(3, 6)].p_frozen === 1 || G.board[rc(3, 6)].frozen === 1);

  /* ── the draw pool ─────────────────────────────────────────────────── */
  group("Spell pool");
  G = newGame(0, 42); UI = freshUI();
  ok("every spell the mode allows starts eligible to draw",
    eligibleSpellIds().length === modeSpellIds().length, eligibleSpellIds().length);
  const COSTS = {
    hopscotch: 3, evasive: 3, mirror: 2, veil: 2, mindcontrol: 3, eye: 3, chronos: 4, cascade: 5, martyr: 3, phaserSpell: 3,
    juggernautSpell: 3, heraldSpell: 3, enchanterSpell: 3, alchemistSpell: 6,
    tactician: 0, rift: 4, wraparound: 4, anchor: 3, echo: 4, chokepoint: 4,
    stutter: 4, pressure: 3, hollow: 3, quantum: 5, twin: 5,
  };
  ok("every spell cost matches the rulebook",
    SPELL_IDS.every((id) => SPELLS[id].cost === COSTS[id]));
  ok("every spell declares a rarity the draw understands",
    SPELL_IDS.every((id) => RARITY[SPELLS[id].rarity] > 0));
  ok("...and its weight is derived from that rarity, never hand-written",
    SPELL_IDS.every((id) => SPELLS[id].weight === RARITY[SPELLS[id].rarity]));
  const FCOSTS = { juggernaut: 3, phaser: 0, herald: 3, enchanter: 3, alchemist: 6 };
  ok("every transformation cost matches the rulebook",
    Object.keys(FORMS).every((f) => FORMS[f].cost === FCOSTS[f]));
  ok("every transformation is reached only through its spell",
    Object.keys(FORMS).every((f) => FORMS[f].viaSpell === true));

  blank();
  G.players[0].fp = 40;
  G.players[0].hand = ["evasive", "evasive", "evasive", "evasive", "evasive"];
  put(rc(5, 4), 0); put(rc(5, 6), 0); put(rc(5, 8), 0); put(rc(5, 10), 0); put(rc(5, 2), 0);
  G.turn = 0; G.phase = "declare";
  for (const from of [rc(5, 4), rc(5, 6), rc(5, 8), rc(5, 10), rc(5, 2)])
    castSpell("evasive", 0, { from, to: rc(6, colOf(from) + 1) });
  ok("a common card stays eligible to draw after being cast", eligibleSpellIds().includes("evasive"));

  blank();
  G = newGame(0, 42); UI = freshUI();
  G.drawCounts.cascade = SPELLS.cascade.maxDraws;
  ok("a maxDraws card drops out of the pool once exhausted", !eligibleSpellIds().includes("cascade"));
  ok("...but every other card is unaffected", eligibleSpellIds().length === modeSpellIds().length - 1);

  blank();
  G.players[0].fp = 9; G.players[0].hand = ["cascade"];
  put(rc(9, 4), 0);
  G.turn = 0; G.phase = "declare";
  castSpell("cascade", 0, { sacrifice: rc(9, 4) });
  ok("Temporal Cascade leaves the game after use", G.removed.includes("cascade"));
  ok("...grants 2 extra turns", G.players[0].extraTurns === 2);
  ok("...and bars drawing for 4 turns", G.players[0].noDraw === 4, G.players[0].noDraw);

  /* ── the board-altering four ───────────────────────────────────────── */
  group("Tactician");
  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(6, 3), 1); put(rc(0, 1), 1);
  G.turn = 0; G.phase = "declare"; G.players[0].fp = 0; G.players[0].hand = ["tactician"];
  ok("it counts every jump, not every jumper", availableCaptures(0) === 2, availableCaptures(0));
  castSpell("tactician", 0, {});
  ok("...and pays one Focus for each", G.players[0].fp === 2, G.players[0].fp);  // 2 gained, the card is free
  ok("...leaving a debt of one capture", tacticianDebt(0));
  ok("...which blocks ending the turn",
    applyAction(0, { t: "endTurn" }).ok === false);
  applyAction(0, { t: "move", from: rc(7, 4), to: rc(5, 6), kind: "capture" });
  ok("...and is discharged by taking one", !tacticianDebt(0));

  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(0, 1), 1);
  G.turn = 0; G.phase = "declare"; G.players[0].fp = 9; G.players[0].hand = ["tactician"];
  castSpell("tactician", 0, {});
  removePiece(rc(6, 5), "is removed by the test", "sacrifice");
  ok("a debt with nothing left to capture clears itself", !tacticianDebt(0));

  group("Rift");
  blank();
  put(rc(7, 4), 0); put(rc(0, 1), 1);
  G.turn = 0; G.phase = "declare"; G.players[0].fp = 9; G.players[0].hand = ["rift"];
  castSpell("rift", 0, { a: rc(6, 5), b: rc(2, 3) });
  ok("the rift remembers both ends", G.rift.a === rc(6, 5) && G.rift.b === rc(2, 3));
  performMove(rc(7, 4), { to: rc(6, 5), kind: "step" });
  ok("it is inert on the turn it was opened", !!G.board[rc(6, 5)] && !G.board[rc(2, 3)]);

  blank();
  put(rc(7, 4), 0); put(rc(0, 1), 1);
  G.rift = { a: rc(6, 5), b: rc(2, 3), madeOn: 0 };
  G.turn = 0; G.phase = "declare"; G.turnNo = 4;
  performMove(rc(7, 4), { to: rc(6, 5), kind: "step" });
  ok("afterwards it carries whatever lands on it",
    !G.board[rc(6, 5)] && !!G.board[rc(2, 3)] && G.board[rc(2, 3)].owner === 0);
  ok("...and the square it left is empty", !G.board[rc(7, 4)]);

  blank();
  put(rc(7, 4), 0); put(rc(2, 3), 1); put(rc(0, 1), 1);
  G.rift = { a: rc(6, 5), b: rc(2, 3), madeOn: 0 };
  G.turn = 0; G.turnNo = 4;
  performMove(rc(7, 4), { to: rc(6, 5), kind: "step" });
  ok("a blocked far end swallows nobody", !!G.board[rc(6, 5)]);

  // The other half of the card: cast on an open rift, it seals it instead.
  blank();
  put(rc(7, 4), 0); put(rc(0, 1), 1);
  G.rift = { a: rc(6, 5), b: rc(2, 3), madeOn: 0 };
  G.turn = 0; G.phase = "declare"; G.turnNo = 4;
  G.players[0].fp = 9; G.players[0].hand = ["rift"];
  ok("the card is castable with a rift already open", !spellBlocker("rift", 0));
  ok("...even one the caster did not open", !!applyAction(0, { t: "cast", id: "rift", payload: {} }).ok);
  ok("...and it closes it", G.rift === null);
  G.phase = "declare";
  performMove(rc(7, 4), { to: rc(6, 5), kind: "step" });
  ok("...so nothing is carried across it again", !!G.board[rc(6, 5)] && !G.board[rc(2, 3)]);

  blank();
  put(rc(7, 4), 0); put(rc(0, 1), 1);
  G.rift = { a: rc(6, 5), b: rc(2, 3), madeOn: 0 };
  G.turn = 0; G.phase = "declare"; G.turnNo = 4;
  G.players[0].fp = 9; G.players[0].hand = ["rift"];
  ok("a closing cast ignores whatever squares an edited client names",
    !!applyAction(0, { t: "cast", id: "rift", payload: { a: rc(9, 0), b: rc(9, 2) } }).ok
      && G.rift === null);

  group("Wraparound");
  blank();
  put(rc(7, 0), 0); put(rc(0, 1), 1);
  G.turn = 0; G.phase = "declare"; G.players[0].fp = 9; G.players[0].hand = ["wraparound"];
  ok("with edges intact a pawn on column 0 has one step", simpleMoves(rc(7, 0)).length === 1);
  castSpell("wraparound", 0, {});
  const wrapped = simpleMoves(rc(7, 0));
  ok("joined edges give it a second, across the seam", wrapped.length === 2, wrapped.length);
  ok("...and every destination is still a dark square",
    wrapped.every((m) => isDark(m.to)));
  ok("...the wrapping one lands on column 11",
    wrapped.some((m) => colOf(m.to) === N - 1));
  // 2 rounds = 4 turns, ticked in beginTurn.
  let wrapGuard = 0;
  while (G.wrap > 0 && wrapGuard++ < 10) beginTurn(1 - G.turn);
  ok("it expires after 2 rounds", G.wrap === 0 && simpleMoves(rc(7, 0)).length === 1, wrapGuard);

  blank();
  put(rc(7, 0), 0); put(rc(6, 11), 1); put(rc(0, 1), 1);
  G.wrap = 4; G.turn = 0;
  const wcaps = captureMoves(rc(7, 0));
  ok("a capture across the seam takes the right victim",
    wcaps.length === 1 && wcaps[0].victim === rc(6, 11), JSON.stringify(wcaps));
  ok("...and lands two columns on, wrapped", wcaps[0].to === rc(5, 10), wcaps[0] && sq(wcaps[0].to));

  group("Anchor In Time");
  blank(0);
  put(rc(6, 5), 0); put(rc(2, 5), 1);
  G.players[0].hand = ["anchor"]; G.players[0].fp = 9; G.turnNo = 0;
  beginTurn(0);
  performMove(rc(6, 5), simpleMoves(rc(6, 5))[0]);
  endTurnLocal(); endTurnLocal();
  ok("Chronos can reach back before the anchor is dropped", chronosTargets(0).length > 0);
  castSpell("anchor", 0, {});
  const firstPin = G.anchor.turnNo;
  ok("...and cannot once it is", chronosTargets(0).length === 0);
  ok("...which binds the caster too", !!spellBlocker("chronos", 0));

  // A second copy is not a dead card. It drags the pin forward to the turn it
  // is cast on, which is strictly more restrictive than leaving it where it was.
  G.players[0].hand = ["anchor"]; G.players[0].fp = 9;
  endTurnLocal(); endTurnLocal();
  G.phase = "declare";
  ok("a second Anchor is castable on a later turn", !spellBlocker("anchor", 0));
  castSpell("anchor", 0, {});
  ok("...and drags the pin forward", G.anchor.turnNo > firstPin, `${firstPin} → ${G.anchor.turnNo}`);
  ok("...but not onto the very turn it already pins", !!spellBlocker("anchor", 0));

  group("Echo");
  blank(0);
  put(rc(6, 5), 0); put(rc(2, 5), 1);
  G.players[0].hand = ["echo"]; G.players[0].fp = 9; G.turnNo = 0;
  beginTurn(0);
  const echoHome = rc(6, 5);
  performMove(echoHome, simpleMoves(echoHome)[0]);
  let at = G.lastMove.to;
  for (let k = 0; k < 3; k++) {
    endTurnLocal(); endTurnLocal();
    if (simpleMoves(at).length) { performMove(at, simpleMoves(at)[0]); at = G.lastMove.to; }
  }
  const echoBack = echoTarget(at, 0);
  ok("Echo finds where the piece stood 3 of its owner's turns ago", echoBack >= 0, echoBack);
  castSpell("echo", 0, { target: at });
  ok("...and sends it there", !!G.board[echoBack] && !G.board[at]);
  ok("...removing itself from the game", G.removed.includes("echo"));

  group("Chokepoint");
  blank();
  put(rc(5, 4), 1); put(rc(9, 2), 0); put(rc(0, 1), 1);
  G.turn = 0; G.phase = "declare"; G.players[0].fp = 9; G.players[0].hand = ["chokepoint"];
  const pick1 = chokepointTarget(0), pick2 = chokepointTarget(0);
  ok("the engine picks the same square twice from one board", pick1 === pick2 && pick1 >= 0, pick1);
  castSpell("chokepoint", 0, {});
  ok("...and seals it", G.barriers.includes(pick1));
  ok("...so nothing may land there", isBarrier(pick1) && !simpleMoves(rc(5, 4)).some((m) => m.to === pick1));
  ok("...and it is not a piece", !G.board[pick1]);
  ok("...so it cannot be mistaken for a side's last man",
    !immobileWipeout(0) && !immobileWipeout(1));
  ok("...and the caster pays with 2 turns of silence", G.players[0].noSpells === 2, G.players[0].noSpells);

  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(0, 1), 1);
  G.barriers = [rc(5, 6)];
  G.turn = 0;
  ok("a sealed landing square kills the jump over it",
    captureMoves(rc(7, 4)).length === 0);

  /* ── Chronos's Gaze ────────────────────────────────────────────────── */
  /* ── the turn model ────────────────────────────────────────────────── */
  group("Stutter");
  blank();
  put(rc(9, 4), 0); put(rc(9, 6), 0);
  put(rc(2, 3), 1); put(rc(2, 5), 1);
  G.turn = 0; G.phase = "declare";
  G.players[0].fp = 10; G.players[0].hand = ["stutter"];
  G.players[1].fp = 0; G.players[1].hand = [];
  castSpell("stutter", 0, {});
  ok("it arms against the opponent, not the caster",
    G.stutter && G.stutter.player === 1, JSON.stringify(G.stutter));
  ok("...and nothing is banned until a turn has actually been taken",
    G.stutter.banned === null);
  ok("...and it costs 4 for the card plus 3 in strain",
    G.players[0].fp === 3, G.players[0].fp);
  ok("...and bars the caster's next draw",
    G.players[0].p_noDraw === 1 || G.players[0].noDraw === 1);

  endTurnLocal();
  ok("arming survives the handover — beginTurn must not clear it",
    !!G.stutter && G.turn === 1, `${G.turn} / ${JSON.stringify(G.stutter)}`);

  const stFrom = rc(2, 3), stTaken = rc(3, 2), stOther = rc(3, 4);
  const stRes = applyAction(1, { t: "move", from: stFrom, to: stTaken, kind: "step" });
  ok("the stuttered turn is played out and then unmade",
    stRes.ok && !!G.board[stFrom] && !G.board[stTaken],
    `${stRes.ok} / ${!!G.board[stFrom]} / ${!!G.board[stTaken]}`);
  ok("...and the seat keeps the turn rather than handing over",
    G.turn === 1 && G.phase === "declare" && !G.hasActed,
    `${G.turn} / ${G.phase} / ${G.hasActed}`);
  ok("...with the move it just made now named as the one it may not repeat",
    G.stutter && G.stutter.banned && G.stutter.banned.to === stTaken,
    JSON.stringify(G.stutter && G.stutter.banned));
  ok("...and the turn counter did not advance for a turn that was unmade",
    G.history[G.history.length - 1].turnNo === G.turnNo);

  ok("repeating it is refused",
    !applyAction(1, { t: "move", from: stFrom, to: stTaken, kind: "step" }).ok);
  ok("...and refusing it leaves the piece where it was",
    !!G.board[stFrom] && !G.board[stTaken]);
  ok("any other turn is allowed",
    applyAction(1, { t: "move", from: stFrom, to: stOther, kind: "step" }).ok);
  ok("...and the second attempt stands", !G.board[stFrom] && !!G.board[stOther]);
  ok("...spending the card, so play returns to the opponent",
    G.stutter === null && G.turn === 0, `${JSON.stringify(G.stutter)} / ${G.turn}`);

  // "Take a different turn" cannot mean "lose the game". Down to a single
  // legal move, the ban stops binding.
  blank();
  put(rc(9, 4), 0);                                   // so the game is not already won
  put(rc(0, 1), 1);                                   // Violet's one and only piece
  // Sealed rather than blocked by a piece: an enemy pawn on that square would
  // hand this pawn a capture, which is a second move and defeats the fixture.
  G.barriers.push(rc(1, 2));
  G.turn = 1; G.phase = "declare";
  G.players[1].fp = 0; G.players[1].hand = [];
  G.players[1].noDraw = 9;                            // and drawing is off the table
  G.stutter = { player: 1, banned: { t: "move", from: rc(0, 1), to: rc(1, 0), kind: "step" } };
  ok("the position really does leave exactly one move",
    legalMovesFor(rc(0, 1)).length === 1 && legalMovesFor(rc(0, 1))[0].to === rc(1, 0),
    JSON.stringify(legalMovesFor(rc(0, 1)).map((m) => m.to)));
  ok("...so the ban lifts rather than sealing the game shut",
    !stutterHasAlternative(1) && !stutterBans(1, { t: "move", from: rc(0, 1), to: rc(1, 0), kind: "step" }));
  ok("...and the referee lets it through",
    applyAction(1, { t: "move", from: rc(0, 1), to: rc(1, 0), kind: "step" }).ok);

  // A turn spent DRAWING is unmade like any other, and drawing again is the
  // same turn over. The referee refuses it, and — because the machine never
  // goes through the referee — aiShouldDraw has to refuse it independently.
  blank();
  put(rc(9, 4), 0); put(rc(2, 3), 1); put(rc(0, 1), 1);
  G.turn = 1; G.phase = "declare"; G.turnNo = 6;
  G.players[1].hand = []; G.players[1].fp = 0;
  G.stutter = { player: 1, banned: null };
  G.history = [{ turn: 1, turnNo: G.turnNo, snap: snapshot(G) }];
  const stDrew = applyAction(1, { t: "draw" });
  ok("a drawn turn is handed straight back to be taken again",
    stDrew.ok && stDrew.sameSeat === true && G.turn === 1, JSON.stringify(stDrew));
  ok("...with the draw unmade", G.players[1].hand.length === 0 && !G.drewThisTurn);
  ok("...and named as what may not be repeated",
    G.stutter && G.stutter.banned && G.stutter.banned.t === "draw",
    JSON.stringify(G.stutter && G.stutter.banned));
  ok("...so the referee refuses a second draw",
    !applyAction(1, { t: "draw" }).ok);
  const stAISide = AI.side;
  AI.side = 1;
  G.players[1].noDraw = 0;                            // nothing else standing in its way
  ok("...and the machine will not take one either", !aiShouldDraw());
  AI.side = stAISide;

  // A turn that did nothing has nothing to unmake, and banning "do nothing"
  // would rewind for ever.
  blank();
  put(rc(9, 4), 0); put(rc(2, 3), 1);
  G.turn = 1; G.phase = "declare";
  G.stutter = { player: 1, banned: null };
  G.turnAction = null;
  const stNoop = endTurn();
  ok("a turn that did nothing spends the card instead of rewinding for ever",
    G.stutter === null && stNoop.sameSeat === false && G.turn === 0,
    `${JSON.stringify(G.stutter)} / ${stNoop.sameSeat} / ${G.turn}`);

  // Chronos's Gaze truncates history in place and could have been cast during
  // the very turn Stutter is trying to unmake.
  blank();
  put(rc(9, 4), 0); put(rc(2, 3), 1);
  G.turn = 1; G.phase = "end";
  G.stutter = { player: 1, banned: null };
  G.turnAction = { t: "move", from: rc(2, 3), to: rc(3, 2), kind: "step" };
  G.history = [];                                     // the moment has been unmade already
  endTurn();
  ok("with no snapshot to return to it fizzles rather than rewinding somebody else's turn",
    G.stutter === null && G.turn === 0, `${JSON.stringify(G.stutter)} / ${G.turn}`);

  // The machine does not end its turn through the referee, so the refusal in
  // dispatchAction never binds it. rootMoves is the one place that does.
  blank();
  put(rc(9, 4), 0); put(rc(2, 3), 1); put(rc(2, 5), 1);
  G.turn = 1; G.phase = "declare";
  const stAll = turnMoves(1);
  G.stutter = { player: 1, banned: { t: "move", from: rc(2, 3), to: rc(3, 2), kind: "step" } };
  const stRoot = rootMoves(1);
  ok("the machine's own move list drops the banned turn",
    stRoot.length === stAll.length - 1
      && !stRoot.some((m) => m.from === rc(2, 3) && m.to === rc(3, 2)),
    `${stAll.length} → ${stRoot.length}`);
  ok("...and the evaluator can see being stuttered as a cost",
    (() => { const withBan = sideScore(1); G.stutter = null; return sideScore(1) > withBan; })());

  /* Whether the machine will PAY for it. Both halves of the judgement are
     asserted, because either one alone silently does nothing: without the gate
     it would buy a stutter worth nothing, and without the bonus the flat score
     term caps its value at STUTTER_DENIAL and it never clears the cast margin
     however sharp the position. */
  const stAIWas = { on: AI.on, side: AI.side, level: AI.level, fast: AI.fast, thinking: AI.thinking };

  // A quiet position: several replies, all equally good. Denying one is free
  // for the victim, so the card must not be bought.
  blank(0, { mode: "ai" });
  put(rc(5, 4), 1, "queen");
  put(rc(1, 6), 1); put(rc(1, 8), 1);
  put(rc(10, 5), 0); put(rc(10, 7), 0);
  G.turn = 0; G.phase = "declare";
  G.players[0].fp = 10; G.players[0].hand = ["stutter"];
  G.players[1].fp = 0; G.players[1].hand = [];
  AI.on = true; AI.fast = true; AI.side = 0; AI.level = "skilled"; AI.thinking = false;
  ok("nothing worth denying, so the machine is not even offered the card",
    aiStutterGap() < STUTTER_DENIAL
      && !aiSpellCandidates("declare").some((c) => c.id === "stutter"),
    Math.round(aiStutterGap()));
  ok("...and it keeps its Focus", !aiCastOnce("declare") && G.stutter === null);

  // The same card against a position with exactly ONE turn worth taking: a
  // hanging queen with a single escape, and other legal turns to fall back on
  // so the ban still has something to bite.
  blank(0, { mode: "ai" });
  put(rc(5, 4), 1, "queen");                 // hanging...
  put(rc(6, 3), 0);                          // ...to this pawn, which lands on f8
  put(rc(4, 3), 1); put(rc(6, 5), 1);        // her own pawns seal every escape but f8
  G.barriers.push(rc(7, 2));                 // and her counter-jump has nowhere to land
  put(rc(1, 6), 1); put(rc(1, 8), 1);        // spare turns, so she is not down to one move
  put(rc(10, 5), 0); put(rc(10, 7), 0);
  G.turn = 0; G.phase = "declare";
  G.players[0].fp = 10; G.players[0].hand = ["stutter"];
  G.players[1].fp = 0; G.players[1].hand = [];
  AI.side = 0;
  ok("the fixture really is sharp — one saving turn, and the rest legal",
    capturersFor(1).length === 0 && turnMoves(1).length > 2 && aiStutterGap() > 200,
    `${turnMoves(1).length} moves, gap ${Math.round(aiStutterGap())}`);
  const stCand = aiSpellCandidates("declare").find((c) => c.id === "stutter");
  ok("...so the card is offered, carrying what the position is worth",
    !!stCand && stCand.bonus > 100, stCand && Math.round(stCand.bonus));
  ok("...and the machine pays for it",
    aiCastOnce("declare") && G.stutter && G.stutter.player === 1,
    JSON.stringify(G.stutter));

  AI.on = stAIWas.on; AI.side = stAIWas.side; AI.level = stAIWas.level;
  AI.fast = stAIWas.fast; AI.thinking = stAIWas.thinking;

  group("Hollow");
  blank(0, { mode: "ai" });
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(0, 1), 1);
  G.turn = 0; G.phase = "declare";
  G.players[0].fp = 9; G.players[0].hand = ["hollow"];
  ok("a pawn with a jump available is still a legal target",
    hollowTargets(0).includes(rc(7, 4)));
  castSpell("hollow", 0, { target: rc(7, 4) });
  ok("the pawn is marked", G.board[rc(7, 4)].hollow === true);
  ok("...and can no longer capture", captureMoves(rc(7, 4)).length === 0);
  ok("...so the mandatory-capture rule stops billing it", capturersFor(0).length === 0);
  ok("...but it can still move", simpleMoves(rc(7, 4)).length > 0);
  ok("...and the line naming it is private to its owner",
    G.log.filter((l) => /a shell closes over/i.test(l.text)).every((l) => l.only === 0));
  ok("...while the cast itself is public",
    G.log.some((l) => /casts Hollow/.test(l.text) && l.only == null));

  /* §3b. The shell, and the one thing about it a render can get wrong: after it
     is spent the pawn is still there, and neither seat may still be shown a
     marker for a shell that no longer exists. */
  {
    blank(1, { mode: "ai" });
    put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(0, 1), 1);
    G.board[rc(7, 4)].hollow = true;
    G.board[rc(7, 4)].hollowHome = rc(9, 8);
    G.turn = 1; G.phase = "declare"; G.hasActed = false;
    const capsWas = G.board[rc(6, 5)].captures;
    performMove(rc(6, 5), captureMoves(rc(6, 5)).find((m) => m.victim === rc(7, 4)));
    ok("an enemy jump breaks the shell and the pawn steps back out where it was cast",
      !G.board[rc(7, 4)] && !!G.board[rc(9, 8)] && G.board[rc(9, 8)].hollow === false);
    ok("...with the attacker on its landing square", !!G.board[rc(8, 3)]);
    ok("...paid for nothing", G.board[rc(8, 3)].captures === capsWas);
    ok("...and the reveal is public", G.log.some((l) => /was a Hollow/.test(l.text) && l.only == null));
    renderBoard();
    ok("...so no shell marker survives the break, from either chair",
      !CELL_NODES.some((n) => n.querySelector(".piece.hollow")));
    ok("...while the pawn itself is still drawn, at home",
      !!CELL_NODES[rc(9, 8)].querySelector(".piece")
      && !CELL_NODES[rc(7, 4)].querySelector(".piece"));
  }

  /* §3c. The home marker, and the tooltip beside it. Both say which pawn is
     shelled, so both are owner-only — and the tooltip is the one that was
     still talking: the board stopped at the .hollow class and describePiece
     did not. Vs the machine this device holds the whole game, so a bare
     `if (p.hollow)` would have announced the machine's own shell. */
  {
    const hWas = { on: AI.on, side: AI.side };
    blank(0, { mode: "ai" });
    put(rc(7, 4), 0); put(rc(3, 2), 1); put(rc(0, 1), 1);
    G.board[rc(7, 4)].hollow = true; G.board[rc(7, 4)].hollowHome = rc(9, 8);
    G.board[rc(3, 2)].hollow = true; G.board[rc(3, 2)].hollowHome = rc(1, 0);
    AI.on = true; AI.side = 1; G.turn = 0; UI.revealed = true;
    renderBoard();

    ok("your own shell marks the square it comes back to",
      CELL_NODES[rc(9, 8)].classList.contains("hollowhome"));
    ok("...and the machine's does NOT — that square would name its decoy",
      !CELL_NODES[rc(1, 0)].classList.contains("hollowhome"));
    ok("...your tooltip tells you about your shell",
      /HOLLOW/.test(describePiece(G.board[rc(7, 4)], rc(7, 4))));
    ok("...and says nothing about the machine's",
      !/HOLLOW/.test(describePiece(G.board[rc(3, 2)], rc(3, 2))));
    ok("...nor does the tooltip leak which half of an enemy superposition is real",
      !/real pawn|empty half/.test(
        describePiece(Object.assign({}, G.board[rc(3, 2)], { quantum: 5, quantumReal: true }), rc(3, 2))));

    // A blocked home says so rather than promising a retreat that cannot happen.
    put(rc(9, 8), 0);
    renderBoard();
    ok("...and an occupied home is marked as blocked",
      CELL_NODES[rc(9, 8)].classList.contains("blocked"));
    AI.on = hWas.on; AI.side = hWas.side;
  }

  /* §3c. The machine's contract, and the one that matters: it must not be
     able to price a board with a decoy differently from a board without one.
     A term in sideScore would break this, because evaluate() calls sideScore
     for BOTH sides — so pricing your own decoy prices your opponent's too. */
  blank(0, { mode: "ai" });
  put(rc(7, 4), 0); put(rc(3, 2), 0); put(rc(6, 5), 1); put(rc(2, 3), 1);
  const hPlain = [sideScore(0), sideScore(1)];
  G.board[rc(7, 4)].hollow = true;
  const hDecoy = [sideScore(0), sideScore(1)];
  ok("the evaluator cannot tell a decoy from a pawn — its own side",
    hPlain[0] === hDecoy[0], `${hPlain[0]} vs ${hDecoy[0]}`);
  ok("...nor the other one, which is the half that would leak",
    hPlain[1] === hDecoy[1], `${hPlain[1]} vs ${hDecoy[1]}`);
  G.board[rc(6, 5)].hollow = true;
  ok("...and an ENEMY decoy is invisible to it too",
    sideScore(0) === hPlain[0] && sideScore(1) === hPlain[1]);

  // The machine still has to be able to CAST it, which is why the value rides
  // on the candidate rather than on the evaluator.
  {
    const hWas = { on: AI.on, side: AI.side, fast: AI.fast, level: AI.level };
    blank(0, { mode: "ai" });
    // A pawn standing next to an enemy but with its jump blocked: exactly the
    // pawn the finder is supposed to pick, since shelling a real threat would
    // throw the threat away to save the pawn.
    put(rc(7, 4), 0); put(rc(9, 0), 0);
    put(rc(6, 5), 1); put(rc(5, 6), 1); put(rc(0, 1), 1);
    G.turn = 0; G.phase = "declare";
    G.players[0].fp = 9; G.players[0].hand = ["hollow"];
    AI.on = true; AI.fast = true; AI.side = 0; AI.level = "skilled"; AI.thinking = false;
    const hCands = aiSpellCandidates("declare").filter((c) => c.id === "hollow");
    ok("the machine is offered a shell, and prefers a pawn with no jump to give up",
      hCands.length > 0 && hCands.every((c) => captureMoves(c.payload.target).length === 0),
      hCands.map((c) => sq(c.payload.target)).join(","));
    ok("...carrying the worth the evaluator cannot see",
      hCands.every((c) => c.bonus >= HOLLOW_SHELL));
    /* And it declines HERE, which is the point of having cut the bonus. That
       pawn is attacked but can simply walk away, so 3 Focus and a permanent
       loss of its jump buys nothing the position did not already have. The old
       bluff-era bonus was large enough to cast anyway. */
    ok("...but declines when the pawn could just step out of the way",
      !aiCastOnce("declare") && countHollow(0) === 0, countHollow(0));

    /* Where the shell genuinely IS the answer, it pays. This pawn is attacked
       and frozen, so there is no walking away — and the search sees the save
       for itself now, which is why the bonus does not have to carry it. */
    blank(0, { mode: "ai" });
    put(rc(7, 4), 0); put(rc(9, 0), 0); put(rc(6, 5), 1); put(rc(0, 1), 1);
    G.board[rc(7, 4)].frozen = 2;
    G.turn = 0; G.phase = "declare"; G.hasActed = false;
    G.players[0].fp = 9; G.players[0].hand = ["hollow"];
    ok("a pawn that is attacked and cannot run is worth a shell, and the machine pays",
      aiCastOnce("declare") && countHollow(0) === 1, countHollow(0));

    /* The shield reading: given a pawn that is actually under the axe and a
       second one merely standing near somebody, the finder has to pick the
       one about to be taken. That preference is the whole redesign. */
    blank(0, { mode: "ai" });
    put(rc(7, 4), 0); put(rc(3, 2), 0); put(rc(9, 0), 0);
    put(rc(6, 5), 1); put(rc(5, 6), 1); put(rc(2, 3), 1); put(rc(0, 1), 1);
    G.turn = 0; G.phase = "declare"; G.hasActed = false;
    G.players[0].fp = 9; G.players[0].hand = ["hollow"];
    const doomed = aiAttackedPieces(0).filter((i) => hollowTargets(0).includes(i) && !captureMoves(i).length);
    const hRanked = aiSpellCandidates("declare").filter((c) => c.id === "hollow");
    ok("the finder puts the pawn that is about to be taken first",
      doomed.length === 0 || (hRanked.length > 0 && doomed.includes(hRanked[0].payload.target)),
      `doomed=${doomed.map(sq).join(",")} offered=${hRanked.map((c) => sq(c.payload.target)).join(",")}`);

    /* And the search's half: the machine's OWN shell survives a jump inside
       applyStep, while an enemy's does not — reading that would be a leak. */
    blank(1, { mode: "ai" });
    put(rc(7, 4), 0); put(rc(6, 5), 1);
    AI.side = 0;
    G.board[rc(7, 4)].hollow = true;
    G.board[rc(7, 4)].hollowHome = rc(9, 8);
    let mvS = captureMoves(rc(6, 5)).find((m) => m.victim === rc(7, 4));
    let recS = applyStep(rc(6, 5), mvS);
    ok("the search keeps its own shelled pawn alive under a jump, and sends it home",
      !G.board[rc(7, 4)] && !!G.board[rc(9, 8)] && G.board[rc(9, 8)].hollow === false);
    ok("...without paying it a capture", G.board[rc(8, 3)].captures === 0);
    undoStep(recS);
    ok("...and unmake puts the pawn, the shell and its home back",
      !!G.board[rc(7, 4)] && G.board[rc(7, 4)].hollow === true
      && G.board[rc(7, 4)].hollowHome === rc(9, 8) && !G.board[rc(9, 8)] && !G.board[rc(8, 3)]);

    /* Unmake has to survive the nastiest board the retreat can produce: a home
       square that IS the square the attacker jumped from. Clearing the fled
       square after restoring the attacker would erase the attacker. */
    G.board[rc(7, 4)].hollowHome = rc(6, 5);
    recS = applyStep(rc(6, 5), mvS);
    ok("a retreat onto the attacker's own origin square is legal — it is empty by then",
      !!G.board[rc(6, 5)] && G.board[rc(6, 5)].owner === 0 && !!G.board[rc(8, 3)]);
    undoStep(recS);
    ok("...and unmake still puts both pieces back where they belong",
      !!G.board[rc(6, 5)] && G.board[rc(6, 5)].owner === 1
      && !!G.board[rc(7, 4)] && G.board[rc(7, 4)].owner === 0 && !G.board[rc(8, 3)]);

    /* And a home the attacker has just landed on is refused, same as the engine. */
    G.board[rc(7, 4)].hollowHome = rc(8, 3);
    recS = applyStep(rc(6, 5), mvS);
    ok("a home square under the attacker is refused; the pawn stands its ground",
      !!G.board[rc(7, 4)] && G.board[rc(7, 4)].owner === 0 && G.board[rc(8, 3)].owner === 1);
    undoStep(recS);

    AI.side = 1;
    G.board[rc(7, 4)].hollowHome = rc(9, 8);
    recS = applyStep(rc(6, 5), mvS);
    ok("but an ENEMY shell is invisible to it — the jump kills, as it would for a person",
      !G.board[rc(7, 4)] && !G.board[rc(9, 8)]);
    undoStep(recS);

    AI.on = hWas.on; AI.side = hWas.side; AI.fast = hWas.fast; AI.level = hWas.level;
  }

  group("Quantum Pawn");
  blank(0, { mode: "ai" });
  put(rc(5, 4), 0); put(rc(1, 6), 1);
  G.turn = 0; G.phase = "declare";
  G.players[0].fp = 9; G.players[0].hand = ["quantum"];
  ok("an untouched pawn with an empty square beside it can be split",
    quantumTargets(0).includes(rc(5, 4)));
  const qSpot = quantumSpots(rc(5, 4))[0];
  castSpell("quantum", 0, { target: rc(5, 4), spot: qSpot });
  const qPair = quantumPair(G.board[rc(5, 4)].quantum);
  ok("...leaving two bodies linked by one id", qPair.length === 2, qPair.length);
  ok("...exactly one of which is real",
    qPair.filter((i) => G.board[i].quantumReal).length === 1);
  ok("...neither able to capture", qPair.every((i) => !canCapture(G.board[i])));
  ok("...with the square named privately to its owner",
    G.log.filter((l) => /real pawn is/.test(l.text)).every((l) => l.only === 0));
  ok("...while the split itself is public",
    G.log.some((l) => /stands on both/.test(l.text) && l.only == null));

  /* The blindness contract for this card is NOT "a pair scores like a pawn" —
     the pair is plainly visible and the machine is entitled to count it. It is
     that the machine cannot tell WHICH half is the real one. */
  blank(0, { mode: "ai" });
  put(rc(5, 4), 0); put(rc(4, 3), 0); put(rc(1, 6), 1); put(rc(1, 8), 1);
  G.board[rc(5, 4)].quantum = 9; G.board[rc(4, 3)].quantum = 9;
  G.board[rc(5, 4)].quantumReal = true; G.board[rc(4, 3)].quantumReal = false;
  const qA = [sideScore(0), sideScore(1)];
  G.board[rc(5, 4)].quantumReal = false; G.board[rc(4, 3)].quantumReal = true;
  const qB = [sideScore(0), sideScore(1)];
  ok("the evaluator cannot tell which half of a superposition is real",
    qA[0] === qB[0] && qA[1] === qB[1], `${qA} vs ${qB}`);
  G.board[rc(5, 4)].quantum = 0; G.board[rc(4, 3)].quantum = 0;
  ok("...but it does discount the pair, which is public and fair to read",
    sideScore(0) > qA[0], `${sideScore(0)} vs ${qA[0]}`);

  {
    const qWas = { on: AI.on, side: AI.side, fast: AI.fast, level: AI.level };
    blank(0, { mode: "ai" });
    put(rc(5, 4), 0); put(rc(9, 0), 0); put(rc(1, 6), 1); put(rc(0, 1), 1);
    G.turn = 0; G.phase = "declare";
    G.players[0].fp = 10; G.players[0].hand = ["quantum"];
    AI.on = true; AI.fast = true; AI.side = 0; AI.level = "skilled"; AI.thinking = false;
    const qC = aiSpellCandidates("declare").filter((c) => c.id === "quantum");
    ok("the machine is offered the gamble, carrying its own worth",
      qC.length > 0 && qC.every((c) => c.bonus === QUANTUM_GAMBIT), qC.length);
    ok("...and takes it", aiCastOnce("declare")
      && G.board.filter((p) => p && p.quantum).length === 2);
    AI.on = qWas.on; AI.side = qWas.side; AI.fast = qWas.fast; AI.level = qWas.level;
  }

  group("Temporal Twin");
  blank(0, { mode: "local" });
  put(rc(5, 4), 0); put(rc(1, 6), 1); put(rc(1, 8), 1);
  G.turn = 0; G.phase = "declare";
  G.players[0].fp = 9; G.players[0].hand = ["twin"];
  const tSpot = quantumSpots(rc(5, 4))[0];
  castSpell("twin", 0, { target: rc(5, 4), spot: tSpot });
  ok("both bodies are real pieces", countPieces(0) === 2, countPieces(0));
  ok("...sharing one link", G.board[rc(5, 4)].twin === G.board[tSpot].twin);
  ok("...and nothing about it is private",
    G.log.filter((l) => /stands on both/.test(l.text)).every((l) => l.only == null));

  // The machine does not end its turn through the referee, so aiFinishMove is
  // the only thing that will ever take the second movement for it.
  {
    const tWas = { on: AI.on, side: AI.side, fast: AI.fast, level: AI.level };
    AI.on = true; AI.fast = true; AI.side = 0; AI.level = "skilled"; AI.thinking = false;
    const tA = rc(5, 4);
    const tMv = legalMovesFor(tA)[0];
    performMove(tA, tMv);
    ok("after one body moves, the other owes a move", G.twinStep != null, G.twinStep);
    aiFinishMove();
    ok("...and the machine takes it rather than walking away",
      G.twinStep === null, G.twinStep);
    ok("...leaving both bodies still on the board", countPieces(0) === 2, countPieces(0));

    blank(0, { mode: "local" });
    put(rc(5, 4), 0); put(rc(9, 0), 0); put(rc(1, 6), 1); put(rc(0, 1), 1);
    G.turn = 0; G.phase = "declare";
    G.players[0].fp = 10; G.players[0].hand = ["twin"];
    AI.side = 0;
    const tC = aiSpellCandidates("declare").filter((c) => c.id === "twin");
    ok("the machine is offered the pairing, carrying the tempo it cannot search",
      tC.length > 0 && tC.every((c) => c.bonus === TWIN_TEMPO), tC.length);
    ok("...and takes it", aiCastOnce("declare")
      && G.board.filter((p) => p && p.twin).length === 2);
    AI.on = tWas.on; AI.side = tWas.side; AI.fast = tWas.fast; AI.level = tWas.level;
  }

  // The evaluator may read the pairing freely — it is public — but should
  // price the shared life against it.
  blank(0, { mode: "local" });
  put(rc(5, 4), 0); put(rc(4, 3), 0); put(rc(1, 6), 1);
  const tPlain = sideScore(0);
  G.board[rc(5, 4)].twin = 8; G.board[rc(4, 3)].twin = 8;
  ok("a twinned pair is worth less than two loose pawns, because one jump takes both",
    sideScore(0) < tPlain, `${sideScore(0)} vs ${tPlain}`);

  group("Chronos's Gaze");
  blank(0);
  put(rc(6, 5), 0); put(rc(9, 2), 0); put(rc(2, 5), 1);
  G.players[0].hand = ["chronos", "evasive", "veil", "eye"];
  G.players[0].fp = 9;
  G.turnNo = 0;
  beginTurn(0);                                    // Gold turn 1, snapshot taken
  const fpAtStart = G.players[0].fp;
  performMove(rc(6, 5), simpleMoves(rc(6, 5))[0]); // Gold commits a move
  const movedTo = G.lastMove.to;
  endTurnLocal();                                       // Violet's turn
  endTurnLocal();                                       // back to Gold
  castSpell("chronos", 0, {});
  ok("the board returns to the earlier position", !!G.board[rc(6, 5)] && !G.board[movedTo]);
  ok("Focus Points rewind too", G.players[0].fp === fpAtStart, G.players[0].fp);
  ok("the Chronos card stays spent", !G.players[0].hand.includes("chronos"));
  ok("Chronal Backlash leaves exactly one card", G.players[0].hand.length === 1, G.players[0].hand.length);
  ok("play resumes with the caster", G.turn === 0 && G.phase === "declare");

  blank(0);
  put(rc(6, 5), 0); put(rc(2, 5), 1);
  G.players[0].hand = ["chronos"];
  G.players[0].fp = 9;
  G.turnNo = 0;
  beginTurn(0);                                     // Gold turn 1, snapshot taken
  performMove(rc(6, 5), simpleMoves(rc(6, 5))[0]);   // Gold's 1st move
  const firstTo = G.lastMove.to;
  endTurnLocal(); endTurnLocal();                    // Violet, then back to Gold turn 2
  performMove(firstTo, simpleMoves(firstTo)[0]);     // Gold's 2nd move
  const secondTo = G.lastMove.to;
  endTurnLocal(); endTurnLocal();                    // Violet, then back to Gold turn 3
  const opts = chronosTargets(0);
  ok("two of the caster's own turns are offered when two are behind", opts.length === 2, opts.length);
  castSpell("chronos", 0, { turnNo: opts[1] });
  ok("rewinding 2 turns undoes both moves, not just the last one",
    !!G.board[rc(6, 5)] && !G.board[firstTo] && !G.board[secondTo]);

  /* ── Martyr's Pledge ───────────────────────────────────────────────── */
  group("The Martyr's Pledge");
  blank();
  G.players[0].fp = 9;
  G.players[0].hand = ["martyr"];
  G.players[0].lostQueens = [{ form: null }];
  put(rc(11, 0), 0);
  G.turn = 0; G.phase = "declare";
  castSpell("martyr", 0, { sacrifice: rc(11, 0) });
  ok("a queen rises where the pawn fell",
    G.board[rc(11, 0)] && G.board[rc(11, 0)].rank === "queen");
  ok("the revived queen is on probation", G.players[0].martyrWatch != null);
  removePiece(rc(11, 0), "test");
  ok("losing her before a new queen bans the card", G.players[0].martyrBanned === true);

  /* ── blockade ──────────────────────────────────────────────────────── */
  group("Win conditions");
  blank();
  put(rc(6, 5), 0);
  ok("a lone side with no opposition still has moves", hasAnyMove(0));
  blank();
  put(rc(0, 1), 0, "queen", { form: "alchemist" });
  put(rc(5, 4), 1);
  ok("a side of nothing but Alchemists cannot move", !hasAnyMove(0));
  blank();
  put(rc(5, 4), 1);
  G.turnNo = 0;
  beginTurn(0);
  ok("a side with no pieces loses", G.over && G.over.winner === 1, JSON.stringify(G.over));

  blank();
  put(rc(6, 5), 0, "queen", { form: "alchemist" });
  put(rc(6, 7), 0, "queen", { form: "alchemist" });
  put(rc(2, 3), 1);
  ok("a side left with nothing but Alchemists loses",
    checkGameOver() && G.over.winner === 1, JSON.stringify(G.over));
  blank();
  put(rc(6, 5), 0, "queen", { form: "alchemist" });
  put(rc(9, 2), 0);
  put(rc(2, 3), 1);
  ok("...but one piece that can still move keeps you alive", !checkGameOver() && !G.over);
  blank();
  put(rc(6, 5), 0, "queen", { form: "alchemist" });
  put(rc(9, 2), 0);
  put(rc(6, 7), 1, "queen", { form: "alchemist" });
  put(rc(2, 3), 1);
  ok("...and an Alchemist is no liability while the rest of the army marches",
    !checkGameOver() && !G.over);

  /* ── automatic turn passing ────────────────────────────────────────── */
  group("Automatic turn passing");
  blank();
  put(rc(6, 5), 0);
  put(rc(1, 0), 1);
  G.turn = 0; G.phase = "declare";
  G.players[0].fp = 0; G.players[0].hand = []; G.removed = SPELL_IDS.slice();
  const passed = applyAction(0, { t: "move", from: rc(6, 5), to: rc(5, 4), kind: "step" });
  ok("a move that leaves nothing else to do passes the turn itself",
    G.turn === 1, `turn ${G.turn}, phase ${G.phase}`);
  ok("...and reports the handover, so the curtain still rises",
    passed.ok === true && passed.autoPassed === true && "sameSeat" in passed, JSON.stringify(passed));
  ok("...and says why in the log", G.log.some((l) => /nothing left to do/.test(l.text)));

  blank();
  put(rc(6, 5), 0);
  put(rc(1, 0), 1);
  G.turn = 0; G.phase = "declare";
  // rc(5,4) sits on the enemy half, so once the pawn steps there Herald is a
  // legal (spell-based) transformation — the affordable option this test needs.
  G.players[0].fp = 9; G.players[0].hand = ["heraldSpell"];
  applyAction(0, { t: "move", from: rc(6, 5), to: rc(5, 4), kind: "step" });
  ok("a turn with a transformation still affordable is left alone",
    G.turn === 0 && G.phase === "end", `turn ${G.turn}, phase ${G.phase}`);

  blank();
  put(rc(6, 5), 0);
  put(rc(1, 0), 1);
  G.turn = 0; G.phase = "declare";
  G.players[0].fp = 0; G.players[0].hand = [];
  applyAction(0, { t: "move", from: rc(6, 5), to: rc(5, 4), kind: "step" });
  ok("...and a drawable pool is not an option once you have moved",
    G.turn === 1, `turn ${G.turn}`);

  /* ── the Focus Point ceiling ───────────────────────────────────────── */
  group("The Focus Point ceiling");
  blank();
  put(rc(6, 5), 0); put(rc(1, 0), 1);
  G.players[0].fp = FP_CAP - 1;
  awardFP(0, 5, "a test");
  ok(`the pool stops at ${FP_CAP}`, G.players[0].fp === FP_CAP, G.players[0].fp);
  ok("...and the wasted income is announced", G.log.some((l) => /is full at/.test(l.text)));
  G.players[0].fp = 4;
  awardFP(0, 3, "a test");
  ok("...while income below the ceiling is paid in full", G.players[0].fp === 7, G.players[0].fp);

  blank();
  put(rc(6, 5), 0); put(rc(1, 0), 1);
  G.players[0].fp = 0; G.players[0].hand = [];
  drawSpell(0);
  ok("drawing a card pays no Focus", G.players[0].fp === 0, G.players[0].fp);
  ok("...the card itself is the payment", G.players[0].hand.length === 1);

  blank();
  put(rc(0, 1), 0, "queen", { form: "alchemist" });
  put(rc(9, 2), 0);
  put(rc(1, 0), 1);
  G.players[0].fp = FP_CAP; G.turnNo = 0;
  beginTurn(0);
  ok("an Alchemist cannot print Focus past the ceiling either",
    G.players[0].fp === FP_CAP, G.players[0].fp);

  blank();
  put(rc(6, 5), 0); put(rc(1, 0), 1);
  G.players[0].fp = 0; G.players[0].turnsTaken = 0; G.turnNo = 0;
  beginTurn(0); const drip1 = G.players[0].fp;
  beginTurn(0); const drip2 = G.players[0].fp;
  beginTurn(0); const drip3 = G.players[0].fp;
  ok("the passive drip pays on your first turn", drip1 === 1, drip1);
  ok("...skips your second", drip2 === 1, drip2);
  ok("...and pays again on your third", drip3 === 2, drip3);
  ok("...so waiting earns half what it used to, and fighting earns the rest",
    drip3 === 2 && G.players[1].fp === 0);

  /* ── board orientation ─────────────────────────────────────────────── */
  group("Board orientation");
  const seatWas = { net: NET.on, seat: NET.seat, ai: AI.on, side: AI.side,
                    revealed: UI.revealed, turn: G.turn };

  // Regression: the entry point builds the board before the first game exists.
  // A predicate that reaches through G or UI there throws before wire() runs,
  // and the page comes up dead — an empty grid with no click handlers.
  const gWas = G, uiWas = UI;
  G = null; UI = null;
  ok("the predicate survives the first build, before any game exists",
    boardFlipped() === false);
  G = gWas; UI = uiWas;

  // Hot-seat. The curtain is what times the turn-around.
  NET.on = false; AI.on = false;
  G.turn = 0; UI.revealed = true;
  ok("hot-seat: Gold plays the board the way it is drawn", boardFlipped() === false);
  G.turn = 1; UI.revealed = false;
  ok("...it does not turn while the curtain is still up", boardFlipped() === false);
  UI.revealed = true;
  ok("...and turns around the moment Violet lifts it", boardFlipped() === true);
  buildBoard();
  ok("...so Violet's home row is drawn at the bottom",
    Number($("board").firstChild.dataset.i) === CELLS - 1 && Number($("board").lastChild.dataset.i) === 0);
  ok("...while every lookup stays indexed by board square, not by seat",
    CELL_NODES.every((n, i) => Number(n.dataset.i) === i));
  G.turn = 0;
  ok("...and it turns back when the device returns to Gold", boardFlipped() === false);

  // Facing the machine, the seat never changes hands, so neither does the board.
  AI.on = true; AI.side = 0; UI.revealed = true;
  ok("vs the machine: playing Violet puts your own pieces on the near side",
    boardFlipped() === true);
  AI.side = 1;
  ok("...and playing Gold leaves the board alone", boardFlipped() === false);

  // Online is decided by your seat alone and never consults the curtain.
  AI.on = false; NET.on = true; NET.seat = 1; UI.revealed = false;
  ok("online: Violet's board is turned regardless of the curtain flag",
    boardFlipped() === true);
  NET.seat = 0;
  ok("...and Gold's own board is never turned", boardFlipped() === false);

  // Watching two machines, viewSeat() follows the turn — so a board that faced
  // it would spin a half-turn every handover, twice a round, for the whole game.
  NET.on = false; AI.on = true; AI.duel = ["skilled", "skilled"]; UI.revealed = true;
  G.turn = 0;
  ok("watching: the board is not turned for Gold's turn", boardFlipped() === false);
  G.turn = 1;
  ok("...and does not spin round when the machines hand over", boardFlipped() === false);
  AI.duel = null;

  NET.on = seatWas.net; NET.seat = seatWas.seat; AI.on = seatWas.ai; AI.side = seatWas.side;
  UI.revealed = seatWas.revealed; G.turn = seatWas.turn;
  buildBoard();

  /* ── concealment ───────────────────────────────────────────────────────
     viewFor() covers the wire, and test/engine.test.js §9 proves it. What it
     cannot cover is the game against the MACHINE, where there is no wire: the
     browser holds the real G, so the client has to do its own filtering or
     the machine's secrets render straight onto the screen of the player they
     are being kept from. These are that second copy.
     ─────────────────────────────────────────────────────────────────── */
  group("Concealment on this device");
  {
    const cWas = { net: NET.on, seat: NET.seat, ai: AI.on, side: AI.side, turn: G.turn };
    blank(0, { mode: "ai" });
    // Playing Gold against the machine: viewSeat() is 0, and seat 1 is the
    // machine, whose private lines and effects must not reach this screen.
    NET.on = false; AI.on = true; AI.side = 1; G.turn = 0;
    ok("vs the machine the device speaks for one seat only", viewSeat() === 0, viewSeat());

    log("a line for everyone", "sys");
    log("a line only Gold may read", "rule", 0);
    log("a line only the machine may read", "rule", 1);
    const cSeen = visibleLog().map((l) => l.text);
    ok("the log keeps the public lines", cSeen.includes("a line for everyone"));
    ok("...and your own private ones", cSeen.includes("a line only Gold may read"));
    ok("...and drops the machine's", !cSeen.includes("a line only the machine may read"));

    // The transcript, the second channel. FX.pump is what drains G.fx onto the
    // board, so the filter has to hold there rather than in the recipes.
    const cEnabled = FX.enabled, cMode = FX.mode, cRun = FX.run, cQueued = [];
    FX.reset();
    FX.mode = "normal";
    FX.enabled = () => true;
    FX.run = () => {};                       // never actually paint in a test
    G.fx = [
      { n: 1, type: "spell", id: "veil", caster: 1 },
      { n: 2, type: "hollow", at: rc(5, 4), only: 1 },
    ];
    FX.pump();
    for (const e of FX.queue) cQueued.push(e.type);
    ok("the transcript queues the machine's public effect", cQueued.includes("spell"));
    ok("...and never queues the one addressed to the machine alone",
      !cQueued.includes("hollow"), cQueued.join(","));
    ok("...while the high-water mark still clears the whole batch, so a withheld effect cannot resurface",
      FX.seen === 2, FX.seen);

    /* And the sandbox, which redacts nothing — one person is driving both
       chairs, so a line or a marker withheld from "the other player" would
       simply never be seen by anyone. This is the regression that shipped
       first: the concealment cards were gated out of the one mode built for
       trying cards out. */
    // beginTurn is what stocks the sandbox — devStockHands runs from there,
    // not from newGame. And renderBoard rather than render(): the suite stubs
    // render() out at the top so the engine can be driven headlessly.
    G = newGame(0, 42, { dev: true, mode: "local" });
    UI = freshUI();
    NET.on = false; AI.on = false;
    G.turnNo = 0;
    beginTurn(0);
    ok("the workbench holds every card there is",
      G.players[0].hand.length === SPELL_IDS.length, G.players[0].hand.length);
    for (const cId of ["stutter", "pressure", "hollow", "quantum", "twin"])
      ok(`...including ${SPELLS[cId].name}`, G.players[0].hand.includes(cId));

    log("a sandbox line for one seat only", "rule", 0);
    G.turn = 1;
    ok("...and hides no log line from the other chair",
      visibleLog().some((l) => l.text === "a sandbox line for one seat only"));

    G.turn = 0;
    const cH = hollowTargets(0)[0];
    castSpell("hollow", 0, { target: cH });
    const cMarks = () => document.querySelectorAll("#board .piece.hollow").length;
    renderBoard();
    const cOwnerSees = cMarks();
    G.turn = 1; renderBoard();
    ok("...nor a decoy marker, from either chair",
      cOwnerSees === 1 && cMarks() === 1, `${cOwnerSees} then ${cMarks()}`);

    // The same cast in a real hot-seat game must still be hidden. If this ever
    // starts matching the sandbox, the exemption has leaked into real play.
    G = newGame(0, 42, { mode: "local" });
    UI = freshUI();
    G.players[0].fp = 9; G.players[0].hand = ["hollow"]; G.phase = "declare"; G.turn = 0;
    castSpell("hollow", 0, { target: hollowTargets(0)[0] });
    renderBoard();
    const cLiveOwner = cMarks();
    G.turn = 1; renderBoard();
    ok("outside the sandbox the decoy is still the owner's alone",
      cLiveOwner === 1 && cMarks() === 0, `${cLiveOwner} then ${cMarks()}`);

    FX.enabled = cEnabled; FX.mode = cMode; FX.run = cRun;
    FX.reset();
    NET.on = cWas.net; NET.seat = cWas.seat; AI.on = cWas.ai; AI.side = cWas.side; G.turn = cWas.turn;
  }

  /* ── the exhibition ────────────────────────────────────────────────────
     Two machines, one screen, nobody playing. Almost everything that can go
     wrong here is a thing that reads AI.side or AI.level and gets an answer
     about the WRONG SEAT — during a duel those two name whoever is thinking,
     not a fixed side, and every one of the tests below failed at least once
     while that was being sorted out.
     ─────────────────────────────────────────────────────────────────── */
  group("Watching two machines");
  {
    const dWas = { on: AI.on, side: AI.side, level: AI.level, fast: AI.fast,
                   duel: AI.duel, paused: AI.paused, watch: AI.watch,
                   fxRate: FX.rate, net: NET.on };
    const pair = ["novice", "skilled"];
    G = newGame(0, 42, { mode: "ai" });
    UI = freshUI();
    G.turnNo = 0;
    beginTurn(0);
    NET.on = false;
    AI.on = true; AI.fast = true; AI.paused = false; AI.thinking = false;
    AI.duel = pair; AI.side = 0; AI.level = pair[0];

    ok("both chairs are machine seats", isAISeat(0) && isAISeat(1));
    ok("...and neither of them is driven from this device",
      !iDrive(0) && !iDrive(1));
    ok("...which is what the interface asks before offering anything to click",
      isDuel() === true && spectating() === true);

    // The bug this exists for: a strip that reports AI.level answers with the
    // level of whoever is mid-search, so both machines wear one name.
    ok("each seat is described by its own brain, not by the one thinking",
      aiNameFor(0) === "Novice" && aiNameFor(1) === "Skilled",
      `${aiNameFor(0)} / ${aiNameFor(1)}`);
    AI.side = 1; AI.level = "skilled";                 // as if Violet were on move
    ok("...and still is while the other one has the chair",
      aiNameFor(0) === "Novice" && aiNameFor(1) === "Skilled",
      `${aiNameFor(0)} / ${aiNameFor(1)}`);
    AI.side = 0; AI.level = pair[0];

    renderPlayers();
    const dNames = [...document.querySelectorAll("#players .nm")].map((n) => n.textContent);
    ok("...which is what the player strips print",
      dNames[0].includes("Novice") && dNames[1].includes("Skilled"), dNames.join(" | "));
    const dFp = [...document.querySelectorAll("#players .fp")].map((n) => n.firstChild.textContent);
    ok("...and a spectator is shown both Focus pools, neither of them blanked",
      dFp.every((t) => t !== "—"), dFp.join(" / "));

    // The turn-by-turn hand-over. Written against G.turn rather than assuming
    // strict alternation, because Temporal Cascade can keep a seat twice.
    const dSeen = [];
    for (let t = 0; t < 4 && !G.over; t++) {
      const who = G.turn;
      aiRunTurn();
      dSeen.push({ who, side: AI.side, level: AI.level });
    }
    ok("the brain in the chair is always the one that owns the seat on move",
      dSeen.length === 4 && dSeen.every((r) => r.side === r.who && r.level === pair[r.who]),
      dSeen.map((r) => `${r.who}:${r.side}/${r.level}`).join(" "));
    ok("...so both machines actually got to play",
      new Set(dSeen.map((r) => r.who)).size === 2);
    ok("...and four turns of it went by without either one throwing",
      G.turnNo > 0 && dSeen.length === 4);

    // Pause is a hard stop, not a request: the next beat must not start.
    duelPause();
    const dPausedTurn = G.turn;
    aiTakeTurn();
    ok("pausing stops the next turn from starting at all",
      AI.paused === true && AI.thinking === false && G.turn === dPausedTurn);
    duelResume();
    ok("...and resuming clears the flag", AI.paused === false);
    // Resuming scheduled a real beat. The suite is synchronous and about to
    // replace G, so that beat must be made a no-op before it can wake up.
    aiCancel();

    /* The speed control, and the one line it must never cross. Playing an
       exhibition back faster is a presentation choice; a machine given less
       time to think is a WEAKER machine, and a Ruthless mirror that quietly
       played at Skilled strength because the watcher pressed 4× would be
       measuring nothing. So this pins every search and policy budget. */
    const dBudgets = () => AI_ORDER.map((l) => {
      const L = AI_LEVELS[l];
      return [L.depth, L.timeMs, L.policyDepth, L.policyMs, L.policyBudget, L.noise, L.qply].join("/");
    }).join(" ");
    const dWatchWas = AI.watch, dBudgetsWas = dBudgets(), dRateWas = watchRate();
    watchCycle();
    ok("the watch speed shortens the gaps between the machine's beats",
      watchRate() < dRateWas, `${dRateWas} → ${watchRate()}`);
    ok("...and shortens the animations by exactly as much, so nothing outruns them",
      FX.rate === watchRate(), `FX.rate ${FX.rate}`);
    ok("...and does not touch one search or policy budget on any level",
      dBudgets() === dBudgetsWas, dBudgets());
    // One step was already taken above, so this completes the lap.
    for (let k = 0; k < WATCH_SPEEDS.length - 1; k++) watchCycle();
    ok("...and cycles back round to where it started",
      AI.watch === dWatchWas && watchRate() === dRateWas, `${AI.watch} vs ${dWatchWas}`);
    AI.duel = null;
    ok("...while outside an exhibition it never scales anything at all",
      watchRate() === 1);
    AI.duel = pair; AI.watch = dWatchWas; watchApply();

    // Nothing is kept back from someone who is not in the game. Both machines
    // are blind to this screen, so a redacted spectator view would be hiding
    // the game from the only eyes in the room.
    log("a line only Gold's machine may read", "rule", 0);
    log("a line only Violet's machine may read", "rule", 1);
    const dLog = visibleLog().map((l) => l.text);
    ok("a spectator's log keeps both machines' private lines",
      dLog.includes("a line only Gold's machine may read")
      && dLog.includes("a line only Violet's machine may read"));

    // And the same for the board markers, which is the interesting half: a
    // Hollow Shell hidden from the watcher is a bluff nobody ever sees land.
    G = newGame(0, 42, { mode: "ai" });
    UI = freshUI();
    G.players[0].fp = 9; G.players[0].hand = ["hollow"]; G.phase = "declare"; G.turn = 0;
    castSpell("hollow", 0, { target: hollowTargets(0)[0] });
    G.players[1].fp = 9; G.players[1].hand = ["hollow"]; G.phase = "declare"; G.turn = 1;
    castSpell("hollow", 1, { target: hollowTargets(1)[0] });
    renderBoard();
    ok("...and both decoys are marked on the board, whichever machine is on move",
      document.querySelectorAll("#board .piece.hollow").length === 2,
      document.querySelectorAll("#board .piece.hollow").length);

    // Both hands in the one panel, since the seat it used to show belongs to
    // nobody here.
    G.players[0].hand = ["evasive"]; G.players[1].hand = ["mirror"];
    renderHand();
    ok("the hand panel carries both hands, named and separated",
      document.querySelectorAll("#hand .handside").length === 2
      && document.querySelectorAll("#hand .card").length === 2,
      `${document.querySelectorAll("#hand .handside").length} labels, `
      + `${document.querySelectorAll("#hand .card").length} cards`);
    ok("...and every card in it is unclickable, because neither hand is yours",
      [...document.querySelectorAll("#hand .card")].every((b) => b.disabled));

    AI.on = dWas.on; AI.side = dWas.side; AI.level = dWas.level; AI.fast = dWas.fast;
    AI.duel = dWas.duel; AI.paused = dWas.paused; AI.watch = dWas.watch;
    NET.on = dWas.net; FX.rate = dWas.fxRate;
    AI.thinking = false;
  }

  /* ── the machine ───────────────────────────────────────────────────── */
  group("The machine — search");
  // The link fields belong in here, not just the material ones. A make/unmake
  // that quietly forgot to put a `twin` id back would have left this silent —
  // which is most of why the search went so long without modelling the card.
  const fingerprint = () => G.board.map((p, i) =>
    p ? `${i}:${p.id}:${p.owner}:${p.rank}:${p.form}:${p.armor ? 1 : 0}:${p.captures}`
      + `:${p.twin}:${p.quantum}:${p.hollow ? 1 : 0}` : "").join("|");

  blank();
  AI.side = 0;
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(4, 5), 1); put(rc(4, 9), 1);
  put(rc(2, 3), 0); put(rc(9, 0), 0); put(rc(5, 8), 0, "queen"); put(rc(1, 2), 1, "pawn", { armor: true });
  // A twinned pair and a superposition, both under the axe. The position used
  // to hold neither, which is exactly how applyStep went so long without
  // knowing what either card does.
  put(rc(9, 6), 0); put(rc(8, 7), 1, "pawn", { twin: 501 }); put(rc(3, 6), 1, "pawn", { twin: 501 });
  put(rc(9, 10), 0); put(rc(8, 9), 1, "pawn", { quantum: 77 }); put(rc(3, 8), 1, "pawn", { quantum: 77 });
  const fp0 = fingerprint();
  aiNewSearch();
  const h0 = AI_HASH;
  let corrupt = 0, tried = 0, drift = 0;
  for (const m of turnMoves(0)) {
    const r = applySeq(m.steps);
    // The hash is kept up to date a few squares at a time. Whether it still
    // agrees with the whole board is the only question worth asking about it,
    // and the answer has to be yes mid-move as well as after the undo.
    if (AI_HASH !== boardHash()) drift++;
    undoSeq(r);
    tried++;
    if (fingerprint() !== fp0) corrupt++;
    if (AI_HASH !== h0) drift++;
  }
  ok(`make/unmake is reversible across all ${tried} turn moves`, tried > 0 && corrupt === 0, corrupt + " corrupted");
  ok("...and the incremental hash tracks the board through every one of them",
    drift === 0, `${drift} disagreements`);

  AI.side = 0; AI.level = "skilled"; AI.fast = true;
  AI_TIMEUP = false; AI_DEADLINE = performance.now() + 2000;
  aiNewSearch();                    // calling alphabeta directly means declaring a search
  alphabeta(0, 4, -Infinity, Infinity, 0);
  ok("a full depth-4 search leaves the board untouched", fingerprint() === fp0);
  ok("...and the incremental hash comes back to what the board says it is",
    AI_HASH === boardHash(), `${AI_HASH} vs ${boardHash()}`);

  /* ── the two cards the search used to be blind to ──────────────────────
     Temporal Twin is obeyed outright: it is public information, and a jump
     that takes one body takes both. Quantum Pawn cannot be obeyed without
     reading which half is real, so it is modelled by what is true either way
     — the struck square empties, the far half stands, and the chain stops.
     ─────────────────────────────────────────────────────────────────── */
  blank();
  AI.side = 0;
  put(rc(9, 6), 0);
  put(rc(8, 7), 1, "pawn", { twin: 501 });          // the body under the axe
  put(rc(3, 6), 1, "pawn", { twin: 501 });          // its far half, nowhere near the jump
  const twinFp = fingerprint();
  const twinBefore = evaluate(0);
  const twinRecs = applySeq(turnMoves(0)[0].steps);
  const twinGain = evaluate(0) - twinBefore;
  const twinLeft = G.board.filter((p) => p && p.owner === 1).length;
  undoSeq(twinRecs);
  ok("one jump on a twinned pair takes both bodies", twinLeft === 0, `${twinLeft} left`);
  ok("...so it is worth about two pawns, not one", twinGain > VAL_PAWN * 1.5, twinGain);
  ok("...and undo puts both of them back, links and all", fingerprint() === twinFp);

  // The control. Same two pawns, same jump, no link — one body dies.
  blank();
  AI.side = 0;
  put(rc(9, 6), 0); put(rc(8, 7), 1); put(rc(3, 6), 1);
  const loneBefore = evaluate(0);
  const loneRecs = applySeq(turnMoves(0)[0].steps);
  const loneGain = evaluate(0) - loneBefore;
  undoSeq(loneRecs);
  ok("...while the same jump on an unlinked pawn is worth strictly less",
    loneGain < twinGain, `${loneGain} vs ${twinGain}`);

  blank();
  AI.side = 0;
  put(rc(9, 6), 0); put(rc(8, 7), 1); put(rc(6, 9), 1);
  const chainPlain = turnMoves(0);
  ok("a two-hop chain over ordinary pawns is generated whole",
    chainPlain.length === 1 && chainPlain[0].steps.length === 2,
    JSON.stringify(chainPlain.map((m) => m.steps.length)));

  blank();
  AI.side = 0;
  put(rc(9, 6), 0); put(rc(6, 9), 1);
  put(rc(8, 7), 1, "pawn", { quantum: 77 }); put(rc(3, 6), 1, "pawn", { quantum: 77 });
  const chainQ = turnMoves(0);
  ok("...but the same chain stops dead at a superposition, which may take nothing",
    chainQ.length === 1 && chainQ[0].steps.length === 1,
    JSON.stringify(chainQ.map((m) => m.steps.length)));
  const qRecs = applySeq(chainQ[0].steps);
  ok("the struck half leaves the board — true whether or not it was ever there",
    G.board[rc(8, 7)] === null);
  ok("...while the far half stands, still superposed, still worth half a pawn",
    G.board[rc(3, 6)] != null && G.board[rc(3, 6)].quantum === 77);
  undoSeq(qRecs);

  // And the blindness contract, on the one card that has a secret to leak.
  G.board[rc(8, 7)].quantumReal = true;  G.board[rc(3, 6)].quantumReal = false;
  const qSeenA = `${evaluate(0)}|${JSON.stringify(turnMoves(0).map((m) => m.steps.length))}`;
  G.board[rc(8, 7)].quantumReal = false; G.board[rc(3, 6)].quantumReal = true;
  const qSeenB = `${evaluate(0)}|${JSON.stringify(turnMoves(0).map((m) => m.steps.length))}`;
  ok("which half is real changes nothing the machine can see",
    qSeenA === qSeenB, `${qSeenA} vs ${qSeenB}`);

  /* ── a trade you cannot decline ────────────────────────────────────────
     The queen has exactly one jump, it wins a pawn, and it loses the queen to
     the recapture. Quiescence used to stand pat here — assume the side to move
     could simply not capture — and so scored the position as though the trade
     were optional. It is not; captures are compulsory. Every trap that works
     by making a bad jump mandatory read as free.
     ─────────────────────────────────────────────────────────────────── */
  blank();
  AI.side = 0; AI.level = "skilled";
  put(rc(9, 6), 0, "queen");             // the only piece on the board with a jump
  put(rc(8, 7), 1);                      // the bait
  put(rc(6, 7), 1);                      // waiting to take the queen back
  put(rc(5, 6), 0);                      // and blocking the queen from chaining onto it
  const forced = turnMoves(0);
  ok("the trap offers exactly one capture, and no way to decline it",
    forced.length === 1 && forced[0].capture && forced[0].steps.length === 1,
    JSON.stringify(forced.map((m) => m.steps.length)));
  AI_TIMEUP = false; AI_DEADLINE = performance.now() + 2000;
  const forcedStatic = evaluate(0);
  const forcedQ = quiesce(0, -Infinity, Infinity, 0);
  ok("...so a pawn bought with a queen scores below simply standing there",
    forcedQ < forcedStatic, `quiescence ${forcedQ} vs static ${forcedStatic}`);
  // Not the full queen-minus-pawn: the recapturing pawn walks two rows further
  // from its own crown to do it, and the evaluator charges it for that. A whole
  // pawn of loss is the claim worth pinning — it is a material verdict, not a
  // rounding wobble.
  ok("...by more than a pawn's worth", forcedStatic - forcedQ > VAL_PAWN,
    forcedStatic - forcedQ);

  /* ── a win found inside the flurry ─────────────────────────────────────
     The chain takes both remaining enemy pieces. alphabeta has always called
     that mate; quiescence called it a material lead, which is a thing you can
     be talked out of in exchange for material.
     ─────────────────────────────────────────────────────────────────── */
  blank();
  AI.side = 0; AI.level = "skilled";
  put(rc(9, 6), 0); put(rc(8, 7), 1); put(rc(6, 9), 1);
  AI_TIMEUP = false; AI_DEADLINE = performance.now() + 2000;
  const wipe = quiesce(0, -Infinity, Infinity, 0);
  ok("a chain that sweeps the last enemy piece scores as a win, not as material",
    wipe > MATE / 2, wipe);
  // And the distance is measured from the root, so the faster kill wins. The
  // same flurry entered three plies deeper must score strictly lower.
  AI_TIMEUP = false; AI_DEADLINE = performance.now() + 2000;
  const wipeLater = quiesce(0, -Infinity, Infinity, 0, 3);
  ok("...and a win three plies further off is worth strictly less",
    wipeLater < wipe && wipeLater > MATE / 2, `${wipeLater} vs ${wipe}`);

  /* ── search honestly, choose sloppily ──────────────────────────────────
     The jitter that makes the easier levels beatable used to be added to the
     score before that score became the alpha bound for every later root move,
     and it re-rolled at every deepening iteration. Neither is a blunder rate;
     both are just incoherence. What follows pins the separation rather than
     the blunder rate itself — a run-count test of "chooses well most of the
     time" is a coin-flip test, and would fail on Fridays.
     ─────────────────────────────────────────────────────────────────── */
  blank();
  AI.side = 0; AI.fast = true;
  put(rc(9, 2), 0); put(rc(9, 6), 0); put(rc(2, 3), 1); put(rc(2, 7), 1);

  // A level with the jitter off and time to spare, so nothing but the search
  // itself can differ between two runs. Ruthless would do, but its clock would
  // be the variable instead.
  AI_LEVELS.__fixed = { ...AI_LEVELS.ruthless, depth: 3, timeMs: 5000, noise: 0 };
  AI.level = "__fixed"; AI.fast = false;
  const fixA = searchBestMove(0), fixB = searchBestMove(0);
  ok("with the jitter off, two searches agree on the SCORE and not merely the move",
    fixA && fixB && fixA.score === fixB.score && fixA.move.from === fixB.move.from,
    `${fixA && fixA.score} vs ${fixB && fixB.score}`);
  delete AI_LEVELS.__fixed;
  AI.fast = true;

  // Every term in the evaluator is a whole number, so every honest search score
  // is one too. A fractional score is jitter that has got into the SEARCH
  // instead of the choice, which is exactly the bug this replaced.
  AI.level = "novice";
  const noisy = searchBestMove(0);
  ok("a level that blunders still reports a real search score, not a jittered one",
    noisy && Number.isInteger(noisy.score), noisy && noisy.score);

  // Beatable, though. Four moves worth about the same, and the jitter is what
  // decides between them, so it should not decide the same way every time.
  // Measured: the four come up almost exactly evenly over 60 runs, so sixteen
  // landing on one move is a one-in-a-billion event rather than a bad Friday.
  const picks = new Set();
  for (let i = 0; i < 16; i++) {
    const r = searchBestMove(0);
    if (r) picks.add(`${r.move.from}>${r.move.to}`);
  }
  ok("...and among near-equal moves it varies from run to run", picks.size > 1,
    [...picks].join(" "));

  // Beatable is not the same as random. Two jumps are on offer — one takes
  // three pawns, one takes a single — and ±38 of jitter is nowhere near two
  // pawns, so the triple must win every single time.
  blank();
  AI.side = 0; AI.level = "novice"; AI.fast = true;
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(4, 5), 1); put(rc(2, 5), 1); put(rc(1, 0), 1);
  put(rc(9, 8), 0); put(rc(8, 9), 1);
  let tookThree = 0;
  for (let i = 0; i < 8; i++) {
    const r = searchBestMove(0);
    if (r && r.move.steps.length === 3) tookThree++;
  }
  ok("...and it never blunders away a triple jump for a single one", tookThree === 8,
    `${tookThree}/8`);
  AI.level = "skilled";

  /* ── the transposition table ───────────────────────────────────────────
     It is allowed to change what a search COSTS. It is not allowed to change
     what the search concludes. A level with the jitter off and time to spare
     is used so that neither the clock nor the noise can be the thing that
     differs between the two runs.
     ─────────────────────────────────────────────────────────────────── */
  const ttSetups = [
    () => { put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(4, 5), 1); put(rc(4, 9), 1);
            put(rc(2, 3), 0); put(rc(9, 0), 0); put(rc(5, 8), 0, "queen");
            put(rc(1, 2), 1, "pawn", { armor: true }); },
    () => { put(rc(9, 2), 0); put(rc(9, 6), 0); put(rc(2, 3), 1); put(rc(2, 7), 1); },
    () => { put(rc(9, 6), 0); put(rc(11, 4), 0); put(rc(8, 7), 1); put(rc(6, 9), 1);
            put(rc(3, 6), 1); put(rc(4, 3), 1); },
  ];
  AI_LEVELS.__tt = { ...AI_LEVELS.ruthless, depth: 4, timeMs: 30000, noise: 0 };
  let ttAgree = 0, ttNodesOn = 0, ttNodesOff = 0;
  for (const setup of ttSetups) {
    blank();
    AI.side = 0; AI.level = "__tt"; AI.fast = false;
    setup();
    AI_TT = false; const off = searchBestMove(0); ttNodesOff += off.nodes;
    AI_TT = true;  const on = searchBestMove(0);  ttNodesOn += on.nodes;
    if (off.move.from === on.move.from && off.move.to === on.move.to
      && off.score === on.score) ttAgree++;
  }
  delete AI_LEVELS.__tt;
  AI.level = "skilled"; AI.fast = true; AI_TT = true;
  ok("the table changes what a search costs, not what it concludes",
    ttAgree === ttSetups.length, `${ttAgree}/${ttSetups.length} positions agreed`);
  ok("...and it costs a great deal less", ttNodesOn < ttNodesOff,
    `${ttNodesOn.toLocaleString()} nodes with the table, ${ttNodesOff.toLocaleString()} without`);

  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(4, 5), 1); put(rc(2, 5), 1); put(rc(1, 0), 1);
  const gen = turnMoves(0);
  ok("a triple jump is generated as ONE complete turn move",
    gen.length === 1 && gen[0].steps.length === 3, JSON.stringify(gen.map(g => g.steps.length)));
  ok("when captures exist, only captures are offered", gen.every((m) => m.capture));
  const chosen = searchBestMove(0);
  ok("the search takes the whole chain", chosen && chosen.move.steps.length === 3);

  blank();
  put(rc(6, 5), 0); put(rc(9, 0), 0); put(rc(1, 0), 1);
  ok("with no captures available, quiet moves are offered", turnMoves(0).every((m) => !m.capture));

  /* ── the evaluator, pinned ─────────────────────────────────────────────
     Three positions, and the exact numbers the evaluator gave for them. This
     group exists to make a SPEED-UP prove it is one: the mobility term was
     rewritten to stop allocating an array of move objects for every piece at
     every leaf, and an Enchanter's swap-with-anything mobility was turned from
     a scan of the whole board into a subtraction. Neither is allowed to move
     any of these six numbers by one point.

     If you are here because one of them failed, and you MEANT to change what
     the evaluator thinks: work out the new number, put it in, and say in the
     commit message which term moved and why. What must not happen is the
     numbers drifting while somebody was optimising.
     ─────────────────────────────────────────────────────────────────── */
  group("The machine — evaluation is pinned");
  blank(); AI.side = 0;
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(4, 5), 1); put(rc(4, 9), 1);
  put(rc(2, 3), 0); put(rc(9, 0), 0); put(rc(5, 8), 0, "queen"); put(rc(1, 2), 1, "pawn", { armor: true });
  ok("pawns, a queen and a suit of armor score exactly as they always have",
    sideScore(0) === 703 && sideScore(1) === 580 && evaluate(0) === 123,
    `${sideScore(0)}/${sideScore(1)}/${evaluate(0)}`);

  blank(); AI.side = 0;
  put(rc(7, 4), 0, "pawn", { form: "enchanter" }); put(rc(6, 5), 1); put(rc(4, 5), 1, "queen");
  put(rc(9, 0), 0); put(rc(2, 3), 0, "pawn", { form: "phaser" }); put(rc(1, 2), 1, "pawn", { form: "alchemist" });
  // Violet's piece here was a Sentinel until that card was retired; it is an
  // Alchemist now, which is why this row reads 50 points different from the
  // one recorded before the retirement — VAL_FORM prices the two at 45 and 95.
  ok("...and so do the transformations, the Enchanter's board-wide swap included",
    sideScore(0) === 656 && sideScore(1) === 609 && evaluate(0) === 47,
    `${sideScore(0)}/${sideScore(1)}/${evaluate(0)}`);

  blank(); AI.side = 0;
  put(rc(7, 4), 0, "pawn", { twin: 9 }); put(rc(5, 4), 0, "pawn", { twin: 9 });
  put(rc(6, 5), 1, "pawn", { quantum: 3 }); put(rc(4, 7), 1, "pawn", { quantum: 3 });
  put(rc(9, 0), 0, "pawn", { frozen: 2 }); put(rc(2, 3), 0, "pawn", { noCapture: 1, eyeMark: 2 });
  put(rc(1, 2), 1, "pawn", { armor: true, p_frozen: 1 });
  ok("...and the links, the freezes and the marks",
    sideScore(0) === 485 && sideScore(1) === 337 && evaluate(0) === 148,
    `${sideScore(0)}/${sideScore(1)}/${evaluate(0)}`);

  // The rift term counts neighbours instead of collecting them now, so it gets
  // a position of its own — it is the one term whose arithmetic changed shape.
  blank(); AI.side = 0;
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(4, 5), 1); put(rc(4, 9), 1);
  put(rc(2, 3), 0); put(rc(9, 0), 0); put(rc(5, 8), 0, "queen"); put(rc(1, 2), 1, "pawn", { armor: true });
  G.rift = { a: rc(6, 3), b: rc(3, 4), madeOn: 0 };
  ok("...and a rift is still priced by who stands beside its mouths",
    sideScore(0) === 715 && sideScore(1) === 586 && evaluate(0) === 129,
    `${sideScore(0)}/${sideScore(1)}/${evaluate(0)}`);

  group("The machine — fair play");
  blank();
  put(rc(6, 5), 0); put(rc(2, 3), 1);
  G.players[1].hand = ["evasive", "veil", "mirror"];
  const seen = evaluate(0);
  G.players[1].hand = ["chronos", "cascade", "martyr"];    // same SIZE, far better cards
  ok("evaluation ignores WHICH cards the opponent holds — only how many",
    evaluate(0) === seen, `${seen} vs ${evaluate(0)}`);
  G.players[1].hand = ["chronos", "cascade"];
  ok("...but does notice the hand shrinking", evaluate(0) !== seen);

  group("The machine — resource curve");
  ok("Focus Points show diminishing returns",
    resourceValue(20, 0) - resourceValue(19, 0) < resourceValue(2, 0) - resourceValue(1, 0));
  ok("cards show diminishing returns",
    resourceValue(0, 10) - resourceValue(0, 9) < resourceValue(0, 1) - resourceValue(0, 0));
  // Regression: with flat resource values the machine found that drawing beat
  // every quiet move and drew on literally every turn, never playing the board.
  const hoardGame = aiPlayGame("skilled", "skilled", 40, 20250804);
  const drewCount = G.log.filter((l) => l.text.includes("draws a spell")).length;
  const playedCount = G.log.filter((l) => / moves | jumps /.test(l.text)).length;
  ok("the machine plays the board instead of hoarding cards",
    playedCount > drewCount * 2, `${drewCount} draws vs ${playedCount} piece moves`);
  ok("...and both sides keep a sane hand size",
    G.players[0].hand.length <= 6 && G.players[1].hand.length <= 6,
    `${G.players[0].hand.length}/${G.players[1].hand.length}`);

  group("The machine — plays legally");
  const legalGame = aiPlayGame("skilled", "random", 60, 555);
  ok("a full headless game completes without throwing", legalGame.turns > 0);
  ok("every piece is still on a dark square", G.board.every((p, i) => !p || isDark(i)));
  ok("no side ever exceeded its Herald cap",
    countForm("herald", 0) <= 1 && countForm("herald", 1) <= 1);
  ok("the board-wide Phaser cap of 2 held", countForm("phaser") <= 2);
  ok("no piece carries two transformations",
    G.board.every((p) => !p || !p.form || FORMS[p.form]));

  /* ── the plan is re-checked against the board ──────────────────────────
     A turn is chosen under the search's model of the rules and played out one
     beat at a time under the referee's. When those part company — a quantum
     whiff, an enemy shell, an early promotion — what is left of the plan describes
     hops from squares that are now empty.

     The dangerous half is not the empty squares, which performMove ignores. It
     is that a promotion ends the SEQUENCE while leaving
     the jump sitting on the board, still playable. Replaying the plan through
     one of those would take a second action in a single turn, which no player
     can do and the referee would refuse — except that the machine does not end
     its turn through the referee.
     ─────────────────────────────────────────────────────────────────── */
  blank();
  AI.side = 0;
  put(rc(7, 8), 0); put(rc(6, 9), 1);
  const stale = { from: rc(7, 8), mv: { to: rc(5, 10), kind: "capture", victim: rc(6, 9) } };

  G.chain = null; G.hasActed = false;
  ok("a jump the turn has not yet spent its action on is allowed", aiStepStillLegal(stale));

  G.hasActed = true;
  ok("...the very same jump, once the sequence has closed, is refused",
    !aiStepStillLegal(stale));

  G.chain = rc(7, 8);
  ok("...allowed again while the chain stands open at that square",
    aiStepStillLegal(stale));

  G.chain = rc(9, 0);
  ok("...and refused when the chain is open somewhere else", !aiStepStillLegal(stale));

  G.chain = null; G.hasActed = false;
  G.board[rc(6, 9)] = null;
  ok("...and refused when the victim has already gone", !aiStepStillLegal(stale));
  G.board[rc(7, 8)] = null;
  ok("...and when the piece itself has", !aiStepStillLegal(stale));

  // And end to end, in the mode where the concealment cards are actually dealt
  // — an enemy Hollow shell being the likeliest way for plan and board to part,
  // and the one the machine is forbidden to see coming. Three seeds, not one:
  // one seed proves one opening, and the cards that cause this are dealt.
  //
  // 30 turns rather than 60. Machine against machine is by far the priciest
  // thing in this file — both sides price their whole hand every turn — and
  // three 60-turn games put twenty seconds on a suite that runs at page load.
  // Breadth across seeds is what this is for; depth into one game is not.
  const abandonedBefore = AI_ABANDONED;
  let seedsClean = 0;
  const seedNotes = [];
  for (const s of [555, 20260809, 987654]) {
    const g = aiPlayGame("skilled", "skilled", 30, s);
    if (g.turns > 0
      && G.board.every((p, i) => !p || isDark(i))
      && countForm("phaser") <= 2
      && G.board.every((p) => !p || !p.form || FORMS[p.form])) seedsClean++;
    seedNotes.push(`${s}:${g.turns}t`);
  }
  ok("three seeds of machine-versus-machine each finish on a legal board",
    seedsClean === 3, seedNotes.join(" "));
  // Measured at 0 across 180 turns of these same games, which is the point:
  // once the search learned what Twin and Quantum do, plan and board agree in
  // practice, and this is a net rather than a routine. A number that starts
  // climbing means the two have drifted apart again.
  ok("...and the machine almost never has to abandon a plan mid-turn",
    AI_ABANDONED - abandonedBefore <= 3, `${AI_ABANDONED - abandonedBefore} abandoned`);

  /* ── the difficulty ladder ─────────────────────────────────────────────
     Nothing used to check that the three levels were actually ordered. A
     retune that quietly made Novice the strongest would have shipped.
     ─────────────────────────────────────────────────────────────────── */
  /* ── the machine looks at its whole hand ───────────────────────────────
     Pricing a candidate costs a clone of the game and a search, so a full hand
     on a crowded board offers more than the budget can pay for. It used to be
     the tail of the list that went unpriced, and the list was ordered by card
     type — so Stutter, Echo, Wraparound, Anchor and Rift were, in ordinary
     play, never once looked at. Not judged badly: not looked at.
     ─────────────────────────────────────────────────────────────────── */
  group("The machine — reads its whole hand");
  {
    const hWas = { on: AI.on, side: AI.side, level: AI.level, fast: AI.fast };
    // The sandbox is the one place that deals every card there is.
    G = newGame(0, 42, { dev: true, mode: "local" });
    UI = freshUI();
    G.turnNo = 0;
    beginTurn(0);
    G.players[0].fp = 99;                       // afford anything, so nothing is gated on cost
    AI.on = true; AI.side = 0; AI.level = "ruthless"; AI.fast = true;

    const offered = aiSpellCandidates("declare").filter((c) => !spellBlocker(c.id, 0));
    const offeredIds = [...new Set(offered.map((c) => c.id))];
    ok("a full hand on a fresh board offers candidates from many cards",
      offeredIds.length >= 8, `${offeredIds.length} cards, ${offered.length} candidates`);

    const shortlist = aiShortlist(offered);
    const shortIds = new Set(shortlist.map((c) => c.id));
    const dropped = offeredIds.filter((id) => !shortIds.has(id));
    ok("every card that offers anything at all gets one of its offers priced",
      dropped.length === 0, `dropped entirely: ${dropped.join(", ")}`);

    // And the rule that guarantees it: nobody gets a second look until
    // everybody has had a first.
    const firstN = shortlist.slice(0, offeredIds.length).map((c) => c.id);
    ok("...because no card gets a second candidate before every card has had one",
      new Set(firstN).size === firstN.length, firstN.join(" "));

    // The specific cards the old ordering starved. Any of these that is
    // castable here must be in the shortlist.
    const tail = ["stutter", "echo", "wraparound", "anchor", "rift"]
      .filter((id) => offeredIds.includes(id));
    ok("...including the ones that used to sit past the end of the budget",
      tail.length > 0 && tail.every((id) => shortIds.has(id)),
      `castable here: ${tail.join(", ") || "none"}`);

    AI.on = hWas.on; AI.side = hWas.side; AI.level = hWas.level; AI.fast = hWas.fast;
  }

  group("The machine — difficulty ladder");
  const ladder = AI_ORDER.map((k) => AI_LEVELS[k]);
  const rises = (f) => ladder.every((L, i) => i === 0 || f(L) > f(ladder[i - 1]));
  const neverFalls = (f) => ladder.every((L, i) => i === 0 || f(L) >= f(ladder[i - 1]));
  ok("each level searches deeper than the last", rises((L) => L.depth),
    ladder.map((L) => L.depth).join(" < "));
  ok("...and is given longer to do it", rises((L) => L.timeMs),
    ladder.map((L) => L.timeMs).join(" < "));
  ok("...and blunders less", ladder.every((L, i) => i === 0 || L.noise < ladder[i - 1].noise),
    ladder.map((L) => L.noise).join(" > "));
  ok("...and judges its own hand at least as hard", neverFalls((L) => L.policyDepth),
    ladder.map((L) => L.policyDepth).join(" <= "));
  ok("...and demands no more of a spell before casting it",
    ladder.every((L, i) => i === 0 || L.castEdge <= ladder[i - 1].castEdge),
    ladder.map((L) => L.castEdge).join(" >= "));
  ok("only Ruthless is noiseless", AI_LEVELS.ruthless.noise === 0);

  // The ordering work — principal variation first, killer moves, history — must
  // be a pure speed-up. If it ever starts steering the choice, the same
  // position searched twice stops giving the same answer, and this notices.
  blank();
  put(rc(7, 4), 0); put(rc(6, 5), 1); put(rc(4, 5), 1); put(rc(4, 9), 1);
  put(rc(2, 3), 0); put(rc(9, 0), 0); put(rc(5, 8), 0, "queen"); put(rc(1, 2), 1, "pawn", { armor: true });
  AI.side = 0; AI.level = "ruthless"; AI.fast = true;
  const fpLadder = fingerprint();
  const runA = searchBestMove(0), runB = searchBestMove(0);
  ok("a noiseless level picks the same move twice from one position",
    runA && runB && runA.move.from === runB.move.from && runA.move.to === runB.move.to,
    runA && runB ? `${sq(runA.move.from)}→${sq(runA.move.to)} vs ${sq(runB.move.from)}→${sq(runB.move.to)}` : "no move");
  ok("...and a search at Ruthless's depth still leaves the board untouched",
    fingerprint() === fpLadder);

  const ladderGame = aiPlayGame("ruthless", "novice", 30, 424242);
  ok("Ruthless and Novice play a full headless game without throwing", ladderGame.turns > 0);
  AI.level = "skilled";

  AI.on = false; AI.fast = false;

  /* ── summary ───────────────────────────────────────────────────────── */
  const sum = el("h1", null, `${pass} passed · ${fail} failed`);
  sum.style.color = fail ? "#f0576b" : "#4bd6a0";
  sum.style.marginTop = "22px";
  out.appendChild(sum);
  const back = el("div", null, "Remove ?test=1 from the address bar to play.");
  back.style.color = "#525a7d";
  out.appendChild(back);
}
