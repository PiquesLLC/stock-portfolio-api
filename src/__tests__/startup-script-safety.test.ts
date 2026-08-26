import { describe, it, expect } from 'vitest';
import { createClient } from '@libsql/client';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The startup script must never hand JavaScript to bash.
 *
 * On 2026-08-26 production proved why. scripts/start.sh carried a large
 * double-quoted `node -e "..."` block, and one comment inside it mentioned
 * `prisma migrate deploy` in backticks. Bash performs command substitution
 * inside double quotes, so every boot:
 *
 *   1. ran prisma migrate deploy as a side effect of a COMMENT,
 *   2. spliced its multi-line stdout into the JavaScript source,
 *   3. killed the script with SyntaxError before one statement executed,
 *   4. and hid all of it behind `2>&1 || true`.
 *
 * The critical-table repair block therefore had not run since 2026-05-27, and a
 * schema migration was applied by an invocation nobody knew existed.
 *
 * These tests pin the three properties that make that impossible to reintroduce.
 */

const REPO = path.join(__dirname, '..', '..');
const START_SH = path.join(REPO, 'scripts', 'start.sh');
const ENSURE = path.join(REPO, 'scripts', 'ensure-critical-tables.cjs');

const posix = (p: string) => p.split(path.sep).join('/');
const readStart = () => fs.readFileSync(START_SH, 'utf8');
const isComment = (line: string) => /^\s*#/.test(line);

/** Inline `node -e "` blocks that bash actually executes (comments excluded). */
function inlineNodeBlocks(source: string): Array<{ openLine: number; body: string[] }> {
  const lines = source.split('\n');
  const blocks: Array<{ openLine: number; body: string[] }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (isComment(lines[i]) || !/^\s*node -e "\s*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*"(\s|$)/.test(lines[j])) j++;
    blocks.push({ openLine: i + 1, body: lines.slice(i + 1, j) });
  }
  return blocks;
}

/** migrate-deploy invocations that actually run: not comments, not echo text. */
function executedMigrateDeploys(source: string): string[] {
  return source
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !isComment(line))
    .filter(({ line }) => /(npx\s+)?prisma\s+migrate\s+deploy/
      .test(line.replace(/echo\s+"[^"]*"/g, '').replace(/echo\s+'[^']*'/g, '')))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

/**
 * Runs a shell snippet under bash with a sentinel-firing command available, and
 * reports whether command substitution happened.
 *
 * The fixture text is identical in both directions; only the DELIVERY mechanism
 * changes. That is the whole point: it is not the backticks that are dangerous,
 * it is embedding the source in a double-quoted shell string.
 */
function runFixture(mode: 'inline' | 'file'): { substituted: boolean; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-safety-'));
  const sentinel = posix(path.join(dir, 'substitution-happened'));
  const scriptBody = [
    'const ok = true;',
    `// \`touch ${sentinel} && echo injected-line-one && echo injected-line-two\` fails for any reason:`,
    "console.log('fixture ran', ok);",
  ].join('\n');

  const shell = mode === 'inline'
    ? `node -e "\n${scriptBody}\n" 2>&1 || true`
    : (() => {
      const f = path.join(dir, 'fixture.cjs');
      fs.writeFileSync(f, scriptBody, 'utf8');
      return `node "${posix(f)}" 2>&1 || true`;
    })();

  const res = spawnSync('bash', ['-c', shell], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
  if (res.error) throw new Error(`bash is required for this test: ${res.error.message}`);
  // The fixture mirrors production and carries `2>&1`, so Node's SyntaxError
  // arrives on stdout. Reading only stderr here would have made the control
  // test pass for the wrong reason.
  return {
    substituted: fs.existsSync(path.join(dir, 'substitution-happened')),
    output: String(res.stdout ?? '') + String(res.stderr ?? ''),
  };
}

describe('startup script shell-safety', () => {
  it('ensure-critical-tables.cjs parses as a standalone Node script', () => {
    expect(() => execFileSync('node', ['--check', ENSURE], { cwd: REPO, timeout: 60_000 })).not.toThrow();
  });

  it('ensure-critical-tables.cjs executes standalone, exits 0, and creates the tables', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-tables-'));
    const file = path.join(dir, 'ensure.db');
    const res = spawnSync('node', [ENSURE], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, DATABASE_URL: `file:${posix(file)}` },
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('[Startup] Critical tables ensured');
    expect(res.stdout).toContain('[EnsureTables] complete');

    const db = createClient({ url: `file:${posix(file)}` });
    const rows = (await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )).rows.map((r) => String(r.name));
    await db.close();

    // Exactly the four tables this block owns. The ledger/payout operations
    // target tables migrations create, and stay non-fatal when absent.
    expect(rows).toEqual(['PendingEmailChange', 'RefreshRotationCache', 'UserBlock', 'ValueRadarCache']);
  });

  it('is idempotent across repeated boots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-idem-'));
    const env = { ...process.env, DATABASE_URL: `file:${posix(path.join(dir, 'twice.db'))}` };
    const first = spawnSync('node', [ENSURE], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env });
    const second = spawnSync('node', [ENSURE], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('[Startup] Critical tables ensured');
  });

  /**
   * CONTROL. If this fails, every other substitution assertion below is
   * meaningless — a harness that cannot observe the bug cannot prove its
   * absence. This is the exact production defect, reproduced.
   */
  it('CONTROL: the same fixture inlined in node -e IS command-substituted by bash', () => {
    const { substituted, output } = runFixture('inline');
    expect(substituted).toBe(true);
    expect(output).toMatch(/SyntaxError/);
    expect(output).not.toContain('fixture ran');
  });

  it('backticks in a file-delivered script cannot cause command substitution', () => {
    const { substituted, output } = runFixture('file');
    expect(substituted).toBe(false);
    expect(output).not.toMatch(/SyntaxError/);
    expect(output).toContain('fixture ran');
  });

  it('ensure-critical-tables.cjs still contains backticks, so the property is load-bearing', () => {
    // If this ever goes to zero the file-delivery test stops proving anything,
    // because there would be nothing left for bash to substitute.
    expect(fs.readFileSync(ENSURE, 'utf8')).toContain('`prisma migrate deploy`');
  });

  it('start.sh invokes the repair as a file, never by embedding its source', () => {
    const source = readStart();
    expect(source).toMatch(/^node scripts\/ensure-critical-tables\.cjs$/m);

    // The ledger-idempotency backfill is unique to the extracted block, so it is
    // the honest marker that the block is gone. (UserBlock DDL also appears in
    // the separate migrate-deploy FAILURE fallback, which is out of scope here.)
    for (const block of inlineNodeBlocks(source)) {
      expect(block.body.join('\n')).not.toContain('creator_wallet_ledger_creator_desc_unique');
    }
  });

  it('start.sh does not hide the repair failure behind || true', () => {
    const source = readStart();
    const invocation = source.split('\n').findIndex((l) => /^node scripts\/ensure-critical-tables\.cjs$/.test(l));
    expect(invocation).toBeGreaterThan(-1);
    expect(source.split('\n')[invocation]).not.toContain('|| true');
    expect(source).toContain('ensure_status=$?');
  });

  it('no executable node -e block in start.sh contains a backtick or shell expansion', () => {
    for (const block of inlineNodeBlocks(readStart())) {
      const offenders = block.body.filter((l) => l.includes('`') || /\$(?!\?)/.test(l));
      expect(
        offenders,
        `node -e block opening at start.sh:${block.openLine} is shell-interpolated`,
      ).toEqual([]);
    }
  });

  it('start.sh executes prisma migrate deploy exactly once', () => {
    expect(executedMigrateDeploys(readStart())).toHaveLength(1);
  });

  it('start.sh no longer resolves 20260320_add_appeals as applied', () => {
    const executable = readStart().split('\n').filter((l) => !isComment(l)).join('\n');
    expect(executable).not.toMatch(/migrate resolve --applied 20260320_add_appeals/);
  });

  it('start.sh is valid bash', () => {
    const res = spawnSync('bash', ['-n', START_SH], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
    if (res.error) throw new Error(`bash is required for this test: ${res.error.message}`);
    expect(res.status).toBe(0);
  });
});
