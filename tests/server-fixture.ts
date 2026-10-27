import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';

export const secrets = { viewerToken: 'synthetic-viewer-key-not-a-real-secret', ingestToken: 'synthetic-ingestion-key-not-a-real-secret', runSecret: 'synthetic-server-only-key-not-shared-with-agents' };
export async function fixture(directory?: string) {
  const dir = directory || mkdtempSync(join(tmpdir(), 'agenticview-http-'));
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify(secrets));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const address = probe.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const port = address.port; await new Promise<void>(done => probe.close(() => done()));
  const url = `http://127.0.0.1:${port}`;
  const binary = resolve(process.env.AV_TEST_SERVER || 'src/AgenticView.Server/bin/Release/net10.0/AgenticView.Server.dll');
  const child = spawn('dotnet', [binary], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AV_HOST: '127.0.0.1', AV_PORT: String(port), AV_PUBLIC_URL: url, AV_DATA_DIR: dir } });
  let logs = '', startError: Error | undefined;
  child.stdout.on('data', c => { logs = (logs + c.toString()).slice(-8_000); }); child.stderr.on('data', c => { logs = (logs + c.toString()).slice(-8_000); }); child.on('error', error => { startError = error; });
  let ready = false;
  for (let i = 0; i < 150; i++) { if (startError) throw startError; if (child.exitCode !== null) throw new Error(`C# server exited before startup: ${logs}`); try { if ((await fetch(url + '/health')).ok) { ready = true; break; } } catch { /* startup */ } await new Promise(r => setTimeout(r, 100)); }
  if (!ready) { child.kill(); throw new Error(`C# startup deadline exceeded: ${logs}`); }
  const call = (path: string, token = '', data?: unknown, method = data === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) => fetch(url + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { dir, url, call, async close(remove = !directory) { if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } if (remove) { if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('agenticview-http-')) throw new Error('Unsafe test cleanup target'); rmSync(dir, { recursive: true }); } } };
}
