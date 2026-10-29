import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('preview startup retains custody before health and protects uncertain or mismatched processes', () => {
  const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', resolve('tests/fixtures/preview-startup-probe.ps1'), '-SourceScript', resolve('scripts/start-preview.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).passed, 6);
});
