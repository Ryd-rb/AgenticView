import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, secrets } from './server-fixture.ts';
import { componentSchema } from '../shared/protocol.ts';
import { applicationManifestSchema } from '../shared/application-manifest.ts';

test('goal guide is bounded, read-only and references actual tools with all required arguments', { timeout: 20000 }, async () => {
  const f = await fixture(), client = new Client({ name: 'synthetic-guide-contract', version: '1' });
  const snapshot = async () => { const response = await f.call('/api/snapshot', secrets.viewerToken); assert.equal(response.status, 200); return await response.json() as any; };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.url), { requestInit: { headers: { Authorization: `Bearer ${secrets.ingestToken}` } } }));
    const tools = (await client.listTools()).tools, names = new Map(tools.map(tool => [tool.name, tool]));
    const guideTool = names.get('ui_guide'); assert.ok(guideTool); assert.equal(guideTool.annotations?.readOnlyHint, true);
    const before = await snapshot(), goals = ['start', 'create', 'style', 'data', 'debug', 'test', 'windows', 'templates'];
    for (const goal of goals) {
      const response = await client.callTool({ name: 'ui_guide', arguments: { goal } }); assert.ok(!response.isError, JSON.stringify(response));
      const guide = response.structuredContent as any; assert.equal(guide.goal, goal); assert.equal(guide.readOnly, true); assert.equal(guide.executesTools, false);
      assert.ok(Buffer.byteLength(JSON.stringify(guide)) < 8192, goal); assert.ok(guide.steps.length > 0 && guide.steps.length <= 5);
      assert.match(guide.placeholders, /NOT working credentials/);
      for (const secret of Object.values(secrets)) assert.ok(!JSON.stringify(guide).includes(secret));
      for (const call of [guide.nextCall, ...guide.examples]) {
        const actual = names.get(call.tool); assert.ok(actual, `Unknown suggested tool ${call.tool}`);
        const required = actual.inputSchema.required ?? [];
        for (const field of required) assert.ok(Object.hasOwn(call.arguments, field), `${goal}: ${call.tool} missing ${field}`);
        assert.ok(call.effect.length > 0, 'Mutations and read-only calls describe their actual effect');
        if (call.tool === 'agent_publish') for (const operation of call.arguments.operations) componentSchema.parse(operation.component);
        if (call.tool === 'application_define') applicationManifestSchema.parse(call.arguments.manifest);
      }
      if (goal === 'windows') assert.match(guide.steps.join(' '), /no dedicated MCP pop-out tool/);
      if (goal === 'data') assert.match(guide.steps.join(' '), /provider/);
      if (goal === 'debug') assert.match(guide.steps.join(' '), /never re-execute an unknown/);
      const retry = await client.callTool({ name: 'ui_guide', arguments: { goal } }); assert.deepEqual(retry.structuredContent, guide, 'Static guidance is deterministic and carries no live user state');
    }
    const invalid = await client.callTool({ name: 'ui_guide', arguments: { goal: 'execute-anything' } }); assert.ok(invalid.isError);
    const after = await snapshot(); assert.deepEqual(after.agents, before.agents); assert.deepEqual(after.settings, before.settings);
  } finally { await client.close(); await f.close(); }
});
