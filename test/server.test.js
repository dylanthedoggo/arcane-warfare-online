"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   SERVER SUITE — a client cannot stop the server

       npm test        (runs after the cheat-rejection suite)

   The engine suite proves the referee refuses a bad ACTION. This proves the
   server survives a bad MESSAGE: null, a number, or nothing at all where an
   object is expected. One of those used to throw inside a socket handler,
   which stops the whole process and every game on it.

   It starts the real server.js on a spare port and talks to it over a raw
   WebSocket, so there is no client library to hide a malformed frame behind.
   ══════════════════════════════════════════════════════════════════════════ */

const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const engine = require("../public/engine.js");

const PORT = String(20000 + Math.floor(Math.random() * 20000));
const failures = [];
let passed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`    ok   ${name}`); return; }
  failures.push(name);
  console.log(`    FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
}

/* Socket.IO frames, written by hand: "42" + JSON is an event, "42<id>" + JSON
   is an event that wants an answer, and "43<id>" + JSON is that answer. */
const BAD = [
  '42["create",null]', '42["create"]', '42["create",5]', '42["create","x"]',
  '42["join",null]', '42["join",{"room":["A"],"token":{}}]',
  '42["hello",null]', '42["hello",{"room":{}}]',
  '42["action",null]', '42["action","x"]', '42["action",[1,2]]',
  '42["undoRequest",null]', '42["undoRespond",null]', '42["leave",null]',
  '421["create",null]', '422["join",null]', '423["hello",7]',
];

function client(onReady) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=websocket`);
  const c = { ws, acks: {}, events: [], next: 100 };
  c.emit = (event, data, onAck) => {
    if (!onAck) { ws.send(`42${JSON.stringify([event, data])}`); return; }
    const id = c.next++;
    c.acks[id] = onAck;
    ws.send(`42${id}${JSON.stringify([event, data])}`);
  };
  ws.on("message", (raw) => {
    const m = String(raw);
    if (m[0] === "0") ws.send("40");                 // transport open: join the namespace
    else if (m === "2") ws.send("3");                // ping
    else if (m.startsWith("40")) onReady(c);
    else if (m.startsWith("43")) {
      const id = parseInt(m.slice(2), 10);
      const ack = c.acks[id];
      if (ack) ack(JSON.parse(m.slice(2 + String(id).length))[0]);
    } else if (m.startsWith("42")) c.events.push(JSON.parse(m.slice(2)));
  });
  ws.on("error", () => {});
  return c;
}

/** Gold's first legal quiet move, taken from the engine itself. */
function openingMove() {
  const { out } = engine.withGame(engine.newGame(0, 1, { mode: "online" }), () => {
    const g = engine.getG();
    for (let i = 0; i < engine.CELLS; i++) {
      if (!g.board[i] || g.board[i].owner !== 0) continue;
      const mv = engine.simpleMoves(i)[0];
      if (mv) return { t: "move", from: i, to: mv.to, kind: mv.kind };
    }
    return null;
  });
  return out;
}

console.log("\n  a client cannot stop the server");

const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")],
  { env: { ...process.env, PORT } });
let stderr = "";
let exited = false;
server.stderr.on("data", (d) => { stderr += d; });
server.on("exit", () => { exited = true; });

function finish() {
  server.kill();
  console.log("");
  if (failures.length) {
    console.log(`✗ ${failures.length} failed, ${passed} passed\n`);
    console.log("The server can be stopped or confused by a client. Deploy stopped.\n");
    process.exit(1);
  }
  console.log(`✓ ${passed} server checks passed\n`);
  process.exit(0);
}

const giveUp = setTimeout(() => {
  check("the server answered in time", false, exited ? `it exited:\n${stderr.slice(0, 600)}` : "no answer in 20s");
  finish();
}, 20000);

let started = false;
server.stdout.on("data", () => {
  if (started) return;
  started = true;

  client((a) => {
    for (const frame of BAD) a.ws.send(frame);

    // If the server is still up, an honest request after all that is answered.
    a.emit("create", { token: "token-a" }, (made) => {
      check(`it survives ${BAD.length} malformed messages`, !exited, stderr.slice(0, 600));
      check("...and then hosts a game as usual", made && made.ok === true && made.seat === 0,
        JSON.stringify(made));

      client((b) => {
        b.emit("join", { room: made.room, token: "token-b" }, (joined) => {
          check("a second player can join it", joined && joined.ok === true && joined.seat === 1,
            JSON.stringify(joined));

          a.emit("action", openingMove());
          setTimeout(() => {
            const state = b.events.filter((e) => e[0] === "state").pop();
            check("a move by one player reaches the other",
              !!state && state[1].turn === 1 && state[1].lastMove != null,
              state ? `turn ${state[1].turn}, lastMove ${JSON.stringify(state[1].lastMove)}` : "no state was pushed");
            check("the malformed messages were answered with a refusal, not silence",
              a.events.some((e) => e[0] === "rejected"));
            check("the server is still running at the end", !exited, stderr.slice(0, 600));
            clearTimeout(giveUp);
            finish();
          }, 600);
        });
      });
    });
  });
});
