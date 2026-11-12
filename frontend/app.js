// BlackJack — panel app.
//
// The backend is the only authority: it owns the shoe, the turn order and
// every CP. This file renders what it is told, animates the difference
// between one state and the next, and sends intent back.
//
// Rendering strategy, for smoothness:
//   - The lobby is cheap and re-rendered wholesale.
//   - The table view builds its skeleton once, then reconciles: cards are
//     keyed by their server deal id so only genuinely new cards animate in,
//     seats are patched in place, and the action dock re-renders only when
//     its inputs change. Countdown text and rings tick from CSS / one timer.

const UP = window.UncodedPlugin;
const $ = (sel, root = document) => root.querySelector(sel);

const CHIPS = [5, 25, 100, 500, 1000];
const DEAL_STAGGER = 280; // keep in step with DEAL_STAGGER_MS on the server
const HEARTBEAT_MS = 20_000;
const SUIT = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RESULT_LABEL = {
  blackjack: "Blackjack",
  win: "Win",
  push: "Push",
  lose: "Lose",
  bust: "Bust",
  surrender: "Surrendered",
};

const S = {
  sdk: null,
  view: "boot",
  me: null,
  wallet: null,
  lobby: null,
  table: null,
  tableId: null,
  offset: 0,
  /** Locally stacked bet not yet confirmed by the server. */
  pendingBet: null,
  betTimer: null,
  betInFlight: null,
  knownCards: new Set(),
  dockSig: "",
  noticeKey: "",
  heartbeat: null,
  lobbyPoll: null,
  muted: loadPref("bj.muted", false),
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback; // sandboxed storage may be unavailable
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* in-memory only */
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const nf = new Intl.NumberFormat("en-US");
const fmt = (n) => nf.format(n);
const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : "±0");
const serverNow = () => Date.now() + S.offset;

function syncClock(serverTime) {
  if (typeof serverTime === "number") S.offset = serverTime - Date.now();
}

function secondsLeft(deadline) {
  return Math.max(0, Math.ceil((deadline - serverNow()) / 1000));
}

function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function avatar(userId, name, url, size = 26) {
  if (UP && typeof UP.avatarHtml === "function") {
    return UP.avatarHtml({ userId, displayName: name, avatarUrl: url, size });
  }
  return `<span style="display:grid;place-items:center;width:${size}px;height:${size}px;border-radius:50%;background:#456;color:#fff;font-size:${size * 0.45}px;font-weight:700">${esc((name || "?")[0].toUpperCase())}</span>`;
}

function chipHtml(v, cls = "") {
  return `<span class="chip ${cls}" data-v="${v}"><span>${v >= 1000 ? v / 1000 + "k" : v}</span></span>`;
}

function breakdown(amount) {
  const out = [];
  let left = amount;
  for (const v of [...CHIPS].reverse()) {
    while (left >= v && out.length < 7) {
      out.push(v);
      left -= v;
    }
  }
  if (left > 0 && out.length < 7) out.push(5);
  return out.reverse();
}

function cardsText(str) {
  return String(str || "")
    .split(" ")
    .filter(Boolean)
    .map((tok) => {
      const s = tok.slice(-1);
      const r = tok.slice(0, -1);
      return `<span class="${s === "H" || s === "D" ? "r" : ""}">${esc(r)}${SUIT[s] ?? ""}</span>`;
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// Toasts, requests
// ---------------------------------------------------------------------------

function toast(message, severity = "info") {
  try {
    if (S.sdk?.platform?.toast?.show) {
      S.sdk.platform.toast.show({ message: String(message).slice(0, 280), severity });
      return;
    }
  } catch {
    /* fall through to inline */
  }
  const host = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${severity === "error" ? "error" : ""}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

async function call(action, params = {}, { quiet = false } = {}) {
  try {
    return await S.sdk.request(action, params);
  } catch (err) {
    if (!quiet) {
      const msg =
        err?.code === "REQUEST_TIMEOUT" ? "The server didn't respond. Try again." : err?.message || "Something went wrong. Try again.";
      toast(msg, "error");
      sfx.error();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sound — tiny WebAudio synth, no assets. Off by default until first click.
// ---------------------------------------------------------------------------

const sfx = (() => {
  let ctx = null;
  const ac = () => {
    if (S.muted) return null;
    try {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") void ctx.resume();
      return ctx;
    } catch {
      return null;
    }
  };

  function tone(freq, { at = 0, dur = 0.12, type = "triangle", gain = 0.08, slide = 0 } = {}) {
    const c = ac();
    if (!c) return;
    const t = c.currentTime + at;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function noise({ at = 0, dur = 0.07, gain = 0.12, freq = 2400 } = {}) {
    const c = ac();
    if (!c) return;
    const t = c.currentTime + at;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = 0.8;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(c.destination);
    src.start(t);
  }

  return {
    card: (at = 0) => noise({ at, dur: 0.08, gain: 0.16, freq: 2600 }),
    flip: () => noise({ dur: 0.11, gain: 0.12, freq: 1600 }),
    chip: () => {
      tone(2200, { dur: 0.05, type: "square", gain: 0.025 });
      tone(3100, { at: 0.03, dur: 0.05, type: "square", gain: 0.018 });
    },
    turn: () => {
      tone(660, { dur: 0.12, gain: 0.06 });
      tone(990, { at: 0.1, dur: 0.16, gain: 0.06 });
    },
    win: () => [523, 659, 784].forEach((f, i) => tone(f, { at: i * 0.09, dur: 0.22, gain: 0.07 })),
    blackjack: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, { at: i * 0.08, dur: 0.3, gain: 0.07 })),
    lose: () => tone(330, { dur: 0.35, gain: 0.05, slide: 0.6 }),
    error: () => tone(200, { dur: 0.16, type: "sawtooth", gain: 0.03 }),
  };
})();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    if (!UP?.createPluginFrontend) throw new Error("SDK missing");
    S.sdk = await UP.createPluginFrontend();
  } catch (err) {
    $("#app").innerHTML = `<div class="boot"><div><h2 style="margin:0 0 6px">BlackJack couldn't connect</h2>
      <p style="margin:0">Open this panel from your UnCorded server, or reload the panel to try again.</p></div></div>`;
    console.error("[blackjack] handshake failed", err);
    return;
  }

  S.sdk.on("table", (state) => {
    if (state?.id === S.tableId) applyTable(state);
  });
  S.sdk.on("wallet", (w) => setWallet(w));
  S.sdk.on("lobby", (msg) => {
    syncClock(msg.serverNow);
    if (S.lobby) S.lobby.tables = msg.tables;
    if (S.view === "lobby") renderTables();
  });
  S.sdk.on("table.closed", ({ id }) => {
    if (id === S.tableId) {
      toast("This table was closed.");
      void showLobby();
    }
  });

  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.view === "table") void heartbeat(true);
  });
  setInterval(tick, 250);

  await showLobby();
  // Back where you were sitting, if anywhere.
  if (S.me?.seatedAt) await openTable(S.me.seatedAt);
}

function setWallet(w) {
  if (!w) return;
  syncClock(w.serverNow);
  const prev = S.wallet?.balance;
  S.wallet = w;
  for (const el of document.querySelectorAll("[data-balance]")) {
    el.textContent = fmt(displayBalance());
    if (prev !== undefined && prev !== w.balance) {
      const pill = el.closest(".balance-pill");
      if (pill) {
        pill.classList.remove("bump");
        void pill.offsetWidth;
        pill.classList.add("bump");
      }
    }
  }
  if (S.view === "lobby") renderWallet();
  if (S.view === "table") renderDock(true);
}

/** Wallet balance minus chips stacked locally but not yet sent. */
function displayBalance() {
  const base = S.wallet?.balance ?? 0;
  const seat = mySeat();
  if (S.pendingBet === null || !seat) return base;
  return base - (S.pendingBet - seat.bet);
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

async function showLobby() {
  if (S.tableId) {
    const id = S.tableId;
    S.tableId = null;
    S.table = null;
    void call("unwatchTable", { tableId: id }, { quiet: true }).catch(() => {});
  }
  clearInterval(S.heartbeat);
  S.view = "lobby";
  let data;
  try {
    data = await call("getLobby");
  } catch {
    $("#app").innerHTML = `<div class="boot"><div><p>Couldn't load the tables.</p><button class="btn" id="retry">Try again</button></div></div>`;
    $("#retry").onclick = () => showLobby();
    return;
  }
  syncClock(data.serverNow);
  S.lobby = data;
  S.me = data.me;
  S.wallet = data.wallet;
  renderLobby();
  clearInterval(S.lobbyPoll);
  S.lobbyPoll = setInterval(() => {
    if (S.view !== "lobby" || document.visibilityState !== "visible") return;
    call("getLobby", {}, { quiet: true })
      .then((d) => {
        if (S.view !== "lobby") return;
        S.lobby = d;
        S.me = d.me;
        S.wallet = d.wallet;
        syncClock(d.serverNow);
        renderWallet();
        renderTables();
        renderLeaders();
        renderRecent();
      })
      .catch(() => {});
  }, 30_000);
}

function renderLobby() {
  $("#app").innerHTML = `
    <header class="topbar">
      ${chipHtml(1000, "chip-mini")}
      <h1>BlackJack</h1>
      <span class="spacer"></span>
      ${muteButton()}
    </header>
    <main class="lobby">
      <div class="main-col">
        <section class="wallet" id="wallet"></section>
        <section class="panel">
          <div class="panel-head">
            <h2>Tables</h2>
            <button class="btn" id="new-table" ${S.lobby.canCreateTables ? "" : "hidden"}>Open a table</button>
          </div>
          <div class="table-list" id="tables"></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Your recent hands</h2></div>
          <ul class="recent" id="recent"></ul>
        </section>
      </div>
      <aside class="side-col">
        <section class="panel">
          <div class="panel-head"><h2>Leaderboard</h2><span class="hint">by CP</span></div>
          <ol class="leaders" id="leaders"></ol>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>How a round works</h2></div>
          <ol class="howto">
            <li>Sit at a table and stack chips on your spot.</li>
            <li>Press Deal, or let the betting timer run out.</li>
            <li>Beat the dealer's hand without going over 21.</li>
            <li>Everyone plays the house. The leaderboard settles who's up.</li>
          </ol>
        </section>
      </aside>
    </main>`;
  $("#new-table").onclick = openCreateDialog;
  wireMute();
  renderWallet();
  renderTables();
  renderLeaders();
  renderRecent();
}

function renderWallet() {
  const el = $("#wallet");
  if (!el || !S.wallet) return;
  const w = S.wallet;
  const rank = S.me?.rank && w.handsPlayed > 0 ? `<span>Rank <b>#${S.me.rank}</b></span>` : "";
  let daily = "";
  if (w.nextDailyAt !== null) {
    const ready = w.nextDailyAt <= serverNow();
    daily = `<div class="daily">
      <button class="btn" id="claim" ${ready ? "" : "disabled"}>Claim ${fmt(w.dailyBonus)} CP</button>
      <small data-until="${w.nextDailyAt}">${ready ? "Daily bonus ready" : `Next bonus in ${duration(w.nextDailyAt - serverNow())}`}</small>
    </div>`;
  }
  el.innerHTML = `
    <div>
      <div class="label">Your chips</div>
      <div class="amount"><span data-balance>${fmt(w.balance)}</span><span class="cp">CP</span></div>
      <div class="stats">
        ${rank}
        <span>Hands <b>${fmt(w.handsPlayed)}</b></span>
        <span>Won <b>${fmt(w.handsWon)}</b></span>
        <span>Blackjacks <b>${fmt(w.blackjacks)}</b></span>
        <span>Net <b class="${w.net > 0 ? "pos" : w.net < 0 ? "neg" : ""}">${signed(w.net)}</b></span>
        ${w.biggestWin > 0 ? `<span>Best round <b>+${fmt(w.biggestWin)}</b></span>` : ""}
      </div>
    </div>
    ${daily}
    <svg class="chip-stack-art" width="150" height="150" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="46" fill="none" stroke="#fff" stroke-width="8" stroke-dasharray="12 12"/>
      <circle cx="50" cy="50" r="30" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="4 4"/>
    </svg>`;
  const claim = $("#claim");
  if (claim)
    claim.onclick = async () => {
      claim.disabled = true;
      try {
        const r = await call("claimDaily");
        S.wallet = r.wallet;
        sfx.win();
        toast(`Added ${fmt(r.amount)} CP to your chips.`);
        renderWallet();
      } catch {
        claim.disabled = false;
      }
    };
}

const SEAT_DOTS = [
  [13, 44],
  [31, 64],
  [50, 71],
  [69, 64],
  [87, 44],
];

function renderTables() {
  const el = $("#tables");
  if (!el || !S.lobby) return;
  const tables = S.lobby.tables;
  if (!tables.length) {
    el.innerHTML = `<div class="empty">No tables are open. Open one and invite the family.</div>`;
    return;
  }
  el.innerHTML = tables
    .map((t) => {
      const live = !["waiting"].includes(t.phase) || t.players.length > 0;
      const full = t.players.length >= t.seats;
      const mine = S.me?.seatedAt === t.id;
      const dots = SEAT_DOTS.map(([x, y], i) => {
        const p = t.players[i];
        return `<span class="dot ${p ? "taken" : ""}" style="left:${x}%;top:${y}%">${p ? avatar(p.userId, p.name, p.avatarUrl, 18) : ""}</span>`;
      }).join("");
      const canClose = !t.isDefault && t.players.length === 0 && (t.createdBy === S.me?.userId || S.me?.isMod);
      const who = t.players.length ? t.players.map((p) => esc(p.name)).join(", ") : "Empty";
      return `<div class="table-row">
        <div class="mini-felt" aria-hidden="true">${dots}</div>
        <div style="min-width:0">
          <div class="name">${esc(t.name)}</div>
          <div class="meta">
            <span><span class="status-dot ${live ? "live" : ""}"></span>${t.players.length}/${t.seats} seated</span>
            <span>Bets ${fmt(t.minBet)}–${fmt(t.maxBet)} CP</span>
            ${t.watchers > t.players.length ? `<span>${t.watchers - t.players.length} watching</span>` : ""}
          </div>
          <div class="meta" style="margin-top:2px">${who}</div>
        </div>
        <div class="actions">
          ${canClose ? `<button class="btn ghost danger" data-close="${esc(t.id)}">Close</button>` : ""}
          ${mine ? `<button class="btn primary" data-open="${esc(t.id)}">Back to seat</button>` : `
          <button class="btn ghost" data-open="${esc(t.id)}">Watch</button>
          <button class="btn primary" data-sit="${esc(t.id)}" ${full ? "disabled" : ""}>${full ? "Full" : "Sit down"}</button>`}
        </div>
      </div>`;
    })
    .join("");
  for (const b of el.querySelectorAll("[data-open]")) b.onclick = () => openTable(b.dataset.open);
  for (const b of el.querySelectorAll("[data-sit]")) b.onclick = () => openTable(b.dataset.sit, { sit: true });
  for (const b of el.querySelectorAll("[data-close]"))
    b.onclick = async () => {
      let ok = true;
      try {
        ok = (await S.sdk.platform?.modal?.confirm?.({
          title: "Close this table?",
          message: "It will disappear from the lobby for everyone.",
          confirmLabel: "Close table",
          danger: true,
        })) ?? true;
      } catch {
        ok = true;
      }
      if (!ok) return;
      await call("closeTable", { tableId: b.dataset.close }).catch(() => {});
    };
}

function renderLeaders() {
  const el = $("#leaders");
  if (!el || !S.lobby) return;
  const rows = S.lobby.leaderboard;
  if (!rows.length) {
    el.outerHTML = `<div class="empty" id="leaders">Play a hand to get on the board.</div>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (p, i) => `<li class="${p.userId === S.me?.userId ? "me" : ""}">
        <span class="rank">${i + 1}</span>
        ${avatar(p.userId, p.name, p.avatarUrl, 24)}
        <span class="who">${esc(p.name)}</span>
        <span><span class="bal">${fmt(p.balance)}</span><span class="net ${p.net > 0 ? "pos" : p.net < 0 ? "neg" : ""}">${signed(p.net)}</span></span>
      </li>`,
    )
    .join("");
}

function renderRecent() {
  const el = $("#recent");
  if (!el || !S.lobby) return;
  const rows = S.lobby.recent;
  if (!rows.length) {
    el.outerHTML = `<div class="empty" id="recent">Your hands will show up here after your first round.</div>`;
    return;
  }
  el.innerHTML = rows
    .map((r) => {
      const d = r.payout - r.bet;
      const when = new Date(r.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `<li>
        <span class="cards-text">${cardsText(r.player_cards)} <span class="sub">(${r.player_total}) vs ${cardsText(r.dealer_cards)} (${r.dealer_total})</span></span>
        <span class="delta ${d > 0 ? "pos" : d < 0 ? "neg" : ""}">${signed(d)}</span>
        <span class="sub">${RESULT_LABEL[r.result] ?? esc(r.result)}, ${fmt(r.bet)} CP at ${esc(r.table_name)}</span>
        <span class="sub" style="text-align:right">${when}</span>
      </li>`;
    })
    .join("");
}

// ---- create table dialog -------------------------------------------------

const PRESETS = [
  { label: "Penny", min: 5, max: 100 },
  { label: "Casual", min: 10, max: 500 },
  { label: "High roller", min: 100, max: 5000 },
];

function openCreateDialog() {
  let dlg = $("#create-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "create-dialog";
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `<form method="dialog" novalidate>
      <h3>Open a table</h3>
      <label class="field">Name
        <input name="name" maxlength="32" required placeholder="Friday night" autocomplete="off" />
      </label>
      <div class="presets" role="group" aria-label="Stakes">
        ${PRESETS.map((p, i) => `<button type="button" data-p="${i}" aria-pressed="${i === 1}">${p.label} ${fmt(p.min)}–${fmt(p.max)}</button>`).join("")}
      </div>
      <div class="field-row">
        <label class="field">Minimum bet<input name="min" type="number" min="1" step="1" value="10" /></label>
        <label class="field">Maximum bet<input name="max" type="number" min="1" step="1" value="500" /></label>
      </div>
      <div class="form-error" aria-live="polite"></div>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" value="cancel">Cancel</button>
        <button type="submit" class="btn primary">Open table</button>
      </div>
    </form>`;
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".form-error");
  for (const b of dlg.querySelectorAll("[data-p]"))
    b.onclick = () => {
      const p = PRESETS[Number(b.dataset.p)];
      form.min.value = p.min;
      form.max.value = p.max;
      for (const o of dlg.querySelectorAll("[data-p]")) o.setAttribute("aria-pressed", String(o === b));
    };
  dlg.querySelector('[value="cancel"]').onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    const name = form.name.value.trim();
    const minBet = Math.floor(Number(form.min.value));
    const maxBet = Math.floor(Number(form.max.value));
    if (!name) return void (err.textContent = "Give the table a name.");
    if (!(minBet >= 1) || !(maxBet >= minBet)) return void (err.textContent = "Maximum bet must be at least the minimum.");
    try {
      const { id } = await S.sdk.request("createTable", { name, minBet, maxBet });
      dlg.close();
      await openTable(id, { sit: true });
    } catch (e2) {
      err.textContent = e2?.message || "Couldn't open the table.";
    }
  };
  dlg.showModal();
  form.name.focus();
}

// ---------------------------------------------------------------------------
// Table view
// ---------------------------------------------------------------------------

function mySeat(t = S.table) {
  if (!t || !S.me) return null;
  return t.seats.find((s) => s && s.userId === S.me.userId) ?? null;
}

async function openTable(id, { sit = false } = {}) {
  clearInterval(S.lobbyPoll);
  let res;
  try {
    res = await call("watchTable", { tableId: id });
  } catch {
    return;
  }
  S.view = "table";
  S.tableId = id;
  S.table = null;
  S.pendingBet = null;
  S.knownCards = new Set();
  S.dockSig = "";
  buildTableView(res.state);
  applyTable(res.state, { initial: true });
  clearInterval(S.heartbeat);
  S.heartbeat = setInterval(() => heartbeat(false), HEARTBEAT_MS);
  if (sit && !mySeat()) await sitDown();
}

async function heartbeat(force) {
  if (!S.tableId) return;
  try {
    const r = await call("watchTable", { tableId: S.tableId, seq: force ? -1 : S.table?.seq }, { quiet: true });
    if (r.state) applyTable(r.state);
    else syncClock(r.serverNow);
  } catch (err) {
    if (/closed/i.test(err?.message ?? "")) {
      toast("This table was closed.");
      void showLobby();
    }
  }
}

async function sitDown(seat) {
  try {
    await call("sit", { tableId: S.tableId, seat });
    sfx.chip();
  } catch {
    /* toast shown */
  }
}

async function leaveTable() {
  const seat = mySeat();
  if (seat) {
    if (S.pendingBet !== null) clearTimeout(S.betTimer);
    S.pendingBet = null;
    try {
      const r = await call("standUp", { tableId: S.tableId });
      if (r.leavingAfterRound) toast("You'll leave once this round finishes.");
    } catch {
      return;
    }
  }
  await showLobby();
}

function buildTableView(t) {
  $("#app").innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="back" aria-label="Back to lobby">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div style="min-width:0">
        <h1 id="t-name">${esc(t.name)}</h1>
      </div>
      <span class="sub" id="t-stakes"></span>
      <span class="spacer"></span>
      <span class="balance-pill">${chipHtml(100, "chip-mini")}<span data-balance>${fmt(displayBalance())}</span><span class="cp">CP</span></span>
      ${muteButton()}
      <button class="btn ghost" id="leave">Leave table</button>
    </header>
    <main class="table-view">
      <div class="stage">
        <div class="felt" id="felt">
          <svg class="felt-print" viewBox="0 0 600 190" aria-hidden="true">
            <path id="arc1" d="M 30 30 Q 300 150 570 30" class="rule" />
            <path id="arc2" d="M 70 66 Q 300 176 530 66" class="rule" />
            <path id="arc-t1" d="M 40 22 Q 300 140 560 22" fill="none" />
            <path id="arc-t2" d="M 60 58 Q 300 166 540 58" fill="none" />
            <path id="arc-t3" d="M 80 92 Q 300 196 520 92" fill="none" />
            <text font-size="22"><textPath href="#arc-t1" startOffset="50%" text-anchor="middle" id="print-bj"></textPath></text>
            <text font-size="14"><textPath href="#arc-t2" startOffset="50%" text-anchor="middle" id="print-ins">Insurance pays 2 to 1</textPath></text>
            <text font-size="15"><textPath href="#arc-t3" startOffset="50%" text-anchor="middle" id="print-dealer"></textPath></text>
          </svg>
          <div class="shoe" id="shoe"><span class="left" id="shoe-left"></span></div>
          <div class="dealer">
            <div class="hand-cards" id="dealer-cards"></div>
            <div class="who"><span>Dealer</span><span class="total hidden" id="dealer-total"></span></div>
          </div>
          <div class="notice hidden" id="notice"></div>
          <div class="seats" id="seats">
            ${[0, 1, 2, 3, 4].map((i) => `<div class="seat" data-i="${i}"></div>`).join("")}
          </div>
        </div>
        <section class="dock" id="dock" aria-live="polite"></section>
      </div>
      <aside class="side">
        <section class="panel">
          <div class="panel-head"><h2>At this table</h2><span class="hint" id="watching"></span></div>
          <ul class="standings" id="standings"></ul>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>House rules</h2></div>
          <div class="rules" id="rules"></div>
          <div class="keys">
            <span><kbd>H</kbd> Hit</span><span><kbd>S</kbd> Stand</span><span><kbd>D</kbd> Double</span>
            <span><kbd>P</kbd> Split</span><span><kbd>R</kbd> Surrender</span><span><kbd>Enter</kbd> Deal</span>
          </div>
        </section>
      </aside>
    </main>`;
  $("#back").onclick = () => leaveTable();
  $("#leave").onclick = () => leaveTable();
  wireMute();
}

/** Accept a server snapshot if it's newer than what we have. */
function applyTable(state, { initial = false } = {}) {
  if (!state || state.id !== S.tableId) return;
  if (!initial && S.table && state.seq <= S.table.seq) return;
  syncClock(state.serverNow);
  const prev = S.table;
  S.table = state;

  // A confirmed server bet replaces our local stack unless more clicks are queued.
  const seat = mySeat();
  if (S.pendingBet !== null && !S.betTimer && !S.betInFlight) S.pendingBet = null;
  if (!seat || (state.phase !== "waiting" && state.phase !== "betting")) {
    S.pendingBet = null;
    clearTimeout(S.betTimer);
    S.betTimer = null;
  }

  renderTableChrome(state);
  const fresh = renderCards(state, initial);
  renderSeats(state, prev, fresh);
  renderNotice(state);
  renderDock();
  renderSide(state);
  moments(prev, state, fresh);
}

function renderTableChrome(t) {
  $("#t-name").textContent = t.name;
  $("#t-stakes").textContent = `Bets ${fmt(t.minBet)}–${fmt(t.maxBet)} CP`;
  $("#print-bj").textContent = `Blackjack pays ${t.rules.blackjackPayout.replace(":", " to ")}`;
  $("#print-dealer").textContent = t.rules.hitSoft17 ? "Dealer hits soft 17" : "Dealer stands on all 17s";
  const pct = Math.min(100, Math.round((t.shoe.remaining / t.shoe.size) * 100));
  $("#shoe-left").textContent = `${pct}% left`;
  $("#shoe").title = `${t.rules.decks}-deck shoe, ${t.shoe.remaining} cards left`;
}

// ---- cards -----------------------------------------------------------------

function cardEl(c) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.id = c.id;
  el.innerHTML = `<div class="inner"><div class="face"></div><div class="back"></div></div>`;
  if (c.hidden) el.classList.add("down");
  else paintFace(el, c);
  return el;
}

function paintFace(el, c) {
  const red = c.s === "H" || c.s === "D";
  el.classList.toggle("red", red);
  const court = c.r === "J" || c.r === "Q" || c.r === "K";
  const s = SUIT[c.s];
  el.querySelector(".face").innerHTML = `
    <span class="idx"><span>${c.r}</span><span class="s">${s}</span></span>
    <span class="pip ${court ? "court" : ""}">${court ? `<span>${c.r}</span>` : s}</span>
    <span class="idx flip"><span>${c.r}</span><span class="s">${s}</span></span>`;
  el.setAttribute("aria-label", `${c.r} of ${{ S: "spades", H: "hearts", D: "diamonds", C: "clubs" }[c.s]}`);
}

/**
 * Reconcile one card row. New cards are queued so they can be animated from
 * the shoe in deal order; a hidden card that becomes visible flips over.
 */
function syncCards(container, cards, fresh) {
  const existing = new Map();
  for (const el of container.children) if (!el.classList.contains("leaving")) existing.set(el.dataset.id, el);
  const wanted = new Set(cards.map((c) => String(c.id)));
  for (const [id, el] of existing) {
    if (wanted.has(id)) continue;
    // Moved to a split hand: vanish quietly; otherwise sweep it off the felt.
    if (fresh.allIds.has(id)) el.remove();
    else sweep(el);
  }
  for (const c of cards) {
    let el = existing.get(String(c.id));
    if (!el) {
      el = cardEl(c);
      container.appendChild(el);
      if (!S.knownCards.has(c.id)) fresh.cards.push({ el, id: c.id });
    } else if (el.classList.contains("down") && !c.hidden) {
      paintFace(el, c);
      requestAnimationFrame(() => el.classList.remove("down"));
      fresh.flips++;
    }
    S.knownCards.add(c.id);
  }
}

function sweep(el) {
  const r = el.getBoundingClientRect();
  el.style.setProperty("--sx", `${-r.left - 80}px`);
  el.style.setProperty("--sy", `${-r.top - 60}px`);
  el.classList.add("leaving");
  setTimeout(() => el.remove(), 420);
}

function renderCards(t, initial) {
  const fresh = { cards: [], flips: 0, allIds: new Set() };
  for (const c of t.dealer.cards) fresh.allIds.add(String(c.id));
  for (const s of t.seats) if (s) for (const h of s.hands) for (const c of h.cards) fresh.allIds.add(String(c.id));

  syncCards($("#dealer-cards"), t.dealer.cards, fresh);

  const dt = $("#dealer-total");
  if (t.dealer.total !== null && t.dealer.cards.length) {
    dt.classList.remove("hidden");
    dt.textContent = t.dealer.blackjack ? "BJ" : t.dealer.soft ? `${t.dealer.total - 10}/${t.dealer.total}` : t.dealer.total;
    dt.classList.toggle("bust", t.dealer.bust);
    dt.classList.toggle("bj", t.dealer.blackjack);
  } else dt.classList.add("hidden");

  fresh.initial = initial;
  return fresh;
}

/** Fly queued cards in from the shoe, staggered in deal order. */
function animateDeals(fresh) {
  if (!fresh.cards.length) return;
  if (fresh.initial) return; // opening a table mid-round: no replay
  const shoe = $("#shoe").getBoundingClientRect();
  const ordered = fresh.cards.sort((a, b) => a.id - b.id);
  ordered.forEach(({ el }, i) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty("--fx", `${shoe.left + shoe.width / 2 - (r.left + r.width / 2)}px`);
    el.style.setProperty("--fy", `${shoe.top + shoe.height / 2 - (r.top + r.height / 2)}px`);
    el.style.animationDelay = `${i * DEAL_STAGGER}ms`;
    el.classList.add("deal");
    sfx.card((i * DEAL_STAGGER) / 1000);
  });
}

// ---- seats -----------------------------------------------------------------

function renderSeats(t, prev, fresh) {
  const me = mySeat(t);
  const seatsEl = $("#seats");
  t.seats.forEach((seat, i) => {
    const el = seatsEl.children[i];
    const owner = seat ? seat.userId : "";
    if (el.dataset.owner !== owner) {
      el.dataset.owner = owner;
      el.className = `seat ${seat ? "" : "empty-seat"}`;
      el.innerHTML = seat
        ? `<div class="hands"></div>
           <div class="spot"><div class="stack"></div><span class="amt"></span></div>
           <div class="seat-plate ${seat.userId === S.me?.userId ? "me" : ""}">
             <span class="av">${avatar(seat.userId, seat.name, seat.avatarUrl, 26)}</span>
             <span class="nm">${esc(seat.name)}</span><span class="tag"></span>
           </div>`
        : `<button class="sit" data-seat="${i}">Sit here</button>
           <div class="seat-plate placeholder" aria-hidden="true"><span class="av"></span><span class="nm">&nbsp;</span></div>`;
      const btn = el.querySelector(".sit");
      if (btn) btn.onclick = () => sitDown(i);
      const plate = el.querySelector(".seat-plate");
      if (plate && S.sdk?.platform?.userCard?.show) {
        plate.style.cursor = "pointer";
        plate.onclick = () => S.sdk.platform.userCard.show({ userId: seat.userId, displayName: seat.name, avatarUrl: seat.avatarUrl });
      }
    }
    if (!seat) {
      const btn = el.querySelector(".sit");
      btn.disabled = !!me;
      el.classList.toggle("can-sit", !me);
      btn.textContent = me ? "Open" : "Sit here";
      return;
    }
    patchSeat(el, seat, t, fresh, prev);
  });
  animateDeals(fresh);
}

function patchSeat(el, seat, t, fresh, prev) {
  const isMe = seat.userId === S.me?.userId;
  // Bet spot: during betting show the (pending) bet; during play the wagers on the felt.
  const betting = t.phase === "waiting" || t.phase === "betting";
  const amt = betting ? (isMe && S.pendingBet !== null ? S.pendingBet : seat.bet) : seat.hands.reduce((a, h) => a + h.bet, 0) + seat.insurance;
  const spot = el.querySelector(".spot");
  if (spot.dataset.amt !== String(amt)) {
    const grew = amt > Number(spot.dataset.amt || 0);
    spot.dataset.amt = String(amt);
    spot.classList.toggle("has-bet", amt > 0);
    spot.querySelector(".stack").innerHTML = breakdown(amt)
      .map((v, k) => `<span class="chip" data-v="${v}" style="transform:translateY(${-k * 3}px);animation-delay:${grew ? 0 : -1}s"></span>`)
      .join("");
    spot.querySelector(".amt").textContent = amt > 0 ? fmt(amt) : "";
  }

  // Name plate: status tag + turn ring.
  const tag = el.querySelector(".tag");
  let tagText = "";
  if (seat.leaving) tagText = "leaving";
  else if (betting && seat.ready && seat.bet > 0) tagText = "ready";
  else if (betting && t.phase === "betting" && seat.bet === 0) tagText = "betting…";
  else if (!betting && !seat.inRound && t.phase !== "settled") tagText = "next round";
  else if (t.phase === "insurance" && seat.inRound && !seat.insuranceDecided) tagText = "deciding…";
  tag.textContent = tagText;

  const av = el.querySelector(".av");
  const turnHere = t.turn && t.turn.seat === seat.index && t.deadline;
  const ringKey = turnHere ? String(t.deadline) : "";
  if (av.dataset.ring !== ringKey) {
    av.dataset.ring = ringKey;
    av.querySelector("svg.ring")?.remove();
    if (turnHere) {
      const total = t.rules.turnSeconds * 1000;
      const left = Math.max(0, t.deadline - serverNow());
      av.insertAdjacentHTML(
        "beforeend",
        `<svg class="ring" viewBox="0 0 34 34"><circle cx="17" cy="17" r="15.5" pathLength="100"
          style="animation-duration:${total}ms;animation-delay:${left - total}ms"/></svg>`,
      );
    }
  }

  // Hands, keyed by hand id.
  const handsEl = el.querySelector(".hands");
  handsEl.classList.toggle("multi", seat.hands.length > 1);
  const byId = new Map([...handsEl.children].map((h) => [h.dataset.hid, h]));
  const keep = new Set(seat.hands.map((h) => String(h.id)));
  for (const [id, hEl] of byId) {
    if (keep.has(id) || hEl.classList.contains("gone")) continue;
    hEl.classList.add("gone");
    for (const c of hEl.querySelectorAll(".card")) {
      if (fresh.allIds.has(c.dataset.id)) c.remove();
      else sweep(c);
    }
    hEl.querySelector(".total")?.remove();
    hEl.querySelector(".result-tag")?.remove();
    setTimeout(() => hEl.remove(), 430);
  }
  seat.hands.forEach((h, hi) => {
    let hEl = byId.get(String(h.id));
    if (!hEl || hEl.classList.contains("gone")) {
      hEl = document.createElement("div");
      hEl.className = "hand";
      hEl.dataset.hid = h.id;
      hEl.innerHTML = `<span class="total"></span><div class="hand-cards"></div>`;
      // Keep split order: insert at the right index.
      const live = [...handsEl.children].filter((x) => !x.classList.contains("gone"));
      handsEl.insertBefore(hEl, live[hi] ?? null);
    }
    syncCards(hEl.querySelector(".hand-cards"), h.cards, fresh);
    const total = hEl.querySelector(".total");
    total.textContent = h.blackjack ? "BJ" : h.soft ? `${h.total - 10}/${h.total}` : String(h.total);
    total.classList.toggle("bust", h.bust);
    total.classList.toggle("bj", h.blackjack);
    total.classList.toggle("hidden", h.cards.length === 0);
    const active = t.phase === "playing" && t.turn?.seat === seat.index && t.turn?.hand === hi;
    hEl.classList.toggle("active", !!active);
    hEl.className = hEl.className.replace(/\bdone-\w+/g, "").trim() + (h.result ? ` done-${h.result}` : "");
    let tagEl = hEl.querySelector(".result-tag");
    const label = h.result ? RESULT_LABEL[h.result] : h.surrendered ? RESULT_LABEL.surrender : h.bust ? RESULT_LABEL.bust : "";
    const cls = h.result || (h.surrendered ? "surrender" : h.bust ? "bust" : "");
    if (label && (!tagEl || tagEl.dataset.k !== label)) {
      tagEl?.remove();
      hEl.insertAdjacentHTML("beforeend", `<span class="result-tag ${cls}" data-k="${label}">${label}${h.doubled && h.result ? " ×2" : ""}</span>`);
    } else if (!label && tagEl) tagEl.remove();
  });

  // Round result float.
  if (seat.delta === null) el.querySelector(".delta")?.remove();
  const prevSeat = prev?.seats?.[seat.index];
  if (seat.delta !== null && t.phase === "settled" && (prev?.phase !== "settled" || prevSeat?.delta === null)) {
    el.querySelector(".delta")?.remove();
    const d = seat.delta;
    el.insertAdjacentHTML(
      "afterbegin",
      `<span class="delta ${d > 0 ? "pos" : d < 0 ? "neg" : "zero"}">${d === 0 ? (seat.hands.every((h) => h.result === "push") ? "Push" : "Even") : `${signed(d)} CP`}</span>`,
    );
  }
}

// ---- notice, dock, side ----------------------------------------------------

function renderNotice(t) {
  const el = $("#notice");
  let html = "";
  let key = "";
  if (t.phase === "betting" && t.deadline) {
    html = `Bets close in <span class="count" data-deadline="${t.deadline}">${secondsLeft(t.deadline)}</span>`;
    key = "betting";
  } else if (t.phase === "waiting") {
    html = t.seats.some(Boolean) ? "Place your bets" : "Take a seat to play";
    key = html;
  } else if (t.phase === "insurance") {
    html = `${esc(t.notice ?? "Insurance?")} <span class="count" data-deadline="${t.deadline}">${secondsLeft(t.deadline)}</span>`;
    key = "ins";
  } else if (t.notice) {
    html = esc(t.notice);
    key = `${t.roundId}:${t.notice}`;
  }
  if (!html) {
    el.classList.add("hidden");
    S.noticeKey = "";
    return;
  }
  if (S.noticeKey !== key) {
    S.noticeKey = key;
    el.classList.remove("hidden");
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "";
    // One-shot server notices fade after a moment; timers stay up.
    clearTimeout(S.noticeTimer);
    if (t.notice && t.phase !== "insurance" && t.phase !== "betting" && t.phase !== "waiting") {
      S.noticeTimer = setTimeout(() => el.classList.add("hidden"), 2600);
    }
  }
  el.innerHTML = html;
}

function dockSignature(t) {
  const seat = mySeat(t);
  return JSON.stringify([
    t.phase,
    t.deadline,
    t.turn,
    seat && [seat.bet, seat.ready, seat.inRound, seat.insuranceDecided, seat.leaving, seat.lastBet, seat.hands.length],
    S.pendingBet,
    S.wallet?.balance,
    t.results?.length,
    t.seats.filter(Boolean).length,
  ]);
}

function renderDock(force = false) {
  const t = S.table;
  const dock = $("#dock");
  if (!t || !dock) return;
  const sig = dockSignature(t);
  if (!force && sig === S.dockSig) return;
  S.dockSig = sig;
  const seat = mySeat(t);
  dock.classList.remove("your-turn");

  // Spectating.
  if (!seat) {
    const free = t.seats.some((s) => !s);
    dock.innerHTML = `<div class="msg">${free ? "You're watching. Take a seat to play." : "The table is full. You're watching until a seat opens."}</div>
      ${free ? `<div class="line"><button class="btn primary" id="d-sit">Sit down</button></div>` : ""}`;
    $("#d-sit")?.addEventListener("click", () => sitDown());
    return;
  }

  // Betting.
  if (t.phase === "waiting" || t.phase === "betting") {
    const bet = S.pendingBet ?? seat.bet;
    const room = (S.wallet?.balance ?? 0) + seat.bet - bet; // CP still in hand
    const under = bet > 0 && bet < t.minBet;
    const rebet = seat.lastBet;
    const canRebet = rebet >= t.minBet && rebet <= t.maxBet && rebet <= (S.wallet?.balance ?? 0) + seat.bet;
    const canDouble = rebet * 2 >= t.minBet && rebet * 2 <= t.maxBet && rebet * 2 <= (S.wallet?.balance ?? 0) + seat.bet;
    const broke = (S.wallet?.balance ?? 0) + seat.bet < t.minBet;
    dock.innerHTML = `
      <div class="line chips">
        ${CHIPS.map((v) => `<button class="chip" data-v="${v}" data-chip="${v}" ${v > room || bet + v > t.maxBet ? "disabled" : ""} aria-label="Add ${v} CP"><span>${v >= 1000 ? "1k" : v}</span></button>`).join("")}
      </div>
      <div class="line">
        <button class="btn ghost" id="d-clear" ${bet > 0 ? "" : "disabled"}>Clear</button>
        ${rebet > 0 && bet === 0 ? `<button class="btn" id="d-rebet" ${canRebet ? "" : "disabled"}>Rebet ${fmt(rebet)}</button>
        <button class="btn" id="d-rebet2" ${canDouble ? "" : "disabled"}>2× ${fmt(rebet * 2)}</button>` : ""}
        <div class="bet-readout">${bet > 0 ? `${fmt(bet)} CP` : "No bet"}<small>${under ? `Minimum ${fmt(t.minBet)} CP` : seat.ready && bet > 0 ? "You're in. Waiting for others." : `Bets ${fmt(t.minBet)}–${fmt(t.maxBet)}`}</small></div>
        <button class="btn primary" id="d-deal" ${bet >= t.minBet && !seat.ready ? "" : "disabled"}>Deal <kbd>Enter</kbd></button>
      </div>
      ${broke ? `<div class="msg">You're out of chips for this table. Claim your daily bonus in the lobby, or try a table with a smaller minimum.</div>` : ""}`;
    for (const b of dock.querySelectorAll("[data-chip]")) b.onclick = () => addChip(Number(b.dataset.chip));
    $("#d-clear").onclick = () => placeBet(0, false);
    $("#d-deal").onclick = () => deal();
    $("#d-rebet")?.addEventListener("click", () => placeBet(rebet, true));
    $("#d-rebet2")?.addEventListener("click", () => placeBet(rebet * 2, true));
    return;
  }

  if (!seat.inRound) {
    dock.innerHTML = `<div class="msg">You're in for the next round. Bets open when this hand finishes.</div>`;
    return;
  }

  if (t.phase === "insurance") {
    if (seat.insuranceDecided) {
      dock.innerHTML = `<div class="msg">${seat.insurance > 0 ? `Insured for ${fmt(seat.insurance)} CP.` : "No insurance."} Waiting for the others…</div>`;
      return;
    }
    const cost = Math.floor((seat.hands[0]?.bet ?? 0) / 2);
    const afford = cost >= 1 && cost <= (S.wallet?.balance ?? 0);
    dock.classList.add("your-turn");
    dock.innerHTML = `<div class="msg">The dealer shows an Ace. Insurance costs <strong>${fmt(cost)} CP</strong> and pays 2 to 1 if the dealer has blackjack.</div>
      <div class="line">
        <button class="btn" id="d-noins">No thanks</button>
        <button class="btn primary" id="d-ins" ${afford ? "" : "disabled"}>Insure for ${fmt(cost)} CP</button>
      </div>`;
    $("#d-noins").onclick = () => call("insurance", { tableId: t.id, take: false }).catch(() => {});
    $("#d-ins").onclick = () => call("insurance", { tableId: t.id, take: true }).then(sfx.chip).catch(() => {});
    return;
  }

  if (t.phase === "playing" && t.turn) {
    if (t.turn.userId === S.me.userId) {
      const hand = seat.hands[t.turn.hand];
      const bal = S.wallet?.balance ?? 0;
      const extra = t.turn.extraCost;
      dock.classList.add("your-turn");
      dock.innerHTML = `
        <div class="msg"><strong>Your move</strong>${seat.hands.length > 1 ? ` on hand ${t.turn.hand + 1} of ${seat.hands.length}` : ""}: ${hand.soft ? `soft ${hand.total}` : hand.total}
          against the dealer's ${t.dealer.total}. <span class="count" data-deadline="${t.deadline}">${secondsLeft(t.deadline)}</span>s</div>
        <div class="line">
          <button class="btn act hit" data-act="hit">Hit <kbd>H</kbd></button>
          <button class="btn act stand" data-act="stand">Stand <kbd>S</kbd></button>
          <button class="btn act" data-act="double" ${t.turn.canDouble && extra <= bal ? "" : "disabled"}>Double <kbd>D</kbd></button>
          <button class="btn act" data-act="split" ${t.turn.canSplit && extra <= bal ? "" : "disabled"}>Split <kbd>P</kbd></button>
          <button class="btn act ghost" data-act="surrender" ${t.turn.canSurrender ? "" : "disabled"}>Surrender <kbd>R</kbd></button>
        </div>`;
      for (const b of dock.querySelectorAll("[data-act]")) b.onclick = () => act(b.dataset.act);
      return;
    }
    const other = t.seats[t.turn.seat];
    dock.innerHTML = `<div class="msg">${esc(other?.name ?? "Someone")} is playing… <span class="count" data-deadline="${t.deadline}">${secondsLeft(t.deadline)}</span>s</div>`;
    return;
  }

  if (t.phase === "settled") {
    const d = seat.delta ?? 0;
    dock.innerHTML = `<div class="msg">${d > 0 ? `<strong class="pos">You won ${fmt(d)} CP.</strong>` : d < 0 ? `<strong class="neg">You lost ${fmt(-d)} CP.</strong>` : seat.hands.every((h) => h.result === "push") ? "<strong>Push. Your bet comes back.</strong>" : "<strong>You broke even.</strong>"}
      Next round in <span class="count" data-deadline="${t.deadline}">${secondsLeft(t.deadline)}</span>s</div>`;
    return;
  }

  dock.innerHTML = `<div class="msg">${t.phase === "dealer" ? "Dealer's turn…" : "Dealing…"}</div>`;
}

function renderSide(t) {
  $("#watching").textContent = t.watchers > 1 ? `${t.watchers} here` : "";
  const st = $("#standings");
  const seated = new Set(t.seats.filter(Boolean).map((s) => s.userId));
  st.innerHTML = t.standings.length
    ? t.standings
        .map(
          (s) => `<li><span class="n">${esc(s.name)}<small>${s.hands} hand${s.hands === 1 ? "" : "s"}${seated.has(s.userId) ? "" : ", left"}</small></span>
            <b class="${s.net > 0 ? "pos" : s.net < 0 ? "neg" : ""}">${signed(s.net)}</b></li>`,
        )
        .join("")
    : `<li><span class="n" style="color:var(--muted)">Results from this table show up here.</span></li>`;
  $("#rules").innerHTML = `
    <div><span>Blackjack pays</span><b>${t.rules.blackjackPayout.replace(":", " to ")}</b></div>
    <div><span>Dealer</span><b>${t.rules.hitSoft17 ? "Hits soft 17" : "Stands on 17"}</b></div>
    <div><span>Shoe</span><b>${t.rules.decks} deck${t.rules.decks === 1 ? "" : "s"}</b></div>
    <div><span>Double</span><b>Any two cards</b></div>
    <div><span>Split</span><b>Up to 4 hands</b></div>
    <div><span>Surrender</span><b>Late</b></div>
    <div><span>Turn timer</span><b>${t.rules.turnSeconds}s</b></div>`;
}

// ---- moments: sounds, bursts, confetti --------------------------------------

function moments(prev, t, fresh) {
  if (fresh.flips) sfx.flip();
  const me = S.me?.userId;
  // Your turn just started.
  if (t.phase === "playing" && t.turn?.userId === me && (prev?.turn?.userId !== me || prev?.phase !== "playing")) {
    setTimeout(sfx.turn, 120);
  }
  if (t.phase === "settled" && prev && prev.phase !== "settled") {
    const seat = mySeat(t);
    if (!seat || seat.delta === null) return;
    const bj = seat.hands.some((h) => h.result === "blackjack");
    if (bj) {
      sfx.blackjack();
      burst("Blackjack!");
      confetti();
    } else if (seat.delta > 0) {
      sfx.win();
      if (seat.delta >= 4 * (seat.hands[0]?.bet ?? Infinity) || seat.hands.length > 1) burst(`+${fmt(seat.delta)} CP`);
    } else if (seat.delta < 0) sfx.lose();
  }
}

function burst(text) {
  const felt = $("#felt");
  if (!felt) return;
  const el = document.createElement("div");
  el.className = "burst";
  el.textContent = text;
  felt.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

function confetti() {
  const felt = $("#felt");
  if (!felt || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const box = document.createElement("div");
  box.className = "confetti";
  const colors = ["#d9bc72", "#f4ecd6", "#c8323c", "#1f8a4c", "#6a3fa0"];
  for (let i = 0; i < 70; i++) {
    const p = document.createElement("i");
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty("--dx", `${(Math.random() - 0.5) * 160}px`);
    p.style.setProperty("--rot", `${(Math.random() - 0.5) * 900}deg`);
    p.style.animationDuration = `${1.6 + Math.random() * 1.4}s`;
    p.style.animationDelay = `${Math.random() * 0.35}s`;
    box.appendChild(p);
  }
  felt.appendChild(box);
  setTimeout(() => box.remove(), 3600);
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

function addChip(v) {
  const t = S.table;
  const seat = mySeat();
  if (!t || !seat) return;
  const current = S.pendingBet ?? seat.bet;
  const next = Math.min(t.maxBet, current + v);
  const affordable = (S.wallet?.balance ?? 0) + seat.bet;
  if (next > affordable) {
    toast("Not enough CP for that chip.", "warning");
    return;
  }
  S.pendingBet = next;
  sfx.chip();
  refreshBetDisplay();
  // Batch rapid chip clicks into one request.
  clearTimeout(S.betTimer);
  S.betTimer = setTimeout(() => {
    S.betTimer = null;
    if (S.pendingBet !== null && S.pendingBet >= t.minBet) void placeBet(S.pendingBet, false);
  }, 380);
}

function refreshBetDisplay() {
  for (const el of document.querySelectorAll("[data-balance]")) el.textContent = fmt(displayBalance());
  if (S.table) {
    const seat = mySeat();
    if (seat) patchSeat($("#seats").children[seat.index], seat, S.table, { cards: [], flips: 0, allIds: new Set() }, S.table);
  }
  renderDock();
}

async function placeBet(amount, ready) {
  const t = S.table;
  if (!t) return;
  clearTimeout(S.betTimer);
  S.betTimer = null;
  S.pendingBet = amount;
  refreshBetDisplay();
  const run = call("setBet", { tableId: t.id, amount, ready });
  S.betInFlight = run;
  try {
    await run;
    if (amount > 0) sfx.chip();
  } catch {
    S.pendingBet = null; // fall back to the server's number
  } finally {
    if (S.betInFlight === run) S.betInFlight = null;
    if (!S.betTimer && !S.betInFlight) S.pendingBet = null;
    refreshBetDisplay();
  }
}

async function deal() {
  const t = S.table;
  const seat = mySeat();
  if (!t || !seat || (t.phase !== "waiting" && t.phase !== "betting")) return;
  const want = S.pendingBet ?? seat.bet;
  if (want < t.minBet) return;
  if (want !== seat.bet || S.betTimer) await placeBet(want, true);
  else await call("ready", { tableId: t.id }).catch(() => {});
}

let acting = false;
async function act(action) {
  const t = S.table;
  if (!t?.turn || t.turn.userId !== S.me?.userId || acting) return;
  const hand = mySeat()?.hands[t.turn.hand];
  acting = true;
  for (const b of document.querySelectorAll("[data-act]")) b.disabled = true;
  try {
    await call("act", { tableId: t.id, action, handId: hand?.id });
    if (action === "double" || action === "split") sfx.chip();
  } catch {
    S.dockSig = "";
    renderDock();
  } finally {
    acting = false;
  }
}

function onKey(e) {
  if (e.target.closest?.("input, textarea, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = S.table;
  if (S.view !== "table" || !t) return;
  const k = e.key.toLowerCase();
  if (t.phase === "playing" && t.turn?.userId === S.me?.userId) {
    const map = { h: "hit", s: "stand", d: "double", p: "split", r: "surrender" };
    if (map[k]) {
      const btn = $(`[data-act="${map[k]}"]`);
      if (btn && !btn.disabled) {
        e.preventDefault();
        void act(map[k]);
      }
    }
  } else if ((t.phase === "waiting" || t.phase === "betting") && k === "enter") {
    e.preventDefault();
    void deal();
  }
}

// ---------------------------------------------------------------------------
// Mute, ticker
// ---------------------------------------------------------------------------

function muteButton() {
  return `<button class="icon-btn" id="mute" aria-label="${S.muted ? "Turn sound on" : "Turn sound off"}" title="${S.muted ? "Sound off" : "Sound on"}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z"/>${S.muted ? '<path d="M23 9l-6 6M17 9l6 6"/>' : '<path d="M15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14"/>'}
    </svg></button>`;
}

function wireMute() {
  const b = $("#mute");
  if (!b) return;
  b.onclick = () => {
    S.muted = !S.muted;
    savePref("bj.muted", S.muted);
    b.outerHTML = muteButton();
    wireMute();
    if (!S.muted) sfx.chip();
  };
}

/** One 4 Hz ticker for every countdown on screen. */
function tick() {
  for (const el of document.querySelectorAll("[data-deadline]")) {
    const s = String(secondsLeft(Number(el.dataset.deadline)));
    if (el.textContent !== s) el.textContent = s;
  }
  for (const el of document.querySelectorAll("[data-until]")) {
    const until = Number(el.dataset.until);
    const ms = until - serverNow();
    const txt = ms <= 0 ? "Daily bonus ready" : `Next bonus in ${duration(ms)}`;
    if (el.textContent !== txt) {
      el.textContent = txt;
      if (ms <= 0) {
        const b = $("#claim");
        if (b) b.disabled = false;
      }
    }
  }
}

boot();
