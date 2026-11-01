# AGENTS.md

Personal expense tracker: Next.js dashboard over a local SQLite DB, fed by the Plaid API (US Bank, Transactions product, Trial plan).

## Commands

```bash
npm run dev            # dashboard at http://127.0.0.1:3100 (dev mode)
npm run build          # production build (output: standalone → .next/standalone/server.js)
npm run db:push        # apply src/lib/schema.ts via drizzle-kit
node sync.mjs          # standalone sync: Plaid → transactions.jsonl (legacy path, see Data flow)
node server.mjs        # one-time Plaid Link UI on :8642 — only for linking or re-auth
node scripts/gatekeeper.mjs   # on-demand supervisor: proxy on :3100, spawns Next on :3101
```

**Production run model:** the dashboard runs on-demand via the systemd user unit `gwal.service` (`systemctl --user status gwal`), which runs `scripts/gatekeeper.mjs` permanently (~25MB). A visit to http://127.0.0.1:3100 spawns the Next standalone server on internal port 3101 (first response may be a 503 "waking up" auto-refresh page for a couple of seconds); after 10 minutes with no requests the gatekeeper SIGTERMs it. MemoryMax=250M on the unit; linger is enabled so it survives logout/reboot. `npm start` is no longer the run path — `npm run build` also copies `.next/static` + `public` into `.next/standalone/` (required; standalone omits them and the page hangs on "Loading..." without them), then `systemctl --user restart gwal` to pick up changes.

Cron is **not installed yet**. The dashboard's "Sync now" button writes to `tracker.db`; `sync.mjs` writes to `transactions.jsonl`. Do not treat these as interchangeable (see Data flow).

## Data flow & storage

- **`tracker.db` (SQLite, via Drizzle) is the single source of truth.** Tables: `transactions`, `rules`, `overrides`.
- `transactions.jsonl` is a legacy append-only archive. The app imports it only when `tracker.db` is empty; afterwards the two diverge. Never rely on JSONL as current data.
- Secrets, never commit or echo: `.env` (PLAID_CLIENT_ID / PLAID_API_KEY), `plaid-token.json` (long-lived Plaid access token), `plaid-cursor.json`. All gitignored.

## Category taxonomy (drives ALL budget math)

`recurring_weekly` · `recurring_biweekly` · `recurring_fourweekly` · `recurring_bimonthly` · `recurring_monthly` · `one_off` · `transfer` · `uncategorized`

- Recurring categories normalize to a monthly equivalent via periods-per-year: 52 / 26 / 13 / 24 / 12 (see `PERIODS` in `src/lib/classifier.ts`). Four-weekly ≠ monthly (13 ≠ 12).
- `transfer` = the discard chute: self-transfers (Alpaca, ****↔****, Zelle-to-self, credit-card payments) are excluded from income, fixed, one-off, and net. Do not count them as expenses.
- `one_off` is net-signed: negative amounts (refunds, deposits) increase net.
- Tags were considered and parked — do not implement without asking.

## Budget engine (`src/lib/budget.ts`)

- `monthly_income` / `fixed_monthly` = avg of last 3 instances per recurring shape × periods/12. Shapes derive from rules; a shape with no matching instances is skipped.
- `daily_target = (monthly_income − fixed_monthly − one_off_spent_before_today) / days_remaining_in_month`. Month reset is inherent — no stored state.
- `projected_net = monthly_income − fixed_monthly − one_off_mtd` (one-offs frozen at now; fixed and income are full-month forecasts). `projected_net_at_pace` additionally subtracts avg daily one-off × days remaining.
- `monthHistory()` is derived, never stored: re-categorizing old transactions recomputes past months automatically. Don't add snapshot tables for it.

## Classifier (`src/lib/classifier.ts`)

Precedence: **override → rule substring match → fuzzy (trigram Jaccard ≥ 0.62, patterns ≥ 5 chars) → uncategorized**. Plaid's `personal_finance_category` is a suggestion in the UI, never auto-applied.

- Rules table patterns are matched against `norm(merchant + ' ' + name)` (lowercase, non-alphanumerics → spaces).
- Merchant grouping uses `groupKeyOf()`, which strips card-statement prefixes ("Web Authorized Pmt", "Debit Purchase -visa", …) — keep that prefix list current.
- Known weakness: one pattern can span two real merchants sharing a name prefix (the `catapult park st` membership-vs-visits case). Fix by narrowing the pattern to the billing descriptor, not by adding exceptions elsewhere.
- `reclassifyAll()` replays every transaction whenever rules change — history self-corrects. There is no ML model; do not introduce one without asking.

## Plaid specifics

- Posting lag: card purchases appear 1–3 days after swipe, dated the post date. Sync ingests only the `added` array — `modified`/`removed` are not handled yet, so pending→posted transitions do not flow through.
- Plaid Trial plan: max 10 Items, and deleting an Item never frees the slot. Never relink casually; use `server.mjs` update-mode for re-auth instead of creating a new Item.
- Plaid errors to recognize: `ITEM_LOGIN_REQUIRED` = run the link flow; `PRODUCT_NOT_READY` = retry after the initial pull settles.

## Conventions

- Server-side code binds to 127.0.0.1 — this app is local-only, single-user, no auth by design.
- Money display: `amount > 0` = outflow, `amount < 0` = inflow (Plaid convention).
- `.gitignore` already covers all data/secrets; keep it that way.
