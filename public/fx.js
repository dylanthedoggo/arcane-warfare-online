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

  /**
   * Two dials, so the whole system can be nudged without editing 38 recipes.
   *
   * The numbers written into the recipes below are the design; these scale all
   * of them at once. `rate` stretches every duration, delay and hold; `density`
   * multiplies every particle count. Turn `rate` up if effects still feel rushed
   * and `density` down if the board gets noisy.
   */
  rate: 1,
  density: 1.9,

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

/* Every wait in this file goes through here, so FX.rate stretches the gaps
   between beats exactly as much as it stretches the beats themselves. */
const sleepFX = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms * FX.rate)));

/** Round a designed particle count through the density dial. */
const fxN = (n) => Math.max(1, Math.round(n * FX.density));

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
  const o = Object.assign({ easing: "ease-out", fill: "forwards" }, opts || {});
  // The rate dial has to reach the delay as well as the duration, or a staggered
  // set of waves would slow down while its stagger stayed put and bunch together.
  o.duration = Math.max(1, ms * FX.rate);
  if (o.delay) {
    o.delay = o.delay * FX.rate;
    // Anything on a delay must hold its FIRST keyframe while it waits, or it
    // sits at its stylesheet appearance until its turn comes — a stagger of
    // waves all showing up at once, fully opaque, before any of them moves.
    // "forwards" only covers the tail; the leading edge needs "backwards" too.
    if (o.fill === "forwards") o.fill = "both";
  }
  try {
    a = el.animate(frames, o);
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
  const n = fxN(opts.shards || 14);
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
  const motes = fxN(opts.motes == null ? 8 : opts.motes);
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

/**
 * Distance from a point to the FARTHEST corner of the board.
 *
 * This is the radius that guarantees a wave covers the whole board no matter
 * which square it starts on — a capture in the corner has to travel a lot
 * further than one in the middle, and both should die at the edge rather than
 * one stopping short and the other overshooting into nothing.
 */
function fxReach(c) {
  const b = fxBoardRect();
  return Math.max(
    Math.hypot(c.x, c.y),
    Math.hypot(b.width - c.x, c.y),
    Math.hypot(c.x, b.height - c.y),
    Math.hypot(b.width - c.x, b.height - c.y)
  );
}

/**
 * A shockwave: a ring that crosses the entire board and dissipates as it goes.
 *
 * Deliberately not built on fxRing. That one grows with transform:scale(), which
 * scales the border along with the box — fine at the 1.3-4.5x the local rings
 * use, useless here, where reaching the far corner of a 12x12 board means a
 * diameter of thirty-odd cells and would turn a 2px stroke into a 60px disc.
 *
 * So this grows by animating its own width and height, held centred by a
 * transform that never changes. That puts the stroke under our control, and the
 * stroke is most of the effect: 5px at the point of impact thinning to 1px at
 * the rim is what reads as a wave losing energy rather than a circle inflating.
 *
 * The opacity curve is weighted late on purpose. An ease-out fade would be gone
 * by the halfway mark and the wave would look like it stopped in the middle of
 * the board; this one is still faintly there when it arrives at the edge, which
 * is the whole point of sending it that far.
 *
 * `opts.reach` (0-1) stops it short — for an impact that was blocked rather than
 * landed. `opts.count` fires several staggered waves; one wave reads as a
 * diagram, three read as force.
 */
function fxShockwave(c, color, ms, opts) {
  opts = opts || {};
  const full = fxReach(c) * (opts.reach == null ? 1 : opts.reach);
  const count = opts.count == null ? 3 : opts.count;
  const start = fxSize() * (opts.from == null ? 0.5 : opts.from);
  const out = [];

  for (let k = 0; k < count; k++) {
    // Trailing waves are dimmer, thinner and slightly shorter — an echo, not a
    // copy. Without the falloff three waves just look like a thick one.
    const fade = 1 - k * 0.28;
    const el = fxNode("fx-wave" + (opts.cls ? " " + opts.cls : ""), {
      left: c.x + "px", top: c.y + "px",
      width: start + "px", height: start + "px",
      color,
    });
    const end = full * 2 * (1 - k * 0.06);
    out.push(fxPlay(el, [
      { width: start + "px", height: start + "px",
        borderWidth: (5 * fade) + "px", opacity: 0.85 * fade },
      { width: (end * .4) + "px", height: (end * .4) + "px",
        borderWidth: (3.2 * fade) + "px", opacity: 0.55 * fade, offset: .4 },
      { width: (end * .75) + "px", height: (end * .75) + "px",
        borderWidth: (1.9 * fade) + "px", opacity: 0.22 * fade, offset: .75 },
      // Scaled by `fade` like every other stop, or a trailing wave that started
      // thinner than 1px would get THICKER as it died. Floored so it cannot
      // vanish into a sub-pixel before it reaches the edge.
      { width: end + "px", height: end + "px",
        borderWidth: Math.max(0.5, 1 * fade) + "px", opacity: 0 },
    ], ms, { delay: k * 70, easing: "cubic-bezier(.16,.72,.34,1)" }));
  }
  return Promise.all(out);
}

/**
 * Kick the board.
 *
 * Applied to #boardstack rather than #board, and that is not incidental:
 * #fxlayer is a SIBLING of #board inside the stack, so shaking the board alone
 * would leave every ghost in flight sitting still while the squares it is
 * travelling between move out from under it. Shaking the wrapper moves both.
 */
function fxShake(px, ms) {
  if (FX.mode !== "full") return Promise.resolve();
  const stack = document.getElementById("boardstack");
  if (!stack || fxPrefersReducedMotion()) return Promise.resolve();

  const steps = 7;
  const frames = [{ transform: "translate(0,0)" }];
  for (let k = 1; k < steps; k++) {
    const decay = 1 - k / steps;             // energy bleeding off
    frames.push({
      transform: `translate(${rand(-px, px) * decay}px,${rand(-px, px) * decay}px)`,
      offset: k / steps,
    });
  }
  frames.push({ transform: "translate(0,0)" });
  try {
    stack.animate(frames, { duration: ms * FX.rate, easing: "linear" });
  } catch (e) {}
  return Promise.resolve();
}

const fxPrefersReducedMotion = () =>
  !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

/**
 * What an event leaves behind on the square it happened on.
 *
 * Everything else in this file vanishes completely the moment it ends, so a
 * board a second after a capture looks exactly like a board where nothing
 * happened. This is the trace.
 */
function fxAfterglow(i, color, ms, opts) {
  opts = opts || {};
  const S = fxSize();
  const c = fxCtr(i);
  const d = S * (opts.spread || 1.9);
  const el = fxNode("fx-afterglow", {
    left: (c.x - d / 2) + "px", top: (c.y - d / 2) + "px",
    width: d + "px", height: d + "px", color,
  });
  return fxPlay(el, [
    { opacity: 0 },
    { opacity: opts.peak == null ? .5 : opts.peak, offset: .12 },
    { opacity: 0 },
  ], ms || 900, { easing: "cubic-bezier(.1,.5,.3,1)" });
}

/** Debris: shards stretched along their direction of travel. */
function fxStreaks(c, color, n, ms, opts) {
  opts = opts || {};
  const S = fxSize();
  const bias = opts.bias;             // a direction to throw along, if any
  const out = [];
  for (let k = 0; k < n; k++) {
    const ang = bias != null ? bias + rand(-0.7, 0.7) : rand(0, Math.PI * 2);
    const len = S * rand(.28, .62);
    const el = fxNode("fx-streak", {
      left: c.x + "px", top: (c.y - S * .028) + "px",
      width: len + "px", height: (S * .056) + "px",
      color,
      transformOrigin: "0 50%",
    });
    const d = S * rand(.55, 1.35);
    out.push(fxPlay(el, [
      { transform: `rotate(${ang}rad) translateX(0) scaleX(.4)`, opacity: .9 },
      { transform: `rotate(${ang}rad) translateX(${d}px) scaleX(1)`, opacity: 0 },
    ], ms * rand(.75, 1.15), { delay: rand(0, ms * .12) }));
  }
  return Promise.all(out);
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
  n = fxN(n);
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

/*
 * Holds grow by roughly half again, while the effects themselves grow by nearly
 * double. That gap is deliberate. Effects then run INTO each other instead of
 * queueing politely end to end, which is most of what makes a board feel busy
 * rather than narrated — a three-hop chain-jump now has overlapping shockwaves,
 * compounding with the arc that already climbs hop by hop.
 *
 * `step` is the exception, here and everywhere: it keeps its old 230ms exactly.
 * It is the quiet baseline all of this is measured against, and raising it would
 * flatten the contrast the rest of the pass exists to create.
 */
const FX_HOLD = {
  move:        (e) => (e.kind === "capture" ? 300
                     : e.kind === "swap"    ? 560
                     : e.kind === "phase"   ? 520
                     : e.kind === "mind"    ? 400
                     : 230),                            // step and herald: untouched
  death:       (e) => (e.kind === "sacrifice" ? 400 : e.kind === "eye" ? 450 : 320),
  armor:       () => 450,
  eyeTether:   () => 110,
  promote:     () => 600,
  transform:   (e) => (e.form === "juggernaut" ? 780 : 570),
  sentinelHalt:() => 230,
  spell:       (e) => (FX_BIG[e.id] ? 700 : 300),
  hopscotch:   () => 630,
  evasive:     () => 570,
  mirror:      () => 840,
  veil:        () => 700,
  mind:        () => 900,
  eye:         () => 840,
  chronos:     () => 1500,
  cascade:     () => 1600,
  martyr:      () => 1550,
  // The board-altering four. A rift being carved and a square being sealed
  // are permanent changes, so they get a beat closer to a transformation than
  // to a step; the carry itself is a travel and paces like one.
  rift:        () => 700,
  riftCarry:   () => 520,
  wraparound:  () => 900,
  anchor:      () => 700,
  echo:        () => 620,
  chokepoint:  () => 780,
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

  // A plain step is the one thing in this file that did NOT get louder. It is
  // the baseline — every other effect is read against how quiet this one is.
  const quiet = e.kind === "step" || e.kind === "herald";

  const ms = e.kind === "capture" ? 760 : e.kind === "mind" ? 540 : quiet ? 230 : 420;
  const lift = (e.kind === "capture" ? 0.46 : 0.18) + step * 0.1;

  FX.mask(e.to);
  const g = fxGhost(e.from, pd);
  // The square comes back the moment the ghost lands — the wave below outlives
  // the travel by half a second and must not gate it.
  const done = FX.landing(e.to, fxGlide(g, e.from, e.to, ms, {
    lift,
    peak: e.kind === "capture" ? 1.5 : 1.15,
    pd,
    trailCount: e.kind === "capture" ? 4 + step : 2,
  }));

  const land = fxCtr(e.to);
  const own = FX_OWNER(pd.owner);
  const extras = [
    sleepFX(ms * 0.86).then(() => fxGlow(land, own, quiet ? 0.8 : 1.4, quiet ? 220 : 380,
      { peak: quiet ? .32 : .5 })),
  ];

  // The Herald's bonus step is owed to a piece the player did not click, so it
  // says where it came from: the banner's colour trails the pawn.
  if (e.kind === "herald") {
    extras.push(fxRing(fxCtr(e.from), own, .5, 1.5, 320));
  }

  // A capture lands with everything: the impact wave belongs to the death event
  // that follows, but the arrival itself gets its own weight.
  if (e.kind === "capture") {
    extras.push(sleepFX(ms * .82).then(() => Promise.all([
      fxShake(4 + step, 180),
      fxStreaks(land, own, 5, 420, { bias: Math.atan2(land.y - fxCtr(e.from).y, land.x - fxCtr(e.from).x) }),
    ])));
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
  const ms = 680;
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
    fxGlow(mid, FX_C.arcane, 2.2, ms, { peak: .7 }),
    fxRing(mid, FX_C.arcane, .2, 2.6, ms),
    // Two pieces changing places across the whole board is arcane, not physical
    // — the wave goes out from the midpoint of the exchange.
    sleepFX(ms * .4).then(() => Promise.all([
      fxShockwave(mid, FX_C.arcane, 800, { count: 3 }),
      fxSparks(ca, FX_C.arcane, 6, 620),
      fxSparks(cb, FX_C.arcane, 6, 620),
      fxShake(4, 220),
    ])),
  ];
  // Swapping with an ENEMY costs you a card. Say so, in the hue that means cost.
  if (b && a && b.owner !== a.owner)
    out.push(sleepFX(ms * .45).then(() => Promise.all([
      fxGlow(mid, FX_C.dead, 1.7, 420, { peak: .6 }),
      fxShockwave(mid, FX_C.dead, 700, { count: 1, reach: .55 }),
    ])));
  return Promise.all(out);
}

/**
 * A phase: two squares orthogonally, THROUGH whatever stands between. Passing
 * through an occupied square is the rule people forget, so the streak crosses
 * the obstacle and the obstacle flickers as it goes.
 */
function fxPhase(e) {
  const pd = e.piece;
  const ms = 700;
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
    ? sleepFX(ms * .35).then(() => Promise.all([
        fxGlow(fxCtr(midIdx), FX_C.frost, 1.8, 460, { peak: .85 }),
        // It went THROUGH this piece. Ring the square it passed clean out of.
        fxRing(fxCtr(midIdx), FX_C.frost, .4, 2.2, 520, { cls: "dashed" }),
      ]))
    : Promise.resolve();

  return Promise.all([
    flatten, streak, flick,
    fxShockwave(a, FX_C.frost, 700, { count: 2, reach: .7 }),
    sleepFX(ms * .7).then(() => Promise.all([
      fxShockwave(b, FX_C.frost, 700, { count: 2 }),
      fxRing(b, FX_C.frost, .4, 1.7, 520, { cls: "dashed" }),
      fxSparks(b, FX_C.frost, 7, 620),
      fxShake(4, 200),
    ])),
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
  const c = fxCtr(e.at);
  const own = FX_OWNER(pd.owner);

  // Given up, not struck down. Every sacrifice in the rules comes through here,
  // and its wave runs INWARD — the exact inverse of an impact, because nothing
  // hit this piece. It was offered.
  if (e.kind === "sacrifice") {
    return Promise.all([
      fxDissolve(e.at, pd, { ms: 690 }),
      fxCollapse(c, own, 760, { count: 2 }),
      fxAfterglow(e.at, own, 900, { peak: .38 }),
    ]);
  }

  // Dragged down by its own prey — shards pulled back the way it came.
  if (e.kind === "eye") {
    return Promise.all([
      fxShatter(e.at, pd, { ms: 620, shards: 14, toward: FX._eyeAnchor || null }),
      fxGlow(c, FX_C.dead, 2.0, 620, { peak: .8 }),
      fxShockwave(c, FX_C.dead, 940, { count: 3 }),
      fxShake(6, 260),
      fxAfterglow(e.at, FX_C.dead, 1000, { peak: .55 }),
    ]);
  }

  // A kill. Core blowout, three waves to the board edge, debris, sparks, trace.
  const transformed = !!pd.form;
  const heavy = transformed || pd.rank === "queen";
  return Promise.all([
    fxGlow(c, "#ffffff", 1.5, 190, { peak: .95 }),
    fxShockwave(c, FX_C.dead, 760, { count: 3 }),
    sleepFX(40).then(() => fxShatter(e.at, pd, { ms: 620, shards: transformed ? 17 : 14 })),
    sleepFX(40).then(() => fxStreaks(c, transformed ? (FX_FORM[pd.form] || own) : own, 6, 560)),
    fxSparks(c, FX_C.dead, 8, 700),
    fxShake(heavy ? 6 : 4, heavy ? 240 : 180),
    fxAfterglow(e.at, FX_C.dead, 1000, { peak: .55 }),
    // A transformed piece is worth double, and the board should say so.
    transformed ? fxSparks(c, FX_C.gain, 5, 760) : Promise.resolve(),
  ]);
};

/** A shockwave run backwards: it converges on the square instead of leaving it. */
function fxCollapse(c, color, ms, opts) {
  opts = opts || {};
  const full = fxReach(c) * (opts.reach == null ? .62 : opts.reach);
  const count = opts.count == null ? 2 : opts.count;
  const out = [];
  for (let k = 0; k < count; k++) {
    const fade = 1 - k * 0.3;
    const el = fxNode("fx-wave", {
      left: c.x + "px", top: c.y + "px",
      width: (full * 2) + "px", height: (full * 2) + "px",
      color,
    });
    out.push(fxPlay(el, [
      { width: (full * 2) + "px", height: (full * 2) + "px", borderWidth: "1px", opacity: 0 },
      { width: (full * .9) + "px", height: (full * .9) + "px", borderWidth: "2.4px", opacity: .5 * fade, offset: .45 },
      { width: (fxSize() * .3) + "px", height: (fxSize() * .3) + "px", borderWidth: "4px", opacity: 0 },
    ], ms, { delay: k * 90, easing: "cubic-bezier(.4,.05,.5,1)" }));
  }
  return Promise.all(out);
}

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

  const out = [
    fxGlow(c, "#ffffff", 1.6, 320, { peak: .9 }),
    // Stopped, not landed — so the wave is stopped too. It travels less than
    // half way and dies, which is the difference between this and a kill.
    fxShockwave(c, "#cfd6ef", 620, { count: 2, reach: .45 }),
    fxStreaks(c, "#cfd6ef", 7, 520),
    fxShake(3, 200),
  ];

  // Segments of the ring spin off and fade.
  const segs = fxN(6);
  for (let k = 0; k < segs; k++) {
    const ang = (k / segs) * Math.PI * 2;
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
    ], 620, { easing: "cubic-bezier(.3,1.4,.5,1)" }).then(() => FX.unmask(e.at)));
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

  // The crown descending IS the arrival. The waves and sparks that follow it are
  // celebration, and the new queen must already be standing there for them.
  const crowned = FX.landing(e.at,
    sleepFX(360).then(() => fxGlyph(c, "♛", FX_C.time, 540, { size: .62, drop: .7 }))
  ).then(() => {
    const n = FX.pieceNode(e.at);
    if (n) n.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.18)", offset: .4 }, { transform: "scale(1)" }],
      { duration: 240, easing: "ease-out" });
  });

  return Promise.all([
    fxRing(c, FX_C.time, 1.6, .55, 360),                       // anticipation
    sleepFX(180).then(() => fxPlay(col, [
      { transform: "scaleY(.1) translateY(40%)", opacity: 0 },
      { transform: "scaleY(1) translateY(0)", opacity: .9, offset: .45 },
      { transform: "scaleY(1.05) translateY(-6%)", opacity: 0 },
    ], 600, { easing: "cubic-bezier(.2,.8,.3,1)" })),
    crowned,
    // The crown lands and the board feels it, twice over: white for the crown
    // itself, then a slower gold echo in the new queen's own colour.
    sleepFX(620).then(() => Promise.all([
      fxShockwave(c, FX_C.time, 950, { count: 3 }),
      sleepFX(140).then(() => fxShockwave(c, own, 900, { count: 2, from: .8 })),
      fxGlow(c, FX_C.time, 2.4, 520, { peak: .85 }),
      fxShake(7, 300),
      fxSparks(c, (k) => (k % 2 ? FX_C.time : own), 11, 780),
      fxStreaks(c, own, 8, 640),
      // Crowning pays 2 FP, and this is the one moment worth saying it.
      fxSparks(c, FX_C.gain, 2, 900),
      fxAfterglow(e.at, own, 1200, { peak: .6, spread: 2.4 }),
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

  // Waves per form. A transformation is permanent and irreversible — a piece
  // becoming something it can never stop being — so every one of them announces
  // itself across the whole board, in the hue that form owns.
  const WAVE = {
    juggernaut: { count: 2, ms: 1100 },   // heavy, slow, armoured
    phaser:     { count: 3, ms: 700 },    // fast and electric
    sentinel:   { count: 2, ms: 900, cls: "square" },   // it is terrain now
    herald:     { count: 1, ms: 860 },
    enchanter:  { count: 3, ms: 950 },    // interference
    alchemist:  { count: 2, ms: 900 },
  }[e.form] || { count: 2, ms: 810 };

  const base = Promise.all([
    fxGlow(c, own, 1.8, 340, { peak: .8 }),
    fxShockwave(c, hue, WAVE.ms, { count: WAVE.count, cls: WAVE.cls }),
    fxShake(5, 240),
    sleepFX(160).then(() => Promise.all([
      fxGlyph(c, F.glyph || "✦", hue, 540, { size: .6 }),
      fxRing(c, hue, .35, 2.2, 540, { cls: "thick" }),
      fxSparks(c, hue, 7, 700),
    ])),
    fxAfterglow(e.at, hue, 1200, { peak: .5, spread: 2.2 }),
  ]);

  return sig ? Promise.all([base, sig(e, { c, S, own, hue })]) : base;
};

const FX_TRANSFORM = {
  /* Paid for with a pawn, and you can watch it being paid: the motes of the
     sacrifice fly INTO the Juggernaut. Then the armour locks on, ending exactly
     where the real .armored ring begins its slow spin. */
  juggernaut: (e, k) => sleepFX(340).then(() => {
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
      ], 560, { easing: "cubic-bezier(.2,.9,.3,1)" }));
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
      ], 680, { easing: "ease-in-out" }));
    }
    out.push(sleepFX(520).then(() => fxGlow(k.c, FX_C.frost, 2.1, 400, { peak: .95 })));
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
      ], 740, { easing: "cubic-bezier(.3,1.5,.5,1)" }),
      sleepFX(620).then(() => Promise.all([
        fxRing(k.c, FX_C.stone, .8, 2.4, 560, { cls: "square thick" }),
        fxSparks(k.c, FX_C.stone, 8, 600),
        fxStreaks(k.c, FX_C.stone, 7, 560),
        fxShake(6, 280),                    // terrain arriving
      ])),
    ]);
  },

  /* The banner unrolls, then pulses out to exactly the radius its rule
     reaches — a friendly pawn landing ADJACENT gets the bonus step. The effect
     is the rule. */
  herald: (e, k) => {
    const out = [sleepFX(210).then(() => {
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
      ], 740);
    })];
    // Pulses out to exactly the radius the rule reaches, which is the same
    // radius the permanent .heraldzone aura will now hold from here on.
    for (const d of [0, 340]) out.push(sleepFX(310 + d).then(() => fxRing(k.c, k.own, .5, 3.2, 840, { from: .55 })));
    out.push(sleepFX(420).then(() => fxSparks(k.c, k.own, 6, 760)));
    return Promise.all(out);
  },

  /* Arcane rather than partisan — violet for either side. What it ate orbits it
     once before it is absorbed. */
  enchanter: (e, k) => Promise.all([
    (() => {
      const out = [];
      const orbiting = fxN(10);
      for (let n = 0; n < orbiting; n++) {
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
        ], 900, { easing: "ease-in-out" }));
      }
      return Promise.all(out);
    })(),
    fxRing(k.c, FX_C.arcane, .4, 4.5, 1000, { from: .4 }),
    sleepFX(240).then(() => fxRing(k.c, FX_C.arcane, .4, 3.6, 950, { from: .35 })),
  ]),

  /* It will never move again; it makes Focus instead. Green, and the flask
     fills from the bottom. */
  alchemist: (e, k) => sleepFX(250).then(() => {
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
      ], 820, { easing: "cubic-bezier(.4,.2,.2,1)" }),
      fxSparks(k.c, FX_C.gain, 7, 820),
    ]);
  }),
};

/* ── the Sentinel stopping a chain ──────────────────────────────────────── */

FX_PLAY.sentinelHalt = function (e) {
  const to = fxCtr(e.at);
  const out = [];
  for (const w of (e.walls || [])) {
    const c = fxCtr(w);
    out.push(fxRing(c, FX_C.stone, .8, 1.8, 540, { cls: "square thick", from: 1 }));
    out.push(fxLine(c, to, "fx-beam", FX_C.stone, 4, 500));
    // Terrain refusing to move. The wave is square-cornered and short — it is
    // the Sentinel's own shape, and it does not travel because nothing gave.
    out.push(fxShockwave(c, FX_C.stone, 620, { count: 2, reach: .38, cls: "square" }));
  }
  out.push(fxRing(to, FX_C.stone, 1.3, .9, 500, { cls: "square" }));
  out.push(fxShake(3, 200));
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
  const own = FX_OWNER(e.caster);
  const out = [fxCastTell(e.caster)];
  if (FX_BIG[e.id]) {
    // These four hold input. The lock is released when the banner ends, and by
    // run()'s finally as a backstop, so a thrown effect cannot strand it.
    FX.lock++;
    out.push(
      fxBanner(S.name || e.id, S.flavor || null, own, 1800)
        .then(() => { FX.lock = Math.max(0, FX.lock - 1); })
    );
    // A rolling shake rather than a single kick — these bend the rules, and
    // that should feel less like a hit and more like the ground giving.
    out.push(fxShake(12, 600));
    out.push(sleepFX(420).then(() => fxShake(8, 500)));
  } else {
    // Even an ordinary spell announces itself from the caster's edge — and it
    // has to be the EDGE. Centred on fxMid() it reads as an event happening on
    // the middle square, so the spell's own effect a beat later looks like the
    // ring jumping from the centre of the board to the piece it was always
    // about. From off-board it is unmistakably a wash arriving from a player's
    // side, which is what this beat is for: the cast, not the target.
    out.push(sleepFX(120).then(() => fxShockwave(fxHome(e.caster), own, 1050, { count: 2, from: 1.6 })));
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
  ], 820, { easing: "linear" }));

  // What it leaves behind at the square it is being pulled out of.
  const after = fxGhost(e.from, pd);
  after.classList.add("fx-trail");
  return Promise.all([
    stutter,
    fxPlay(after, [{ opacity: .4, filter: "saturate(.2)" }, { opacity: 0 }], 460),
    // Time going backwards, so the wave does too — it converges on the square
    // the piece is being pulled back to.
    sleepFX(200).then(() => fxCollapse(b, FX_C.frost, 900, { count: 3, reach: .9 })),
    sleepFX(700).then(() => Promise.all([
      fxGlow(b, FX_C.frost, 1.6, 460, { peak: .6 }),
      fxShockwave(b, FX_C.frost, 800, { count: 2 }),
      fxShake(4, 220),
      fxAfterglow(e.to, FX_C.frost, 900, { peak: .4 }),
    ])),
  ]);
};

/** A scramble, not a leap: low, fast, backwards, and it costs the pawn its legs. */
FX_PLAY.evasive = function (e) {
  const pd = e.piece;
  FX.mask(e.to);
  const g = fxGhost(e.from, pd);
  const a = fxCtr(e.from), b = fxCtr(e.to);
  const ms = 690;

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
  out.push(fxGlow(a, "#cfd6ef", 1.3, 460, { peak: .4 }));
  out.push(fxStreaks(a, "#cfd6ef", 6, 520,
    { bias: Math.atan2(a.y - b.y, a.x - b.x) }));   // dust kicked back the way it fled
  out.push(fxShockwave(a, "#cfd6ef", 700, { count: 2, reach: .55 }));
  // It bought the escape with its next move; the pending-penalty hue says so.
  out.push(sleepFX(ms * .8).then(() => Promise.all([
    fxRing(b, FX_C.frost, .5, 1.7, 560, { cls: "dashed" }),
    fxAfterglow(e.to, FX_C.frost, 800, { peak: .35 }),
  ])));
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
      out.push(fxPlay(sl, reverse ? frames.slice().reverse() : frames, 380,
        { easing: reverse ? "cubic-bezier(.2,.9,.3,1)" : "ease-in" }));
    }
    return Promise.all(out);
  };

  const a = fxCtr(e.from), b = fxCtr(e.to);
  const out = [
    shatterSlices(a, false),
    fxCollapse(a, FX_C.time, 620, { count: 2, reach: .7 }),   // she is pulled out
    sleepFX(260).then(() => fxSweep(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, 560)),
    // Reassembling on the far side IS the arrival; the Distortion Field ripples
    // below run on afterwards and must not hold the queen off her square.
    FX.landing(e.to, sleepFX(540).then(() => shatterSlices(b, true))),
    sleepFX(800).then(() => Promise.all([
      fxGlow(b, FX_C.time, 2.2, 460, { peak: .8 }),
      fxShockwave(b, FX_C.time, 900, { count: 3 }),           // and slammed back in
      fxSparks(b, FX_C.time, 8, 700),
      fxShake(5, 240),
      fxAfterglow(e.to, FX_C.time, 900, { peak: .45 }),
    ])),
  ];
  for (const j of (e.ripples || []))
    out.push(sleepFX(860).then(() => fxRing(fxCtr(j), FX_C.frost, .4, 2, 560, { cls: "dashed" })));
  return Promise.all(out);
};

/* ── combat spells ──────────────────────────────────────────────────────── */

/** A ring drops and clamps. Electric, not smooth — it flickers rather than eases. */
FX_PLAY.veil = function (e) {
  const c = fxCtr(e.at), S = fxSize();
  const out = [
    fxRing(c, FX_C.stun, 2.2, 1, 420, { cls: "thick", from: .2, easing: "cubic-bezier(.3,1.3,.4,1)" }),
    sleepFX(390).then(() => Promise.all([
      fxGlow(c, FX_C.stun, 2.0, 400, { peak: .9 }),
      fxShockwave(c, FX_C.stun, 1050, { count: 3 }),   // the stun rolls outward
      fxShake(4, 220),
      fxAfterglow(e.at, FX_C.stun, 900, { peak: .45 }),
    ])),
  ];
  const arcs = fxN(12);
  for (let k = 0; k < arcs; k++) {
    const ang = (k / arcs) * Math.PI * 2;
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
    ], 740, { delay: 350 + rand(0, 210), easing: "steps(1,end)" }));
  }
  out.push(sleepFX(600).then(() => fxRing(c, FX_C.stun, 1, 2.2, 460)));
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
    fxRing(c, FX_C.dead, 2, .9, 400, { cls: "thick", from: .3 }),
    sleepFX(300).then(() => fxPlay(iris, [
      { transform: "scaleY(.04)", opacity: 0 },
      { transform: "scaleY(1)", opacity: 1, offset: .35 },
      { transform: "scaleY(1)", opacity: 1, offset: .72 },
      { transform: "scaleY(.04)", opacity: 0 },
    ], 820, { easing: "cubic-bezier(.3,.9,.3,1)" })),
    // The eye opens and the threat spreads. The opponent has to SEE this —
    // the whole card only works if they do — so it goes to the edges.
    sleepFX(560).then(() => Promise.all([
      fxShockwave(c, FX_C.dead, 1050, { count: 3 }),
      fxRing(c, FX_C.dead, .8, 2.3, 560),
      fxSparks(c, FX_C.dead, 7, 700),
      fxShake(4, 220),
      fxAfterglow(e.at, FX_C.dead, 1000, { peak: .5 }),
    ])),
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

  const arms = Math.max(3, fxN(3));
  for (let k = 0; k < arms; k++) {
    const off = (k - (arms - 1) / 2) * S * .8;
    const from = { x: src.x + off, y: src.y };
    out.push(fxLine(from, c, "fx-tendril", own, Math.max(3, S * .1), 1350, {
      frames: [
        { transform: `rotate(${Math.atan2(c.y - from.y, c.x - from.x) * 180 / Math.PI}deg) scaleX(0) scaleY(1)`, opacity: .9 },
        { transform: `rotate(${Math.atan2(c.y - from.y, c.x - from.x) * 180 / Math.PI}deg) scaleX(1) scaleY(1.3)`, opacity: .9, offset: .45 },
        { transform: `rotate(${Math.atan2(c.y - from.y, c.x - from.x) * 180 / Math.PI}deg) scaleX(1) scaleY(.7)`, opacity: .75, offset: .7 },
        { transform: `rotate(${Math.atan2(c.y - from.y, c.x - from.x) * 180 / Math.PI}deg) scaleX(1) scaleY(1)`, opacity: 0 },
      ],
      opts: { delay: k * 90, easing: "cubic-bezier(.4,.1,.3,1)" },
    }));
  }

  // The piece changes hands: it takes on the caster's colour, then jerks.
  const p = G.board[e.at];
  if (p) {
    out.push(sleepFX(630).then(() => {
      const g = fxGhost(e.at, { owner: e.caster, rank: p.rank, form: p.form });
      return fxPlay(g, [
        { opacity: 0, transform: "translate(0,0)" },
        { opacity: .75, transform: "translate(0,0)", offset: .3 },
        { opacity: .75, transform: `translate(${rand(-1, 1) * S * .1}px,${-S * .06}px)`, offset: .62 },
        { opacity: .6, transform: "translate(0,0)" },
      ], 950, { easing: "cubic-bezier(.4,1.6,.5,1)" });
    }));
  }
  // The grip closes, and the board registers it.
  out.push(sleepFX(690).then(() => Promise.all([
    fxRing(c, FX_C.arcane, 1.6, .9, 460, { cls: "thick", from: .8 }),
    fxShockwave(c, FX_C.arcane, 1100, { count: 3 }),
    fxGlow(c, own, 2.0, 520, { peak: .75 }),
    fxAfterglow(e.at, FX_C.arcane, 1100, { peak: .5 }),
  ])));
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
  ], 1800));
  out.push(fxPlay(hand, [
    { transform: "rotate(0deg)", opacity: .9 },
    { transform: "rotate(-1440deg)", opacity: .9, offset: .78 },
    { transform: "rotate(-1680deg)", opacity: 0 },
  ], 1800, { easing: "cubic-bezier(.3,0,.6,1)" }));

  // Time collapsing inward, then blowing back out on the far side of the swap.
  for (let k = 0; k < 3; k++) {
    out.push(sleepFX(240 + k * 130).then(() => fxCollapse(mid, FX_C.time, 800, { count: 1, reach: 1 })));
    out.push(sleepFX(980 + k * 130).then(() => fxShockwave(mid, FX_C.time, 900, { count: 1 })));
  }

  // The board itself dips out and comes back on the restored state.
  if (board) {
    board.animate([
      { filter: "saturate(1)", opacity: 1 },
      { filter: "saturate(.1)", opacity: .28, offset: .45 },
      { filter: "saturate(.1)", opacity: .28, offset: .55 },
      { filter: "saturate(1)", opacity: 1 },
    ], { duration: 1800 * FX.rate, easing: "ease-in-out" });
  }

  // And then: this is what moved. The one genuinely useful part of the effect.
  for (const i of (e.changed || []).slice(0, 40))
    out.push(sleepFX(1000).then(() => Promise.all([
      fxRing(fxCtr(i), FX_C.time, .5, 1.8, 700, { cls: "thick", from: .95 }),
      fxAfterglow(i, FX_C.time, 900, { peak: .5 }),
    ])));

  return Promise.all(out);
};

/** Frost floods the board and time stops for everyone but the caster. */
FX_PLAY.cascade = function (e) {
  const b = fxBoardRect();
  const own = e.caster;
  const out = [
    fxWash(FX_C.frost, 1900, { peak: .3 }),
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
  ], 940, { easing: "cubic-bezier(.2,.7,.3,1)" }));

  // Three pulses, one per turn taken. Numbered, so the count is unmistakable,
  // and each one throws a real wave the length of the board.
  const mid = fxMid();
  for (let k = 0; k < 3; k++) {
    out.push(sleepFX(520 + k * 300).then(() => Promise.all([
      fxShockwave(mid, FX_C.frost, 900, { count: 2 }),
      fxGlyph(mid, String(k + 1), FX_C.frost, 620, { size: 1.1 }),
      fxShake(7 - k, 260),
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
  const hovering = fxN(10);
  for (let k = 0; k < hovering; k++) {
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
    ], 1300, { easing: "cubic-bezier(.4,0,.5,1)" }));
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
    sleepFX(440).then(() => fxPlay(col, [
      { transform: "scaleY(.05) scaleX(.4)", opacity: 0 },
      { transform: "scaleY(1) scaleX(1)", opacity: .92, offset: .4 },
      { transform: "scaleY(1) scaleX(1.1)", opacity: .92, offset: .72 },
      { transform: "scaleY(1) scaleX(.6)", opacity: 0 },
    ], 1180, { easing: "cubic-bezier(.2,.8,.3,1)" })),
    // She is standing there as soon as she has materialised. Everything after
    // is for her, not instead of her.
    FX.landing(e.at, sleepFX(880).then(() => {
      const g = fxGhost(e.at, { owner: e.owner, rank: "queen", form: null });
      return fxPlay(g, [
        { transform: "translateY(-90%) scale(1.6)", opacity: 0 },
        { transform: "translateY(0) scale(1)", opacity: 1, offset: .6 },
        { transform: "scale(1)", opacity: 1 },
      ], 590, { easing: "cubic-bezier(.2,.9,.3,1)" });
    })),
    // A queen coming back from the dead is the loudest thing in the ruleset.
    sleepFX(1380).then(() => Promise.all([
      fxShockwave(c, FX_C.time, 1000, { count: 3 }),
      sleepFX(150).then(() => fxShockwave(c, own, 950, { count: 2, from: .8 })),
      fxRing(c, FX_C.time, .4, 2.8, 620, { cls: "thick" }),
      fxGlow(c, FX_C.time, 2.6, 560, { peak: .9 }),
      fxSparks(c, (k) => (k % 2 ? FX_C.time : own), 10, 820),
      fxStreaks(c, own, 8, 700),
      fxShake(9, 340),
      fxAfterglow(e.at, own, 1300, { peak: .6, spread: 2.6 }),
    ])),
  ]);
};

/* ══════════════════════════════════════════════════════════════════════════
   THE BOARD ITSELF

   These change the terms of play rather than any one piece, and they outlast
   the turn that paid for them. So each one ends by leaving a mark the board
   keeps — the .riftend and .barrier auras in fx.css — and the effect here is
   only the moment of carving it.
   ══════════════════════════════════════════════════════════════════════════ */

/** Two mouths open and reach for each other. */
FX_PLAY.rift = function (e) {
  const a = fxCtr(e.a), b = fxCtr(e.b);
  const pair = (c, delay) => sleepFX(delay).then(() => Promise.all([
    fxRing(c, FX_C.arcane, 2.4, .3, 480, { cls: "thick", easing: "cubic-bezier(.3,1.2,.4,1)" }),
    fxGlow(c, FX_C.arcane, 2.0, 460, { peak: .9 }),
    fxSparks(c, FX_C.arcane, 7, 620),
    fxAfterglow(c === a ? e.a : e.b, FX_C.arcane, 1000, { peak: .5, spread: 2.2 }),
  ]));
  return Promise.all([
    pair(a, 0),
    pair(b, 140),
    sleepFX(420).then(() => fxSweep(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, 620)),
  ]);
};

/** The carry itself: swallowed at one end, spat out at the other. */
FX_PLAY.riftCarry = function (e) {
  const a = fxCtr(e.from), b = fxCtr(e.to);
  FX.mask(e.to);
  return Promise.all([
    fxCollapse(a, FX_C.arcane, 420, { count: 2, reach: .8 }),
    fxRing(a, FX_C.arcane, .4, 2.2, 460, { cls: "dashed" }),
    FX.landing(e.to, sleepFX(300).then(() => Promise.all([
      fxGlow(b, FX_C.arcane, 2.2, 420, { peak: .95 }),
      fxShockwave(b, FX_C.arcane, 780, { count: 2 }),
      fxSparks(b, FX_C.arcane, 8, 620),
    ]))),
    fxAfterglow(e.to, FX_C.arcane, 900, { peak: .5 }),
  ]);
};

/** The edges join: a wave runs off one side of the board and back on the other. */
FX_PLAY.wraparound = function (e) {
  const own = FX_OWNER(e.caster);
  const out = [fxBanner(SPELLS.wraparound.name, SPELLS.wraparound.flavor, own, 1400), fxShake(6, 420)];
  // Light the whole of both edge columns, so it is obvious WHICH edges joined.
  for (let r = 0; r < N; r++) {
    for (const c of [0, N - 1]) {
      const i = rc(r, c);
      if (!isDark(i)) continue;
      out.push(sleepFX(r * 26).then(() => fxRing(fxCtr(i), FX_C.arcane, .4, 1.9, 520, { cls: "dashed" })));
    }
  }
  return Promise.all(out);
};

/** Time is pinned. One heavy ring, and the board stops shivering. */
FX_PLAY.anchor = function (e) {
  const own = FX_OWNER(e.caster);
  return Promise.all([
    fxBanner(SPELLS.anchor.name, SPELLS.anchor.flavor, own, 1300),
    fxSweep(0, 520),
    fxShake(7, 300),
  ]);
};

/** A piece is pulled back to where it stood: the ghost arrives before it does. */
FX_PLAY.echo = function (e) {
  const a = fxCtr(e.from), b = fxCtr(e.to);
  FX.mask(e.to);
  const ghost = e.piece ? fxGhost(e.to, e.piece) : null;
  return Promise.all([
    ghost ? fxPlay(ghost, [
      { opacity: .28, transform: "scale(1.04)" },
      { opacity: .55, transform: "scale(1)" },
    ], 460, { easing: "ease-out" }) : Promise.resolve(),
    fxCollapse(a, FX_C.time, 460, { count: 2, reach: .75 }),
    fxRing(a, FX_C.time, .4, 2.1, 480, { cls: "dashed" }),
    FX.landing(e.to, sleepFX(360).then(() => Promise.all([
      fxGlow(b, FX_C.time, 2.1, 440, { peak: .85 }),
      fxShockwave(b, FX_C.time, 760, { count: 2 }),
      fxGlyph(b, "⟲", FX_C.time, 560, { size: .55 }),
    ]))),
    fxAfterglow(e.to, FX_C.time, 950, { peak: .45 }),
  ]);
};

/** A square is sealed. Stone, and it lands hard. */
FX_PLAY.chokepoint = function (e) {
  const c = fxCtr(e.at);
  return Promise.all([
    fxRing(c, FX_C.stone, 2.6, .35, 460, { cls: "thick", easing: "cubic-bezier(.3,1.25,.4,1)" }),
    sleepFX(400).then(() => Promise.all([
      fxGlow(c, FX_C.stone, 2.2, 460, { peak: .95 }),
      fxShockwave(c, FX_C.stone, 900, { count: 3 }),
      fxGlyph(c, "▩", FX_C.stone, 620, { size: .6 }),
      fxShake(8, 320),
    ])),
    fxAfterglow(e.at, FX_C.stone, 1200, { peak: .55, spread: 2.2 }),
  ]);
};

/* ══════════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════════ */

FX.loadMode();
document.addEventListener("visibilitychange", () => { if (document.hidden) FX.abort(); });
