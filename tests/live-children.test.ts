import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, secrets } from './server-fixture.ts';
import { applyLivePatch, rootAgents } from '../shared/live-state.ts';
import type { Component, Patch, Snapshot } from '../shared/protocol.ts';

type Credentials = { runId: string; runToken: string };

test('one live viewer follows late children, archive promotion and parent recovery', { timeout: 20_000 }, async () => {
  const f = await fixture();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('Live child pipeline exceeded ten seconds')), 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await fetch(f.url + '/api/events', {
      headers: { Authorization: `Bearer ${secrets.viewerToken}` }, signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.ok(stream.body);
    reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function event(): Promise<{ type: string | undefined; value: Snapshot | Patch }> {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const lines = frame.split('\n');
          const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          if (data) return { type: lines.find(line => line.startsWith('event: '))?.slice(7), value: JSON.parse(data) };
        } else {
          const next = await reader!.read();
          assert.equal(next.done, false, 'The original viewer stream must remain connected');
          buffer += decoder.decode(next.value, { stream: true });
        }
      }
    }
    const initial = await event();
    assert.equal(initial.type, 'snapshot');
    let view = initial.value as Snapshot;
    assert.equal(view.agents.length, 0, 'Viewer connects before any producer registers');
    async function until(predicate: () => boolean) {
      for (let count = 0; !predicate() && count < 50; count++) {
        const message = await event();
        assert.equal(message.type, 'patch', 'All later state must arrive as deltas on the original connection');
        view = applyLivePatch(view, message.value as Patch);
      }
      assert.ok(predicate(), 'Expected live state was not delivered within fifty deltas');
    }
    async function post(path: string, token: string, data: unknown, status = 200) {
      const response = await fetch(f.url + path, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data), signal: controller.signal,
      });
      assert.equal(response.status, status, path);
      return response.json();
    }
    async function register(id: string, parent?: Credentials): Promise<Credentials> {
      return post('/api/agents/register', secrets.ingestToken, {
        requestId: id, registrationKey: `synthetic-private-child-recovery-key-${id}`,
        agentId: id, name: `Synthetic ${id}`, role: parent ? 'Worker' : 'Orchestrator',
        ...(parent ? { parentId: parent.runId, parentToken: parent.runToken } : {}),
      }, 201);
    }
    const publish = (run: Credentials, sequence: number, components: Component[]) => post(
      `/api/agents/${run.runId}/publish`, run.runToken,
      { sequence, operations: components.map(component => ({ op: 'upsert', component })) },
    );

    const parent = await register('parent');
    const parentEvidence: Component = { id: 'evidence', title: 'Parent evidence', kind: 'markdown', data: { text: 'Retained across archive and recovery' } };
    await publish(parent, 1, [parentEvidence]);
    await until(() => !!view.agents.find(agent => agent.id === parent.runId)?.components.evidence);
    const children: Credentials[] = [];
    for (const id of ['child-a', 'child-b']) {
      const child = await register(id, parent); children.push(child);
      await publish(child, 1, [
        { id: 'progress', title: 'Progress', kind: 'metric', data: { value: 1 } },
        { id: 'plan', title: 'Plan', kind: 'markdown', data: { text: `Plan for ${id}` } },
      ]);
      await until(() => !!view.agents.find(agent => agent.id === child.runId)?.components.plan);
    }
    assert.equal(view.agents.length, 3);
    assert.deepEqual(rootAgents(view.agents).map(agent => agent.id), [parent.runId]);
    for (const child of children) assert.equal(view.agents.find(agent => agent.id === child.runId)?.parentId, parent.runId);

    await publish(children[0], 2, [{ id: 'progress', title: 'Progress', kind: 'metric', data: { value: 2 } }]);
    await until(() => view.agents.find(agent => agent.id === children[0].runId)?.sequence === 2);
    assert.deepEqual(view.agents.find(agent => agent.id === children[0].runId)?.components.plan.data, { text: 'Plan for child-a' });
    assert.deepEqual(view.agents.find(agent => agent.id === children[0].runId)?.components.progress.data, { value: 2 });

    await post(`/api/agents/${parent.runId}/archive`, parent.runToken, {});
    await until(() => !view.agents.some(agent => agent.id === parent.runId));
    assert.deepEqual(rootAgents(view.agents).map(agent => agent.id).sort(), children.map(child => child.runId).sort());
    assert.equal(view.stats.archived, 1);

    const recovered = await post(`/api/agents/${parent.runId}/publish`, parent.runToken, {
      sequence: 2, operations: [{ op: 'context', text: 'Parent resumed' }],
    });
    assert.equal(recovered.restored, true);
    await until(() => view.agents.find(agent => agent.id === parent.runId)?.sequence === 2);
    const restored = view.agents.find(agent => agent.id === parent.runId)!;
    assert.equal(restored.context, 'Parent resumed');
    assert.deepEqual(restored.components.evidence, parentEvidence, 'Recovery delta must include archived components absent from the viewer');
    assert.deepEqual(rootAgents(view.agents).map(agent => agent.id), [parent.runId]);
    assert.equal(view.stats.archived, 0);
    for (const child of children) {
      const agent = view.agents.find(agent => agent.id === child.runId)!;
      assert.equal(agent.parentId, parent.runId);
      assert.deepEqual(Object.keys(agent.components).sort(), ['plan', 'progress']);
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    await f.close();
  }
});
