import test from 'node:test';
import assert from 'node:assert/strict';
import { AgenticViewClient } from '../clients/client.ts';
import { fixture, secrets } from './server-fixture.ts';

test('client reconciles an accepted batch after all retry responses are lost', async () => {
  const f = await fixture(); const original = globalThis.fetch;
  try {
    const client = await AgenticViewClient.connect(f.url, secrets.ingestToken, { agentId: 'client', name: 'Synthetic client' });
    let lost = 0;
    globalThis.fetch = async (input, init) => { const response = await original(input, init); if (String(input).endsWith('/publish') && lost++ < 3) { await response.arrayBuffer(); throw new TypeError('Synthetic lost response'); } return response; };
    await assert.rejects(client.display({ id: 'metric', title: 'Rows', kind: 'metric', data: { value: 1 } }), /lost response/);
    await client.display({ id: 'metric', title: 'Rows', kind: 'metric', data: { value: 2 } });
    const snapshot = await (await f.call('/api/snapshot', secrets.viewerToken)).json();
    assert.equal(snapshot.agents[0].sequence, 2); assert.equal(snapshot.agents[0].components.metric.data.value, 2); assert.equal(snapshot.stats.updates, 2);
    await client.archive();
  } finally { globalThis.fetch = original; await f.close(); }
});
