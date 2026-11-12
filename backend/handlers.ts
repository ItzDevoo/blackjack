// Every BlackJack request handler, plus the per-table game loop.
//
// The bodies live here rather than in index.ts so they can be registered
// against a test double: `registerHandlers` takes a structural `PluginLike`
// instead of importing the SDK, and its clock/timers/RNG are injectable, which
// lets tests/e2e.test.ts play whole rounds over an in-memory SQLite database
// with no runtime and no real waiting.
//
// House rules, applied to every handler in this file:
//   - `params` is untrusted: validate each field before use.
//   - Money binds to `user.id`, never to an id supplied by the caller.
//   - All SQL goes through `?` placeholders.
//   - The server is the only authority on cards, turns and CP.
//
// Concurrency model: each table owns an async lock. Every mutation — a user
// action or a timer firing — runs inside `runExclusive`, so two clicks (or a
// click racing a turn timeout) can never interleave half-way through a step.
// One broadcast goes out when the step finishes.
//
// CP model: a chip is debited from the wallet the moment it hits the felt, and
// recorded in `stakes` in the same transaction. Settlement credits payouts and
// deletes the round's stakes in one transaction. Whatever is left in `stakes`
// at boot was interrupted by a restart and is refunded, so CP is never lost.

import {
  MAX_HANDS,
  Shoe,
  canDouble,
  canSplit,
  canSurrender,
  cardsToString,
  cryptoRandom,
  dealerShouldHit,
  dealerShouldPeek,
  handTotal,
  isBlackjack,
  settleHand,
  settleInsurance,
  type BlackjackPayout,
  type Card,
  type HandResult,
  type Random,
} from "./engine.ts";

// ---------------------------------------------------------------------------
// The slice of the SDK this module needs
// ---------------------------------------------------------------------------

export interface AuthedUser {
  id: string;
  displayName?: string;
  avatarUrl?: string | null;
  role?: string;
}

export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

export interface PluginLike {
  handle(
    action: string,
    handler: (params: Record<string, unknown>, user: AuthedUser) => unknown | Promise<unknown>,
  ): void;
  db: {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
    batch(statements: SqlStatement[]): Promise<unknown>;
  };
  broadcast: {
    toUser(userId: string, event: string, payload: unknown): Promise<void>;
    toUsers(userIds: string[], event: string, payload: unknown): Promise<void>;
    toAll(event: string, payload: unknown): Promise<void>;
  };
  settings: {
    getAll(): Promise<Record<string, string | number | boolean>>;
  };
  permissions: {
    hasMinLevel(userId: string, level: number): Promise<boolean>;
  };
}

export interface Deps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  random: Random;
}

const realDeps: Deps = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: cryptoRandom,
};

// ---------------------------------------------------------------------------
// Tunables (not worth an admin setting)
// ---------------------------------------------------------------------------

export const SEATS = 5;
const MOD_LEVEL = 60;
const DAILY_COOLDOWN_MS = 20 * 60 * 60 * 1000;
/** Matches the frontend's per-card deal animation stagger. */
const DEAL_STAGGER_MS = 280;
const DEAL_SETTLE_MS = 450;
const INSURANCE_MS = 8000;
const DEALER_DRAW_MS = 800;
const SETTLE_SHOW_MS = 5500;
/** Once every seated player has bet and pressed Deal. */
const ALL_READY_MS = 1200;
const WATCH_TTL_MS = 60_000;
const LOBBY_COALESCE_MS = 400;
const IDLE_TABLE_MS = 30 * 60 * 1000;
const SWEEP_MS = 60_000;
const MAX_MISSED_ROUNDS = 3;
const MAX_TIMEOUTS = 2;
const MAX_TABLES_PER_USER = 2;
const HISTORY_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  startingBalance: number;
  dailyBonus: number;
  decks: number;
  bettingSeconds: number;
  turnSeconds: number;
  hitSoft17: boolean;
  blackjackPayout: BlackjackPayout;
  allowMemberTables: boolean;
  maxTables: number;
}

const DEFAULT_SETTINGS: Settings = {
  startingBalance: 1000,
  dailyBonus: 250,
  decks: 6,
  bettingSeconds: 15,
  turnSeconds: 20,
  hitSoft17: false,
  blackjackPayout: "3:2",
  allowMemberTables: true,
  maxTables: 8,
};

function intIn(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

// ---------------------------------------------------------------------------
// In-memory game state
// ---------------------------------------------------------------------------

type Phase = "waiting" | "betting" | "dealing" | "insurance" | "playing" | "dealer" | "settled";

interface DealtCard extends Card {
  /** Monotonic per table — lets the client animate only cards it hasn't seen. */
  id: number;
}

interface Hand {
  id: number;
  cards: DealtCard[];
  bet: number;
  doubled: boolean;
  stood: boolean;
  surrendered: boolean;
  fromSplit: boolean;
  splitAces: boolean;
  result: HandResult | null;
  payout: number | null;
}

interface Seat {
  index: number;
  userId: string;
  name: string;
  avatarUrl: string | null;
  /** CP staked for the upcoming round (already debited). */
  bet: number;
  lastBet: number;
  ready: boolean;
  inRound: boolean;
  hands: Hand[];
  insurance: number;
  insuranceDecided: boolean;
  /** Everything this seat put on the felt this round (bets, doubles, splits, insurance). */
  staked: number;
  /** Round result (payout − staked), set at settlement. */
  delta: number | null;
  missedRounds: number;
  timeouts: number;
  leaving: boolean;
}

interface Standing {
  userId: string;
  name: string;
  net: number;
  hands: number;
}

interface Table {
  id: string;
  name: string;
  minBet: number;
  maxBet: number;
  createdBy: string | null;
  isDefault: boolean;
  createdAt: number;

  shoe: Shoe;
  shuffledAt: number;
  seats: (Seat | null)[];
  phase: Phase;
  deadline: number | null;
  roundId: string;
  dealer: { cards: DealtCard[]; revealed: boolean };
  turn: { seat: number; hand: number } | null;
  notice: string | null;
  results: { userId: string; name: string; delta: number }[] | null;
  standings: Map<string, Standing>;

  seq: number;
  dealCounter: number;
  handCounter: number;
  watchers: Map<string, number>;
  lastActivity: number;

  lock: Promise<void>;
  timer: unknown;
  timerToken: number;
  dirty: boolean;
  /** What the lobby last saw of this table; re-broadcast only when it changes. */
  lobbySig: string;
  closed: boolean;
}

interface TableRow {
  id: string;
  name: string;
  min_bet: number;
  max_bet: number;
  created_by: string | null;
  is_default: number;
  created_at: number;
}

interface WalletRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  balance: number;
  hands_played: number;
  hands_won: number;
  hands_lost: number;
  hands_pushed: number;
  blackjacks: number;
  total_wagered: number;
  net: number;
  biggest_win: number;
  last_daily_at: number | null;
}

const WALLET_COLUMNS =
  "user_id, display_name, avatar_url, balance, hands_played, hands_won, hands_lost, hands_pushed, blackjacks, total_wagered, net, biggest_win, last_daily_at";

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || !v) throw new Error(`Missing ${key}.`);
  return v;
}

function int(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${key} must be a whole number.`);
  return v;
}

function nameOf(user: AuthedUser): string {
  const n = (user.displayName ?? "").trim();
  return n ? n.slice(0, 40) : "Player";
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// registerHandlers
// ---------------------------------------------------------------------------

export interface BlackjackHandle {
  refreshSettings(): Promise<void>;
  /** Resolves once stakes are recovered and tables are loaded. */
  ready: Promise<void>;
  /** Test hooks. */
  tables: Map<string, Table>;
  settings: Settings;
  dispose(): void;
}

export function registerHandlers(plugin: PluginLike, deps: Deps = realDeps): BlackjackHandle {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const tables = new Map<string, Table>();
  /** userId → display name we last wrote to their wallet row. */
  const knownWallets = new Map<string, string>();
  let lobbyTimer: unknown = null;
  let sweepTimer: unknown = null;
  let disposed = false;

  // ---- settings ----------------------------------------------------------

  async function refreshSettings(): Promise<void> {
    const s = await plugin.settings.getAll();
    settings.startingBalance = intIn(s["starting_balance"], 100, 100000, DEFAULT_SETTINGS.startingBalance);
    settings.dailyBonus = intIn(s["daily_bonus"], 0, 10000, DEFAULT_SETTINGS.dailyBonus);
    settings.decks = intIn(s["decks"], 1, 8, DEFAULT_SETTINGS.decks);
    settings.bettingSeconds = intIn(s["betting_seconds"], 5, 60, DEFAULT_SETTINGS.bettingSeconds);
    settings.turnSeconds = intIn(s["turn_seconds"], 8, 90, DEFAULT_SETTINGS.turnSeconds);
    settings.hitSoft17 = typeof s["dealer_hits_soft_17"] === "boolean" ? s["dealer_hits_soft_17"] : DEFAULT_SETTINGS.hitSoft17;
    settings.blackjackPayout = s["blackjack_payout"] === "6:5" ? "6:5" : "3:2";
    settings.allowMemberTables =
      typeof s["allow_member_tables"] === "boolean" ? s["allow_member_tables"] : DEFAULT_SETTINGS.allowMemberTables;
    settings.maxTables = intIn(s["max_tables"], 1, 30, DEFAULT_SETTINGS.maxTables);
  }

  // ---- boot: recover stakes, load tables ---------------------------------

  async function boot(): Promise<void> {
    // Refund CP left on the felt by a round that a restart interrupted.
    const orphaned = await plugin.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM stakes");
    if ((orphaned[0]?.n ?? 0) > 0) {
      await plugin.db.batch([
        {
          sql: `UPDATE wallets SET balance = balance + (SELECT COALESCE(SUM(amount), 0) FROM stakes WHERE stakes.user_id = wallets.user_id),
                updated_at = ? WHERE user_id IN (SELECT user_id FROM stakes)`,
          params: [deps.now()],
        },
        { sql: "DELETE FROM stakes" },
      ]);
      console.error(`[blackjack] refunded ${orphaned[0]!.n} interrupted stake(s) after restart`);
    }
    await plugin.db.run("DELETE FROM hands WHERE created_at < ?", [deps.now() - HISTORY_KEEP_MS]);

    const rows = await plugin.db.query<TableRow>(
      "SELECT id, name, min_bet, max_bet, created_by, is_default, created_at FROM tables ORDER BY is_default DESC, created_at ASC",
    );
    for (const row of rows) tables.set(row.id, newTable(row));
    scheduleSweep();
  }

  const ready = boot();
  ready.catch((err) => console.error("[blackjack] boot failed:", err));

  function newTable(row: TableRow): Table {
    return {
      id: row.id,
      name: row.name,
      minBet: row.min_bet,
      maxBet: row.max_bet,
      createdBy: row.created_by,
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
      shoe: new Shoe(settings.decks, deps.random),
      shuffledAt: 0,
      seats: Array.from({ length: SEATS }, () => null),
      phase: "waiting",
      deadline: null,
      roundId: crypto.randomUUID(),
      dealer: { cards: [], revealed: false },
      turn: null,
      notice: null,
      results: null,
      standings: new Map(),
      seq: 0,
      dealCounter: 0,
      handCounter: 0,
      watchers: new Map(),
      lastActivity: deps.now(),
      lock: Promise.resolve(),
      timer: null,
      timerToken: 0,
      dirty: false,
      lobbySig: "",
      closed: false,
    };
  }

  function getTable(params: Record<string, unknown>): Table {
    const id = str(params, "tableId");
    const t = tables.get(id);
    if (!t || t.closed) throw new Error("That table is closed.");
    return t;
  }

  // ---- locking, timers, broadcasting -------------------------------------

  function runExclusive<T>(t: Table, fn: () => T | Promise<T>): Promise<T> {
    const run = t.lock.then(async () => {
      try {
        return await fn();
      } finally {
        if (t.dirty) {
          t.dirty = false;
          t.seq++;
          void broadcastTable(t);
          // The lobby shows seats and whether a hand is on, not every card.
          const sig = `${t.phase === "waiting" ? 0 : 1}|${t.seats.map((x) => x?.userId ?? "").join(",")}`;
          if (sig !== t.lobbySig) {
            t.lobbySig = sig;
            scheduleLobby();
          }
        }
      }
    });
    t.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function touch(t: Table): void {
    t.dirty = true;
    t.lastActivity = deps.now();
  }

  /** One pending timer per table; scheduling a new one cancels the old. */
  function schedule(t: Table, delay: number, fn: () => void | Promise<void>): void {
    cancelTimer(t);
    const token = ++t.timerToken;
    t.timer = deps.setTimer(() => {
      if (token !== t.timerToken || t.closed) return;
      void runExclusive(t, async () => {
        if (token !== t.timerToken || t.closed) return;
        t.timer = null;
        await fn();
      }).catch((err) => console.error(`[blackjack] table ${t.id} step failed:`, err));
    }, Math.max(0, delay));
  }

  function cancelTimer(t: Table): void {
    if (t.timer !== null) deps.clearTimer(t.timer);
    t.timer = null;
    t.timerToken++;
  }

  function audience(t: Table): string[] {
    const now = deps.now();
    const ids = new Set<string>();
    for (const [userId, expires] of t.watchers) {
      if (expires < now) t.watchers.delete(userId);
      else ids.add(userId);
    }
    for (const s of t.seats) if (s) ids.add(s.userId);
    return [...ids];
  }

  async function broadcastTable(t: Table): Promise<void> {
    const ids = audience(t);
    if (ids.length === 0) return;
    const state = serialize(t);
    try {
      for (let i = 0; i < ids.length; i += 100) {
        await plugin.broadcast.toUsers(ids.slice(i, i + 100), "table", state);
      }
    } catch (err) {
      // Best effort: clients heartbeat and resync from watchTable.
      console.error(`[blackjack] broadcast failed for ${t.id}:`, err);
    }
  }

  function scheduleLobby(): void {
    if (lobbyTimer !== null || disposed) return;
    lobbyTimer = deps.setTimer(() => {
      lobbyTimer = null;
      plugin.broadcast
        .toAll("lobby", { tables: lobbySummaries(), serverNow: deps.now() })
        .catch((err) => console.error("[blackjack] lobby broadcast failed:", err));
    }, LOBBY_COALESCE_MS);
  }

  async function pushWallet(userId: string): Promise<void> {
    try {
      const w = await loadWallet(userId);
      if (w) await plugin.broadcast.toUser(userId, "wallet", walletView(w));
    } catch (err) {
      console.error("[blackjack] wallet push failed:", err);
    }
  }

  // ---- wallets -----------------------------------------------------------

  async function ensureWallet(user: AuthedUser): Promise<void> {
    const name = nameOf(user);
    const avatar = user.avatarUrl ?? null;
    const key = `${name}\u0000${avatar ?? ""}`;
    if (knownWallets.get(user.id) === key) return;
    const now = deps.now();
    await plugin.db.run(
      `INSERT INTO wallets (user_id, display_name, avatar_url, balance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, avatar_url = excluded.avatar_url`,
      [user.id, name, avatar, settings.startingBalance, now, now],
    );
    knownWallets.set(user.id, key);
  }

  async function loadWallet(userId: string): Promise<WalletRow | null> {
    const rows = await plugin.db.query<WalletRow>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE user_id = ?`, [userId]);
    return rows[0] ?? null;
  }

  function walletView(w: WalletRow) {
    const nextDailyAt =
      settings.dailyBonus > 0 ? (w.last_daily_at === null ? 0 : w.last_daily_at + DAILY_COOLDOWN_MS) : null;
    return {
      balance: w.balance,
      handsPlayed: w.hands_played,
      handsWon: w.hands_won,
      handsLost: w.hands_lost,
      handsPushed: w.hands_pushed,
      blackjacks: w.blackjacks,
      totalWagered: w.total_wagered,
      net: w.net,
      biggestWin: w.biggest_win,
      dailyBonus: settings.dailyBonus,
      nextDailyAt,
      serverNow: deps.now(),
    };
  }

  /**
   * Atomically move `amount` CP from the wallet onto the felt. The stake
   * upsert and the wallet debit share one condition (balance ≥ amount) inside
   * one transaction, so either both happen or neither does.
   */
  async function debit(t: Table, userId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    const before = await stakeOf(t.roundId, userId);
    const results = await plugin.db.batch([
      {
        sql: `INSERT INTO stakes (round_id, table_id, user_id, amount)
              SELECT ?, ?, ?, ? WHERE (SELECT balance FROM wallets WHERE user_id = ?) >= ?
              ON CONFLICT(round_id, user_id) DO UPDATE SET amount = amount + excluded.amount`,
        params: [t.roundId, t.id, userId, amount, userId, amount],
      },
      {
        sql: "UPDATE wallets SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND balance >= ?",
        params: [amount, deps.now(), userId, amount],
      },
    ]);
    const changes = Array.isArray(results) ? (results[1] as { changes?: number } | undefined)?.changes : undefined;
    const ok = typeof changes === "number" ? changes === 1 : (await stakeOf(t.roundId, userId)) === before + amount;
    if (!ok) throw new Error("Not enough CP for that.");
    void pushWallet(userId);
  }

  /** Return CP from the felt to the wallet (bet lowered or seat left before the deal). */
  async function refund(t: Table, userId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    await plugin.db.batch([
      { sql: "UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?", params: [amount, deps.now(), userId] },
      // Delete first when the whole stake comes back (amount > 0 is a CHECK).
      { sql: "DELETE FROM stakes WHERE round_id = ? AND user_id = ? AND amount <= ?", params: [t.roundId, userId, amount] },
      { sql: "UPDATE stakes SET amount = amount - ? WHERE round_id = ? AND user_id = ?", params: [amount, t.roundId, userId] },
    ]);
    void pushWallet(userId);
  }

  async function stakeOf(roundId: string, userId: string): Promise<number> {
    const rows = await plugin.db.query<{ amount: number }>(
      "SELECT amount FROM stakes WHERE round_id = ? AND user_id = ?",
      [roundId, userId],
    );
    return rows[0]?.amount ?? 0;
  }

  // ---- serialization -----------------------------------------------------

  function handView(h: Hand) {
    const { total, soft } = handTotal(h.cards);
    return {
      id: h.id,
      cards: h.cards,
      bet: h.bet,
      doubled: h.doubled,
      stood: h.stood,
      surrendered: h.surrendered,
      fromSplit: h.fromSplit,
      total,
      soft: soft && total < 21,
      blackjack: !h.fromSplit && isBlackjack(h.cards),
      bust: total > 21,
      result: h.result,
      payout: h.payout,
    };
  }

  function serialize(t: Table) {
    const dealerCards = t.dealer.cards.map((c, i) =>
      i === 1 && !t.dealer.revealed ? { id: c.id, hidden: true as const } : c,
    );
    const visible = t.dealer.revealed ? t.dealer.cards : t.dealer.cards.slice(0, 1);
    const dTotal = visible.length ? handTotal(visible) : null;

    let turn = null;
    if (t.turn && t.phase === "playing") {
      const seat = t.seats[t.turn.seat];
      const hand = seat?.hands[t.turn.hand];
      if (seat && hand) {
        turn = {
          seat: t.turn.seat,
          hand: t.turn.hand,
          userId: seat.userId,
          canDouble: canDouble(hand),
          canSplit: canSplit(hand, seat.hands.length),
          canSurrender: canSurrender(hand, seat.hands.length),
          extraCost: hand.bet,
        };
      }
    }

    return {
      id: t.id,
      name: t.name,
      minBet: t.minBet,
      maxBet: t.maxBet,
      isDefault: t.isDefault,
      createdBy: t.createdBy,
      phase: t.phase,
      deadline: t.deadline,
      serverNow: deps.now(),
      seq: t.seq,
      roundId: t.roundId,
      notice: t.notice,
      rules: {
        blackjackPayout: settings.blackjackPayout,
        hitSoft17: settings.hitSoft17,
        decks: t.shoe.decks,
        turnSeconds: settings.turnSeconds,
        bettingSeconds: settings.bettingSeconds,
      },
      shoe: { remaining: t.shoe.remaining, size: t.shoe.size, shuffledAt: t.shuffledAt },
      dealer: {
        cards: dealerCards,
        revealed: t.dealer.revealed,
        total: dTotal ? dTotal.total : null,
        soft: dTotal ? dTotal.soft && dTotal.total < 21 : false,
        blackjack: t.dealer.revealed && isBlackjack(t.dealer.cards),
        bust: dTotal ? dTotal.total > 21 : false,
      },
      seats: t.seats.map((s) =>
        s
          ? {
              index: s.index,
              userId: s.userId,
              name: s.name,
              avatarUrl: s.avatarUrl,
              bet: s.bet,
              lastBet: s.lastBet,
              ready: s.ready,
              inRound: s.inRound,
              insurance: s.insurance,
              insuranceDecided: s.insuranceDecided,
              staked: s.staked,
              delta: s.delta,
              leaving: s.leaving,
              missedRounds: s.missedRounds,
              hands: s.hands.map(handView),
            }
          : null,
      ),
      turn,
      results: t.results,
      standings: [...t.standings.values()].sort((a, b) => b.net - a.net).slice(0, 8),
      watchers: audience(t).length,
    };
  }

  function lobbySummaries() {
    return [...tables.values()]
      .filter((t) => !t.closed)
      .map((t) => ({
        id: t.id,
        name: t.name,
        minBet: t.minBet,
        maxBet: t.maxBet,
        isDefault: t.isDefault,
        createdBy: t.createdBy,
        phase: t.phase,
        players: t.seats
          .filter((s): s is Seat => s !== null)
          .map((s) => ({ userId: s.userId, name: s.name, avatarUrl: s.avatarUrl })),
        seats: SEATS,
        watchers: audience(t).length,
      }));
  }

  // ---- seat helpers ------------------------------------------------------

  function seatOf(t: Table, userId: string): Seat | null {
    return t.seats.find((s) => s?.userId === userId) ?? null;
  }

  function seatedTableOf(userId: string): Table | null {
    for (const t of tables.values()) if (!t.closed && seatOf(t, userId)) return t;
    return null;
  }

  function occupied(t: Table): Seat[] {
    return t.seats.filter((s): s is Seat => s !== null);
  }

  function inRound(t: Table): Seat[] {
    return occupied(t).filter((s) => s.inRound);
  }

  function removeSeat(t: Table, seat: Seat): void {
    t.seats[seat.index] = null;
  }

  // ---- the round state machine -------------------------------------------
  //
  // waiting ─first bet→ betting ─deadline / all ready→ dealing
  //   dealing → insurance? → (dealer natural → settled) | playing
  //   playing ─each hand acted / timed out→ dealer → settled → waiting

  function openBetting(t: Table): void {
    t.phase = "betting";
    t.deadline = deps.now() + settings.bettingSeconds * 1000;
    t.notice = null;
    schedule(t, t.deadline - deps.now(), () => closeBetting(t));
  }

  /** Shorten the countdown once everyone seated has bet and pressed Deal. */
  function maybeHurry(t: Table): void {
    if (t.phase !== "betting") return;
    const seated = occupied(t).filter((s) => !s.leaving);
    if (seated.length === 0 || !seated.every((s) => s.bet > 0 && s.ready)) return;
    const soon = deps.now() + ALL_READY_MS;
    if (t.deadline === null || t.deadline > soon) {
      t.deadline = soon;
      schedule(t, ALL_READY_MS, () => closeBetting(t));
    }
  }

  function closeBetting(t: Table): void {
    const players = occupied(t).filter((s) => s.bet > 0);
    if (players.length === 0) {
      t.phase = "waiting";
      t.deadline = null;
      touch(t);
      return;
    }
    startRound(t);
  }

  function draw(t: Table): DealtCard {
    const c = t.shoe.draw();
    return { ...c, id: ++t.dealCounter };
  }

  function newHand(t: Table, bet: number, cards: DealtCard[], fromSplit: boolean, splitAces: boolean): Hand {
    return {
      id: ++t.handCounter,
      cards,
      bet,
      doubled: false,
      stood: false,
      surrendered: false,
      fromSplit,
      splitAces,
      result: null,
      payout: null,
    };
  }

  function startRound(t: Table): void {
    // Admin changed the deck count, or the cut card came out last round.
    let shuffled = false;
    if (t.shoe.decks !== settings.decks) {
      t.shoe = new Shoe(settings.decks, deps.random);
      shuffled = true;
    } else if (t.shoe.needsShuffle) {
      t.shoe.shuffle();
      shuffled = true;
    }
    if (shuffled) t.shuffledAt = deps.now();

    for (const s of occupied(t)) {
      if (s.bet > 0) {
        s.inRound = true;
        s.hands = [newHand(t, s.bet, [], false, false)];
        s.staked = s.bet;
        s.lastBet = s.bet;
        s.bet = 0;
        s.missedRounds = 0;
      } else {
        s.missedRounds++;
      }
      s.ready = false;
      s.insurance = 0;
      s.insuranceDecided = false;
      s.delta = null;
    }
    // Sat out too many rounds in a row: free the seat for someone else.
    for (const s of occupied(t)) {
      if (!s.inRound && (s.missedRounds >= MAX_MISSED_ROUNDS || s.leaving)) removeSeat(t, s);
    }

    const players = inRound(t);
    t.dealer = { cards: [], revealed: false };
    t.results = null;
    for (let pass = 0; pass < 2; pass++) {
      for (const s of players) s.hands[0]!.cards.push(draw(t));
      t.dealer.cards.push(draw(t));
    }

    t.phase = "dealing";
    t.deadline = null;
    t.turn = null;
    t.notice = shuffled ? "Fresh shoe shuffled" : null;
    touch(t);
    const dealt = players.length * 2 + 2;
    schedule(t, dealt * DEAL_STAGGER_MS + DEAL_SETTLE_MS, () => afterDeal(t));
  }

  function afterDeal(t: Table): void {
    const up = t.dealer.cards[0]!;
    if (up.r === "A") {
      t.phase = "insurance";
      t.deadline = deps.now() + INSURANCE_MS;
      t.notice = "Dealer shows an Ace — insurance?";
      touch(t);
      schedule(t, INSURANCE_MS, () => resolveInsurance(t));
      return;
    }
    if (dealerShouldPeek(up) && isBlackjack(t.dealer.cards)) {
      t.notice = "Dealer has blackjack";
      return revealAndSettle(t);
    }
    if (dealerShouldPeek(up)) t.notice = "Dealer checked — no blackjack";
    beginPlay(t);
  }

  function resolveInsurance(t: Table): void {
    for (const s of inRound(t)) s.insuranceDecided = true;
    if (isBlackjack(t.dealer.cards)) {
      t.notice = "Dealer has blackjack";
      return revealAndSettle(t);
    }
    t.notice = "Dealer checked — no blackjack";
    beginPlay(t);
  }

  function revealAndSettle(t: Table): void {
    t.dealer.revealed = true;
    t.turn = null;
    t.phase = "dealer";
    t.deadline = null;
    touch(t);
    schedule(t, DEALER_DRAW_MS, () => settle(t));
  }

  function beginPlay(t: Table): void {
    t.phase = "playing";
    touch(t);
    advanceTurn(t);
  }

  function handDone(h: Hand): boolean {
    if (h.stood || h.surrendered) return true;
    const total = handTotal(h.cards).total;
    return total >= 21; // bust, or 21 (nothing left to decide)
  }

  /** Move to the next hand that needs a decision, or hand over to the dealer. */
  function advanceTurn(t: Table): void {
    for (const s of t.seats) {
      if (!s || !s.inRound) continue;
      for (let h = 0; h < s.hands.length; h++) {
        const hand = s.hands[h]!;
        if (handDone(hand)) {
          hand.stood = true;
          continue;
        }
        if (s.leaving) {
          hand.stood = true;
          continue;
        }
        t.turn = { seat: s.index, hand: h };
        t.phase = "playing";
        t.deadline = deps.now() + settings.turnSeconds * 1000;
        touch(t);
        schedule(t, settings.turnSeconds * 1000, () => onTurnTimeout(t));
        return;
      }
    }
    t.turn = null;
    dealerPlay(t);
  }

  function onTurnTimeout(t: Table): void {
    const seat = t.turn ? t.seats[t.turn.seat] : null;
    const hand = seat?.hands[t.turn!.hand];
    if (seat && hand) {
      hand.stood = true;
      seat.timeouts++;
      // AFK: stand their remaining hands and free the seat after the round.
      if (seat.timeouts >= MAX_TIMEOUTS) seat.leaving = true;
    }
    advanceTurn(t);
  }

  function dealerPlay(t: Table): void {
    t.phase = "dealer";
    t.deadline = null;
    t.dealer.revealed = true;
    touch(t);
    const live = inRound(t).some((s) =>
      s.hands.some((h) => !h.surrendered && handTotal(h.cards).total <= 21 && !(isBlackjack(h.cards) && !h.fromSplit)),
    );
    if (!live) {
      schedule(t, DEALER_DRAW_MS, () => settle(t));
      return;
    }
    const step = () => {
      if (dealerShouldHit(t.dealer.cards, settings.hitSoft17)) {
        t.dealer.cards.push(draw(t));
        touch(t);
        schedule(t, DEALER_DRAW_MS, step);
      } else {
        schedule(t, DEALER_DRAW_MS * 0.6, () => settle(t));
      }
    };
    schedule(t, DEALER_DRAW_MS, step);
  }

  async function settle(t: Table): Promise<void> {
    const now = deps.now();
    const dealerCards = t.dealer.cards;
    const dealerTotal = handTotal(dealerCards).total;
    const statements: SqlStatement[] = [];
    const results: { userId: string; name: string; delta: number }[] = [];
    const touched: string[] = [];

    for (const s of inRound(t)) {
      let payout = settleInsurance(s.insurance, dealerCards);
      let won = 0;
      let lost = 0;
      let pushed = 0;
      let naturals = 0;
      for (const h of s.hands) {
        const out = settleHand(h, dealerCards, settings.blackjackPayout);
        h.result = out.result;
        h.payout = out.payout;
        payout += out.payout;
        if (out.result === "win" || out.result === "blackjack") won++;
        else if (out.result === "push") pushed++;
        else lost++;
        if (out.result === "blackjack") naturals++;
        statements.push({
          sql: `INSERT INTO hands (id, user_id, table_id, table_name, round_id, bet, payout, result, player_cards, dealer_cards, player_total, dealer_total, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            crypto.randomUUID(),
            s.userId,
            t.id,
            t.name,
            t.roundId,
            h.bet,
            out.payout,
            out.result,
            cardsToString(h.cards),
            cardsToString(dealerCards),
            handTotal(h.cards).total,
            dealerTotal,
            now,
          ],
        });
      }
      const delta = payout - s.staked;
      s.delta = delta;
      statements.push({
        sql: `UPDATE wallets SET balance = balance + ?, hands_played = hands_played + ?, hands_won = hands_won + ?,
              hands_lost = hands_lost + ?, hands_pushed = hands_pushed + ?, blackjacks = blackjacks + ?,
              total_wagered = total_wagered + ?, net = net + ?, biggest_win = MAX(biggest_win, ?), updated_at = ?
              WHERE user_id = ?`,
        params: [payout, s.hands.length, won, lost, pushed, naturals, s.staked, delta, Math.max(0, delta), now, s.userId],
      });
      results.push({ userId: s.userId, name: s.name, delta });
      touched.push(s.userId);

      const st = t.standings.get(s.userId) ?? { userId: s.userId, name: s.name, net: 0, hands: 0 };
      st.name = s.name;
      st.net += delta;
      st.hands += s.hands.length;
      t.standings.set(s.userId, st);
    }
    statements.push({ sql: "DELETE FROM stakes WHERE round_id = ?", params: [t.roundId] });

    try {
      await plugin.db.batch(statements);
    } catch (err) {
      // The stakes rows survive, so the next boot refunds them. Tell players.
      console.error(`[blackjack] settlement failed for table ${t.id}:`, err);
      t.notice = "Settlement failed — your stake will be refunded";
    }
    for (const id of touched) void pushWallet(id);

    t.phase = "settled";
    t.results = results;
    t.turn = null;
    const ms = SETTLE_SHOW_MS;
    t.deadline = now + ms;
    touch(t);
    schedule(t, ms, () => endRound(t));
  }

  function endRound(t: Table): void {
    for (const s of occupied(t)) {
      s.inRound = false;
      s.hands = [];
      s.staked = 0;
      s.insurance = 0;
      s.insuranceDecided = false;
      s.delta = null;
      if (s.leaving || s.timeouts >= MAX_TIMEOUTS) removeSeat(t, s);
    }
    t.dealer = { cards: [], revealed: false };
    t.turn = null;
    t.results = null;
    t.notice = null;
    t.roundId = crypto.randomUUID();
    t.phase = "waiting";
    t.deadline = null;
    touch(t);
  }

  // ---- sweeping idle tables ----------------------------------------------

  function scheduleSweep(): void {
    if (disposed) return;
    sweepTimer = deps.setTimer(() => {
      void sweep().finally(scheduleSweep);
    }, SWEEP_MS);
  }

  async function sweep(): Promise<void> {
    const cutoff = deps.now() - IDLE_TABLE_MS;
    for (const t of [...tables.values()]) {
      if (t.isDefault || t.closed || occupied(t).length > 0 || t.lastActivity > cutoff) continue;
      await closeTable(t).catch((err) => console.error("[blackjack] sweep failed:", err));
    }
  }

  async function closeTable(t: Table): Promise<void> {
    await runExclusive(t, async () => {
      if (occupied(t).length > 0) throw new Error("Players are still seated at that table.");
      await plugin.db.run("DELETE FROM tables WHERE id = ?", [t.id]);
      cancelTimer(t);
      t.closed = true;
      tables.delete(t.id);
    });
    // Tell anyone still watching that it is gone.
    const ids = [...t.watchers.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      await plugin.broadcast.toUsers(ids.slice(i, i + 100), "table.closed", { id: t.id }).catch(() => undefined);
    }
    scheduleLobby();
  }

  // =========================================================================
  // Handlers — registered synchronously.
  // =========================================================================

  plugin.handle("getLobby", async (_params, user) => {
    await ready;
    await ensureWallet(user);
    const [wallet, leaders, recent, isMod] = await Promise.all([
      loadWallet(user.id),
      plugin.db.query<WalletRow>(
        `SELECT ${WALLET_COLUMNS} FROM wallets WHERE hands_played > 0 OR user_id = ? ORDER BY balance DESC, net DESC LIMIT 10`,
        [user.id],
      ),
      plugin.db.query<Record<string, unknown>>(
        `SELECT id, table_name, bet, payout, result, player_cards, dealer_cards, player_total, dealer_total, created_at
         FROM hands WHERE user_id = ? ORDER BY created_at DESC LIMIT 15`,
        [user.id],
      ),
      plugin.permissions.hasMinLevel(user.id, MOD_LEVEL).catch(() => false),
    ]);
    const rank = await plugin.db.query<{ n: number }>(
      "SELECT COUNT(*) + 1 AS n FROM wallets WHERE balance > ? AND hands_played > 0",
      [wallet?.balance ?? 0],
    );
    const seatedAt = seatedTableOf(user.id);
    return {
      me: { userId: user.id, name: nameOf(user), isMod, seatedAt: seatedAt?.id ?? null, rank: rank[0]?.n ?? null },
      wallet: wallet ? walletView(wallet) : null,
      tables: lobbySummaries(),
      leaderboard: leaders.map((w) => ({
        userId: w.user_id,
        name: w.display_name,
        avatarUrl: w.avatar_url,
        balance: w.balance,
        net: w.net,
        handsPlayed: w.hands_played,
        blackjacks: w.blackjacks,
      })),
      recent,
      canCreateTables: settings.allowMemberTables || isMod,
      maxTables: settings.maxTables,
      serverNow: deps.now(),
    };
  });

  plugin.handle("claimDaily", async (_params, user) => {
    await ready;
    await ensureWallet(user);
    if (settings.dailyBonus <= 0) throw new Error("The daily bonus is turned off on this server.");
    const now = deps.now();
    const res = await plugin.db.run(
      `UPDATE wallets SET balance = balance + ?, last_daily_at = ?, updated_at = ?
       WHERE user_id = ? AND (last_daily_at IS NULL OR last_daily_at <= ?)`,
      [settings.dailyBonus, now, now, user.id, now - DAILY_COOLDOWN_MS],
    );
    if (res.changes !== 1) throw new Error("Your daily bonus isn't ready yet.");
    const w = (await loadWallet(user.id))!;
    return { amount: settings.dailyBonus, wallet: walletView(w) };
  });

  plugin.handle("createTable", async (params, user) => {
    await ready;
    const isMod = await plugin.permissions.hasMinLevel(user.id, MOD_LEVEL).catch(() => false);
    if (!settings.allowMemberTables && !isMod) throw new Error("Only moderators can open tables on this server.");
    const name = (typeof params["name"] === "string" ? params["name"] : "").trim().replace(/\s+/g, " ");
    if (name.length < 1 || name.length > 32) throw new Error("Table name must be 1–32 characters.");
    const minBet = int(params, "minBet");
    const maxBet = int(params, "maxBet");
    if (minBet < 1 || minBet > 100000) throw new Error("Minimum bet must be between 1 and 100,000 CP.");
    if (maxBet < minBet || maxBet > 1000000) throw new Error("Maximum bet must be at least the minimum (max 1,000,000 CP).");

    const open = [...tables.values()].filter((t) => !t.closed);
    if (open.length >= settings.maxTables) throw new Error(`This server allows ${settings.maxTables} open tables. Join one instead!`);
    if (!isMod && open.filter((t) => t.createdBy === user.id).length >= MAX_TABLES_PER_USER) {
      throw new Error(`You can have ${MAX_TABLES_PER_USER} tables open at a time.`);
    }
    if (open.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new Error("A table with that name is already open.");

    const row: TableRow = {
      id: crypto.randomUUID(),
      name,
      min_bet: minBet,
      max_bet: maxBet,
      created_by: user.id,
      is_default: 0,
      created_at: deps.now(),
    };
    await plugin.db.run(
      "INSERT INTO tables (id, name, min_bet, max_bet, created_by, is_default, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      [row.id, row.name, row.min_bet, row.max_bet, row.created_by, row.created_at],
    );
    tables.set(row.id, newTable(row));
    scheduleLobby();
    return { id: row.id };
  });

  plugin.handle("closeTable", async (params, user) => {
    await ready;
    const t = getTable(params);
    if (t.isDefault) throw new Error("The main table can't be closed.");
    const isMod = await plugin.permissions.hasMinLevel(user.id, MOD_LEVEL).catch(() => false);
    if (t.createdBy !== user.id && !isMod) throw new Error("Only the table's creator or a moderator can close it.");
    await closeTable(t);
    return { closed: true };
  });

  /** Open a table view; doubles as the 20 s heartbeat that keeps you subscribed. */
  plugin.handle("watchTable", async (params, user) => {
    await ready;
    const t = getTable(params);
    await ensureWallet(user);
    const fresh = !t.watchers.has(user.id);
    t.watchers.set(user.id, deps.now() + WATCH_TTL_MS);
    if (fresh) scheduleLobby();
    const seq = params["seq"];
    // Heartbeat with an up-to-date client: skip the payload.
    if (typeof seq === "number" && seq === t.seq) return { unchanged: true, seq: t.seq, serverNow: deps.now() };
    return { state: serialize(t) };
  });

  plugin.handle("unwatchTable", async (params, user) => {
    await ready;
    const t = tables.get(typeof params["tableId"] === "string" ? params["tableId"] : "");
    if (t && t.watchers.delete(user.id)) scheduleLobby();
    return { ok: true };
  });

  plugin.handle("sit", async (params, user) => {
    await ready;
    const t = getTable(params);
    await ensureWallet(user);
    return runExclusive(t, async () => {
      const already = seatedTableOf(user.id);
      if (already && already !== t) throw new Error(`You're already seated at ${already.name}. Leave that seat first.`);
      const existing = seatOf(t, user.id);
      if (existing) {
        existing.leaving = false;
        existing.missedRounds = 0;
        existing.timeouts = 0;
        touch(t);
        return { seat: existing.index };
      }
      let index = typeof params["seat"] === "number" ? params["seat"] : -1;
      if (!Number.isInteger(index) || index < 0 || index >= SEATS || t.seats[index]) {
        index = t.seats.findIndex((s) => s === null);
      }
      if (index < 0) throw new Error("This table is full. Watch for a seat to open up.");
      t.seats[index] = {
        index,
        userId: user.id,
        name: nameOf(user),
        avatarUrl: user.avatarUrl ?? null,
        bet: 0,
        lastBet: 0,
        ready: false,
        inRound: false,
        hands: [],
        insurance: 0,
        insuranceDecided: false,
        staked: 0,
        delta: null,
        missedRounds: 0,
        timeouts: 0,
        leaving: false,
      };
      t.watchers.set(user.id, deps.now() + WATCH_TTL_MS);
      touch(t);
      return { seat: index };
    });
  });

  plugin.handle("standUp", async (params, user) => {
    await ready;
    const t = getTable(params);
    return runExclusive(t, async () => {
      const seat = seatOf(t, user.id);
      if (!seat) return { left: true };
      if (seat.inRound) {
        // Finish the hand on autopilot: stand everything, free the seat after.
        seat.leaving = true;
        if (t.phase === "playing" && t.turn?.seat === seat.index) {
          for (const h of seat.hands) h.stood = true;
          advanceTurn(t);
        }
        touch(t);
        return { left: false, leavingAfterRound: true };
      }
      if (seat.bet > 0) await refund(t, user.id, seat.bet);
      removeSeat(t, seat);
      if (t.phase === "betting" && occupied(t).every((s) => s.bet === 0)) {
        cancelTimer(t);
        t.phase = "waiting";
        t.deadline = null;
      } else {
        maybeHurry(t);
      }
      touch(t);
      return { left: true };
    });
  });

  plugin.handle("setBet", async (params, user) => {
    await ready;
    const t = getTable(params);
    const amount = int(params, "amount");
    return runExclusive(t, async () => {
      const seat = seatOf(t, user.id);
      if (!seat) throw new Error("Take a seat to place a bet.");
      if (t.phase !== "waiting" && t.phase !== "betting") throw new Error("Bets are closed — wait for the next round.");
      if (amount !== 0 && (amount < t.minBet || amount > t.maxBet)) {
        throw new Error(`Bets at this table are ${fmt(t.minBet)}–${fmt(t.maxBet)} CP.`);
      }
      const delta = amount - seat.bet;
      if (delta > 0) await debit(t, user.id, delta);
      else if (delta < 0) await refund(t, user.id, -delta);
      seat.bet = amount;
      seat.leaving = false;
      seat.missedRounds = 0;
      // Changing the bet means you haven't confirmed the new amount yet,
      // except via the explicit "ready" flag on the request (Rebet + Deal).
      seat.ready = amount > 0 && params["ready"] === true;

      if (amount > 0 && t.phase === "waiting") openBetting(t);
      if (t.phase === "betting" && occupied(t).every((s) => s.bet === 0)) {
        cancelTimer(t);
        t.phase = "waiting";
        t.deadline = null;
      }
      maybeHurry(t);
      touch(t);
      return { bet: seat.bet };
    });
  });

  plugin.handle("ready", async (params, user) => {
    await ready;
    const t = getTable(params);
    return runExclusive(t, () => {
      const seat = seatOf(t, user.id);
      if (!seat || seat.bet <= 0) throw new Error("Place a bet first.");
      if (t.phase !== "betting") return { ok: true };
      seat.ready = true;
      maybeHurry(t);
      touch(t);
      return { ok: true };
    });
  });

  plugin.handle("insurance", async (params, user) => {
    await ready;
    const t = getTable(params);
    const take = params["take"] === true;
    return runExclusive(t, async () => {
      const seat = seatOf(t, user.id);
      if (t.phase !== "insurance" || !seat || !seat.inRound) throw new Error("Insurance isn't on offer right now.");
      if (seat.insuranceDecided) return { insurance: seat.insurance };
      if (take) {
        const cost = Math.floor(seat.hands[0]!.bet / 2);
        if (cost < 1) throw new Error("Your bet is too small to insure.");
        await debit(t, user.id, cost);
        seat.insurance = cost;
        seat.staked += cost;
      }
      seat.insuranceDecided = true;
      touch(t);
      if (inRound(t).every((s) => s.insuranceDecided)) schedule(t, 350, () => resolveInsurance(t));
      return { insurance: seat.insurance };
    });
  });

  plugin.handle("act", async (params, user) => {
    await ready;
    const t = getTable(params);
    const action = str(params, "action");
    // Lets a double-click or a retried request become a no-op instead of
    // acting on the *next* hand.
    const handId = typeof params["handId"] === "number" ? params["handId"] : null;
    return runExclusive(t, async () => {
      if (t.phase !== "playing" || !t.turn) throw new Error("It's not your turn.");
      const seat = t.seats[t.turn.seat];
      if (!seat || seat.userId !== user.id) throw new Error("It's not your turn.");
      const hand = seat.hands[t.turn.hand]!;
      if (handId !== null && hand.id !== handId) return { stale: true };
      seat.timeouts = 0;

      switch (action) {
        case "hit": {
          if (hand.splitAces) throw new Error("Split aces get one card each.");
          hand.cards.push(draw(t));
          break;
        }
        case "stand": {
          hand.stood = true;
          break;
        }
        case "double": {
          if (!canDouble(hand)) throw new Error("You can only double down on your first two cards.");
          await debit(t, user.id, hand.bet);
          seat.staked += hand.bet;
          hand.bet *= 2;
          hand.doubled = true;
          hand.cards.push(draw(t));
          hand.stood = true;
          break;
        }
        case "split": {
          if (!canSplit(hand, seat.hands.length)) {
            throw new Error(seat.hands.length >= MAX_HANDS ? `You can hold at most ${MAX_HANDS} hands.` : "You can only split a pair.");
          }
          await debit(t, user.id, hand.bet);
          seat.staked += hand.bet;
          const aces = hand.cards[0]!.r === "A";
          const second = hand.cards.pop()!;
          hand.fromSplit = true;
          hand.splitAces = aces;
          hand.cards.push(draw(t));
          const sibling = newHand(t, hand.bet, [second, draw(t)], true, aces);
          seat.hands.splice(t.turn.hand + 1, 0, sibling);
          if (aces) {
            hand.stood = true;
            sibling.stood = true;
          }
          break;
        }
        case "surrender": {
          if (!canSurrender(hand, seat.hands.length)) throw new Error("You can only surrender your first two cards.");
          hand.surrendered = true;
          break;
        }
        default:
          throw new Error("Unknown action.");
      }

      touch(t);
      if (handDone(hand)) advanceTurn(t);
      else {
        // Still your hand: restart the clock for the next decision.
        t.deadline = deps.now() + settings.turnSeconds * 1000;
        schedule(t, settings.turnSeconds * 1000, () => onTurnTimeout(t));
      }
      return { ok: true };
    });
  });

  plugin.handle("getHistory", async (_params, user) => {
    await ready;
    return plugin.db.query(
      `SELECT id, table_name, bet, payout, result, player_cards, dealer_cards, player_total, dealer_total, created_at
       FROM hands WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [user.id],
    );
  });

  // Reserved action: tells the shell what to render in the sidebar.
  plugin.handle("sidebar.items", async () => ({
    items: [
      {
        id: "blackjack",
        label: "BlackJack",
        icon: "Spade",
        panelType: "plugin" as const,
        slug: "blackjack", // must equal manifest "name"
        section: "BlackJack",
      },
    ],
  }));

  return {
    refreshSettings,
    ready,
    tables,
    settings,
    dispose() {
      disposed = true;
      if (lobbyTimer !== null) deps.clearTimer(lobbyTimer);
      if (sweepTimer !== null) deps.clearTimer(sweepTimer);
      for (const t of tables.values()) cancelTimer(t);
    },
  };
}
