import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, secrets } from './server-fixture.ts';

test('authentication matches API and MCP routing across casing and trailing slashes', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/snapshot', '/API/SNAPSHOT', '/Api/Monitoring/', '/API/EVENTS/']) {
      assert.equal((await f.call(path)).status, 401, path);
      assert.equal((await f.call(path, secrets.ingestToken)).status, 401, path + ' ingestion key');
    }
    for (const path of ['/API/AGENTS/REGISTER', '/api/agents/register/']) {
      const body = { requestId: randomUUID(), registrationKey: randomUUID(), agentId: 'synthetic', name: 'Synthetic' };
      assert.equal((await f.call(path, '', body)).status, 401, path);
      assert.equal((await f.call(path, secrets.viewerToken, body)).status, 401, path + ' viewer key');
      assert.equal((await f.call(path, secrets.ingestToken, body)).status, 201, path + ' ingestion key');
    }
    for (const path of ['/MCP', '/mcp/']) assert.equal((await f.call(path, '', {})).status, 401, path);
    assert.equal((await f.call('/API/SNAPSHOT/', secrets.viewerToken)).status, 200);
  } finally { await f.close(); }
});
