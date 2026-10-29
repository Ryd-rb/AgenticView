import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { ArchiveBrowser } from '../web/ArchiveBrowser.tsx';
import type { AgentView, ArchiveSummary } from '../shared/protocol.ts';

const summary = (i: number): ArchiveSummary => ({ id: `saved-${i}`, agentId: `agent-${i}`, name: `Saved ${i}<script>literal</script>`, role: 'Synthetic worker', parentId: null, status: 'completed', archivedAt: 1000 + i, completedAt: 900 + i, bytes: 256, rawBytes: 1024 });
const agent = (id: string): AgentView => ({ ...summary(0), id, context: '', createdAt: 1, lastSeen: 2, sequence: 1, components: {}, layout: { x: 0, y: 0, width: 480, height: 420, locked: false, z: 1 } });

test('archive browser bounds pages, reviews finished work and restores explicitly without polling', async () => {
  const dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  const requests: { path: string; method: string; signal?: AbortSignal; resolve: (value: unknown) => void }[] = [], notices: string[] = [];
  const request = <T,>(path: string, method = 'GET', _body?: unknown, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    requests.push({ path, method, signal, resolve: value => resolve(value as T) });
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const { createRoot } = await import('react-dom/client'), host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const render = (count = 61) => createElement(ArchiveBrowser, { count, request, report: (value: string) => notices.push(value), renderContent: (value: AgentView) => createElement('p', {}, `Evidence from ${value.id}`) });
  const click = async (selector: string) => { await act(() => host.querySelector<HTMLButtonElement>(selector)!.click()); };
  try {
    await act(() => root.render(render()));
    assert.equal(requests[0]!.path, '/api/archives?offset=0&limit=25');
    await act(async () => { requests[0]!.resolve(Array.from({ length: 25 }, (_, i) => summary(i))); await settle(); });
    assert.equal(host.querySelectorAll('.archive-row').length, 25); assert.match(host.textContent!, /Finished/); assert.equal(host.querySelector('script'), null);
    await act(() => { [...host.querySelectorAll<HTMLButtonElement>('.pagination button')].find(button => button.textContent === 'Next')!.click(); });
    assert.equal(requests[1]!.path, '/api/archives?offset=25&limit=25');
    await act(async () => { requests[1]!.resolve([summary(25)]); await settle(); });
    await click('[aria-label="Review Saved 25<script>literal</script>"]');
    assert.equal(requests[2]!.path, '/api/archives/saved-25');
    await act(async () => { requests[2]!.resolve(agent('saved-25')); await settle(); });
    assert.match(host.textContent!, /Evidence from saved-25/);
    await act(() => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Restore card'))!.click(); });
    assert.equal(requests[3]!.method, 'POST'); assert.equal(requests[3]!.path, '/api/archives/saved-25/restore');
    assert.equal(requests.length, 4, 'restore is never sent automatically');
    await act(async () => { requests[3]!.resolve({}); await settle(); });
    assert.equal(notices.length, 1); assert.equal(requests[4]!.path, '/api/archives?offset=25&limit=25');
    hidden = true; await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await settle(); });
    assert.equal(requests[4]!.signal!.aborted, true); assert.match(host.textContent!, /Paused while hidden/);
    await act(() => root.render(render(62))); assert.equal(requests.length, 5, 'hidden count changes do not fetch');
    hidden = false; await act(() => document.dispatchEvent(new Event('visibilitychange'))); assert.equal(requests.length, 6);
    await act(() => root.unmount()); assert.equal(requests[5]!.signal!.aborted, true);
    document.dispatchEvent(new Event('visibilitychange')); assert.equal(requests.length, 6, 'unmounted archive views remain idle');
  } finally { await act(() => root.unmount()); await dom.happyDOM.close(); }
});
