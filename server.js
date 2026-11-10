"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   CHECKERS ARCANE WARFARE — game server

   Holds the real game. Clients hold a rendering of it.

   Every player action arrives as a small object, is checked by applyAction()
   in public/engine.js — the same function the browser uses offline — and is
   either applied to this process's copy of the state or refused. Nothing a
   client sends is trusted: not the seat it claims, not the victim of a jump,
   not the target of a spell. The board goes back out through viewFor(), which
   strips the opponent's hand and the undo snapshots.

   One door to a game. The engine works on one game at a time. inGame() is the
   only place this file opens a room's game: it loads the game, runs the engine
   call, and saves the game back. The engine refuses an async callback, and it
   holds no game between calls, so one room cannot touch another room's game.
   ══════════════════════════════════════════════════════════════════════════ */

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const engine = require("./public/engine.js");
const {
  newGame, beginTurn, log, applyAction, viewFor, withGame, undoTarget, applyUndoTo,
  playRandomTurn, PRESSURE_SECONDS,
} = engine;

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

/* ── the Pressure clock ───────────────────────────────────────────────────
   The only wall-clock in the game, and the only reason this file holds a timer
   at all. Everything else here is driven by discrete events; nothing else has
   a deadline.

   The engine does not look at a clock. It records `players[seat].timed` — a
   counter on the same machinery as every other lockout — and this reads it.
   That split is what keeps the rules replayable: the same actions in the same
   order give the same game whether or not anybody ran out of time.
   ─────────────────────────────────────────────────────────────────────── */

const PRESSURE_MS = PRESSURE_SECONDS * 1000;

function clearClock(room) {
  if (room.clock) { clearTimeout(room.clock.timer); room.clock = null; }
}

/** Milliseconds left on this room's clock, or null if it is not running. */
function clockLeft(room) {
  return room.clock ? Math.max(0, room.clock.deadline - Date.now()) : null;
}

/**
 * Start, keep or stop the clock so it matches the state of the game.
 *
 * Called after anything that could change whose turn it is or who is here.
 * The clock is suspended while the player on it is disconnected: a refresh
 * should not cost somebody their turn, and they cannot act while away, so
 * dropping the connection buys nothing but the reconnect.
 */
function syncClock(room) {
  const g = room.G;
  const seat = g.turn;
  const wanted = !g.over && !!room.seats[1] && seatOnline(room, seat)
    && g.players[seat].timed > 0;

  if (!wanted) { clearClock(room); return; }
  // Already counting down for this exact turn — leave it alone, or every
  // state push would silently hand the player a fresh fifteen seconds.
  if (room.clock && room.clock.seat === seat && room.clock.turnNo === g.turnNo) return;

  clearClock(room);
  const turnNo = g.turnNo;
  room.clock = {
    seat, turnNo,
    deadline: Date.now() + PRESSURE_MS,
    timer: setTimeout(() => expireClock(room, seat, turnNo), PRESSURE_MS),
  };
}

/** The clock ran out. The referee takes the turn. */
function expireClock(room, seat, turnNo) {
  room.clock = null;
  if (rooms.get(room.code) !== room) return;         // the room went away

  // A timer callback has no caller to catch its errors. An error here must
  // cost one turn, not the whole server.
  try {
    // The turn may have been played, undone or rewound between the timer being
    // set and this firing, so the fixture it was set for has to still be there.
    const g = room.G;
    if (!g.over && g.turn === seat && g.turnNo === turnNo) {
      inGame(room, () => playRandomTurn(seat));
      room.lastSeen = Date.now();
      pushState(room);
      return;                                        // pushState re-syncs
    }
    syncClock(room);
  } catch (e) {
    console.error("expireClock threw:", e);
  }
}

/** One seat's view of a room, with everything the wire adds on top of it. */
function stateFor(room, seat) {
  return viewFor(room.G, seat, {
    oppConnected: seatOnline(room, 1 - seat),
    clockMs: clockLeft(room),
    clockSeat: room.clock ? room.clock.seat : null,
  });
}

/** Send each connected player their own redacted view of the board. */
function pushState(room) {
  // Before the send, so the countdown that goes out is the one now running.
  syncClock(room);
  for (const seat of [0, 1]) {
    const sock = socketOf(room, seat);
    if (sock) sock.emit("state", stateFor(room, seat));
  }
}

function pushPresence(room) {
  syncClock(room);                 // a seat leaving or returning starts or stops it
  for (const seat of [0, 1]) {
    const sock = socketOf(room, seat);
    if (sock) sock.emit("presence", {
      oppConnected: seatOnline(room, 1 - seat),
      clockMs: clockLeft(room), clockSeat: room.clock ? room.clock.seat : null,
    });
  }
}

/**
 * The one door to a room's game. Runs `fn` with the room's game loaded in the
 * engine, then saves the game back — the engine can replace the game object
 * (a rollback or Chronos's Gaze does), so the save is not optional.
 */
function inGame(room, fn) {
  const { g, out } = withGame(room.G, fn);
  room.G = g;
  return out;
}

/** Run one action against a room's state. */
function runAction(room, seat, action) {
  const res = inGame(room, () => applyAction(seat, action));
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
    state: stateFor(room, seat),
  };
}

/**
 * Register a handler that a client cannot crash.
 *
 * Nothing a client sends is trusted, and that includes the SHAPE of the
 * message. A client can send null, a number, or nothing at all where an object
 * is expected, and an error thrown in a socket handler stops the whole process
 * — every room with it. So the payload is forced to an object, the reply
 * function is found wherever it is, and any error is caught here.
 */
function onSafe(socket, event, handler) {
  socket.on(event, (...args) => {
    const last = args[args.length - 1];
    const ack = typeof last === "function" ? last : null;
    const first = args[0];
    const data = first && typeof first === "object" && !Array.isArray(first) ? first : {};
    try {
      handler(data, ack);
    } catch (e) {
      console.error(`handler "${event}" threw:`, e);
      if (ack) ack({ ok: false, err: "The server could not read that message." });
      else socket.emit("rejected", { err: "The server could not read that message." });
    }
  });
}

io.on("connection", (socket) => {
  let budget = ACTION_BURST;
  const refill = setInterval(() => { budget = ACTION_BURST; }, ACTION_WINDOW_MS);

  const reply = (ack, payload) => { if (typeof ack === "function") ack(payload); };
  const on = (event, handler) => onSafe(socket, event, handler);

  /* ── host a game ───────────────────────────────────────────────────────── */
  on("create", ({ token }, ack) => {
    if (rooms.size >= MAX_ROOMS) return reply(ack, { ok: false, err: "The server is full — try again in a while." });
    if (!token || typeof token !== "string") return reply(ack, { ok: false, err: "Missing player token." });
    const code = makeCode();
    if (!code) return reply(ack, { ok: false, err: "Could not allocate a room code." });

    const room = {
      code,
      // The host takes Gold, and Gold opens. `mode` is what makes the
      // concealment cards drawable at all — see MODE in engine.js. The
      // sandbox flag is deliberately still not passed, and never should be.
      G: newGame(0, null, { mode: "online" }),
      seats: [{ token, socketId: null }, null],
      undoOffer: null,
      clock: null,                        // Pressure's countdown — see syncClock
      lastSeen: Date.now(),
    };
    // Mirror the client's boot(): turnNo starts at 0 so beginTurn makes it 1.
    room.G.turnNo = 0;
    inGame(room, () => {
      log("A new game begins. Pieces hold the dark squares; the four centre rows are the separation space.", "sys");
      log(`Online game — room ${code}. The server is the referee.`, "sys");
      beginTurn(0);
    });

    rooms.set(code, room);
    seatSocket(room, 0, socket);
    reply(ack, ackJoined(socket, room, 0));
  });

  /* ── join a game ───────────────────────────────────────────────────────── */
  on("join", ({ room: code, token }, ack) => {
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
  on("hello", ({ room: code, token }, ack) => {
    if (!token || typeof token !== "string") return reply(ack, { ok: false, err: "Missing player token." });
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return reply(ack, { ok: false, err: "That game is no longer on the server." });
    const seat = room.seats.findIndex((s) => s && s.token === token);
    if (seat < 0) return reply(ack, { ok: false, err: "That seat is not yours." });
    seatSocket(room, seat, socket);
    pushPresence(room);
    reply(ack, ackJoined(socket, room, seat));
  });

  /* ── play ──────────────────────────────────────────────────────────────── */
  on("action", (action) => {
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
      if (sock) sock.emit("state", stateFor(room, seat));
      return;
    }
    pushState(room);
  });

  /* ── undo handshake ────────────────────────────────────────────────────── */
  on("undoRequest", () => {
    const ctx = contextOf(socket);
    if (!ctx) return;
    const { room, seat } = ctx;
    if (room.G.over) return socket.emit("rejected", { err: "The game is over." });
    if (room.undoOffer) return socket.emit("rejected", { err: "There is already an undo request pending." });
    if (!seatOnline(room, 1 - seat)) return socket.emit("rejected", { err: "Your opponent is not here to agree." });

    const t = inGame(room, () => undoTarget());
    if (!t) return socket.emit("rejected", { err: "Nothing to undo yet." });

    room.undoOffer = { from: seat, turn: t.turn, turnNo: t.turnNo };
    room.lastSeen = Date.now();
    socketOf(room, 1 - seat).emit("undoOffer", { turn: t.turn, turnNo: t.turnNo });
  });

  on("undoRespond", ({ accept }) => {
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

    const target = room.G.history.find((h) => h.turn === offer.turn && h.turnNo === offer.turnNo);
    if (!target) {
      if (asker) asker.emit("rejected", { err: "That point in the game has scrolled out of history." });
      return;
    }
    inGame(room, () => applyUndoTo(target));
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

  on("leave", detach);
  on("disconnect", () => { clearInterval(refill); detach(); });
});

/* ── housekeeping ────────────────────────────────────────────────────────── */

setInterval(() => {
  const cutoff = Date.now() - ROOM_IDLE_MS;
  for (const [code, room] of rooms)
    if (room.lastSeen < cutoff && !seatOnline(room, 0) && !seatOnline(room, 1)) {
      // The timer holds a reference to the room, so forgetting the room
      // without stopping the clock leaks both it and the game it points at.
      clearClock(room);
      rooms.delete(code);
    }
}, GC_EVERY_MS).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Checkers Arcane Warfare listening on ${PORT}`);
});
