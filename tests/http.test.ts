import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, secrets } from './server-fixture.ts';
import { applyLivePatch, rootAgents } from '../shared/live-state.ts';
import { fitToViewport, isVisible } from '../shared/canvas.ts';
import type { Patch, Snapshot } from '../shared/protocol.ts';

const registrationKey = 'synthetic-private-registration-recovery-key';

test('an already-connected viewer receives new agents and packing without reload', async () => { const f = await fixture(); const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 8_000); try {
  const stream = await fetch(f.url + '/api/events', { headers: { Authorization: `Bearer ${secrets.viewerToken}` }, signal: controller.signal });
  const reader = stream.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  async function event() { for (;;) { const end = buffer.indexOf('\n\n'); if (end >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); const data = frame.split('\n').find(line => line.startsWith('data: ')); if (data) return { type: frame.split('\n').find(line => line.startsWith('event: '))?.slice(7), value: JSON.parse(data.slice(6)) }; } else { const next = await reader.read(); if (next.done) throw new Error('Live stream closed'); buffer += decoder.decode(next.value, { stream: true }); } } }
  const first = await event(); assert.equal(first.type, 'snapshot'); let view = first.value as Snapshot; assert.equal(view.agents.length, 0);
  const registered = await (await f.call('/api/agents/register', secrets.ingestToken, { requestId: 'late', registrationKey, agentId: 'late', name: 'Synthetic arriving agent' })).json();
  assert.equal((await f.call(`/api/agents/${registered.runId}/publish`, registered.runToken, { sequence: 1, operations: [{ op: 'upsert', component: { id: 'metric', title: 'Live metric', kind: 'metric', data: { value: 7 } } }] })).status, 200);
  for (let count = 0; count < 30 && !view.agents[0]?.components.metric; count++) { const message = await event(); assert.equal(message.type, 'patch'); view = applyLivePatch(view, message.value as Patch); }
  assert.equal(view.agents[0]?.name, 'Synthetic arriving agent'); assert.equal(view.agents[0]?.components.metric.kind, 'metric');
  assert.equal((await f.call('/api/layout/pack', secrets.ingestToken, { mode: 'all' })).status, 401);
  assert.equal((await f.call('/api/layout/pack', secrets.viewerToken, { mode: 'all', aspectRatio: 1.6 })).status, 200);
  const roots = rootAgents(view.agents), camera = fitToViewport(roots.map(agent => agent.layout), { width: 1200, height: 800 });
  assert.ok(roots.every(agent => isVisible(agent.layout, { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: 1200 / camera.zoom, height: 800 / camera.zoom })));
} finally { clearTimeout(deadline); controller.abort(); await f.close(); } });

test('viewer/producer boundaries, origin checks and login cookies', async () => { const f = await fixture(); try {
  assert.equal((await f.call('/api/snapshot')).status, 401);
  assert.equal((await f.call('/api/snapshot', secrets.ingestToken)).status, 401);
  assert.equal((await f.call('/api/snapshot', secrets.viewerToken, undefined, 'GET', { Origin: 'null' })).status, 403);
  assert.equal((await f.call('/api/snapshot', secrets.viewerToken, undefined, 'GET', { Origin: 'https://untrusted.example.invalid' })).status, 403);
  assert.equal((await f.call('/api/agents/register', secrets.viewerToken, { requestId: 'a', agentId: 'a', name: 'A' })).status, 401);
  const login = await f.call('/api/login', '', { token: secrets.viewerToken }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i); assert.equal((await login.json()).authenticated, true);
  assert.equal((await f.call('/api/snapshot', '', undefined, 'GET', { Cookie: cookie.split(';')[0] })).status, 200);
  const session = await f.call('/api/session', '', undefined, 'GET', { Cookie: 'av_session=forged.9999999999999.invalid' }); assert.equal((await session.json()).authenticated, false);
} finally { await f.close(); } });

test('interaction leases require viewer access and release independently without changing geometry', async () => { const f = await fixture(); try {
  async function read(response: Response, label: string) { const body = await response.text(); assert.ok(body.length, `${label} returned empty body with status ${response.status}`); return JSON.parse(body); }
  const registration = await f.call('/api/agents/register', secrets.ingestToken, { requestId: 'interaction', registrationKey, agentId: 'interaction', name: 'Synthetic interaction' }); assert.equal(registration.status, 201, 'interaction test registration');
  const created = await read(registration, 'registration');
  const endpoint = `/api/agents/${created.runId}/layout/interaction`;
  for (const token of ['', secrets.ingestToken, created.runToken]) assert.equal((await f.call(endpoint, token, { active: true, leaseId: 'view-a' })).status, 401);
  assert.equal((await f.call(endpoint, secrets.viewerToken, { active: true, leaseId: 'view-a' }, 'POST', { Origin: 'https://untrusted.example.invalid' })).status, 403);
  assert.equal((await f.call(endpoint, secrets.viewerToken, { active: true })).status, 400);
  const before = (await read(await f.call('/api/snapshot', secrets.viewerToken), 'snapshot before')).agents[0].layout;
  const first = await f.call(endpoint, secrets.viewerToken, { active: true, leaseId: 'view-a' }); assert.equal(first.status, 200); assert.ok((await read(first, 'admission')).expiresAt > Date.now());
  assert.deepEqual((await read(await f.call('/api/snapshot', secrets.viewerToken), 'snapshot after')).agents[0].layout, before);
  await f.call(endpoint, secrets.viewerToken, { active: true, leaseId: 'view-b' });
  await f.call(endpoint, secrets.viewerToken, { active: false, leaseId: 'view-a' });
  assert.equal((await read(await f.call('/api/layout/pack', secrets.viewerToken, { mode: 'all' }), 'pack while held')).arranged, 0);
  const released = await f.call(endpoint, secrets.viewerToken, { active: false, leaseId: 'view-b' }); assert.equal((await read(released, 'release')).expiresAt, null);
  assert.equal((await f.call(endpoint, secrets.viewerToken, { active: false, leaseId: 'view-b' })).status, 200);
  assert.equal((await read(await f.call('/api/layout/pack', secrets.viewerToken, { mode: 'all' }), 'pack after release')).arranged, 1);
} finally { await f.close(); } });

test('real HTTP ingest, SSE patch, trusted embed policy and compressed archive export', async () => { const f = await fixture(); const controller = new AbortController(); try {
  const create = await f.call('/api/agents/register', secrets.ingestToken, { requestId: 'run', registrationKey, agentId: 'synthetic', name: 'Synthetic' }); assert.equal(create.status, 201); const credentials = await create.json();
  const stream = await fetch(f.url + '/api/events', { headers: { Authorization: `Bearer ${secrets.viewerToken}` }, signal: controller.signal }); const reader = stream.body!.getReader(); const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /event: snapshot/);
  const input = { sequence: 1, operations: [{ op: 'upsert', component: { id: 'view', title: 'Synthetic embedded view', kind: 'embed', data: { html: '<script>document.body.dataset.ready="yes"</script><p>Trusted synthetic view</p>', height: 200 } } }] };
  assert.equal((await f.call(`/api/agents/${credentials.runId}/publish`, 'wrong', input)).status, 403);
  assert.equal((await f.call(`/api/agents/${credentials.runId}/publish`, credentials.runToken, input)).status, 200);
  let next = ''; for (let i = 0; i < 10 && !next.includes('Synthetic embedded view'); i++) next += new TextDecoder().decode((await reader.read()).value); assert.match(next, /event: patch/); assert.match(next, /Synthetic embedded view/);
  const embed = await f.call(`/api/embeds/${credentials.runId}/view`, secrets.viewerToken); assert.equal(embed.status, 200); const policy = embed.headers.get('content-security-policy')!; assert.match(policy, /sandbox allow-scripts/); assert.doesNotMatch(policy, /allow-same-origin/); assert.match(await embed.text(), /agenticview:init/);
  const archived = await f.call(`/api/agents/${credentials.runId}/archive`, credentials.runToken, {}); assert.equal(archived.status, 200);
  assert.equal((await f.call(`/api/agents/${credentials.runId}/archive`, credentials.runToken, {})).status, 200);
  assert.equal((await f.call(`/api/archives/${credentials.runId}`, credentials.runToken)).status, 401);
  const exported = await f.call(`/api/archives/${credentials.runId}/export`, secrets.viewerToken); assert.equal(exported.headers.get('content-type'), 'application/gzip'); assert.ok((await exported.arrayBuffer()).byteLength > 0);
  controller.abort();
} finally { controller.abort(); await f.close(); } });

test('official MCP client negotiates and publishes through Streamable HTTP', async () => { const f = await fixture(); const client = new Client({ name: 'agenticview-contract-test', version: '1.0.0' }); try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.url), { requestInit: { headers: { Authorization: `Bearer ${secrets.ingestToken}` } } }));
  const list = await client.listTools(); assert.ok(list.tools.some(tool => tool.name === 'agent_publish'));
  const registration = await client.callTool({ name: 'agent_register', arguments: { requestId: 'mcp-run', registrationKey, agentId: 'mcp-test', name: 'Synthetic MCP agent' } });
  assert.ok(!registration.isError); const credentials = registration.structuredContent as { runId: string; runToken: string };
  const result = await client.callTool({ name: 'agent_publish', arguments: { ...credentials, sequence: 1, operations: [{ op: 'upsert', component: { id: 'metric', title: 'Rows', kind: 'metric', data: { value: 42 } } }] } });
  assert.ok(!result.isError); const snapshot = await (await f.call('/api/snapshot', secrets.viewerToken)).json(); assert.equal(snapshot.agents.find((a: { id: string }) => a.id === credentials.runId).components.metric.kind, 'metric');
  const invalid = await client.callTool({ name: 'agent_publish', arguments: { ...credentials, sequence: 2, operations: [{ op: 'upsert', component: { id: 'bad', title: 'Invalid', kind: 'unsupported', data: {} } }] } }); assert.ok(invalid.isError);
} finally { await client.close(); await f.close(); } });

test('viewer restore and producer auto-recovery preserve credentials and content', async () => { const f = await fixture(); try {
  const created = await f.call('/api/agents/register', secrets.ingestToken, { requestId: 'recovery', registrationKey, agentId: 'recovery', name: 'Synthetic recovery' });
  const { runId, runToken } = await created.json(); const publish = `/api/agents/${runId}/publish`, archive = `/api/agents/${runId}/archive`, restore = `/api/archives/${runId}/restore`;
  assert.equal((await f.call(publish, runToken, { sequence: 1, operations: [{ op: 'upsert', component: { id: 'evidence', title: 'Evidence', kind: 'markdown', data: { text: 'Retained evidence' } } }] })).status, 200);
  assert.equal((await f.call(archive, secrets.viewerToken, {})).status, 200);
  assert.equal((await f.call(restore, runToken, {})).status, 401);
  assert.equal((await f.call(restore, secrets.ingestToken, {})).status, 401);
  assert.equal((await f.call(restore, secrets.viewerToken, {})).status, 200);
  assert.equal((await f.call(restore, secrets.viewerToken, {})).status, 200);
  assert.equal((await f.call(archive, runToken, {})).status, 200);
  const response = await f.call(publish, runToken, { sequence: 2, operations: [{ op: 'context', text: 'Continuing work' }] }); assert.equal(response.status, 200); assert.equal((await response.json()).restored, true);
  const snapshot = await (await f.call('/api/snapshot', secrets.viewerToken)).json();
  assert.equal(snapshot.agents.find((a: { id: string }) => a.id === runId).components.evidence.data.text, 'Retained evidence'); assert.equal(snapshot.stats.archived, 0);
} finally { await f.close(); } });

test('published monitor serves its HTML and compiled script from the C# process', async () => { const f = await fixture(); try {
  const response = await fetch(f.url + '/'); assert.equal(response.status, 200);
  const html = await response.text(); assert.match(html, /AgenticView/);
  const script = /src="([^"]+\.js)"/.exec(html)?.[1]; assert.ok(script);
  const asset = await fetch(f.url + script); assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type') || '', /javascript/);
  const library = /(?:\.\/|\/assets\/)ApplicationLibrary-[a-zA-Z0-9_-]+\.js/.exec(await asset.text())?.[0]; assert.ok(library, 'Application editor stays in a deferred module');
  const deferred = await fetch(new URL(library, new URL(script, f.url))); assert.equal(deferred.status, 200); assert.match(deferred.headers.get('content-type') || '', /javascript/); assert.match(await deferred.text(), /Portable applications/);
} finally { await f.close(); } });
