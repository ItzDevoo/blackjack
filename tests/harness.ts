// A headless stand-in for the UnCorded runtime.
//
// `registerHandlers` takes a structural plugin interface and injectable
// clock/timers, so these tests drive the real handlers against a real
// (in-memory) SQLite database built from the real migrations, and advance a
// fake clock instead of waiting for turn timers.

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCards, type Card } from "../backend/engine.ts";
import {
  registerHandlers,
  type AuthedUser,
  type BlackjackHandle,
  type PluginLike,
  type SqlStatement,
} from "../backend/handlers.ts";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Broadcast {
  to: string[] | "all";
  event: string;
  payload: any;
}

export class FakeClock {
  now = 1_800_000_000_000;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimer = (h: unknown): void => {
    this.timers.delete(h as number);
  };

  /** Run every timer due within `ms`, in order, letting async work settle between. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].fn();
    }
    this.now = target;
    await settle();
  }
}

/** Let queued promise chains (table locks, db calls) run to completion. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

export function createDb(): Database {
  const db = new Database(":memory:");
  const files = readdirSync(join(PLUGIN_ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(join(PLUGIN_ROOT, "migrations", f), "utf8"));
  return db;
}

export interface Harness {
  db: Database;
  clock: FakeClock;
  handle: BlackjackHandle;
  broadcasts: Broadcast[];
  settings: Record<string, string | number | boolean>;
  moderators: Set<string>;
  user(id: string, name?: string): AuthedUser;
  call<T = any>(action: string, params: Record<string, unknown>, user: AuthedUser): Promise<T>;
  /** Put specific cards on top of a table's shoe, e.g. "AS KH 9D". */
  stack(tableId: string, cards: string | Card[]): void;
  lastTable(tableId?: string): any;
  balance(userId: string): number;
  totalCp(): number;
  close(): void;
}

export async function createHarness(opts: { db?: Database; clock?: FakeClock } = {}): Promise<Harness> {
  const db = opts.db ?? createDb();
  const clock = opts.clock ?? new FakeClock();
  const handlers = new Map<string, (params: Record<string, unknown>, user: AuthedUser) => unknown>();
  const broadcasts: Broadcast[] = [];
  const settings: Record<string, string | number | boolean> = {};
  const moderators = new Set<string>();

  const plugin: PluginLike = {
    handle(action, handler) {
      handlers.set(action, handler);
    },
    db: {
      async query<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as never[])) as T[];
      },
      async run(sql: string, params: unknown[] = []) {
        const r = db.prepare(sql).run(...(params as never[]));
        return { changes: r.changes };
      },
      async batch(statements: SqlStatement[]) {
        const tx = db.transaction((list: SqlStatement[]) =>
          list.map((s) => {
            const r = db.prepare(s.sql).run(...((s.params ?? []) as never[]));
            return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
          }),
        );
        return tx(statements);
      },
    },
    broadcast: {
      async toUser(userId, event, payload) {
        broadcasts.push({ to: [userId], event, payload });
      },
      async toUsers(userIds, event, payload) {
        if (userIds.length > 100) throw new Error("toUsers: > 100 ids");
        broadcasts.push({ to: userIds, event, payload });
      },
      async toAll(event, payload) {
        broadcasts.push({ to: "all", event, payload });
      },
    },
    settings: {
      async getAll() {
        return { ...settings };
      },
    },
    permissions: {
      async hasMinLevel(userId) {
        return moderators.has(userId);
      },
    },
  };

  const handle = registerHandlers(plugin, {
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: seededRandom(42),
  });
  await handle.ready;
  await handle.refreshSettings();

  return {
    db,
    clock,
    handle,
    broadcasts,
    settings,
    moderators,
    user: (id, name) => ({ id, displayName: name ?? id[0]!.toUpperCase() + id.slice(1), avatarUrl: null }),
    async call<T>(action: string, params: Record<string, unknown>, user: AuthedUser) {
      const h = handlers.get(action);
      if (!h) throw new Error(`UNKNOWN_ACTION: ${action}`);
      const result = (await h(params, user)) as T;
      await settle();
      return result;
    },
    stack(tableId, cards) {
      const t = handle.tables.get(tableId)!;
      t.shoe.stack(typeof cards === "string" ? parseCards(cards) : cards);
    },
    lastTable(tableId = "main") {
      for (let i = broadcasts.length - 1; i >= 0; i--) {
        const b = broadcasts[i]!;
        if (b.event === "table" && b.payload.id === tableId) return b.payload;
      }
      return null;
    },
    balance(userId) {
      const row = db.prepare("SELECT balance FROM wallets WHERE user_id = ?").get(userId) as { balance: number } | null;
      return row?.balance ?? 0;
    },
    totalCp() {
      const w = db.prepare("SELECT COALESCE(SUM(balance), 0) AS n FROM wallets").get() as { n: number };
      const s = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM stakes").get() as { n: number };
      return w.n + s.n;
    },
    close() {
      handle.dispose();
    },
  };
}

/** Deterministic PRNG so a failing playout can be reproduced exactly. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
