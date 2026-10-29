import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('console updater stages verified bundles, rejects unsafe inputs and refuses Apply without its original installation', () => {
  const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', resolve('tests/fixtures/console-update-probe.ps1'), '-SourceScript', resolve('scripts/pull-console-update.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.passed, 10);
  assert.equal(result.liveOperations, 0);
  assert.deepEqual(result.cases, ['stage', 'sha-mismatch', 'traversal', 'absolute', 'duplicate', 'credential', 'database', 'log', 'symlink', 'apply-without-installation']);
});
