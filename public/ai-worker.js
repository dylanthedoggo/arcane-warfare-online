/* ══════════════════════════════════════════════════════════════════════════
   ARCANE WARFARE — the machine's thinking thread

   Loaded by ai.js (aiWorker) with `new Worker("ai-worker.js")`. It loads the
   same two files the page does, so the rules and the machine in here are the
   rules and the machine out there — there is no second copy of either.

   One message in, one message out:

     in    { id, job, arg, G, ai, fresh }
     out   { id, G, out }      the game after the job, and the job's result
           { id, error }       the job threw

   The page names ai.js mentions (render, FX, UI and the rest) do not exist
   here, on purpose. No job reaches one — tools/bootstrap.js checks that — and
   if one ever does, the ReferenceError comes back as `error` instead of the
   job quietly doing something different from the page.
   ══════════════════════════════════════════════════════════════════════════ */

importScripts("engine.js", "ai.js");

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    G = m.G;
    Object.assign(AI, m.ai);
    // A new turn: nothing the last one learned about move order may be kept.
    if (m.fresh) clearOrderingMemory();
    const out = AI_JOBS[m.job](m.arg);
    self.postMessage({ id: m.id, G, out });
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.message) || err) });
  }
};
