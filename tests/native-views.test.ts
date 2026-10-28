import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComponentView } from '../web/Components.tsx';
import { AgentContent } from '../web/App.tsx';
import { componentSchema, type Component, type AgentView } from '../shared/protocol.ts';

const render = (component: Component) => renderToStaticMarkup(createElement(ComponentView, { component, embeds: false, runId: 'synthetic' }));
const cases = [
  ['stat-grid', { items: [{ label: 'Rows inspected', value: 42, unit: 'rows', change: '+3' }] }, 'Rows inspected'],
  ['checklist', { items: [{ id: 'read', label: 'Read evidence', status: 'completed', detail: 'Confirmed' }] }, 'Read evidence'],
  ['bar-list', { items: [{ label: 'Slow query', value: 20 }], unit: 'ms' }, 'Slow query'],
  ['histogram', { buckets: [{ label: '0–10ms', count: 3 }] }, '0–10ms'],
  ['heatmap', { rows: ['Worker'], columns: ['Stage'], cells: [{ row: 0, column: 0, value: 4 }] }, 'Worker'],
  ['gauge', { value: 40, max: 100, label: 'Capacity' }, 'Capacity'],
  ['query', { query: 'SELECT id FROM synthetic', columns: [{ key: 'id', label: 'ID' }], rows: [{ id: 'sample-row' }], state: 'success', durationMs: 1234 }, 'sample-row'],
  ['command', { command: 'dotnet build', shell: 'PowerShell', output: 'Build succeeded', exitCode: 0, durationMs: 121_234 }, 'Build succeeded'],
  ['trace', { spans: [{ id: 'read', name: 'Read data', startMs: 0, durationMs: 25 }] }, 'Read data'],
  ['alert', { message: 'Evidence requires review', tone: 'warning', detail: 'Compare the two samples' }, 'Evidence requires review'],
  ['links', { items: [{ label: 'Documentation', url: 'https://example.com/docs', description: 'Synthetic link' }] }, 'Documentation'],
  ['comparison', { items: [{ label: 'Timeout', before: 10, after: 20 }] }, 'Timeout'],
] as const;

for (const [kind, data, expected] of cases) test(`${kind} renders as a typed built-in with useful semantic content`, () => {
  const html = render(componentSchema.parse({ id: 'synthetic', title: 'Evidence', kind, data }));
  assert.match(html, /data-origin="native"/); assert.match(html, /Built-in/); assert.ok(html.includes(expected));
  assert.doesNotMatch(html, /<iframe|<script/);
});

test('custom views remain visibly distinct even when execution is paused', () => {
  const html = render({ id: 'custom', title: 'Custom', kind: 'embed', data: { html: '<script>example()</script>', height: 300 } });
  assert.match(html, /data-origin="custom"/); assert.match(html, /component-origin custom/); assert.match(html, /Custom view/); assert.match(html, /Embedded views are paused/);
});

test('query, command, alert and comparison payloads are text rather than executable markup', () => {
  for (const [kind, data] of [['query', { query: '<script>query()</script>' }], ['command', { command: '<script>command()</script>', output: '<script>output()</script>' }], ['alert', { message: '<script>alert()</script>' }], ['comparison', { items: [{ label: 'HTML', before: '<script>old()</script>', after: '<script>new()</script>' }] }]] as const) {
    const html = render(componentSchema.parse({ id: 'literal', title: 'Literal', kind, data })); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  }
});

test('query results, large heatmaps and execution traces have bounded initial rendering with accessible paging', () => {
  const query = render(componentSchema.parse({ id: 'query', title: 'Results', kind: 'query', data: { query: 'SELECT sample', columns: [{ key: 'id', label: 'ID' }], rows: Array.from({ length: 100 }, (_, i) => ({ id: `sample-${i}` })) } }));
  assert.match(query, /sample-24/); assert.doesNotMatch(query, /sample-25</); assert.match(query, /100 rows/);
  const heatmap = render(componentSchema.parse({ id: 'heatmap', title: 'Distribution', kind: 'heatmap', data: { rows: Array.from({ length: 64 }, (_, i) => `Worker-${i}`), columns: ['Stage'], cells: [] } }));
  assert.match(heatmap, /Worker-15/); assert.doesNotMatch(heatmap, /Worker-16/); assert.match(heatmap, /64 rows/); assert.match(heatmap, /Next/);
  const trace = render(componentSchema.parse({ id: 'trace', title: 'Spans', kind: 'trace', data: { spans: Array.from({ length: 500 }, (_, i) => ({ id: `span-${i}`, name: `Operation-${i}`, startMs: i, durationMs: 1 })) } }));
  assert.match(trace, /Operation-49/); assert.doesNotMatch(trace, /Operation-50/); assert.match(trace, /500 spans/);
});

test('native checklists lead each agent and preserve observed elapsed timing', () => {
  const agent: AgentView = { id: 'parent', agentId: 'synthetic', name: 'Synthetic', role: 'Test', context: 'Supporting context', parentId: null, createdAt: 1, lastSeen: 2, status: 'active', sequence: 1, layout: { x: 0, y: 0, width: 480, height: 420, z: 1, locked: false }, components: {
    evidence: { id: 'evidence', title: 'Supporting metric', kind: 'metric', data: { value: 42 } },
    tasks: { id: 'tasks', title: 'Current work', kind: 'checklist', data: { items: [{ id: 'read', label: 'Native task', status: 'completed' }] } }
  }, taskTimes: { tasks: [{ key: 'checklist:read', line: 1, firstSeenAt: 1000, startedAt: 1000, completedAt: 2234, updatedAt: 2234 }] } };
  const html = renderToStaticMarkup(createElement(AgentContent, { agent, agents: [agent], settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: false, reducedMotion: true } }));
  assert.ok(html.indexOf('Native task') < html.indexOf('Supporting context')); assert.ok(html.indexOf('Native task') < html.indexOf('Supporting metric')); assert.match(html, /Duration 1.234s/);
});
