import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, secrets } from './server-fixture.ts';

const registrationKey = 'synthetic-private-registration-recovery-key';

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
