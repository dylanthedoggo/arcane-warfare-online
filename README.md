# Checkers Arcane Warfare

Checkers on a 12×12 board, with spell cards, Focus Points and pieces that
change form. You can play it three ways:

- **Hot-seat** — two people, one device.
- **Against the machine** — three levels: Novice, Skilled, Ruthless.
- **Online** — two devices. The server is the referee.

## Run it

You need Node 18 or newer.

```bash
npm install
```

```bash
npm start
```

Then open <http://localhost:3000>.

## Test it

```bash
npm test
```

This is fast. It proves that the referee refuses cheating and that a bad
message cannot stop the server. The deploy runs it first.

```bash
npm run test:ai
```

This is slow (about 5 minutes). It proves that the machine still plays well.
Run it after any change to `public/ai.js` or `public/engine.js`.

There is also a test page in the browser: <http://localhost:3000/?test=1>.

## Where things are

| File | What it is |
| --- | --- |
| `server.js` | The online referee. It holds the real game for each room. |
| `public/engine.js` | The rules. The browser and the server run this same file. |
| `public/ai.js` | The machine. |
| `public/ai-worker.js` | Runs the machine's thinking on a background thread. |
| `public/app.js` | The interface: board, hand, menus, online client. |
| `public/fx.js`, `fx.css` | Animations. |
| `public/styles.css` | The look of the page. |
| `public/selftest.js` | The in-browser test page. |
| `public/main.js` | Starts the page. |
| `public/index.html` | The page markup. It loads the files above. |
| `test/` | The test suites. |
| `tools/` | Runs the machine without a browser, to measure it. |

## Two rules that keep it correct

1. **One copy of the rules.** `engine.js` decides what is legal. Nothing else
   does. The machine has a fast board update of its own for searching, and a
   test compares it with the engine jump by jump.
2. **The server trusts nothing.** Every action a player sends is checked by the
   engine. Each player is sent only what that player may know.

## More

- [DEPLOY.md](DEPLOY.md) — how to put it online with Render.
- [AI-NODE-PORT.md](AI-NODE-PORT.md) — notes on how the machine was made to run
  without a browser.
