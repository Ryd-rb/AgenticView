import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { MonitoringView } from '../web/MonitoringView.tsx';
import type { MonitoringSnapshot } from '../shared/monitoring.ts';

const sampledAt = Date.UTC(2026, 9, 28, 12, 30);
function sample(): MonitoringSnapshot {
  return { sampledAt, uptimeSeconds: 900, active: 3, stale: 1, completed: 95, errors: 1, liveAgents: 100, archived: 4, components: 100, viewerStreams: 1, liveBytes: 4096,
    acceptedBatches: 50, acceptedOperations: 500, acceptedPayloadBytes: 8192, duplicateBatches: 2, rejectedPublishes: 1,
    updatesPerSecond: 50, batchesPerSecond: 5, bytesPerSecond: 1024, publishP95Ms: 4, cpuPercent: 12, workingSetBytes: 10000000, managedHeapBytes: 4000000,
    history: Array.from({ length: 300 }, (_, i) => ({ time: sampledAt - (299 - i) * 1000, active: 3, stale: 1, updatesPerSecond: i, batchesPerSecond: i / 10, bytesPerSecond: i * 10, cpuPercent: 12 })),
    kinds: [{ kind: 'metric', components: 100, operations: 500, updatesPerSecond: 50 }],
    agents: Array.from({ length: 100 }, (_, i) => ({ id: 'agent-' + i, name: `Agent-${i}${i ? '' : '<script>literal()</script>'}`, status: 'active', lastSeen: sampledAt, components: 1, operations: 5, updatesPerSecond: 1 })),
    stages: [{ name: 'SQLite commit', totalMilliseconds: 20, meanMilliseconds: .4, share: 60 }]
  };
}

test('monitoring polls without overlap, pauses and aborts while hidden, recovers errors, pages agents and cleans up', async () => {
  const dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originals = { fetch: globalThis.fetch, set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  let hidden = false, timerId = 900000;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  const timers = new Map<number, () => void>(), requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 1000) { timers.set(++timerId, callback); return timerId; }
    return originals.set(callback, delay, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { if (!timers.delete(id)) originals.clear(id); }) as typeof clearTimeout;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/monitoring'); assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store');
    const signal = init!.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => { requests.push({ signal, resolve }); signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
  };
  const { createRoot } = await import('react-dom/client'), host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const respond = (index: number, status = 200) => requests[index]!.resolve(new Response(JSON.stringify(sample()), { status, headers: { 'Content-Type': 'application/json' } }));
  const pollTimer = () => { const [id, callback] = [...timers.entries()][0]!; timers.delete(id); callback(); };
  let unmounted = false;
  try {
    await act(() => root.render(createElement(MonitoringView)));
    assert.equal(requests.length, 1); assert.match(host.textContent!, /Waiting for the first server sample/);
    await act(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(requests.length, 1, 'visibility notifications do not overlap an in-flight poll');
    await act(async () => { respond(0); await settle(); });
    assert.equal(timers.size, 1); assert.match(host.textContent!, /Run states|Accepted traffic/); assert.match(host.textContent!, /canonical accepted JSON/);
    assert.equal(host.querySelector('script'), null); assert.match(host.textContent!, /Agent-0<script>literal\(\)<\/script>/);
    assert.match(host.textContent!, /not CPU samples/);
    const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const oldest = time(sampledAt - 299000); assert.ok(host.textContent!.includes(oldest));
    assert.equal([...host.querySelectorAll('.chart text')].some(node => /^\d{13}$/.test(node.textContent ?? '')), false, 'time axes do not expose raw epoch values');
    await act(() => { [...host.querySelectorAll<HTMLButtonElement>('[aria-label="History window"] button')].find(button => button.textContent === '1m')!.click(); });
    assert.equal(host.textContent!.includes(oldest), false, 'short window excludes older server history');
    const agents = [...host.querySelectorAll<HTMLElement>('.component')].find(section => section.querySelector('.component-title')?.textContent === 'Agents by update rate')!;
    assert.equal(agents.querySelectorAll('tbody tr').length, 25); assert.ok(agents.textContent!.includes('Agent-24')); assert.equal(agents.textContent!.includes('Agent-25'), false);
    await act(() => { [...agents.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Next')!.click(); });
    assert.ok(agents.textContent!.includes('Agent-25'));
    hidden = true; await act(() => document.dispatchEvent(new Event('visibilitychange'))); assert.equal(timers.size, 0); assert.match(host.textContent!, /Paused while hidden/);
    hidden = false; await act(() => document.dispatchEvent(new Event('visibilitychange'))); assert.equal(requests.length, 2);
    hidden = true; await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await settle(); });
    assert.equal(requests[1]!.signal.aborted, true); assert.equal(timers.size, 0); assert.equal(host.querySelector('[role="alert"]'), null, 'hidden abort is not a reported failure');
    hidden = false; await act(() => document.dispatchEvent(new Event('visibilitychange'))); assert.equal(requests.length, 3);
    await act(async () => { respond(2, 503); await settle(); }); assert.match(host.querySelector('[role="alert"]')!.textContent!, /503/); assert.equal(timers.size, 1);
    await act(() => pollTimer()); assert.equal(requests.length, 4); assert.equal(timers.size, 0);
    await act(async () => { respond(3); await settle(); }); assert.equal(host.querySelector('[role="alert"]'), null, 'successful recovery clears the error');
    await act(() => pollTimer()); assert.equal(requests.length, 5);
    await act(async () => { root.unmount(); unmounted = true; await settle(); });
    assert.equal(requests[4]!.signal.aborted, true); assert.equal(timers.size, 0);
    document.dispatchEvent(new Event('visibilitychange')); assert.equal(requests.length, 5, 'unmounted view never polls again');
  } finally { if (!unmounted) await act(() => root.unmount()); globalThis.fetch = originals.fetch; globalThis.setTimeout = originals.set; globalThis.clearTimeout = originals.clear; await dom.happyDOM.close(); }
});
