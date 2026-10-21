// Transaction classifier: layered rules → fuzzy match → uncategorized.
// Pure functions; the DB layer feeds it and persists results.

export const CATEGORIES = [
  'recurring_weekly', 'recurring_biweekly', 'recurring_fourweekly',
  'recurring_bimonthly', 'recurring_monthly', 'one_off', 'transfer', 'uncategorized',
] as const;
export type Category = (typeof CATEGORIES)[number];

// monthly-equivalent multipliers per cadence (periods per year / 12)
export const PERIODS: Record<string, number> = {
  recurring_weekly: 52,
  recurring_biweekly: 26,
  recurring_fourweekly: 13,
  recurring_bimonthly: 24,
  recurring_monthly: 12,
};

export interface Rule { id: number; pattern: string; category: string; origin: string }
export interface TxnLike {
  transaction_id: string;
  name?: string | null;
  merchant_name?: string | null;
}

export const norm = (s?: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const textOf = (t: TxnLike) => norm((t.merchant_name ?? '') + ' ' + (t.name ?? ''));

function trigrams(s: string): Set<string> {
  const set = new Set<string>();
  const p = '  ' + s + ' ';
  for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3));
  return set;
}

export function similarity(a?: string | null, b?: string | null): number {
  if (!a || !b) return 0;
  const A = trigrams(norm(a)), B = trigrams(norm(b));
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

const FUZZY_AUTO = 0.62;

/** Returns { category, source } for a transaction. */
export function classify(
  txn: TxnLike,
  rules: Rule[],
  overrideCategory?: string | null,
): { category: string; source: string } {
  if (overrideCategory) return { category: overrideCategory, source: 'override' };
  const text = textOf(txn);
  for (const r of rules) if (text.includes(r.pattern)) return { category: r.category, source: 'rule' };
  const merchant = norm(txn.merchant_name), name = norm(txn.name);
  let best: { sim: number; rule: Rule } | null = null;
  for (const r of rules) {
    if (r.pattern.length < 5) continue;
    const sim = Math.max(similarity(merchant, r.pattern), similarity(name, r.pattern));
    if (!best || sim > best.sim) best = { sim, rule: r };
  }
  if (best && best.sim >= FUZZY_AUTO) return { category: best.rule.category, source: 'fuzzy' };
  return { category: 'uncategorized', source: 'uncategorized' };
}

// Suggestion grouping: strip card-statement prefixes so merchants group cleanly.
const PREFIXES = [
  'web authorized pmt', 'debit purchase visa', 'recurring debit purchase',
  'electronic deposit', 'electronic withdrawal', 'internet banking transfer',
  'mobile banking transfer', 'debit purchase', 'recurring debit',
  'mobile check deposit', 'visa direct', 'pos purchase',
];

export function groupKeyOf(t: TxnLike): string {
  const m = (t.merchant_name ?? '').trim();
  if (m) return m;
  let n = norm(t.name);
  for (const p of PREFIXES) {
    if (n.startsWith(p)) { n = n.slice(p.length).trim(); break; }
  }
  return n.split(' ').slice(0, 3).join(' ') || n;
}

export const SEED_RULES: Array<[string, string]> = [
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
