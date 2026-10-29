import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applicationManifestSchema } from '../shared/application-manifest.ts';

test('optional subscription template preserves six draft-only launchers and explicit deferred setup', () => {
  const manifest = JSON.parse(readFileSync('examples/applications/agent-sessions-with-subscription.agenticview.json', 'utf8'));
  assert.ok(applicationManifestSchema.safeParse(manifest).success);
  assert.equal(manifest.actions.filter((a: { kind: string }) => a.kind === 'session').length, 6);
  assert.ok(manifest.actions.find((a: { id: string }) => a.id === 'connect-subscription').confirmation);
  const profile = JSON.parse(readFileSync('examples/connector/subscription-profile.example.json', 'utf8'));
  assert.equal(profile.handlers['subscription-connect'].output, 'json');
  assert.ok(profile.handlers['subscription-status'].arguments.includes('Status'));
});

test('subscription status never starts authentication or exposes credentials or stale codes', () => {
  const root = mkdtempSync(join(tmpdir(), 'agenticview-subscription-status-'));
  try {
    const script = resolve('examples/connector/subscription-connection.ps1');
    const call = () => {
      const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-GatewayRoot', root, '-Operation', 'Status'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.equal(run.status, 0, run.stderr); return JSON.parse(run.stdout);
    };
    writeFileSync(join(root, 'login-private.log'), 'Old device code AAAA-BBBBB\n');
    assert.equal(call().state, 'deferred'); assert.equal(call().deviceCode, undefined);
    writeFileSync(join(root, 'connection-worker.json'), JSON.stringify({ phase: 'running', pid: 42, executable: 'synthetic-pwsh', startedUtc: '2024-01-02T03:04:05.1234565Z', deadlineUtc: new Date(Date.now() + 60000).toISOString() }));
    const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', resolve('tests/fixtures/subscription-status-probe.ps1'), '-Script', script, '-Root', root], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(probe.status, 0, probe.stderr); assert.equal(JSON.parse(probe.stdout).state, 'login_pending', 'CIM microsecond precision must match the same native start receipt');
    writeFileSync(join(root, 'connection-worker.json'), JSON.stringify({ phase: 'launch-intent', deadlineUtc: new Date(Date.now() + 60000).toISOString() }));
    assert.equal(call().deviceCode, undefined, 'An uncertain launch must not reveal a stale code');
    mkdirSync(join(root, 'auth')); writeFileSync(join(root, 'auth/auth.json'), JSON.stringify({ access_token: 'SYNTHETIC_ACCESS_TOKEN', refresh_token: 'SYNTHETIC_REFRESH_TOKEN' }));
    const authenticated = call(); assert.equal(authenticated.authenticationPresent, true); assert.equal(authenticated.automaticInferenceRequests, 0);
    assert.ok(!JSON.stringify(authenticated).includes('SYNTHETIC_')); assert.equal(authenticated.deviceCode, undefined);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('agenticview-subscription-status-')); rmSync(root, { recursive: true });
  }
});
