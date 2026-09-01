---
name: rcl-converge
description: Drive the current PR or branch diff to a converged Review Council verdict by looping review → triage → fix → push until a conclusive round converges
argument-hint: "[PR#N] [--roles <roles>] [--spec <path>] [--post-final]"
allowed-tools:
  - Bash(gh pr view:*)
  - Bash(gh pr comment:*)
  - Bash(gh pr merge:*)  # disarming only — see hard rules; the command is `gh pr merge <PR> --disable-auto`
  - Bash(gh auth token:*)
  - Bash(gh repo view:*)
  - Bash(rcl review:*)
  - Bash(rcl converge-attempt:*)
  - Bash(rcl converge-report:*)
  - Bash(rcl converge-verdict:*)
  - Bash(rcl roles:*)
  - Bash(git status:*)
  - Bash(git merge-base:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git rev-parse:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git push:*)
  - Bash(harness show:*)
  - Bash(harness list:*)
  - Bash(npm install -g review-council@latest)
  - Bash(npm test:*)
  - Bash(npm run lint:*)
  - Bash(which rcl)
  - Bash(rm -f /tmp/rcl-*)
  - Write(/tmp/rcl-spec-*.md)
  - Read
  - Edit
{{#codex}}
  - Bash(nohup:*)
  - Bash(kill:*)
  - Bash(cat /tmp/rcl-*)
  - Read(/tmp/rcl-*.log)
{{/codex}}
  - Write
  - Glob
  - Read(/tmp/rcl-*/**)
  - Write(/tmp/rcl-*/**)
  - Bash(mkdir -p /tmp/rcl-*)
  - Bash(mkdir *rcl-converge-*.lock)
  - Bash(rmdir *rcl-converge-*.lock)
  - Bash(chmod 0700 /tmp/rcl-*)
  - Read(/tmp/rcl-report-*.md)
  - Read(/tmp/rcl-report-*.json)
  - Read(/tmp/rcl-converge-*.md)
  - Write(/tmp/rcl-converge-*.md)
---

# Review Council converge (rcl-converge)
{{#codex}}

Invoke as `{{PREFIX}}rcl-converge` in a Codex session.
{{/codex}}

Drive the current PR (or branch diff) to a converged Review Council verdict: loop review → triage → fix → push until a round converges — zero new or regating gating findings, or every gating finding dismissed with nothing fixed (`converged-dismissal-only`). This skill composes the `rcl` skill — each round runs the same review; this skill owns the loop, the triage ledger, and the safety interlocks.

Cost awareness: every attempt is a full multi-model council run. RCL prints a run-specific call/wave estimate; multi-chunk diffs can take much longer than one provider timeout. Attempt and evidence-round counts are telemetry only, but no numerical count, cost, or elapsed-time threshold stops a healthy loop or requires renewed consent. Continue until convergence or a genuine blocker. Reviewer-health requirements, stale-head rejection, process timeouts, authorization, and exact-head quality gates remain unchanged.

Authorization: invoking this skill IS the explicit request for the loop's fix commits (and pushes, in PR mode) — no additional mid-loop approval is sought for those edits. This satisfies repository profiles that otherwise require asking before committing. A standing "do not commit" or "do not push" instruction still wins: do not start the loop while one is active.

## Flags

- `PR#N` / `#N` / `N` — converge a specific PR (default: current branch's PR, else local diff mode)
- `--roles <list>`, `--spec <path>` — passed through to every round's review
- `--post-final` — after convergence, post a summary comment to the PR (never posts mid-loop)

## Steps

### 0. Private artifact directory

All temporary artifacts below (patches, specs, reports, logs, PID files) live under `<RCL_TMP>` = `/tmp/rcl-<uid>` (your numeric `id -u`) — never directly in world-writable `/tmp`, where another local user could pre-create, symlink, or tamper with predictable filenames. Create and verify it once per session:

```bash
RCL_TMP=/tmp/rcl-$(id -u); mkdir -p "$RCL_TMP" && [ ! -L "$RCL_TMP" ] && [ -d "$RCL_TMP" ] && [ -O "$RCL_TMP" ] && chmod 0700 "$RCL_TMP"
```

Order matters: the symlink and ownership checks run **before** `chmod`, because a `chmod` on a pre-created symlink would follow it and re-permission someone else's directory before the check could reject it. If any check fails, stop — never write artifacts to a directory you do not exclusively own. `<RCL_TMP>` below is a **textual placeholder**: substitute the resolved path (e.g. `/tmp/rcl-501`) when writing each command, rather than relying on `$RCL_TMP` surviving into a detached or single-quoted shell. Shell-quote every dynamic value that enters a generated command. A tampered report would steer real commits in this loop, so the directory check is load-bearing. The converge ledger is the exception: it lives in the repository's git dir (step 1.5) for durability across sessions.

### 1. Preconditions

1. The working tree must be clean (`git status --porcelain`) — the loop makes commits. If dirty, stop and ask the user to commit or stash first.
2. Resolve the review target, spec, and `rcl` availability exactly as the `rcl` skill does — read `{{DIR}}/skills/rcl/SKILL.md` and follow its steps 1–3. Conventions that differ here:
   - `<TARGET>` is `<repo>-<PR number>` (e.g. `rcl-7`), or `<repo>-<branch>` in local diff mode, with every character outside `[A-Za-z0-9._-]` in either component replaced by `-` — git allows shell metacharacters in branch names, so an unsanitized name interpolated into paths, `rm`, or the detached launch command is an injection vector, and the repo component keeps identical PR numbers or branch names in different repositories from colliding.
   - Report files are round-scoped: `<RCL_TMP>/rcl-report-<TARGET>-r<R>.md` / `.json` for round `<R>`, so rounds never clobber each other.
3. **Verify the checkout matches the PR** (PR mode): the loop commits to the current branch, so the PR's head branch (`gh pr view <PR> --json headRefName -q .headRefName`) must equal `git rev-parse --abbrev-ref HEAD`. On mismatch — typical when an explicit `PR#N` was passed — stop and ask the user to check out the PR's branch first; never fix a PR from a different checkout. The PR must also live in this repository: `gh pr view <PR> --json isCrossRepository` must be false — converge does not drive fork PRs. (A detached HEAD reads as `HEAD` and simply fails the match; that stop is correct.) Also verify local HEAD equals the PR head commit (`gh pr view <PR> --json headRefOid -q .headRefOid` vs `git rev-parse HEAD`): a clean tree can still be ahead of the PR by unpushed commits, and the council would then review — and possibly converge on — code the PR does not contain. If local is ahead, push first; if the histories diverge, stop and ask. The PR must also be OPEN (`gh pr view <PR> --json state -q .state`) — never converge a merged or closed PR.
4. **Disarm auto-merge** (PR mode): check `gh pr view <PR> --json autoMergeRequest`. If armed, run `gh pr merge <PR> --disable-auto` and tell the user why: CI can go green mid-loop, merge a partial squash, auto-delete the branch, and strand later fix pushes on an already-merged PR. Do not re-arm during the loop.
5. **Take the target lock** — after `<TARGET>` is resolved in step 2, never before it. Two converge runs on one target would interleave edits, commits, and ledger writes. Claim `<GIT_DIR>/rcl-converge-<TARGET>.lock` atomically (`mkdir` succeeds only if the directory does not already exist — do not use `-p`, which succeeds unconditionally and defeats the lock). If the claim fails, read the holder's PID from the lock's `owner` file: if that process is gone the lock is stale from a crashed run — remove it, say so, and re-claim. Otherwise report that a live run holds the target and stop. Release the lock (`rmdir`) on every exit path: convergence, precondition failure, review failure, genuine blocker, or user interrupt.
6. Open the ledger `<GIT_DIR>/rcl-converge-<TARGET>-ledger.md`, where `<GIT_DIR>` is `$(git rev-parse --git-common-dir)` — the *common* dir, because `--git-dir` resolves to `.git/worktrees/<name>` inside a linked worktree, which would give every worktree its own private ledger and lock when they must share one per repository. The git dir is durable (the cumulative attempt accounting survives reboots and /tmp cleanup), repo-scoped, and not world-writable — a /tmp ledger could be pre-seeded by another local user to mark real findings as already-dismissed. If a ledger exists from an earlier session, first verify it belongs to this history: every round records the reviewed HEAD SHA, and the last recorded SHA must be an ancestor of or equal to the current HEAD (`git merge-base --is-ancestor <sha> HEAD`). If it is, resume with contiguous round numbering. If not (force-push, branch reuse), rename the evidence ledger aside and start a fresh one, but never delete or reset `.git/rcl-converge-attempts`: launch attempts remain cumulative telemetry for the stable target. Historical machine state containing cap fields resumes unchanged and uncapped; never reset, delete, or rebadge the target to alter its counts. Otherwise create the ledger — format below.

### 2. Round loop

For each evidence round `<R>` (numbering continues from a resumed ledger), first record one machine-accounted attempt. A failed or inconclusive attempt may leave `<R>` unchanged, but it still advances the durable attempt telemetry. Neither count is a stopping condition; continue until convergence or a genuine blocker.

1. **Refresh the target.** PR mode: re-check that the PR head still equals local HEAD and that the PR is still OPEN (an external push mid-loop means someone else is driving the branch, and a merged or closed PR must not be converged — stop and report). Otherwise nothing to do — the PR already contains last round's pushed fixes. Local diff mode: regenerate the patch so the round reviews the fixed code:
   ```bash
   DEFAULT_BRANCH=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)
git rev-parse --verify "$DEFAULT_BRANCH" >/dev/null || { echo "no default branch: $DEFAULT_BRANCH"; exit 1; }
   BASE=$(git merge-base HEAD "$DEFAULT_BRANCH")
   git diff "$BASE"..HEAD > <RCL_TMP>/rcl-branch-review-<TARGET>.patch
   ```
{{#claude}}
2. **Claim in the foreground, then run the review detached.** Run the first block below exactly once as a foreground Bash call. Its quoted `<TARGET>` is the exact resolved accounting key (the quotes are shell syntax, not part of the value). Never set `run_in_background` on this claim and never call it separately again. Any non-zero exit — including exit 3 for an accounting/infrastructure failure — means attempt accounting failed or could not be verified; the attempt may already be recorded. Release the target lock and diagnose the failure. Never retry the claim automatically: inspect the durable attempt state first, and retry only after proving no claim persisted and repairing the cause; stop when the failure is a genuine blocker. A successful claim is spent even if the later launch fails, is killed, produces no report, or is inconclusive.

   ```bash
   rm -f <RCL_TMP>/rcl-report-<TARGET>-r<R>.md <RCL_TMP>/rcl-report-<TARGET>-r<R>.json || { echo "failed to remove stale review artifacts" >&2; exit 3; }
   rcl converge-attempt --target '<TARGET>'
   ```

   Only after that foreground call succeeds, launch this second block as a separate Bash call with `run_in_background: true`; never run the review as a plain foreground call. RCL prints the run-specific runtime plan, so never assume a fixed duration. Continue when the task-completion notification arrives — never block on it with a foreground wait or sleep loop.

   ```bash
   GITHUB_TOKEN=$(gh auth token) rcl review <target> \
     --markdown <RCL_TMP>/rcl-report-<TARGET>-r<R>.md \
     --json-file <RCL_TMP>/rcl-report-<TARGET>-r<R>.json \
     [--spec <SPEC>] [--roles <roles>]
   ```

   Never pass `--post` or `--inline` mid-loop. If the run exits non-zero or the JSON report is missing or empty, read the run output, diagnose and repair any fixable launch or provider-health cause, then claim the retry as another attempt. It does not count as an evidence round, but its foreground claim remains durable telemetry. Release the target lock and stop only when the failure is a genuine infrastructure blocker.
{{/claude}}
{{#codex}}
2. **Claim the attempt, then run the review detached.** Run the complete block below exactly once per intended council launch; its foreground first command claims exactly one attempt. Its quoted `<TARGET>` is the exact resolved accounting key (the quotes are shell syntax, not part of the value). Never call the claim separately and then rerun the complete block. Any non-zero claim exit stops the launch. Exit 3 is an accounting/infrastructure failure: release the lock and diagnose the error because provider calls cannot start while accounting is uncertain. Never retry the claim automatically: inspect the durable attempt state first, and retry only after proving no claim persisted and repairing the cause; stop when the failure is a genuine blocker. A successful claim is spent even if the following process fails to launch, is killed, times out, produces no report, or is inconclusive. RCL prints the run-specific runtime plan; never assume a fixed duration. Do not run the review as a plain foreground shell call. Delete stale reports and the PID file first, because a retry reuses the evidence-round number and must never monitor an old or recycled PID.

   ```bash
   rm -f <RCL_TMP>/rcl-report-<TARGET>-r<R>.md <RCL_TMP>/rcl-report-<TARGET>-r<R>.json <RCL_TMP>/rcl-converge-<TARGET>-r<R>.pid || { echo "failed to remove stale review artifacts" >&2; exit 3; }
   rcl converge-attempt --target '<TARGET>'
   ATTEMPT_STATUS=$?
   [ "$ATTEMPT_STATUS" -eq 0 ] || exit "$ATTEMPT_STATUS"
   nohup sh -c 'umask 077
   printf "%s\n" "$$" > <RCL_TMP>/rcl-converge-<TARGET>-r<R>.pid || exit 125
   GITHUB_TOKEN=$(gh auth token)
   export GITHUB_TOKEN
   exec rcl review <target> \
     --markdown <RCL_TMP>/rcl-report-<TARGET>-r<R>.md \
     --json-file <RCL_TMP>/rcl-report-<TARGET>-r<R>.json \
     [--spec <SPEC>] [--roles <roles>]' \
     > <RCL_TMP>/rcl-converge-<TARGET>-r<R>.log 2>&1 &
   ```

   Poll for the child-created PID file in short, repeated tool calls for no more than 30 seconds. The PID write is load-bearing: if it fails, the child exits 125 before resolving credentials or starting provider calls. If the file is still missing or empty at that deadline, read the log and diagnose the launch failure; the pre-launch claim remains durable telemetry, but no review could have started past the failed PID write. Never search by process name. Once the PID file exists and is non-empty, poll `kill -0 $(cat <RCL_TMP>/rcl-converge-<TARGET>-r<R>.pid)` until the process is gone — again in short, repeated tool calls, never one blocking loop (which hits the same tool timeout; the nohup'd review survives a killed poll; just poll again), and never by process name, which collides with concurrent rcl runs. The child writes its own PID before `exec` replaces it with RCL, so an interrupted parent shell cannot lose the identity of a live review. Only after that PID exits, confirm the JSON report exists and is non-empty; a half-written file must never be parsed. The report file is the success signal: the exit status of a backgrounded process is not recoverable across tool calls. Never pass `--post` or `--inline` mid-loop. If the process is gone but the JSON report is missing or empty, read the log, diagnose and repair any fixable launch or provider-health cause, then claim the retry as another attempt. It does not count as an evidence round, but its pre-launch claim remains durable telemetry. Release the target lock and stop only when the failure is a genuine infrastructure blocker.
{{/codex}}
3. **Check reviewer health first, then parse findings from the JSON file**, never from console scrollback. `stats.successfulReviews` / `stats.totalReviews` gates the whole round: a report is produced even when most model calls time out or error, so a near-empty finding list can mean 'nothing found' or 'nobody looked'. Full-fleet completion is not required. Let `N = stats.totalReviews`; a round is conclusive only when `stats.successfulReviews >= max(2, ceil(2 × N / 3))`. Otherwise it is **inconclusive** — never counted as converged. Disclose every timeout or error and the successful/total count. Report the failure pattern (which models, timeout vs error), fix the cause if it is under your control (timeouts, missing keys, reasoning budget), and re-run as needed while a healthy fleet remains achievable. Stop only when reviewer health is a genuine blocker, never because attempts, rounds, cost, or elapsed time accumulated. Split by the report's gating annotations: a finding **gates convergence** when its `gating.reason` is `consensus`, `critical`, or `verified`; findings with `gating.reason: "none"` (refuted single-model claims and everything below important) are opportunistic — fix them when cheap, never loop on them. A `gating.verification.verdict` of `unavailable` means the verification pass could not check that finding: it still gates, but read its `note` — a persistently broken verifier is a fixable cause, like a missing key. Legacy reports without `gating` fields fall back to the severity split (critical/important gate).
4. **Dedup against the run state with the identity tool.** Run once per valid evidence round; the call enforces strict contiguous sequencing while preserving identity and verdict history:
   ```bash
   rcl converge-report --target '<TARGET>' --report <RCL_TMP>/rcl-report-<TARGET>-r<R>.json --round <R> --json
   ```
   It matches findings by stable identity (file + category + location anchor — NOT titles, which models rephrase ~98% of the time), against every prior round of this run, and classifies each as `new`, `repeat`, `suppressed`, or `regating`. `suppressed` = previously dismissed: do NOT re-triage it — a dismissal is terminal on its evidence (RCL-30) and fresh corroboration alone never re-gates it (identity is location-anchored, so a claim about different code is a new identity by construction). `regating` = previously dismissed at non-critical severity but now sighted as critical — genuinely new evidence: re-triage it. `repeat` of a **fixed** finding gets a quick re-verification that the fix actually landed — if it does, mark it `[recurring]` in the ledger; if not, triage as new. Record the tool's per-round counts (new/repeat/suppressed/regating) in the ledger.
5. **Triage every `new`/`regating` gating finding against the actual code before touching anything.** Council findings skew heavily false-positive (historically roughly 1 in 10 is actionable). Classify each as `fix` (real, worth fixing) or `dismiss` (false positive, not actionable, or out of scope) — every dismissal gets a one-line reason in the ledger. Verdicts are persisted in step 7, after the quality gates — a fix that fails to go green is not a fix.
6. **Apply the fixes.** After edits: `npm run lint` (type-check) and `npm test` (vitest suite). Do not commit until these are green; if a fix cannot be made green, drop it, record that in the ledger, and report it.
7. **Record the round in the ledger and persist the verdicts.** Ledger format below — the round header records the reviewed HEAD SHA. Write the findings and verdicts now, but leave each fixed entry's commit hash blank: the commit does not exist until the next step. Fill the hashes in immediately after committing, so the ledger never cites a hash that was never created. Persist the verdicts as they actually stand after the quality gates — a `fix` that could not be made green is recorded as dropped in the ledger, not as fixed:
   ```bash
   rcl converge-verdict --target '<TARGET>' --round <R> --fixed <identity> --dismissed '<identity>=<one-line reason>'
   ```
   (both flags repeatable; identities come from the converge-report output; later rounds suppress dismissed re-findings and the tool's precision history accrues from these records). The tool replies with the round's **resolution** once every gating identity is triaged: `converged-dismissal-only` means every gating finding was dismissed and nothing was fixed — the reviewed patch is unchanged, **this round converges**, and no confirmation round may be launched to "double-check" it; `fixes-pending-fresh-round` means the patch changes and the loop continues; `unresolved` lists identities still needing verdicts. Trust the machine resolution over your own recount.
8. **Commit and push** (PR mode) if anything was fixed: one commit per round, e.g. `Address RCL round 2 findings: <short summary>`. Local diff mode: commit only; there is nothing to push. Immediately before `git push`, re-check the PR is still OPEN — if it merged or closed mid-loop, keep the commit local, stop, and report.
   - **Push alarm:** if `git push` prints `* [new branch]` for a branch that should already exist remotely, STOP the loop immediately — the remote branch was deleted (the PR merged and auto-deleted mid-loop) and the push just re-created an orphan attached to a merged PR. Check `gh pr view --json state`; unpushed fixes need a fresh PR.
9. **Check convergence** (next section). Converged or genuinely blocked → exit the loop; otherwise start the next round.

### 3. Convergence

A round can only converge if it was **conclusive** under the reviewer-health formula in step 3. A conclusive round **converges** when it produced **zero new actionable gating findings** (`gating.reason` of `consensus`, `critical`, or `verified`; legacy fallback: critical/important severity) — every gating finding in its report was either already in the ledger or was dismissed this round with a reason, and nothing required a fix. Dismissal-only rounds are terminal (RCL-30): when `rcl converge-verdict` reports `converged-dismissal-only`, the round converges right there — dismissing every gating finding does not buy another round, because the reviewed patch is unchanged and a rerun could only re-sample the same code. A round that fixed a gating finding is by definition not converged, even though the finding is handled. Non-gating findings never block convergence; fix them opportunistically when cheap. This stop condition is satisfiable by construction (RCL-21/RCL-23): multi-model gating is ~2 findings/round and reaches zero at a median of 3 rounds, where the old any-single-model rule flatlined at ~15/round forever.

Consequences:

- A round that fixed any gating finding did **not** converge — at least one more round must confirm those fixes and catch regressions they may have introduced. A round whose only fixes were non-gating findings can still converge.
- Attempt and round counts never change the convergence predicate. They remain telemetry while the loop continues until convergence or a genuine blocker.

### 4. After the loop

1. If `--post-final` (PR mode, converged only): post a convergence summary as a PR comment (`gh pr comment`) built from the ledger — rounds run, fixed/dismissed counts with reasons, final verdict. This is a summary comment, not another council run.
2. Report to the user:
   - Converged or genuinely blocked, with evidence rounds and attempts used as telemetry
   - Per round: new findings, fixed vs dismissed (with the load-bearing dismissal reasons)
   - Commits pushed
   - Reminder: auto-merge was disarmed / left unarmed — it is now safe to arm it.

## Ledger format

`<GIT_DIR>/rcl-converge-<TARGET>-ledger.md` (`<GIT_DIR>` = `$(git rev-parse --git-common-dir)`):

```markdown
# RCL converge ledger — <TARGET>

## Round 1 — HEAD abc1234 — report <RCL_TMP>/rcl-report-<TARGET>-r1.json — 12 findings (2 critical / 4 important / 6 minor) — identity: 9 new / 2 repeat / 1 suppressed / 0 regating
- [fixed] 9787c6ea72ae778c src/consensus/deduper.ts — line-overlap window applied twice — commit abc1234
- [dismissed] d2baf9675eb450f0 src/output/github.ts — "prompt injection via diff content" — delimiters already neutralized in sanitize.ts
- [suppressed] c4842562392f4b60 src/dispatch/runner.ts — dismissed in round 1, no new corroboration
- [minor/fixed] src/config/defaults.ts — typo in comment — commit abc1234
```

## Hard rules

- Never `--post`/`--inline` mid-loop; the only posting is the `--post-final` summary comment after convergence.
- Never arm auto-merge; disarm it at the start if armed. Never run `gh pr merge` in any form other than `--disable-auto` — that allowlist entry exists solely for disarming; merging is out of scope for this skill.
- Never amend or force-push — fixes are always new commits.
- Every council launch must be preceded by a successful `rcl converge-attempt` claim. Never bypass or reset its persisted state. The count is cumulative telemetry across sessions, force-pushes, and resumes, and it never stops a healthy loop.
- Preserve the converge run state (`.git/rcl-converge-runs/`) for strict round sequencing, identity matching, suppression, and regating. Never reset it or rebadge a target to discard historical evidence.
- Execute the host variant's claim exactly once: Claude runs its claim block in the foreground and its review block separately; Codex runs its combined claim-and-launch block once. Never repeat `rcl converge-attempt`, because each successful call spends another attempt.
- Never terminate a live council merely because its log contains one model/parser warning. Let RCL finish and assess reviewer health from the completed JSON report; killing the process destroys the evidence needed for that decision.
- Read reports from files, never console scrollback; every round gets its own report files.

## Examples

- `{{PREFIX}}rcl-converge` — converge the current branch's PR until convergence or a genuine blocker
- `{{PREFIX}}rcl-converge #7` — converge a specific PR with durable attempt and round telemetry
- `{{PREFIX}}rcl-converge --roles security-auditor,bug-hunter --post-final` — converge on two roles, post the summary once converged
