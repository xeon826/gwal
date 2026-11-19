// Repo-root resolution: Next's standalone server runs with cwd = .next/standalone,
// but data/secrets live in the repo root. The gatekeeper exports GWAL_ROOT
// explicitly; the walk-up (looking for plaid-token.json) is the fallback.
import fs from 'node:fs';
import path from 'node:path';

function repoRoot(): string {
  if (process.env.GWAL_ROOT && fs.existsSync(process.env.GWAL_ROOT)) return process.env.GWAL_ROOT;
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'plaid-token.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export const ROOT = repoRoot();
