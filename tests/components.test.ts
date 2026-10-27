import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComponentView } from '../web/Components.tsx';
import { AgentContent } from '../web/App.tsx';
import type { AgentView } from '../shared/protocol.ts';
import { componentSchema, type Component } from '../shared/protocol.ts';

const render = (component: Component) => renderToStaticMarkup(createElement(ComponentView, { component, embeds: false, runId: 'synthetic' }));
test('declared worker cards appear before parent display content', () => {
  const parent: AgentView = { id: 'parent', agentId: 'parent', name: 'Parent', role: 'Orchestrator', context: '', parentId: null, createdAt: 1, lastSeen: 1, status: 'active', sequence: 1, layout: { x: 0, y: 0, width: 480, height: 420, z: 1, locked: false }, components: { plan: { id: 'plan', title: 'Parent evidence', kind: 'markdown', data: { text: 'Parent plan' } } } };
  const worker: AgentView = { ...parent, id: 'worker', name: 'Visible worker', parentId: parent.id, components: {} };
  const html = renderToStaticMarkup(createElement(AgentContent, { agent: parent, agents: [parent, worker], settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: false, reducedMotion: true } }));
  assert.ok(html.indexOf('Visible worker') >= 0 && html.indexOf('Visible worker') < html.indexOf('Parent evidence'));
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
