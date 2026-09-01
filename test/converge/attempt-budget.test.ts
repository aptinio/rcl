import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  claimConvergeAttempt,
  ConvergeAttemptStateError,
  convergeAttemptStatePath,
  loadConvergeAttemptState,
  resolveGitCommonDir,
} from '../../src/converge/attempt-budget.js';

const dirs: string[] = [];
const claimWorker = fileURLToPath(new URL('../fixtures/converge-claim-worker.ts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const isolatedGitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: nullDevice,
  GIT_CONFIG_SYSTEM: nullDevice,
};

async function tempGitDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-attempt-budget-'));
  dirs.push(dir);
  return dir;
}

async function exitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  if (pid === undefined) throw new Error('Child process did not receive a PID');
  await once(child, 'exit');
  return pid;
}

async function runClaimProcess(gitCommonDir: string, target: string) {
  const child = spawn(
    process.execPath,
    ['--import', tsxImport, claimWorker, gitCommonDir, target],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 10_000 }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [status, signal] = (await once(child, 'close')) as [number | null, string | null];
  if (status === null) {
    throw new Error(
      `Claim worker terminated by ${signal ?? 'an unknown signal'}${stderr ? `: ${stderr}` : ''}`
    );
  }
  return { status, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('convergence attempt telemetry', () => {
  it('persists every claimed attempt under the common Git directory', async () => {
    const gitCommonDir = await tempGitDir();

    const first = await claimConvergeAttempt({
      gitCommonDir,
      target: 'rcl-18',
      now: () => new Date('2026-08-15T12:00:00Z'),
      recordPid: 101,
    });
    const second = await claimConvergeAttempt({
      gitCommonDir,
      target: 'rcl-18',
      now: () => new Date('2026-08-15T12:01:00Z'),
      recordPid: 202,
    });

    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    const state = await loadConvergeAttemptState(gitCommonDir, 'rcl-18');
    expect(state).toMatchObject({
      target: 'rcl-18',
      migratedAttempts: 0,
      attemptsUsed: 2,
      attempts: [
        { attempt: 1, pid: 101, source: 'claim' },
        { attempt: 2, pid: 202, source: 'claim' },
      ],
    });
    expect(first).not.toHaveProperty('cap');
    expect(second).not.toHaveProperty('cap');
  });

  it('records every claim beyond the former 20-attempt boundary', async () => {
    const gitCommonDir = await tempGitDir();

    for (let attempt = 1; attempt <= 25; attempt++) {
      await expect(claimConvergeAttempt({ gitCommonDir, target: 'repo-7559' })).resolves.toMatchObject({
        attempt,
        attemptsUsed: attempt,
      });
    }

    expect((await loadConvergeAttemptState(gitCommonDir, 'repo-7559'))?.attemptsUsed).toBe(25);
  });

  it('loads historical state containing a cap and continues uncapped in place', async () => {
    const gitCommonDir = await tempGitDir();
    const stateFile = convergeAttemptStatePath(gitCommonDir, 'rcl-18');
    await mkdir(join(gitCommonDir, 'rcl-converge-attempts'), { recursive: true });
    await writeFile(
      stateFile,
      `${JSON.stringify({
        version: 2,
        target: 'rcl-18',
        cap: 1,
        migratedAttempts: 1,
        attemptsUsed: 1,
        attempts: [],
        updatedAt: '2026-08-15T12:00:00Z',
      })}\n`
    );

    const claim = await claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' });
    expect(claim).toMatchObject({ attempt: 2, attemptsUsed: 2, stateFile });
    expect(claim).not.toHaveProperty('cap');
    expect(await loadConvergeAttemptState(gitCommonDir, 'rcl-18')).toMatchObject({
      target: 'rcl-18',
      migratedAttempts: 1,
      attemptsUsed: 2,
      attempts: [expect.objectContaining({ attempt: 2 })],
    });
  });

  it('serializes concurrent starters above the former limit without losing claims', async () => {
    const gitCommonDir = await tempGitDir();
    for (let attempt = 1; attempt <= 20; attempt++) {
      await claimConvergeAttempt({ gitCommonDir, target: 'repo-7559' });
    }
    const claims = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        claimConvergeAttempt({ gitCommonDir, target: 'repo-7559', lockRetryMs: 1 })
      )
    );

    expect(claims.every((claim) => claim.status === 'fulfilled')).toBe(true);
    const attempts = claims
      .filter((claim) => claim.status === 'fulfilled')
      .map((claim) => claim.value.attempt)
      .sort((a, b) => a - b);
    expect(attempts).toEqual(Array.from({ length: 12 }, (_, index) => index + 21));
    expect((await loadConvergeAttemptState(gitCommonDir, 'repo-7559'))?.attemptsUsed).toBe(32);
  });

  it('serializes independent processes above the former limit', async () => {
    const gitCommonDir = await tempGitDir();
    for (let attempt = 1; attempt <= 20; attempt++) {
      await claimConvergeAttempt({ gitCommonDir, target: 'cross-process' });
    }
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runClaimProcess(gitCommonDir, 'cross-process'))
    );

    expect(results.map((result) => result.status)).toEqual([0, 0, 0, 0]);
    expect(results.every((result) => result.stdout)).toBe(true);
    expect(results.every((result) => result.stderr === '')).toBe(true);
    expect((await loadConvergeAttemptState(gitCommonDir, 'cross-process'))?.attemptsUsed).toBe(24);
  });

  it('fails closed when persisted accounting is corrupt', async () => {
    const gitCommonDir = await tempGitDir();
    const stateFile = convergeAttemptStatePath(gitCommonDir, 'rcl-18');
    await mkdir(join(gitCommonDir, 'rcl-converge-attempts'), { recursive: true });
    await writeFile(stateFile, '{"attemptsUsed":0}\n');

    await expect(claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' })).rejects.toBeInstanceOf(
      ConvergeAttemptStateError
    );
  });

  it('fails closed when persisted accounting is not valid JSON', async () => {
    const gitCommonDir = await tempGitDir();
    const stateFile = convergeAttemptStatePath(gitCommonDir, 'rcl-18');
    await mkdir(join(gitCommonDir, 'rcl-converge-attempts'), { recursive: true });
    await writeFile(stateFile, '{"attemptsUsed":');

    await expect(claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' })).rejects.toThrow(
      'refusing to reset attempt accounting'
    );
  });

  it('reclaims an attempt lock owned by a dead process', async () => {
    const gitCommonDir = await tempGitDir();
    const stateFile = convergeAttemptStatePath(gitCommonDir, 'rcl-18');
    const lockFile = `${stateFile}.lock`;
    const token = '00000000-0000-4000-8000-000000000001';
    const deadPid = await exitedChildPid();
    await mkdir(join(gitCommonDir, 'rcl-converge-attempts'), { recursive: true });
    await writeFile(
      lockFile,
      `${JSON.stringify({ pid: deadPid, claimedAt: '2026-08-15T12:00:00Z', token })}\n`
    );

    await expect(
      claimConvergeAttempt({
        gitCommonDir,
        target: 'rcl-18',
        lockTimeoutMs: 100,
        lockRetryMs: 1,
      })
    ).resolves.toMatchObject({ attempt: 1 });
    await expect(readFile(`${lockFile}.stale.${token}`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serializes concurrent stale-lock reclaimers without losing claims', async () => {
    const gitCommonDir = await tempGitDir();
    const stateFile = convergeAttemptStatePath(gitCommonDir, 'rcl-18');
    const lockFile = `${stateFile}.lock`;
    const token = '00000000-0000-4000-8000-000000000002';
    const deadPid = await exitedChildPid();
    await mkdir(join(gitCommonDir, 'rcl-converge-attempts'), { recursive: true });
    await writeFile(
      lockFile,
      `${JSON.stringify({ pid: deadPid, claimedAt: '2026-08-15T12:00:00Z', token })}\n`
    );

    const claims = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        claimConvergeAttempt({
          gitCommonDir,
          target: 'rcl-18',
          lockTimeoutMs: 5_000,
          lockRetryMs: 1,
        })
      )
    );

    expect(claims.every((claim) => claim.status === 'fulfilled')).toBe(true);
    expect((await loadConvergeAttemptState(gitCommonDir, 'rcl-18'))?.attemptsUsed).toBe(12);
    await expect(readFile(`${lockFile}.stale.${token}`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed on an ownerless legacy lock instead of replacing it', async () => {
    const gitCommonDir = await tempGitDir();
    const stateFile = convergeAttemptStatePath(gitCommonDir, 'rcl-18');
    await mkdir(`${stateFile}.lock`, { recursive: true });

    await expect(
      claimConvergeAttempt({
        gitCommonDir,
        target: 'rcl-18',
        lockTimeoutMs: 10,
        lockRetryMs: 1,
      })
    ).rejects.toThrow('move or remove that lock path and retry');
    expect((await lstat(`${stateFile}.lock`)).isDirectory()).toBe(true);
  });

  it('fails closed on a null lock owner without throwing a raw TypeError', async () => {
    const gitCommonDir = await tempGitDir();
    const stateFile = convergeAttemptStatePath(gitCommonDir, 'rcl-18');
    await mkdir(join(gitCommonDir, 'rcl-converge-attempts'), { recursive: true });
    await writeFile(`${stateFile}.lock`, 'null\n');

    await expect(
      claimConvergeAttempt({
        gitCommonDir,
        target: 'rcl-18',
        lockTimeoutMs: 10,
        lockRetryMs: 1,
      })
    ).rejects.toThrow('move or remove that lock path and retry');
  });

  it('does not reclaim a lock owned by a live process', async () => {
    const gitCommonDir = await tempGitDir();
    const stateFile = convergeAttemptStatePath(gitCommonDir, 'rcl-18');
    const lockFile = `${stateFile}.lock`;
    await mkdir(join(gitCommonDir, 'rcl-converge-attempts'), { recursive: true });
    await writeFile(
      lockFile,
      `${JSON.stringify({
        pid: process.pid,
        claimedAt: '2026-08-15T12:00:00Z',
        token: '00000000-0000-4000-8000-000000000003',
      })}\n`
    );

    await expect(
      claimConvergeAttempt({
        gitCommonDir,
        target: 'rcl-18',
        lockTimeoutMs: 10,
        lockRetryMs: 1,
      })
    ).rejects.toThrow('If no live converge-attempt process owns it');
  });

  it('seeds a missing machine counter from an existing evidence ledger', async () => {
    const gitCommonDir = await tempGitDir();
    await writeFile(
      join(gitCommonDir, 'rcl-converge-repo-42-ledger.md'),
      '# RCL converge ledger — repo-42\n\n## Round 1 — HEAD aaa\n\n## Round 2 — HEAD bbb\n'
    );

    const claim = await claimConvergeAttempt({ gitCommonDir, target: 'repo-42' });

    expect(claim.attempt).toBe(3);
    const state = await loadConvergeAttemptState(gitCommonDir, 'repo-42');
    expect(state?.attemptsUsed).toBe(3);
    expect(state?.migratedAttempts).toBe(2);
    expect(state?.attempts).toEqual([
      expect.objectContaining({ attempt: 3, source: 'claim' }),
    ]);
  });

  it('continues from an existing ledger at the former attempt boundary', async () => {
    const gitCommonDir = await tempGitDir();
    await writeFile(
      join(gitCommonDir, 'rcl-converge-repo-42-ledger.md'),
      Array.from(
        { length: 20 },
        (_, index) => `## Round ${index + 1} — HEAD abc`
      ).join('\n')
    );

    await expect(claimConvergeAttempt({ gitCommonDir, target: 'repo-42' })).resolves.toMatchObject({
      attempt: 21,
      attemptsUsed: 21,
    });
    expect((await loadConvergeAttemptState(gitCommonDir, 'repo-42'))?.attemptsUsed).toBe(21);
  });

  it('continues from an existing ledger above the former attempt boundary', async () => {
    const gitCommonDir = await tempGitDir();
    await writeFile(
      join(gitCommonDir, 'rcl-converge-repo-42-ledger.md'),
      '# RCL converge ledger\n\n## Round 25 — HEAD abc\n'
    );

    await expect(claimConvergeAttempt({ gitCommonDir, target: 'repo-42' })).resolves.toMatchObject({
      attempt: 26,
      attemptsUsed: 26,
    });
    expect(await loadConvergeAttemptState(gitCommonDir, 'repo-42')).toMatchObject({
      migratedAttempts: 25,
      attemptsUsed: 26,
      attempts: [expect.objectContaining({ attempt: 26 })],
    });
  });

  it('hashes an untrusted target instead of allowing it to escape the state directory', async () => {
    const gitCommonDir = await tempGitDir();
    const claim = await claimConvergeAttempt({ gitCommonDir, target: '../../outside target' });

    expect(claim.stateFile.startsWith(join(gitCommonDir, 'rcl-converge-attempts'))).toBe(true);
    expect(claim.stateFile).not.toContain('../');
  });

  it('resolves the current repository common Git directory', async () => {
    await expect(resolveGitCommonDir()).resolves.toMatch(/\.git$/);
  });

  it('shares persisted accounting across linked worktrees', async () => {
    const root = await tempGitDir();
    const repository = join(root, 'repository');
    const worktree = join(root, 'worktree');
    execFileSync('git', ['init', '-q', repository], { env: isolatedGitEnv });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=RCL Test',
        '-c',
        'user.email=rcl@example.test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${nullDevice}`,
        'commit',
        '--allow-empty',
        '-qm',
        'seed',
      ],
      { cwd: repository, env: isolatedGitEnv }
    );
    execFileSync('git', ['worktree', 'add', '-qb', 'linked-test', worktree], {
      cwd: repository,
      env: isolatedGitEnv,
    });

    const repositoryCommonDir = await resolveGitCommonDir(repository);
    const worktreeCommonDir = await resolveGitCommonDir(worktree);
    expect(worktreeCommonDir).toBe(repositoryCommonDir);

    await claimConvergeAttempt({ gitCommonDir: repositoryCommonDir, target: 'repo-42' });
    await claimConvergeAttempt({ gitCommonDir: worktreeCommonDir, target: 'repo-42' });
    expect((await loadConvergeAttemptState(repositoryCommonDir, 'repo-42'))?.attemptsUsed).toBe(2);
  });
});
