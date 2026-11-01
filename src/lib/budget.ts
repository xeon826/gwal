// Budget engine: derives daily target from categorized history.
// The three shape families: recurring_* (normalized to monthly), one_off (measured), transfer (ignored).
import { and, desc, eq, like, notInArray } from 'drizzle-orm';
import { db } from './db';
import * as schema from './schema';
import { PERIODS, textOf, groupKeyOf, type Rule } from './classifier';

interface Shape {
  rule_id: number; pattern: string; category: string;
  monthly: number; inflow: boolean; instances: number;
}

function shapes(rules: Rule[]): Shape[] {
  const out: Shape[] = [];
  const byCat = (cat: string) =>
    db.select({
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      name: schema.transactions.name,
      merchantName: schema.transactions.merchantName,
    })
      .from(schema.transactions)
      .where(eq(schema.transactions.category, cat))
      .orderBy(desc(schema.transactions.date))
      .all();
  for (const r of rules) {
    if (!PERIODS[r.category]) continue;
    const last3 = byCat(r.category)
      .filter((t) => textOf({ transaction_id: '', name: t.name, merchant_name: t.merchantName }).includes(r.pattern))
      .slice(0, 3);
    if (!last3.length) continue;
    const avg = last3.reduce((s, t) => s + t.amount, 0) / last3.length;
    out.push({
      rule_id: r.id, pattern: r.pattern, category: r.category,
      monthly: +(Math.abs(avg) * PERIODS[r.category] / 12).toFixed(2),
      inflow: avg < 0, instances: last3.length,
    });
  }
  return out;
}

const PFC_SUGGEST: Record<string, string> = {
  PAYCHECK: 'recurring_bimonthly',
  TRANSFER_IN: 'transfer',
  TRANSFER_OUT: 'transfer',
  ACCOUNT_TO_ACCOUNT: 'transfer',
};

export interface MonthHistory {
  month: string; income: number; fixed: number; one_off: number; unreviewed: number;
  net: number; days_over_target: number | null; partial: boolean; live: boolean;
}

// Per-month loss/gain, derived from categorized transactions (never stored —
// re-tagging old transactions self-corrects history).
export function monthHistory(currentMonth: string): MonthHistory[] {
  const RECURRING = new Set(Object.keys(PERIODS));
  const rows = db
    .select({ date: schema.transactions.date, amount: schema.transactions.amount, category: schema.transactions.category })
    .from(schema.transactions)
    .where(notInArray(schema.transactions.category, ['transfer']))
    .all();

  const byMonth = new Map<string, typeof rows>();
  for (const r of rows) {
    const mo = r.date.slice(0, 7);
    if (!byMonth.has(mo)) byMonth.set(mo, []);
    byMonth.get(mo)!.push(r);
  }
  const minDate = rows.length ? rows.map((r) => r.date).reduce((a, b) => (a < b ? a : b)) : '';
  const months = [...byMonth.keys()].sort().slice(-12);

  const out: MonthHistory[] = [];
  for (const mo of months) {
    const rowsM = byMonth.get(mo)!;
    let income = 0, fixed = 0, one_off = 0, unreviewed = 0;
    const dailySpend = new Map<string, number>();
    for (const r of rowsM) {
      if (RECURRING.has(r.category)) {
        if (r.amount < 0) income += -r.amount; else fixed += r.amount;
      } else if (r.category === 'one_off') {
        one_off += r.amount;
        dailySpend.set(r.date, (dailySpend.get(r.date) ?? 0) + r.amount);
      } else if (r.category === 'uncategorized') {
        if (r.amount > 0) unreviewed += r.amount; else income += -r.amount;
        dailySpend.set(r.date, (dailySpend.get(r.date) ?? 0) + Math.max(0, r.amount));
      }
    }
    const [yy, mm2] = mo.split('-').map(Number);
    const daysIn = new Date(yy, mm2, 0).getDate();
    const partial = minDate > `${mo}-01`;
    const live = mo === currentMonth;
    let daysOver: number | null = null;
    if (!partial) {
      const lastDay = live ? new Date().getDate() : daysIn;
      daysOver = 0;
      for (let d = 1; d <= lastDay; d++) {
        const ds = `${mo}-${String(d).padStart(2, '0')}`;
        const before = [...dailySpend.entries()].filter(([k]) => k < ds).reduce((s, [, v]) => s + v, 0);
        const target = (income - fixed - before) / (daysIn - d + 1);
        if ((dailySpend.get(ds) ?? 0) > target) daysOver++;
      }
    }
    out.push({
      month: mo,
      income: +income.toFixed(2), fixed: +fixed.toFixed(2),
      one_off: +one_off.toFixed(2), unreviewed: +unreviewed.toFixed(2),
      net: +(income - fixed - one_off - unreviewed).toFixed(2),
      days_over_target: daysOver, partial, live,
    });
  }
  return out;
}

export function merchantBreakdown() {
  const rows = db
    .select({
      transactionId: schema.transactions.transactionId,
      date: schema.transactions.date,
      name: schema.transactions.name,
      merchantName: schema.transactions.merchantName,
      amount: schema.transactions.amount,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.category, 'one_off'))
    .orderBy(desc(schema.transactions.date))
    .all();

  const byMonth = new Map<string, Map<string, {
    merchant: string; count: number; total: number;
    txns: Array<{ transaction_id: string; date: string; name: string; amount: number }>;
  }>>();
  for (const t of rows) {
    const mo = t.date.slice(0, 7);
    const key = groupKeyOf({ transaction_id: '', name: t.name, merchant_name: t.merchantName });
    if (!byMonth.has(mo)) byMonth.set(mo, new Map());
    const groups = byMonth.get(mo)!;
    if (!groups.has(key)) groups.set(key, { merchant: key, count: 0, total: 0, txns: [] });
    const g = groups.get(key)!;
    g.count++; g.total += t.amount;
    g.txns.push({ transaction_id: t.transactionId, date: t.date, name: t.name ?? '', amount: t.amount });
  }

  const months = [...byMonth.keys()].sort();
  const out: Record<string, {
    total: number;
    groups: Array<{ merchant: string; count: number; total: number; txns: Array<{ transaction_id: string; date: string; name: string; amount: number }> }>;
  }> = {};
  for (const mo of months) {
    const groups = [...byMonth.get(mo)!.values()]
      .map((g) => ({ ...g, total: +g.total.toFixed(2) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    out[mo] = { total: +groups.reduce((s, g) => s + g.total, 0).toFixed(2), groups };
  }
  return { months, byMonth: out };
}

export function computeState() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(); // 0-based
  const daysIn = new Date(y, m + 1, 0).getDate();
  const dayNow = now.getDate();
  const daysRemaining = daysIn - dayNow + 1;
  const mm = `${y}-${String(m + 1).padStart(2, '0')}`;
  const today = `${mm}-${String(dayNow).padStart(2, '0')}`;

  const rules = db.select().from(schema.rules).all();
  const sh = shapes(rules);
  const monthly_income = +sh.filter((s) => s.inflow).reduce((s, x) => s + x.monthly, 0).toFixed(2);
  const fixed_monthly = +sh.filter((s) => !s.inflow).reduce((s, x) => s + x.monthly, 0).toFixed(2);

  const flowRows = (cat: string) =>
    db.select({ date: schema.transactions.date, amount: schema.transactions.amount })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.category, cat), like(schema.transactions.date, mm + '%')))
      .all();
  const oneOff = flowRows('one_off');
  const unrev = flowRows('uncategorized');
  const net = (rows: { date: string; amount: number }[], pred?: (t: { date: string }) => boolean) =>
    rows.filter((t) => !pred || pred(t)).reduce((s, t) => s + t.amount, 0);

  const one_off_mtd = +net(oneOff).toFixed(2);
  const unreviewed_mtd = +net(unrev).toFixed(2);
  const spent_before_today = net(oneOff, (t) => t.date < today) + Math.max(0, net(unrev, (t) => t.date < today));
  const spent_today = +(net(oneOff, (t) => t.date === today) + Math.max(0, net(unrev, (t) => t.date === today))).toFixed(2);
  const daily_target = +((monthly_income - fixed_monthly - spent_before_today) / daysRemaining).toFixed(2);

  const daily: Array<{ date: string; spent: number; target: number }> = [];
  for (let d = 1; d <= dayNow; d++) {
    const ds = `${mm}-${String(d).padStart(2, '0')}`;
    const spent = +(net(oneOff, (t) => t.date === ds) + Math.max(0, net(unrev, (t) => t.date === ds))).toFixed(2);
    const before = net(oneOff, (t) => t.date < ds) + Math.max(0, net(unrev, (t) => t.date < ds));
    daily.push({ date: ds, spent, target: +((monthly_income - fixed_monthly - before) / (daysIn - d + 1)).toFixed(2) });
  }

  // suggestions: group uncategorized by cleaned merchant key
  const unreviewedRows = db.select().from(schema.transactions)
    .where(eq(schema.transactions.category, 'uncategorized'))
    .orderBy(desc(schema.transactions.date)).all();
  const groups = new Map<string, { key: string; merchant: string; count: number; total: number; suggested: string; sample_id: string }>();
  for (const t of unreviewedRows) {
    const key = groupKeyOf({ transaction_id: '', name: t.name, merchant_name: t.merchantName });
    if (!groups.has(key)) {
      groups.set(key, {
        key, merchant: key, count: 0, total: 0,
        suggested: PFC_SUGGEST[t.pfc ?? ''] ?? 'one_off',
        sample_id: t.transactionId,
      });
    }
    const g = groups.get(key)!;
    g.count++; g.total += t.amount;
  }

  const txns = db.select({
    transaction_id: schema.transactions.transactionId,
    account_id: schema.transactions.accountId,
    date: schema.transactions.date,
    name: schema.transactions.name,
    merchant_name: schema.transactions.merchantName,
    amount: schema.transactions.amount,
    pfc: schema.transactions.pfc,
    category: schema.transactions.category,
    source: schema.transactions.source,
  }).from(schema.transactions).orderBy(desc(schema.transactions.date), desc(schema.transactions.datetime)).limit(500).all();

  return {
    today, days_in_month: daysIn, days_remaining: daysRemaining, month: mm,
    budget: {
      monthly_income, fixed_monthly, one_off_mtd, unreviewed_mtd,
      unreviewed_count: unreviewedRows.length,
      daily_target, spent_today,
      projected_net: +(monthly_income - fixed_monthly - one_off_mtd).toFixed(2),
      projected_net_at_pace: +(monthly_income - fixed_monthly - one_off_mtd - (one_off_mtd / dayNow) * daysRemaining).toFixed(2),
    },
    shapes: sh,
    history: monthHistory(mm),
    merchants: merchantBreakdown(),
    daily, rules, categories: Object.keys(PERIODS).concat(['one_off', 'transfer', 'uncategorized']),
    suggestions: [...groups.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    transactions: txns,
  };
}
