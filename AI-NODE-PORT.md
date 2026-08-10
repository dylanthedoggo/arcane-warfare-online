# Running the machine under Node

A staged plan for making `public/ai.js` usable outside a browser, so that
self-play, tuning and strength regression tests can run from the terminal and
from `npm test` instead of from a console tab someone has to remember to open.

This document is the plan, not the work. Each stage below is small enough to
finish and verify on its own, and the order matters: every stage leaves the
browser game working exactly as it does today, and no stage depends on a later
one being finished.

---

## Done — and three things this document had wrong

All eight stages are built. `npm run selfplay`, `npm run agreement` and
`npm run test:ai` are the three ways in; `tools/bootstrap.js` is the bridge.
`npm test` and `public/index.html?test=1` are unchanged at 127 and 349 checks.

Stage 7 earned the whole exercise on its first outing: pointed at the machine
for the first time, self-play found that two Ruthless opponents would play out
140 turns and finish **24 pieces to 24, having never captured anything**. That
had been true in the shipping browser game the entire time. Nothing else in the
repository could have noticed it, because nothing else ever played a long game
and looked at the result.

Three of this document's claims did not survive contact, and each is corrected
in the stage it belongs to. They are collected here because the pattern matters
more than any one of them:

1. **Seeding the dice was not enough to make a run reproducible.** The search
   also stops on a wall clock, and that is not seeded either. See Stage 0.
2. **`AI.fast` had been flattening the difficulty ladder** — it clamps every
   budget to 40 ms, which makes Ruthless's 3000 and Novice's 250 the same
   number. Every self-play figure ever taken through the harness was taken with
   most of what separates the levels removed. See Stage 4.
3. **The proposed strength gate could not detect a gutted machine.** Ruthless
   cut to depth 2, and Ruthless made to blunder harder than Novice, both beat
   Novice comfortably enough to pass it. See Stage 6.

The common thread is the one Stage 0's risk note already named: *the layer above
the carefully-verified layer had not been checked, and nothing made the gap
visible.* It was right, and it was right three times rather than once. The
useful habit is not "seed the randomness" but **build the regression you are
afraid of and watch the check catch it** — every finding above came from doing
that, and none of them from reading the code.

---

Line numbers below are as of commit `e1b9635`. They drift; where one matters,
it is given as a link to a named function rather than trusted on its own.

---

## What "can't run under Node" actually means

Three separate problems, stacked. Only the second is hard.

**1. `ai.js` never offers itself to Node.** `public/engine.js` ends with a
`module.exports = { ... }` block. That block is what makes
`require("./public/engine.js")` hand something back — without it, Node loads the
file, defines everything privately, and returns an empty object. `ai.js` has no
such block, so `require("./public/ai.js")` today returns nothing at all.

**2. `G` would be frozen.** In the browser, every `<script>` tag on the page
shares one namespace, so when `ai.js` writes `G.board[i]`, it is reading the
*same live variable* that `engine.js` declared. Node does not work that way:
each file is sealed, and `require` hands back a **copy** of the values as they
were at the moment of import. `ai.js` mentions `G` 167 times. Under a naive port
every one of those would read a game state frozen at import time, while the
search mutates the real one somewhere invisible. It would not crash. It would
quietly play nonsense, which is worse than crashing — and this is the reason the
port has to be done deliberately rather than by adding an export line.

Note also that `G` is not only read. `aiPlayGame` *assigns* to it —
`G = newGame(0, seed, { mode: "ai" })` — which is what makes Stage 2 harder
than it first looks. See that stage.

**3. Part of the file *is* the web page.** `aiTakeTurn`, `aiStep` and
`afterHandoff` call `render()`, `UI`, `NET`, `FX` and `announceWinner()`, and
pace themselves with `setTimeout` so a human can watch pieces move. That part is
not "unported" — it is inherently the page, and it should stay there.

It is a smaller part than it looks. Below it, and *above* it, sits code that
reads like driver work and is not: see the seam, next.

---

## The seam

The browser-only part of `ai.js` is much smaller than it looks from a glance at
the file, and getting this wrong in either direction is expensive — so it is
worth stating precisely.

| Part | Roughly | What it is | Node? |
| --- | --- | --- | --- |
| **The brain** | `ai.js:130`–`aiResolveDiscard` (~1540) | Board hashing, make/unmake, evaluation, alpha-beta, quiescence, the spell and transformation policy layer | Yes — pure computation, wants no screen |
| **The turn logic** | `aiConsiderChronos` (~1549)–`aiAbandonPlan` (~1745) | Deciding a whole turn: Chronos, drawing, casting, finishing a move, paying Tactician debt | Yes — this is judgement, not animation |
| **`aiRunTurn`** | ~1748–1777 | The whole turn, synchronously | Yes — this *is* the headless entry point |
| **The driver** | `aiTakeTurn`/`aiStep`/`afterHandoff` (~1788–1917) | The `setTimeout` animation state machine | No — stays browser-only |
| **The harness** | `aiRandomTurn` (~1923)–end | `aiRandomTurn`, `aiPlayGame`, `aiTournament` | Yes — already headless in spirit, but currently reachable only from the browser console |

The browser-only band is therefore about 130 lines, not the ~370 an earlier
draft of this document claimed. The middle three rows all sit between
`aiRender` and `aiTakeTurn` and all of them are needed headlessly —
`aiRunTurn`'s own comment says so ("The whole turn, synchronously. Used by
headless self-play"), and `aiPlayGame` calls it directly.

The goal is: everything except the driver runs in both places, and neither copy
of the game changes behaviour as a result.

**On the line numbers.** They are approximate on purpose. This document's
earlier draft pinned the seam at `1538`/`1905` and both had drifted by a dozen
lines within one commit. If the seam needs to be machine-checkable, put a
grep-able banner comment in `ai.js` at the two boundaries and have the
bootstrap assert on it — a number in a Markdown file will not hold.

---

## Stage 0 — seed the machine's own randomness

**Do this first.** Stages 4, 5 and 6 each claim that a run can be reproduced
from a seed. Today that is not true, and every one of those stages is
unbuildable until it is.

**The problem.** The engine is properly seeded — card draws, quantum rolls and
pressure timeouts all derive from `G.seed` through `mulberry32`
(`engine.js:2990`, `2933`, `3147`), which is why `snapshot`/`restore` works at
all. The machine is not. Two live `Math.random()` calls decide moves:

| Site | What it does | Who it affects |
| --- | --- | --- |
| `ai.js:1038` | Root-move jitter — the whole of "blunders on purpose" | Novice (`noise: 38`) and Skilled (`noise: 12`) |
| `ai.js:1926` | `aiRandomTurn` choosing its move | every game against the `"random"` opponent |

`mulberry32` does appear in `ai.js`, which is what makes this easy to miss —
but only at `ai.js:189` and `ai.js:194`, building the Zobrist hash tables from
two hardcoded constants. It never touches move choice.

Ruthless escapes, but only by accident: `noise: 0` multiplies the random sample
to zero. So "it reproduced for me" is a claim that can be true at one difficulty
and false at the next, which is the worst way for this to be discovered.

**The work.** Thread a seeded generator through both sites, deriving it the way
the engine already does — off `G.seed` and `G.turnNo`, with its own multiplier
and sequence counter so it cannot fall into step with the draw stream. Follow
the shape of `drawSpell`.

**Why it is safe.** It changes which move a noisy level picks, so self-play
numbers recorded before this stage are not comparable with numbers after it.
Nothing else moves: Ruthless is unaffected, and the referee, the evaluation and
the search are all untouched. Record the changeover wherever old numbers are
kept.

**How you know it worked.** `aiPlayGame("skilled", "novice", 60, 7)` twice in
one browser console returns identical results. Today it does not.

> **What happened.** It still did not, after both `Math.random()` calls were
> seeded. There is a second, independent source of non-determinism and this
> document missed it: **the search stops on a wall clock.** `AI_DEADLINE` is
> `performance.now() + budget`, so the depth an iteration reaches is a fact
> about how fast the machine felt at that moment. Measured on the opening
> position at Skilled, five searches in a row: depths **2, 3, 4, 4, 4** — the
> first two paying for the JIT warm-up the last three then spent. No seed
> touches that.
>
> So `AI.deterministic` was added, which changes the budget's *currency* from
> milliseconds to nodes — same shape of budget, counted in something the machine
> cannot vary. It is off by default and nothing in the browser game turns it on;
> `aiPlayGame` sets it, on the grounds that a measuring instrument which reads
> differently each time it is picked up is not one. With both fixes the test
> above passes, transcript included, line for line.

---

## Stage 1 — widen the engine's export footer

**The problem.** `engine.js` exports a long list of names, but `ai.js` needs
twenty more that are declared in `engine.js` and *not* exported:

```
DIAG  ORTHO  mkPiece  mulberry32  canAct  canCapture  isAlly  isEnemy
promoRow  homeRow  performMove  castSpell  drawSpell  discardCards  applyTransform
moveDirs  isImmobile  adjacentTo  pieceLabel  promoteIfDue
```

`performMove` alone is used 17 times in `ai.js`. In the browser these are
visible for free because of the shared-namespace rule above; under Node they
simply do not exist.

The second row is the one an eye-count misses. Three of those five —
`moveDirs` (`ai.js:577`), `isImmobile` (`ai.js:645`) and `adjacentTo`
(`ai.js:1240`, `1286`) — are inside the evaluation function, the hottest path in
the search, so leaving them out fails immediately and loudly with a
`ReferenceError`. That is the good kind of bug, and it is the reason this stage
is worth finishing properly rather than iterating on: the first run tells you.

`pieceLabel` (`engine.js:675`) deserves a note, because it is easy to file
wrongly. It reads like a presentation function and an earlier draft of this
document listed it under Stage 3's page stand-ins. It is engine code, `index.html`
has no copy of it, and writing a "minimal text version" for Node would fork a
piece of the engine into a second implementation that drifts. Export the real one.

**The work.** Add those names to the `module.exports` block at the bottom of
`engine.js`, grouped and commented in the same style as the existing entries.

**Why it is safe.** Exporting a name changes nothing about how the browser
loads the file — the footer is inside an `if (typeof module !== "undefined")`
guard that the browser never enters. Nothing that already worked can break.

**How you know it worked.** `npm test` still passes, and a throwaway Node
snippet can `require` the engine and call `performMove` without a
`TypeError: performMove is not a function`.

---

## Stage 2 — the `G` bridge

This is the stage that carries the risk. Do it on its own, and do not start
Stage 3 until it is demonstrably correct.

**The problem.** `ai.js` needs `G` to be a *live* view of the engine's current
game, not a snapshot. `engine.js` already anticipated this and exports
`setG(g)` and `getG()` — the server uses them to swap game state per room before
each `applyAction`. So the engine's real `G` is always reachable; it just is not
reachable *by the bare name `G`*.

**The work.** A small Node bootstrap file — call it `tools/bootstrap.js` —
that:

1. `require`s the engine once,
2. defines `G` on `globalThis` as an **accessor property** — a property backed
   by a pair of functions rather than a stored value, so that reading it runs
   `engine.getG()` and *writing* it runs `engine.setG(v)`,
3. copies the rest of the engine's exports onto `globalThis` as plain values,
4. then loads `ai.js` into that same global scope.

The accessor is the entire trick: because it re-asks the engine on every single
read, `G.board[i]` inside `ai.js` sees whatever the engine is holding *right
now*, which is exactly the browser's behaviour.

**The setter is not optional, and omitting it fails silently.** `aiPlayGame`
starts each game with `G = newGame(0, seed, { mode: "ai" })` — an assignment,
not a property write. A getter-only accessor does not reject that. Under Option A
below, `ai.js` is evaluated in sloppy mode exactly as a `<script>` tag is, and
sloppy mode *discards a write to a getter-only property without throwing*:

```
getter-only, sloppy mode  ->  no throw, the assignment is silently lost
getter + setter           ->  the engine receives the new game
```

The consequence is precisely the failure this whole stage exists to prevent:
self-play would run against whatever game happened to be loaded, never the
fresh seeded one, producing plausible numbers about the wrong board. It is worth
noticing that the read-only version of this accessor — the obvious first thing to
write — reintroduces the frozen-`G` bug inside the mechanism designed to kill it.

**Loading `ai.js` into that scope.** Two options, and this is a real decision:

- **A — `vm.runInThisContext`.** The bootstrap reads `public/ai.js` as text and
  evaluates it against the global scope, mimicking a `<script>` tag. No edits to
  `ai.js` at all; the browser file stays literally untouched. Slightly exotic,
  and stack traces need a filename hint to stay readable.
- **B — an export footer on `ai.js`** (same shape as the engine's) plus
  `require`. More conventional, but every name `ai.js` needs from the engine
  must be pulled in explicitly at the top of the file, which means edits inside
  `ai.js` and a second way of resolving names that a reader has to hold in their
  head alongside the browser way.

**Recommendation: A.** The file's own header makes a point of the two loading
paths being kept honest; option A keeps `ai.js` a single-audience file and puts
all the Node-specific strangeness in one bootstrap that exists to be strange.

**How you know it worked.** Write the smallest possible proof and keep it. It
needs **two** assertions, because the read half and the write half break
independently:

1. *The getter is live.* Start a game, read `G.turn`, call `endTurn()` through
   the engine, read `G.turn` again, assert it changed.
2. *The setter reaches the engine.* Assign a whole new game with a known seed —
   `G = newGame(0, 4242, { mode: "ai" })` — then assert `engine.getG().seed`
   is `4242`.

Only the second catches the silent-discard failure above, and it is the one an
earlier draft of this document left out. If either fails, stop.

---

## Stage 3 — a headless turn-ender

**The problem.** The harness at the bottom of `ai.js` ends turns by calling
`endTurnLocal()`, which lives in `index.html` (9 references in `ai.js`).

**The good news.** `endTurnLocal` (`index.html:1396`) is three lines:

```js
function endTurnLocal() { const r = endTurn(); render(); afterHandoff(r.sameSeat); }
```

`endTurn` is already exported by the engine. `render` and `afterHandoff` are
purely about drawing and about hiding hands between two humans sharing a screen
— neither means anything with no screen. So the headless equivalent is just
`endTurn()`.

**The work.** In the bootstrap, before loading `ai.js`, define stand-ins on the
global scope for everything the file expects from the page:

| Name | Uses in `ai.js` | Headless stand-in |
| --- | --- | --- |
| `endTurnLocal` | 9 | `() => engine.endTurn()` |
| `render` | 15 | no-op |
| `UI` | 8 | a plain object with the few fields touched (`targeting`, `revealed`) |
| `FX` | 4 | `{ busyMs: () => 0, then: (f) => f() }` — fire immediately, animate nothing |
| `announceWinner` | 4 | no-op, or a line to the console |
| `sq` | 5 | the engine already exports it |
| `NET` | 2 | `{ on: false }` |
| `clearSelection` | 2 | no-op |
| `toast` | 1 | no-op |
| `freshUI` | 1 | returns the same plain object as `UI` |

`pieceLabel` is *not* on this list — it lives in the engine and Stage 1 exports
it. `sq` is listed only because it is easy to mistake for a page function; it
needs no work.

**Why this is not a hack.** Every one of these is a *presentation* concern.
None of them can change what is legal or what the search decides. If a stand-in
ever needed real logic to make self-play behave, that would be a signal that
game rules had leaked into the page — worth knowing. The `pieceLabel` case is
that test being applied and passing: it looked like a page concern, it turned
out to be engine code, and the answer was to export it rather than to fake it.

**How you know it worked.** `aiPlayGame("skilled", "novice", 60)` completes in
Node and returns a result object with a winner and piece counts.

---

## Stage 4 — a self-play command

**The work.** `tools/selfplay.js`, which uses the bootstrap and exposes
`aiTournament` from the command line, plus an npm script:

```
npm run selfplay -- ruthless skilled 100
```

Print per-game lines as it goes (the existing `aiTournament` already does) and
a summary at the end. Keep `AI.fast = true` so no pacing delays apply.

**Also worth doing here:** make the seed explicit and printed. `aiPlayGame`
already takes a seed and `aiTournament` derives one per game (`1000 + i`), so a
surprising result can be replayed exactly — **provided Stage 0 is done**. Without
it the seed reaches the engine and the machine ignores it, so a printed seed
would be a promise the output does not keep. That property is worth protecting
loudly, because it is what makes everything after this stage meaningful.

**How you know it worked.** Two runs of the same command with the same seeds
produce byte-identical output. If they do not, suspect Stage 0 before suspecting
the bridge.

> **What happened.** Byte-identical, once Stage 0 was finished properly — and
> stdout carries only reproducible things, with elapsed time pushed to stderr so
> that it stays on screen and out of a diff.
>
> Building this turned up the second correction. **`AI.fast` clamps every budget
> to 40 ms**, which is right for the browser and quietly disastrous for
> measurement: it makes Ruthless's `timeMs: 3000` and Novice's `250` into the
> same number. Twelve times the thinking is most of what separates those two
> rungs, so every self-play figure the harness had ever produced was taken with
> the greater part of the ladder removed. It also means `timeMs` was not
> tunable through the harness at all, which would have made **Stage 7
> impossible** without anyone noticing why.
>
> Measured both ways — Ruthless against Novice, same seeds: **3-1-1** through the
> clamp, **22-2** when each level is allowed its own proportions. `AI.budgetScale`
> is the fix: a multiplier applied after the clamp, so a run can buy
> games-per-minute at a cost every level pays in proportion. `--scale` on the
> command line; omitting it keeps the old shoestring, and prints a line saying
> the two budgets have been made equal.

---

## Stage 5 — prove Node and the browser agree

**The problem this prevents.** A subtly wrong bridge produces a machine that
runs fine and plays *differently* from the one in the browser. Every number you
then tune would be tuned against a phantom.

**The work.** Pick a fixed seed. In the browser console, run a short scripted
game and record the sequence of moves. Run the identical thing in Node. The
sequences must match exactly. Save the recorded browser sequence in the repo as
the expected output.

**Why exact.** After Stage 0, the search is deterministic given a seed. Before
Stage 0 it is not, at any level with `noise` above zero, and this check cannot be
run at all — which is the reason Stage 0 exists and the reason it comes first.

Two legitimate sources of divergence remain once the seeding is right:

- **Wall-clock time budgets** (`timeMs`, `policyMs`, `policyBudget`) cutting off
  iterative deepening at different depths on different machines. Run this check
  at a level and depth low enough that the budget never binds, or temporarily
  raise the budgets so the depth ceiling is what stops the search.
- **`AI.fast`**, which clamps every search budget to 40 ms (`aiBudget`). Headless
  self-play sets it; a browser console session must set it too, or the two runs
  are not searching to the same depth and the comparison is meaningless.

If the sequences still differ after controlling for both, the bridge is wrong;
do not proceed.

> **What happened.** `tools/agreement.js`, and it passes: **237 lines, 8,813
> characters, identical.** Four games — Skilled/Novice, Ruthless/Skilled,
> Skilled/random and Novice/Novice — recorded as result, final board, focus and
> hands, and every line of the game log.
>
> Both divergence sources named above are closed rather than worked around: the
> node budget removes the wall clock, and the recipe pins `fast` and `scale`
> explicitly instead of inheriting `aiPlayGame`'s defaults, so a change to what
> a headless game assumes shows up here as a mismatch rather than moving both
> sides at once.
>
> The recipe lives in the tool as **one string**, run in both places, because two
> copies of a procedure is precisely the failure this check exists to detect.
> Getting nine thousand characters out of a browser console by hand is the step
> at which a check like this stops being re-recorded, so `--digest` prints three
> short numbers to compare by eye instead.

---

## Stage 6 — a strength gate in `npm test`

**What is missing today.** `test/engine.test.js` proves the referee refuses
cheating. It says nothing about whether the machine still plays *well*. A change
that weakened the AI would ship unnoticed.

**The work.** A separate file — `test/ai.test.js`, not folded into the
cheat-rejection suite, which has a different job and should stay fast — that
asserts something coarse and stable, such as: Ruthless beats Novice in at least
85 of 100 seeded games. Coarse on purpose: a tight threshold would fail on
harmless changes and get switched off within a month.

Note that Novice is the noisiest level in the game (`noise: 38`), so this gate is
the one most exposed to Stage 0. Without it the "seeded games" in that sentence
are not seeded, the pass rate wanders between runs, and a gate that fails at
random is a gate somebody deletes.

**Cost control.** This is minutes, not milliseconds. Keep `npm test` as it is
and add `npm run test:ai` separately, run deliberately before releases rather
than on every save.

> **What happened — and this is the correction that matters most.** The gate
> above does not work. Not "is imprecise": does not work.
>
> Ruthless does beat Novice, 6-1-1 over eight seeds. But two deliberate
> regressions were built and run against that gate, and both sailed through:
>
> | Regression | Result against Novice | Gate |
> | --- | --- | --- |
> | Ruthless cut from depth 10 to depth **2** | 7-1, +31 pieces | **passes** |
> | Ruthless given **noise 60** — blundering harder than Novice does | 6-1, +40 pieces | **passes** |
>
> Both are the machine gutted. One posts a *better* record than the real thing.
> The reason is not subtle once seen: Novice is so much weaker that Ruthless
> beats it comfortably in any condition, so the measurement is saturated and has
> no resolution left for the question actually being asked. A tighter threshold
> would not have helped — 85 of 100 was never the problem.
>
> **The fix is to make the opponent track the thing under test.** The gate now
> plays Ruthless against a copy of *itself* with exactly one thing taken away:
> same engine in every respect that is not being measured, so the whole of the
> difference lands on the knob that moved.
>
> | Matchup | Result |
> | --- | --- |
> | depth 10 vs depth 2, all else equal | 5-0, 3 tied, +19 pieces |
> | noise 0 vs noise 60, all else equal | 5-1, 2 tied, +18 pieces |
>
> Those separate, and the same two regressions run against the new gate are both
> caught. The **material margin** does the catching — 0 and 1 against a floor of
> 8 — because a hobbled twin of a hobbled Ruthless is the same engine, and the
> same engine playing itself finishes level on material. The win count is blunt
> enough that the depth regression survived it on a lucky split, so all three
> assertions stay.
>
> Ruthless against Novice is kept at four games for the one thing it can
> honestly say: that the ladder faces the right way up. It is labelled as such.
>
> Two smaller notes. Reproducibility is checked at **Novice**, because that is
> where it used to fail — `noise: 0` meant Ruthless, the level anyone would test
> first, reproduced perfectly all along. And the turn limit turned out to be the
> signal rather than a cost knob: at 60 turns the two sides are still a piece
> apart and the sample says almost nothing; 140 is where it separates. 25 checks,
> about 7 minutes.

---

## Stage 7 — tune `AI_LEVELS` with the thing you just built

Not required, but it is the payoff. `AI_LEVELS` at the top of `ai.js` is about
twenty hand-picked numbers per difficulty — search depth, time budgets, and the
margins by which a spell or transformation must beat doing nothing before the
machine commits to it. Right now, justifying a change to any of them means
running tournaments by hand in a browser tab.

With Stages 1–5 done, one command and a few hundred games answers the question.
Change one knob at a time, keep the seeds fixed, and record what you learn in
the comment block above `AI_LEVELS` — that comment already explains why
Skilled's policy figures are pinned where they are, and it is the right home for
whatever comes out of this.

> **What happened.** Done — and the first thing the new machinery was pointed at
> turned out to be a bug in how the machine plays the actual game, not a knob.
>
> **The knobs first.** `depth` and `timeMs` are not independent, and `depth` is
> much the weaker. It is only a ceiling on iterative deepening; the budget is
> what stops the search first, so the ceiling means nothing unless the budget
> reaches it. Ruthless on the opening position, ceiling of 10:
>
> | budget | nodes | depth reached |
> | --- | --- | --- |
> | `AI.fast` — what the page's own suite uses | 4,800 | 4 |
> | `--scale 0.02` | 7,200 | 5 |
> | `--scale 0.05` | 18,000 | 6 |
> | `--scale 0.2` | 72,000 | 8 |
> | its own 3000 ms — **what a player faces** | 360,000 | 10 |
>
> So Ruthless plays at its stated depth against a person and nowhere else.
> Raising `depth` alone would change nothing; `timeMs` has to rise with it.
> Recorded in the comment block above `AI_LEVELS`, as this stage asks.
>
> **Then the thing that mattered.** Two Ruthless machines played 140 turns and
> finished **24 pieces to 24, having never once captured anything** — 120 draws
> against 20 moves between them. Diagnosed by scoring every legal move in the
> dead position: the best of 22 was **-96**, and standing pat beat all of them.
>
> That is **zugzwang**, and the search is right about it. Pawns advance and do
> not retreat, so two armies across one empty rank are stuck: whoever steps in
> first is jumped. What is wrong is that the machine could decline forever —
> **drawing a card is the only turn in the game that does not move a piece**, so
> it is a pass, and both sides passed at each other indefinitely.
>
> Two halves to the fix, in `public/ai.js`:
>
> - `resourceValue` clamped the card term. Focus was already clamped at the
>   ceiling — "Focus past the ceiling does not exist" — but cards fell to +4 and
>   then stayed there, so the twentieth card was worth as much as the fifth and
>   drawing stayed forever, if barely, positive.
> - `aiShouldDraw` now refuses outright once the hand holds five. Pricing cannot
>   fix this on its own, because passing genuinely *is* worth the tempo and the
>   search is answering correctly; what was wrong is that it could keep asking.
>   Drawing a sixth card while five sit unplayed is a wasted turn against a human
>   too — the rule only makes the machine admit it.
>
> The same two games, replayed: **24v24 with 0 captures becomes 9v13 with 29
> jumps**, and 11v13 with 24 jumps. `npm test` and `index.html?test=1` are
> unchanged at 127 and 349, and the browser/Node agreement fixture did not move
> at all — those games run short and on the shoestring, where no hand ever
> reaches five.

---

## Risks, honestly

- **The frozen-`G` failure is silent.** This is the one to respect. It does not
  throw; it plays badly. Stage 2's two assertions and Stage 5's agreement check
  exist solely to make it loud, and none of them is optional. Note that the
  read-only accessor — the natural first attempt — is itself a silent variant of
  this bug, so "I wrote the accessor" is not the same as "the bridge is correct."
- **Reproducibility was assumed rather than checked.** Three stages of this plan
  were written on the belief that the machine was seeded, and it is not. The
  general lesson is worth keeping: the engine being carefully deterministic
  (`snapshot`/`restore` demanded it) said nothing about the layer above it, and
  nothing in the codebase made the gap visible. Stage 0 closes this one; assume
  there are others.

  **There were others — two more, both found the same way.** The wall clock was
  a second unseeded source sitting directly beside the first, and `AI.fast` had
  been flattening the ladder every measurement was taken against. Neither was
  visible by reading; both showed up the moment something was *measured twice
  and the answers compared*. The sharpened version of this note: a layer that
  has never been asked to repeat itself has never been checked, however careful
  the layer underneath it is.

- **A check nobody has watched fail is not a check.** This is the habit the
  whole exercise argues for, and it earned its place three times: the seam guard
  is handed six kinds of doctored file and must object to each; the bridge's two
  assertions are run on every require; and the strength gate was only trusted
  after two deliberately-gutted machines were built and it was seen refusing
  them. The Stage 6 gate as originally proposed would have shipped, looked
  reassuring, and caught nothing — the only thing that exposed it was building
  the regression on purpose.
- **Two loading paths mean two ways to break.** Every stage above leaves the
  browser path untouched, and `public/index.html?test=1` plus `npm test` should
  be run after each one. If a change to `ai.js` itself ever becomes necessary,
  that is the moment to re-read its header comment and update it.
- **Timing-dependent results.** Anything measured with a wall-clock budget is
  measured on the machine that ran it. Comparisons are only fair within a single
  run on a single machine — say so wherever numbers get recorded.
- **The stand-ins can drift.** If someone later adds a `render()` call inside
  the brain half of `ai.js`, Node keeps working (it is a no-op) and nothing
  complains. A grep-able banner comment at each seam boundary, asserted on by
  the bootstrap, is the cheap defence — a line number written down in this file
  is not, having already drifted once before any of the work started.

---

## Sequence at a glance

0. Seed the machine's two `Math.random()` calls — **and the wall clock, which is
   a third source this plan missed.** Prerequisite for 4, 5 and 6. ✅
1. Widen `engine.js` exports — 20 names. Safe, mechanical. ✅
2. `tools/bootstrap.js`: live-`G` accessor, **get and set** + load `ai.js`. **The hard part.** ✅
3. Page stand-ins so the harness runs headless. ✅
4. `tools/selfplay.js` + `npm run selfplay` — **plus `--scale`, without which the
   harness cannot tell the levels apart.** ✅
5. Browser/Node agreement check on a fixed seed. **Gate: do not skip.** ✅
6. `test/ai.test.js` strength gate — **against a hobbled copy of the machine, not
   against Novice.** Run separately from `npm test`. ✅
7. Tune `AI_LEVELS` against real numbers — **which immediately found a game the
   machine would not play at all.** ✅

Stage 0 is what makes any of the measurements mean anything. Stages 1–4 are the
port. Stage 5 is what makes it trustworthy. Stages 6–7 are what makes it worth
having done.

Stage 0 is the only one that changes behaviour in the browser game, and it is
worth being deliberate about the order for that reason: do it, confirm
`public/index.html?test=1` and `npm test` still pass, and commit it on its own
before any of the Node work begins.
