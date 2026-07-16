#!/usr/bin/env node
// Kills any process listening on the configured port before starting the dev server.
// Prevents zombie nodemon/ts-node processes from accumulating across restarts.
//
// Guard: if the listener answers HTTP on /health it is a live API — most likely
// the pm2-managed "nala-api" — and killing it causes a silent ~24s outage plus a
// "Request failed" toast storm in any open UI (bitten 2026-07-14 and twice
// 2026-07-16). In that case abort the dev launch instead of killing. Only
// unresponsive zombies get cleaned up automatically. KILL_PORT_FORCE=1 overrides.

const { execSync } = require('child_process');
const http = require('http');

const PORT = process.env.PORT || 3001;
const MAX_WAIT_MS = 5000;
const FORCE = process.env.KILL_PORT_FORCE === '1';

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getListeningPids(port) {
  try {
    const result = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: 'utf8' });
    return Array.from(new Set(
      result
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        // findstr ":3001" also matches ":30011" — require an exact port on the local address
        .filter((cols) => cols[1] && cols[1].endsWith(`:${port}`))
        .map((cols) => cols.pop())
        .filter((pid) => pid && pid !== '0')
    ));
  } catch {
    return [];
  }
}

function respondsOnHealth(port) {
  return new Promise((resolve) => {
    // 'localhost' (not 127.0.0.1) so Node's family autoselection reaches both
    // IPv4-only and IPv6-only binds — misreading a live server as a zombie here
    // would get it killed.
    const req = http.get({ host: 'localhost', port, path: '/health', timeout: 3000 }, (res) => {
      res.resume();
      res.on('error', () => resolve(false));
      resolve(true); // any HTTP response means a live server, not a zombie
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function main() {
  const pids = getListeningPids(PORT);
  if (pids.length === 0) return;

  if (!FORCE && (await respondsOnHealth(PORT))) {
    console.error(
      `[kill-port] Port ${PORT} is already serving a live API (PID ${pids.join(', ')}) — refusing to kill it.\n` +
      `[kill-port] If it's the pm2-managed server, use "pm2 restart nala-api" instead of a second dev launch.\n` +
      `[kill-port] If it's a genuine orphan (not in "pm2 ls"), rerun with KILL_PORT_FORCE=1.`
    );
    process.exit(1);
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      console.log(`Killed process ${pid} on port ${PORT}`);
    } catch {
      // Process may have already exited.
    }
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (getListeningPids(PORT).length === 0) {
      console.log(`Cleaned up ${pids.length} process(es) on port ${PORT}`);
      process.exit(0);
    }
    sleep(250);
  }
  console.warn(`Port ${PORT} is still busy after ${MAX_WAIT_MS}ms; continuing anyway`);
}

main().catch((err) => {
  // Unexpected failure must not block the dev launch (original contract:
  // "continuing anyway") — only the explicit live-server refusal exits nonzero.
  console.warn(`[kill-port] Unexpected error, continuing anyway: ${err && err.message ? err.message : err}`);
  process.exit(0);
});
