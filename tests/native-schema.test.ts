import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { componentSchema } from '../shared/protocol.ts';
import { isTaskList } from '../shared/component-order.ts';

const cases: { name: string; input: unknown; valid: boolean }[] = [];
const add = (name: string, kind: string, data: unknown, valid = true) => cases.push({ name, input: { id: 'synthetic', title: 'Synthetic', kind, data }, valid });
add('stat grid scalars', 'stat-grid', { items: [{ label: 'Rows', value: null }, { label: 'Ready', value: true, tone: 'success' }] });
add('stat grid maximum', 'stat-grid', { items: Array.from({ length: 24 }, () => ({ label: 'x'.repeat(160), value: 1 })) });
add('stat grid overflow', 'stat-grid', { items: Array.from({ length: 25 }, () => ({ label: 'x', value: 1 })) }, false);
add('stat grid missing scalar', 'stat-grid', { items: [{ label: 'x' }] }, false);
add('checklist maximum', 'checklist', { items: Array.from({ length: 200 }, (_, i) => ({ id: 'item-' + i, label: 'Task', status: 'blocked' })) });
add('checklist duplicate ids', 'checklist', { items: [{ id: 'one', label: 'A', status: 'pending' }, { id: 'one', label: 'B', status: 'active' }] }, false);
add('checklist invalid status', 'checklist', { items: [{ id: 'one', label: 'A', status: 'success' }] }, false);
add('checklist overflow', 'checklist', { items: Array.from({ length: 201 }, (_, i) => ({ id: 'item-' + i, label: 'Task', status: 'pending' })) }, false);
add('bar list maximum', 'bar-list', { items: Array.from({ length: 100 }, () => ({ label: 'A', value: 0 })) });
add('negative bar', 'bar-list', { items: [{ label: 'A', value: -1 }] }, false);
add('bar list overflow', 'bar-list', { items: Array.from({ length: 101 }, () => ({ label: 'A', value: 1 })) }, false);
add('histogram maximum', 'histogram', { buckets: Array.from({ length: 100 }, () => ({ label: 'x', count: Number.MAX_SAFE_INTEGER })) });
add('fractional histogram', 'histogram', { buckets: [{ label: 'x', count: .5 }] }, false);
add('negative histogram', 'histogram', { buckets: [{ label: 'x', count: -1 }] }, false);
add('heatmap full dimensions', 'heatmap', { columns: Array.from({ length: 32 }, (_, i) => '' + i), rows: Array.from({ length: 64 }, (_, i) => '' + i), cells: Array.from({ length: 2048 }, (_, i) => ({ row: Math.floor(i / 32), column: i % 32, value: -i })) });
add('heatmap out of actual dimensions', 'heatmap', { columns: ['A'], rows: ['B'], cells: [{ row: 1, column: 0, value: 1 }] }, false);
add('heatmap duplicate coordinates', 'heatmap', { columns: ['A'], rows: ['B'], cells: [{ row: 0, column: 0, value: 1 }, { row: 0, column: 0, value: 2 }] }, false);
add('heatmap empty dimensions', 'heatmap', { columns: [], rows: ['B'], cells: [] }, false);
add('gauge defaults', 'gauge', { value: 150 });
add('gauge negative range', 'gauge', { value: -1, min: -5, max: 0 });
add('gauge equal bounds', 'gauge', { value: 1, min: 1, max: 1 }, false);
add('gauge inverted range', 'gauge', { value: 1, min: 2, max: 1 }, false);
add('query defaults', 'query', { query: 'select 1' });
add('query typed rows', 'query', { query: 'select value', columns: [{ key: 'value', label: 'Value' }], rows: [{ value: 1 }, { value: null }, { value: false }], durationMs: 0, totalRows: 3, state: 'success' });
add('query rows without columns', 'query', { query: 'select 1', rows: [{ value: 1 }] }, false);
add('query fractional total', 'query', { query: 'select 1', totalRows: 1.5 }, false);
add('query nested scalar', 'query', { query: 'select 1', columns: [{ key: 'value', label: 'Value' }], rows: [{ value: {} }] }, false);
add('query negative duration', 'query', { query: 'select 1', durationMs: -1 }, false);
add('command minimum exit code', 'command', { command: 'synthetic', exitCode: -2147483648, durationMs: 0, output: 'No execution occurs here.' });
add('command maximum exit code', 'command', { command: 'synthetic', exitCode: 2147483647 });
add('command exit overflow', 'command', { command: 'synthetic', exitCode: 2147483648 }, false);
add('command fractional exit', 'command', { command: 'synthetic', exitCode: .5 }, false);
add('trace parent after child', 'trace', { spans: [{ id: 'child', parentId: 'root', name: 'Child', startMs: 1, durationMs: 2 }, { id: 'root', name: 'Root', startMs: 0, durationMs: 5 }] });
add('trace maximum chain', 'trace', { spans: Array.from({ length: 500 }, (_, i) => ({ id: 'span-' + i, ...(i ? { parentId: 'span-' + (i - 1) } : {}), name: 'Span', startMs: i, durationMs: 1 })) });
add('trace missing parent', 'trace', { spans: [{ id: 'a', parentId: 'missing', name: 'A', startMs: 0, durationMs: 0 }] }, false);
add('trace cycle', 'trace', { spans: [{ id: 'a', parentId: 'b', name: 'A', startMs: 0, durationMs: 0 }, { id: 'b', parentId: 'a', name: 'B', startMs: 0, durationMs: 0 }] }, false);
add('trace duplicate id', 'trace', { spans: [{ id: 'a', name: 'A', startMs: 0, durationMs: 0 }, { id: 'a', name: 'B', startMs: 0, durationMs: 0 }] }, false);
add('trace negative start', 'trace', { spans: [{ id: 'a', name: 'A', startMs: -1, durationMs: 0 }] }, false);
add('alert defaults', 'alert', { message: 'Reported observation' });
add('alert invalid tone', 'alert', { message: 'A', tone: 'critical' }, false);
add('alert detail overflow', 'alert', { message: 'A', detail: 'x'.repeat(131073) }, false);
add('links http and https', 'links', { items: [{ label: 'Docs', url: 'https://example.com/a?q=1#part' }, { label: 'Local', url: 'http://localhost:4317/' }] });
for (const url of ['javascript:alert(1)', 'file:///test', 'https://user:pass@example.com/', 'https://@example.com/', '/relative', 'https://example.com/ has-space']) add('links reject ' + url, 'links', { items: [{ label: 'Unsafe', url }] }, false);
add('comparison scalar types', 'comparison', { items: [{ label: 'State', before: null, after: true }, { label: 'Rows', before: 1, after: 'two' }] });
add('comparison missing before', 'comparison', { items: [{ label: 'A', after: 1 }] }, false);
add('comparison nested scalar', 'comparison', { items: [{ label: 'A', before: [], after: 1 }] }, false);

test('native catalog schema accepts boundaries and rejects invalid relationships', () => {
  for (const item of cases) assert.equal(componentSchema.safeParse(item.input).success, item.valid, item.name);
  assert.equal(componentSchema.safeParse({ id: 'x', title: 'X', kind: 'gauge', data: { value: Infinity } }).success, false);
  const checklist = componentSchema.parse({ id: 'work', title: 'Work', kind: 'checklist', data: { items: [] } });
  assert.equal(isTaskList(checklist), true, 'Every native checklist sorts as a plan');
});

test('C# native validation and normalization agree with TypeScript for the same bounded cases', () => {
  const process = spawnSync('dotnet', ['run', '--project', 'tests/AgenticView.Contracts', '-c', 'Release', '--no-restore', '--', '--native-validation-probe'], { input: JSON.stringify(cases.map(item => item.input)), encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(process.status, 0, process.stderr || process.error?.message);
  const line = process.stdout.split(/\r?\n/).find(value => value.startsWith('[{"ok"'));
  assert.ok(line, process.stdout);
  const results = JSON.parse(line) as { ok: boolean; value?: unknown }[];
  assert.equal(results.length, cases.length);
  // Compare the JSON transport representation (for example, JSON canonicalizes -0 to 0).
  for (const [index, item] of cases.entries()) { const result = results[index]!; assert.equal(result.ok, item.valid, 'C# ' + item.name); if (item.valid) assert.deepEqual(result.value, JSON.parse(JSON.stringify(componentSchema.parse(item.input))), 'normalized ' + item.name); }
});
