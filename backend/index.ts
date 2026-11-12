// BlackJack — backend entry. Runs as a Bun subprocess spawned by the runtime.
//
// Shape required by the runtime: createPlugin() once, every handler registered
// SYNCHRONOUSLY at module top level so a request arriving mid-startup has
// somewhere to land, and only then the async setup that needs IPC round-trips.
//
// The handler bodies and the table game loop live in ./handlers.ts, which takes
// a structural plugin interface instead of importing the SDK — that is what
// lets tests/e2e.test.ts play whole rounds with no runtime.

import { createPlugin } from "@uncorded/plugin-sdk";
import { registerHandlers } from "./handlers.ts";

const plugin = createPlugin();

// 1. Synchronous: every action the frontend can call, plus sidebar.items.
//    (Boot work — refunding interrupted stakes, loading tables — starts here
//    too, and every handler awaits it before touching state.)
const blackjack = registerHandlers(plugin);

// 2. Async setup. Settings start at the manifest defaults, so anything that
//    runs before this resolves still behaves correctly.
await blackjack.refreshSettings().catch((error: unknown) => {
  console.error("[blackjack] failed to load settings:", error);
});
plugin.settings.onChange(() => {
  void blackjack.refreshSettings().catch((error: unknown) => {
    console.error("[blackjack] failed to reload settings:", error);
  });
});
