"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   ARCANE WARFARE — the entry point. Loaded last, after everything it calls.
   ══════════════════════════════════════════════════════════════════════════ */

buildBoard();
wire();
if (new URLSearchParams(location.search).has("test")) {
  // The suite drives hundreds of positions through the referee in one
  // synchronous pass. Every one of them writes to G.fx, and animating that
  // would be both meaningless and slow.
  FX.mode = "off";
  runTests();
} else {
  G = newGame(0);
  UI = freshUI();
  render();
  netBootstrap();     // ?room= link, or a game this browser was in — else the menu
}
