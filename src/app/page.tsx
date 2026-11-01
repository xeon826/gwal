'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement,
  PointElement, LineElement, Tooltip, Legend,
} from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, PointElement, LineElement, Tooltip, Legend);

const CATEGORIES = [
  'recurring_weekly', 'recurring_biweekly', 'recurring_fourweekly',
  'recurring_bimonthly', 'recurring_monthly', 'one_off', 'transfer', 'uncategorized',
] as const;
const SHORT: Record<string, string> = {
  recurring_weekly: 'weekly', recurring_biweekly: 'biweekly', recurring_fourweekly: '4-weekly',
  recurring_bimonthly: 'bimonthly', recurring_monthly: 'monthly', one_off: 'one-off',
  transfer: 'transfer', uncategorized: '?',
};

interface Txn {
  transaction_id: string; account_id: string; date: string; name: string;
  merchant_name: string | null; amount: number; pfc: string | null;
  category: string; source: string;
}
interface State {
  today: string; days_in_month: number; days_remaining: number; month: string;
  budget: {
    monthly_income: number; fixed_monthly: number; one_off_mtd: number;
    unreviewed_mtd: number; unreviewed_count: number; daily_target: number; spent_today: number;
    projected_net: number; projected_net_at_pace: number;
  };
  shapes: Array<{ rule_id: number; pattern: string; monthly: number; inflow: boolean }>;
  merchants: {
    months: string[];
    byMonth: Record<string, {
      total: number;
      groups: Array<{
        merchant: string; count: number; total: number;
        txns: Array<{ transaction_id: string; date: string; name: string; amount: number }>;
      }>;
    }>;
  };
  history: Array<{
    month: string; income: number; fixed: number; one_off: number; unreviewed: number;
    net: number; days_over_target: number | null; partial: boolean; live: boolean;
  }>;
  daily: Array<{ date: string; spent: number; target: number }>;
  rules: Array<{ id: number; pattern: string; category: string; origin: string }>;
  suggestions: Array<{ key: string; merchant: string; count: number; total: number; suggested: string; sample_id: string }>;
  transactions: Txn[];
}

const fmt = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function Page() {
  const [S, setS] = useState<State | null>(null);
  const [tab, setTab] = useState<'dash' | 'txns' | 'rules' | 'merchants'>('dash');
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  }, []);

  const refresh = useCallback(async () => {
    const r = await fetch('/api/state');
    setS(await r.json());
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 60000);
    return () => clearInterval(iv);
  }, [refresh]);

  const tag = useCallback(async (ids: string[], category: string, createRule: boolean) => {
    const r = await fetch('/api/tag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, category, create_rule: createRule }),
    });
    if (r.ok) { flash(`${ids.length} tagged as ${SHORT[category]}${createRule ? ' + rule' : ''}`); refresh(); }
    else flash('failed: ' + JSON.stringify(await r.json()));
  }, [flash, refresh]);

  const doSync = useCallback(async () => {
    setSyncing(true);
    const r = await (await fetch('/api/sync', { method: 'POST' })).json();
    setSyncing(false);
    flash(`${r.added ?? 0} new transaction(s)${r.error ? ' — ' + r.error : ''}`);
    refresh();
  }, [flash, refresh]);

  if (!S) return <div className="wrap"><p className="hint">Loading…</p></div>;
  const b = S.budget;

  return (
    <div className="wrap">
      <div className="bar">
        <h1>Expense Tracker</h1>
        <span className="tag">month {S.month}</span>
        <div className="spacer" />
        <span className="tag">{b.unreviewed_count} unreviewed</span>
        <button onClick={doSync} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync now'}</button>
      </div>

      {b.unreviewed_count > 0 && (
        <div className="banner">
          {b.unreviewed_count} unreviewed transaction(s) this month are counted as spend (conservatively).
          Tag them in Transactions to sharpen the number.
        </div>
      )}

      <div className="cards">
        <div className="card">
          <div className="label">Daily target</div>
          <div className={'big ' + (b.daily_target < 0 ? 'bad' : 'good')}>{fmt(b.daily_target)}</div>
          <div className="sub">{S.days_remaining} day(s) left this month</div>
        </div>
        <div className="card">
          <div className="label">Spent today</div>
          <div className="big">{fmt(b.spent_today)}</div>
          <div className="sub">
            {b.daily_target - b.spent_today >= 0
              ? <span className="good">{fmt(b.daily_target - b.spent_today)} under — tomorrow rises</span>
              : <span className="bad">{fmt(-(b.daily_target - b.spent_today))} over — tomorrow falls</span>}
          </div>
        </div>
        <div className="card">
          <div className="label">Monthly income (normalized)</div>
          <div className="big">{fmt(b.monthly_income)}</div>
          <div className="sub">avg of last 3 instances × cadence</div>
        </div>
        <div className="card">
          <div className="label">Fixed bills (normalized)</div>
          <div className="big">{fmt(b.fixed_monthly)}</div>
          <div className="sub">{fmt(b.monthly_income - b.fixed_monthly)} expendable / month</div>
        </div>
        <div className="card">
          <div className="label">One-off spend, MTD</div>
          <div className="big">{fmt(b.one_off_mtd)}</div>
          <div className="sub">unreviewed spend: {fmt(b.unreviewed_mtd)}</div>
        </div>
        <div className="card">
          <div className="label">Projected month-end net</div>
          <div className={'big ' + (b.projected_net < 0 ? 'bad' : 'good')}>{fmt(b.projected_net)}</div>
          <div className="sub">
            one-offs frozen · <span className={b.projected_net_at_pace < 0 ? 'bad' : 'good'}>{fmt(b.projected_net_at_pace)}</span> at current pace
          </div>
        </div>
      </div>

      <div className="tabs">
        <button className={tab === 'dash' ? 'active' : ''} onClick={() => setTab('dash')}>Dashboard</button>
        <button className={tab === 'txns' ? 'active' : ''} onClick={() => setTab('txns')}>Transactions</button>
        <button className={tab === 'merchants' ? 'active' : ''} onClick={() => setTab('merchants')}>Merchants</button>
        <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>Rules</button>
      </div>

      {tab === 'dash' && (
        <div className="panel">
          <div className="charts">
            <div className="chartbox">
              <Bar
                data={{
                  labels: S.daily.map((d) => d.date.slice(8)),
                  datasets: ([
                    { label: 'spent', data: S.daily.map((d) => d.spent), backgroundColor: '#4f8cff' },
                    { label: 'target', data: S.daily.map((d) => d.target), type: 'line' as const, borderColor: '#3fbf7f', backgroundColor: '#3fbf7f', tension: 0.3, pointRadius: 2 },
                  ] as unknown as NonNullable<React.ComponentProps<typeof Bar>['data']>['datasets']),
                }}
                options={{
                  maintainAspectRatio: false,
                  scales: { x: { ticks: { color: '#8b93a5' } }, y: { ticks: { color: '#8b93a5' } } },
                  plugins: { legend: { labels: { color: '#e6e9ef' } } },
                }}
              />
            </div>
            <div className="chartbox">
              <Line
                data={{
                  labels: S.daily.map((d) => d.date.slice(8)),
                  datasets: [
                    { label: 'cumulative', data: S.daily.reduce<number[]>((acc, d) => { acc.push(+( (acc.at(-1) ?? 0) + Math.max(0, d.spent) ).toFixed(2)); return acc; }, []), borderColor: '#4f8cff', tension: 0.25, pointRadius: 2 },
                    { label: 'ideal pace', data: S.daily.map((_, i) => +(((b.monthly_income - b.fixed_monthly) * (i + 1)) / S.days_in_month).toFixed(2)), borderColor: '#584a1e', borderDash: [6, 4], pointRadius: 0 },
                  ],
                }}
                options={{
                  maintainAspectRatio: false,
                  scales: { x: { ticks: { color: '#8b93a5' } }, y: { ticks: { color: '#8b93a5' } } },
                  plugins: { legend: { labels: { color: '#e6e9ef' } } },
                }}
              />
            </div>
          </div>
          <div className="hint">Bars = one-off spend per day · line = the daily target as it evolved · burn-down compares cumulative spend against ideal pace.</div>
          <HistorySection history={S.history} />
        </div>
      )}

      {tab === 'txns' && (
        <div className="panel">
          <div className="hint">Categorize one merchant and similar transactions follow. Checking &quot;rule&quot; teaches the classifier permanently.</div>
          {S.suggestions.length === 0
            ? <div className="hint">Nothing unreviewed. 🎉</div>
            : S.suggestions.map((g) => <SuggestionRow key={g.key} g={g} txns={S.transactions} onTag={tag} />)}
          <table>
            <thead><tr><th>Date</th><th>Name</th><th>Merchant</th><th className="amt">Amount</th><th>Category</th><th>By</th></tr></thead>
            <tbody>
              {S.transactions.map((t) => (
                <tr key={t.transaction_id}>
                  <td>{t.date}</td>
                  <td>{t.name}</td>
                  <td style={{ color: 'var(--dim)' }}>{t.merchant_name}</td>
                  <td className={'amt' + (t.amount < 0 ? ' good' : '')}>{(t.amount < 0 ? '+' : '') + Math.abs(t.amount).toFixed(2)}</td>
                  <td><CatSelect current={t.category} onPick={(c) => tag([t.transaction_id], c, false)} /></td>
                  <td><span className="tag">{t.source}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'merchants' && <MerchantsTab merchants={S.merchants} />}

      {tab === 'rules' && <RulesTab rules={S.rules} shapes={S.shapes} onChanged={refresh} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function HistorySection({ history }: { history: State['history'] }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div className="label" style={{ color: 'var(--dim)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
        Monthly loss / gain
      </div>
      <div className="chartbox" style={{ height: 200 }}>
        <Bar
          data={{
            labels: history.map((h) => h.month + (h.live ? ' ●' : '') + (h.partial ? ' ◐' : '')),
            datasets: [{
              label: 'net',
              data: history.map((h) => h.net),
              backgroundColor: history.map((h) => (h.net >= 0 ? '#3fbf7f' : '#ff6b6b')),
            }],
          }}
          options={{
            maintainAspectRatio: false,
            scales: { x: { ticks: { color: '#8b93a5' } }, y: { ticks: { color: '#8b93a5' } } },
            plugins: { legend: { display: false } },
          }}
        />
      </div>
      <table style={{ marginTop: 10 }}>
        <thead>
          <tr><th>Month</th><th className="amt">Income</th><th className="amt">Fixed</th><th className="amt">One-off</th><th className="amt">Unreviewed</th><th className="amt">Net</th><th>Days over target</th></tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.month}>
              <td>{h.month}{h.live ? ' ●' : ''}{h.partial ? ' ◐' : ''}</td>
              <td className="amt">{fmt(h.income)}</td>
              <td className="amt">{fmt(h.fixed)}</td>
              <td className="amt">{fmt(h.one_off)}</td>
              <td className="amt">{fmt(h.unreviewed)}</td>
              <td className={'amt ' + (h.net >= 0 ? 'good' : 'bad')}>{(h.net >= 0 ? '+' : '') + fmt(h.net)}</td>
              <td>{h.days_over_target ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hint">● live month (updates as transactions land) · ◐ partial month (data starts mid-month) · net excludes transfers.</div>
    </div>
  );
}

function CatSelect({ current, onPick }: { current: string; onPick: (c: string) => void }) {
  return (
    <select value={current} onChange={(e) => onPick(e.target.value)}>
      {CATEGORIES.map((c) => <option key={c} value={c}>{SHORT[c]}</option>)}
    </select>
  );
}

function SuggestionRow({ g, txns, onTag }: {
  g: { key: string; merchant: string; count: number; total: number; suggested: string; sample_id: string };
  txns: Txn[];
  onTag: (ids: string[], c: string, rule: boolean) => void;
}) {
  const [cat, setCat] = useState(g.suggested);
  const [rule, setRule] = useState(true);
  const ids = txns
    .filter((t) => t.category === 'uncategorized' && (t.merchant_name || t.name).includes(g.key))
    .map((t) => t.transaction_id);
  return (
    <div className="sugg">
      <div style={{ flex: 1 }}>
        <span className="name">{g.merchant}</span>{' '}
        <span className="meta">{g.count} txn · {fmt(g.total)} net · suggested: {SHORT[g.suggested]}</span>
      </div>
      <CatSelect current={cat} onPick={setCat} />
      <button onClick={() => onTag(ids.length ? ids : [g.sample_id], cat, rule)}>Apply to {g.count}</button>
      <label style={{ fontSize: 12, color: 'var(--dim)' }}>
        <input type="checkbox" checked={rule} onChange={(e) => setRule(e.target.checked)} style={{ marginRight: 4 }} />rule
      </label>
    </div>
  );
}

function MerchantsTab({ merchants }: { merchants: State['merchants'] }) {
  const [month, setMonth] = useState<string>(merchants.months.at(-1) ?? '');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const data = merchants.byMonth[month];
  if (!data) return <div className="panel"><div className="hint">No one-off transactions in {month || 'any month'}.</div></div>;
  const max = Math.max(...data.groups.map((g) => Math.abs(g.total)), 1);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div className="panel">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <label style={{ color: 'var(--dim)', fontSize: 13 }}>Month</label>
        <select value={month} onChange={(e) => setMonth(e.target.value)}>
          {merchants.months.map((m) => (
            <option key={m} value={m}>{m}{m === merchants.months.at(-1) ? ' (live)' : ''}</option>
          ))}
        </select>
        <span className="meta" style={{ color: 'var(--dim)', fontSize: 12 }}>
          one-off spend grouped by merchant — click a row to expand
        </span>
      </div>
      <table>
        <thead><tr><th></th><th>Merchant</th><th className="amt">Txns</th><th className="amt">Total</th><th style={{ width: '35%' }}></th></tr></thead>
        <tbody>
          {data.groups.map((g) => {
            const key = month + ':' + g.merchant;
            const isOpen = expanded.has(key);
            const rows = [
              <tr key={g.merchant} style={{ cursor: 'pointer' }} onClick={() => toggle(key)}>
                <td style={{ width: 24 }}>{isOpen ? '▾' : '▸'}</td>
                <td className="name">{g.merchant}</td>
                <td className="amt">{g.count}</td>
                <td className="amt">{fmt(g.total)}</td>
                <td>
                  <div style={{ background: 'var(--accent)', height: 10, borderRadius: 5, width: (Math.abs(g.total) / max) * 100 + '%' }} />
                </td>
              </tr>,
            ];
            if (isOpen) {
              for (const t of [...g.txns].sort((a, b) => (a.date < b.date ? 1 : -1))) {
                rows.push(
                  <tr key={t.transaction_id} style={{ background: '#12151c' }}>
                    <td></td>
                    <td style={{ color: 'var(--dim)', paddingLeft: 24 }}>{t.date} — {t.name.slice(0, 55)}</td>
                    <td className="amt" colSpan={2}>{(t.amount < 0 ? '+' : '') + Math.abs(t.amount).toFixed(2)}</td>
                    <td></td>
                  </tr>,
                );
              }
            }
            return rows;
          })}
          <tr>
            <td></td><td style={{ fontWeight: 700 }}>Total</td>
            <td className="amt" style={{ fontWeight: 700 }}>{data.groups.reduce((s, g) => s + g.count, 0)}</td>
            <td className="amt" style={{ fontWeight: 700 }}>{fmt(data.total)}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function RulesTab({ rules, shapes, onChanged }: {
  rules: Array<{ id: number; pattern: string; category: string; origin: string }>;
  shapes: Array<{ pattern: string; monthly: number; inflow: boolean }>;
  onChanged: () => void;
}) {
  const [pattern, setPattern] = useState('');
  const [category, setCategory] = useState('one_off');

  const save = async () => {
    await fetch('/api/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', pattern, category }),
    });
    setPattern('');
    onChanged();
  };
  const del = async (id: number) => {
    await fetch('/api/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    });
    onChanged();
  };

  return (
    <div className="panel">
      <div className="hint">Rules auto-assign categories on every sync. &quot;seed&quot; came from your history; &quot;learned&quot; from your clicks.</div>
      <table>
        <thead><tr><th>Pattern</th><th>Category</th><th>Origin</th><th></th></tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>{r.pattern}</td>
              <td>{SHORT[r.category] ?? r.category}</td>
              <td><span className="tag">{r.origin}</span></td>
              <td><button className="ghost" onClick={() => del(r.id)}>delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input placeholder="pattern (e.g. trade coffee)" value={pattern} onChange={(e) => setPattern(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <CatSelect current={category} onPick={setCategory} />
        <button className="secondary" onClick={save}>Add rule</button>
      </div>
      <div className="hint">
        Derived shapes: {shapes.map((s) => `${s.pattern} → ${fmt(s.monthly)}/mo${s.inflow ? ' (in)' : ''}`).join(' · ')}
      </div>
    </div>
  );
}
