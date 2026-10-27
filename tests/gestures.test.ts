import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { CardSurface } from '../web/CardSurface.tsx';
import { ComponentView } from '../web/Components.tsx';
import { scrollAncestors, scrollThrough } from '../web/scrollChain.ts';

// In-memory event contracts. No browser, external document, or visual capture runs here.
const dom = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true, enableJavaScriptEvaluation: false } });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'WheelEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : key === 'getComputedStyle' ? dom.getComputedStyle.bind(dom) : dom[key] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
const { createRoot } = await import('react-dom/client');
const prototype = dom.HTMLElement.prototype;
for (const [key, value] of Object.entries({ clientWidth: 400, clientHeight: 300, offsetWidth: 400, scrollWidth: 800, scrollHeight: 1000 })) {
  Object.defineProperty(prototype, key, { configurable: true, get: () => value });
}
prototype.getBoundingClientRect = () => new dom.DOMRect(0, 0, 400, 300);
const captured = new Set<number>();
prototype.setPointerCapture = pointer => { captured.add(pointer); };
prototype.hasPointerCapture = pointer => captured.has(pointer);
prototype.releasePointerCapture = pointer => { captured.delete(pointer); };
after(() => { dom.happyDOM.abort(); dom.happyDOM.close(); });

async function mount(children: React.ReactNode, active = true) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const store = new Map<string, { x: number; y: number; zoom: number }>();
  const render = (enabled: boolean) => createElement(CardSurface, { id: 'test', active: enabled, deactivate() {}, canvasOwnsPointer: () => false, forceCanvas: () => false, store, children });
  await act(() => root.render(render(active)));
  return { host, store, viewport: host.querySelector<HTMLElement>('.card-content-scroll')!,
    async active(enabled: boolean) { await act(() => root.render(render(enabled))); },
    async close() { await act(() => root.unmount()); host.remove(); captured.clear(); } };
}
function wheel(target: Element, init: WheelEventInit) {
  // Happy DOM's WheelEvent derives from UIEvent; supply the real MouseEvent modifier contract.
  const event = new MouseEvent('wheel', { bubbles: true, cancelable: true, ...init });
  for (const key of ['deltaX', 'deltaY', 'deltaMode'] as const) Object.defineProperty(event, key, { value: init[key] ?? 0 });
  target.dispatchEvent(event); return event;
}
function pointer(target: Element, type: string, x: number, y: number, id = 1, pointerType = 'touch') {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType, button: 0 }); target.dispatchEvent(event); return event;
}
const grid = () => createElement('div', { className: 'grid', style: { overflowX: 'auto', overflowY: 'auto' } }, createElement('span', null, 'Grid evidence'));

test('wheel capture beats component interception and chains partial overflow into the card', async () => {
  const view = await mount(grid());
  try {
    const target = view.host.querySelector('.grid')!, region = target as HTMLElement;
    region.scrollTop = 680; // 700 maximum: consume 20, then hand 80 to the card.
    target.addEventListener('wheel', event => event.stopPropagation());
    await act(() => { assert.equal(wheel(target, { deltaY: 100 }).defaultPrevented, true); });
    assert.equal(region.scrollTop, 700); assert.equal(view.viewport.scrollTop, 80);
    await act(() => { wheel(target, { deltaY: 100 }); });
    assert.equal(view.viewport.scrollTop, 180);
    await act(() => { wheel(target, { deltaY: -1000 }); });
    assert.equal(region.scrollTop, 0); assert.equal(Math.abs(view.viewport.scrollTop), 0);
  } finally { await view.close(); }
});

test('captured pointer drag chains at grid edges, reverses, and stops at card boundaries', async () => {
  const view = await mount(grid());
  try {
    const region = view.host.querySelector<HTMLElement>('.grid')!; region.scrollTop = 680;
    region.addEventListener('pointermove', event => event.stopPropagation());
    await act(() => { pointer(region, 'pointerdown', 100, 200); pointer(region, 'pointermove', 100, 100); });
    assert.equal(region.scrollTop, 700); assert.equal(view.viewport.scrollTop, 80);
    await act(() => { pointer(region, 'pointermove', 100, 50); }); assert.equal(view.viewport.scrollTop, 130);
    await act(() => { pointer(region, 'pointermove', 100, 150); }); assert.equal(region.scrollTop, 600); assert.equal(view.viewport.scrollTop, 130);
    await act(() => { pointer(region, 'pointermove', 100, -5000); pointer(region, 'pointerup', 100, -5000); });
    assert.equal(view.viewport.scrollTop, 700); assert.equal(captured.size, 0);
  } finally { await view.close(); }
});

test('zoom beats nested scroll handlers and wheel movement respects local zoom and delta mode', async () => {
  const view = await mount(grid());
  try {
    const region = view.host.querySelector<HTMLElement>('.grid')!;
    region.addEventListener('wheel', event => event.stopPropagation());
    await act(() => { wheel(region, { ctrlKey: true, deltaY: -Math.log(2) / .0015, clientX: 0, clientY: 0 }); });
    assert.equal(view.store.get('test')!.zoom, 2);
    region.scrollTop = 700;
    await act(() => { wheel(region, { deltaY: 2, deltaMode: 1 }); }); assert.equal(view.viewport.scrollTop, 32);
    region.scrollLeft = 400;
    await act(() => { wheel(region, { deltaY: 3, shiftKey: true, deltaMode: 1 }); }); assert.equal(view.viewport.scrollLeft, 48);
  } finally { await view.close(); }
});

test('pinch starts on controls without breaking stationary clicks, and navigation cancels capture', async () => {
  let clicks = 0;
  const view = await mount(createElement('button', { onClick: () => clicks++ }, 'Control'));
  try {
    const control = view.host.querySelector('.card-content-plane button')!;
    await act(() => { pointer(control, 'pointerdown', 50, 50); pointer(control, 'pointerup', 50, 50); control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    assert.equal(clicks, 1);
    await act(() => { pointer(control, 'pointerdown', 50, 50, 1); pointer(control, 'pointerdown', 150, 50, 2); pointer(control, 'pointermove', 250, 50, 2); });
    assert.equal(view.store.get('test')!.zoom, 2);
    await act(() => { control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); window.dispatchEvent(new Event('agenticview:canvas-navigation')); });
    assert.equal(clicks, 1); assert.equal(captured.size, 0);
    const prior = { ...view.store.get('test')! };
    await act(() => { pointer(control, 'pointermove', 350, 50, 2); }); assert.deepEqual(view.store.get('test'), prior);
  } finally { await view.close(); }
});

test('embed requires explicit interaction and resets when the card or canvas takes navigation', async () => {
  const view = await mount(createElement(ComponentView, { component: { id: 'embed', title: 'View', kind: 'embed', data: { html: '<p>Synthetic view</p>', height: 200 } }, embeds: true, runId: 'synthetic' }));
  try {
    const frame = view.host.querySelector('iframe')!, button = view.host.querySelector<HTMLElement>('.embed-interact')!;
    assert.equal(frame.tabIndex, -1); assert.equal(frame.style.pointerEvents, 'none'); assert.equal(frame.hasAttribute('inert'), true);
    assert.doesNotMatch(frame.getAttribute('sandbox')!, /allow-same-origin/);
    assert.ok(view.host.querySelector('.embed-navigation-shield'));
    await act(() => { button.click(); }); assert.equal(frame.tabIndex, 0); assert.equal(frame.style.pointerEvents, 'auto');
    await act(() => { window.dispatchEvent(new Event('agenticview:canvas-navigation')); }); assert.equal(frame.tabIndex, -1);
    await act(() => { button.click(); }); await view.active(false); await view.active(true);
    assert.equal(frame.style.pointerEvents, 'none'); assert.equal(frame.tabIndex, -1);
  } finally { await view.close(); }
});

test('card toolbar contacts participate in pinch while a single tap still controls zoom', async () => {
  const view = await mount(createElement('p', null, 'Content'));
  try {
    const plus = view.host.querySelector<HTMLElement>('[aria-label="Zoom card in"]')!;
    await act(() => { plus.click(); }); assert.equal(view.store.get('test')!.zoom, 1.2);
    await act(() => { pointer(plus, 'pointerdown', 50, -20, 1); pointer(plus, 'pointerdown', 150, -20, 2); pointer(plus, 'pointermove', 250, -20, 2); });
    assert.equal(view.store.get('test')!.zoom, 2.4);
    await act(() => { pointer(plus, 'pointerup', 250, -20, 2); pointer(plus, 'pointerup', 50, -20, 1); }); assert.equal(captured.size, 0);
  } finally { await view.close(); }
});

test('multiple scroll ancestors consume independently on each axis before returning residual movement', () => {
  const outer = document.createElement('div'), inner = document.createElement('div'), target = document.createElement('span'), boundary = document.createElement('div');
  outer.style.overflowY = 'auto'; outer.style.overflowX = 'auto'; inner.style.overflowY = 'auto'; inner.style.overflowX = 'auto';
  document.body.append(boundary); boundary.append(outer); outer.append(inner); inner.append(target); inner.scrollTop = 690; outer.scrollTop = 680;
  const regions = scrollAncestors(target, boundary); assert.equal(regions.length, 2); assert.equal(regions[0], inner); assert.equal(regions[1], outer);
  assert.deepEqual(scrollThrough([inner, outer], 900, 100), { x: 100, y: 70 });
  assert.equal(inner.scrollTop, 700); assert.equal(outer.scrollTop, 700);
  inner.style.overflowX = 'hidden'; inner.scrollLeft = 50;
  assert.deepEqual(scrollThrough([inner], 30, 0), { x: 30, y: 0 }); assert.equal(inner.scrollLeft, 50);
  assert.deepEqual(scrollAncestors(target, document.createElement('div')), []);
  boundary.remove();
});
