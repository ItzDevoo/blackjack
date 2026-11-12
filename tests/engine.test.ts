import { describe, expect, test } from "bun:test";
import {
  Shoe,
  blackjackWinnings,
  canDouble,
  canSplit,
  canSurrender,
  dealerShouldHit,
  dealerShouldPeek,
  handTotal,
  isBlackjack,
  parseCards,
  settleHand,
  settleInsurance,
} from "../backend/engine.ts";
import { seededRandom } from "./harness.ts";

const c = parseCards;
const hand = (cards: string, extra: Partial<{ fromSplit: boolean; splitAces: boolean }> = {}) => ({
  cards: c(cards),
  fromSplit: false,
  splitAces: false,
  ...extra,
});

describe("hand totals", () => {
  test("hard and soft totals", () => {
    expect(handTotal(c("10S 7H"))).toEqual({ total: 17, soft: false });
    expect(handTotal(c("AS 6H"))).toEqual({ total: 17, soft: true });
    expect(handTotal(c("AS 6H 10D"))).toEqual({ total: 17, soft: false });
    expect(handTotal(c("AS AH"))).toEqual({ total: 12, soft: true });
    expect(handTotal(c("AS AH AD AC 7S"))).toEqual({ total: 21, soft: true });
    expect(handTotal(c("KS QH 5D"))).toEqual({ total: 25, soft: false });
  });

  test("blackjack only on two cards", () => {
    expect(isBlackjack(c("AS KH"))).toBe(true);
    expect(isBlackjack(c("AS 5H 5D"))).toBe(false);
  });
});

describe("dealer", () => {
  test("stands on soft 17 by default, hits it when H17", () => {
    expect(dealerShouldHit(c("AS 6H"), false)).toBe(false);
    expect(dealerShouldHit(c("AS 6H"), true)).toBe(true);
    expect(dealerShouldHit(c("10S 6H"), false)).toBe(true);
    expect(dealerShouldHit(c("10S 7H"), true)).toBe(false);
  });

  test("peeks on ace and ten-valued upcards", () => {
    expect(dealerShouldPeek(c("AS")[0]!)).toBe(true);
    expect(dealerShouldPeek(c("QS")[0]!)).toBe(true);
    expect(dealerShouldPeek(c("9S")[0]!)).toBe(false);
  });
});

describe("decisions", () => {
  test("split needs a same-value pair and room", () => {
    expect(canSplit(hand("8S 8H"), 1)).toBe(true);
    expect(canSplit(hand("KS QH"), 1)).toBe(true);
    expect(canSplit(hand("8S 9H"), 1)).toBe(false);
    expect(canSplit(hand("8S 8H"), 4)).toBe(false);
    expect(canSplit(hand("AS AH", { fromSplit: true, splitAces: true }), 2)).toBe(false);
  });

  test("double on two cards, never on split aces or 21", () => {
    expect(canDouble(hand("5S 6H"))).toBe(true);
    expect(canDouble(hand("5S 6H 2D"))).toBe(false);
    expect(canDouble(hand("AS 9H", { fromSplit: true, splitAces: true }))).toBe(false);
    expect(canDouble(hand("5S 6H", { fromSplit: true }))).toBe(true);
  });

  test("surrender only as the first decision", () => {
    expect(canSurrender(hand("10S 6H"), 1)).toBe(true);
    expect(canSurrender(hand("10S 6H", { fromSplit: true }), 2)).toBe(false);
    expect(canSurrender(hand("10S 3H 3D"), 1)).toBe(false);
  });
});

describe("settlement", () => {
  const settle = (p: string, d: string, bet = 100, extra: Partial<{ fromSplit: boolean; surrendered: boolean }> = {}) =>
    settleHand({ cards: c(p), bet, fromSplit: false, surrendered: false, ...extra }, c(d), "3:2");

  test("outcomes and payouts (stake included)", () => {
    expect(settle("AS KH", "10S 9H")).toEqual({ result: "blackjack", payout: 250 });
    expect(settle("AS KH", "AD QH")).toEqual({ result: "push", payout: 100 });
    expect(settle("10S 9H", "AD QH")).toEqual({ result: "lose", payout: 0 });
    expect(settle("10S 9H", "10D 8H")).toEqual({ result: "win", payout: 200 });
    expect(settle("10S 8H", "10D 8C")).toEqual({ result: "push", payout: 100 });
    expect(settle("10S 5H 9D", "10D 8C")).toEqual({ result: "bust", payout: 0 });
    expect(settle("10S 5H", "10D 6C 9H")).toEqual({ result: "win", payout: 200 });
    expect(settle("10S 5H", "10D 6C", 101, { surrendered: true })).toEqual({ result: "surrender", payout: 50 });
  });

  test("21 after a split is not a natural", () => {
    expect(settle("AS KH", "10S 9H", 100, { fromSplit: true })).toEqual({ result: "win", payout: 200 });
    expect(settle("AS KH", "AD QH", 100, { fromSplit: true })).toEqual({ result: "lose", payout: 0 });
  });

  test("blackjack payouts round down to whole CP", () => {
    expect(blackjackWinnings(25, "3:2")).toBe(37);
    expect(blackjackWinnings(25, "6:5")).toBe(30);
  });

  test("insurance pays 2:1", () => {
    expect(settleInsurance(50, c("AS KH"))).toBe(150);
    expect(settleInsurance(50, c("AS 9H"))).toBe(0);
  });
});

describe("shoe", () => {
  test("contains every card exactly decks times and is shuffled", () => {
    const shoe = new Shoe(2, seededRandom(7));
    const seen = new Map<string, number>();
    const firstTen: string[] = [];
    for (let i = 0; i < 104; i++) {
      const card = shoe.draw();
      const k = card.r + card.s;
      if (i < 10) firstTen.push(k);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    expect(seen.size).toBe(52);
    for (const n of seen.values()) expect(n).toBe(2);
    expect(firstTen.join(" ")).not.toBe("AS 2S 3S 4S 5S 6S 7S 8S 9S 10S");
  });

  test("flags a reshuffle past penetration and never runs dry", () => {
    const shoe = new Shoe(1, seededRandom(1));
    for (let i = 0; i < 38; i++) shoe.draw();
    expect(shoe.needsShuffle).toBe(false);
    for (let i = 0; i < 1; i++) shoe.draw();
    expect(shoe.needsShuffle).toBe(true);
    for (let i = 0; i < 100; i++) shoe.draw();
  });
});
