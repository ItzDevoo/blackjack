# BlackJack

Multiplayer BlackJack for friends and families. Sit at a table, bet fake
currency (**CP**) against an automatic dealer, and climb the server leaderboard.

An UnCorded plugin. This folder's name (`blackjack`) is the plugin's slug
and must not change — it is the plugin's identity everywhere.

## What players get

- **Tables** — a permanent *Main Table* plus player-opened tables with their
  own bet limits (up to 5 seats each; anyone can watch). Empty player tables
  close themselves after 30 minutes.
- **Real rules** — 6-deck shoe (configurable) with a cut card, dealer peek,
  insurance, double on any two cards (including after a split), split up to
  4 hands (split aces get one card), and late surrender.
- **CP wallet** — starting chips, a daily bonus, lifetime stats, recent-hand
  history and a server leaderboard; plus per-table session standings.
- **Smooth table** — cards deal from the shoe, the hole card flips, results
  stamp onto each hand, keyboard shortcuts (H / S / D / P / R, Enter to deal),
  synthesized sound effects with a mute toggle, light/dark theming, and a
  phone-sized layout.

## How it works

The backend is authoritative: it owns the shoe, turn order, timers and every
CP. Each table runs its steps through an async lock so clicks and timeouts
never interleave. A bet is debited the moment it's placed and recorded in
`stakes` in the same transaction; settlement pays out and clears stakes
atomically, and any stakes left behind by a restart are refunded at boot, so
CP is never lost. Live table state is pushed to watchers with
`broadcast.toUsers`; panels heartbeat every 20 s to stay subscribed and to
resync after a missed update.

| Path | What |
| --- | --- |
| `backend/engine.ts` | Pure rules: shoe, totals, legality, payouts |
| `backend/handlers.ts` | Handlers, wallets, table state machine |
| `backend/index.ts` | Entry: registers handlers, loads settings |
| `frontend/` | Panel (`index.html`, `styles.css`, `app.js`) |
| `migrations/002_blackjack.sql` | Schema (replaces the scaffold's `visits`) |
| `tests/` | Rules tests + whole-round simulations on a fake clock |

Admin settings (Server settings → Plugins → BlackJack): starting CP, daily
bonus, decks, betting window, turn timer, dealer hits soft 17, blackjack
payout (3:2 or 6:5), whether members can open tables, and the table limit.

## Develop

```sh
bun test
```

Bump the `?v=` tokens in `frontend/index.html` together with the manifest
`version` when releasing, so clients pick up the new assets.

## Load it into a server

The easiest path is the UnCorded desktop app: Server settings → Plugins →
Add Plugin → Develop → **Install**. Manually:

1. Copy this folder to `<server-data>/plugins/blackjack/`.
2. Add `"blackjack"` to `installed_plugins` in the server's `server.json`.
3. Restart the server **through the desktop app** (the runtime reads
   `installed_plugins` only at boot, and a bare `docker restart` degrades
   the tunnel).

For development guidance, see `AGENTS.md`.
