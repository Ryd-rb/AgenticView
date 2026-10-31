import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, secrets } from './server-fixture.ts';

test('easy UI MCP follows copyable calls, scopes capabilities and retains exact retries across target refresh', { timeout: 40000 }, async () => {
  const f = await fixture(), client = new Client({ name: 'synthetic-easy-ui', version: '1' });
  let running = true, viewer: Promise<void> | undefined, reference = 'e' + randomUUID().replaceAll('-', ''), disconnect = false;
  const claimed: any[] = [];
  async function json(response: Response) { const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text); }
  async function tool(name: string, args: Record<string, unknown>) { const response = await client.callTool({ name, arguments: args }); assert.ok(!response.isError, JSON.stringify(response)); return response.structuredContent as any; }
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.url), { requestInit: { headers: { Authorization: `Bearer ${secrets.ingestToken}` } } }));
    const listed=await client.listTools(),actionSchema=(listed.tools.find(t=>t.name==='ui_action')!.inputSchema.properties as any).action;
    assert.equal(actionSchema.type,'string');assert.deepEqual(actionSchema.enum,['click','type','press','scroll','focus','zoom','metrics','profile','layers']);
    const registered = await f.call('/api/agents/register', secrets.ingestToken, { requestId: 'easy-run', registrationKey: 'synthetic-easy-registration-proof', agentId: 'easy-run', name: 'Easy run' });
    assert.equal(registered.status, 201); const { runId, runToken } = await registered.json() as any;
    assert.equal((await tool('ui_open', { runId, runToken: 'wrong' })).status, 403);
    assert.equal((await tool('ui_open', { runId, runToken })).state, 'error', 'No viewer yields actionable error rather than inventing a session');
    assert.equal((await tool('ui_open_card', { cardId: runId, operatorToken: secrets.ingestToken })).status, 403);
    const body = { clientId: randomUUID(), clientToken: 'synthetic-viewer-proof-0123456789abcdef', cardIds: [runId], visible: true, platform: 'desktop' };
    await json(await f.call('/api/debug/poll', secrets.viewerToken, body));
    viewer = (async () => {
      while (running) {
        const poll = await json(await f.call('/api/debug/poll', secrets.viewerToken, body));
        for (const job of poll.jobs) {
          claimed.push(job);
          if (disconnect) { await json(await f.call('/api/debug/disconnect', secrets.viewerToken, { clientId: body.clientId, clientToken: body.clientToken })); running = false; break; }
          const result = job.command.operation === 'inspect' ? { components: [{ id: 'chart', targets: [
            { target: { ref: reference }, name: 'Series 1', role: 'button', visible: true, disabled: false, actions: ['click', 'focus'] },
            { target: { ref: 'e' + randomUUID().replaceAll('-', '') }, name: 'Operational action', role: 'button', visible: true, actions: [] },
          ] }] } : { synthetic: true, operation: job.command.operation };
          await json(await f.call('/api/debug/complete', secrets.viewerToken, { clientId: body.clientId, clientToken: body.clientToken, commandId: job.id, claimToken: job.claimToken, state: 'succeeded', result }));
        }
        if (running) await new Promise(resolve => setTimeout(resolve, 15));
      }
    })();
    const opened = await tool('ui_open', { runId, runToken, componentId: 'chart' });
    assert.equal(opened.state, 'succeeded'); assert.equal(opened.targets.length, 1);
    assert.deepEqual(opened.targets[0], { ref: reference, label: 'Series 1', role: 'button', componentId: 'chart', allowedActions: ['click', 'focus'] });
    assert.equal(opened.nextCall.tool, 'ui_action'); assert.equal(opened.nextCall.arguments.requestId, opened.nextActionId);
    assert.ok(!JSON.stringify(opened).includes(runToken)); assert.ok(!JSON.stringify(opened).includes(body.clientToken));
    const action = { debugId: opened.debugId, requestId: opened.nextActionId, action: 'click', targetRef: reference };
    const clicked = await tool('ui_action', action); assert.equal(clicked.state, 'succeeded', JSON.stringify(clicked));
    assert.deepEqual(claimed.find(job => job.id === clicked.commandId).command, { operation: 'click', componentId: 'chart', target: { ref: reference } });
    const count = claimed.length; assert.equal((await tool('ui_action', action)).commandId, clicked.commandId); assert.equal(claimed.length, count);
    assert.equal((await tool('ui_action', { ...action, action: 'focus' })).status, 409);
    const denied = await tool('ui_action', { debugId: opened.debugId, requestId: clicked.nextActionId, action: 'type', targetRef: reference, value: 'draft' });
    assert.equal(denied.status, 403); assert.deepEqual(denied.allowedActions, ['click', 'focus']);
    assert.equal((await tool('ui_action', { debugId: opened.debugId, requestId: clicked.nextActionId, action: 'zoom', zoom: 0 })).status, 400);
    assert.equal((await tool('ui_wait', { debugId: opened.debugId + 'bad', commandId: clicked.commandId })).status, 403);
    reference = 'e' + randomUUID().replaceAll('-', ''); const refreshed = await tool('ui_inspect', { debugId: opened.debugId });
    assert.equal(refreshed.targets[0].ref, reference);
    const historical = await tool('ui_wait', { debugId: opened.debugId, commandId: opened.commandId });
    assert.equal(historical.targets[0].ref, reference, 'Reading an older inspection must not replace the newest target mapping');
    assert.equal((await tool('ui_action', { ...action, requestId: refreshed.nextActionId })).status, 409, 'Old refs cannot create a new action after refresh');
    assert.equal((await tool('ui_action', action)).commandId, clicked.commandId, 'Exact old retry works after current target mapping changes');
    const focused = await tool('ui_action', { debugId: opened.debugId, requestId: refreshed.nextActionId, action: 'focus', targetRef: reference });
    assert.equal(focused.state, 'succeeded', JSON.stringify(focused));
    assert.deepEqual(claimed.find(job => job.id === focused.commandId).command.target, { ref: reference }, 'The new reference remains actionable after reading old inspection history');
    const reopened = await tool('ui_open_card', { cardId: runId, operatorToken: secrets.viewerToken, componentId: 'chart' });
    assert.equal(reopened.debugId, opened.debugId, 'Operator opening reuses the same live scoped lease');
    disconnect = true;
    const uncertainArgs = { debugId: opened.debugId, requestId: reopened.nextActionId, action: 'metrics' };
    const uncertain = await tool('ui_action', uncertainArgs); assert.equal(uncertain.state, 'unknown');
    const claimedAtDisconnect = claimed.length;
    assert.equal((await tool('ui_action', uncertainArgs)).commandId, uncertain.commandId);
    assert.equal(claimed.length, claimedAtDisconnect, 'Unknown claimed actions are never queued for replay');
    assert.equal((await tool('ui_action', { ...uncertainArgs, requestId: uncertain.nextActionId })).state, 'error', 'Closed/offline leases refuse new actions');
    assert.equal((await tool('ui_close', { debugId: opened.debugId })).state, 'closed');
    assert.equal((await tool('ui_close', { debugId: opened.debugId })).state, 'closed');
  } finally { running = false; await viewer; await client.close(); await f.close(); }
});
