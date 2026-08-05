# Deploying to Render

## What you're deploying

```
server.js               the referee — holds the real game, checks every action
public/engine.js        the rules, shared verbatim by browser and server
public/index.html       the interface
test/engine.test.js     cheat-rejection suite, run at build time
render.yaml             Render reads this and configures the service for you
```

---

## 1. Put it on GitHub

The folder isn't a git repo yet. From inside `checkers-arcane-warfare`:

```bash
git init && git add . && git commit -m "Checkers Arcane Warfare: online play"
```

Create an **empty** repo on GitHub (no README, no .gitignore — this folder has one),
then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/checkers-arcane-warfare.git
git branch -M main && git push -u origin main
```

## 2. Create the Render service

1. <https://dashboard.render.com> → **New +** → **Web Service**
2. Connect the GitHub repo.
3. Render finds `render.yaml` and fills everything in. Confirm it shows:
   - Runtime **Node**
   - Build command `npm install && npm test`
   - Start command `npm start`
   - Health check path `/healthz`
   - Instance type **Free**
4. **Create Web Service.**

First build takes a couple of minutes. You get a URL like
`https://checkers-arcane-warfare.onrender.com`.

**No environment variables to set.** Render supplies `PORT`; the server reads it.

## 3. Play

Open the URL. One player picks **Play online → Host a game** and gets a four-letter
code plus a share link (`...onrender.com/?room=ABCD`). The other opens the link, or
picks **Join with a code**.

To test it yourself, use two different browsers — or one normal window and one
incognito. Two tabs in the *same* browser share `localStorage`, so the second tab
will try to reclaim the first tab's seat and the server will release the older window.

---

## Things to know about the free tier

- **It sleeps after ~15 minutes of no traffic.** The first request afterwards takes
  roughly 30 seconds to wake it, and **games in progress are lost** — state lives in
  memory, not a database. Fine for a game you play in one sitting; if you want games
  to survive restarts, that needs a datastore, which is a separate piece of work.
- **WebSockets work on free.** Socket.IO connects directly; no extra configuration.
- **A push to `main` redeploys**, which also drops any in-progress game.
- **The build runs `npm test`.** If the referee is broken, the deploy fails instead of
  shipping. That is deliberate — see `test/engine.test.js`.

## Checking it actually works

Once deployed:

```
https://YOUR-APP.onrender.com/healthz     → ok
```

Then, in one of the two browsers, open the console mid-game and try to cheat:

```js
G.players[G.turn].fp = 99      // then try to cast something expensive
G.board[45] = G.board[97]      // then try to move the piece you just invented
```

Both should be refused with a message in the toast, and the board should snap back
to the truth on the next update from the server. That is the whole point of the
split: `G` in your tab is a rendering, not the game.

## Running it locally instead

Needs Node 18+ (<https://nodejs.org>, LTS installer):

```bash
npm install && npm start
```

Then <http://localhost:3000>.

The offline modes need no server at all — opening `public/index.html` straight from
the file system still plays hot-seat and vs-the-machine, and
`public/index.html?test=1` runs the 131-assertion rules suite in the browser.
