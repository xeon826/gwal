// Minimal Plaid Link helper: serves a connect page, creates link tokens,
// exchanges public tokens, and verifies the resulting Item.
// Usage: node server.mjs   (requires PLAID_CLIENT_ID + PLAID_API_KEY env vars)
import http from 'node:http';
import fs from 'node:fs';

// load .env from this directory (existing env vars take precedence)
for (const line of fs.readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_API_KEY || process.env.PLAID_SECRET;
const PLAID_HOST = process.env.PLAID_ENV || 'https://production.plaid.com';
const PORT = Number(process.env.PORT || 8642);
const TOKEN_FILE = new URL('./plaid-token.json', import.meta.url).pathname;

if (!CLIENT_ID || !SECRET) {
  console.error('Missing PLAID_CLIENT_ID / PLAID_API_KEY env vars');
  process.exit(1);
}

async function plaid(pathName, body = {}) {
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

const page = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Connect US Bank -> Plaid</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 60px auto; text-align: center; }
    button { font-size: 18px; padding: 12px 28px; cursor: pointer; }
    #status { margin-top: 24px; white-space: pre-wrap; text-align: left; }
  </style>
</head>
<body>
  <h1>Expense Tracker</h1>
  <p>Links your US Bank login to Plaid. Your bank credentials stay in the US Bank OAuth window.</p>
  <button id="connect" disabled>Loading…</button>
  <div id="status"></div>
  <script>
    const status = (t) => document.getElementById('status').textContent += t + "\\n";
    const btn = document.getElementById('connect');
    let linkToken;

    fetch('/link-token')
      .then(r => r.json())
      .then(({ link_token, error }) => {
        if (error) { status('FAILED: ' + error); return; }
        linkToken = link_token;
        btn.disabled = false;
        btn.textContent = 'Connect US Bank';
      })
      .catch(e => status('FAILED: ' + e.message));

    btn.onclick = () => {
      const handler = Plaid.create({
        token: linkToken,
        onSuccess: async (public_token, metadata) => {
          status('Link completed: ' + (metadata.institution?.name ?? 'institution'));
          const res = await fetch('/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ public_token, institution: metadata.institution?.name }),
          });
          const out = await res.json();
          if (out.error) { status('EXCHANGE FAILED: ' + out.error); return; }
          status('ACCESS TOKEN SAVED\\nItem: ' + out.item_id);
          for (const a of out.accounts) {
            status('  - ' + a.name + ' ****' + a.mask + ' (' + a.type + '/' + a.subtype + ')');
          }
          status('\\nDone. You can close this tab.');
        },
        onExit: (err) => { if (err) status('Exited: ' + err.error_message); },
      });
      handler.open();
    };
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Content-Type', 'application/json');
  try {
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(page);
      return;
    }
    if (url.pathname === '/link-token') {
      const json = await plaid('/link/token/create', {
        client_name: "Dan's Expense Tracker",
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
        user: { client_user_id: 'dan-expense-tracker-001' },
      });
      console.log('[link-token] created');
      res.end(JSON.stringify({ link_token: json.link_token, expiration: json.expiration }));
      return;
    }
    if (url.pathname === '/exchange' && req.method === 'POST') {
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => resolve(JSON.parse(data || '{}')));
      });
      const ex = await plaid('/item/public_token/exchange', { public_token: body.public_token });
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({
        access_token: ex.access_token,
        item_id: ex.item_id,
        institution: body.institution ?? null,
        created_at: new Date().toISOString(),
      }, null, 2), { mode: 0o600 });
      console.log('[exchange] access token saved to', TOKEN_FILE);
      const accounts = await plaid('/accounts/get', { access_token: ex.access_token });
      const slim = accounts.accounts.map((a) => ({
        name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
        current_balance: a.balances.current,
        currency: a.balances.iso_currency_code,
      }));
      console.log('[accounts]', JSON.stringify(slim, null, 2));
      res.end(JSON.stringify({ item_id: ex.item_id, accounts: slim }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    console.error('[error]', e.message);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Connect page: http://localhost:${PORT}  (env: ${PLAID_HOST})`));
