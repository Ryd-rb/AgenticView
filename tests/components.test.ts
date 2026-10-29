import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComponentView } from '../web/Components.tsx';
import { AgentContent } from '../web/App.tsx';
import type { AgentView } from '../shared/protocol.ts';
import { componentSchema, type Component } from '../shared/protocol.ts';
import { isTaskList } from '../shared/component-order.ts';

const render = (component: Component) => renderToStaticMarkup(createElement(ComponentView, { component, embeds: false, runId: 'synthetic' }));
test('declared worker cards appear before parent display content', () => {
  const parent: AgentView = { id: 'parent', agentId: 'parent', name: 'Parent', role: 'Orchestrator', context: '', parentId: null, createdAt: 1, lastSeen: 1, status: 'active', sequence: 1, layout: { x: 0, y: 0, width: 480, height: 420, z: 1, locked: false }, components: { notes: { id: 'notes', title: 'Parent evidence', kind: 'markdown', data: { text: 'Investigation notes' } } } };
  const worker: AgentView = { ...parent, id: 'worker', name: 'Visible worker', parentId: parent.id, components: {} };
  const html = renderToStaticMarkup(createElement(AgentContent, { agent: parent, agents: [parent, worker], settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: false, reducedMotion: true } }));
  assert.ok(html.indexOf('Visible worker') >= 0 && html.indexOf('Visible worker') < html.indexOf('Parent evidence'));
});
test('task lists lead each agent card before context, workers and evidence regardless of arrival order', () => {
  const parent: AgentView = { id: 'parent', agentId: 'parent', name: 'Parent', role: 'Orchestrator', context: 'Parent context', parentId: null, createdAt: 1, lastSeen: 1, status: 'active', sequence: 1,
    layout: { x: 0, y: 0, width: 480, height: 420, z: 1, locked: false }, components: {
      metric: { id: 'metric', title: 'Evidence metric', kind: 'metric', data: { value: 42 } },
      checklist: { id: 'steps', title: 'Current work', kind: 'markdown', data: { text: '- [ ] Parent task' } },
      plan: { id: 'plan', title: 'Plan', kind: 'markdown', data: { text: 'Parent next steps' } } } };
  const child: AgentView = { ...parent, id: 'worker', name: 'Worker', parentId: parent.id, context: 'Worker context', components: {
    code: { id: 'code', title: 'Worker evidence', kind: 'code', data: { code: 'synthetic' } },
    tasks: { id: 'tasks', title: 'Task list', kind: 'tree', data: { nodes: [{ id: 'next', label: 'Worker task' }] } } } };
  const html = renderToStaticMarkup(createElement(AgentContent, { agent: parent, agents: [parent, child], settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: false, reducedMotion: true } }));
  for (const later of ['Parent context', 'Worker', 'Evidence metric']) assert.ok(html.indexOf('Parent task') < html.indexOf(later));
  assert.ok(html.indexOf('Parent next steps') < html.indexOf('Parent context'));
  assert.ok(html.indexOf('Worker task') < html.indexOf('Worker context')); assert.ok(html.indexOf('Worker task') < html.indexOf('Worker evidence'));
  assert.equal(isTaskList({ id: 'query', title: 'Query plan', kind: 'code', data: { code: 'synthetic' } }), false);
  assert.equal(isTaskList({ id: 'notes', title: 'Notes', kind: 'markdown', data: { text: 'Ordinary evidence' } }), false);
});
test('coding subcards render Markdown plans, escaped code, diffs and modified-file trees', () => {
  assert.match(render({ id: 'plan', kind: 'markdown', title: 'Plan', data: { text: '## Next steps\n- Implement the reader\n<script>unexpected()</script>' } }), /Next steps/);
  assert.doesNotMatch(render({ id: 'plan', kind: 'markdown', title: 'Plan', data: { text: '<script>unexpected()</script>' } }), /<script>/);
  assert.match(render({ id: 'code', kind: 'code', title: 'Code', data: { code: '<script>literal</script>' } }), /&lt;script&gt;/);
  const diff = render({ id: 'diff', kind: 'diff', title: 'Changes', data: { before: 'old\n', after: 'new\n' } }); assert.match(diff, /class="removed"/); assert.match(diff, /class="added"/);
  assert.match(render({ id: 'files', kind: 'tree', title: 'Modified files', data: { nodes: [{ id: 'src', label: 'src' }, { id: 'file', parentId: 'src', label: 'Reader.cs', detail: 'modified' }] } }), /Reader.cs/);
});
test('large tables paginate and logs render a bounded visible range', () => {
  const table = render({ id: 'table', kind: 'table', title: 'Results', data: { columns: [{ key: 'name', label: 'Name' }], rows: Array.from({ length: 100 }, (_, i) => ({ name: `row-${i}` })) } }); assert.match(table, /row-24/); assert.doesNotMatch(table, /row-25</); assert.match(table, /100 rows/);
  const logs = render(componentSchema.parse({ id: 'logs', kind: 'logs', title: 'Logs', data: { entries: Array.from({ length: 2_000 }, (_, i) => ({ message: `entry-${i}`, level: 'info' })) } })); assert.match(logs, /2000 log entries/); assert.doesNotMatch(logs, /entry-1999/);
});


test('ordinary code expands while unusually large output keeps a bounded viewport', () => {
  const ordinary = render({ id: 'ordinary', title: 'Ordinary code', kind: 'code', data: { code: 'line\n'.repeat(40) } });
  assert.doesNotMatch(ordinary, /bounded-output/);
  const large = render({ id: 'large', title: 'Large code', kind: 'code', data: { code: 'line\n'.repeat(301) } });
  assert.match(large, /bounded-output/);
});

test('archived content does not mount live controls or managed session readers', () => {
  const archived: AgentView = { id: 'saved', agentId: 'synthetic', name: 'Saved', role: 'Worker', context: 'Retained context', parentId: null, createdAt: 1, lastSeen: 2, status: 'completed', sequence: 1,
    layout: { x: 0, y: 0, width: 480, height: 420, locked: false, z: 1 }, components: {
      session: { id: 'session', title: 'Retained session', kind: 'agent-session', data: { sessionId: 'session-1' } },
      evidence: { id: 'evidence', title: 'Retained evidence', kind: 'markdown', data: { text: 'Finished investigation' } },
      grid: { id: 'grid', title: 'Configured reader', kind: 'table', data: { sourceAction: 'read', columns: [], rows: [] } }
    } };
  const html = renderToStaticMarkup(createElement(AgentContent, { agent: archived, agents: [], readOnly: true, settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: false, reducedMotion: true } }));
  assert.match(html, /Retained context/); assert.match(html, /Finished investigation/); assert.match(html, /Managed agent session/); assert.match(html, /restore this card/);
  assert.doesNotMatch(html, /session-view|control-view/);
});

test('orphan components render directly without agent context or nested child frames', () => {
  const orphan: AgentView = { id: 'orphan', agentId: 'synthetic', name: 'Internal identity', role: 'Internal role', context: 'Hidden agent wrapper context', parentId: null, createdAt: 1, lastSeen: 2, status: 'active', sequence: 1,
    orphanComponentId: 'display', layout: { x: 0, y: 0, width: 480, height: 420, locked: false, z: 1 }, components: { display: { id: 'display', title: 'Standalone display', kind: 'markdown', data: { text: 'Direct native content' } } } };
  const child = { ...orphan, id: 'child', parentId: orphan.id, name: 'Hidden child wrapper' };
  const html = renderToStaticMarkup(createElement(AgentContent, { agent: orphan, agents: [orphan, child], settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: false, reducedMotion: true } }));
  assert.match(html, /Standalone display/); assert.match(html, /Direct native content/); assert.match(html, /Built-in/);
  assert.doesNotMatch(html, /Hidden agent wrapper|Hidden child wrapper|child-card/);
});
