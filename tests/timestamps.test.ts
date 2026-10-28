import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compactTime, timePrecision } from '../shared/time-format.ts';
import { ArrivalTracker } from '../shared/arrivals.ts';
import { ComponentView } from '../web/Components.tsx';
import { AgentContent } from '../web/App.tsx';
import type { AgentView, TaskTiming } from '../shared/protocol.ts';

test('compact task clocks preserve milliseconds, seconds or minutes according to event spacing', () => {
  const at = Date.UTC(2026, 9, 28, 10, 11, 12, 345);
  assert.equal(timePrecision(999), 'millisecond'); assert.equal(timePrecision(60_000), 'second'); assert.equal(timePrecision(600_000), 'minute');
  assert.match(compactTime(at, 1234), /^\d{2}:\d{2}:\d{2}\.345$/);
  assert.match(compactTime(at, 120_000), /^\d{2}:\d{2}:\d{2}$/);
  assert.match(compactTime(at, 1_200_000), /^\d{2}:\d{2}$/);
});

test('task row times follow source lines and retain exact accessible times without changing task text', () => {
  const start = Date.UTC(2026, 9, 28, 10), tasks: TaskTiming[] = [
    { key: 'a', line: 1, firstSeenAt: start, startedAt: start, completedAt: start + 1234, updatedAt: start + 1234 },
    { key: 'b', line: 2, firstSeenAt: start, startedAt: start, completedAt: start + 121_234, updatedAt: start + 121_234 },
    { key: 'c', line: 3, firstSeenAt: start, startedAt: start, completedAt: start + 1_321_234, updatedAt: start + 1_321_234 }
  ];
  const html = renderToStaticMarkup(createElement(ComponentView, { component: { id: 'plan', title: 'Plan', kind: 'markdown', data: { text: '- [x] Read evidence\n- [x] Run checks\n- [x] Finish review\n- Plain note' } }, embeds: false, runId: 'synthetic', updatedAt: start + 1_321_234, taskTimes: tasks }));
  assert.equal((html.match(/class="task-time"/g) ?? []).length, 3);
  for (const task of tasks) assert.ok(html.includes(new Date(task.completedAt!).toISOString()));
  assert.match(html, /Observed interval 1234 ms/); assert.match(html, /Read evidence/); assert.match(html, /Plain note/);
  assert.match(html, /class="component-time"/);
});

test('initial snapshot is quiet and new-arrival color starts only on first visibility', () => {
  const arrivals = new ArrivalTracker(); arrivals.sync(['old']); assert.equal(arrivals.isPending('old'), false);
  arrivals.sync(['old', 'new']); assert.equal(arrivals.visibleAt('new'), undefined); assert.equal(arrivals.isPending('new'), true);
  assert.equal(arrivals.firstVisible('new', 1234), 1234); assert.equal(arrivals.firstVisible('new', 9876), 1234);
  arrivals.sync(['old']); assert.equal(arrivals.visibleAt('new'), undefined);
});

test('completed child cards carry status and a prominent archive action with lifecycle times', () => {
  const parent: AgentView = { id: 'parent', agentId: 'parent', name: 'Parent', role: 'Orchestrator', context: '', parentId: null, createdAt: 1000, lastSeen: 2000, status: 'active', sequence: 1, components: {}, layout: { x: 0, y: 0, width: 480, height: 420, z: 1, locked: false } };
  const child: AgentView = { ...parent, id: 'child', name: 'Child', parentId: parent.id, status: 'completed', completedAt: 3000 };
  const html = renderToStaticMarkup(createElement(AgentContent, { agent: parent, agents: [parent, child], settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: false, reducedMotion: true } }));
  assert.match(html, /child-card status-completed/); assert.match(html, /archive-completed/); assert.match(html, /Task completed/); assert.match(html, /Arrived/); assert.match(html, /Completed/);
});
