import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliEntrypoint = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');
const tempDirs: string[] = [];
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

function tempRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rcl-cli-'));
  tempDirs.push(directory);
  execFileSync('git', ['init', '-q'], {
    cwd: directory,
    env: { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice },
  });
  return directory;
}

function runConvergeAttempt(args: string[], cwd = fileURLToPath(new URL('../..', import.meta.url))) {
  return spawnSync(
    process.execPath,
    ['--import', tsxImport, cliEntrypoint, 'converge-attempt', '--json', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      timeout: 10_000,
    }
  );
}

function runCli(args: string[], cwd = fileURLToPath(new URL('../..', import.meta.url))) {
  return spawnSync(process.execPath, ['--import', tsxImport, cliEntrypoint, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('converge-attempt CLI', () => {
  it('accepts the deprecated cap option as an ignored compatibility no-op', () => {
    const repository = tempRepository();
    const first = runConvergeAttempt(
      ['--target', 'rcl-test', '--max-attempts', '1'],
      repository
    );
    const second = runConvergeAttempt(
      ['--target', 'rcl-test', '--max-attempts', '0'],
      repository
    );

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ attempt: 1, attemptsUsed: 1 });
    expect(JSON.parse(second.stdout)).toMatchObject({ attempt: 2, attemptsUsed: 2 });
    expect(JSON.parse(second.stdout)).not.toHaveProperty('cap');
  });

  it('accepts the deprecated cap option without a value', () => {
    const repository = tempRepository();
    const result = runConvergeAttempt(['--target', 'rcl-test', '--max-attempts'], repository);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ attempt: 1, attemptsUsed: 1 });
  });

  it('emits structured JSON and exit 3 when the target is missing', () => {
    const result = runConvergeAttempt([]);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'RCL_CONVERGE_ATTEMPT_STATE',
        message: '--target is required.',
      },
    });
  });

  it('emits structured JSON when the target option has no value', () => {
    const result = runConvergeAttempt(['--target']);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'RCL_CONVERGE_ATTEMPT_STATE',
        message: '--target is required.',
      },
    });
  });

  it('emits exit 0 for every persisted claim without a cap field', () => {
    const repository = tempRepository();
    const claimed = runConvergeAttempt(['--target', 'rcl-cli-test'], repository);

    expect(claimed.status).toBe(0);
    expect(claimed.stderr).toBe('');
    expect(JSON.parse(claimed.stdout)).toMatchObject({
      target: 'rcl-cli-test',
      attempt: 1,
      attemptsUsed: 1,
    });
    expect(JSON.parse(claimed.stdout)).not.toHaveProperty('cap');

    const next = runConvergeAttempt(['--target', 'rcl-cli-test'], repository);
    expect(next.status).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({ attempt: 2, attemptsUsed: 2 });
  });

  it('does not advertise a numerical stopping option', () => {
    const help = runCli(['converge-attempt', '--help']);

    expect(help.status).toBe(0);
    expect(help.stdout).not.toContain('--max-attempts');
    expect(help.stdout).not.toMatch(/cap|budget/i);
  });
});

describe('converge-report CLI', () => {
  it('accepts the deprecated round option as an ignored no-op above 99', () => {
    const repository = tempRepository();
    const report = join(repository, 'report.json');
    writeFileSync(report, `${JSON.stringify({ findings: [] })}\n`);

    const result = runCli(
      [
        'converge-report',
        '--json',
        '--target',
        'rcl-cli-report',
        '--report',
        report,
        '--round',
        '100',
        '--max-rounds',
        '2',
      ],
      repository
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ target: 'rcl-cli-report', round: 100 });
    expect(JSON.parse(result.stdout)).not.toHaveProperty('roundCap');
  });

  it('does not advertise a numerical stopping option', () => {
    const help = runCli(['converge-report', '--help']);

    expect(help.status).toBe(0);
    expect(help.stdout).not.toContain('--max-rounds');
    expect(help.stdout).not.toMatch(/cap/i);
  });
});
