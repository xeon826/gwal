// Shared Plaid client + incremental sync. Used by app.mjs and sync.mjs.
import fs from 'node:fs';

const ENV_FILE = new URL('../.env', import.meta.url).pathname;
for (const line of fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

export const CLIENT_ID = process.env.PLAID_CLIENT_ID;
export const SECRET = process.env.PLAID_API_KEY || process.env.PLAID_SECRET;
export const PLAID_HOST = process.env.PLAID_ENV || 'https://production.plaid.com';
export const CURSOR_FILE = new URL('../plaid-cursor.json', import.meta.url).pathname;

if (!CLIENT_ID || !SECRET) {
  throw new Error('Missing PLAID_CLIENT_ID / PLAID_API_KEY (set in .env or environment)');
}

export async function plaid(pathName, body = {}) {
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
    err.code = json.error_code;
    throw err;
  }
  return json;
}

export function readCursor() {
  return fs.existsSync(CURSOR_FILE)
    ? JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8'))
    : { cursor: '', has_more: true };
}

export function writeCursor(state) {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(state, null, 2));
}

// Pull all new transactions since the stored cursor.
// Returns array of raw Plaid transaction objects; updates cursor on success.
export async function fetchNewTransactions(access_token) {
  const state = readCursor();
  let cursor = state.cursor ?? '';
  let hasMore = true;
  const added = [];
  while (hasMore) {
    const out = await plaid('/transactions/sync', { access_token, cursor, count: 250 });
    added.push(...out.added);
    cursor = out.next_cursor;
    hasMore = out.has_more;
    if (out.cursor_update_requested) break; // rare: re-run later to finish the update
  }
  writeCursor({ cursor, has_more: hasMore });
  return added;
}

export async function getAccessToken() {
  const TOKEN_FILE = new URL('../plaid-token.json', import.meta.url).pathname;
  if (!fs.existsSync(TOKEN_FILE)) throw new Error('No plaid-token.json — link an account first (node server.mjs)');
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).access_token;
}
