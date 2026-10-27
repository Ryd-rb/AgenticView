import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLivePatch, rootAgents } from '../shared/live-state.ts';
import type { AgentView, Snapshot } from '../shared/protocol.ts';

const agent: AgentView = { id: 'new', agentId: 'synthetic', name: 'Synthetic', role: 'Agent', context: '', parentId: null, createdAt: 1, lastSeen: 1, status: 'active', sequence: 0, components: {}, layout: { x: 0, y: 0, width: 480, height: 420, z: 1, locked: false, automatic: true } };
const empty: Snapshot = { revision: 0, agents: [], settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: true, reducedMotion: false }, stats: { active: 0, stale: 0, archived: 0, updates: 0, updatesPerSecond: 0 } };

test('live arrivals, descendants and recovery form the same visible tree as a snapshot', () => {
  const parent = applyLivePatch(empty, { revision: 1, changes: [{ id: agent.id, meta: agent }], removed: [], stats: { ...empty.stats, active: 1 } });
  const child = { ...agent, id: 'child', parentId: agent.id };
  const nested = applyLivePatch(parent, { revision: 2, changes: [{ id: child.id, meta: child }], removed: [], stats: { ...empty.stats, active: 2 } });
  assert.deepEqual(rootAgents(nested.agents).map(a => a.id), ['new']);
  const orphan = applyLivePatch(nested, { revision: 3, changes: [], removed: ['new'], stats: { ...empty.stats, active: 1 } }); assert.deepEqual(rootAgents(orphan.agents).map(a => a.id), ['child']);
  const restored = applyLivePatch(orphan, { revision: 4, changes: [{ id: 'new', meta: agent, clear: true, components: [{ id: 'plan', title: 'Plan', kind: 'markdown', data: { text: 'Recovered' } }] }], removed: [], stats: { ...empty.stats, active: 2 } });
  assert.equal(restored.agents.find(a => a.id === 'new')?.components.plan.kind, 'markdown'); assert.deepEqual(rootAgents(restored.agents).map(a => a.id), ['new']);
  assert.equal(orphan.agents.length, 1); assert.equal(applyLivePatch(restored, { revision: 2, changes: [], removed: ['new'], stats: empty.stats }), restored);
});
