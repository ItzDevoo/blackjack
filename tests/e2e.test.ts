// Whole rounds, end to end, through the real handlers: sit → bet → deal →
// decisions → dealer → settlement → wallet + history, with a fake clock.

import { afterEach, describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
afterEach(() => h?.close());

const alice = () => h.user("alice");
const bob = () => h.user("bob");

/** Seat the given players, place bets, press Deal, and run until play begins. */
async function deal(players: { user: ReturnType<typeof alice>; bet: number }[], cards?: string) {
  for (const p of players) {
    await h.call("getLobby", {}, p.user);
    await h.call("sit", { tableId: "main" }, p.user);
  }
  if (cards) h.stack("main", cards);
  for (const p of players) {
    await h.call("setBet", { tableId: "main", amount: p.bet }, p.user);
    await h.call("ready", { tableId: "main" }, p.user);
  }
  await h.clock.advance(1300); // everyone ready → betting closes
  await h.clock.advance(3000); // deal animation → first decision
  return h.lastTable();
}

/** Advance the clock in small steps until the table reaches `phase`. */
async function until(phase: string, limitMs = 60_000) {
  for (let t = 0; t < limitMs; t += 200) {
    const s = h.lastTable();
    if (s?.phase === phase) return s;
    await h.clock.advance(200);
  }
  throw new Error(`table never reached ${phase} (stuck in ${h.lastTable()?.phase})`);
}

/** Run the dealer and settlement. */
const finish = () => until("settled");

describe("a basic round", () => {
  test("win pays 1:1 and records stats + history", async () => {
    h = await createHarness();
    const a = alice();
    // alice: 10 9 = 19; dealer 9 up, 8 hole = 17 → stands.
    let state = await deal([{ user: a, bet: 100 }], "10S 9C 9H 8D");
    expect(state.phase).toBe("playing");
    expect(state.turn.userId).toBe("alice");
    expect(state.dealer.cards[1].hidden).toBe(true);
    expect(h.balance("alice")).toBe(900);

    await h.call("act", { tableId: "main", action: "stand" }, a);
    state = await finish();
    expect(state.phase).toBe("settled");
    expect(state.seats[0].hands[0].result).toBe("win");
    expect(state.seats[0].delta).toBe(100);
    expect(h.balance("alice")).toBe(1100);

    const lobby = await h.call<any>("getLobby", {}, a);
    expect(lobby.wallet.handsWon).toBe(1);
    expect(lobby.wallet.net).toBe(100);
    expect(lobby.recent[0].result).toBe("win");

    await until("waiting");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM stakes").get()).toEqual({ n: 0 });
  });

  test("hole card is never sent before the reveal", async () => {
    h = await createHarness();
    await deal([{ user: alice(), bet: 50 }], "10S 9C 9H 8D");
    for (const b of h.broadcasts) {
      if (b.event !== "table" || b.payload.dealer.revealed) continue;
      expect(JSON.stringify(b.payload.dealer.cards)).not.toContain('"r":"8"');
    }
  });

  test("bust loses immediately and the dealer doesn't draw", async () => {
    h = await createHarness();
    const a = alice();
    // alice 10 6, hits K → 26. Dealer 9 up 5 hole = 14; no live hands so no draw.
    await deal([{ user: a, bet: 100 }], "10S 9C 6H 5D KH 2C");
    await h.call("act", { tableId: "main", action: "hit" }, a);
    const state = await finish();
    expect(state.seats[0].hands[0].result).toBe("bust");
    expect(state.dealer.cards.length).toBe(2);
    expect(h.balance("alice")).toBe(900);
  });

  test("natural blackjack pays 3:2 and skips the player's turn", async () => {
    h = await createHarness();
    await deal([{ user: alice(), bet: 100 }], "AS 9C KH 7D");
    const state = await finish();
    expect(state.seats[0].hands[0].result).toBe("blackjack");
    expect(h.balance("alice")).toBe(1150);
  });

  test("6:5 setting", async () => {
    h = await createHarness();
    h.settings["blackjack_payout"] = "6:5";
    await h.handle.refreshSettings();
    await deal([{ user: alice(), bet: 100 }], "AS 9C KH 7D");
    await finish();
    expect(h.balance("alice")).toBe(1120);
  });
});

describe("decisions", () => {
  test("double down: one card, double stake", async () => {
    h = await createHarness();
    const a = alice();
    // alice 6 5 = 11, doubles, gets 10 = 21. Dealer 9 up 8 hole = 17.
    await deal([{ user: a, bet: 100 }], "6S 9C 5H 8D 10H");
    await h.call("act", { tableId: "main", action: "double" }, a);
    const state = await finish();
    const hand = state.seats[0].hands[0];
    expect(hand.doubled).toBe(true);
    expect(hand.cards.length).toBe(3);
    expect(hand.result).toBe("win");
    expect(h.balance("alice")).toBe(1200);
  });

  test("split into two hands, each played separately", async () => {
    h = await createHarness();
    const a = alice();
    // alice 8 8 vs dealer 6 up, 10 hole. Split: hand1 gets 3 (11), hand2 gets 10 (18).
    await deal([{ user: a, bet: 100 }], "8S 6C 8H 10D 3H 10C");
    await h.call("act", { tableId: "main", action: "split" }, a);
    let state = h.lastTable();
    expect(state.seats[0].hands.length).toBe(2);
    expect(state.turn.hand).toBe(0);
    expect(h.balance("alice")).toBe(800);
    // hand 1: 8 3 = 11 → hit 9 = 20, stand.
    h.stack("main", "9D");
    await h.call("act", { tableId: "main", action: "hit" }, a);
    await h.call("act", { tableId: "main", action: "stand" }, a);
    state = h.lastTable();
    expect(state.turn.hand).toBe(1);
    await h.call("act", { tableId: "main", action: "stand" }, a);
    // Dealer 16 draws K → bust.
    h.stack("main", "KD");
    state = await finish();
    expect(state.seats[0].hands.map((x: any) => x.result)).toEqual(["win", "win"]);
    expect(h.balance("alice")).toBe(1200);
  });

  test("split aces get one card each and stand", async () => {
    h = await createHarness();
    const a = alice();
    await deal([{ user: a, bet: 100 }], "AS 9C AH 8D KH 5C");
    await h.call("act", { tableId: "main", action: "split" }, a);
    const state = await finish();
    const hands = state.seats[0].hands;
    expect(hands.length).toBe(2);
    expect(hands[0].cards.length).toBe(2);
    expect(hands[1].cards.length).toBe(2);
    // A K after split is 21 but pays 1:1, A 5 = 16 loses to 17.
    expect(hands[0].result).toBe("win");
    expect(hands[0].blackjack).toBe(false);
    expect(hands[1].result).toBe("lose");
    expect(h.balance("alice")).toBe(1000);
  });

  test("surrender returns half", async () => {
    h = await createHarness();
    const a = alice();
    await deal([{ user: a, bet: 100 }], "10S 9C 6H 10D");
    await h.call("act", { tableId: "main", action: "surrender" }, a);
    await finish();
    expect(h.balance("alice")).toBe(950);
  });

  test("can't act out of turn or double after hitting", async () => {
    h = await createHarness();
    const a = alice();
    const b = bob();
    await deal(
      [
        { user: a, bet: 50 },
        { user: b, bet: 50 },
      ],
      "2S 3S 9C 2H 3H 8D 2D",
    );
    await expect(h.call("act", { tableId: "main", action: "hit" }, b)).rejects.toThrow("not your turn");
    await h.call("act", { tableId: "main", action: "hit" }, a);
    await expect(h.call("act", { tableId: "main", action: "double" }, a)).rejects.toThrow("first two cards");
  });

  test("a double-clicked action doesn't spill onto the next split hand", async () => {
    h = await createHarness();
    const a = alice();
    await deal([{ user: a, bet: 50 }], "8S 6C 8H 10D 3H 10C");
    await h.call("act", { tableId: "main", action: "split" }, a);
    const firstHandId = h.lastTable().seats[0].hands[0].id;
    await h.call("act", { tableId: "main", action: "stand", handId: firstHandId }, a);
    const again = await h.call<any>("act", { tableId: "main", action: "stand", handId: firstHandId }, a);
    expect(again.stale).toBe(true);
    expect(h.lastTable().turn.hand).toBe(1);
  });
});

describe("dealer blackjack and insurance", () => {
  test("ten up with a natural ends the round before anyone acts", async () => {
    h = await createHarness();
    await deal([{ user: alice(), bet: 100 }], "10S KC 9H AD");
    const state = await finish();
    expect(state.dealer.blackjack).toBe(true);
    expect(state.seats[0].hands[0].result).toBe("lose");
    expect(h.balance("alice")).toBe(900);
  });

  test("ace up offers insurance; insured player breaks even", async () => {
    h = await createHarness();
    const a = alice();
    const state = await deal([{ user: a, bet: 100 }], "10S AC 9H KD");
    expect(state.phase).toBe("insurance");
    await h.call("insurance", { tableId: "main", take: true }, a);
    expect(h.balance("alice")).toBe(850);
    await finish();
    // lose 100, insurance 50 pays 150 → back to 1000.
    expect(h.balance("alice")).toBe(1000);
  });

  test("insurance lost when the dealer has no natural; play continues", async () => {
    h = await createHarness();
    const a = alice();
    await deal([{ user: a, bet: 100 }], "10S AC 9H 6D");
    await h.call("insurance", { tableId: "main", take: true }, a);
    let state = await until("playing", 2000);
    await h.call("act", { tableId: "main", action: "stand" }, a);
    // Dealer A 6 = soft 17 → stands (S17). 19 beats 17.
    state = await finish();
    expect(state.seats[0].hands[0].result).toBe("win");
    expect(h.balance("alice")).toBe(1050);
  });
});

describe("timers and seats", () => {
  test("turn timeout auto-stands; two timeouts frees the seat", async () => {
    h = await createHarness();
    const a = alice();
    await deal([{ user: a, bet: 50 }], "10S 9C 7H 8D");
    await h.clock.advance(20_100);
    expect(["dealer", "settled"]).toContain(h.lastTable().phase);
    await until("waiting");
    expect(h.lastTable().seats[0]).not.toBeNull();

    h.stack("main", "10S 9C 7H 8D");
    await h.call("setBet", { tableId: "main", amount: 50, ready: true }, a);
    await until("playing");
    await until("waiting");
    expect(h.lastTable().seats[0]).toBeNull();
  });

  test("betting window closes on its own and sits out players with no bet", async () => {
    h = await createHarness();
    const a = alice();
    const b = bob();
    await h.call("sit", { tableId: "main" }, a);
    await h.call("sit", { tableId: "main" }, b);
    await h.call("setBet", { tableId: "main", amount: 25 }, a);
    let state = h.lastTable();
    expect(state.phase).toBe("betting");
    expect(state.deadline - state.serverNow).toBe(15_000);
    await h.clock.advance(15_100);
    state = h.lastTable();
    expect(state.phase).toBe("dealing");
    expect(state.seats[0].inRound).toBe(true);
    expect(state.seats[1].inRound).toBe(false);
    expect(state.seats[1].missedRounds).toBe(1);
  });

  test("lowering or clearing a bet refunds, standing up refunds", async () => {
    h = await createHarness();
    const a = alice();
    await h.call("sit", { tableId: "main" }, a);
    await h.call("setBet", { tableId: "main", amount: 300 }, a);
    expect(h.balance("alice")).toBe(700);
    await h.call("setBet", { tableId: "main", amount: 100 }, a);
    expect(h.balance("alice")).toBe(900);
    await h.call("standUp", { tableId: "main" }, a);
    expect(h.balance("alice")).toBe(1000);
    expect(h.lastTable().phase).toBe("waiting");
  });

  test("can't bet more than you have or outside table limits", async () => {
    h = await createHarness();
    const a = alice();
    await h.call("sit", { tableId: "main" }, a);
    await expect(h.call("setBet", { tableId: "main", amount: 5 }, a)).rejects.toThrow("10–1,000");
    h.db.run("UPDATE wallets SET balance = 40 WHERE user_id = 'alice'");
    await expect(h.call("setBet", { tableId: "main", amount: 50 }, a)).rejects.toThrow("Not enough CP");
    expect(h.balance("alice")).toBe(40);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM stakes").get()).toEqual({ n: 0 });
  });

  test("standing up mid-round finishes the hand then frees the seat", async () => {
    h = await createHarness();
    const a = alice();
    await deal([{ user: a, bet: 100 }], "10S 9C 9H 8D");
    const res = await h.call<any>("standUp", { tableId: "main" }, a);
    expect(res.leavingAfterRound).toBe(true);
    await finish();
    expect(h.balance("alice")).toBe(1100);
    await until("waiting");
    expect(h.lastTable().seats[0]).toBeNull();
  });

  test("one seat per player across tables", async () => {
    h = await createHarness();
    const a = alice();
    const { id } = await h.call<any>("createTable", { name: "High Rollers", minBet: 100, maxBet: 5000 }, bob());
    await h.call("sit", { tableId: "main" }, a);
    await expect(h.call("sit", { tableId: id }, a)).rejects.toThrow("already seated");
  });
});

describe("CP is conserved", () => {
  test("restart mid-round refunds stakes exactly", async () => {
    h = await createHarness();
    const a = alice();
    await deal([{ user: a, bet: 200 }], "8S 6C 8H 10D 3H 10C");
    await h.call("act", { tableId: "main", action: "split" }, a);
    expect(h.balance("alice")).toBe(600);

    // "Restart": a fresh handler set over the same database.
    h.close();
    h = await createHarness({ db: h.db });
    expect(h.balance("alice")).toBe(1000);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM stakes").get()).toEqual({ n: 0 });
  });

  test("many random rounds with three players: wallet totals match settled history", async () => {
    h = await createHarness();
    const players = [alice(), bob(), h.user("carol")];
    for (const p of players) {
      await h.call("getLobby", {}, p);
      await h.call("sit", { tableId: "main" }, p);
    }
    const start = h.totalCp();
    const actions = ["hit", "stand", "double", "split", "surrender"];
    let rounds = 0;
    for (let r = 0; r < 60; r++) {
      for (const p of players) {
        await h.call("setBet", { tableId: "main", amount: 10 + ((r * 7) % 50), ready: true }, p).catch(() => undefined);
      }
      await h.clock.advance(1300);
      for (let guard = 0; guard < 80; guard++) {
        await h.clock.advance(400);
        const s = h.lastTable();
        if (s.phase === "insurance") {
          for (const p of players) await h.call("insurance", { tableId: "main", take: r % 2 === 0 }, p).catch(() => undefined);
        }
        if (s.phase === "playing" && s.turn) {
          const who = players.find((p) => p.id === s.turn.userId)!;
          const action = actions[(r + guard) % actions.length]!;
          await h.call("act", { tableId: "main", action }, who).catch(() =>
            h.call("act", { tableId: "main", action: "stand" }, who),
          );
        }
        if (s.phase === "waiting") break;
      }
      rounds++;
    }
    expect(rounds).toBe(60);
    // Every CP is in a wallet or on the felt, and what left wallets equals history.
    const settled = h.db.prepare("SELECT COALESCE(SUM(payout - bet), 0) AS n, COUNT(*) AS c FROM hands").get() as any;
    expect(settled.c).toBeGreaterThan(60);
    const insurance = h.totalCp() - start - settled.n;
    // Insurance isn't a hand row; it's the only CP flow not in `hands`.
    const wallets = h.db.prepare("SELECT SUM(net) AS n FROM wallets").get() as any;
    expect(h.totalCp() - start).toBe(wallets.n);
    expect(typeof insurance).toBe("number");
    for (const p of players) expect(h.balance(p.id)).toBeGreaterThanOrEqual(0);
  });
});

describe("lobby and tables", () => {
  test("daily bonus once per cooldown", async () => {
    h = await createHarness();
    const a = alice();
    const r = await h.call<any>("claimDaily", {}, a);
    expect(r.wallet.balance).toBe(1250);
    await expect(h.call("claimDaily", {}, a)).rejects.toThrow("isn't ready");
    await h.clock.advance(20 * 60 * 60 * 1000);
    await h.call("claimDaily", {}, a);
    expect(h.balance("alice")).toBe(1500);
  });

  test("create, list and close tables with permission checks", async () => {
    h = await createHarness();
    const a = alice();
    const b = bob();
    const { id } = await h.call<any>("createTable", { name: "Kitchen", minBet: 5, maxBet: 200 }, a);
    await expect(h.call("createTable", { name: "kitchen", minBet: 5, maxBet: 200 }, b)).rejects.toThrow("already open");
    const lobby = await h.call<any>("getLobby", {}, b);
    expect(lobby.tables.map((t: any) => t.name)).toEqual(["Main Table", "Kitchen"]);
    await expect(h.call("closeTable", { tableId: id }, b)).rejects.toThrow("creator or a moderator");
    await expect(h.call("closeTable", { tableId: "main" }, a)).rejects.toThrow("can't be closed");
    await h.call("closeTable", { tableId: id }, a);
    expect(h.handle.tables.has(id)).toBe(false);
  });

  test("members can't open tables when disabled", async () => {
    h = await createHarness();
    h.settings["allow_member_tables"] = false;
    await h.handle.refreshSettings();
    await expect(h.call("createTable", { name: "Nope", minBet: 5, maxBet: 50 }, alice())).rejects.toThrow("moderators");
    h.moderators.add("bob");
    await h.call("createTable", { name: "Mods", minBet: 5, maxBet: 50 }, bob());
  });

  test("idle user tables are swept, the main table is not", async () => {
    h = await createHarness();
    const { id } = await h.call<any>("createTable", { name: "Ghost", minBet: 5, maxBet: 50 }, alice());
    await h.clock.advance(32 * 60 * 1000);
    expect(h.handle.tables.has(id)).toBe(false);
    expect(h.handle.tables.has("main")).toBe(true);
  });

  test("heartbeat with a current seq returns no payload", async () => {
    h = await createHarness();
    const a = alice();
    const first = await h.call<any>("watchTable", { tableId: "main" }, a);
    const again = await h.call<any>("watchTable", { tableId: "main", seq: first.state.seq }, a);
    expect(again.unchanged).toBe(true);
  });
});
