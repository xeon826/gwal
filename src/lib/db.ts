// DB singleton + bootstrap + classification persistence.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { classify, SEED_RULES, norm, type Rule } from './classifier';
import type { PlaidTxn } from './plaid';

export const sqlite = new Database(path.join(process.cwd(), 'tracker.db'));
sqlite.pragma('journal_mode = WAL');
export const db = drizzle(sqlite, { schema });

// table safety net (drizzle-kit push is the primary schema path)
sqlite.exec(`
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY, account_id TEXT, date TEXT, datetime TEXT,
  name TEXT, merchant_name TEXT, amount REAL, pfc TEXT,
  category TEXT DEFAULT 'uncategorized', source TEXT DEFAULT 'uncategorized', raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(category);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT UNIQUE, category TEXT,
  origin TEXT DEFAULT 'learned', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS overrides (
  transaction_id TEXT PRIMARY KEY, category TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const allRules = (): Rule[] => db.select().from(schema.rules).all();
const overrideMap = () =>
  new Map(db.select().from(schema.overrides).all().map((o) => [o.transactionId, o.category]));

export function reclassifyAll() {
  const rules = allRules();
  const ov = overrideMap();
  const rows = db.select().from(schema.transactions).all();
  for (const row of rows) {
    const txn = { transaction_id: row.transactionId, name: row.name, merchant_name: row.merchantName };
    const { category, source } = classify(txn, rules, ov.get(row.transactionId));
    if (category !== row.category || source !== row.source) {
      db.update(schema.transactions).set({ category, source }).where(eq(schema.transactions.transactionId, row.transactionId)).run();
    }
  }
}

export function insertTxn(t: PlaidTxn, raw?: string) {
  db.insert(schema.transactions)
    .values({
      transactionId: t.transaction_id,
      accountId: t.account_id,
      date: t.date,
      datetime: t.datetime ?? null,
      name: t.name,
      merchantName: t.merchant_name ?? null,
      amount: t.amount,
      pfc: t.personal_finance_category?.primary ?? null,
      raw: raw ?? JSON.stringify(t),
    })
    .onConflictDoNothing()
    .run();
}

function classifyTxnById(id: string, rules: Rule[], ov: Map<string, string>) {
  const row = db.select().from(schema.transactions).where(eq(schema.transactions.transactionId, id)).get();
  if (!row) return;
  const txn = { transaction_id: row.transactionId, name: row.name, merchant_name: row.merchantName };
  const { category, source } = classify(txn, rules, ov.get(row.transactionId));
  db.update(schema.transactions).set({ category, source }).where(eq(schema.transactions.transactionId, id)).run();
}

let syncing = false;
export async function syncTransactions(): Promise<{ added: number; note?: string }> {
  if (syncing) return { added: 0, note: 'sync already in progress' };
  syncing = true;
  try {
    const { fetchNewTransactions, getAccessToken } = await import('./plaid');
    const token = getAccessToken();
    const added = await fetchNewTransactions(token);
    const rules = allRules();
    const ov = overrideMap();
    for (const t of added) {
      insertTxn(t);
      classifyTxnById(t.transaction_id, rules, ov);
    }
    console.log(`[sync] ${added.length} new transaction(s)`);
    return { added: added.length };
  } finally {
    syncing = false;
  }
}

export function tagTransactions(ids: string[], category: string, createRule: boolean) {
  const first = db.select().from(schema.transactions).where(eq(schema.transactions.transactionId, ids[0])).get();
  for (const id of ids) {
    db.insert(schema.overrides)
      .values({ transactionId: id, category })
      .onConflictDoUpdate({ target: schema.overrides.transactionId, set: { category } })
      .run();
  }
  if (createRule && first) {
    const pattern = norm(first.merchantName) || norm(first.name).split(' ').slice(0, 3).join(' ');
    if (pattern.length >= 4) {
      db.insert(schema.rules)
        .values({ pattern, category, origin: 'learned' })
        .onConflictDoUpdate({ target: schema.rules.pattern, set: { category } })
        .run();
    }
  }
  reclassifyAll();
}

let initPromise: Promise<void> | null = null;
export function initDb(): Promise<void> {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit() {
  const n = db.select({ c: countAll() }).from(schema.transactions).get();
  if (!n || n.c === 0) {
    const JSONL = path.join(process.cwd(), 'transactions.jsonl');
    if (fs.existsSync(JSONL)) {
      const lines = fs.readFileSync(JSONL, 'utf8').trim().split('\n');
      for (const line of lines) {
        try { insertTxn(JSON.parse(line), line); } catch { /* skip malformed */ }
      }
      console.log(`[bootstrap] imported ${lines.length} transactions`);
    }
  }
  if (db.select({ c: countAll() }).from(schema.rules).get()!.c === 0) {
    for (const [pattern, category] of SEED_RULES) {
      db.insert(schema.rules).values({ pattern, category, origin: 'seed' })
        .onConflictDoNothing().run();
    }
    console.log(`[bootstrap] seeded ${SEED_RULES.length} rules`);
  }
  reclassifyAll();
}

// tiny aggregate helper
import { sql } from 'drizzle-orm';
const countAll = () => sql<number>`count(*)`;
