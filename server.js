"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   CHECKERS ARCANE WARFARE — game server

   Holds the real game. Clients hold a rendering of it.

   Every player action arrives as a small object, is checked by applyAction()
   in public/engine.js — the same function the browser uses offline — and is
   either applied to this process's copy of the state or refused. Nothing a
   client sends is trusted: not the seat it claims, not the victim of a jump,
   not the target of a spell. The board goes back out through viewFor(), which
   strips the opponent's hand, the deck order, and the undo snapshots.

   Concurrency note. The engine keeps one module-level `G`, so a room's state is
   swapped in with setG() immediately before each applyAction() and read back
   with getG() immediately after — restore() (used by the rollback path and by
   Chronos's Gaze) REPLACES G rather than mutating it, so skipping that read-back
   silently loses moves. This is safe only because Node is single-threaded and
   applyAction never awaits. Do not make anything on this path async.
   ══════════════════════════════════════════════════════════════════════════ */

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const engine = require("./public/engine.js");
const { newGame, beginTurn, log, applyAction, viewFor, setG, getG, undoTarget, applyUndoTo } = engine;

const PORT = process.env.PORT || 3000;
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;   // forget a room nobody has touched in 2h
const GC_EVERY_MS = 10 * 60 * 1000;
const MAX_ROOMS = 500;                     // free-tier memory guard
const ACTION_BURST = 40;                   // actions per socket per window
const ACTION_WINDOW_MS = 10 * 1000;

/* ── http ────────────────────────────────────────────────────────────────── */

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

/* ── rooms ───────────────────────────────────────────────────────────────── */

/**
 * code -> {
 *   code, G,
 *   seats:  [ {token, socketId} | null, {token, socketId} | null ],
 *   undoOffer: { from, turn, turnNo } | null,
 *   lastSeen
 * }
 */
const rooms = new Map();

// No I or O — they are the letters people mistype off a screenshot.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

function makeCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = "";
    for (let k = 0; k < 4; k++) c += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
    if (!rooms.has(c)) return c;
  }
  return null;
}

const seatOnline = (room, seat) => !!(room.seats[seat] && room.seats[seat].socketId);
const socketOf = (room, seat) =>
  seatOnline(room, seat) ? io.sockets.sockets.get(room.seats[seat].socketId) : null;

/** Send each connected player their own redacted view of the board. */
function pushState(room) {
  for (const seat of [0, 1]) {
    const sock = socketOf(room, seat);
    if (sock) sock.emit("state", viewFor(room.G, seat, { oppConnected: seatOnline(room, 1 - seat) }));
  }
}

function pushPresence(room) {
  for (const seat of [0, 1]) {
    const sock = socketOf(room, seat);
    if (sock) sock.emit("presence", { oppConnected: seatOnline(room, 1 - seat) });
  }
}

/** Run one action against a room's state. See the concurrency note up top. */
function runAction(room, seat, action) {
  setG(room.G);
  const res = applyAction(seat, action);
  room.G = getG();                 // restore() may have swapped the object out
  room.lastSeen = Date.now();
  return res;
}

/* ── connections ─────────────────────────────────────────────────────────── */

/** socket.id -> { code, seat } */
const attached = new Map();

function contextOf(socket) {
  const at = attached.get(socket.id);
  if (!at) return null;
  const room = rooms.get(at.code);
  if (!room) { attached.delete(socket.id); return null; }
  return { room, seat: at.seat };
}

/**
 * Let go of whatever room this socket was in. Without this, starting a second
 * game on the same connection leaves the first room believing the seat is still
 * occupied, and it keeps pushing state to somebody who has walked away.
 */
function releaseSocket(socket) {
  const at = attached.get(socket.id);
  if (!at) return;
  attached.delete(socket.id);
  const room = rooms.get(at.code);
  if (!room) return;
  if (room.seats[at.seat] && room.seats[at.seat].socketId === socket.id) room.seats[at.seat].socketId = null;
  socket.leave(at.code);
  pushPresence(room);
}

function seatSocket(room, seat, socket) {
  releaseSocket(socket);
  // If the same seat is open in another tab, drop the older one — two windows
  // driving one seat is a confusing way to lose a game.
  const prev = socketOf(room, seat);
  if (prev && prev.id !== socket.id) {
    prev.emit("roomClosed", { reason: "You opened this game somewhere else, so this window was released." });
    attached.delete(prev.id);
    prev.leave(room.code);
  }
  room.seats[seat].socketId = socket.id;
  attached.set(socket.id, { code: room.code, seat });
  socket.join(room.code);
  room.lastSeen = Date.now();
}

function ackJoined(socket, room, seat) {
  return {
    ok: true,
    room: room.code,
    seat,
    oppConnected: seatOnline(room, 1 - seat),
    state: viewFor(room.G, seat, { oppConnected: seatOnline(room, 1 - seat) }),
  };
}

io.on("connection", (socket) => {
  let budget = ACTION_BURST;
  const refill = setInterval(() => { budget = ACTION_BURST; }, ACTION_WINDOW_MS);

  const reply = (ack, payload) => { if (typeof ack === "function") ack(payload); };

  /* ── host a game ───────────────────────────────────────────────────────── */
  socket.on("create", ({ token } = {}, ack) => {
    if (rooms.size >= MAX_ROOMS) return reply(ack, { ok: false, err: "The server is full — try again in a while." });
    if (!token || typeof token !== "string") return reply(ack, { ok: false, err: "Missing player token." });
    const code = makeCode();
    if (!code) return reply(ack, { ok: false, err: "Could not allocate a room code." });

    const room = {
      code,
      G: newGame(0),                      // the host takes Gold, and Gold opens
      seats: [{ token, socketId: null }, null],
      undoOffer: null,
      lastSeen: Date.now(),
    };
    // Mirror the client's boot(): turnNo starts at 0 so beginTurn makes it 1.
    setG(room.G);
    room.G.turnNo = 0;
    log("A new game begins. Pieces hold the dark squares; the four centre rows are the separation space.", "sys");
    log(`Online game — room ${code}. The server is the referee.`, "sys");
    beginTurn(0);
    room.G = getG();

    rooms.set(code, room);
    seatSocket(room, 0, socket);
    reply(ack, ackJoined(socket, room, 0));
  });

  /* ── join a game ───────────────────────────────────────────────────────── */
  socket.on("join", ({ room: code, token } = {}, ack) => {
    if (!token || typeof token !== "string") return reply(ack, { ok: false, err: "Missing player token." });
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return reply(ack, { ok: false, err: "No game with that code. Check the letters, or ask for a new link." });

    // Already one of the players? Treat it as a reconnect.
    const mine = room.seats.findIndex((s) => s && s.token === token);
    if (mine >= 0) {
      seatSocket(room, mine, socket);
      pushPresence(room);
      return reply(ack, ackJoined(socket, room, mine));
    }
    if (room.seats[1]) return reply(ack, { ok: false, err: "That game already has two players." });

    room.seats[1] = { token, socketId: null };
    seatSocket(room, 1, socket);
    pushPresence(room);
    pushState(room);
    reply(ack, ackJoined(socket, room, 1));
  });

  /* ── reclaim a seat after a refresh or a dropped connection ────────────── */
  socket.on("hello", ({ room: code, token } = {}, ack) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return reply(ack, { ok: false, err: "That game is no longer on the server." });
    const seat = room.seats.findIndex((s) => s && s.token === token);
    if (seat < 0) return reply(ack, { ok: false, err: "That seat is not yours." });
    seatSocket(room, seat, socket);
    pushPresence(room);
    reply(ack, ackJoined(socket, room, seat));
  });

  /* ── play ──────────────────────────────────────────────────────────────── */
  socket.on("action", (action) => {
    const ctx = contextOf(socket);
    if (!ctx) return socket.emit("rejected", { err: "You are not in a game." });
    if (budget-- <= 0) return socket.emit("rejected", { err: "Slow down." });

    const { room, seat } = ctx;
    if (room.undoOffer) return socket.emit("rejected", { err: "An undo request is waiting on an answer." });
    if (!room.seats[1]) return socket.emit("rejected", { err: "Nobody has joined yet." });

    const res = runAction(room, seat, action);
    if (!res.ok) {
      // Re-send the truth as well as the reason: a client that got here by
      // being edited needs its board put back the way it really is.
      socket.emit("rejected", { err: res.err });
      const sock = socketOf(room, seat);
      if (sock) sock.emit("state", viewFor(room.G, seat, { oppConnected: seatOnline(room, 1 - seat) }));
      return;
    }
    pushState(room);
  });

  /* ── undo handshake ────────────────────────────────────────────────────── */
  socket.on("undoRequest", () => {
    const ctx = contextOf(socket);
    if (!ctx) return;
    const { room, seat } = ctx;
    if (room.G.over) return socket.emit("rejected", { err: "The game is over." });
    if (room.undoOffer) return socket.emit("rejected", { err: "There is already an undo request pending." });
    if (!seatOnline(room, 1 - seat)) return socket.emit("rejected", { err: "Your opponent is not here to agree." });

    setG(room.G);
    const t = undoTarget();
    if (!t) return socket.emit("rejected", { err: "Nothing to undo yet." });

    room.undoOffer = { from: seat, turn: t.turn, turnNo: t.turnNo };
    room.lastSeen = Date.now();
    socketOf(room, 1 - seat).emit("undoOffer", { turn: t.turn, turnNo: t.turnNo });
  });

  socket.on("undoRespond", ({ accept } = {}) => {
    const ctx = contextOf(socket);
    if (!ctx) return;
    const { room, seat } = ctx;
    const offer = room.undoOffer;
    if (!offer || offer.from === seat) return;      // only the other player answers
    room.undoOffer = null;
    room.lastSeen = Date.now();

    const asker = socketOf(room, offer.from);
    if (asker) asker.emit("undoResult", { accepted: !!accept });
    if (!accept) return;

    setG(room.G);
    const target = getG().history.find((h) => h.turn === offer.turn && h.turnNo === offer.turnNo);
    if (!target) {
      if (asker) asker.emit("rejected", { err: "That point in the game has scrolled out of history." });
      return;
    }
    applyUndoTo(target);
    room.G = getG();
    pushState(room);
  });

  /* ── leaving ───────────────────────────────────────────────────────────── */
  const detach = () => {
    const ctx = contextOf(socket);
    // An undo request dies with the connection that could have answered it.
    if (ctx && ctx.room.undoOffer) {
      ctx.room.undoOffer = null;
      const other = socketOf(ctx.room, 1 - ctx.seat);
      if (other) other.emit("undoResult", { accepted: false });
    }
    releaseSocket(socket);
  };

  socket.on("leave", detach);
  socket.on("disconnect", () => { clearInterval(refill); detach(); });
});

/* ── housekeeping ────────────────────────────────────────────────────────── */

setInterval(() => {
  const cutoff = Date.now() - ROOM_IDLE_MS;
  for (const [code, room] of rooms)
    if (room.lastSeen < cutoff && !seatOnline(room, 0) && !seatOnline(room, 1)) rooms.delete(code);
}, GC_EVERY_MS).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Checkers Arcane Warfare listening on ${PORT}`);
});
