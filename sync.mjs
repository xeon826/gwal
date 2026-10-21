// CLI sync: pull new transactions and append to transactions.jsonl (cron-friendly).
// Usage: node sync.mjs
import fs from 'node:fs';
import { fetchNewTransactions, getAccessToken } from './lib/plaid.mjs';

const OUTPUT_FILE = new URL('./transactions.jsonl', import.meta.url).pathname;

const access_token = await getAccessToken();
const added = await fetchNewTransactions(access_token);
fs.appendFileSync(OUTPUT_FILE, added.map((t) => JSON.stringify(t)).join('\n') + (added.length ? '\n' : ''));
for (const t of added) {
  const dir = t.amount >= 0 ? 'OUT' : 'IN ';
  console.log(`${t.date}  ${dir} ${Math.abs(t.amount).toFixed(2).padStart(10)}  ${t.name}`);
}
console.log(`\n${added.length} new transaction(s). Total stored in ${OUTPUT_FILE}`);
