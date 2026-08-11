# Running the machine under Node

**Status: done.** `public/ai.js` runs under Node via the bridge at the top of
that file, and `npm run tournament` is the front door. This document started
life as a plan; it is kept as the record of what was built, and — more usefully
— of the two things the plan asserted confidently and got wrong.

Measurements below were taken on 2026-08-10, on a four-core machine. Anything
timing-related is specific to that machine and should be re-measured elsewhere
rather than quoted.

---

## What the port had to solve

**The live binding.** In the browser, every `<script>` shares one namespace, so
`G.board[i]` inside `ai.js` reads the *same variable* `engine.js` declared. Node
seals each file and `require` hands back a **copy** of the values at import time
— which for `G` is `null`. `ai.js` mentions `G` 164 times.

Solved by the bridge at [ai.js:73](public/ai.js:73): it defines `G` on
`globalThis` as an *accessor* over the engine's own `setG`/`getG`, so every read
re-asks the engine and every write reaches it. Verified three ways —
`globalThis.G === engine.getG()`, a turn advanced through `endTurnLocal()`, and
a write made on the engine's side showing up under the bare name `G`.

**The page.** The driver reaches for nine names that live in `index.html`. All
nine are presentation-only, and the bridge supplies inert stand-ins. The one
with real behaviour is `endTurnLocal`, which headlessly is just `endTurn()` —
there is no curtain to raise and no handover to animate.

**The engine's exports.** Fifteen names `ai.js` needs were declared in
`engine.js` but not exported (`performMove`, `castSpell`, `mulberry32`,
`promoRow` and the rest). Widening the footer is invisible to the browser,
which never enters that `if` block.

---

## Correction 1 — "a few hundred games, one command"

**Wrong, by about 90x.** The original plan, and the conversation around it,
claimed that Node self-play meant typing one command, letting a few hundred
games run, and reading the win rate.

Measured: one `--full` Ruthless-vs-Skilled game that goes the 200-turn
distance costs **269 seconds**. A hundred of those is seven and a half hours
single-threaded. "A few hundred games" was never a coffee break.

The claim was only ever true at the *default* budgets, and that turns out to be
worse than being slow — see below.

**What was done about it.** `--jobs` in `tools/tournament.js` plays several
games at once in worker threads, since the games are independent. The default
is `cores - 1`.

Measured end to end, `--full`, three games at `--jobs 3` on four cores:

| | per game | vs serial |
| --- | --- | --- |
| `--jobs 1` | 268.9s | — |
| `--jobs 3` | 114.1s | **2.36x** (ideal would be 3.00x) |

Worth having, and worth understanding why it falls short of 3x, because the
two obvious explanations are both wrong and the real one is reassuring.

It is **not** that the searches got less thinking done. Three simultaneous
3000ms searches each got through 168k–182k positions; one running alone got
154k–169k. The machine plays as hard under load as it does alone, which is the
part that would have invalidated the measurement.

What actually happens is that a game's wall clock stretched from 269s to 342s
under three-way load — about 27% — while the searches inside it kept their full
budget. The extra time is the work *between* searches: move generation,
snapshot and restore, logging. None of that is time-bounded, so it simply runs
slower when three cores are busy. Throughput still improves by 2.4x; each
individual game just takes longer to come back.

Two caveats worth keeping:

- Past the core count the reassuring part stops holding: searches keep their
  wall-clock budget but get less CPU inside it, which quietly makes the machine
  weaker rather than just slower. Never compare runs made at different `--jobs`
  values above that line.
- At *shoestring* budgets the speedup is much smaller than the job count (1.3x
  over nine games), because each worker re-JITs the search from cold and the
  games are only seconds long. Parallelism is for `--full`.

---

## Correction 2 — "same seed, same game"

**Also wrong, and this one matters more.** Stage 4 of the plan said to print
the seeds so "a surprising result can be replayed exactly," and Stage 5 was
built entirely on comparing a browser and a Node run move-for-move.

No run of the tournament is reproducible, and this was true long before there
were workers. Two identical `--jobs 1` runs of the same command produce
different games.

The reason: every search stops on the **wall clock**
([ai.js:1029](public/ai.js:1029)), so how much thinking fits in the budget
depends on what else the machine is doing. The same position searched twice in
a row, alone, reached 154,112 nodes and then 169,472 — a ten percent swing, and
easily enough to change which move comes back. The seed fixes the deal and the
root-score jitter, and nothing else.

**So a tournament is a sample, not a recording.** Judge a change by the record
over enough games that the noise cancels; never by whether one game came out
the same. The plan's Stage 5 — "prove Node and the browser agree, exactly" —
cannot be run as written, and its failure would have said nothing about the
bridge.

**If reproducibility is ever wanted**, it means bounding the search by node
count instead of by time. That is a real change to how the machine plays, worth
doing deliberately or not at all, and it is the only thing that would make the
seeds mean what the plan thought they meant.

---

## The trap that is still live: `--full`

The tournament's default is what its header calls *shoestring* budgets, and
[ai.js:1259](public/ai.js:1259) is what that means:

```js
const aiBudget = (ms) => (AI.fast ? Math.min(ms, 40) : ms);
```

Every search is capped at 40ms regardless of level. Measured, one root search
from the opening position:

| | asks for | actually spends |
| --- | --- | --- |
| Ruthless, default | 3000ms | **43ms** |
| Ruthless, `--full` | 3000ms | **3005ms** |

A default `npm run tournament` is not measuring Ruthless. It is measuring
something roughly seventy times weaker that shares the name, and it comes back
fast and looks perfectly reasonable. This is the single easiest way to draw a
confident wrong conclusion about the machine, and it is worth checking the flag
before believing any number.

---

## What is still worth doing

**A strength gate in the test suite.** `test/engine.test.js` proves the referee
refuses cheating; nothing proves the machine still plays well, so a change that
weakened it would ship unnoticed. A separate `test/ai.test.js` — never folded
into the cheat-rejection suite, which must stay fast — could assert something
coarse and stable over enough `--full` games to survive the noise. Coarse on
purpose: a tight threshold fails on harmless changes and gets switched off
within a month.

Cost it honestly before writing it. At 269s a game, even parallel, this is a
run you start and walk away from, not something that belongs on every save.

**Tuning `AI_LEVELS`.** The knobs at the top of `ai.js` are hand-picked, and
the tournament is now the instrument for justifying changes to them. Change one
at a time, use enough games that the ten percent search noise cancels, and
record what comes out in the comment block above `AI_LEVELS`.

---

## Lesson, for the next time

Both corrections above have the same shape: a confident claim about
*performance* or *determinism*, made without running anything. The port itself
was fine. The numbers attached to it were invented, and one of them —
`--full` — is a live trap that produces plausible output rather than an error.

Measure first, then write the sentence.
