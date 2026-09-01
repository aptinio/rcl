import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  convergeRunStatePath,
  processRoundReport,
  recordVerdicts,
  loadConvergeRunState,
  ConvergeRunStateError,
  withRunStateLock,
} from '../../src/converge/run-state.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rcl-runstate-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function finding(over: Partial<ConsensusFinding> & { models?: string[] } = {}): ConsensusFinding {
  const { models = ['m1'], ...rest } = over;
  return {
    id: 'x',
    file: 'src/a.ts',
    startLine: 10,
    endLine: 14,
    severity: 'important',
    category: 'correctness',
    title: 'possible bug',
    description: 'desc',
    consensus: {
      score: models.length,
      total: 3,
      models,
      roles: ['general'],
      crossRole: false,
      crossModel: models.length >= 2,
      elevated: false,
      elevation: 'none',
      confidence: 0.5,
      confidenceLabel: 'Medium',
      tier: models.length >= 2 ? 'majority' : 'single',
    },
    gating: { reason: models.length >= 2 ? 'consensus' : 'verified' },
    ...rest,
  };
}

describe('round telemetry (RCL-35)', () => {
  it('returns a persisted result with a warning when only lock release fails', async () => {
    const result = await withRunStateLock(dir, 'release-warning', async () => {
      await rm(`${convergeRunStatePath(dir, 'release-warning')}.lock`);
      return { persisted: true };
    });

    expect(result).toMatchObject({
      persisted: true,
      warning: expect.stringContaining('persisted'),
    });
  });

  it('accepts contiguous rounds beyond the former default and hard boundaries', async () => {
    for (let round = 1; round <= 101; round++) {
      await processRoundReport({
        gitCommonDir: dir,
        target: 't1',
        round,
        findings: [finding()],
      });
    }
    const state = await loadConvergeRunState(dir, 't1');
    expect(state?.rounds).toHaveLength(101);
    expect(state?.rounds.at(-1)?.round).toBe(101);
  });

  it('loads historical state containing a round cap and continues uncapped in place', async () => {
    const stateFile = convergeRunStatePath(dir, 'historical');
    await mkdir(join(dir, 'rcl-converge-runs'), { recursive: true });
    await writeFile(
      stateFile,
      `${JSON.stringify({
        version: 1,
        target: 'historical',
        roundCap: 15,
        rounds: Array.from({ length: 99 }, (_, index) => ({
          round: index + 1,
          counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 },
        })),
        findings: {},
        updatedAt: '2026-08-15T12:00:00Z',
      })}\n`
    );

    await expect(
      processRoundReport({
        gitCommonDir: dir,
        target: 'historical',
        round: 100,
        findings: [],
      })
    ).resolves.toMatchObject({ counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } });
    const state = await loadConvergeRunState(dir, 'historical');
    expect(state?.roundCap).toBe(15);
    expect(state?.rounds).toHaveLength(100);
    expect(state?.rounds.at(-1)?.round).toBe(100);
  });

  it('retains strict contiguous sequencing above the former hard boundary', async () => {
    await processRoundReport({ gitCommonDir: dir, target: 'ordered-high', round: 100, findings: [] });
    await expect(
      processRoundReport({
        gitCommonDir: dir,
        target: 'ordered-high',
        round: 102,
        findings: [],
      })
    ).rejects.toThrow(ConvergeRunStateError);
  });

  it('atomically persists concurrent re-reports above the former hard boundary', async () => {
    await processRoundReport({ gitCommonDir: dir, target: 'concurrent-high', round: 100, findings: [] });
    const reports = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        processRoundReport({
          gitCommonDir: dir,
          target: 'concurrent-high',
          round: 100,
          findings: [
            finding({
              startLine: index * 20 + 1,
              endLine: index * 20 + 2,
              title: `concurrent finding ${index}`,
            }),
          ],
        })
      )
    );

    expect(reports.every((report) => report.status === 'fulfilled')).toBe(true);
    const state = await loadConvergeRunState(dir, 'concurrent-high');
    expect(state?.rounds).toEqual([
      { round: 100, counts: { new: 1, repeat: 0, suppressed: 0, regating: 0 } },
    ]);
    expect(Object.keys(state?.findings ?? {})).toHaveLength(20);
  });
});

describe('round ordering and re-runs (RCL-24)', () => {
  it('re-running the current round keeps its findings classified as new', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 'rr1',
      round: 1,
      findings: [finding()],
    });
    expect(r1.counts.new).toBe(1);
    const rerun = await processRoundReport({
      gitCommonDir: dir,
      target: 'rr1',
      round: 1,
      findings: [finding()],
    });
    expect(rerun.counts).toMatchObject({ new: 1, repeat: 0, suppressed: 0 });
    expect(rerun.findings[0]!.status).toBe('new');
  });

  it('rejects backfilling an earlier round or skipping ahead', async () => {
    await processRoundReport({ gitCommonDir: dir, target: 'rr2', round: 1, findings: [] });
    await processRoundReport({ gitCommonDir: dir, target: 'rr2', round: 2, findings: [] });
    await expect(
      processRoundReport({ gitCommonDir: dir, target: 'rr2', round: 1, findings: [] })
    ).rejects.toThrow(ConvergeRunStateError);
    // Round 3 would be next; there is no recorded round 3 yet, so 4 skips.
    await expect(
      processRoundReport({ gitCommonDir: dir, target: 'rr2', round: 4, findings: [] })
    ).rejects.toThrow(ConvergeRunStateError);
  });

  it('a fresh state adopts a high mid-run round from a resumed pre-upgrade ledger', async () => {
    const r = await processRoundReport({
      gitCommonDir: dir,
      target: 'rr3',
      round: 100,
      findings: [finding()],
    });
    expect(r.counts.new).toBe(1);
  });

  it('updates the stored span to the latest sighting so drift does not decay matching', async () => {
    await processRoundReport({
      gitCommonDir: dir,
      target: 'rr4',
      round: 1,
      findings: [finding({ startLine: 10, endLine: 14 })],
    });
    await processRoundReport({
      gitCommonDir: dir,
      target: 'rr4',
      round: 2,
      findings: [finding({ startLine: 13, endLine: 17 })],
    });
    const state = await loadConvergeRunState(dir, 'rr4');
    const entry = Object.values(state!.findings)[0]!;
    expect(entry.startLine).toBe(13);
    expect(entry.endLine).toBe(17);
  });
});

describe('intra-round identity (RCL-24)', () => {
  it('near-duplicates within one report share one identity even across bucket boundaries', async () => {
    const r = await processRoundReport({
      gitCommonDir: dir,
      target: 'ir1',
      round: 1,
      findings: [
        finding({ startLine: 9, endLine: 10 }),
        finding({ startLine: 11, endLine: 12, title: 'other phrasing' }),
      ],
    });
    expect(r.findings[0]!.identity).toBe(r.findings[1]!.identity);
  });

  it('non-overlapping findings sharing a line bucket keep separate identities', async () => {
    const r = await processRoundReport({
      gitCommonDir: dir,
      target: 'ir2',
      round: 1,
      findings: [
        finding({ startLine: 40, endLine: 41 }),
        finding({ startLine: 49, endLine: 49, title: 'unrelated thing nearby' }),
      ],
    });
    expect(r.findings[0]!.identity).not.toBe(r.findings[1]!.identity);
    expect(r.counts.new).toBe(2);
  });
});

describe('cross-round identity and suppression (RCL-24)', () => {
  it('classifies first sightings as new and later sightings as repeat', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 't2',
      round: 1,
      findings: [finding()],
    });
    expect(r1.counts).toMatchObject({ new: 1, repeat: 0, suppressed: 0 });

    const r2 = await processRoundReport({
      gitCommonDir: dir,
      target: 't2',
      round: 2,
      findings: [finding({ title: 'entirely different phrasing of the same thing' })],
    });
    expect(r2.counts).toMatchObject({ new: 0, repeat: 1, suppressed: 0 });
    expect(r2.findings[0]!.identity).toBe(r1.findings[0]!.identity);
  });

  it('suppresses re-findings of dismissed findings without new corroboration', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 't3',
      round: 1,
      findings: [finding({ models: ['m1'] })],
    });
    await recordVerdicts({
      gitCommonDir: dir,
      target: 't3',
      round: 1,
      verdicts: [{ key: r1.findings[0]!.identity, verdict: 'dismissed', reason: 'guard exists' }],
    });

    const r2 = await processRoundReport({
      gitCommonDir: dir,
      target: 't3',
      round: 2,
      findings: [finding({ models: ['m2'] })],
    });
    expect(r2.counts.suppressed).toBe(1);
    expect(r2.findings[0]!.status).toBe('suppressed');
    expect(r2.findings[0]!.suppressReason).toMatch(/dismissed/i);
  });

  it('keeps a dismissal terminal under fresh corroboration; only escalation to critical re-gates (RCL-30)', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 't4',
      round: 1,
      findings: [finding({ models: ['m1'] })],
    });
    await recordVerdicts({
      gitCommonDir: dir,
      target: 't4',
      round: 1,
      verdicts: [{ key: r1.findings[0]!.identity, verdict: 'dismissed', reason: 'not applicable' }],
    });

    // Fresh ≥2-model corroboration on the same evidence: stays suppressed —
    // this is exactly the popular-false-positive treadmill (allocator-one#7774).
    const r2 = await processRoundReport({
      gitCommonDir: dir,
      target: 't4',
      round: 2,
      findings: [finding({ models: ['m1', 'm2'], gating: { reason: 'consensus' } })],
    });
    expect(r2.findings[0]!.status).toBe('suppressed');
    expect(r2.findings[0]!.suppressReason).toMatch(/terminal/i);
    expect(r2.counts.regating).toBe(0);

    // Escalation past the dismissed severity is genuinely new evidence.
    const r3 = await processRoundReport({
      gitCommonDir: dir,
      target: 't4',
      round: 3,
      findings: [
        finding({ models: ['m3'], severity: 'critical', gating: { reason: 'critical' } }),
      ],
    });
    expect(r3.findings[0]!.status).toBe('regating');

    // Re-dismissing at critical makes even critical sightings terminal.
    await recordVerdicts({
      gitCommonDir: dir,
      target: 't4',
      round: 3,
      verdicts: [
        { key: r3.findings[0]!.identity, verdict: 'dismissed', reason: 'critical is by design' },
      ],
    });
    const r4 = await processRoundReport({
      gitCommonDir: dir,
      target: 't4',
      round: 4,
      findings: [
        finding({ models: ['m1', 'm2', 'm3'], severity: 'critical', gating: { reason: 'critical' } }),
      ],
    });
    expect(r4.findings[0]!.status).toBe('suppressed');
  });

  it('resolves a dismissal-only round as converged and a fixing round as pending (RCL-30)', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 't4r',
      round: 1,
      findings: [
        finding({ models: ['m1', 'm2'] }),
        finding({ models: ['m1'], startLine: 100, endLine: 104, title: 'other bug' }),
      ],
    });
    const keys = r1.findings.map((f) => f.identity);

    // First verdict alone: the round still has an untriaged gating identity.
    const partial = await recordVerdicts({
      gitCommonDir: dir,
      target: 't4r',
      round: 1,
      verdicts: [{ key: keys[0]!, verdict: 'dismissed', reason: 'by design' }],
    });
    expect(partial.resolution?.status).toBe('unresolved');
    expect(partial.resolution?.unresolved).toEqual([keys[1]!]);

    // Dismissing the rest with nothing fixed: the round converges outright.
    const done = await recordVerdicts({
      gitCommonDir: dir,
      target: 't4r',
      round: 1,
      verdicts: [{ key: keys[1]!, verdict: 'dismissed', reason: 'false positive' }],
    });
    expect(done.resolution?.status).toBe('converged-dismissal-only');
    expect(done.resolution?.actionable).toBe(2);

    // A fix flips the round to pending: the reviewed patch changed.
    const fixed = await recordVerdicts({
      gitCommonDir: dir,
      target: 't4r',
      round: 1,
      verdicts: [{ key: keys[1]!, verdict: 'fixed' }],
    });
    expect(fixed.resolution?.status).toBe('fixes-pending-fresh-round');
  });

  it('makes no resolution claim for verdicts recorded against an older round', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 't4o',
      round: 1,
      findings: [finding()],
    });
    await processRoundReport({ gitCommonDir: dir, target: 't4o', round: 2, findings: [] });
    const result = await recordVerdicts({
      gitCommonDir: dir,
      target: 't4o',
      round: 1,
      verdicts: [{ key: r1.findings[0]!.identity, verdict: 'dismissed' }],
    });
    expect(result.resolution).toBeUndefined();
  });

  it('persists per-round counts and verdicts in the state file', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 't5',
      round: 1,
      findings: [finding()],
    });
    await recordVerdicts({
      gitCommonDir: dir,
      target: 't5',
      round: 1,
      verdicts: [{ key: r1.findings[0]!.identity, verdict: 'fixed' }],
    });
    const state = await loadConvergeRunState(dir, 't5');
    expect(state!.rounds).toHaveLength(1);
    expect(state!.rounds[0]!.counts).toMatchObject({ new: 1 });
    const entry = Object.values(state!.findings)[0]!;
    expect(entry.verdict).toBe('fixed');
    expect(entry.verdictRound).toBe(1);
  });
});
