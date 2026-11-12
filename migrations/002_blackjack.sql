-- 002_blackjack.sql — replaces the scaffold's starter "visits" feature with
-- the BlackJack schema. Timestamps are Unix-ms integers; CP amounts are
-- integers (no fractional chips, ever).

DROP TABLE IF EXISTS visits;

-- One wallet per player. Created lazily the first time a user opens the panel.
CREATE TABLE wallets (
  user_id        TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL DEFAULT '',
  avatar_url     TEXT,
  balance        INTEGER NOT NULL CHECK (balance >= 0),
  hands_played   INTEGER NOT NULL DEFAULT 0,
  hands_won      INTEGER NOT NULL DEFAULT 0,
  hands_lost     INTEGER NOT NULL DEFAULT 0,
  hands_pushed   INTEGER NOT NULL DEFAULT 0,
  blackjacks     INTEGER NOT NULL DEFAULT 0,
  total_wagered  INTEGER NOT NULL DEFAULT 0,
  net            INTEGER NOT NULL DEFAULT 0,
  biggest_win    INTEGER NOT NULL DEFAULT 0,
  last_daily_at  INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_wallets_balance ON wallets(balance DESC);

-- Table definitions. Live game state (shoe, seats, hands) is in memory only;
-- what must survive a restart is the table itself and any CP on the felt.
CREATE TABLE tables (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  min_bet     INTEGER NOT NULL,
  max_bet     INTEGER NOT NULL,
  created_by  TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

INSERT INTO tables (id, name, min_bet, max_bet, created_by, is_default, created_at)
VALUES ('main', 'Main Table', 10, 1000, NULL, 1, 0);

-- CP currently on the felt: debited from the wallet but not yet settled.
-- Settlement deletes these rows in the same transaction that pays out; any
-- rows still present at boot belong to a round a restart interrupted and are
-- refunded.
CREATE TABLE stakes (
  round_id   TEXT NOT NULL,
  table_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount > 0),
  PRIMARY KEY (round_id, user_id)
);

-- Settled hand history (one row per player hand, splits included).
CREATE TABLE hands (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  table_id      TEXT NOT NULL,
  table_name    TEXT NOT NULL,
  round_id      TEXT NOT NULL,
  bet           INTEGER NOT NULL,
  payout        INTEGER NOT NULL,
  result        TEXT NOT NULL,
  player_cards  TEXT NOT NULL,
  dealer_cards  TEXT NOT NULL,
  player_total  INTEGER NOT NULL,
  dealer_total  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_hands_user ON hands(user_id, created_at DESC);
CREATE INDEX idx_hands_created ON hands(created_at);
