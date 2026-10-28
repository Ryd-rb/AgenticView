import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { App } from '../web/App.tsx';
import type { AgentView, Snapshot } from '../shared/protocol.ts';

// Actual App event/lifecycle contracts in memory; no browser or physical touch claims.
const dom = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true, enableJavaScriptEvaluation: false } });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMRect', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'MessageEvent'] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'getComputedStyle'] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom[key].bind(dom) });
Object.assign(globalThis, { innerWidth: 1200, innerHeight: 800, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
const { createRoot } = await import('react-dom/client');
const prototype = dom.HTMLElement.prototype;
for (const [key, value] of Object.entries({ clientWidth: 400, clientHeight: 300, offsetWidth: 400, offsetHeight: 300, scrollWidth: 800, scrollHeight: 1000 }))
  Object.defineProperty(prototype, key, { configurable: true, get: () => value });
prototype.getBoundingClientRect = () => new dom.DOMRect(0, 0, 400, 300);
const captures = new Map<number, HTMLElement>();
prototype.setPointerCapture = function(id) { captures.set(id, this as unknown as HTMLElement); };
prototype.hasPointerCapture = function(id) { return captures.get(id) === (this as unknown as HTMLElement); };
prototype.releasePointerCapture = function(id) { if (captures.get(id) === (this as unknown as HTMLElement)) captures.delete(id); };
class Stream extends dom.EventTarget {
  static current: Stream;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { super(); Stream.current = this; }
  close() {}
  snapshot(value: Snapshot) { this.dispatchEvent(new dom.MessageEvent('snapshot', { data: JSON.stringify(value) })); }
}
const leaseRequests: { active: boolean; leaseId: string }[] = []; let admission: Promise<void> | undefined;
Object.assign(globalThis, { EventSource: Stream, fetch: async (input: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (input.endsWith('/layout/interaction')) { leaseRequests.push(body); if (body.active && admission) await admission; }
  return new Response(JSON.stringify(input === '/api/session' ? { authenticated: true } : body), { status: 200, headers: { 'Content-Type': 'application/json' } });
} });
after(() => { dom.happyDOM.abort(); dom.happyDOM.close(); });
const agent: AgentView = { id: 'agent', agentId: 'synthetic', name: 'Synthetic agent', role: 'Testing', context: '', parentId: null,
  createdAt: 1, lastSeen: 1, status: 'active', sequence: 1,
  layout: { x: 0, y: 0, width: 480, height: 420, z: 1, locked: false, sizing: 'fixed' },
  components: { content: { id: 'content', title: 'Evidence', kind: 'markdown', data: { text: 'Scrollable evidence' } } } };
function snapshot(layout = agent.layout): Snapshot { return { revision: 1, agents: [{ ...agent, layout }],
  settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: false, reducedMotion: true },
  stats: { active: 1, stale: 0, archived: 0, updates: 1, updatesPerSecond: 1 } }; }
function pointer(hitTarget: Element, type: string, y: number) {
  // Physical hit target may change; capture owns delivery after pointerdown.
  const target = type === 'pointerdown' ? hitTarget : captures.get(11) ?? hitTarget;
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 11, button: 0, clientX: 100, clientY: y }));
}
async function mount() {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => { root.render(createElement(App)); await Promise.resolve(); });
  await act(() => { Stream.current.snapshot(snapshot()); });
  const target = host.querySelector<HTMLElement>('.markdown p')!; assert.ok(target);
  await act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  return { host, target, async close() { await act(() => root.unmount()); host.remove(); captures.clear(); } };
}

test('live layout telemetry cannot cancel an active local touch while Fit all is following', async () => {
  const view = await mount();
  try {
    await act(() => { document.querySelector<HTMLElement>('[aria-label="Fit all cards"]')!.click(); });
    await act(() => { pointer(view.target, 'pointerdown', 200); pointer(view.target, 'pointermove', 160); });
    assert.equal(captures.has(11), true, 'local content gesture started');
    await act(() => { Stream.current.snapshot(snapshot({ ...agent.layout, height: 421 })); });
    assert.equal(captures.has(11), true, 'telemetry must not release active local touch capture');
  } finally { await view.close(); }
});

test('interaction release waits for admission and never posts stale layout geometry', async () => {
  const view = await mount(); let release!: () => void;
  leaseRequests.length = 0; admission = new Promise<void>(resolve => { release = resolve; });
  try {
    await act(() => { pointer(view.target, 'pointerdown', 200); });
    assert.equal(leaseRequests.length, 1); assert.equal(leaseRequests[0]!.active, true);
    await act(() => { pointer(view.target, 'pointerup', 200); }); assert.equal(leaseRequests.length, 1, 'release waits for admitted request');
    await act(async () => { release(); await new Promise<void>(resolve => setImmediate(resolve)); });
    assert.deepEqual(leaseRequests.map(request => request.active), [true, false]);
    assert.equal(leaseRequests[0]!.leaseId, leaseRequests[1]!.leaseId);
    assert.deepEqual(Object.keys(leaseRequests[1]!).sort(), ['active', 'leaseId']);
  } finally { release(); admission = undefined; await view.close(); }
});

test('a new contact prevents an older queued release from dropping its lease', async () => {
  const view = await mount(); let release!: () => void;
  leaseRequests.length = 0; admission = new Promise<void>(resolve => { release = resolve; });
  try {
    await act(() => { pointer(view.target, 'pointerdown', 200); });
    await act(() => { pointer(view.target, 'pointerup', 200); });
    await act(() => { pointer(view.target, 'pointerdown', 200); });
    await act(async () => { release(); admission = undefined; await new Promise<void>(resolve => setImmediate(resolve)); });
    assert.ok(leaseRequests.length > 0); assert.ok(leaseRequests.every(request => request.active), 'stale release is skipped while new contact remains');
    await act(async () => { pointer(view.target, 'pointerup', 200); await new Promise<void>(resolve => setImmediate(resolve)); });
    assert.equal(leaseRequests.at(-1)!.active, false);
  } finally { release(); admission = undefined; await view.close(); }
});

test('remote layout movement cannot cull the originating card during active local touch', async () => {
  const view = await mount();
  try {
    const zoom = document.querySelector<HTMLElement>('[aria-label="Zoom in"]')!;
    await act(() => { zoom.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await act(() => { pointer(view.target, 'pointerdown', 200); pointer(view.target, 'pointermove', 160); });
    assert.equal(captures.has(11), true, 'local content gesture started');
    await act(() => { Stream.current.snapshot(snapshot({ ...agent.layout, x: 100000 })); });
    assert.equal(view.target.isConnected, true, 'active card must survive culling until contact ends');
    assert.equal(captures.has(11), true, 'remote layout must not release local touch capture');
  } finally { await view.close(); }
});

test('content-only telemetry preserves local capture and subsequent movement', async () => {
  const view = await mount();
  try {
    await act(() => { pointer(view.target, 'pointerdown', 200); pointer(view.target, 'pointermove', 160); });
    const scroller = view.host.querySelector<HTMLElement>('.card-content-scroll')!, before = scroller.scrollTop;
    const update = snapshot(); update.revision = 2; update.agents[0] = { ...update.agents[0]!, sequence: 2, context: 'Updated synthetic context' };
    await act(() => { Stream.current.snapshot(update); });
    assert.equal(captures.has(11), true, 'content telemetry retains local capture');
    await act(() => { pointer(view.target, 'pointermove', 120); });
    assert.ok(scroller.scrollTop > before, 'the same contact continues scrolling after content telemetry');
  } finally { await view.close(); }
});

test('repeated layout updates defer during capture and latest geometry reconciles after release', async () => {
  const view = await mount();
  try {
    const card = view.target.closest<HTMLElement>('[data-card-id]')!, left = card.style.left, height = card.style.height;
    await act(() => { pointer(view.target, 'pointerdown', 200); pointer(view.target, 'pointermove', 170); });
    const scroller = view.host.querySelector<HTMLElement>('.card-content-scroll')!;
    for (const [index, next] of [{ x: 100, height: 500 }, { x: 200, height: 550 }, { x: 300, height: 600 }].entries()) {
      const before = scroller.scrollTop;
      const update = snapshot({ ...agent.layout, ...next }); update.revision = index + 2;
      await act(() => { Stream.current.snapshot(update); });
      assert.equal(captures.has(11), true, `layout update ${index} preserves capture`);
      assert.equal(card.style.left, left, 'remote position waits until release');
      assert.equal(card.style.height, height, 'remote size waits until release');
      await act(() => { pointer(document.body, 'pointermove', 140 - index * 30); });
      assert.ok(scroller.scrollTop > before, `captured movement ${index} survives changed hit target and telemetry`);
    }
    await act(() => { pointer(document.body, 'pointerup', 80); });
    assert.equal(captures.has(11), false, 'release clears capture');
    const accepted = view.host.querySelector<HTMLElement>('[data-card-id="agent"]')!;
    assert.ok(accepted, 'latest geometry remains in view');
    assert.equal(accepted.style.left, '300px', 'latest pending position wins');
    assert.equal(accepted.style.height, '600px', 'latest pending size wins');
  } finally { await view.close(); }
});

test('explicit global navigation intentionally cancels captured local input', async () => {
  const view = await mount();
  try {
    await act(() => { pointer(view.target, 'pointerdown', 200); pointer(view.target, 'pointermove', 160); });
    const scroller = view.host.querySelector<HTMLElement>('.card-content-scroll')!, before = scroller.scrollTop;
    assert.equal(captures.has(11), true);
    const zoom = document.querySelector<HTMLElement>('[aria-label="Zoom in"]')!;
    await act(() => { zoom.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    assert.equal(captures.has(11), false, 'explicit navigation cancels local capture');
    await act(() => { pointer(view.target, 'pointermove', 120); pointer(view.target, 'pointerup', 120); });
    assert.equal(scroller.scrollTop, before, 'cancelled contact cannot resume local scrolling');
  } finally { await view.close(); }
});

test('selected-card zoom reaches 200 percent in the main view before content zoom starts', async () => {
  const view = await mount();
  try {
    const outer = view.host.querySelector<HTMLElement>('.world')!, inner = view.host.querySelector<HTMLElement>('.card-content-plane')!;
    const scale = (element: HTMLElement) => Number(/scale\(([^)]+)\)/.exec(element.style.transform)![1]);
    const zoom = (factor: number) => { const event = new MouseEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, clientX: 100, clientY: 100 }); for (const [key, value] of Object.entries({ deltaY: -Math.log(factor) / .0015, deltaX: 0, deltaMode: 0 })) Object.defineProperty(event, key, { value }); view.target.dispatchEvent(event); };
    assert.ok(scale(outer) < 2);
    await act(() => { zoom(2 / scale(outer)); });
    assert.ok(Math.abs(scale(outer) - 2) < 1e-8); assert.ok(Math.abs(scale(inner) - 1) < 1e-8);
    await act(() => { zoom(1.2); });
    assert.ok(Math.abs(scale(outer) - 2) < 1e-8); assert.ok(Math.abs(scale(inner) - 1.2) < 1e-8);
  } finally { await view.close(); }
});
