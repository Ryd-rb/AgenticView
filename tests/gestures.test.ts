import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { CardSurface } from '../web/CardSurface.tsx';
import { ComponentView } from '../web/Components.tsx';
import { scrollAncestors, scrollThrough } from '../web/scrollChain.ts';
import { zoomTowardScale } from '../shared/interaction.ts';
import { zoomAt, type Camera } from '../shared/viewport.ts';

// In-memory event contracts. No browser, external document, or visual capture runs here.
const dom = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true, enableJavaScriptEvaluation: false } });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMRect', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'WheelEvent', 'getComputedStyle'] as const) {
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
const captureOwners = new Map<number, EventTarget>();
prototype.setPointerCapture = function (pointer) { captured.add(pointer); captureOwners.set(pointer, this as unknown as EventTarget); };
prototype.hasPointerCapture = function (pointer) { return captureOwners.get(pointer) === this as unknown as EventTarget; };
prototype.releasePointerCapture = function (pointer) { if (captureOwners.get(pointer) === this as unknown as EventTarget) { captured.delete(pointer); captureOwners.delete(pointer); } };
after(() => { dom.happyDOM.abort(); dom.happyDOM.close(); });

async function mount(children: React.ReactNode, active = true, panPastEdge?: (x: number, y: number) => void, zoomRouting: Pick<React.ComponentProps<typeof CardSurface>, 'zoomBeforeCard' | 'zoomPastCard' | 'canvasCamera' | 'getCanvasCamera' | 'getCanvasBounds'> = {}) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const store = new Map<string, { x: number; y: number; zoom: number }>();
  const render = (enabled: boolean) => createElement(CardSurface, { id: 'test', active: enabled, deactivate() {}, canvasOwnsPointer: () => false, forceCanvas: () => false, panPastEdge, ...zoomRouting, store, children });
  await act(() => root.render(render(active)));
  return { host, store, viewport: host.querySelector<HTMLElement>('.card-content-scroll')!,
    async active(enabled: boolean) { await act(() => root.render(render(enabled))); },
    async close() { await act(() => root.unmount()); host.remove(); captured.clear(); captureOwners.clear(); } };
}
function wheel(target: Element, init: WheelEventInit) {
  // Happy DOM's WheelEvent derives from UIEvent; supply the real MouseEvent modifier contract.
  const event = new MouseEvent('wheel', { bubbles: true, cancelable: true, ...init });
  for (const key of ['deltaX', 'deltaY', 'deltaMode'] as const) Object.defineProperty(event, key, { value: init[key] ?? 0 });
  target.dispatchEvent(event); return event;
}
function pointer(target: Element, type: string, x: number, y: number, id = 1, pointerType = 'touch') {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType, button: 0 }); (type === 'pointerdown' ? target : captureOwners.get(id) ?? target).dispatchEvent(event); return event;
}
const grid = () => createElement('div', { className: 'grid', style: { overflowX: 'auto', overflowY: 'auto' } }, createElement('span', null, 'Grid evidence'));

test('a captured drag follows the current hit region from parent into child and back without losing movement', async () => {
  const view = await mount(createElement('div', { className: 'parent-scroll', style: { overflowY: 'auto' } }, grid()));
  const originalHitTest = document.elementFromPoint; let hit: Element;
  try {
    const parent = view.host.querySelector<HTMLElement>('.parent-scroll')!, child = view.host.querySelector<HTMLElement>('.grid')!;
    hit = parent; document.elementFromPoint = () => hit;
    await act(() => { pointer(parent, 'pointerdown', 100, 200); pointer(parent, 'pointermove', 100, 180); });
    assert.equal(parent.scrollTop, 20); assert.equal(child.scrollTop, 0);
    hit = child;
    await act(() => { pointer(child, 'pointermove', 100, 160); pointer(child, 'pointermove', 100, 140); });
    assert.equal(child.scrollTop, 40); assert.equal(parent.scrollTop, 20); assert.equal(captured.has(1), true);
    hit = parent;
    await act(() => { pointer(parent, 'pointermove', 100, 120); }); assert.equal(parent.scrollTop, 40); assert.equal(child.scrollTop, 40);
    await act(() => { pointer(parent, 'pointerup', 100, 120); }); assert.equal(captured.size, 0);
  } finally { document.elementFromPoint = originalHitTest; await view.close(); }
});

test('320 captured moves across nested scroll targets conserve both axes without interruption', async () => {
  const view = await mount(createElement('div', { className: 'parent-scroll', style: { overflowX: 'auto', overflowY: 'auto' } }, grid()));
  const originalHitTest = document.elementFromPoint; let hit: Element;
  try {
    const parent = view.host.querySelector<HTMLElement>('.parent-scroll')!, child = view.host.querySelector<HTMLElement>('.grid')!;
    parent.scrollLeft = parent.scrollTop = child.scrollLeft = child.scrollTop = 200;
    hit = parent; document.elementFromPoint = () => hit;
    let x = 200, y = 200;
    await act(() => { pointer(parent, 'pointerdown', x, y); pointer(parent, 'pointermove', x - 5, y - 5); }); x -= 5; y -= 5;
    await act(() => {
      for (let step = 0; step < 320; step++) {
        hit = Math.floor(step / 10) % 2 ? parent : child;
        const dx = Math.floor(step / 40) % 2 ? 1 : -1, dy = Math.floor(step / 20) % 2 ? -1 : 1;
        const left = parent.scrollLeft + child.scrollLeft, top = parent.scrollTop + child.scrollTop;
        x += dx; y += dy; pointer(hit, 'pointermove', x, y);
        assert.equal(parent.scrollLeft + child.scrollLeft - left, -dx, `horizontal movement at step ${step}`);
        assert.equal(parent.scrollTop + child.scrollTop - top, -dy, `vertical movement at step ${step}`);
        assert.equal(captured.has(1), true, `capture at step ${step}`);
      }
    });
    await act(() => { pointer(hit!, 'pointerup', x, y); }); assert.equal(captured.size, 0);
  } finally { document.elementFromPoint = originalHitTest; await view.close(); }
});

test('unexpected capture loss recovers an active contact but never resurrects a cancelled one', async () => {
  const view = await mount(grid());
  try {
    const target = view.host.querySelector('.grid')!;
    await act(() => { pointer(target, 'pointerdown', 100, 200); pointer(target, 'pointermove', 100, 160); });
    const owner = captureOwners.get(1)!; assert.ok(owner);
    await act(() => { captureOwners.delete(1); owner.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1, pointerType: 'touch' })); });
    assert.equal(captureOwners.get(1), owner);
    const before = (target as HTMLElement).scrollTop;
    await act(() => { pointer(target, 'pointermove', 100, 120); }); assert.ok((target as HTMLElement).scrollTop > before);
    await act(() => { window.dispatchEvent(new Event('agenticview:canvas-navigation')); owner.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1, pointerType: 'touch' })); });
    assert.equal(captureOwners.has(1), false); assert.equal(captured.size, 0);
  } finally { await view.close(); }
});

test('disabled Markdown task checks remain draggable scroll content', async () => {
  const view = await mount(createElement('div', { className: 'markdown' }, createElement('input', { type: 'checkbox', disabled: true, checked: true, readOnly: true })));
  try {
    const check = view.host.querySelector('input')!;
    await act(() => { pointer(check, 'pointerdown', 100, 200); pointer(check, 'pointermove', 100, 160); });
    assert.equal(view.viewport.scrollTop, 40); assert.equal(captured.has(1), true);
    await act(() => { pointer(check, 'pointerup', 100, 160); }); assert.equal(captured.size, 0);
  } finally { await view.close(); }
});

function closeTo(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }
async function anchoredFixture(start: Camera = { x: 37, y: -61, zoom: .25 }) {
  const origin = { x: 1000, y: 300 }; let world = { ...start }, committed = { ...start };
  const announce = () => window.dispatchEvent(new CustomEvent('agenticview:canvas-navigation', { detail: { card: 'test' } }));
  const routing = { canvasCamera: committed, getCanvasCamera: () => world,
    zoomBeforeCard(factor: number, anchor: { x: number; y: number }) { const result = zoomTowardScale(world, 1, factor, anchor); world = result.camera; announce(); return result.remaining; },
    zoomPastCard(factor: number, anchor: { x: number; y: number }) { world = zoomAt(world, factor, anchor); announce(); } };
  const view = await mount(grid(), true, (x, y) => { world = { ...world, x: world.x - x, y: world.y - y }; announce(); }, routing);
  // This rectangle stays at its last committed camera until explicitly committed.
  view.viewport.getBoundingClientRect = () => new DOMRect(committed.x + committed.zoom * origin.x, committed.y + committed.zoom * origin.y, 400 * committed.zoom, 300 * committed.zoom);
  const contentAt = (screen: { x: number; y: number }) => {
    const inner = view.store.get('test') ?? { x: 0, y: 0, zoom: 1 };
    return { x: ((screen.x - world.x) / world.zoom - origin.x - inner.x) / inner.zoom, y: ((screen.y - world.y) / world.zoom - origin.y - inner.y) / inner.zoom };
  };
  return { ...view, target: view.host.querySelector('.grid')!, contentAt, world: () => world,
    async commitWorld() { committed = { ...world }; routing.canvasCamera = committed; await view.active(true); } };
}

test('batched wheel handoffs preserve an off-center content anchor through scale changes and clamping', async () => {
  const view = await anchoredFixture();
  try {
    const anchor = { x: 357, y: 44 }, original = view.contentAt(anchor); let scale = view.world().zoom;
    await act(() => {
      for (const factor of [2, 3, 1.25, .7, .1, .5, 4, 1.8, .2]) {
        wheel(view.target, { ctrlKey: true, deltaY: -Math.log(factor) / .0015, clientX: anchor.x, clientY: anchor.y }); scale *= factor;
        const content = view.contentAt(anchor), inner = view.store.get('test')!;
        closeTo(content.x, original.x); closeTo(content.y, original.y); closeTo(view.world().zoom * inner.zoom, scale);
        assert.ok(inner.x <= 0 && inner.y <= 0);
      }
    });
    closeTo(view.contentAt(anchor).x, original.x); closeTo(view.contentAt(anchor).y, original.y);
    await view.commitWorld();
    await act(() => { wheel(view.target, { ctrlKey: true, deltaY: -Math.log(3) / .0015, clientX: anchor.x, clientY: anchor.y }); });
    closeTo(view.contentAt(anchor).x, original.x); closeTo(view.contentAt(anchor).y, original.y);
  } finally { await view.close(); }
});

test('continuous moving pinch preserves the content under its midpoint across both handoff directions', async () => {
  const view = await anchoredFixture();
  try {
    const positions = [{ x: 307, y: 34 }, { x: 347, y: 34 }], original = view.contentAt({ x: 327, y: 34 });
    await act(() => { pointer(view.target, 'pointerdown', 307, 34, 1); pointer(view.target, 'pointerdown', 347, 34, 2); });
    for (const [id, x, y] of [[2, 387, 54], [2, 467, 14], [1, 297, 24], [2, 337, 34], [1, 317, 34], [2, 347, 44]]) {
      positions[id! - 1] = { x: x!, y: y! };
      await act(() => { pointer(view.target, 'pointermove', x!, y!, id!); });
      const center = { x: (positions[0]!.x + positions[1]!.x) / 2, y: (positions[0]!.y + positions[1]!.y) / 2 };
      closeTo(view.contentAt(center).x, original.x); closeTo(view.contentAt(center).y, original.y);
    }
    await act(() => { pointer(view.target, 'pointerup', 317, 34, 1); pointer(view.target, 'pointerup', 347, 44, 2); }); assert.equal(captured.size, 0);
  } finally { await view.close(); }
});

test('native scroll rounding is compensated once after zoom commit without scroll-event feedback', async () => {
  const view = await anchoredFixture({ x: 37, y: -61, zoom: 1 });
  try {
    let left = 0, top = 0;
    Object.defineProperty(view.viewport, 'scrollLeft', { configurable: true, get: () => left, set: value => { left = Math.floor(value); } });
    Object.defineProperty(view.viewport, 'scrollTop', { configurable: true, get: () => top, set: value => { top = Math.floor(value); } });
    const anchor = { x: 1162.25, y: 326.7 }, original = view.contentAt(anchor);
    await act(() => { wheel(view.target, { ctrlKey: true, deltaY: -Math.log(1.3) / .0015, clientX: anchor.x, clientY: anchor.y }); });
    closeTo(view.contentAt(anchor).x, original.x); closeTo(view.contentAt(anchor).y, original.y);
    const world = { ...view.world() }, inner = { ...view.store.get('test')! };
    await act(() => { for (let i = 0; i < 100; i++) view.viewport.dispatchEvent(new Event('scroll', { bubbles: true })); });
    assert.deepEqual(view.world(), world); assert.deepEqual(view.store.get('test'), inner);
  } finally { await view.close(); }
});

test('reversing a nested drag restores parent visibility before scrolling its child on either axis', async () => {
  const world = { x: 0, y: 0 };
  const view = await mount(createElement('div', { className: 'outer-scroll', style: { overflowX: 'auto', overflowY: 'auto' } }, grid()), true,
    (x, y) => { world.x -= x; world.y -= y; window.dispatchEvent(new CustomEvent('agenticview:canvas-navigation', { detail: { card: 'test' } })); },
    { getCanvasBounds: () => ({ left: 0, top: 0, width: 400, height: 300 }) });
  const originalHit=document.elementFromPoint;
  try {
    const outer = view.host.querySelector<HTMLElement>('.outer-scroll')!, child = view.host.querySelector<HTMLElement>('.grid')!;
    document.elementFromPoint=()=>child; // This contract deliberately holds one physical route; outside routing has a separate case.
    for (const [node, dimensions] of [[outer, { clientWidth: 240, offsetWidth: 240, clientHeight: 200, scrollWidth: 640, scrollHeight: 800 }], [child, { clientWidth: 160, offsetWidth: 160, clientHeight: 120, scrollWidth: 560, scrollHeight: 620 }]] as const) {
      for (const [key, value] of Object.entries(dimensions)) Object.defineProperty(node, key, { configurable: true, get: () => value });
    }
    view.viewport.getBoundingClientRect = () => new DOMRect(world.x, world.y, 400, 300);
    outer.getBoundingClientRect = () => new DOMRect(world.x + 100 - view.viewport.scrollLeft, world.y + 120 - view.viewport.scrollTop, 240, 200);
    child.getBoundingClientRect = () => { const bounds = outer.getBoundingClientRect(); return new DOMRect(bounds.left + 40 - outer.scrollLeft, bounds.top + 60 - outer.scrollTop, 160, 120); };
    await act(() => { view.viewport.scrollLeft = 100; view.viewport.scrollTop = 100; view.viewport.dispatchEvent(new Event('scroll', { bubbles: true })); });
    outer.scrollLeft = 40; outer.scrollTop = 60;
    await act(() => { pointer(child, 'pointerdown', 80, 80); pointer(child, 'pointermove', 480, 480); });
    assert.deepEqual(world, { x: 260, y: 240 }); assert.equal(child.scrollTop, 0); assert.equal(child.scrollLeft, 0);
    await act(() => { pointer(child, 'pointermove', 380, 380); });
    assert.deepEqual(world, { x: 160, y: 140 }); assert.equal(child.scrollTop, 0); assert.equal(outer.scrollTop, 0);
    await act(() => { pointer(child, 'pointermove', 80, 80); });
    assert.deepEqual(world, { x: 0, y: 0 }); assert.equal(view.viewport.scrollTop, 20);
    assert.equal(child.scrollTop, 140); assert.equal(child.scrollLeft, 140);
    const parent = outer.getBoundingClientRect(), bounds = child.getBoundingClientRect();
    assert.ok(bounds.left >= parent.left && bounds.right <= parent.right && bounds.top >= parent.top && bounds.bottom <= parent.bottom);
    await act(() => { pointer(child, 'pointerup', 80, 80); });
  } finally { document.elementFromPoint=originalHit; await view.close(); }
});

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

test('card scroll residuals pan the world continuously without losing the originating drag', async () => {
  const world = { x: 0, y: 0 }, residuals: number[] = [];
  const view = await mount(grid(), true, (x, y) => { world.x -= x; world.y -= y; residuals.push(y); window.dispatchEvent(new CustomEvent('agenticview:canvas-navigation', { detail: { card: 'test' } })); });
  try {
    view.viewport.getBoundingClientRect = () => new DOMRect(world.x, world.y, 400, 300);
    const region = view.host.querySelector<HTMLElement>('.grid')!; region.scrollTop = 700;
    await act(() => { wheel(region, { deltaY: 680 }); }); assert.equal(view.viewport.scrollTop, 680); assert.equal(world.y, 0);
    await act(() => { wheel(region, { deltaY: 100 }); }); assert.equal(view.viewport.scrollTop, 700); assert.equal(world.y, -80);
    await act(() => { pointer(region, 'pointerdown', 100, 200); pointer(region, 'pointermove', 100, 100); pointer(region, 'pointermove', 100, 50); });
    assert.deepEqual(residuals, [80, 100, 50]); assert.equal(world.y, -230); assert.equal(view.viewport.scrollTop, 700);
    await act(() => { pointer(region, 'pointerup', 100, 50); }); assert.equal(captured.size, 0);
  } finally { await view.close(); }
});

test('world handoff converts residuals back to screen pixels at overview scale on both axes', async () => {
  const residuals: { x: number; y: number }[] = [];
  const view = await mount(grid(), true, (x, y) => { residuals.push({ x, y }); });
  try {
    view.viewport.getBoundingClientRect = () => new DOMRect(0, 0, 200, 150);
    const region = view.host.querySelector<HTMLElement>('.grid')!; region.scrollLeft = 400; region.scrollTop = 700;
    await act(() => { wheel(region, { deltaX: 250, deltaY: 400 }); });
    assert.equal(view.viewport.scrollLeft, 400); assert.equal(view.viewport.scrollTop, 700);
    assert.deepEqual(residuals, [{ x: 50, y: 50 }]);
    await act(() => { wheel(region, { deltaY: 25 }); }); assert.deepEqual(residuals[1], { x: 0, y: 25 });
  } finally { await view.close(); }
});

test('wheel zoom raises world scale first and returns to it after local zoom-out reaches fit', async () => {
  let world = { x: 0, y: 0, zoom: .1 };
  const view = await mount(grid(), true, undefined, {
    zoomBeforeCard(factor, anchor) { const result = zoomTowardScale(world, 1, factor, anchor); world = result.camera; return result.remaining; },
    zoomPastCard(factor) { world = { ...world, zoom: world.zoom * factor }; }
  });
  try {
    const target = view.host.querySelector('.grid')!;
    await act(() => { wheel(target, { ctrlKey: true, deltaY: -Math.log(4) / .0015 }); });
    assert.equal(world.zoom, .4); assert.equal(view.store.get('test')?.zoom ?? 1, 1);
    await act(() => { wheel(target, { ctrlKey: true, deltaY: -Math.log(4) / .0015 }); });
    assert.equal(world.zoom, 1); assert.equal(view.store.get('test')!.zoom, 1.6);
    await act(() => { wheel(target, { ctrlKey: true, deltaY: -Math.log(.1) / .0015 }); });
    assert.equal(view.store.get('test')!.zoom, .5); assert.ok(Math.abs(world.zoom - .32) < 1e-10);
  } finally { await view.close(); }
});

test('one continuous pinch crosses overview, local zoom and local fit without resetting', async () => {
  let world = { x: 0, y: 0, zoom: .25 };
  const view = await mount(grid(), true, undefined, {
    zoomBeforeCard(factor, anchor) { const result = zoomTowardScale(world, 1, factor, anchor); world = result.camera; window.dispatchEvent(new CustomEvent('agenticview:canvas-navigation', { detail: { card: 'test' } })); return result.remaining; },
    zoomPastCard(factor) { world = { ...world, zoom: world.zoom * factor }; }
  });
  try {
    view.viewport.getBoundingClientRect = () => new DOMRect(0, 0, 400 * world.zoom, 300 * world.zoom);
    const target = view.host.querySelector('.grid')!;
    await act(() => { pointer(target, 'pointerdown', 10, 30, 1); pointer(target, 'pointerdown', 50, 30, 2); pointer(target, 'pointermove', 90, 30, 2); });
    assert.equal(world.zoom, .5); assert.equal(view.store.get('test')?.zoom ?? 1, 1);
    await act(() => { pointer(target, 'pointermove', 170, 30, 2); }); assert.equal(world.zoom, 1);
    await act(() => { pointer(target, 'pointermove', 330, 30, 2); }); assert.equal(view.store.get('test')!.zoom, 2);
    await act(() => { pointer(target, 'pointermove', 90, 30, 2); }); assert.equal(view.store.get('test')!.zoom, .5); assert.equal(world.zoom, 1);
    await act(() => { pointer(target, 'pointermove', 50, 30, 2); }); assert.equal(world.zoom, .5);
    await act(() => { pointer(target, 'pointerup', 50, 30, 2); pointer(target, 'pointerup', 10, 30, 1); }); assert.equal(captured.size, 0);
  } finally { await view.close(); }
});

test('a moved editable contact is rebased from its live position when a pinch begins', async () => {
  const view = await mount(createElement('input', { defaultValue: 'Synthetic control' }));
  try {
    const input = view.host.querySelector('input')!;
    await act(() => { pointer(input, 'pointerdown', 50, 50, 1); pointer(input, 'pointermove', 100, 50, 1); pointer(input, 'pointerdown', 200, 50, 2); pointer(input, 'pointermove', 100, 50, 1); });
    assert.equal(view.store.get('test')?.zoom ?? 1, 1);
    await act(() => { pointer(input, 'pointermove', 300, 50, 2); }); assert.equal(view.store.get('test')!.zoom, 2);
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


test('captured table panning continues on the canvas after the physical contact leaves the card',async()=>{
 const world={x:0,y:0},view=await mount(grid(),true,(x,y)=>{world.x-=x;world.y-=y;window.dispatchEvent(new CustomEvent('agenticview:canvas-navigation',{detail:{card:'test'}}));});
 const previous=document.elementFromPoint;const table=view.host.querySelector<HTMLElement>('.grid')!;let hit:Element=table;document.elementFromPoint=()=>hit;
 try{
  table.scrollLeft=400;table.scrollTop=700;view.viewport.scrollLeft=400;view.viewport.scrollTop=700;
  await act(()=>view.viewport.dispatchEvent(new Event('scroll',{bubbles:true})));
  await act(()=>{pointer(table,'pointerdown',100,100);pointer(table,'pointermove',90,90);});assert.deepEqual(world,{x:-10,y:-10});
  hit=document.body;
  await act(()=>pointer(table,'pointermove',100,100));assert.deepEqual(world,{x:0,y:0});assert.equal(table.scrollTop,700);assert.equal(table.scrollLeft,400);assert.equal(view.viewport.scrollTop,700);assert.equal(captured.has(1),true);
  await act(()=>pointer(table,'pointermove',110,110));assert.deepEqual(world,{x:10,y:10});assert.equal(table.scrollTop,700);
  hit=table;await act(()=>pointer(table,'pointermove',120,120));assert.equal(table.scrollTop,700,'an ongoing canvas pan keeps ownership while reentering a grid');assert.deepEqual(world,{x:20,y:20});
  await act(()=>pointer(table,'pointerup',120,120));assert.equal(captured.has(1),false);
 }finally{document.elementFromPoint=previous;await view.close();}
});


test('an ongoing canvas drag keeps moving when a selected card grid passes under the contact',async()=>{
 const world={x:0,y:0},view=await mount(createElement('div',null,createElement('p',{className:'plain'},'Text'),grid()),true,(x,y)=>{world.x-=x;world.y-=y;window.dispatchEvent(new CustomEvent('agenticview:canvas-navigation',{detail:{card:'test'}}));});
 const previous=document.elementFromPoint;const text=view.host.querySelector('.plain')!,table=view.host.querySelector<HTMLElement>('.grid')!;let hit:Element=text;document.elementFromPoint=()=>hit;
 try{
  view.viewport.scrollLeft=400;view.viewport.scrollTop=700;await act(()=>view.viewport.dispatchEvent(new Event('scroll',{bubbles:true})));
  await act(()=>{pointer(text,'pointerdown',150,150);pointer(text,'pointermove',140,140);});assert.deepEqual(world,{x:-10,y:-10});
  hit=table;await act(()=>pointer(table,'pointermove',120,120));assert.deepEqual(world,{x:-30,y:-30});assert.equal(table.scrollLeft,0);assert.equal(table.scrollTop,0);assert.equal(captured.has(1),true);
  await act(()=>pointer(table,'pointermove',130,130));assert.deepEqual(world,{x:-20,y:-20},'reverse movement recovers handed-out canvas displacement before entering the grid');assert.equal(table.scrollTop,0);
  await act(()=>pointer(table,'pointermove',155,140));assert.deepEqual(world,{x:0,y:-10},'axes independently recover only their outstanding world handoff');assert.equal(view.viewport.scrollLeft,395,'remaining reversal enters the child route after world recovery');assert.equal(table.scrollLeft,0);
  await act(()=>pointer(table,'pointerup',155,140));
  await act(()=>{pointer(table,'pointerdown',130,130);pointer(table,'pointermove',120,120);});assert.equal(table.scrollTop,10,'a fresh grid gesture retains native scrolling');assert.equal(table.scrollLeft,10);assert.deepEqual(world,{x:0,y:-10});
  await act(()=>pointer(table,'pointerup',120,120));
 }finally{document.elementFromPoint=previous;await view.close();}
});
