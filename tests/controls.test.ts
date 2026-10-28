import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fixture, secrets } from './server-fixture.ts';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const proof = 'synthetic-local-connector-registration-proof';
async function register(f: Awaited<ReturnType<typeof fixture>>, name = 'app') {
  const response = await f.call('/api/agents/register', secrets.ingestToken, { requestId: name, registrationKey: proof, agentId: name, name: 'Synthetic application' });
  assert.equal(response.status, 201); return response.json() as Promise<{ runId: string; runToken: string }>;
}
const action = { id: 'send', label: 'Send prompt', kind: 'prompt', target: 'agent', confirmation: 'Send this prompt?', fields: [{ key: 'message', label: 'Message', type: 'multiline', required: true }] };
test('official MCP tools configure permanent cards and deliver agent inbox actions', async () => {
  const f = await fixture(), client = new Client({ name: 'synthetic-control-agent', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.url), { requestInit: { headers: { Authorization: `Bearer ${secrets.ingestToken}` } } }));
    const registration = await client.callTool({ name: 'agent_register', arguments: { requestId: 'mcp-controls', registrationKey: proof, agentId: 'mcp-controls', name: 'Synthetic controls' } });
    const credentials = registration.structuredContent as { runId: string; runToken: string };
    const configuration = await client.callTool({ name: 'card_configure', arguments: { ...credentials, application: { name: 'Synthetic persistent MCP card' }, actions: [action] } });
    assert.ok(!configuration.isError, JSON.stringify(configuration));
    const version = (configuration.structuredContent as { version: string }).version;
    const invocation = await (await f.call(`/api/controls/${credentials.runId}/invoke`, secrets.viewerToken, { requestId: 'mcp-prompt', actionId: 'send', definitionVersion: version, confirmed: true, input: { message: 'Inspect synthetic status' } })).json();
    const inbox = await client.callTool({ name: 'agent_actions_poll', arguments: credentials }); assert.ok(!inbox.isError);
    const [job] = (inbox.structuredContent as { jobs: { id: string; claimToken: string }[] }).jobs; assert.equal(job!.id, invocation.id);
    const ack = await client.callTool({ name: 'agent_action_complete', arguments: { ...credentials, invocationId: job!.id, claimToken: job!.claimToken, state: 'succeeded', result: { reply: 'Synthetic status reviewed' } } }); assert.ok(!ack.isError, JSON.stringify(ack));
  } finally { await client.close(); await f.close(); }
});
test('controls preserve viewer/producer/connector boundaries, casing and opaque claims', async () => {
  const f = await fixture();
  try {
    const a = await register(f), endpoint = `/api/agents/${a.runId}/controls`;
    assert.equal((await f.call('/api/connectors/register', secrets.viewerToken, { id: 'local', name: 'Local', registrationKey: proof })).status, 401);
    assert.equal((await f.call(endpoint, 'wrong', { actions: [action] }, 'PUT')).status, 403);
    const configuration = await f.call(endpoint, a.runToken, { actions: [action], application: { name: 'Permanent synthetic app' } }, 'PUT');
    assert.equal(configuration.status, 200); const config = await configuration.json();
    assert.equal((await f.call(`/API/CONTROLS/${a.runId}/`)).status, 401);
    assert.equal((await f.call(`/api/controls/${a.runId}`, a.runToken)).status, 401);
    assert.equal((await f.call(`/api/controls/${a.runId}/invoke`, secrets.ingestToken, {})).status, 401);
    assert.ok(!JSON.stringify(config).includes(a.runToken));
    const body = { requestId: 'prompt-1', actionId: 'send', definitionVersion: config.version, input: { message: 'Synthetic instruction' } };
    assert.equal((await f.call(`/api/controls/${a.runId}/invoke`, secrets.viewerToken, body)).status, 409);
    assert.equal((await f.call(`/api/controls/${a.runId}/invoke`, secrets.viewerToken, { ...body, confirmed: true, input: { message: 'x', undeclared: 1 } })).status, 400);
    const accepted = { ...body, confirmed: true };
    const invocation = await (await f.call(`/api/controls/${a.runId}/invoke`, secrets.viewerToken, accepted)).json();
    assert.equal(invocation.state, 'queued');
    assert.equal((await f.call(`/api/agents/${a.runId}/actions/poll`, 'wrong', {})).status, 403);
    const [job] = await (await f.call(`/api/agents/${a.runId}/actions/poll`, a.runToken, {})).json();
    assert.equal(job.id, invocation.id); assert.ok(job.claimToken);
    assert.deepEqual(await (await f.call(`/api/agents/${a.runId}/actions/poll`, a.runToken, {})).json(), []);
    const retried = await (await f.call(`/api/controls/${a.runId}/invoke`, secrets.viewerToken, accepted)).json();
    assert.equal(retried.id, job.id); assert.equal(retried.claimToken, undefined);
    assert.equal((await f.call(`/api/controls/${a.runId}/invoke`, secrets.viewerToken, { ...accepted, input: { message: 'Changed' } })).status, 409);
    const done = { invocationId: job.id, claimToken: job.claimToken, state: 'succeeded', result: { reply: 'Acknowledged' } };
    assert.equal((await f.call(`/api/agents/${a.runId}/actions/complete`, a.runToken, { ...done, claimToken: 'wrong' })).status, 403);
    for (let i = 0; i < 2; i++) assert.equal((await f.call(`/api/agents/${a.runId}/actions/complete`, a.runToken, done)).status, 200);
    const history = await (await f.call(`/api/controls/${a.runId}/history`, secrets.viewerToken)).json();
    assert.equal(history.length, 1); assert.equal(history[0].state, 'succeeded'); assert.equal(history[0].claimToken, undefined);
    const changed = await (await f.call(endpoint, a.runToken, { actions: [{ ...action, confirmation: 'Review revised action' }] }, 'PUT')).json();
    assert.notEqual(changed.version, config.version);
    assert.equal((await f.call(`/api/controls/${a.runId}/invoke`, secrets.viewerToken, { ...accepted, requestId: 'stale' })).status, 409);
  } finally { await f.close(); }
});

test('application definitions and queued actions survive a hub restart and configuration retries', async () => {
  let f = await fixture(); const dir = f.dir;
  try {
    const a = await register(f), endpoint = `/api/agents/${a.runId}/controls`;
    const definition = { actions: [action], application: { name: 'Persistent console', description: 'Synthetic example' } };
    const config = await (await f.call(endpoint, a.runToken, definition, 'PUT')).json();
    const retry = await (await f.call(endpoint, a.runToken, definition, 'PUT')).json(); assert.equal(config.version, retry.version);
    const input = { requestId: 'durable', actionId: 'send', definitionVersion: config.version, input: { message: 'After restart' }, confirmed: true };
    const invocation = await (await f.call(`/api/controls/${a.runId}/invoke`, secrets.viewerToken, input)).json();
    await f.close(false); f = await fixture(dir);
    const snap = await (await f.call('/api/snapshot', secrets.viewerToken)).json(); assert.equal(snap.agents[0].application.name, 'Persistent console');
    const [job] = await (await f.call(`/api/agents/${a.runId}/actions/poll`, a.runToken, {})).json(); assert.equal(job.id, invocation.id);
    await f.close(false); f = await fixture(dir);
    assert.deepEqual(await (await f.call(`/api/agents/${a.runId}/actions/poll`, a.runToken, {})).json(), [], 'A claimed command must not replay after restart');
  } finally { await f.close(true); }
});

test('real local connector executes fixed process arguments and serves a filtered log window', async () => {
  const f = await fixture();
  try {
    const a = await register(f); const path = join(f.dir, 'synthetic.log'); writeFileSync(path, 'INFO ready\nERROR synthetic evidence\nWARN later\n');
    const configPath = join(f.dir, 'connector.json');
    writeFileSync(configPath, JSON.stringify({ id: 'synthetic-local', name: 'Synthetic connector', url: f.url, ingestionKey: secrets.ingestToken, registrationKey: proof, handlers: { version: { type: 'process', executable: 'dotnet', arguments: ['--version'] }, logs: { type: 'log-file', path } } }));
    const config = await (await f.call(`/api/agents/${a.runId}/controls`, a.runToken, { actions: [{ id: 'version', label: 'SDK version', kind: 'command', target: 'synthetic-local', handler: 'version' }, { id: 'tail', label: 'Log tail', kind: 'logs', target: 'synthetic-local', handler: 'logs' }] }, 'PUT')).json();
    for (const [actionId, input] of [['version', {}], ['tail', { filter: 'evidence', level: 'error' }]] as const) {
      const invocation = await (await f.call(`/api/controls/${a.runId}/invoke`, secrets.viewerToken, { requestId: actionId, definitionVersion: config.version, actionId, input })).json();
      const child = spawn('dotnet', [resolve(process.env.AV_TEST_SERVER || 'src/AgenticView.Server/bin/Release/net10.0/AgenticView.Server.dll'), '--connector', configPath, '--once'], { windowsHide: true, stdio: 'pipe' });
      let logs = ''; child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c); const [code] = await once(child, 'exit'); assert.equal(code, 0, logs);
      const result = await (await f.call(`/api/controls/${a.runId}/invocations/${invocation.id}`, secrets.viewerToken)).json(); assert.equal(result.state, 'succeeded', JSON.stringify(result));
      if (actionId === 'version') assert.match(result.result.stdout, /^10\./);
      else { assert.equal(result.result.entries.length, 1); assert.match(result.result.entries[0].message, /synthetic evidence/); assert.ok(result.result.cursor); }
    }
    assert.equal((await f.call('/api/connectors/synthetic-local/poll', secrets.viewerToken, {})).status, 403);
    assert.equal((await f.call('/api/connectors/register', secrets.ingestToken, { id: 'synthetic-local', name: 'Other', registrationKey: proof + 'different' })).status, 409);
  } finally { await f.close(); }
});

test('generic row callbacks and million-row data providers use JSON scripts without a database dependency', async () => {
  const f = await fixture();
  try {
    const a = await register(f); const script = join(f.dir, 'generic-handler.mjs');
    writeFileSync(script, "let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);if(input.operation){process.stdout.write(JSON.stringify({row:input.row,rows:input.rows,received:input}));}else{const offset=Number(input.cursor||0);process.stdout.write(JSON.stringify({rows:Array.from({length:Math.min(input.limit||20,200)},(_,i)=>({name:'Synthetic '+(offset+i)})),nextCursor:String(offset+(input.limit||20)),totalRows:5000000,received:input}));}");
    const profile = join(f.dir, 'generic-connector.json');
    writeFileSync(profile, JSON.stringify({ id: 'generic', url: f.url, registrationKey: proof, ingestionKey: secrets.ingestToken, handlers: { mutate: { type: 'process', kind: 'edit', executable: process.execPath, arguments: [script], input: 'json-stdin', output: 'json' }, read: { type: 'process', kind: 'query', executable: process.execPath, arguments: [script], input: 'json-stdin', output: 'json' } } }));
    const configuration = await (await f.call(`/api/agents/${a.runId}/controls`, a.runToken, { actions: [{ id: 'mutate', kind: 'edit', label: 'Row callback', target: 'generic', handler: 'mutate' }, { id: 'read', kind: 'query', label: 'External dataset', target: 'generic', handler: 'read' }] }, 'PUT')).json();
    const values = [{ actionId: 'mutate', input: { operation: 'add', row: { name: 'New' }, rows: [{ name: 'New' }] } }, { actionId: 'mutate', input: { operation: 'update', row: { name: 'Updated' }, previousRow: { name: 'Before' }, rows: [{ name: 'Updated' }], changes: { name: 'Updated' } } }, { actionId: 'mutate', input: { operation: 'delete', row: { name: 'Old' }, rows: [{ name: 'Old' }] } }, { actionId: 'mutate', input: { operation: 'bulk', rows: [{ name: 'A' }, { name: 'B' }] } }, { actionId: 'read', input: { cursor: '4200000', limit: 20, filter: 'Synthetic', sort: [{ key: 'name', direction: 'desc' }], columns: ['name'] } }];
    for (const [index, value] of values.entries()) {
      const queued = await f.call(`/api/controls/${a.runId}/invoke`, secrets.viewerToken, { ...value, requestId: 'generic-' + index, definitionVersion: configuration.version }); assert.equal(queued.status, 200); const invocation = await queued.json();
      const child = spawn('dotnet', [resolve(process.env.AV_TEST_SERVER || 'src/AgenticView.Server/bin/Release/net10.0/AgenticView.Server.dll'), '--connector', profile, '--once'], { windowsHide: true, stdio: 'pipe' }); let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c); const [code] = await once(child, 'exit'); assert.equal(code, 0, output);
      const result = await (await f.call(`/api/controls/${a.runId}/invocations/${invocation.id}`, secrets.viewerToken)).json(); assert.equal(result.state, 'succeeded', JSON.stringify(result)); assert.deepEqual(result.result.received, value.input);
      if (value.actionId === 'read') { assert.equal(result.result.rows.length, 20); assert.equal(result.result.totalRows, 5000000); }
    }
  } finally { await f.close(); }
});
