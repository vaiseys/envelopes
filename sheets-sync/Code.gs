/**
 * Envelopes <-> Google Sheets sync.
 *
 * Paste this whole file into Extensions > Apps Script in your budget sheet.
 * Then put the sync key from the app on the line below and deploy as a web app
 * (see README.md for the step-by-step).
 */
const SECRET_KEY = 'PASTE-YOUR-SYNC-KEY-HERE';

// Deleted transactions (and archived envelopes/accounts no longer used) are removed
// from the sheet once they've been deleted this many days. Until then they stay so
// every device can learn about the deletion.
const PURGE_AFTER_DAYS = 30;

// Each tab in the sheet. Columns with a `key` are read back by the app;
// columns without one (balances, names, amounts) are just there for you to read.
// The app treats the sheet as a copy, so edits made directly in the sheet may be overwritten.
const TABLES = [
  {
    sheet: 'Envelopes', coll: 'envelopes', cols: [
      col('Name', 'name', 'text'),
      col('Type', 'group', 'text'),
      col('Budget / goal', 'amount', 'money'),
      col('Balance', null, 'money', function (e, ctx) { return ctx.envBal[e.id] || 0; }),
      col('Archived', 'archived', 'bool'),
      col('ID', 'id', 'text'),
      col('Updated', 'updatedAt', 'text'),
    ],
  },
  {
    sheet: 'Accounts', coll: 'accounts', cols: [
      col('Name', 'name', 'text'),
      col('Balance', null, 'money', function (a, ctx) { return ctx.acctBal[a.id] || 0; }),
      col('Archived', 'archived', 'bool'),
      col('ID', 'id', 'text'),
      col('Updated', 'updatedAt', 'text'),
    ],
  },
  {
    sheet: 'Transactions', coll: 'txns', cols: [
      col('Date', 'date', 'date'),
      col('Type', 'kind', 'text'),
      col('Payee', 'payee', 'text'),
      col('Envelope', null, 'text', envelopeLabel),
      col('Amount', null, 'money', function (t) { return t.deleted ? '' : displayCents(t); }),
      col('Account', null, 'text', function (t, ctx) { return ctx.acctName[t.account] || ''; }),
      col('Note', 'note', 'text'),
      col('Deleted', 'deleted', 'bool'),
      col('ID', 'id', 'text'),
      col('Updated', 'updatedAt', 'text'),
      col('Created', 'createdAt', 'text'),
      col('Account ID', 'account', 'nullable'),
      col('Account amount (cents)', 'accountAmt', 'int'),
      col('Lines', 'lines', 'json'),
    ],
  },
];

const FORMATS = { text: '@', date: '@', nullable: '@', json: '@', money: '#,##0.00', int: '0' };

function col(h, key, type, view) {
  return { h: h, key: key, type: type, view: view };
}

// ---------- Web app entry points ----------

function doGet() {
  return ContentService.createTextOutput('Envelopes sync is running. Paste this URL into the app.');
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'Bad request.' });
  }
  if (SECRET_KEY.indexOf('PASTE-') === 0) {
    return reply({ ok: false, error: 'Set SECRET_KEY at the top of the Apps Script, then deploy a new version.' });
  }
  if (req.key !== SECRET_KEY) return reply({ ok: false, error: 'Wrong sync key.' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const push = req.push || {};
    const data = {};
    let changed = !ss.getSheetByName('Transactions');

    // Merge: for each record, the most recently updated version wins.
    TABLES.forEach(function (spec) {
      const byId = {};
      const order = [];
      readTable(ss, spec, tz).forEach(function (r) {
        if (!byId[r.id]) order.push(r.id);
        byId[r.id] = r;
      });
      (push[spec.coll] || []).forEach(function (r) {
        if (!r || !r.id) return;
        const cur = byId[r.id];
        if (!cur) order.push(r.id);
        if (!cur || String(r.updatedAt) > String(cur.updatedAt)) {
          byId[r.id] = r;
          changed = true;
        }
      });
      data[spec.coll] = order.map(function (id) { return byId[id]; });
    });

    if (purgeOld(data)) changed = true;

    if (changed) {
      const ctx = buildContext(data);
      TABLES.forEach(function (spec) {
        let rows = data[spec.coll];
        if (spec.coll === 'txns') rows = rows.slice().sort(newestFirst);
        writeTable(ss, spec, rows, ctx);
      });
      removeEmptyDefaultSheet(ss);
    }
    return reply({ ok: true, data: data, serverTime: new Date().toISOString() });
  } finally {
    lock.releaseLock();
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Drops records deleted/archived more than PURGE_AFTER_DAYS ago. Returns true if anything was removed.
function purgeOld(data) {
  const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const old = function (r) { return String(r.updatedAt) < cutoff; };
  const before = data.txns.length + data.envelopes.length + data.accounts.length;

  data.txns = data.txns.filter(function (t) { return !(t.deleted && old(t)); });
  // Keep archived envelopes/accounts that remaining transactions still point to, so their names still show.
  const usedEnv = {}, usedAcct = {};
  data.txns.forEach(function (t) {
    (t.lines || []).forEach(function (l) { usedEnv[l.env] = true; });
    if (t.account) usedAcct[t.account] = true;
  });
  data.envelopes = data.envelopes.filter(function (e) { return !(e.archived && old(e) && !usedEnv[e.id]); });
  data.accounts = data.accounts.filter(function (a) { return !(a.archived && old(a) && !usedAcct[a.id]); });

  return data.txns.length + data.envelopes.length + data.accounts.length !== before;
}

// ---------- Reading and writing tabs ----------

function readTable(ss, spec, tz) {
  const sh = ss.getSheetByName(spec.sheet);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  const head = values[0].map(String);
  const idCol = head.indexOf('ID');
  const cols = spec.cols
    .filter(function (c) { return c.key; })
    .map(function (c) { return { c: c, i: head.indexOf(c.h) }; })
    .filter(function (x) { return x.i >= 0; });
  return values.slice(1)
    .filter(function (row) { return row[idCol]; })
    .map(function (row) {
      const r = {};
      cols.forEach(function (x) { r[x.c.key] = fromCell(x.c.type, row[x.i], tz); });
      return r;
    });
}

function writeTable(ss, spec, records, ctx) {
  const sh = ss.getSheetByName(spec.sheet) || ss.insertSheet(spec.sheet);
  const width = spec.cols.length;
  sh.getRange(1, 1, 1, width).setValues([spec.cols.map(function (c) { return c.h; })]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, Math.max(width, sh.getLastColumn())).clearContent();
  if (!records.length) return;
  spec.cols.forEach(function (c, i) {
    if (FORMATS[c.type]) sh.getRange(2, i + 1, records.length, 1).setNumberFormat(FORMATS[c.type]);
  });
  const rows = records.map(function (r) {
    return spec.cols.map(function (c) {
      const v = c.view ? c.view(r, ctx) : r[c.key];
      return v === '' ? '' : toCell(c.type, v);
    });
  });
  sh.getRange(2, 1, rows.length, width).setValues(rows);
}

function removeEmptyDefaultSheet(ss) {
  const sh = ss.getSheetByName('Sheet1');
  if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
}

// ---------- Cell conversion ----------

function toCell(type, v) {
  switch (type) {
    case 'bool': return !!v;
    case 'int': return Number(v) || 0;
    case 'money': return (Number(v) || 0) / 100;
    case 'json': return JSON.stringify(v || []);
    default: {
      const s = v == null ? '' : String(v);
      return /^[=+]/.test(s) ? "'" + s : s; // stop text being treated as a formula
    }
  }
}

function fromCell(type, v, tz) {
  switch (type) {
    case 'bool': return v === true || String(v).toUpperCase() === 'TRUE';
    case 'int': return Math.round(Number(v) || 0);
    case 'money': return Math.round((Number(v) || 0) * 100);
    case 'json':
      try { return JSON.parse(v || '[]'); } catch (err) { return []; }
    case 'date':
      return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v);
    case 'nullable':
      return v === '' || v == null ? null : String(v);
    default:
      return v instanceof Date ? v.toISOString() : String(v == null ? '' : v);
  }
}

// ---------- Human-readable columns ----------

function buildContext(data) {
  const ctx = { envName: {}, acctName: {}, envBal: {}, acctBal: {} };
  data.envelopes.forEach(function (e) { ctx.envName[e.id] = e.name; });
  data.accounts.forEach(function (a) { ctx.acctName[a.id] = a.name; });
  data.txns.forEach(function (t) {
    if (t.deleted) return;
    (t.lines || []).forEach(function (l) { ctx.envBal[l.env] = (ctx.envBal[l.env] || 0) + l.amt; });
    if (t.account) ctx.acctBal[t.account] = (ctx.acctBal[t.account] || 0) + t.accountAmt;
  });
  return ctx;
}

function envelopeLabel(t, ctx) {
  const lines = t.lines || [];
  const name = function (l) { return (l && ctx.envName[l.env]) || ''; };
  if (t.kind === 'transfer') return name(lines[0]) + ' → ' + name(lines[1]);
  if (t.kind === 'fill') return 'Fill: ' + lines.slice(1).map(name).join(', ');
  return name(lines[0]);
}

function displayCents(t) {
  const lines = t.lines || [];
  if (t.kind === 'transfer') return lines[1] ? lines[1].amt : 0;
  if (t.kind === 'fill') return lines[0] ? -lines[0].amt : 0;
  return t.accountAmt;
}

function newestFirst(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return String(b.createdAt).localeCompare(String(a.createdAt));
}
