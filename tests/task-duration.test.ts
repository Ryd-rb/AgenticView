import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import {RenderBoundary} from '../web/RenderActivity.tsx';
import { TaskDuration } from '../web/TaskDuration.tsx';

test('running durations share one clock, pause while hidden, stop when completed and release on unmount', async () => {
  const dom = new Window();
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let now = 100_000, id = 0, hidden = false; const timers = new Map<number, () => void>();
  const original = { now: Date.now, set: globalThis.setInterval, clear: globalThis.clearInterval };
  Date.now = () => now;
  globalThis.setInterval = ((callback: () => void) => { timers.set(++id, callback); return id; }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: number) => { timers.delete(timer); }) as unknown as typeof clearInterval;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  const { createRoot } = await import('react-dom/client'), host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const timing = { key: 'task', line: 1, firstSeenAt: 98_766, startedAt: 98_766, updatedAt: 98_766 };
  try {
    await act(() => root.render(createElement('div', {}, createElement(TaskDuration, { timing }), createElement(TaskDuration, { timing: { ...timing, key: 'other' } }))));
    assert.equal(timers.size, 1); assert.match(host.textContent!, /1.234s/);
    now += 1000; await act(() => { for (const callback of [...timers.values()]) callback(); }); assert.match(host.textContent!, /2.234s/);
    hidden = true; await act(() => document.dispatchEvent(new Event('visibilitychange'))); assert.equal(timers.size, 0);
    now += 120_000; hidden = false; await act(() => document.dispatchEvent(new Event('visibilitychange'))); assert.equal(timers.size, 1); assert.match(host.textContent!, /2m 02s/);
    await act(() => root.render(createElement(TaskDuration, { timing: { ...timing, completedAt: 100_000 } }))); assert.equal(timers.size, 0); assert.match(host.textContent!, /1.234s/);
    now += 60_000; assert.match(host.textContent!, /1.234s/, 'completion remains frozen');
    await act(() => root.render(createElement(TaskDuration, { timing }))); assert.equal(timers.size, 1);
    const body=()=>createElement(TaskDuration,{timing});
    await act(()=>root.render(createElement(RenderBoundary,{visible:true,updates:false,children:body})));assert.equal(timers.size,0,'retained card clock must stop when source updates are paused');
    const retained=host.textContent;now+=60000;for(const callback of timers.values())callback();assert.equal(host.textContent,retained);
    await act(()=>root.render(createElement(RenderBoundary,{visible:true,updates:true,children:body})));assert.equal(timers.size,1);assert.notEqual(host.textContent,retained,'visible clock consumes current time when updates resume');

  } finally { await act(() => root.unmount()); assert.equal(timers.size, 0); Date.now = original.now; globalThis.setInterval = original.set; globalThis.clearInterval = original.clear; await dom.happyDOM.close(); }
});
