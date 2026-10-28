import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, secrets } from './server-fixture.ts';
import type { MonitoringSnapshot } from '../shared/monitoring.ts';

test('monitoring requires viewer authentication and reports bounded rates, inventory and viewer lifecycle', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/api/monitoring')).status, 401);
    assert.equal((await f.call('/api/monitoring', secrets.ingestToken)).status, 401);
    const read = async () => { const response = await f.call('/api/monitoring', secrets.viewerToken); assert.equal(response.status, 200); return response.json() as Promise<MonitoringSnapshot>; };
    const registered = await (await f.call('/api/agents/register', secrets.ingestToken, { requestId: randomUUID(), registrationKey: randomUUID(), agentId: 'synthetic', name: 'Synthetic publisher' })).json();
    const path = `/api/agents/${registered.runId}/publish`, body = { sequence: 1, operations: [{ op: 'upsert', component: { id: 'count', title: 'Count', kind: 'metric', data: { value: 42 } } }, { op: 'context', text: 'PRIVATE_SYNTHETIC_CONTEXT' }] };
    assert.equal((await f.call(path, registered.runToken, body)).status, 200);
    assert.equal((await f.call(path, registered.runToken, body)).status, 200);
    const current = await read(); assert.equal(current.active, 1); assert.equal(current.liveAgents, 1); assert.equal(current.components, 1); assert.equal(current.acceptedOperations, 2); assert.equal(current.duplicateBatches, 1); assert.equal(current.agents[0]!.name, 'Synthetic publisher');
    assert.equal(JSON.stringify(current).includes('PRIVATE_SYNTHETIC_CONTEXT'), false); assert.equal(JSON.stringify(current).includes(registered.runToken), false);
    const controller = new AbortController(), stream = await fetch(f.url + '/api/events', { headers: { Authorization: `Bearer ${secrets.viewerToken}` }, signal: controller.signal }), reader = stream.body!.getReader(); await reader.read();
    assert.equal((await read()).viewerStreams, 1); await reader.cancel(); controller.abort();
    let latest = current;
    for (let i = 0; i < 30; i++) { latest = await read(); if (latest.history.length && latest.viewerStreams === 0) break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(latest.viewerStreams, 0); assert.ok(latest.history.length > 0 && latest.history.length <= 300); assert.ok(latest.history.every(sample => Number.isFinite(sample.updatesPerSecond) && sample.updatesPerSecond >= 0));
    assert.ok(latest.kinds.some(kind => kind.kind === 'metric' && kind.components === 1 && kind.operations === 1));
  } finally { await f.close(); }
});
