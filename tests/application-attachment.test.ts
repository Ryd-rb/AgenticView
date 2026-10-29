import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { applicationManifestSchema } from '../shared/application-manifest.ts';

test('deferred setup is a portable utility child with explicit connection confirmation', () => {
  const manifest = applicationManifestSchema.parse(JSON.parse(readFileSync('examples/applications/codex-subscription-setup.agenticview.json', 'utf8')));
  assert.equal(manifest.permanent, true);
  assert.deepEqual(manifest.bindings.map(binding => binding.id), ['setup']);
  assert.equal(manifest.actions.length, 2);
  assert.ok(manifest.actions.find(action => action.id === 'connect-subscription')?.confirmation);
  assert.ok(manifest.actions.every(action => action.kind === 'custom' && action.target === 'setup'));
  assert.equal(manifest.components[0]?.id, 'plan');
});

test('application attachment preserves parent configuration and exact retry identity', () => {
  const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', resolve('tests/fixtures/application-attachment-probe.ps1'), '-SourceScript', resolve('scripts/attach-application.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).passed, 6);
});
