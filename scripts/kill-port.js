#!/usr/bin/env node
// Kills any process listening on the configured port before starting the dev server.
// Prevents zombie nodemon/ts-node processes from accumulating across restarts.

const { execSync } = require('child_process');

const PORT = process.env.PORT || 3001;
const MAX_WAIT_MS = 5000;

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
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid) => pid && pid !== '0')
    ));
  } catch {
    return [];
  }
}

const pids = getListeningPids(PORT);

for (const pid of pids) {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    console.log(`Killed process ${pid} on port ${PORT}`);
  } catch {
    // Process may have already exited.
  }
}

if (pids.length > 0) {
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
