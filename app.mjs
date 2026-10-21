// Expense tracker: local dashboard + categorization + budget engine.
// Usage: node app.mjs  → http://127.0.0.1:8643
import http from 'node:http';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fetchNewTransactions, getAccessToken } from './lib/plaid.mjs';

const PORT = Number(process.env.PORT || 8643);
const HOST = '127.0.0.1';
const DB_FILE = new URL('./budget.db', import.meta.url).pathname;
const JSONL = new URL('./transactions.jsonl', import.meta.url).pathname;
const DASH = new URL('./dashboard.html', import.meta.url).pathname;

export const CATEGORIES = [
  'recurring_weekly', 'recurring_biweekly', 'recurring_fourweekly',
  'recurring_bimonthly', 'recurring_monthly', 'one_off', 'transfer', 'uncategorized',
];
const PERIODS = { recurring_weekly: 52, recurring_biweekly: 26, recurring_fourweekly: 13, recurring_bimonthly: 24, recurring_monthly: 12 };

// ---------- text helpers ----------
const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const textOf = (t) => norm((t.merchant_name ?? '') + ' ' + (t.name ?? ''));
function trigrams(s) { const set = new Set(); const p = '  ' + s + ' '; for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3)); return set; }
function similarity(a, b) {
  if (!a || !b) return 0;
  const A = trigrams(a), B = trigrams(b);
  let inter = 0; for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------- db ----------
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY, account_id TEXT, date TEXT, datetime TEXT,
  name TEXT, merchant_name TEXT, amount REAL, pfc TEXT,
  category TEXT DEFAULT 'uncategorized', source TEXT DEFAULT 'uncategorized', raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(category);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT UNIQUE, category TEXT,
  origin TEXT DEFAULT 'learned', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS overrides (
  transaction_id TEXT PRIMARY KEY, category TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const insTxn = db.prepare(`INSERT INTO transactions
  (transaction_id, account_id, date, datetime, name, merchant_name, amount, pfc, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(transaction_id) DO NOTHING`);
const setCat = db.prepare('UPDATE transactions SET category=?, source=? WHERE transaction_id=?');
const allRules = () => db.prepare('SELECT * FROM rules ORDER BY id').all();

// ---------- classifier ----------
function classify(txn, rules) {
  const o = db.prepare('SELECT category FROM overrides WHERE transaction_id = ?').get(txn.transaction_id);
  if (o) return { category: o.category, source: 'override' };
  const text = textOf(txn);
  for (const r of rules) if (text.includes(r.pattern)) return { category: r.category, source: 'rule' };
  const merchant = norm(txn.merchant_name), name = norm(txn.name);
  let best = null;
  for (const r of rules) {
    if (r.pattern.length < 5) continue;
    const sim = Math.max(similarity(merchant, r.pattern), similarity(name, r.pattern));
    if (!best || sim > best.sim) best = { sim, r };
  }
  if (best && best.sim >= 0.62) return { category: best.r.category, source: 'fuzzy' };
  return { category: 'uncategorized', source: 'uncategorized' };
}

function reclassifyAll() {
  const rules = allRules();
  const rows = db.prepare('SELECT * FROM transactions').all();
  const upd = db.prepare('UPDATE transactions SET category=?, source=? WHERE transaction_id=?');
  for (const t of rows) {
    const { category, source } = classify(t, rules);
    if (category !== t.category || source !== t.source) upd.run(category, source, t.transaction_id);
  }
}

// ---------- bootstrap ----------
const count = db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
if (count === 0 && fs.existsSync(JSONL)) {
  const lines = fs.readFileSync(JSONL, 'utf8').trim().split('\n');
  for (const line of lines) {
    const t = JSON.parse(line);
    insTxn.run(t.transaction_id, t.account_id, t.date, t.datetime ?? null, t.name,
      t.merchant_name ?? null, t.amount, t.personal_finance_category?.primary ?? null, line);
  }
  console.log(`[bootstrap] imported ${lines.length} transactions from transactions.jsonl`);
}
if (db.prepare('SELECT COUNT(*) c FROM rules').get().c === 0) {
  const SEED = [
    ['databank holding', 'recurring_bimonthly'],
    ['bridge sfr', 'recurring_monthly'],
    ['duke', 'recurring_monthly'],
    ['state farm', 'recurring_monthly'], ['electronic withdrawal att', 'recurring_monthly'],
    ['openai', 'recurring_monthly'], ['firecrawl', 'recurring_monthly'],
    ['walterai', 'recurring_monthly'], ['epoch eu', 'recurring_monthly'],
    ['bluechew', 'recurring_monthly'], ['google one', 'recurring_monthly'],
    ['alpaca securitie', 'transfer'], ['web transfer', 'transfer'],
    ['mobile banking transfer', 'transfer'], ['internet banking transfer', 'transfer'],
    ['zelle instant pmt', 'transfer'],
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO rules (pattern, category, origin) VALUES (?, ?, ?)');
  for (const [pattern, category] of SEED) ins.run(pattern, category, 'seed');
  console.log(`[bootstrap] seeded ${SEED.length} rules`);
}
reclassifyAll();

// ---------- sync ----------
let syncing = false;
async function doSync() {
  if (syncing) return { added: 0, note: 'sync already in progress' };
  syncing = true;
  try {
    const token = await getAccessToken();
    const added = await fetchNewTransactions(token);
    const rules = allRules();
    const get = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?');
    for (const t of added) {
      insTxn.run(t.transaction_id, t.account_id, t.date, t.datetime ?? null, t.name,
        t.merchant_name ?? null, t.amount, t.personal_finance_category?.primary ?? null, JSON.stringify(t));
      const row = get.get(t.transaction_id);
      const { category, source } = classify(row, rules);
      setCat.run(category, source, row.transaction_id);
    }
    console.log(`[sync] ${added.length} new transaction(s)`);
    return { added: added.length };
  } finally { syncing = false; }
}

// ---------- budget engine ----------
// shapes: each recurring_* rule becomes one monthly-equivalent piece
function shapes(rules) {
  const out = [];
  const byCat = db.prepare(`SELECT date, amount, name, merchant_name FROM transactions WHERE category = ? ORDER BY date DESC`);
  for (const r of rules) {
    if (!PERIODS[r.category]) continue;
    const last3 = byCat.all(r.category).filter((t) => textOf(t).includes(r.pattern)).slice(0, 3);
    if (!last3.length) continue;
    const avg = last3.reduce((s, t) => s + t.amount, 0) / last3.length;
    out.push({
      rule_id: r.id, pattern: r.pattern, category: r.category,
      monthly: Math.abs(avg) * PERIODS[r.category] / 12,
      inflow: avg < 0, instances: last3.length,
    });
  }
  return out;
}

function computeState() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(); // 0-based
  const daysIn = new Date(y, m + 1, 0).getDate();
  const dayNow = now.getDate();
  const daysRemaining = daysIn - dayNow + 1;
  const mm = `${y}-${String(m + 1).padStart(2, '0')}`;
  const today = `${mm}-${String(dayNow).padStart(2, '0')}`;
  const dstr = (d) => `${mm}-${String(d).padStart(2, '0')}`;

  const rules = allRules();
  const sh = shapes(rules);
  const monthly_income = sh.filter((s) => s.inflow).reduce((s, x) => s + x.monthly, 0);
  const fixed_monthly = sh.filter((s) => !s.inflow).reduce((s, x) => s + x.monthly, 0);

  const flow = db.prepare(`SELECT date, amount FROM transactions WHERE category = ? AND date LIKE ?`);
  const oneOff = flow.all('one_off', mm + '%');
  const unrev = flow.all('uncategorized', mm + '%');
  const net = (rows, pred = () => true) => rows.filter(pred).reduce((s, t) => s + t.amount, 0);

  const one_off_mtd = net(oneOff);
  const unreviewed_mtd = net(unrev);
  const spent_before_today = net(oneOff, (t) => t.date < today) + Math.max(0, net(unrev, (t) => t.date < today));
  const spent_today = net(oneOff, (t) => t.date === today) + Math.max(0, net(unrev, (t) => t.date === today));
  const daily_target = (monthly_income - fixed_monthly - spent_before_today) / daysRemaining;

  // per-day series for the current month (up to today)
  const daily = [];
  for (let d = 1; d <= dayNow; d++) {
    const ds = dstr(d);
    const spent = net(oneOff, (t) => t.date === ds) + Math.max(0, net(unrev, (t) => t.date === ds));
    const before = net(oneOff, (t) => t.date < ds) + Math.max(0, net(unrev, (t) => t.date < ds));
    daily.push({ date: ds, spent: +spent.toFixed(2), target: +((monthly_income - fixed_monthly - before) / (daysIn - d + 1)).toFixed(2) });
  }

  // suggestions: group uncategorized by merchant, add plaid-prior hint
  const PFC_SUGGEST = { PAYCHECK: 'recurring_bimonthly', TRANSFER_IN: 'transfer', TRANSFER_OUT: 'transfer', ACCOUNT_TO_ACCOUNT: 'transfer' };
  const rows = db.prepare(`SELECT * FROM transactions WHERE category = 'uncategorized' ORDER BY date DESC`).all();
  const groups = new Map();
  for (const t of rows) {
    const key = t.merchant_name || norm(t.name).split(' ').slice(0, 3).join(' ');
    if (!groups.has(key)) groups.set(key, { key, merchant: key, count: 0, total: 0, suggested: PFC_SUGGEST[t.pfc] ?? 'one_off', sample_id: t.transaction_id });
    const g = groups.get(key);
    g.count++; g.total += t.amount;
  }

  const txns = db.prepare('SELECT transaction_id, account_id, date, name, merchant_name, amount, pfc, category, source FROM transactions ORDER BY date DESC, datetime DESC LIMIT 500').all();

  return {
    today, days_in_month: daysIn, days_remaining: daysRemaining, month: mm,
    budget: {
      monthly_income: +monthly_income.toFixed(2),
      fixed_monthly: +fixed_monthly.toFixed(2),
      one_off_mtd: +one_off_mtd.toFixed(2),
      unreviewed_mtd: +unreviewed_mtd.toFixed(2),
      unreviewed_count: rows.length,
      daily_target: +daily_target.toFixed(2),
      spent_today: +spent_today.toFixed(2),
    },
    shapes: sh.map((s) => ({ ...s, monthly: +s.monthly.toFixed(2) })),
    daily, rules, categories: CATEGORIES,
    suggestions: [...groups.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    transactions: txns,
  };
}

// ---------- http ----------
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(JSON.parse(d || '{}'))); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(DASH));
      return;
    }
    if (url.pathname === '/api/state') return json(res, 200, computeState());
    if (url.pathname === '/api/sync' && req.method === 'POST') return json(res, 200, await doSync());

    if (url.pathname === '/api/tag' && req.method === 'POST') {
      const { ids, category, create_rule } = await readBody(req);
      if (!Array.isArray(ids) || !CATEGORIES.includes(category)) return json(res, 400, { error: 'bad request' });
      const ov = db.prepare('INSERT INTO overrides (transaction_id, category) VALUES (?, ?) ON CONFLICT(transaction_id) DO UPDATE SET category = excluded.category');
      for (const id of ids) ov.run(id, category);
      if (create_rule) {
        const t0 = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(ids[0]);
        const pattern = norm(t0.merchant_name) || norm(t0.name).split(' ').slice(0, 3).join(' ');
        if (pattern.length >= 4) {
          db.prepare('INSERT OR IGNORE INTO rules (pattern, category, origin) VALUES (?, ?, ?)').run(pattern, category, 'learned');
        }
      }
      reclassifyAll();
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/rules' && req.method === 'POST') {
      const { action, id, pattern, category } = await readBody(req);
      if (action === 'delete' && id) db.prepare('DELETE FROM rules WHERE id = ?').run(id);
      else if (action === 'save' && pattern && CATEGORIES.includes(category)) {
        db.prepare('INSERT INTO rules (pattern, category, origin) VALUES (?, ?, ?) ON CONFLICT(pattern) DO UPDATE SET category = excluded.category')
          .run(norm(pattern), category, 'learned');
      } else return json(res, 400, { error: 'bad request' });
      reclassifyAll();
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[error]', e.message);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`Expense tracker → http://${HOST}:${PORT}`));
