import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fixture, secrets } from './server-fixture.ts';

const signingSecret = 'synthetic-local-webhook-signing-secret';
const bearerSecret = 'synthetic-webhook-only-bearer-secret';
const proof = 'synthetic-webhook-connector-registration-proof';
type Captured = { path: string; method: string; headers: IncomingHttpHeaders; body: Buffer };
type Profile = Record<string, unknown>;
async function webhookFixture() {
  const hub = await fixture(), received: Captured[] = [];
  let respond = (_request: Captured, response: ServerResponse) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"received":true}'); };
  const target = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const capture = { path: request.url!, method: request.method!, headers: request.headers, body: Buffer.concat(chunks) };
      received.push(capture); respond(capture, response);
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('Synthetic target failure'); });
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const address = target.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/hook`, profilePath = join(hub.dir, 'webhook-connector.json');
  const registered = await hub.call('/api/agents/register', secrets.ingestToken, { requestId: 'webhook-tests', registrationKey: proof, agentId: 'synthetic-webhook-agent', name: 'Synthetic webhook application' });
  assert.equal(registered.status, 201); const agent = await registered.json() as { runId: string; runToken: string };
  let serial = 0;
  const profile: Profile = { type: 'webhook', url, signingKeyEnv: 'AV_TEST_HOOK_SIGNING_KEY', bearerTokenEnv: 'AV_TEST_HOOK_BEARER' };
  async function queue(kind = 'prompt', input: Record<string, unknown> = { message: 'Synthetic prompt' }) {
    const configured = await hub.call(`/api/agents/${agent.runId}/controls`, agent.runToken, { actions: [{ id: 'send', label: 'Send', kind, target: 'webhook-worker', handler: 'agent-hook', fields: [{ key: 'message', label: 'Message', type: 'text' }] }] }, 'PUT');
    assert.equal(configured.status, 200); const configuration = await configured.json();
    const invoked = await hub.call(`/api/controls/${agent.runId}/invoke`, secrets.viewerToken, { requestId: `webhook-${++serial}`, definitionVersion: configuration.version, actionId: 'send', input });
    assert.equal(invoked.status, 200, `queue ${kind}: ${await invoked.clone().text()}`); return invoked.json();
  }
  async function run(patch: Profile = {}) {
    writeFileSync(profilePath, JSON.stringify({ id: 'webhook-worker', name: 'Synthetic webhook worker', url: hub.url, ingestionKey: secrets.ingestToken, registrationKey: proof, handlers: { 'agent-hook': { ...profile, ...patch } } }));
    const child = spawn('dotnet', [resolve(process.env.AV_TEST_SERVER || 'src/AgenticView.Server/bin/Release/net10.0/AgenticView.Server.dll'), '--connector', profilePath, '--once'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AV_INGEST_KEY: secrets.ingestToken, AV_TEST_HOOK_SIGNING_KEY: signingSecret, AV_TEST_HOOK_BEARER: bearerSecret } });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); }); child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
    const deadline = setTimeout(() => child.kill(), 10_000);
    try { const [code, signal] = await once(child, 'exit'); assert.equal(code, 0, `Connector failed (${signal ?? 'no signal'}): ${output}`); }
    finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill(); }
    return output;
  }
  async function result(id: string) {
    const response = await hub.call(`/api/controls/${agent.runId}/invocations/${id}`, secrets.viewerToken); assert.equal(response.status, 200); return response.json();
  }
  function noPrivateEnvelope(capture: Captured) {
    const text = capture.body.toString('utf8'), envelope = JSON.parse(text);
    assert.deepEqual(Object.keys(envelope).sort(), ['actionId', 'createdAt', 'input', 'invocationId', 'kind', 'runId', 'schemaVersion'].sort());
    for (const secret of [signingSecret, bearerSecret, secrets.ingestToken, secrets.viewerToken, secrets.runSecret, agent.runToken, proof, profilePath]) assert.equal(text.includes(secret), false, 'delivery body excludes local and hub credentials');
    assert.equal(envelope.claimToken, undefined); assert.equal(envelope.handler, undefined); assert.equal(envelope.profile, undefined);
  }
  function genericError(invocation: { error?: string }) {
    assert.equal(typeof invocation.error, 'string');
    for (const privateText of [url, signingSecret, bearerSecret, secrets.ingestToken, secrets.runSecret, agent.runToken, proof, profilePath, 'PRIVATE_TARGET_BODY']) assert.equal(invocation.error!.includes(privateText), false, 'operator error excludes target secrets, body and local profile');
    assert.ok(invocation.error!.length < 2000);
  }
  return { hub, agent, url, profilePath, received, queue, run, result, noPrivateEnvelope, genericError,
    respond: (handler: typeof respond) => { respond = handler; },
    close: async () => { const closed = new Promise<void>((done, reject) => target.close(error => error ? reject(error) : done())); target.closeAllConnections(); await closed; await hub.close(); },
  };
}

test('real webhook connector signs stable retry bytes and sends only the public delivery envelope', { timeout: 15_000 }, async () => {
  const f = await webhookFixture();
  try {
    f.respond((_request, response) => { response.writeHead(f.received.length === 1 ? 502 : 200, { 'Content-Type': 'application/json' }); response.end(f.received.length === 1 ? '{"private":"PRIVATE_TARGET_BODY"}' : '{"received":true}'); });
    const input = { message: 'Exact UTF-8 prompt é\nsecond line' }, invoked = await f.queue('prompt', input);
    assert.equal(f.received.length, 0, 'the hub never calls the configured target');
    await f.run({ maxAttempts: 3, idempotent: true }); assert.equal(f.received.length, 2);
    const first = f.received[0]!, second = f.received[1]!;
    assert.deepEqual(first.body, second.body, 'retry body is byte-for-byte stable');
    for (const capture of [first, second]) {
      assert.equal(capture.path, '/hook'); assert.equal(capture.method, 'POST'); assert.equal(capture.headers.authorization, `Bearer ${bearerSecret}`);
      assert.equal(capture.headers['idempotency-key'], invoked.id); assert.equal(capture.headers['x-agenticview-invocation-id'], invoked.id);
      const timestamp = String(capture.headers['x-agenticview-timestamp']); assert.match(timestamp, /^\d{10}$/);
      assert.ok(Math.abs(Number(timestamp) - Math.floor(Date.now() / 1000)) < 60, 'signed timestamp uses current Unix seconds');
      assert.equal(capture.headers['x-agenticview-signature'], 'sha256=' + createHmac('sha256', signingSecret).update(timestamp + '.').update(capture.body).digest('hex'));
      f.noPrivateEnvelope(capture);
      const body = JSON.parse(capture.body.toString('utf8')); assert.equal(body.schemaVersion, 1); assert.equal(body.invocationId, invoked.id); assert.equal(body.runId, f.agent.runId); assert.equal(body.actionId, 'send'); assert.equal(body.kind, 'prompt'); assert.deepEqual(body.input, input); assert.equal(body.createdAt, invoked.createdAt);
    }
    assert.equal(first.headers['x-agenticview-timestamp'], second.headers['x-agenticview-timestamp']); assert.equal(first.headers['x-agenticview-signature'], second.headers['x-agenticview-signature']);
    const completed = await f.result(invoked.id); assert.equal(completed.state, 'succeeded'); assert.equal(completed.claimToken, undefined); assert.deepEqual(completed.result.response, { received: true });
    assert.equal(completed.result.delivery.state, 'acknowledged'); assert.equal(completed.result.delivery.invocationId, invoked.id); assert.equal(completed.result.delivery.attempts, 2); assert.equal(completed.result.delivery.httpStatus, 200); assert.ok(completed.result.delivery.acknowledgedAt);
    const custom = await f.queue('custom'); await f.run({ kind: 'custom' }); assert.equal((await f.result(custom.id)).state, 'succeeded'); assert.equal(JSON.parse(f.received.at(-1)!.body.toString()).kind, 'custom');
  } finally { await f.close(); }
});

test('HTTP 202 acknowledges prompt delivery without claiming target task completion', { timeout: 15_000 }, async () => {
  const f = await webhookFixture();
  try {
    f.respond((_request, response) => { response.writeHead(202, { 'Content-Type': 'application/json' }); response.end('{"taskState":"queued"}'); });
    const invoked = await f.queue(); await f.run(); const completed = await f.result(invoked.id);
    assert.equal(f.received.length, 1); assert.equal(completed.state, 'succeeded'); assert.equal(completed.result.delivery.state, 'acknowledged'); assert.equal(completed.result.delivery.httpStatus, 202); assert.equal(completed.result.delivery.attempts, 1); assert.deepEqual(completed.result.response, { taskState: 'queued' }); assert.equal(completed.result.taskCompleted, undefined);
  } finally { await f.close(); }
});

test('webhooks never retry unsafe delivery, follow redirects, or retry explicit rejection; lost responses remain unknown', { timeout: 15_000 }, async () => {
  const f = await webhookFixture();
  try {
    for (const scenario of [{ status: 502, patch: {} }, { status: 302, patch: { maxAttempts: 3, idempotent: true } }, { status: 400, patch: { maxAttempts: 3, idempotent: true } }, { status: 401, patch: { maxAttempts: 3, idempotent: true } }, { status: 0, patch: {} }]) {
      const before = f.received.length;
      f.respond((_request, response) => { if (scenario.status === 0) { response.destroy(); return; } response.writeHead(scenario.status, { Location: f.url.replace('/hook', '/redirected') }); response.end('PRIVATE_TARGET_BODY'); });
      const invoked = await f.queue(); await f.run(scenario.patch); const completed = await f.result(invoked.id);
      assert.equal(f.received.length - before, 1, `${scenario.status} gets exactly one delivery attempt`); assert.equal(f.received.at(-1)!.path, '/hook'); assert.equal(completed.state, scenario.status === 0 ? 'unknown' : 'failed'); f.genericError(completed);
    }
  } finally { await f.close(); }
});

test('oversized successful response bodies are bounded and never resend acknowledged prompts', { timeout: 15_000 }, async () => {
  const f = await webhookFixture();
  try {
    f.respond((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('x'.repeat(300_000)); });
    const invoked = await f.queue(); await f.run({ maxAttempts: 3, idempotent: true, maxResponseBytes: 1024 }); const completed = await f.result(invoked.id);
    assert.equal(f.received.length, 1); assert.equal(completed.state, 'succeeded'); assert.equal(completed.result.delivery.state, 'acknowledged'); assert.equal(completed.result.delivery.attempts, 1); assert.equal(completed.result.responseTruncated, true); assert.equal(completed.result.response, undefined); assert.ok(Buffer.byteLength(JSON.stringify(completed.result)) < 4096, 'oversized body is dropped after its bounded prefix');
  } finally { await f.close(); }
});

test('invalid retry profiles and unsupported webhook kinds reject before any target request', { timeout: 15_000 }, async () => {
  const f = await webhookFixture();
  try {
    const cases = [
      { kind: 'prompt', patch: { maxAttempts: 2 } },
      { kind: 'prompt', patch: { maxAttempts: 4, idempotent: true } },
      { kind: 'prompt', patch: { timeoutSeconds: 0 } },
      { kind: 'prompt', patch: { maxResponseBytes: 262145 } },
      ...['command', 'edit', 'query', 'logs'].map(kind => ({ kind, patch: {} })),
    ];
    for (const scenario of cases) {
      const input = scenario.kind === 'edit' ? { message: 'Synthetic prompt', operation: 'update', row: { message: 'Synthetic prompt' } } : { message: 'Synthetic prompt' };
      const invoked = await f.queue(scenario.kind, input); await f.run(scenario.patch); const completed = await f.result(invoked.id);
      assert.equal(f.received.length, 0, `${scenario.kind} invalid profile never contacts target`); assert.equal(completed.state, 'failed'); f.genericError(completed);
    }
  } finally { await f.close(); }
});
