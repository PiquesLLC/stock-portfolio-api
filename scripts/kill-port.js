#!/usr/bin/env node
// Kills any process listening on port 3001 before starting the dev server
// Prevents zombie nodemon/ts-node processes from accumulating

const { execSync } = require('child_process');
const PORT = process.env.PORT || 3001;

try {
  const result = execSync(`netstat -ano | findstr ":${PORT}" | findstr "LISTENING"`, { encoding: 'utf8' });
  const lines = result.trim().split('\n');
  const pids = new Set();

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && pid !== '0') pids.add(pid);
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      console.log(`Killed process ${pid} on port ${PORT}`);
    } catch {
      // Process may have already exited
    }
  }

  if (pids.size > 0) {
    console.log(`Cleaned up ${pids.size} process(es) on port ${PORT}`);
  }
} catch {
  // No process on port — nothing to kill
}
