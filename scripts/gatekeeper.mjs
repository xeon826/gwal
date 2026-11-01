// Lightweight on-demand supervisor for the gwal dashboard.
// Always-on: ~10-20MB. Spawns the Next.js standalone server only when
// the dashboard URL is visited, and tears it down after an idle timeout.
//
// Env:
//   GWAL_PUBLIC_PORT  — port this proxy listens on (default 3100)
//   GWAL_INTERNAL_PORT— port the Next server binds (default 3101)
//   GWAL_IDLE_MS      — idle teardown, default 10 min
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_PORT = Number(process.env.GWAL_PUBLIC_PORT || 3100);
const INTERNAL_PORT = Number(process.env.GWAL_INTERNAL_PORT || 3101);
const IDLE_MS = Number(process.env.GWAL_IDLE_MS || 10 * 60 * 1000);
const NEXT_SERVER = path.join(ROOT, '.next', 'standalone', 'server.js');

let child = null;
let lastRequest = 0;
let idleTimer = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function startApp() {
  if (child) return child;
  log('starting Next.js standalone server on :' + INTERNAL_PORT);
  child = spawn(process.execPath, [NEXT_SERVER], {
    cwd: path.dirname(NEXT_SERVER),
    env: { ...process.env, PORT: String(INTERNAL_PORT), HOSTNAME: '127.0.0.1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code, sig) => {
    log('next server exited', { code, sig });
    child = null;
  });
  return child;
}

function scheduleIdleCheck() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (Date.now() - lastRequest >= IDLE_MS && child) {
      log('idle for ' + IDLE_MS / 1000 + 's, stopping Next.js server');
      child.kill('SIGTERM');
      // Hard stop fallback if it ignores SIGTERM.
      setTimeout(() => { if (child) child.kill('SIGKILL'); }, 5000).unref();
    } else if (child) {
      scheduleIdleCheck();
    }
  }, IDLE_MS);
  idleTimer.unref();
}

function wakingUpPage(res) {
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '2' });
  res.end(`<!doctype html><meta http-equiv="refresh" content="2">
<title>gwal — waking up</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee">
<p>gwal is waking up…</p>
</body>`);
}

const proxy = http.createServer((req, res) => {
  lastRequest = Date.now();
  if (child) scheduleIdleCheck();

  const upstream = http.request(
    { host: '127.0.0.1', port: INTERNAL_PORT, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    // Next not up yet (cold boot) or crashed — show waking page and (re)start it.
    if (!res.headersSent) wakingUpPage(res); else res.end();
    startApp();
    scheduleIdleCheck();
  });
  req.pipe(upstream);
});

proxy.listen(PUBLIC_PORT, '127.0.0.1', () => {
  log(`gatekeeper listening on http://127.0.0.1:${PUBLIC_PORT} (idle teardown ${IDLE_MS / 1000}s)`);
});
