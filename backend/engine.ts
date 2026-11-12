// BlackJack rules — pure functions, no SDK, no I/O.
//
// Everything about "what is this hand worth" and "is this move legal" lives
// here so it can be unit-tested directly and shared by every table.

export type Suit = "S" | "H" | "D" | "C";
export type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";

export interface Card {
  r: Rank;
  s: Suit;
}

export const SUITS: readonly Suit[] = ["S", "H", "D", "C"];
export const RANKS: readonly Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

/** Max hands one seat may hold after splitting. */
export const MAX_HANDS = 4;

/** Uniform float in [0, 1). Injectable so tests can be deterministic. */
export type Random = () => number;

/** Cryptographically strong default RNG — a shuffle players can trust. */
export const cryptoRandom: Random = () => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 4294967296;
};

export function cardValue(card: Card): number {
  if (card.r === "A") return 11;
  if (card.r === "J" || card.r === "Q" || card.r === "K") return 10;
  return Number(card.r);
}

export interface HandTotal {
  /** Best total ≤ 21 if one exists, otherwise the (bust) hard total. */
  total: number;
  /** True when an ace is still being counted as 11. */
  soft: boolean;
}

export function handTotal(cards: readonly Card[]): HandTotal {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardValue(c);
    if (c.r === "A") aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

export function isBlackjack(cards: readonly Card[]): boolean {
  return cards.length === 2 && handTotal(cards).total === 21;
}

export function isBust(cards: readonly Card[]): boolean {
  return handTotal(cards).total > 21;
}

/** Ten-valued or ace upcard: the dealer checks for blackjack before play. */
export function dealerShouldPeek(upcard: Card): boolean {
  return upcard.r === "A" || cardValue(upcard) === 10;
}

export function dealerShouldHit(cards: readonly Card[], hitSoft17: boolean): boolean {
  const { total, soft } = handTotal(cards);
  if (total < 17) return true;
  return hitSoft17 && total === 17 && soft;
}

// ---------------------------------------------------------------------------
// Shoe
// ---------------------------------------------------------------------------

export class Shoe {
  private cards: Card[] = [];
  private dealt = 0;
  readonly size: number;

  constructor(
    readonly decks: number,
    private readonly random: Random = cryptoRandom,
    /** Fraction of the shoe dealt before a reshuffle is due. */
    private readonly penetration = 0.75,
  ) {
    this.size = decks * 52;
    this.shuffle();
  }

  shuffle(): void {
    const cards: Card[] = [];
    for (let d = 0; d < this.decks; d++) {
      for (const s of SUITS) for (const r of RANKS) cards.push({ r, s });
    }
    // Fisher–Yates.
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j]!, cards[i]!];
    }
    this.cards = cards;
    this.dealt = 0;
  }

  get remaining(): number {
    return this.cards.length - this.dealt;
  }

  /** Checked between rounds only, so a round never straddles a reshuffle. */
  get needsShuffle(): boolean {
    return this.dealt >= this.size * this.penetration;
  }

  draw(): Card {
    // A full table splitting to the limit can, in theory, exhaust a 1-deck
    // shoe mid-round; reshuffle rather than crash.
    if (this.dealt >= this.cards.length) this.shuffle();
    return this.cards[this.dealt++]!;
  }

  /** Test hook: put specific cards on top of the shoe, dealt in order. */
  stack(cards: Card[]): void {
    this.cards.splice(this.dealt, 0, ...cards);
  }
}

// ---------------------------------------------------------------------------
// Player hand decisions
// ---------------------------------------------------------------------------

export interface PlayerHandLike {
  cards: readonly Card[];
  fromSplit: boolean;
  splitAces: boolean;
}

export function canDouble(hand: PlayerHandLike): boolean {
  return hand.cards.length === 2 && !hand.splitAces && handTotal(hand.cards).total < 21;
}

export function canSplit(hand: PlayerHandLike, handCount: number): boolean {
  if (hand.cards.length !== 2 || handCount >= MAX_HANDS) return false;
  // No re-splitting aces: split aces get exactly one card each.
  if (hand.splitAces) return false;
  return cardValue(hand.cards[0]!) === cardValue(hand.cards[1]!);
}

/** Late surrender: first decision on the original two cards only. */
export function canSurrender(hand: PlayerHandLike, handCount: number): boolean {
  return handCount === 1 && !hand.fromSplit && hand.cards.length === 2;
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export type HandResult = "blackjack" | "win" | "push" | "lose" | "bust" | "surrender";

export type BlackjackPayout = "3:2" | "6:5";

export interface SettleInput {
  cards: readonly Card[];
  bet: number;
  fromSplit: boolean;
  surrendered: boolean;
}

export interface SettleOutcome {
  result: HandResult;
  /** Total CP returned to the player for this hand, stake included. */
  payout: number;
}

/** Winnings (excluding the returned stake) for a natural. Always an integer. */
export function blackjackWinnings(bet: number, payout: BlackjackPayout): number {
  return payout === "6:5" ? Math.floor((bet * 6) / 5) : Math.floor((bet * 3) / 2);
}

export function settleHand(
  hand: SettleInput,
  dealerCards: readonly Card[],
  payout: BlackjackPayout,
): SettleOutcome {
  if (hand.surrendered) return { result: "surrender", payout: Math.floor(hand.bet / 2) };

  const player = handTotal(hand.cards).total;
  if (player > 21) return { result: "bust", payout: 0 };

  // A two-card 21 after a split is just 21, not a natural.
  const playerNatural = !hand.fromSplit && isBlackjack(hand.cards);
  const dealerNatural = isBlackjack(dealerCards);

  if (playerNatural && dealerNatural) return { result: "push", payout: hand.bet };
  if (playerNatural) return { result: "blackjack", payout: hand.bet + blackjackWinnings(hand.bet, payout) };
  if (dealerNatural) return { result: "lose", payout: 0 };

  const dealer = handTotal(dealerCards).total;
  if (dealer > 21 || player > dealer) return { result: "win", payout: hand.bet * 2 };
  if (player === dealer) return { result: "push", payout: hand.bet };
  return { result: "lose", payout: 0 };
}

/** Insurance pays 2:1 when the dealer has a natural; the stake is returned too. */
export function settleInsurance(insurance: number, dealerCards: readonly Card[]): number {
  return insurance > 0 && isBlackjack(dealerCards) ? insurance * 3 : 0;
}

export function cardsToString(cards: readonly Card[]): string {
  return cards.map((c) => `${c.r}${c.s}`).join(" ");
}

/** Parse "AS 10H" style strings — used by tests to stack the shoe. */
export function parseCards(text: string): Card[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const s = tok.slice(-1) as Suit;
      const r = tok.slice(0, -1) as Rank;
      if (!SUITS.includes(s) || !RANKS.includes(r)) throw new Error(`Bad card: ${tok}`);
      return { r, s };
    });
}
