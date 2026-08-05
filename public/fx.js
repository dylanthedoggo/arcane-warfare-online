"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   FX — the effect player.

   Loaded as a classic script, like engine.js, so it shares the same global
   lexical scope as index.html's inline script and can see `G`, `CELL_NODES`,
   `PLAYERS`, `FORMS` and `SPELLS` by bare name.

   ── What this is ────────────────────────────────────────────────────────
   The engine writes a transcript of what it just did to `G.fx` (see the
   PRESENTATION EVENTS section in engine.js). This file reads that transcript
   and draws it. It is the only place in the project that knows what a capture
   should look like, and it holds no rules whatsoever — deleting it would cost
   the game nothing but its looks.

   ── The one structural idea ─────────────────────────────────────────────
   renderBoard() rebuilds every piece from scratch, so by the time anything can
   be drawn the board is ALREADY in its final state: the victim is gone, the
   pawn is a queen. Animating the real pieces is therefore impossible.

   So nothing here animates a real piece. Everything is a ghost drawn in
   #fxlayer on top of a board that is already telling the truth, and a real
   piece that would spoil the illusion — a piece standing at the destination of
   an arc still in flight — is masked for the duration and no longer.

   That has a consequence worth stating plainly: the game is never waiting on
   this file. The board is correct and clickable the instant an action lands,
   and effects catch up. Only two things wait, both because they would cover
   the animation they interrupt: the pass-the-device curtain and the winner
   sheet. Plus one deliberate exception — the four game-altering spells hold
   input while they play, because those are worth a moment.

   ── Sequencing ──────────────────────────────────────────────────────────
   Events are played in order, but an event's HOLD (how long until the next one
   starts) is not its DURATION (how long it is on screen). A capture arc holds
   for 200ms and runs for 420, so the victim shatters as the attacker passes
   over it rather than after it lands. That single split is what lets each
   effect stay an independent recipe instead of one giant hand-timed sequence.
   ══════════════════════════════════════════════════════════════════════════ */

const FX = {
  mode: "full",          // "full" | "reduced" | "off"
  seen: 0,               // high-water mark over G.fxSeq
  queue: [],
  playing: false,
  pending: new Set(),    // visuals still on screen after their hold expired
  hidden: new Set(),     // board indices masked by an in-flight ghost
  lock: 0,               // >0 while a game-altering spell holds input
  chain: 0,              // consecutive capture hops, so a chain visibly builds
  layer: null,
  waiters: [],
  until: 0,              // performance.now() the queue is expected to be idle
};

const FX_KEY = "caw.fx.mode";
const FX_WATCHDOG = 2600;   // no single effect may wedge the queue

/* ── colours ─────────────────────────────────────────────────────────────
   The grammar, in one place. Hue says what KIND of thing happened, and every
   recipe below draws from here rather than picking its own.
   ─────────────────────────────────────────────────────────────────────── */
const FX_C = {
  dead:   "#f0576b",   // --bad     · violence
  stun:   "#78ffdc",   //           · Static Veil, and nothing else
  frost:  "#7fb2ff",   //           · frozen, disoriented, pending
  gain:   "#4bd6a0",   // --good    · resource
  time:   "#ffffff",   //           · time, and queenhood
  stone:  "#7d86ad",   // --ink-dim · terrain
  arcane: "#a86ef0",   // --violet  · magic that belongs to neither side
};
const FX_OWNER = (o) => (PLAYERS[o] ? PLAYERS[o].color : FX_C.time);

/* Each form's own hue, used for its transformation ring and for the shards of
   a transformed piece when one dies. */
const FX_FORM = {
  juggernaut: "#cfd6ef",
  phaser:     FX_C.frost,
  sentinel:   FX_C.stone,
  herald:     null,          // null = the owner's colour
  enchanter:  FX_C.arcane,
  alchemist:  FX_C.gain,
};

/* The four that hold input and get their name across the board. */
const FX_BIG = { mindcontrol: 1, chronos: 1, cascade: 1, martyr: 1 };

/* ══════════════════════════════════════════════════════════════════════════
   PLUMBING
   ══════════════════════════════════════════════════════════════════════════ */

FX.mount = function () {
  if (FX.layer && FX.layer.isConnected) return FX.layer;
  FX.layer = document.getElementById("fxlayer");
  return FX.layer;
};

FX.enabled = function () {
  if (FX.mode === "off") return false;
  if (typeof AI !== "undefined" && AI && AI.fast) return false;   // headless self-play
  if (document.hidden) return false;
  return !!FX.mount();
};

FX.setMode = function (m) {
  FX.mode = m;
  try { localStorage.setItem(FX_KEY, m); } catch (e) {}
  if (m === "off") FX.abort();
};

FX.loadMode = function () {
  let saved = null;
  try { saved = localStorage.getItem(FX_KEY); } catch (e) {}
  if (saved === "full" || saved === "reduced" || saved === "off") { FX.mode = saved; return; }
  // No stored preference: take the OS at its word.
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  FX.mode = reduce ? "reduced" : "full";
};

/** Throw away everything on screen and everything queued. */
FX.abort = function () {
  FX.queue.length = 0;
  FX.pending.clear();
  FX.lock = 0;
  FX.chain = 0;
  for (const i of FX.hidden) FX.unmask(i);
  FX.hidden.clear();
  if (FX.layer) FX.layer.innerHTML = "";
  FX.until = 0;
  FX.release();
};

/**
 * Forget where we were in the transcript. Called when the counter jumps
 * backwards, which means a different game — a new one, or a different room.
 */
FX.reset = function () {
  FX.abort();
  FX.seen = 0;
};

/* ── masking ─────────────────────────────────────────────────────────────
   A ghost mid-flight and the real piece at its destination must not both be
   visible. renderBoard() consults FX.hidden so a re-render mid-animation keeps
   the mask; these two also touch the live node directly, because the mask has
   to take effect on the frame the effect starts, not the next render.
   ─────────────────────────────────────────────────────────────────────── */
FX.mask = function (i) {
  if (i == null || i < 0) return;
  FX.hidden.add(i);
  const p = FX.pieceNode(i);
  if (p) p.style.visibility = "hidden";
};
FX.unmask = function (i) {
  FX.hidden.delete(i);
  const p = FX.pieceNode(i);
  if (p) p.style.visibility = "";
};
FX.pieceNode = function (i) {
  const c = typeof CELL_NODES !== "undefined" && CELL_NODES[i];
  return c ? c.querySelector(".piece") : null;
};

/**
 * Hand a masked square back to the board the moment the piece ARRIVES on it.
 *
 * Arrival and completion are different moments, and conflating them is a hole
 * in the board. A ghost deletes itself the instant its travel ends; the sparks
 * and rings around it run on for another two hundred milliseconds. Wait for all
 * of that before unmasking and the square is empty in between — the piece
 * vanishes mid-move and pops back into existence at the destination.
 *
 * So every recipe that masks passes its TRAVEL promise through here, and hangs
 * its decoration off to the side. The unmask lands one microtask after the
 * ghost is removed, which is the same frame: no gap, and never both at once.
 */
FX.landing = function (i, arrival) {
  return Promise.resolve(arrival).then(
    (v) => { FX.unmask(i); return v; },
    (e) => { FX.unmask(i); throw e; }
  );
};

/* ── the queue ──────────────────────────────────────────────────────────── */

/**
 * Drain everything new out of G.fx. Called at the end of renderBoard(), which
 * is the one place guaranteed to run after every state change in all three
 * modes — a local action, a machine turn, or a state push from the server.
 */
FX.pump = function () {
  if (!G || !Array.isArray(G.fx) || !G.fx.length) return;

  const top = G.fx[G.fx.length - 1].n;
  // The counter only ever climbs within one game (restore() is careful to keep
  // it climbing even through a rewind), so a drop means a different game.
  if (top < FX.seen) FX.reset();

  const fresh = G.fx.filter((e) => e.n > FX.seen);
  if (!fresh.length) return;

  // Advance the mark even when nothing will be drawn. Otherwise a spell cast
  // while the tab was hidden would queue up and play, out of nowhere, minutes
  // later when the player came back.
  FX.seen = top;
  if (!FX.enabled()) return;

  const now = performance.now();
  if (FX.until < now) FX.until = now;
  for (const e of fresh) {
    FX.queue.push(e);
    FX.until += FX.holdOf(e);
  }
  if (!FX.playing) FX.run();
};

/** Roughly how long until the board stops moving. Used to pace the machine. */
FX.busyMs = function () {
  if (!FX.playing && !FX.queue.length) return 0;
  return Math.max(0, Math.min(FX_WATCHDOG * 2, FX.until - performance.now()));
};

/** Run `cb` once the board has settled. Immediate if it already has. */
FX.then = function (cb) {
  if (!FX.playing && !FX.queue.length && !FX.pending.size) { cb(); return; }
  FX.waiters.push(cb);
};

FX.release = function () {
  const ws = FX.waiters.splice(0);
  for (const w of ws) { try { w(); } catch (e) { console.error("FX waiter:", e); } }
};

FX.run = async function () {
  FX.playing = true;
  try {
    while (FX.queue.length) {
      const e = FX.queue.shift();
      let visual;
      try {
        visual = Promise.resolve(FX.play(e)).catch((err) => console.error("FX play:", e, err));
      } catch (err) {
        console.error("FX play:", e, err);
        visual = Promise.resolve();
      }
      FX.pending.add(visual);
      visual.then(() => FX.pending.delete(visual));
      await sleepFX(FX.holdOf(e));
    }
    // Let whatever is still on screen finish before anyone waiting is told the
    // board has settled — with a watchdog, so a broken effect cannot wedge a
    // hot-seat curtain shut.
    await Promise.race([
      Promise.all([...FX.pending]),
      sleepFX(FX_WATCHDOG),
    ]);
  } finally {
    FX.playing = false;
    FX.pending.clear();
    for (const i of [...FX.hidden]) FX.unmask(i);
    if (FX.layer) FX.layer.innerHTML = "";
    FX.lock = 0;
    FX.until = 0;
    FX.release();
  }
};

const sleepFX = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/* ══════════════════════════════════════════════════════════════════════════
   GEOMETRY

   Everything is measured off the live cells rather than computed from indices.
   That is deliberate: the board flips end-for-end when Violet is the one
   looking at it (see buildBoard), and measuring means nothing in this file has
   to know that flipping exists.
   ══════════════════════════════════════════════════════════════════════════ */

function fxBoardRect() { return document.getElementById("board").getBoundingClientRect(); }

function fxCell(i) {
  const c = CELL_NODES[i];
  if (!c) return null;
  const r = c.getBoundingClientRect(), b = fxBoardRect();
  return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
}
function fxCtr(i) {
  const r = fxCell(i);
  return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 0, y: 0 };
}
function fxSize() {
  const r = fxCell(0);
  return r ? r.w : 40;
}
/** The midpoint of the board, for effects that belong to the whole game. */
function fxMid() {
  const b = fxBoardRect();
  return { x: b.width / 2, y: b.height / 2 };
}
/** A point just outside the board on `owner`'s side — where their magic comes from. */
function fxHome(owner) {
  const b = fxBoardRect();
  return { x: b.width / 2, y: owner === 0 ? b.height + 20 : -20 };
}

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/* ══════════════════════════════════════════════════════════════════════════
   PRIMITIVES

   Every effect in the catalogue below is a recipe over these. Ten spells is
   not ten bespoke implementations; it is ten arrangements of eight verbs.
   ══════════════════════════════════════════════════════════════════════════ */

function fxNode(cls, css) {
  const n = document.createElement("div");
  n.className = cls;
  if (css) Object.assign(n.style, css);
  FX.layer.appendChild(n);
  return n;
}

/** Animate, then remove. Returns a promise that never rejects. */
function fxPlay(el, frames, ms, opts) {
  let a;
  try {
    a = el.animate(frames, Object.assign(
      { duration: Math.max(1, ms), easing: "ease-out", fill: "forwards" }, opts || {}));
  } catch (e) {
    el.remove();
    return Promise.resolve();
  }
  return a.finished.catch(() => {}).then(() => el.remove());
}

/** A ghost of a piece: a pixel-identical clone that outlives the real thing. */
function fxGhost(i, pd, opts) {
  opts = opts || {};
  const S = fxSize();
  const frac = pd && pd.form === "sentinel" ? 0.84 : 0.78;
  const d = S * frac * (opts.scale || 1);
  const c = opts.at || fxCtr(i);
  let cls = "piece fx-ghost " + PLAYERS[pd.owner].css;
  if (pd.rank === "queen") cls += " queen";
  if (pd.form === "sentinel") cls += " sentinel";
  const g = fxNode(cls, {
    left: (c.x - d / 2) + "px", top: (c.y - d / 2) + "px",
    width: d + "px", height: d + "px",
  });
  const glyph = pd.form ? (FORMS[pd.form] || {}).glyph : (pd.rank === "queen" ? "♛" : "");
  if (glyph) {
    const s = document.createElement("span");
    s.className = "glyph";
    s.textContent = glyph;
    g.appendChild(s);
  }
  return g;
}

/**
 * Travel from one square to another under one's own power: a lift, an arc, a
 * landing. `lift` is how high, as a fraction of a square — a chain-jump raises
 * it hop by hop, which is what makes a triple-jump read as one build.
 */
function fxGlide(el, from, to, ms, opts) {
  opts = opts || {};
  const a = fxCtr(from), b = fxCtr(to);
  const S = fxSize();
  const lift = (opts.lift == null ? 0.34 : opts.lift) * S;
  const peak = opts.peak == null ? 1.32 : opts.peak;
  const dx = b.x - a.x, dy = b.y - a.y;

  if (opts.trail !== false) fxTrail(el, a, b, ms, opts);

  return fxPlay(el, [
    { transform: "translate(0px,0px) scale(1)" },
    { transform: `translate(${dx * 0.5}px,${dy * 0.5 - lift}px) scale(${peak})`, offset: 0.5 },
    { transform: `translate(${dx}px,${dy}px) scale(1)` },
  ], ms, { easing: opts.easing || "cubic-bezier(.32,.06,.34,1)" });
}

/**
 * After-images left behind by something moving fast.
 *
 * Each frame must be INVISIBLE until the piece has actually reached it —
 * `fill: "both"` is what does that, by applying the leading keyframe through
 * the delay. Without it the element sits at its stylesheet opacity from the
 * moment it is created, so the whole path lights up with dim copies of the
 * piece before the piece has gone anywhere, and the move reads as a smear
 * rather than a travel.
 */
function fxTrail(el, a, b, ms, opts) {
  const n = (opts && opts.trailCount) || 3;
  const pd = opts && opts.pd;
  if (!pd) return;
  for (let k = 1; k <= n; k++) {
    const t = k / (n + 1);
    const g = fxGhost(0, pd, { at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } });
    g.classList.add("fx-trail");
    fxPlay(g, [
      { opacity: 0 },
      { opacity: 0.34, offset: 0.18 },
      { opacity: 0 },
    ], ms * 0.66, { delay: ms * t * 0.62, fill: "both" });
  }
}

/** Violent loss: the piece comes apart. */
function fxShatter(i, pd, opts) {
  opts = opts || {};
  const c = opts.at || fxCtr(i);
  const S = fxSize();
  const n = opts.shards || 14;
  const color = opts.color
    || (pd && pd.form && FX_FORM[pd.form]) || (pd ? FX_OWNER(pd.owner) : FX_C.dead);
  const pull = opts.toward || null;      // Eye For An Eye drags shards inward
  const out = [];
  for (let k = 0; k < n; k++) {
    const ang = (k / n) * Math.PI * 2 + rand(-0.3, 0.3);
    const d = S * rand(0.3, 0.55);
    const sz = S * rand(0.1, 0.2);
    let tx = Math.cos(ang) * d, ty = Math.sin(ang) * d;
    if (pull) { tx = (pull.x - c.x) * rand(0.4, 0.95); ty = (pull.y - c.y) * rand(0.4, 0.95); }
    const sh = fxNode("fx-shard", {
      left: (c.x - sz / 2) + "px", top: (c.y - sz / 2) + "px",
      width: sz + "px", height: sz + "px",
      background: color,
    });
    out.push(fxPlay(sh, [
      { transform: "translate(0,0) rotate(0deg) scale(1)", opacity: 1 },
      { transform: `translate(${tx}px,${ty}px) rotate(${rand(90, 200)}deg) scale(.35)`, opacity: 0 },
    ], (opts.ms || 300) * rand(0.75, 1.15)));
  }
  if (opts.ring !== false) out.push(fxRing(c, opts.ringColor || FX_C.dead, 0.2, 1.3, opts.ms || 300));
  return Promise.all(out);
}

/** Willing loss: the piece is given up. Sinks, greys, dissolves upward. */
function fxDissolve(i, pd, opts) {
  opts = opts || {};
  const ms = opts.ms || 380;
  const c = fxCtr(i);
  const S = fxSize();
  const g = fxGhost(i, pd);
  const out = [fxPlay(g, [
    { transform: "translateY(0) scale(1)", opacity: 1, filter: "saturate(1) brightness(1)" },
    { transform: "translateY(2%) scale(.99)", opacity: .92, filter: "saturate(.15) brightness(.6)", offset: .32 },
    { transform: `translateY(${S * 0.18}px) scale(.75)`, opacity: 0, filter: "saturate(0) brightness(.5)" },
  ], ms, { easing: "cubic-bezier(.4,0,.7,.6)" })];

  // Motes drift UP as the body sinks. The two directions are the whole point:
  // something is leaving, not being knocked over.
  const motes = opts.motes == null ? 8 : opts.motes;
  const gather = opts.gather || null;    // Juggernaut/Alchemist pull them in
  for (let k = 0; k < motes; k++) {
    const sz = S * rand(0.03, 0.07);
    const m = fxNode("fx-mote", {
      left: (c.x + rand(-S * .2, S * .2) - sz / 2) + "px",
      top: (c.y + rand(-S * .15, S * .15) - sz / 2) + "px",
      width: sz + "px", height: sz + "px",
      color: pd ? FX_OWNER(pd.owner) : FX_C.time,
    });
    const tx = gather ? gather.x - c.x : rand(-S * .16, S * .16);
    const ty = gather ? gather.y - c.y : -S * rand(0.28, 0.6);
    out.push(fxPlay(m, [
      { transform: "translate(0,0) scale(1)", opacity: .95 },
      { transform: `translate(${tx}px,${ty}px) scale(.2)`, opacity: 0 },
    ], ms * rand(0.8, 1.25), { delay: rand(0, ms * 0.25) }));
  }
  // A ring that contracts — the exact inverse of a capture's.
  out.push(fxRing(c, pd ? FX_OWNER(pd.owner) : FX_C.time, 1.1, 0.15, ms));
  return Promise.all(out);
}

/** A ring at `c`, scaling from `a` to `b` (fractions of a square) and fading. */
function fxRing(c, color, a, b, ms, opts) {
  opts = opts || {};
  const S = fxSize();
  const d = S * (opts.base || 1);
  const el = fxNode("fx-ring" + (opts.cls ? " " + opts.cls : ""), {
    left: (c.x - d / 2) + "px", top: (c.y - d / 2) + "px",
    width: d + "px", height: d + "px",
    color,
  });
  return fxPlay(el, [
    { transform: `scale(${a})`, opacity: opts.from == null ? .95 : opts.from },
    { transform: `scale(${b})`, opacity: 0 },
  ], ms, { easing: opts.easing || "ease-out" });
}

/** A soft flash of light. */
function fxGlow(c, color, spread, ms, opts) {
  opts = opts || {};
  const S = fxSize();
  const d = S * spread;
  const el = fxNode("fx-glow", {
    left: (c.x - d / 2) + "px", top: (c.y - d / 2) + "px",
    width: d + "px", height: d + "px", color,
  });
  return fxPlay(el, [
    { transform: "scale(.4)", opacity: 0 },
    { transform: "scale(1)", opacity: opts.peak == null ? .8 : opts.peak, offset: .35 },
    { transform: "scale(1.25)", opacity: 0 },
  ], ms);
}

/** Small bright points thrown outward, falling slightly. */
function fxSparks(c, color, n, ms, opts) {
  opts = opts || {};
  const S = fxSize();
  const out = [];
  for (let k = 0; k < n; k++) {
    const sz = S * rand(0.035, 0.07);
    const ang = rand(0, Math.PI * 2);
    const d = S * rand(0.3, 0.8);
    const el = fxNode("fx-spark", {
      left: (c.x - sz / 2) + "px", top: (c.y - sz / 2) + "px",
      width: sz + "px", height: sz + "px",
      color: typeof color === "function" ? color(k) : color,
    });
    out.push(fxPlay(el, [
      { transform: "translate(0,0) scale(1)", opacity: 1 },
      { transform: `translate(${Math.cos(ang) * d}px,${Math.sin(ang) * d * .7 + S * .18}px) scale(.2)`, opacity: 0 },
    ], ms * rand(0.7, 1.2), { delay: rand(0, ms * 0.2), easing: "cubic-bezier(.2,.6,.5,1)" }));
  }
  return Promise.all(out);
}

/** A line from one point to another: beam, tether, or tendril. */
function fxLine(a, b, cls, color, thick, ms, opts) {
  opts = opts || {};
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  const el = fxNode(cls, {
    left: a.x + "px", top: (a.y - thick / 2) + "px",
    width: len + "px", height: thick + "px",
    color,
  });
  const R = `rotate(${ang}deg)`;
  return fxPlay(el, opts.frames || [
    { transform: `${R} scaleX(0)`, opacity: 1 },
    { transform: `${R} scaleX(1)`, opacity: 1, offset: .35 },
    { transform: `${R} scaleX(1)`, opacity: 0 },
  ], ms, opts.opts);
}

/** A character over a square — a form's sigil, a rune, an eye. */
function fxGlyph(c, ch, color, ms, opts) {
  opts = opts || {};
  const S = fxSize();
  const d = S * (opts.box || 1);
  const el = fxNode("fx-glyph", {
    left: (c.x - d / 2) + "px", top: (c.y - d / 2) + "px",
    width: d + "px", height: d + "px",
    color,
    fontSize: (S * (opts.size || 0.5)) + "px",
  });
  el.textContent = ch;
  return fxPlay(el, opts.frames || [
    { transform: `translateY(${-(opts.drop || 0) * S}px) scale(1.9)`, opacity: 0 },
    { transform: "translateY(0) scale(1)", opacity: 1, offset: .45 },
    { transform: "scale(1.06)", opacity: 0 },
  ], ms, { easing: "cubic-bezier(.2,.9,.3,1)" });
}

/** A colour laid over the whole board. */
function fxWash(color, ms, opts) {
  opts = opts || {};
  const el = fxNode("fx-wash", { background: color });
  return fxPlay(el, opts.frames || [
    { opacity: 0 },
    { opacity: opts.peak == null ? .3 : opts.peak, offset: .3 },
    { opacity: 0 },
  ], ms);
}

/** A bar of light crossing the board at `deg`. */
function fxSweep(deg, ms) {
  const b = fxBoardRect();
  const w = b.width * 0.2;
  const el = fxNode("fx-sweep", { left: "0px", width: w + "px" });
  return fxPlay(el, [
    { transform: `rotate(${deg}deg) translateX(${-w}px)`, opacity: 0 },
    { transform: `rotate(${deg}deg) translateX(${b.width * .2}px)`, opacity: 1, offset: .2 },
    { transform: `rotate(${deg}deg) translateX(${b.width * .8}px)`, opacity: 1, offset: .8 },
    { transform: `rotate(${deg}deg) translateX(${b.width + w}px)`, opacity: 0 },
  ], ms, { easing: "linear" });
}

/** The name of a game-altering spell, held over a dimmed board. */
function fxBanner(text, sub, color, ms) {
  const el = fxNode("fx-banner", { color });
  const t = document.createElement("div"); t.className = "t"; t.textContent = text;
  el.appendChild(t);
  if (sub) { const s = document.createElement("div"); s.className = "s"; s.textContent = sub; el.appendChild(s); }
  return fxPlay(el, [
    { opacity: 0 },
    { opacity: 1, offset: .16 },
    { opacity: 1, offset: .74 },
    { opacity: 0 },
  ], ms, { easing: "ease-in-out" });
}

/** The tell that a card was played: it flies from the hand toward the board. */
function fxCastTell(caster) {
  const b = fxBoardRect();
  const S = fxSize();
  // The hand column lives to the right of the board in the layout, so the card
  // enters from that edge regardless of who cast it.
  const from = { x: b.width + S * 0.6, y: b.height * 0.4 };
  const to = fxMid();
  const el = fxNode("fx-card", {
    left: (from.x - S * .22) + "px", top: (from.y - S * .3) + "px",
    width: (S * .44) + "px", height: (S * .6) + "px",
    color: FX_OWNER(caster),
  });
  return fxPlay(el, [
    { transform: "translate(0,0) rotate(14deg) scale(.7)", opacity: 0 },
    { transform: `translate(${(to.x - from.x) * .45}px,${(to.y - from.y) * .45}px) rotate(4deg) scale(1)`, opacity: .95, offset: .45 },
    { transform: `translate(${(to.x - from.x) * .8}px,${(to.y - from.y) * .8}px) rotate(-6deg) scale(.5)`, opacity: 0 },
  ], 320, { easing: "cubic-bezier(.3,.7,.4,1)" });
}

/* ══════════════════════════════════════════════════════════════════════════
   HOLDS — how long until the NEXT event starts.

   Shorter than the effect itself wherever two events describe one moment: a
   capture's arc holds 200ms so the shatter it triggers lands as the attacker
   passes over the victim, not after it has already landed.
   ══════════════════════════════════════════════════════════════════════════ */

const FX_HOLD = {
  move:        (e) => (e.kind === "capture" ? 200 : e.kind === "swap" ? 380 : e.kind === "mind" ? 260 : 230),
  death:       (e) => (e.kind === "sacrifice" ? 260 : e.kind === "eye" ? 300 : 210),
  armor:       () => 300,
  eyeTether:   () => 70,
  promote:     () => 400,
  transform:   (e) => (e.form === "juggernaut" ? 520 : 380),
  sentinelHalt:() => 150,
  spell:       (e) => (FX_BIG[e.id] ? 520 : 200),
  hopscotch:   () => 420,
  evasive:     () => 380,
  mirror:      () => 560,
  veil:        () => 470,
  mind:        () => 640,
  eye:         () => 560,
  chronos:     () => 1150,
  cascade:     () => 1200,
  martyr:      () => 1150,
};

FX.holdOf = function (e) {
  if (FX.mode === "reduced") return 120;
  const f = FX_HOLD[e.type];
  return f ? f(e) : 200;
};

/* ══════════════════════════════════════════════════════════════════════════
   THE CATALOGUE
   ══════════════════════════════════════════════════════════════════════════ */

FX.play = function (e) {
  if (!FX.mount()) return Promise.resolve();
  if (FX.mode === "reduced") return fxReduced(e);
  const r = FX_PLAY[e.type];
  return r ? r(e) : Promise.resolve();
};

/**
 * Reduced motion: no travel, no particles. Every event becomes a short pulse on
 * the squares it concerned, so the board still says "something happened here"
 * without anything flying across it.
 */
function fxReduced(e) {
  const spots = [];
  for (const k of ["at", "from", "to"]) if (typeof e[k] === "number") spots.push(e[k]);
  if (Array.isArray(e.changed)) spots.push(...e.changed.slice(0, 24));
  if (!spots.length) return Promise.resolve();
  const color = e.type === "death" && e.kind !== "sacrifice" ? FX_C.dead
    : e.type === "promote" ? FX_C.time
    : e.caster != null ? FX_OWNER(e.caster)
    : e.owner != null ? FX_OWNER(e.owner) : FX_C.time;
  return Promise.all(spots.map((i) => fxGlow(fxCtr(i), color, 1.1, 240, { peak: .55 })));
}

const FX_PLAY = {};

/* ── movement ───────────────────────────────────────────────────────────── */

FX_PLAY.move = function (e) {
  const pd = e.piece;
  if (!pd) return Promise.resolve();

  if (e.kind === "swap") return fxSwap(e);
  if (e.kind === "phase") return fxPhase(e);

  // A chain-jump builds: each hop is thrown a little higher than the last.
  if (e.kind === "capture") FX.chain = e.chained ? FX.chain + 1 : 0;
  else FX.chain = 0;
  const step = Math.min(FX.chain, 3);

  const ms = e.kind === "capture" ? 420 : e.kind === "mind" ? 300 : 230;
  const lift = (e.kind === "capture" ? 0.4 : 0.18) + step * 0.08;

  FX.mask(e.to);
  const g = fxGhost(e.from, pd);
  // The square comes back the moment the ghost lands — the glow below outlives
  // the travel by a couple of hundred milliseconds and must not gate it.
  const done = FX.landing(e.to, fxGlide(g, e.from, e.to, ms, {
    lift,
    peak: e.kind === "capture" ? 1.4 : 1.15,
    pd,
    trailCount: e.kind === "capture" ? 3 + step : 2,
  }));

  const land = fxCtr(e.to);
  const extras = [
    sleepFX(ms * 0.86).then(() => fxGlow(land, FX_OWNER(pd.owner), 0.8, 220, { peak: .32 })),
  ];

  // The Herald's bonus step is owed to a piece the player did not click, so it
  // says where it came from: the banner's colour trails the pawn.
  if (e.kind === "herald") {
    extras.push(fxRing(fxCtr(e.from), FX_OWNER(pd.owner), .5, 1.5, 320));
  }

  // A borrowed step. The grip that seized this piece was drawn a whole action
  // ago; this is where it lets go. Mind Control always takes an ENEMY piece, so
  // the puppeteer is the other seat.
  if (e.kind === "mind") extras.push(fxGripSnap(1 - pd.owner, e.from, e.to, ms));

  return Promise.all([done, ...extras]);
};

/** Tendrils stretched to breaking as the puppet is walked, then gone. */
function fxGripSnap(caster, from, to, ms) {
  const src = fxHome(caster);
  const S = fxSize();
  const own = FX_OWNER(caster);
  const b = fxCtr(to);
  const out = [];
  for (let k = 0; k < 3; k++) {
    const a = { x: src.x + (k - 1) * S * .8, y: src.y };
    const deg = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    out.push(fxLine(a, b, "fx-tendril", own, Math.max(2, S * .07), ms, {
      frames: [
        { transform: `rotate(${deg}deg) scaleX(1) scaleY(1)`, opacity: .8 },
        { transform: `rotate(${deg}deg) scaleX(1) scaleY(.35)`, opacity: .55, offset: .78 },
        { transform: `rotate(${deg}deg) scaleX(1) scaleY(.05)`, opacity: 0 },
      ],
      opts: { delay: k * 40 },
    }));
  }
  out.push(sleepFX(ms * .9).then(() => fxGlow(b, own, 1.1, 220, { peak: .5 })));
  return Promise.all(out);
}

/** The Enchanter trades places with anything on the board. Pure magic: no path. */
function fxSwap(e) {
  const a = e.piece, b = e.other;
  if (!a) return Promise.resolve();
  FX.mask(e.to);
  FX.mask(e.from);
  const ms = 380;
  const ca = fxCtr(e.from), cb = fxCtr(e.to);
  const mid = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 };

  const one = (pd, from, to, bow) => {
    if (!pd) return Promise.resolve();
    const g = fxGhost(from, pd);
    const d = { x: fxCtr(to).x - fxCtr(from).x, y: fxCtr(to).y - fxCtr(from).y };
    return fxPlay(g, [
      { transform: "translate(0,0) scale(1)", opacity: 1 },
      { transform: `translate(${d.x * .5 + bow}px,${d.y * .5 - bow}px) scale(.55)`, opacity: .25, offset: .5 },
      { transform: `translate(${d.x}px,${d.y}px) scale(1)`, opacity: 1 },
    ], ms, { easing: "ease-in-out" });
  };

  const S = fxSize();
  const out = [
    FX.landing(e.to, one(a, e.from, e.to, S * .18)),
    FX.landing(e.from, one(b, e.to, e.from, -S * .18)),
    fxGlow(mid, FX_C.arcane, 1.6, ms, { peak: .6 }),
    fxRing(mid, FX_C.arcane, .2, 2.2, ms),
  ];
  // Swapping with an ENEMY costs you a card. Say so, in the hue that means cost.
  if (b && a && b.owner !== a.owner) out.push(sleepFX(ms * .45).then(() => fxGlow(mid, FX_C.dead, 1.1, 240, { peak: .5 })));
  return Promise.all(out);
}

/**
 * A phase: two squares orthogonally, THROUGH whatever stands between. Passing
 * through an occupied square is the rule people forget, so the streak crosses
 * the obstacle and the obstacle flickers as it goes.
 */
function fxPhase(e) {
  const pd = e.piece;
  const ms = 420;
  FX.mask(e.to);
  const a = fxCtr(e.from), b = fxCtr(e.to);
  const S = fxSize();

  const g = fxGhost(e.from, pd);
  const flatten = FX.landing(e.to, fxPlay(g, [
    { transform: "translate(0,0) scaleX(1) scaleY(1)", opacity: 1 },
    { transform: `translate(${(b.x - a.x) * .15}px,${(b.y - a.y) * .15}px) scaleX(.14) scaleY(1.3)`, opacity: .85, offset: .3 },
    { transform: `translate(${(b.x - a.x) * .85}px,${(b.y - a.y) * .85}px) scaleX(.14) scaleY(1.3)`, opacity: .85, offset: .62 },
    { transform: `translate(${b.x - a.x}px,${b.y - a.y}px) scaleX(1) scaleY(1)`, opacity: 1 },
  ], ms, { easing: "cubic-bezier(.6,0,.3,1)" }));

  const streak = fxLine(a, b, "fx-beam", FX_C.frost, Math.max(2, S * .07), ms * .7, {
    frames: [
      { transform: "scaleX(0)", opacity: 0 },
      { transform: "scaleX(1)", opacity: 1, offset: .4 },
      { transform: "scaleX(1)", opacity: 0 },
    ],
  });

  // Whatever it passed over: the square between the two ends.
  const midIdx = fxBetween(e.from, e.to);
  const flick = midIdx != null && G.board[midIdx]
    ? sleepFX(ms * .35).then(() => fxGlow(fxCtr(midIdx), FX_C.frost, 1.2, 260, { peak: .7 }))
    : Promise.resolve();

  return Promise.all([
    flatten, streak, flick,
    sleepFX(ms * .75).then(() => fxRing(b, FX_C.frost, .4, 1.4, 300, { cls: "dashed" })),
  ]);
}

/** The square a two-step orthogonal phase passed over, or null. */
function fxBetween(from, to) {
  const dr = rowOf(to) - rowOf(from), dc = colOf(to) - colOf(from);
  if (Math.abs(dr) === 2 && dc === 0) return rc(rowOf(from) + dr / 2, colOf(from));
  if (Math.abs(dc) === 2 && dr === 0) return rc(rowOf(from), colOf(from) + dc / 2);
  return null;
}

/* ── loss ───────────────────────────────────────────────────────────────── */

FX_PLAY.death = function (e) {
  const pd = e.piece;
  if (!pd) return Promise.resolve();

  // Given up, not struck down. Every sacrifice in the rules comes through here.
  if (e.kind === "sacrifice") return fxDissolve(e.at, pd, { ms: 380 });

  // Dragged down by its own prey — the shards are pulled back the way it came.
  if (e.kind === "eye") {
    return Promise.all([
      fxShatter(e.at, pd, { ms: 320, shards: 12, toward: FX._eyeAnchor || null }),
      fxGlow(fxCtr(e.at), FX_C.dead, 1.4, 340, { peak: .7 }),
    ]);
  }

  const c = fxCtr(e.at);
  const transformed = !!pd.form;
  return Promise.all([
    fxGlow(c, "#ffffff", 1.0, 110, { peak: .9 }),
    sleepFX(40).then(() => fxShatter(e.at, pd, { ms: 320, shards: transformed ? 16 : 14 })),
    // A transformed piece is worth double, and the board should say so.
    transformed ? fxSparks(c, FX_C.gain, 4, 420) : Promise.resolve(),
  ]);
};

/**
 * Armour held. This must never, for one frame, look like a death: no red, no
 * shatter, and the victim never fades. The armour comes off; the piece recoils.
 */
FX_PLAY.armor = function (e) {
  const c = fxCtr(e.at);
  const S = fxSize();
  const src = e.from != null ? fxCtr(e.from) : { x: c.x, y: c.y - S };
  const away = { x: c.x - src.x, y: c.y - src.y };
  const len = Math.hypot(away.x, away.y) || 1;

  const out = [fxGlow(c, "#ffffff", 1.2, 200, { peak: .85 })];

  // Six segments of the ring spin off and fade.
  for (let k = 0; k < 6; k++) {
    const ang = (k / 6) * Math.PI * 2;
    const sz = S * .2;
    const seg = fxNode("fx-ring dashed", {
      left: (c.x + Math.cos(ang) * S * .42 - sz / 2) + "px",
      top: (c.y + Math.sin(ang) * S * .42 - sz / 2) + "px",
      width: sz + "px", height: sz + "px",
      color: "#cfd6ef",
    });
    out.push(fxPlay(seg, [
      { transform: "translate(0,0) rotate(0) scale(1)", opacity: .95 },
      { transform: `translate(${Math.cos(ang) * S * .5}px,${Math.sin(ang) * S * .5}px) rotate(${rand(120, 260)}deg) scale(.4)`, opacity: 0 },
    ], 340));
  }

  // The piece itself gives, then holds. Drawn as a ghost so the real one below
  // stays put and visible — nothing about this is a removal.
  const p = G.board[e.at];
  if (p) {
    FX.mask(e.at);
    const g = fxGhost(e.at, { owner: p.owner, rank: p.rank, form: p.form, armor: false });
    out.push(fxPlay(g, [
      { transform: "translate(0,0) scale(1)" },
      { transform: `translate(${away.x / len * S * .08}px,${away.y / len * S * .08}px) scale(.88)`, offset: .3 },
      { transform: "translate(0,0) scale(1)" },
    ], 340, { easing: "cubic-bezier(.3,1.4,.5,1)" }).then(() => FX.unmask(e.at)));
  }
  return Promise.all(out);
};

/** The grudge, snapping taut. Remembers where to drag the killer back to. */
FX_PLAY.eyeTether = function (e) {
  const a = fxCtr(e.from), b = fxCtr(e.to);
  FX._eyeAnchor = a;
  const S = fxSize();
  return Promise.all([
    fxLine(a, b, "fx-tether", FX_C.dead, Math.max(2, S * .06), 420, {
      frames: [
        { transform: "scaleX(0)", opacity: 1 },
        { transform: "scaleX(1)", opacity: 1, offset: .22 },
        { transform: "scaleX(.05)", opacity: .8, offset: .8 },
        { transform: "scaleX(0)", opacity: 0 },
      ],
    }),
    fxGlyph(a, "◉", FX_C.dead, 460, { size: .52 }),
  ]);
};

/* ── crowning ───────────────────────────────────────────────────────────── */

FX_PLAY.promote = function (e) {
  const c = fxCtr(e.at);
  const S = fxSize();
  const own = FX_OWNER(e.owner);
  FX.mask(e.at);

  // A column of light: owner's colour at the base, white at the top.
  const w = S * .4;
  const col = fxNode("", {
    left: (c.x - w / 2) + "px", top: (c.y - S * 1.5) + "px",
    width: w + "px", height: (S * 1.6) + "px",
    background: `linear-gradient(180deg,transparent,${FX_C.time} 55%,${own})`,
    filter: "blur(2px)",
  });

  // The crown descending IS the arrival. The ring and sparks that follow it are
  // celebration, and the new queen must already be standing there for them.
  const crowned = FX.landing(e.at,
    sleepFX(200).then(() => fxGlyph(c, "♛", FX_C.time, 300, { size: .62, drop: .7 }))
  ).then(() => {
    const n = FX.pieceNode(e.at);
    if (n) n.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.18)", offset: .4 }, { transform: "scale(1)" }],
      { duration: 240, easing: "ease-out" });
  });

  return Promise.all([
    fxRing(c, FX_C.time, 1.6, .55, 200),                       // anticipation
    sleepFX(100).then(() => fxPlay(col, [
      { transform: "scaleY(.1) translateY(40%)", opacity: 0 },
      { transform: "scaleY(1) translateY(0)", opacity: .85, offset: .45 },
      { transform: "scaleY(1.05) translateY(-6%)", opacity: 0 },
    ], 330, { easing: "cubic-bezier(.2,.8,.3,1)" })),
    crowned,
    sleepFX(360).then(() => Promise.all([
      fxRing(c, FX_C.time, .3, 1.8, 260, { cls: "thick" }),
      fxSparks(c, (k) => (k % 2 ? FX_C.time : own), 10, 420),
      // Crowning pays 2 FP, and this is the one moment that is worth saying.
      fxSparks(c, FX_C.gain, 2, 520),
    ])),
  ]);
};

/* ── transformations ────────────────────────────────────────────────────── */

FX_PLAY.transform = function (e) {
  const F = FORMS[e.form] || {};
  const own = FX_OWNER(e.owner);
  const hue = FX_FORM[e.form] === null ? own : (FX_FORM[e.form] || own);
  const c = fxCtr(e.at);
  const S = fxSize();
  const sig = FX_TRANSFORM[e.form];

  const base = Promise.all([
    fxGlow(c, own, 1.3, 200, { peak: .7 }),
    sleepFX(100).then(() => Promise.all([
      fxGlyph(c, F.glyph || "✦", hue, 300, { size: .6 }),
      fxRing(c, hue, .35, 1.9, 300, { cls: "thick" }),
    ])),
  ]);

  return sig ? Promise.all([base, sig(e, { c, S, own, hue })]) : base;
};

const FX_TRANSFORM = {
  /* Paid for with a pawn, and you can watch it being paid: the motes of the
     sacrifice fly INTO the Juggernaut. Then the armour locks on, ending exactly
     where the real .armored ring begins its slow spin. */
  juggernaut: (e, k) => sleepFX(200).then(() => {
    const out = [];
    for (let n = 0; n < 6; n++) {
      const ang = (n / 6) * Math.PI * 2;
      const sz = k.S * .2;
      const seg = fxNode("fx-ring dashed", {
        left: (k.c.x - sz / 2) + "px", top: (k.c.y - sz / 2) + "px",
        width: sz + "px", height: sz + "px", color: "#cfd6ef",
      });
      out.push(fxPlay(seg, [
        { transform: `translate(${Math.cos(ang) * k.S}px,${Math.sin(ang) * k.S}px) scale(.5)`, opacity: 0 },
        { transform: `translate(${Math.cos(ang) * k.S * .46}px,${Math.sin(ang) * k.S * .46}px) scale(1)`, opacity: 1 },
      ], 320, { easing: "cubic-bezier(.2,.9,.3,1)" }));
    }
    return Promise.all(out);
  }),

  /* It disorients itself, so it wears the disorient colour. Two after-images
     snap back together. */
  phaser: (e, k) => {
    const out = [];
    for (const dir of [-1, 1]) {
      const g = fxGhost(e.at, { owner: e.owner, rank: e.rank, form: null });
      out.push(fxPlay(g, [
        { transform: "translateX(0)", opacity: .5 },
        { transform: `translateX(${dir * k.S * .16}px)`, opacity: .5, offset: .45 },
        { transform: "translateX(0)", opacity: 0 },
      ], 380, { easing: "ease-in-out" }));
    }
    out.push(sleepFX(300).then(() => fxGlow(k.c, FX_C.frost, 1.5, 220, { peak: .9 })));
    return Promise.all(out);
  },

  /* It stops being a piece and becomes terrain. The circle squares off, landing
     on exactly the geometry .piece.sentinel already specifies, and it lands
     heavily. */
  sentinel: (e, k) => {
    const g = fxGhost(e.at, { owner: e.owner, rank: e.rank, form: null });
    return Promise.all([
      fxPlay(g, [
        { borderRadius: "50%", transform: "scale(1)" },
        { borderRadius: "30%", transform: "scale(1.12)", offset: .45 },
        { borderRadius: "14%", transform: "scale(1.077)" },
      ], 420, { easing: "cubic-bezier(.3,1.5,.5,1)" }),
      sleepFX(360).then(() => Promise.all([
        fxRing(k.c, FX_C.stone, .8, 2.1, 320, { cls: "square thick" }),
        fxSparks(k.c, FX_C.stone, 7, 340),
      ])),
    ]);
  },

  /* The banner unrolls, then pulses out to exactly the radius its rule
     reaches — a friendly pawn landing ADJACENT gets the bonus step. The effect
     is the rule. */
  herald: (e, k) => {
    const out = [sleepFX(120).then(() => {
      const w = k.S * .7, h = k.S * .34;
      const flag = fxNode("", {
        left: k.c.x + "px", top: (k.c.y - h / 2) + "px",
        width: w + "px", height: h + "px",
        background: `linear-gradient(90deg,${k.own},transparent)`,
        transformOrigin: "0 50%",
      });
      return fxPlay(flag, [
        { transform: "scaleX(0)", opacity: .95 },
        { transform: "scaleX(1)", opacity: .95, offset: .5 },
        { transform: "scaleX(1)", opacity: 0 },
      ], 420);
    })];
    for (const d of [0, 200]) out.push(sleepFX(180 + d).then(() => fxRing(k.c, k.own, .5, 3.2, 480, { from: .55 })));
    return Promise.all(out);
  },

  /* Arcane rather than partisan — violet for either side. What it ate orbits it
     once before it is absorbed. */
  enchanter: (e, k) => Promise.all([
    (() => {
      const out = [];
      for (let n = 0; n < 10; n++) {
        const a0 = rand(0, Math.PI * 2);
        const sz = k.S * rand(.04, .08);
        const m = fxNode("fx-mote", {
          left: (k.c.x - sz / 2) + "px", top: (k.c.y - sz / 2) + "px",
          width: sz + "px", height: sz + "px", color: FX_C.arcane,
        });
        out.push(fxPlay(m, [
          { transform: `translate(${Math.cos(a0) * k.S}px,${Math.sin(a0) * k.S}px)`, opacity: 0 },
          { transform: `translate(${Math.cos(a0 + 2.2) * k.S * .6}px,${Math.sin(a0 + 2.2) * k.S * .6}px)`, opacity: 1, offset: .5 },
          { transform: "translate(0,0) scale(.2)", opacity: 0 },
        ], 520, { easing: "ease-in-out" }));
      }
      return Promise.all(out);
    })(),
    fxRing(k.c, FX_C.arcane, .4, 4.5, 600, { from: .4 }),
    sleepFX(140).then(() => fxRing(k.c, FX_C.arcane, .4, 3.6, 560, { from: .35 })),
  ]),

  /* It will never move again; it makes Focus instead. Green, and the flask
     fills from the bottom. */
  alchemist: (e, k) => sleepFX(140).then(() => {
    const w = k.S * .5;
    const jar = fxNode("", {
      left: (k.c.x - w / 2) + "px", top: (k.c.y - w / 2) + "px",
      width: w + "px", height: w + "px",
      background: FX_C.gain, borderRadius: "50%",
      transformOrigin: "50% 100%",
    });
    return Promise.all([
      fxPlay(jar, [
        { transform: "scaleY(0)", opacity: .8 },
        { transform: "scaleY(1)", opacity: .55, offset: .6 },
        { transform: "scaleY(1)", opacity: 0 },
      ], 460, { easing: "cubic-bezier(.4,.2,.2,1)" }),
      fxSparks(k.c, FX_C.gain, 6, 460),
    ]);
  }),
};

/* ── the Sentinel stopping a chain ──────────────────────────────────────── */

FX_PLAY.sentinelHalt = function (e) {
  const to = fxCtr(e.at);
  const out = [];
  for (const w of (e.walls || [])) {
    const c = fxCtr(w);
    out.push(fxRing(c, FX_C.stone, .8, 1.5, 300, { cls: "square thick", from: 1 }));
    out.push(fxLine(c, to, "fx-beam", FX_C.stone, 3, 280));
  }
  out.push(fxRing(to, FX_C.stone, 1.3, .9, 280, { cls: "square" }));
  return Promise.all(out);
};

/* ══════════════════════════════════════════════════════════════════════════
   SPELLS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every spell opens the same way. The opponent never saw the card, so without
 * this a spell's effect is just unexplained motion on their board.
 */
FX_PLAY.spell = function (e) {
  const S = SPELLS[e.id] || {};
  const out = [fxCastTell(e.caster)];
  if (FX_BIG[e.id]) {
    // These four hold input. The lock is released when the banner ends, and by
    // run()'s finally as a backstop, so a thrown effect cannot strand it.
    FX.lock++;
    out.push(
      fxBanner(S.name || e.id, S.flavor || null, FX_OWNER(e.caster), 1250)
        .then(() => { FX.lock = Math.max(0, FX.lock - 1); })
    );
  }
  return Promise.all(out);
};

/* ── movement spells ────────────────────────────────────────────────────── */

/** A capture, run backwards — and it stutters, because that is what undo does. */
FX_PLAY.hopscotch = function (e) {
  const pd = e.piece;
  FX.mask(e.to);
  const g = fxGhost(e.from, pd);
  const a = fxCtr(e.from), b = fxCtr(e.to);
  const dx = b.x - a.x, dy = b.y - a.y, S = fxSize();

  const stutter = FX.landing(e.to, fxPlay(g, [
    { transform: "translate(0,0) scale(1)" },
    { transform: `translate(${dx * .3}px,${dy * .3 - S * .3}px) scale(1.25)`, offset: .28 },
    { transform: `translate(${dx * .22}px,${dy * .22 - S * .26}px) scale(1.22)`, offset: .38 },
    { transform: `translate(${dx * .68}px,${dy * .68 - S * .3}px) scale(1.25)`, offset: .68 },
    { transform: `translate(${dx * .58}px,${dy * .58 - S * .28}px) scale(1.22)`, offset: .76 },
    { transform: `translate(${dx}px,${dy}px) scale(1)` },
  ], 470, { easing: "linear" }));

  // What it leaves behind at the square it is being pulled out of.
  const after = fxGhost(e.from, pd);
  after.classList.add("fx-trail");
  return Promise.all([
    stutter,
    fxPlay(after, [{ opacity: .4, filter: "saturate(.2)" }, { opacity: 0 }], 260),
    sleepFX(400).then(() => fxGlow(b, FX_C.frost, .9, 240, { peak: .4 })),
  ]);
};

/** A scramble, not a leap: low, fast, backwards, and it costs the pawn its legs. */
FX_PLAY.evasive = function (e) {
  const pd = e.piece;
  FX.mask(e.to);
  const g = fxGhost(e.from, pd);
  const a = fxCtr(e.from), b = fxCtr(e.to);
  const ms = 420;

  const out = [FX.landing(e.to, fxPlay(g, [
    { transform: "translate(0,0) rotate(0) scale(1)" },
    { transform: `translate(${(b.x - a.x) * .5}px,${(b.y - a.y) * .5}px) rotate(-7deg) scale(.95,1.05)`, offset: .5 },
    { transform: `translate(${b.x - a.x}px,${b.y - a.y}px) rotate(0) scale(1)` },
  ], ms, { easing: "cubic-bezier(.15,.85,.3,1)" }))];

  for (let k = 1; k <= 5; k++) {
    const t = k / 6;
    const tr = fxGhost(0, pd, { at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } });
    tr.classList.add("fx-trail");
    // fill:"both" for the same reason as fxTrail — invisible until the pawn
    // has actually reached this point, or the retreat reads as a smear.
    out.push(fxPlay(tr, [
      { opacity: 0 }, { opacity: .35, offset: .18 }, { opacity: 0 },
    ], ms * .6, { delay: ms * t * .55, fill: "both" }));
  }
  out.push(fxGlow(a, "#cfd6ef", .8, 260, { peak: .3 }));
  // It bought the escape with its next move; the pending-penalty hue says so.
  out.push(sleepFX(ms * .8).then(() => fxRing(b, FX_C.frost, .5, 1.4, 320, { cls: "dashed" })));
  return Promise.all(out);
};

/** Teleport grammar: a reflection breaking, and reassembling on the far side. */
FX_PLAY.mirror = function (e) {
  const pd = e.piece;
  FX.mask(e.to);
  const S = fxSize();
  const shatterSlices = (c, reverse) => {
    const out = [];
    const n = 8;
    for (let k = 0; k < n; k++) {
      const w = S * .78 / n;
      const sl = fxNode("", {
        left: (c.x - S * .39 + k * w) + "px", top: (c.y - S * .39) + "px",
        width: w + "px", height: (S * .78) + "px",
        background: FX_OWNER(pd.owner), opacity: .9,
      });
      const off = (k - (n - 1) / 2) * S * .12;
      const frames = [
        { transform: "translateX(0) scaleY(1)", opacity: .9 },
        { transform: `translateX(${off}px) scaleY(.2)`, opacity: 0 },
      ];
      out.push(fxPlay(sl, reverse ? frames.slice().reverse() : frames, 220,
        { easing: reverse ? "cubic-bezier(.2,.9,.3,1)" : "ease-in" }));
    }
    return Promise.all(out);
  };

  const a = fxCtr(e.from), b = fxCtr(e.to);
  const out = [
    shatterSlices(a, false),
    sleepFX(150).then(() => fxSweep(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, 320)),
    // Reassembling on the far side IS the arrival; the Distortion Field ripples
    // below run on afterwards and must not hold the queen off her square.
    FX.landing(e.to, sleepFX(320).then(() => shatterSlices(b, true))),
    sleepFX(470).then(() => fxGlow(b, FX_C.time, 1.4, 260, { peak: .7 })),
  ];
  for (const j of (e.ripples || []))
    out.push(sleepFX(500).then(() => fxRing(fxCtr(j), FX_C.frost, .4, 1.6, 300, { cls: "dashed" })));
  return Promise.all(out);
};

/* ── combat spells ──────────────────────────────────────────────────────── */

/** A ring drops and clamps. Electric, not smooth — it flickers rather than eases. */
FX_PLAY.veil = function (e) {
  const c = fxCtr(e.at), S = fxSize();
  const out = [
    fxRing(c, FX_C.stun, 2.2, 1, 240, { cls: "thick", from: .2, easing: "cubic-bezier(.3,1.3,.4,1)" }),
    sleepFX(220).then(() => fxGlow(c, FX_C.stun, 1.3, 220, { peak: .85 })),
  ];
  for (let k = 0; k < 12; k++) {
    const ang = (k / 12) * Math.PI * 2;
    const len = S * rand(.14, .26);
    const el = fxNode("fx-beam", {
      left: (c.x + Math.cos(ang) * S * .42) + "px",
      top: (c.y + Math.sin(ang) * S * .42) + "px",
      width: len + "px", height: "2px",
      color: FX_C.stun,
      transform: `rotate(${ang * 180 / Math.PI}deg)`,
    });
    out.push(fxPlay(el, [
      { opacity: 0 }, { opacity: 1, offset: .2 }, { opacity: 0, offset: .35 },
      { opacity: 1, offset: .6 }, { opacity: 0 },
    ], 420, { delay: 200 + rand(0, 120), easing: "steps(1,end)" }));
  }
  out.push(sleepFX(340).then(() => fxRing(c, FX_C.stun, 1, 1.9, 260)));
  return Promise.all(out);
};

/** An eye opens. The whole point is that the OPPONENT sees it, so it is not shy. */
FX_PLAY.eye = function (e) {
  const c = fxCtr(e.at), S = fxSize();
  const w = S * .9, h = S * .5;
  const iris = fxNode("", {
    left: (c.x - w / 2) + "px", top: (c.y - h / 2) + "px",
    width: w + "px", height: h + "px",
    background: `radial-gradient(ellipse at center,#fff 0 12%,${FX_C.dead} 13% 42%,rgba(240,87,107,.25) 43% 100%)`,
    borderRadius: "50%",
    boxShadow: `0 0 18px ${FX_C.dead}`,
  });
  return Promise.all([
    fxRing(c, FX_C.dead, 2, .9, 220, { cls: "thick", from: .3 }),
    sleepFX(180).then(() => fxPlay(iris, [
      { transform: "scaleY(.04)", opacity: 0 },
      { transform: "scaleY(1)", opacity: 1, offset: .35 },
      { transform: "scaleY(1)", opacity: 1, offset: .72 },
      { transform: "scaleY(.04)", opacity: 0 },
    ], 460, { easing: "cubic-bezier(.3,.9,.3,1)" })),
    sleepFX(420).then(() => fxRing(c, FX_C.dead, .8, 2, 300)),
  ]);
};

/**
 * Tendrils reach across the board and take hold. The seized piece is moved by a
 * SEPARATE action the player takes next, so this ends with the grip still on —
 * the move's own effect is what releases it.
 */
FX_PLAY.mind = function (e) {
  const c = fxCtr(e.at);
  const src = fxHome(e.caster);
  const S = fxSize();
  const own = FX_OWNER(e.caster);
  const out = [];

  for (let k = 0; k < 3; k++) {
    const off = (k - 1) * S * .8;
    const from = { x: src.x + off, y: src.y };
    out.push(fxLine(from, c, "fx-tendril", own, Math.max(3, S * .1), 900, {
      frames: [
        { transform: `rotate(${Math.atan2(c.y - from.y, c.x - from.x) * 180 / Math.PI}deg) scaleX(0) scaleY(1)`, opacity: .9 },
        { transform: `rotate(${Math.atan2(c.y - from.y, c.x - from.x) * 180 / Math.PI}deg) scaleX(1) scaleY(1.3)`, opacity: .9, offset: .45 },
        { transform: `rotate(${Math.atan2(c.y - from.y, c.x - from.x) * 180 / Math.PI}deg) scaleX(1) scaleY(.7)`, opacity: .75, offset: .7 },
        { transform: `rotate(${Math.atan2(c.y - from.y, c.x - from.x) * 180 / Math.PI}deg) scaleX(1) scaleY(1)`, opacity: 0 },
      ],
      opts: { delay: k * 60, easing: "cubic-bezier(.4,.1,.3,1)" },
    }));
  }

  // The piece changes hands: it takes on the caster's colour, then jerks.
  const p = G.board[e.at];
  if (p) {
    out.push(sleepFX(420).then(() => {
      const g = fxGhost(e.at, { owner: e.caster, rank: p.rank, form: p.form });
      return fxPlay(g, [
        { opacity: 0, transform: "translate(0,0)" },
        { opacity: .75, transform: "translate(0,0)", offset: .3 },
        { opacity: .75, transform: `translate(${rand(-1, 1) * S * .1}px,${-S * .06}px)`, offset: .62 },
        { opacity: .6, transform: "translate(0,0)" },
      ], 620, { easing: "cubic-bezier(.4,1.6,.5,1)" });
    }));
  }
  out.push(sleepFX(460).then(() => fxRing(c, FX_C.arcane, 1.6, .9, 280, { cls: "thick", from: .8 })));
  return Promise.all(out);
};

/* ── game-altering spells ───────────────────────────────────────────────── */

/**
 * A rewind you cannot read is a rewind you cannot trust, so this ends by
 * pointing at every square the rewind actually changed. The board underneath is
 * already restored; the fade is what gives the swap somewhere to hide.
 */
FX_PLAY.chronos = function (e) {
  const mid = fxMid();
  const b = fxBoardRect();
  const R = Math.max(b.width, b.height);
  const board = document.getElementById("board");
  const out = [];

  // The clock, running backwards.
  const d = R * .3;
  const face = fxNode("fx-ring thick", {
    left: (mid.x - d / 2) + "px", top: (mid.y - d / 2) + "px",
    width: d + "px", height: d + "px", color: FX_C.time,
  });
  const hand = fxNode("fx-beam", {
    left: mid.x + "px", top: (mid.y - 1) + "px",
    width: (d * .42) + "px", height: "2px", color: FX_C.time,
  });
  out.push(fxPlay(face, [
    { transform: "scale(.2)", opacity: 0 },
    { transform: "scale(1)", opacity: .9, offset: .25 },
    { transform: "scale(1)", opacity: .9, offset: .78 },
    { transform: "scale(1.5)", opacity: 0 },
  ], 1050));
  out.push(fxPlay(hand, [
    { transform: "rotate(0deg)", opacity: .9 },
    { transform: "rotate(-1080deg)", opacity: .9, offset: .78 },
    { transform: "rotate(-1260deg)", opacity: 0 },
  ], 1050, { easing: "cubic-bezier(.3,0,.6,1)" }));

  // Rings contracting inward, then expanding back out on the far side.
  for (let k = 0; k < 3; k++) {
    out.push(sleepFX(180 + k * 90).then(() => fxRing(mid, FX_C.time, 2.4, .2, 460, { base: R / fxSize(), from: .4 })));
    out.push(sleepFX(640 + k * 90).then(() => fxRing(mid, FX_C.time, .2, 2.4, 460, { base: R / fxSize(), from: .4 })));
  }

  // The board itself dips out and comes back on the restored state.
  if (board) {
    board.animate([
      { filter: "saturate(1)", opacity: 1 },
      { filter: "saturate(.15)", opacity: .35, offset: .45 },
      { filter: "saturate(.15)", opacity: .35, offset: .55 },
      { filter: "saturate(1)", opacity: 1 },
    ], { duration: 1050, easing: "ease-in-out" });
  }

  // And then: this is what moved.
  for (const i of (e.changed || []).slice(0, 40))
    out.push(sleepFX(640).then(() => fxRing(fxCtr(i), FX_C.time, .5, 1.5, 420, { cls: "thick", from: .9 })));

  return Promise.all(out);
};

/** Frost floods the board and time stops for everyone but the caster. */
FX_PLAY.cascade = function (e) {
  const b = fxBoardRect();
  const own = e.caster;
  const out = [
    fxWash(FX_C.frost, 1250, { peak: .26 }),
  ];

  // The leading edge, sweeping in from the caster's side.
  const edge = fxNode("", {
    left: "0px", width: b.width + "px", height: (b.height * .22) + "px",
    top: (own === 0 ? b.height : -b.height * .22) + "px",
    background: `linear-gradient(${own === 0 ? 0 : 180}deg,rgba(127,178,255,.55),transparent)`,
  });
  out.push(fxPlay(edge, [
    { transform: "translateY(0)", opacity: .9 },
    { transform: `translateY(${own === 0 ? -b.height * 1.22 : b.height * 1.22}px)`, opacity: 0 },
  ], 620, { easing: "cubic-bezier(.2,.7,.3,1)" }));

  // Three pulses, one per turn taken. Numbered, so the count is unmistakable.
  const mid = fxMid();
  for (let k = 0; k < 3; k++) {
    out.push(sleepFX(340 + k * 190).then(() => Promise.all([
      fxRing(mid, FX_C.frost, .2, 3.4, 420, { base: b.width / fxSize() / 2, from: .7 }),
      fxGlyph(mid, String(k + 1), FX_C.frost, 380, { size: 1.1 }),
    ])));
  }
  return Promise.all(out);
};

/** A pawn is given up and a queen comes back for her. Long live the queen. */
FX_PLAY.martyr = function (e) {
  const c = fxCtr(e.at);
  const S = fxSize();
  const own = FX_OWNER(e.owner);
  FX.mask(e.at);

  // The motes of the sacrifice hang above the square rather than drifting off —
  // the death event has already played; these are what it left behind.
  const held = [];
  for (let k = 0; k < 10; k++) {
    const sz = S * rand(.04, .08);
    const m = fxNode("fx-mote", {
      left: (c.x + rand(-S * .3, S * .3) - sz / 2) + "px",
      top: (c.y - S * rand(.1, .5) - sz / 2) + "px",
      width: sz + "px", height: sz + "px", color: own,
    });
    held.push(fxPlay(m, [
      { transform: "translate(0,0)", opacity: 0 },
      { transform: "translate(0,0)", opacity: .9, offset: .18 },
      { transform: `translate(${rand(-.1, .1) * S}px,${-S * .9}px) scale(.2)`, opacity: 0 },
    ], 900, { easing: "cubic-bezier(.4,0,.5,1)" }));
  }

  const w = S * .55;
  const col = fxNode("", {
    left: (c.x - w / 2) + "px", top: (c.y - S * 2) + "px",
    width: w + "px", height: (S * 2.1) + "px",
    background: `linear-gradient(180deg,transparent,${FX_C.time} 40%,${own})`,
    filter: "blur(3px)",
  });

  return Promise.all([
    ...held,
    sleepFX(300).then(() => fxPlay(col, [
      { transform: "scaleY(.05) scaleX(.4)", opacity: 0 },
      { transform: "scaleY(1) scaleX(1)", opacity: .9, offset: .4 },
      { transform: "scaleY(1) scaleX(1.1)", opacity: .9, offset: .72 },
      { transform: "scaleY(1) scaleX(.6)", opacity: 0 },
    ], 800, { easing: "cubic-bezier(.2,.8,.3,1)" })),
    // She is standing there as soon as she has materialised. The ring and
    // sparks are for her, not instead of her.
    FX.landing(e.at, sleepFX(600).then(() => {
      const g = fxGhost(e.at, { owner: e.owner, rank: "queen", form: null });
      return fxPlay(g, [
        { transform: "translateY(-90%) scale(1.6)", opacity: 0 },
        { transform: "translateY(0) scale(1)", opacity: 1, offset: .6 },
        { transform: "scale(1)", opacity: 1 },
      ], 400, { easing: "cubic-bezier(.2,.9,.3,1)" });
    })),
    sleepFX(940).then(() => Promise.all([
      fxRing(c, FX_C.time, .4, 2.4, 320, { cls: "thick" }),
      fxSparks(c, (k) => (k % 2 ? FX_C.time : own), 8, 420),
    ])),
  ]);
};

/* ══════════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════════ */

FX.loadMode();
document.addEventListener("visibilitychange", () => { if (document.hidden) FX.abort(); });
