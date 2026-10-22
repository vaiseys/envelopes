'use strict';

// ---------- Data model ----------
// All money is stored as integer cents.
// A transaction moves money between envelopes ("lines") and, optionally, an account:
//   expense:  account -X, envelope -X
//   income:   account +X, envelope +X (usually [Available])
//   transfer: envelope A -X, envelope B +X   (no account)
//   fill:     [Available] -total, each envelope +amount
// Balances are always computed from the transaction list, which makes syncing simple later.

const STORE_KEY = 'envelopes-app-v1';
const AVAILABLE = 'available';
const GROUPS = [
  { id: 'monthly', label: 'Monthly', amountLabel: 'Monthly budget' },
  { id: 'goal', label: 'Goal', amountLabel: 'Goal target' },
  { id: 'available', label: 'Available' },
];

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
};

// ---------- Utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowISO = () => new Date().toISOString();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (cents) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtSigned = (cents) => (cents > 0 ? '+' : '') + fmt(cents);
const toInput = (cents) => (cents ? (cents / 100).toFixed(2) : '');
const toCents = (str) => {
  const n = parseFloat(String(str ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayISO = () => isoDate(new Date());
const parseDate = (iso) => new Date(iso + 'T00:00:00');

function fmtDate(iso) {
  const d = parseDate(iso);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  if (iso === todayISO()) return 'Today';
  return d.toLocaleDateString('en-US', opts);
}
const fmtShortDate = (iso) => parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function monthProgress() {
  const now = new Date();
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (now.getDate() - 1 + now.getHours() / 24) / days;
}

// ---------- Transaction builders ----------
const T = {
  expense: ({ date, payee, env, account, amount, note = '' }) =>
    ({ kind: 'expense', date, payee, note, account, accountAmt: -amount, lines: [{ env, amt: -amount }] }),
  income: ({ date, payee, env = AVAILABLE, account, amount, note = '' }) =>
    ({ kind: 'income', date, payee, note, account, accountAmt: amount, lines: [{ env, amt: amount }] }),
  transfer: ({ date, from, to, amount, note = '' }) =>
    ({ kind: 'transfer', date, payee: '', note, account: null, accountAmt: 0, lines: [{ env: from, amt: -amount }, { env: to, amt: amount }] }),
  fill: ({ date, allocations, note = '' }) => {
    const total = allocations.reduce((s, [, amt]) => s + amt, 0);
    return {
      kind: 'fill', date, payee: '', note, account: null, accountAmt: 0,
      lines: [{ env: AVAILABLE, amt: -total }, ...allocations.map(([env, amt]) => ({ env, amt }))],
    };
  },
};
const stamp = (t) => ({ id: uid(), ...t, createdAt: nowISO(), updatedAt: nowISO() });

// ---------- Demo data ----------
function seed() {
  const env = (name, group, amount) => ({ id: uid(), name, group, amount, updatedAt: nowISO() });
  const envelopes = [
    env('Discretionary', 'monthly', 80000),
    env('Health', 'monthly', 30000),
    env('Auto', 'monthly', 20000),
    env('Reserve', 'monthly', 100000),
    env('Reimbursement', 'goal', 0),
    env('Music', 'goal', 250000),
    env('Kid Event', 'goal', 250000),
    env('Vacation', 'goal', 250000),
    { id: AVAILABLE, name: '[Available]', group: 'available', amount: 0, updatedAt: nowISO() },
  ];
  const E = Object.fromEntries(envelopes.map((e) => [e.name, e.id]));
  const accounts = [
    { id: uid(), name: 'Checking', updatedAt: nowISO() },
    { id: uid(), name: 'Credit Card', updatedAt: nowISO() },
  ];
  const [chk, cc] = accounts.map((a) => a.id);
  const monthly = envelopes.filter((e) => e.group === 'monthly').map((e) => [e.id, e.amount]);

  const sample = [
    [2, "Trader Joe's", 'Discretionary', 8743, cc],
    [3, 'Shell', 'Auto', 4520, cc],
    [5, 'CVS Pharmacy', 'Health', 2318, cc],
    [6, 'Netflix', 'Discretionary', 1549, cc],
    [8, 'Chipotle', 'Discretionary', 2387, cc],
    [10, 'Dr. Patel copay', 'Health', 4000, chk],
    [12, 'Target', 'Discretionary', 6412, cc],
    [14, 'Car wash', 'Auto', 1500, cc],
    [15, 'Costco', 'Discretionary', 14328, cc],
    [16, 'Guitar strings', 'Music', 2499, cc],
    [19, 'Dinner out', 'Discretionary', 7856, cc],
    [21, 'Oil change', 'Auto', 6995, chk],
  ];

  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const txns = [];
  const addFunded = (payee, allocations) => {
    const total = allocations.reduce((s, [, a]) => s + a, 0);
    txns.push(stamp(T.income({ date: isoDate(new Date(y, m, 1)), payee, account: chk, amount: total })));
    txns.push(stamp(T.fill({ date: isoDate(new Date(y, m, 1)), allocations })));
  };
  addFunded('Starting balance', [[E['Kid Event'], 250000], [E.Vacation, 120000], [E.Music, 40000]]);
  addFunded('Paycheck', monthly);
  sample.forEach(([day, payee, envName, amount, account]) => {
    const d = new Date(y, m, day);
    if (d <= now) txns.push(stamp(T.expense({ date: isoDate(d), payee, env: E[envName], account, amount })));
  });

  return { version: 1, envelopes, accounts, txns, settings: { lastAccount: cc }, demo: true };
}

// ---------- State ----------
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('Could not save on this device');
  }
}

let state = load() || seed();
const ui = { tab: 'envelopes' };

const liveTxns = () => state.txns.filter((t) => !t.deleted);
const sortedTxns = () =>
  liveTxns().sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)));
const activeEnvelopes = () => state.envelopes.filter((e) => !e.archived);
const activeAccounts = () => state.accounts.filter((a) => !a.archived);
const envById = (id) => state.envelopes.find((e) => e.id === id);
const acctById = (id) => state.accounts.find((a) => a.id === id);
const txnById = (id) => state.txns.find((t) => t.id === id);
const envName = (id) => envById(id)?.name ?? 'Unknown';
const acctName = (id) => acctById(id)?.name ?? '';

function computeBalances() {
  const env = {}, acct = {};
  for (const t of liveTxns()) {
    for (const l of t.lines) env[l.env] = (env[l.env] || 0) + l.amt;
    if (t.account) acct[t.account] = (acct[t.account] || 0) + t.accountAmt;
  }
  return { env, acct };
}

function commit() {
  save();
  render();
  scheduleSync();
}

// ---------- Google Sheets sync ----------
// The phone is the source of truth for speed and offline use. Every sync pushes records changed
// since the last sync and gets back the sheet's full copy; for each record the newest
// `updatedAt` wins. Sync settings live in their own key so resetting the budget keeps them.
const SYNC_KEY = 'envelopes-sync-v1';
const COLLS = ['envelopes', 'accounts', 'txns'];
let syncCfg = (() => {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch { return {}; }
})();
let syncing = false, syncAgain = false, syncTimer;

function saveSyncCfg() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg)); } catch {}
}
function newSyncKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
}
function scheduleSync(delay = 1500) {
  if (!syncCfg.url) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), delay);
}

async function callSync(push) {
  let res;
  try {
    res = await fetch(syncCfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // plain text avoids a CORS preflight, which Apps Script can't answer
      body: JSON.stringify({ key: syncCfg.key, push }),
    });
  } catch {
    throw new Error(navigator.onLine ? 'Could not reach the sheet. Check the script URL, and that access is set to "Anyone".' : 'Offline. Will sync when you are back online.');
  }
  let body;
  try { body = await res.json(); } catch { throw new Error('The script URL did not reply as expected. Make sure it ends in /exec.'); }
  if (!body.ok) throw new Error(body.error || 'Sync failed.');
  return body.data;
}

function mergeRemote(data) {
  for (const coll of COLLS) {
    const byId = new Map(state[coll].map((r) => [r.id, r]));
    for (const r of data[coll] || []) {
      const mine = byId.get(r.id);
      if (!mine || r.updatedAt > mine.updatedAt) byId.set(r.id, r);
    }
    state[coll] = [...byId.values()];
  }
}

async function syncNow({ manual = false } = {}) {
  if (!syncCfg.url) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  render();
  const started = nowISO();
  try {
    const first = !syncCfg.lastSync;
    // A brand-new, empty device joins an existing sheet by taking its copy, so it doesn't add a duplicate "Checking" account.
    if (first && !state.txns.length) {
      const remote = await callSync({});
      if (remote.txns.length || remote.accounts.length || remote.envelopes.length > 1) {
        state.envelopes = remote.envelopes.some((e) => e.id === AVAILABLE) ? remote.envelopes : [...remote.envelopes, freshState().envelopes[0]];
        state.accounts = remote.accounts;
        state.txns = remote.txns;
        state.demo = false;
      }
    }
    const push = Object.fromEntries(COLLS.map((c) => [c, state[c].filter((r) => first || r.updatedAt > syncCfg.lastSync)]));
    mergeRemote(await callSync(push));
    syncCfg.lastSync = started;
    // Match the sheet's 30-day cleanup: forget deleted transactions that are old and already synced.
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
    state.txns = state.txns.filter((t) => !(t.deleted && t.updatedAt < cutoff));
    syncCfg.error = null;
    if (manual) toast('Synced with Google Sheets');
  } catch (err) {
    syncCfg.error = err.message;
    if (manual) toast(err.message);
  } finally {
    syncing = false;
    saveSyncCfg();
    save();
    render();
    if (syncAgain) { syncAgain = false; scheduleSync(0); }
  }
}

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hr ago`;
  return plural(Math.round(mins / 1440), 'day') + ' ago';
}
function syncLabel() {
  if (!syncCfg.url) return 'Sync: set up';
  if (syncing) return 'Syncing…';
  if (syncCfg.error) return '⚠ Sync problem';
  return syncCfg.lastSync ? `Synced ${ago(syncCfg.lastSync)}` : 'Not synced yet';
}

// ---------- Main views ----------
function render() {
  const b = computeBalances();
  const tabs = [['envelopes', 'Envelopes'], ['transactions', 'Transactions'], ['accounts', 'Accounts']];
  const view = { envelopes: envelopesView, transactions: transactionsView, accounts: accountsView }[ui.tab](b);
  $('#app').innerHTML = `
    <header class="appbar">
      <div class="appbar-row">
        <div class="brand"><img src="icon.svg" alt=""><span>Envelopes</span></div>
        <button class="icon-btn" data-action="menu" aria-label="Menu">${ICONS.more}</button>
      </div>
      <nav class="tabs">
        ${tabs.map(([id, label]) => `<button class="tab${ui.tab === id ? ' on' : ''}" data-action="tab" data-tab="${id}">${label}</button>`).join('')}
      </nav>
    </header>
    <main>${view}</main>
    <button class="fab" data-action="new-txn" aria-label="Add transaction">${ICONS.plus}</button>`;
}

function envelopesView(b) {
  const total = Object.values(b.env).reduce((s, v) => s + v, 0);
  const tick = monthProgress() * 100;
  const groups = GROUPS.map((g) => {
    const envs = activeEnvelopes().filter((e) => e.group === g.id);
    if (!envs.length) return '';
    const gTotal = envs.reduce((s, e) => s + (b.env[e.id] || 0), 0);
    return `<section class="group">
      <div class="group-head"><span>${g.label}</span><span>${fmt(gTotal)}</span></div>
      ${envs.map((e) => envRow(e, b.env[e.id] || 0, tick)).join('')}
    </section>`;
  }).join('');
  return `
    ${state.demo ? '<div class="banner">Demo data. Reset it from the ⋮ menu when you are ready to start for real.</div>' : ''}
    <div class="statusline"><button class="sync-link${syncCfg.error ? ' neg' : ''}" data-action="sync-settings">${syncLabel()}</button><span>Total: ${fmt(total)}</span></div>
    ${groups}
    <div class="fab-spacer"></div>`;
}

function envRow(e, bal, tick) {
  if (e.group === 'available') {
    return `<div class="env-row available">
      <span class="env-name">${esc(e.name)}</span>
      ${bal > 0 ? '<button class="chip" data-action="fill">Fill envelopes</button>' : '<span></span>'}
      <span class="env-bal${bal < 0 ? ' neg' : ''}">${fmt(bal)}</span>
    </div>`;
  }
  const pct = e.amount > 0 ? clamp(bal / e.amount, 0, 1) * 100 : 0;
  const full = e.group === 'goal' && e.amount > 0 && bal >= e.amount;
  return `<button class="env-row${full ? ' full' : ''}" data-action="open-env" data-id="${e.id}">
    <span class="env-name">${esc(e.name)}${full ? ' <span class="badge">Goal met</span>' : ''}</span>
    <span class="env-bal${bal < 0 ? ' neg' : ''}">${fmt(bal)}</span>
    <span class="bar"><span class="bar-fill" style="width:${pct}%"></span>${e.group === 'monthly' ? `<span class="bar-tick" style="left:${tick}%"></span>` : ''}</span>
    <span class="env-budget">${fmt(e.amount)}</span>
  </button>`;
}

function transactionsView() {
  const txns = sortedTxns();
  if (!txns.length) return '<div class="empty">No transactions yet. Tap + to add one.</div>';
  let html = '', last = '';
  for (const t of txns) {
    if (t.date !== last) {
      html += `<div class="date-head">${fmtDate(t.date)}</div>`;
      last = t.date;
    }
    html += txnRow(t);
  }
  return html + '<div class="fab-spacer"></div>';
}

function accountsView(b) {
  const accts = activeAccounts();
  const total = accts.reduce((s, a) => s + (b.acct[a.id] || 0), 0);
  return `
    <div class="statusline"><span>${plural(accts.length, 'account')}</span><span>Total: ${fmt(total)}</span></div>
    <div class="list">
      ${accts.map((a) => {
        const bal = b.acct[a.id] || 0;
        return `<button class="row" data-action="open-account" data-id="${a.id}">
          <span class="row-title">${esc(a.name)}</span>
          <span class="row-amt${bal < 0 ? ' neg' : ''}">${fmt(bal)}</span>
        </button>`;
      }).join('')}
    </div>
    <div class="pad"><button class="btn" data-action="new-account">+ Add account</button></div>
    <p class="hint">Your account total always matches your envelope total. Accounts track where money is, envelopes track what it is for.</p>
    <div class="fab-spacer"></div>`;
}

function txnSummary(t) {
  const note = t.note ? ` · ${t.note}` : '';
  switch (t.kind) {
    case 'expense':
      return { title: t.payee || 'Expense', sub: `${envName(t.lines[0].env)} · ${acctName(t.account)}${note}`, amt: t.accountAmt };
    case 'income':
      return { title: t.payee || 'Income', sub: `→ ${envName(t.lines[0].env)} · ${acctName(t.account)}${note}`, amt: t.accountAmt };
    case 'transfer':
      return { title: 'Move money', sub: `${envName(t.lines[0].env)} → ${envName(t.lines[1].env)}${note}`, amt: t.lines[1].amt, neutral: true };
    case 'fill':
      return { title: 'Fill envelopes', sub: `${plural(t.lines.length - 1, 'envelope')}${note}`, amt: -t.lines[0].amt, neutral: true };
  }
}

// envId: show the amount as it affected that envelope. showDate: include the date (used inside sheets).
function txnRow(t, { envId, showDate } = {}) {
  const s = txnSummary(t);
  let amt = s.amt, neutral = s.neutral;
  if (envId) {
    amt = t.lines.filter((l) => l.env === envId).reduce((a, l) => a + l.amt, 0);
    neutral = false;
  }
  const cls = neutral ? '' : amt < 0 ? ' neg' : ' pos';
  return `<button class="row txn" data-action="open-txn" data-id="${t.id}">
    <span class="row-title">${esc(s.title)}</span>
    <span class="row-amt${cls}">${neutral ? fmt(amt) : fmtSigned(amt)}</span>
    <span class="row-sub">${showDate ? fmtShortDate(t.date) + ' · ' : ''}${esc(s.sub)}</span>
  </button>`;
}

// ---------- Sheets ----------
const sheetHead = (title) =>
  `<div class="sheet-head"><h2>${title}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="Close">${ICONS.close}</button></div>`;

function envOptions(selected) {
  const b = computeBalances();
  return GROUPS.map((g) => {
    const envs = activeEnvelopes().filter((e) => e.group === g.id);
    if (!envs.length) return '';
    return `<optgroup label="${g.label}">${envs.map((e) =>
      `<option value="${e.id}"${e.id === selected ? ' selected' : ''}>${esc(e.name)} (${fmt(b.env[e.id] || 0)})</option>`).join('')}</optgroup>`;
  }).join('');
}

function acctOptions(selected) {
  return activeAccounts().map((a) => `<option value="${a.id}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
}

function txnSheet({ kind = 'expense', txn = null, env = null } = {}) {
  const t = txn;
  const k = t?.kind || kind;
  const firstEnv = activeEnvelopes().find((e) => e.group !== 'available')?.id;
  const amount = t ? Math.abs(t.kind === 'transfer' ? t.lines[1].amt : t.accountAmt) : 0;
  const expEnv = (t?.kind === 'expense' && t.lines[0].env) || env || firstEnv;
  const incEnv = (t?.kind === 'income' && t.lines[0].env) || AVAILABLE;
  const from = (t?.kind === 'transfer' && t.lines[0].env) || env || AVAILABLE;
  const to = (t?.kind === 'transfer' && t.lines[1].env) || (from === firstEnv ? AVAILABLE : firstEnv);
  const account = t?.account || state.settings.lastAccount || activeAccounts()[0]?.id;
  const payees = [...new Set(state.txns.map((x) => x.payee).filter(Boolean))].sort();
  const kinds = [['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Move money']];
  return `<form class="txn-form" data-form="txn" data-kind="${k}" data-id="${t?.id || ''}" autocomplete="off">
    ${sheetHead(t ? 'Edit transaction' : 'New transaction')}
    <div class="seg">${kinds.map(([id, label]) => `<button type="button" class="${id === k ? 'on' : ''}" data-action="set-kind" data-kind="${id}">${label}</button>`).join('')}</div>
    <label class="amount"><span>Amount</span><input name="amount" inputmode="decimal" placeholder="0.00" value="${toInput(amount)}"></label>
    <label data-show="expense income"><span class="payee-label">Payee</span><input name="payee" list="payees" value="${esc(t?.payee)}"></label>
    <label data-show="expense"><span>Envelope</span><select name="env">${envOptions(expEnv)}</select></label>
    <label data-show="income"><span>Into envelope</span><select name="incomeEnv">${envOptions(incEnv)}</select></label>
    <label data-show="transfer"><span>From envelope</span><select name="from">${envOptions(from)}</select></label>
    <label data-show="transfer"><span>To envelope</span><select name="to">${envOptions(to)}</select></label>
    <label data-show="expense income"><span>Account</span><select name="account">${acctOptions(account)}</select></label>
    <div class="two-col">
      <label><span>Date</span><input type="date" name="date" value="${t?.date || todayISO()}"></label>
      <label><span>Note</span><input name="note" value="${esc(t?.note)}"></label>
    </div>
    <div class="sheet-actions">
      ${t ? `<button type="button" class="btn danger" data-action="delete-txn" data-id="${t.id}">Delete</button>` : ''}
      <button class="btn primary">Save</button>
    </div>
    <datalist id="payees">${payees.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
  </form>`;
}

function setKind(form, kind) {
  form.dataset.kind = kind;
  form.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
  form.querySelectorAll('[data-show]').forEach((el) => (el.hidden = !el.dataset.show.split(' ').includes(kind)));
  const pl = form.querySelector('.payee-label');
  if (pl) pl.textContent = kind === 'income' ? 'From' : 'Payee';
}

function fillDetailSheet(t) {
  const rows = t.lines.filter((l) => l.env !== AVAILABLE).map((l) =>
    `<div class="row static"><span class="row-title">${esc(envName(l.env))}</span><span class="row-amt">${fmt(l.amt)}</span></div>`).join('');
  return `${sheetHead('Fill envelopes')}
    <p class="muted">${fmtDate(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</p>
    <div class="list">${rows}</div>
    <div class="sheet-actions"><button class="btn danger" data-action="delete-txn" data-id="${t.id}">Delete this fill</button></div>`;
}

function envSheet(id) {
  const e = envById(id);
  const bal = computeBalances().env[id] || 0;
  const txns = sortedTxns().filter((t) => t.lines.some((l) => l.env === id));
  const sub = e.group === 'monthly' ? `of ${fmt(e.amount)} monthly budget`
    : e.group === 'goal' ? `of ${fmt(e.amount)} goal` : 'Not yet assigned to an envelope';
  return `${sheetHead(esc(e.name))}
    <div class="env-hero"><div class="big${bal < 0 ? ' neg' : ''}">${fmt(bal)}</div><div class="muted">${sub}</div></div>
    <div class="btn-row">
      <button class="btn" data-action="new-txn" data-kind="expense" data-env="${id}">Spend</button>
      <button class="btn" data-action="new-txn" data-kind="transfer" data-env="${id}">Move money</button>
      ${id === AVAILABLE ? '<button class="btn" data-action="fill">Fill</button>' : `<button class="btn" data-action="edit-env" data-id="${id}">Edit</button>`}
    </div>
    <div class="list">${txns.map((t) => txnRow(t, { envId: id, showDate: true })).join('') || '<div class="empty">No activity yet</div>'}</div>`;
}

function envEditSheet(id) {
  const e = id ? envById(id) : { name: '', group: 'monthly', amount: 0 };
  return `<form data-form="env" data-id="${id || ''}" autocomplete="off">
    ${sheetHead(id ? 'Edit envelope' : 'New envelope')}
    <label><span>Name</span><input name="name" value="${esc(e.name)}" required></label>
    <label><span>Type</span><select name="group" data-action-change="env-group">
      <option value="monthly"${e.group === 'monthly' ? ' selected' : ''}>Monthly (refilled every month)</option>
      <option value="goal"${e.group === 'goal' ? ' selected' : ''}>Goal (saving up to a target)</option>
    </select></label>
    <label><span class="amount-label">${e.group === 'goal' ? 'Goal target' : 'Monthly budget'}</span><input name="amount" inputmode="decimal" placeholder="0.00" value="${toInput(e.amount)}"></label>
    <div class="sheet-actions">
      ${id ? `<button type="button" class="btn danger" data-action="delete-env" data-id="${id}">Delete</button>` : ''}
      <button class="btn primary">Save</button>
    </div>
  </form>`;
}

function accountSheet(id) {
  const a = id ? acctById(id) : null;
  const bal = a ? computeBalances().acct[id] || 0 : 0;
  const txns = a ? sortedTxns().filter((t) => t.account === id) : [];
  return `<form data-form="account" data-id="${id || ''}" autocomplete="off">
    ${sheetHead(a ? esc(a.name) : 'New account')}
    ${a ? `<div class="env-hero"><div class="big${bal < 0 ? ' neg' : ''}">${fmt(bal)}</div><div class="muted">Current balance</div></div>` : ''}
    <label><span>Account name</span><input name="name" value="${esc(a?.name)}" placeholder="e.g. Savings" required></label>
    ${a ? '' : '<label><span>Starting balance (goes into [Available])</span><input name="start" inputmode="decimal" placeholder="0.00"></label>'}
    <div class="sheet-actions"><button class="btn primary">${a ? 'Rename' : 'Add account'}</button></div>
  </form>
  ${a ? `<div class="list">${txns.map((t) => txnRow(t, { showDate: true })).join('') || '<div class="empty">No activity yet</div>'}</div>` : ''}`;
}

function fillSheet() {
  const b = computeBalances();
  const rows = activeEnvelopes().filter((e) => e.group !== 'available').map((e) => {
    const bal = b.env[e.id] || 0;
    const preset = e.group === 'monthly' ? e.amount : 0;
    return `<div class="fill-row">
      <div><div class="fill-name">${esc(e.name)}</div><div class="muted small">has ${fmt(bal)} · ${e.group === 'monthly' ? 'budget' : 'goal'} ${fmt(e.amount)}</div></div>
      <input name="${e.id}" inputmode="decimal" placeholder="0.00" value="${toInput(preset)}" data-fill data-budget="${e.group === 'monthly' ? e.amount : 0}">
    </div>`;
  }).join('');
  return `<form data-form="fill" autocomplete="off">
    ${sheetHead('Fill envelopes')}
    <div class="fill-summary">
      <span>Available</span><span>${fmt(b.env[AVAILABLE] || 0)}</span>
      <span>Filling</span><span data-out="filling"></span>
      <strong>Left over</strong><strong data-out="left"></strong>
    </div>
    <div class="btn-row">
      <button type="button" class="btn" data-action="fill-budgets">Use monthly budgets</button>
      <button type="button" class="btn" data-action="fill-clear">Clear all</button>
    </div>
    ${rows}
    <label><span>Date</span><input type="date" name="date" value="${todayISO()}"></label>
    <div class="sheet-actions"><button class="btn primary">Fill envelopes</button></div>
  </form>`;
}

function updateFillSummary(form) {
  const avail = computeBalances().env[AVAILABLE] || 0;
  const filling = [...form.querySelectorAll('[data-fill]')].reduce((s, i) => s + toCents(i.value), 0);
  const left = avail - filling;
  form.querySelector('[data-out="filling"]').textContent = fmt(filling);
  const out = form.querySelector('[data-out="left"]');
  out.textContent = fmt(left);
  out.classList.toggle('neg', left < 0);
}

function menuSheet() {
  return `${sheetHead('Menu')}
    <button class="menu-item" data-action="fill">Fill envelopes</button>
    <button class="menu-item" data-action="new-env">New envelope</button>
    <button class="menu-item" data-action="new-account">New account</button>
    <button class="menu-item" data-action="sync-settings">Google Sheets sync</button>
    <button class="menu-item" data-action="export">Export transactions (CSV)</button>
    <button class="menu-item" data-action="reset-empty">Start fresh (erase everything)</button>
    ${syncCfg.url ? '' : '<button class="menu-item" data-action="reset-demo">Reload demo data</button>'}`;
}

function syncSheet() {
  const c = syncCfg;
  const steps = `<ol class="steps">
      <li>Make a new Google Sheet for your budget.</li>
      <li>In the sheet, open <b>Extensions → Apps Script</b> and paste in <b>Code.gs</b>.</li>
      <li>Copy the sync key below into the <b>SECRET_KEY</b> line at the top of the script.</li>
      <li><b>Deploy → New deployment → Web app</b>. Execute as <b>Me</b>, access <b>Anyone</b>.</li>
      <li>Paste the web app URL below and tap Connect.</li>
    </ol>`;
  const status = c.error
    ? `<div class="banner neg-banner">${esc(c.error)}</div>`
    : `<p class="muted">${c.lastSync ? `Last synced ${ago(c.lastSync)}.` : 'Not synced yet.'}</p>`;
  return `<form data-form="sync" autocomplete="off">
    ${sheetHead('Google Sheets sync')}
    <p class="muted small">Your budget lives on this device and is copied to a Google Sheet you own. Any device with the same script URL and sync key shares the same budget.</p>
    ${c.url ? status : steps}
    <label><span>Script URL</span><input name="url" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c.url)}"></label>
    <label><span>Sync key</span><div class="input-row"><input name="key" value="${esc(c.key || newSyncKey())}" spellcheck="false"><button type="button" class="btn" data-action="copy-key">Copy</button></div></label>
    <div class="sheet-actions">
      ${c.url ? '<button type="button" class="btn danger" data-action="sync-disconnect">Disconnect</button><button type="button" class="btn" data-action="sync-now">Sync now</button>' : ''}
      <button class="btn primary">${c.url ? 'Save' : 'Connect'}</button>
    </div>
  </form>`;
}

function saveSyncForm(form) {
  const url = form.elements.url.value.trim();
  const key = form.elements.key.value.trim();
  if (!/^https?:\/\//.test(url)) return toast('Paste the web app URL from Apps Script');
  if (key.length < 8) return toast('The sync key should be at least 8 characters');
  if (url !== syncCfg.url || key !== syncCfg.key) syncCfg.lastSync = null; // new destination: start over
  if (!syncCfg.url && state.demo && confirm('Erase the demo data first, so it is not copied into your sheet?')) {
    state = freshState();
    save();
  }
  Object.assign(syncCfg, { url, key, error: null });
  saveSyncCfg();
  closeSheet();
  syncNow({ manual: true });
}

// Erasing while connected marks everything deleted, so the deletion reaches the sheet and other devices.
function eraseEverything() {
  if (!syncCfg.url) {
    state = freshState();
    return;
  }
  const t = nowISO();
  state.txns.forEach((x) => { if (!x.deleted) Object.assign(x, { deleted: true, updatedAt: t }); });
  state.envelopes.forEach((e) => { if (e.id !== AVAILABLE && !e.archived) Object.assign(e, { archived: true, updatedAt: t }); });
  state.demo = false;
}

// Sheets push a history entry so the Android back button closes them.
function openSheet(html, focusSel) {
  const root = $('#sheet-root');
  const wasOpen = root.classList.contains('open');
  root.innerHTML = `<div class="backdrop" data-action="close-sheet"></div><div class="sheet" role="dialog">${html}</div>`;
  root.offsetHeight; // allow the slide-in transition to run
  root.classList.add('open');
  if (!wasOpen) history.pushState({ sheet: true }, '');
  const form = root.querySelector('form[data-form="txn"]');
  if (form) setKind(form, form.dataset.kind);
  const fill = root.querySelector('form[data-form="fill"]');
  if (fill) updateFillSummary(fill);
  if (focusSel) root.querySelector(focusSel)?.focus();
}
function hideSheet() {
  const root = $('#sheet-root');
  root.classList.remove('open');
  setTimeout(() => { if (!root.classList.contains('open')) root.innerHTML = ''; }, 250);
}
function closeSheet() {
  if (history.state?.sheet) history.back();
  else hideSheet();
}
window.addEventListener('popstate', hideSheet);

let toastTimer;
function toast(msg, actionLabel, onAction) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button data-action="toast-action">${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  toast.onAction = onAction;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------- Actions ----------
function saveTxnForm(form) {
  const f = Object.fromEntries(new FormData(form));
  const kind = form.dataset.kind;
  const amount = toCents(f.amount);
  if (amount <= 0) return toast('Enter an amount greater than 0');
  const base = { date: f.date || todayISO(), payee: f.payee.trim(), note: f.note.trim(), amount };
  let t;
  if (kind === 'expense') t = T.expense({ ...base, env: f.env, account: f.account });
  else if (kind === 'income') t = T.income({ ...base, env: f.incomeEnv, account: f.account });
  else {
    if (f.from === f.to) return toast('Pick two different envelopes');
    t = T.transfer({ ...base, from: f.from, to: f.to });
  }
  const id = form.dataset.id;
  if (id) {
    const i = state.txns.findIndex((x) => x.id === id);
    state.txns[i] = { ...state.txns[i], ...t, updatedAt: nowISO() };
  } else {
    state.txns.push(stamp(t));
  }
  if (t.account) state.settings.lastAccount = t.account;
  commit();
  closeSheet();
  toast(id ? 'Updated' : 'Saved');
}

function deleteTxn(id) {
  const t = txnById(id);
  t.deleted = true;
  t.updatedAt = nowISO();
  commit();
  closeSheet();
  toast('Transaction deleted', 'Undo', () => {
    t.deleted = false;
    t.updatedAt = nowISO();
    commit();
  });
}

function saveEnvForm(form) {
  const f = Object.fromEntries(new FormData(form));
  const name = f.name.trim();
  if (!name) return toast('Give the envelope a name');
  const fields = { name, group: f.group, amount: Math.max(0, toCents(f.amount)), updatedAt: nowISO() };
  const id = form.dataset.id;
  if (id) Object.assign(envById(id), fields);
  else state.envelopes.splice(state.envelopes.findIndex((e) => e.id === AVAILABLE), 0, { id: uid(), ...fields });
  commit();
  closeSheet();
  toast(id ? 'Envelope updated' : 'Envelope added');
}

function deleteEnv(id) {
  const e = envById(id);
  const bal = computeBalances().env[id] || 0;
  const msg = bal ? `Delete "${e.name}"? Its balance of ${fmt(bal)} will move to [Available].` : `Delete "${e.name}"?`;
  if (!confirm(msg)) return;
  if (bal > 0) state.txns.push(stamp(T.transfer({ date: todayISO(), from: id, to: AVAILABLE, amount: bal, note: `Closed ${e.name}` })));
  if (bal < 0) state.txns.push(stamp(T.transfer({ date: todayISO(), from: AVAILABLE, to: id, amount: -bal, note: `Closed ${e.name}` })));
  e.archived = true; // kept so old transactions still show its name
  e.updatedAt = nowISO();
  commit();
  closeSheet();
  toast('Envelope deleted');
}

function saveAccountForm(form) {
  const f = Object.fromEntries(new FormData(form));
  const name = f.name.trim();
  if (!name) return toast('Give the account a name');
  const id = form.dataset.id;
  if (id) {
    Object.assign(acctById(id), { name, updatedAt: nowISO() });
  } else {
    const a = { id: uid(), name, updatedAt: nowISO() };
    state.accounts.push(a);
    const start = toCents(f.start);
    if (start > 0) state.txns.push(stamp(T.income({ date: todayISO(), payee: 'Starting balance', account: a.id, amount: start })));
  }
  commit();
  closeSheet();
  toast(id ? 'Account renamed' : 'Account added');
}

function saveFillForm(form) {
  const allocations = [...form.querySelectorAll('[data-fill]')]
    .map((i) => [i.name, toCents(i.value)])
    .filter(([, amt]) => amt !== 0);
  if (!allocations.length) return toast('Enter an amount for at least one envelope');
  const avail = computeBalances().env[AVAILABLE] || 0;
  const total = allocations.reduce((s, [, a]) => s + a, 0);
  if (total > avail && !confirm(`That's ${fmt(total - avail)} more than you have available. Fill anyway?`)) return;
  state.txns.push(stamp(T.fill({ date: form.elements.date.value || todayISO(), allocations })));
  commit();
  closeSheet();
  toast(`Filled ${plural(allocations.length, 'envelope')}`);
}

function exportCSV() {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Type', 'Payee', 'Envelope', 'Envelope amount', 'Account', 'Account amount', 'Note']];
  for (const t of sortedTxns()) {
    t.lines.forEach((l, i) => rows.push([
      t.date, t.kind, t.payee, envName(l.env), (l.amt / 100).toFixed(2),
      i === 0 ? acctName(t.account) : '', i === 0 && t.account ? (t.accountAmt / 100).toFixed(2) : '', t.note,
    ]));
  }
  const blob = new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `envelopes-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function freshState() {
  return {
    version: 1,
    envelopes: [{ id: AVAILABLE, name: '[Available]', group: 'available', amount: 0, updatedAt: nowISO() }],
    accounts: [{ id: uid(), name: 'Checking', updatedAt: nowISO() }],
    txns: [],
    settings: {},
  };
}

// ---------- Event wiring ----------
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const { action, id, kind, env } = el.dataset;
  switch (action) {
    case 'tab': ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'menu': openSheet(menuSheet()); break;
    case 'close-sheet': closeSheet(); break;
    case 'new-txn': openSheet(txnSheet({ kind, env }), 'input[name="amount"]'); break;
    case 'open-txn': {
      const t = txnById(id);
      openSheet(t.kind === 'fill' ? fillDetailSheet(t) : txnSheet({ txn: t }));
      break;
    }
    case 'set-kind': setKind(el.closest('form'), kind); break;
    case 'delete-txn': deleteTxn(id); break;
    case 'open-env': openSheet(envSheet(id)); break;
    case 'edit-env': openSheet(envEditSheet(id)); break;
    case 'new-env': openSheet(envEditSheet(), 'input[name="name"]'); break;
    case 'delete-env': deleteEnv(id); break;
    case 'open-account': openSheet(accountSheet(id)); break;
    case 'new-account': openSheet(accountSheet(), 'input[name="name"]'); break;
    case 'fill': openSheet(fillSheet()); break;
    case 'fill-budgets':
    case 'fill-clear': {
      const form = el.closest('form');
      form.querySelectorAll('[data-fill]').forEach((i) => {
        i.value = action === 'fill-budgets' ? toInput(+i.dataset.budget) : '';
      });
      updateFillSummary(form);
      break;
    }
    case 'export': exportCSV(); closeSheet(); break;
    case 'reset-empty':
      if (confirm(syncCfg.url ? 'Erase everything here and in your Google Sheet, and start with an empty budget?' : 'Erase everything on this device and start with an empty budget?')) {
        eraseEverything(); ui.tab = 'envelopes'; commit(); closeSheet();
      }
      break;
    case 'sync-settings': openSheet(syncSheet()); break;
    case 'sync-now': closeSheet(); syncNow({ manual: true }); break;
    case 'sync-disconnect':
      if (confirm('Stop syncing this device? Your data stays here and in the sheet.')) {
        syncCfg = { key: syncCfg.key };
        saveSyncCfg(); closeSheet(); render();
      }
      break;
    case 'copy-key':
      navigator.clipboard?.writeText(el.closest('form').elements.key.value).then(() => toast('Sync key copied'), () => toast('Could not copy. Select the key and copy it.'));
      break;
    case 'reset-demo':
      if (confirm('Replace everything with demo data?')) { state = seed(); commit(); closeSheet(); }
      break;
    case 'toast-action': $('#toast').hidden = true; toast.onAction?.(); break;
  }
});

document.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  ({ txn: saveTxnForm, env: saveEnvForm, account: saveAccountForm, fill: saveFillForm, sync: saveSyncForm })[form.dataset.form]?.(form);
});

document.addEventListener('input', (ev) => {
  if (ev.target.matches('[data-fill]')) updateFillSummary(ev.target.form);
});

document.addEventListener('change', (ev) => {
  if (ev.target.dataset.actionChange === 'env-group') {
    ev.target.form.querySelector('.amount-label').textContent = ev.target.value === 'goal' ? 'Goal target' : 'Monthly budget';
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.storage?.persist?.();
window.addEventListener('online', () => scheduleSync(0));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { render(); scheduleSync(0); }
});

render();
scheduleSync(0);
