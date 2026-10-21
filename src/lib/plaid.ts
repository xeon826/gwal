// Plaid client + incremental sync (server-side only).
import fs from 'node:fs';
import path from 'node:path';

// Next.js loads .env automatically; the manual load below only covers bare-node usage.
const ENV_FILE = path.join(process.cwd(), '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const CLIENT_ID = process.env.PLAID_CLIENT_ID ?? '';
export const SECRET = process.env.PLAID_API_KEY ?? process.env.PLAID_SECRET ?? '';
export const PLAID_HOST = process.env.PLAID_ENV || 'https://production.plaid.com';
const CURSOR_FILE = path.join(process.cwd(), 'plaid-cursor.json');

if (!CLIENT_ID || !SECRET) throw new Error('Missing PLAID_CLIENT_ID / PLAID_API_KEY (set in .env)');

export async function plaid(pathName: string, body: Record<string, unknown> = {}) {
  const res = await fetch(PLAID_HOST + pathName, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': CLIENT_ID,
      'PLAID-SECRET': SECRET,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(`${pathName} -> ${res.status}: ${json.error_message ?? JSON.stringify(json)}`);
    (err as any).code = json.error_code;
    throw err;
  }
  return json as Record<string, any>;
}

export function readCursor(): { cursor: string; has_more: boolean } {
  return fs.existsSync(CURSOR_FILE) ? JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')) : { cursor: '', has_more: true };
}

function writeCursor(state: { cursor: string; has_more: boolean }) {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(state, null, 2));
}

export interface PlaidTxn {
  transaction_id: string;
  account_id: string;
  date: string;
  datetime?: string | null;
  name: string;
  merchant_name?: string | null;
  amount: number;
  personal_finance_category?: { primary?: string } | null;
  [k: string]: unknown;
}

export async function fetchNewTransactions(access_token: string): Promise<PlaidTxn[]> {
  const state = readCursor();
  let cursor = state.cursor ?? '';
  let hasMore = true;
  const added: PlaidTxn[] = [];
  while (hasMore) {
    const out = (await plaid('/transactions/sync', { access_token, cursor, count: 250 })) as any;
    added.push(...out.added);
    cursor = out.next_cursor;
    hasMore = out.has_more;
    if (out.cursor_update_requested) break;
  }
  writeCursor({ cursor, has_more: hasMore });
  return added;
}

export function getAccessToken(): string {
  const TOKEN_FILE = path.join(process.cwd(), 'plaid-token.json');
  if (!fs.existsSync(TOKEN_FILE)) throw new Error('No plaid-token.json — run the one-time link flow first (node server.mjs)');
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).access_token as string;
}
