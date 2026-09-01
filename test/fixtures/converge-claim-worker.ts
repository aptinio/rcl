import { claimConvergeAttempt } from '../../src/converge/attempt-budget.js';

const [gitCommonDir, target] = process.argv.slice(2);
if (!gitCommonDir || !target) {
  throw new Error('Usage: converge-claim-worker <git-common-dir> <target>');
}

try {
  const claim = await claimConvergeAttempt({ gitCommonDir, target });
  process.stdout.write(`${JSON.stringify(claim)}\n`);
} catch (err) {
  console.error(err);
  process.exitCode = 3;
}
