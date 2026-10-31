import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { App } from '../web/App.tsx';
import type { AgentView, Snapshot, Patch } from '../shared/protocol.ts';
import type { MonitoringSnapshot } from '../shared/monitoring.ts';
import { fitToViewport, type Rect } from '../shared/canvas.ts';

// Actual App event/lifecycle contracts in memory; no browser or physical touch claims.
const dom = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true, enableJavaScriptEvaluation: false } });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMRect', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'MessageEvent'] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'getComputedStyle'] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom[key].bind(dom) });
const animationFrames = new Map<number, FrameRequestCallback>(); let frameId = 0;
class ControlledResizeObserver {
  static all = new Set<ControlledResizeObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: () => void) { ControlledResizeObserver.all.add(this); }
  observe(target: Element) { this.targets.add(target); }
  disconnect() { this.targets.clear(); ControlledResizeObserver.all.delete(this); }
  static resize(target: Element) { for (const observer of this.all) if (observer.targets.has(target)) observer.callback(); }
}
function flushFrames() { const frames = [...animationFrames.values()]; animationFrames.clear(); for (const callback of frames) callback(0); }
Object.assign(globalThis, { innerWidth: 1200, innerHeight: 800, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: ControlledResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => { animationFrames.set(++frameId, callback); return frameId; },
  cancelAnimationFrame: (id: number) => animationFrames.delete(id) });
class ControlledIntersectionObserver {
  static all = new Set<ControlledIntersectionObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) { ControlledIntersectionObserver.all.add(this); }
  observe(target: Element) { this.targets.add(target);if(target.classList.contains('render-boundary'))this.callback([{target,isIntersecting:true,intersectionRatio:1} as IntersectionObserverEntry],this as unknown as IntersectionObserver); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); ControlledIntersectionObserver.all.delete(this); }
  static visibility(target: Element, intersecting: boolean, ratio = intersecting ? 1 : 0) {
    for (const observer of [...this.all]) if (observer.targets.has(target)) observer.callback([{ target, isIntersecting: intersecting, intersectionRatio: ratio } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
  }
}
Object.assign(globalThis, { IntersectionObserver: ControlledIntersectionObserver });
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
  patch(value: Patch) { this.dispatchEvent(new dom.MessageEvent('patch', { data: JSON.stringify(value) })); }
}
const leaseRequests: { active: boolean; leaseId: string }[] = []; let admission: Promise<void> | undefined;
let releaseAcknowledgement: Promise<void> | undefined, packHook: (() => void) | undefined;
const requestOrder: string[] = [];
const requestPaths: string[] = [];
let lastPackBody: unknown;
let packBounds: Rect|undefined;
function monitoringSnapshot(): MonitoringSnapshot {
  const time = Date.now();
  return { sampledAt: time, uptimeSeconds: 60, active: 1, stale: 0, completed: 0, errors: 0, liveAgents: 1, archived: 0, components: 1, viewerStreams: 1, liveBytes: 1024,
    acceptedBatches: 1, acceptedOperations: 1, acceptedPayloadBytes: 200, duplicateBatches: 0, rejectedPublishes: 0, updatesPerSecond: 1, batchesPerSecond: 1, bytesPerSecond: 200, publishP95Ms: 1, cpuPercent: 2, workingSetBytes: 1024, managedHeapBytes: 512,
    history: [{ time, active: 1, stale: 0, updatesPerSecond: 1, batchesPerSecond: 1, bytesPerSecond: 200, cpuPercent: 2 }],
    kinds: [{ kind: 'metric', components: 1, operations: 1, updatesPerSecond: 1 }], agents: [], stages: [] };
}
Object.assign(globalThis, { EventSource: Stream, fetch: async (input: string, init?: RequestInit) => {
  requestPaths.push(input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (input.startsWith('/api/controls/')) return new Response(JSON.stringify({version:'synthetic',actions:[{id:'edit',label:'Edit',kind:'edit'}]}),{status:200,headers:{'Content-Type':'application/json'}});
  if (input === '/api/monitoring') return new Response(JSON.stringify(monitoringSnapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (input.endsWith('/layout/interaction')) {
    leaseRequests.push(body); requestOrder.push(`lease:${body.active}:request`);
    if (body.active && admission) await admission;
    if (!body.active && releaseAcknowledgement) await releaseAcknowledgement;
    requestOrder.push(`lease:${body.active}:ack`);
  }
  if (input === '/api/layout/pack') { lastPackBody=body; requestOrder.push('pack'); packHook?.(); return new Response(JSON.stringify({ arranged: 1,bounds:packBounds }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
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
async function mount(layout = agent.layout, initial?: Snapshot) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => { root.render(createElement(App)); await Promise.resolve(); });
  await act(() => { Stream.current.snapshot(initial ?? snapshot(layout)); });
  const target = host.querySelector<HTMLElement>('.markdown p')!; assert.ok(target);
  await act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  return { host, target, async close() { await act(() => root.unmount()); host.remove(); captures.clear(); } };
}
function deselect(host: HTMLElement) { host.querySelector('.canvas')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); }
function selectByKeyboard(host: HTMLElement) { host.querySelector('.card-header')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }

test('hidden card headers retain labelled keyboard activation and shortcuts focus the card fallback',async()=>{
 const initial=snapshot();initial.agents=[{...agent,chrome:{header:{visible:false}},components:agent.components}];
 initial.settings={...initial.settings,cardShortcuts:[{id:'hidden',label:'Hidden header card',cardId:agent.id,chord:'Alt+1',mode:'maximize'}]};
 const view=await mount(agent.layout,initial);try{
  const card=view.host.querySelector<HTMLElement>('[data-card-id="agent"]')!;
  assert.equal(card.querySelector(':scope>.card-header'),null);assert.equal(card.tabIndex,0);assert.match(card.getAttribute('aria-label')!,/press Enter to activate/);
  await act(()=>deselect(view.host));assert.equal(card.classList.contains('is-active'),false);
  await act(()=>{card.focus();card.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));});
  assert.equal(card.classList.contains('is-active'),true);
  await act(()=>{const event=new KeyboardEvent('keydown',{key:'1',altKey:true,bubbles:true,cancelable:true});Object.defineProperty(event,'getModifierState',{value:()=>false});window.dispatchEvent(event);});
  await act(()=>flushFrames());
  assert.equal(card.classList.contains('is-maximized'),true);assert.equal(document.activeElement,card);
 }finally{await view.close();}
});

test('live layout telemetry cannot cancel local touch after one-shot Fit all', async () => {
  const view = await mount();
  try {
    await act(() => { document.querySelector<HTMLElement>('[aria-label="Fit all cards"]')!.click(); });
    await act(() => { pointer(view.target, 'pointerdown', 200); pointer(view.target, 'pointermove', 160); });
    assert.equal(captures.has(11), true, 'local content gesture started');
    await act(() => { Stream.current.snapshot(snapshot({ ...agent.layout, height: 421 })); });
    assert.equal(captures.has(11), true, 'telemetry must not release active local touch capture');
  } finally { await view.close(); }
});

test('measured content growth remains deferred after contact release until selected card is deselected', async () => {
  const view = await mount({ ...agent.layout, sizing: 'content' });
  try {
    const card = view.target.closest<HTMLElement>('[data-card-id]')!, measured = view.host.querySelector<HTMLElement>('.agent-content-measure')!;
    const original = { left: card.style.left, top: card.style.top, height: card.style.height };
    await act(() => { pointer(view.target, 'pointerdown', 200); pointer(view.target, 'pointermove', 160); pointer(view.target, 'pointerup', 160); });
    assert.equal(captures.has(11), false, 'contact ended but card remains selected');
    assert.ok(card.classList.contains('is-active'));
    Object.defineProperty(measured, 'offsetHeight', { configurable: true, get: () => 2600 });
    await act(() => { ControlledResizeObserver.resize(measured); flushFrames(); });
    assert.deepEqual({ left: card.style.left, top: card.style.top, height: card.style.height }, original, 'real measured growth cannot resize the selected card');
    await act(() => { deselect(view.host); });
    await act(() => { flushFrames(); });
    assert.equal(card.style.height, '2755px', 'ordinary content grows beyond 1600 after deselection with room for navigation controls');
    assert.equal(card.style.left, original.left); assert.equal(card.style.top, original.top);
  } finally { await view.close(); }
});

test('explicit fit content defers selected fixed-card geometry until deselection', async () => {
  const view=await mount();
  try {
    const card=view.target.closest<HTMLElement>('[data-card-id]')!, measured=view.host.querySelector<HTMLElement>('.agent-content-measure')!;
    const position={left:card.style.left,top:card.style.top},height=card.style.height;Object.defineProperty(measured,'offsetHeight',{configurable:true,get:()=>620});Object.defineProperty(measured,'scrollHeight',{configurable:true,get:()=>620});
    await act(()=>{view.host.querySelector<HTMLButtonElement>('[aria-label="Fit card to content"]')!.click();flushFrames();});
    assert.equal(card.style.height,height,'selection holds geometry even when switching to content sizing');assert.deepEqual({left:card.style.left,top:card.style.top},position);assert.match(card.textContent!,/CONTENT/);
    await act(()=>{deselect(view.host);});await act(()=>{flushFrames();});
    assert.equal(card.style.height,'775px');assert.deepEqual({left:card.style.left,top:card.style.top},position);
  }finally{await view.close();}
});

test('manual archive offers acknowledged Undo without moving the camera or stealing focus',async()=>{
 const view=await mount();try{
  const camera=view.host.querySelector<HTMLElement>('.world')!.style.transform;const active=document.activeElement;
  await act(async()=>{view.host.querySelector<HTMLButtonElement>('[title="Archive agent"]')!.click();await new Promise<void>(done=>setImmediate(done));});
  const notice=document.querySelector<HTMLElement>('.archive-undo')!;assert.ok(notice);assert.match(notice.textContent!,/Synthetic agent.*archived/);assert.equal(notice.getAttribute('aria-live'),'polite');assert.equal(document.activeElement,active);
  await act(async()=>{[...notice.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Undo')!.click();await new Promise<void>(done=>setImmediate(done));});
  assert.ok(requestPaths.includes('/api/archives/agent/restore'));assert.equal(document.querySelector('.archive-undo'),null);assert.equal(view.host.querySelector<HTMLElement>('.world')!.style.transform,camera);
 }finally{await view.close();}
});

test('owner selection policy keeps lease after contact and releases on deselection after admission', async () => {
  const view = await mount(); let release!: () => void;
  leaseRequests.length = 0; admission = new Promise<void>(resolve => { release = resolve; });
  try {
    await act(() => { pointer(view.target, 'pointerdown', 200); });
    assert.equal(leaseRequests.length, 1); assert.equal(leaseRequests[0]!.active, true);
    await act(() => { pointer(view.target, 'pointerup', 200); }); assert.equal(leaseRequests.length, 1, 'selected card retains lease after contact');
    await act(() => { deselect(view.host); }); assert.equal(leaseRequests.length, 1, 'deselection release waits for admitted request');
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
    await act(() => { deselect(view.host); selectByKeyboard(view.host); });
    await act(() => { pointer(view.target, 'pointerdown', 200); });
    await act(async () => { release(); admission = undefined; await new Promise<void>(resolve => setImmediate(resolve)); });
    assert.ok(leaseRequests.length > 0); assert.ok(leaseRequests.every(request => request.active), 'stale release is skipped while new contact remains');
    await act(async () => { pointer(view.target, 'pointerup', 200); deselect(view.host); await new Promise<void>(resolve => setImmediate(resolve)); });
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

test('owner selection policy defers repeated layouts through contact release until explicit deselection', async () => {
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
    assert.equal(card.style.left, left, 'selection continues holding position after contact release');
    assert.equal(card.style.height, height, 'selection continues holding size after contact release');
    await act(() => { deselect(view.host); });
    const accepted = view.host.querySelector<HTMLElement>('[data-card-id="agent"]')!;
    assert.ok(accepted, 'latest geometry remains in view');
    assert.equal(accepted.style.left, '300px', 'latest pending position wins');
    assert.equal(accepted.style.height, '600px', 'latest pending size wins');
  } finally { await view.close(); }
});

test('arrival preserves selected geometry and camera, appears without confirmation, and highlights only after first intersection', async () => {
  const view = await mount();
  const setTimer = globalThis.setTimeout; const fadeCallbacks: (() => void)[] = [];
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== undefined && delay >= 5000 && delay <= 6000) { fadeCallbacks.push(() => callback(...args)); return 900001 as unknown as ReturnType<typeof setTimeout>; }
    return setTimer(callback, delay, ...args);
  }) as typeof setTimeout;
  try {
    const selected = view.host.querySelector<HTMLElement>('[data-card-id="agent"]')!, world = view.host.querySelector<HTMLElement>('.world')!;
    const original = { left: selected.style.left, top: selected.style.top, width: selected.style.width, height: selected.style.height, camera: world.style.transform };
    assert.equal(selected.querySelector('.arrival-halo'), null, 'initial snapshot cards are not newly arrived');
    const update = snapshot({ ...agent.layout, x: 200, height: 550 }); update.revision = 2;
    update.agents.push({ ...agent, id: 'new-agent', agentId: 'new-synthetic', name: 'New synthetic arrival', createdAt: Date.now(), layout: { ...agent.layout, x: 700 } });
    await act(() => { Stream.current.snapshot(update); });
    assert.deepEqual({ left: selected.style.left, top: selected.style.top, width: selected.style.width, height: selected.style.height, camera: world.style.transform }, original, 'arrival and remote update preserve selection geometry and camera');
    const arrived = view.host.querySelector<HTMLElement>('[data-card-id="new-agent"]')!; assert.ok(arrived, 'new unlocked card appears immediately');
    assert.equal(document.querySelector('.arrival-notice'), null, 'arrival does not require Show card confirmation');
    assert.equal([...document.querySelectorAll('button')].some(button => button.textContent?.includes('Show card')), false);
    assert.ok(arrived.querySelector('.arrival-halo')); assert.equal(arrived.querySelector('.arrival-visible'), null);
    assert.equal(fadeCallbacks.length, 0, 'arrival age does not run before visibility');
    await act(() => { ControlledIntersectionObserver.visibility(arrived, false); });
    assert.equal(arrived.querySelector('.arrival-visible'), null, 'nonintersection cannot start arrival age');
    await act(() => { ControlledIntersectionObserver.visibility(arrived, true, 0); });
    assert.equal(arrived.querySelector('.arrival-visible'), null, 'zero-area contact cannot start arrival age');
    await act(() => { ControlledIntersectionObserver.visibility(arrived, true); });
    assert.ok(arrived.querySelector('.arrival-visible'), 'first intersection starts arrival highlight');
    assert.equal(fadeCallbacks.length, 1, 'one fade interval starts after visibility');
    await act(() => { fadeCallbacks[0]!(); });
    assert.equal(arrived.querySelector('.arrival-halo'), null, 'arrival highlight ends after its fade interval');
    assert.equal(world.style.transform, original.camera, 'visibility and fade do not navigate camera');
  } finally { await view.close(); globalThis.setTimeout = setTimer; }
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

test('Arrange all cancels contact, deselects and awaits acknowledged lease release before packing', async () => {
  const view = await mount(); let acknowledge!: () => void;
  releaseAcknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
  requestOrder.length = 0;
  packHook = () => { const update = snapshot({ ...agent.layout, x: 260, height: 480 }); update.revision = 3; Stream.current.snapshot(update); };
  try {
    const card = view.target.closest<HTMLElement>('[data-card-id]')!;
    await act(() => { pointer(view.target, 'pointerdown', 200); pointer(view.target, 'pointermove', 160); });
    assert.equal(captures.has(11), true); assert.ok(card.classList.contains('is-active'));
    await act(async () => { document.querySelector<HTMLElement>('[aria-label="Arrange all cards"]')!.click(); await new Promise<void>(resolve => setImmediate(resolve)); });
    assert.equal(captures.has(11), false, 'explicit Arrange all ends local contact');
    assert.equal(card.classList.contains('is-active'), false, 'explicit Arrange all deselects leased card');
    assert.ok(requestOrder.includes('lease:false:request'), 'selected interaction release requested');
    assert.equal(requestOrder.includes('pack'), false, 'packing cannot race unacknowledged lease release');
    await act(async () => { acknowledge(); await new Promise<void>(resolve => setImmediate(resolve)); });
    assert.ok(requestOrder.indexOf('lease:false:ack') >= 0);
    assert.ok(requestOrder.indexOf('pack') > requestOrder.indexOf('lease:false:ack'), 'server acknowledgement precedes pack request');
    assert.deepEqual(lastPackBody,{mode:'all',aspectRatio:1},'Arrange all targets a square regardless of window aspect');
    const packed = view.host.querySelector<HTMLElement>('[data-card-id="agent"]')!;
    assert.equal(packed.style.left, '260px', 'previously selected unlocked card accepts packed live position');
    assert.equal(packed.style.height, '480px', 'packed live geometry is no longer held by selection');
  } finally { acknowledge(); releaseAcknowledgement = undefined; packHook = undefined; await view.close(); }
});

test('Arrange all leaves standalone mode and frames acknowledged packed bounds before the live patch arrives',async()=>{
 const state=snapshot();state.settings.cardShortcuts=[{id:'app',label:'Example app',cardId:'agent',chord:'Alt+1',mode:'maximize'}];
 const view=await mount(agent.layout,state);try{
  await act(()=>{const event=new KeyboardEvent('keydown',{key:'1',altKey:true,bubbles:true,cancelable:true});Object.defineProperty(event,'getModifierState',{value:()=>false});window.dispatchEvent(event);});
  assert.equal(view.host.querySelector('[data-card-id="agent"]')!.classList.contains('is-maximized'),true);
  packBounds={x:5000,y:3000,width:1000,height:1000};
  await act(async()=>{document.querySelector<HTMLButtonElement>('[aria-label="Arrange all cards"]')!.click();await new Promise<void>(resolve=>setImmediate(resolve));});
  assert.equal(view.host.querySelector('.world')!.classList.contains('has-maximized'),false);
  const expected=fitToViewport([packBounds],{width:1200,height:800});
  assert.equal(view.host.querySelector<HTMLElement>('.world')!.style.transform.replace(' translateZ(0)',''),`translate(${expected.x}px, ${expected.y}px) scale(${expected.zoom})`);
 }finally{packBounds=undefined;await view.close();}
});

test('selected-card zoom reaches 200 percent in the main view before content zoom starts', async () => {
  const view = await mount();
  try {
    const outer = view.host.querySelector<HTMLElement>('.world')!, inner = view.host.querySelector<HTMLElement>('.card-content-plane')!;
    const scale = (element: HTMLElement) => element.style.transform==='none'?1:Number(/scale\(([^)]+)\)/.exec(element.style.transform)![1]);
    const zoom = (factor: number) => { const event = new MouseEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, clientX: 100, clientY: 100 }); for (const [key, value] of Object.entries({ deltaY: -Math.log(factor) / .0015, deltaX: 0, deltaMode: 0 })) Object.defineProperty(event, key, { value }); view.target.dispatchEvent(event); };
    assert.ok(scale(outer) < 2);
    await act(() => { zoom(2 / scale(outer)); });
    assert.ok(Math.abs(scale(outer) - 2) < 1e-8); assert.ok(Math.abs(scale(inner) - 1) < 1e-8);
    await act(() => { zoom(1.2); });
    assert.ok(Math.abs(scale(outer) - 2) < 1e-8); assert.ok(Math.abs(scale(inner) - 1.2) < 1e-8);
  } finally { await view.close(); }
});

test('monitoring is a movable utility world card with isolated polling and global canvas authority', async () => {
  const view = await mount(); const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
  const ownNow = Object.getOwnPropertyDescriptor(performance, 'now'), now = performance.now.bind(performance); let elapsed = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + elapsed });
  let nextTimer = 950000; const polls = new Map<number, () => void>(); requestPaths.length = 0;
  globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => { if (delay === 1000) { polls.set(++nextTimer, callback); return nextTimer; } return setTimer(callback, delay, ...args); }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { if (!polls.delete(id)) clearTimer(id); }) as typeof clearTimeout;
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const utility = (id: string) => view.host.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;
  const rect = (node: HTMLElement) => ({ x: parseFloat(node.style.left), y: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) });
  const key = (node: Element, value: string) => node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  try {
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Hub monitoring"]')!.click(); await settle(); });
    assert.ok(utility('monitoring')); assert.ok(utility('monitoring').classList.contains('is-active'));
    assert.match(utility('monitoring').textContent!, /Accepted traffic|Run states/);
    assert.equal(requestPaths.filter(path => path === '/api/monitoring').length, 1); assert.equal(polls.size, 1);
    await act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Workspace settings"]')!.click(); });
    await act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Fit all cards"]')!.click(); });
    assert.ok(utility('settings')); assert.ok(utility('monitoring'));
    const a = rect(utility('settings')), b = rect(utility('monitoring'));
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'utility cards coexist without overlap');
    let header = utility('monitoring').querySelector<HTMLElement>('.card-header')!;
    await act(() => { key(header, 'Enter'); }); assert.ok(utility('monitoring').classList.contains('is-active'));
    const beforeKeyboard = rect(utility('monitoring'));
    await act(() => { key(header, 'ArrowUp'); });
    assert.notDeepEqual(rect(utility('monitoring')), beforeKeyboard, 'header keyboard moves the utility card');
    header = utility('monitoring').querySelector<HTMLElement>('.card-header')!;
    const beforeTouch = rect(utility('monitoring'));
    await act(() => { pointer(header, 'pointerdown', 200); pointer(header, 'pointermove', 160); pointer(header, 'pointerup', 160); });
    assert.notDeepEqual(rect(utility('monitoring')), beforeTouch, 'touch header drag moves the utility card');
    header = utility('monitoring').querySelector<HTMLElement>('.card-header')!;
    const beforeMouse = rect(utility('monitoring'));
    await act(() => { for (const [type, x, y] of [['pointerdown', 100, 200], ['pointermove', 130, 180], ['pointerup', 130, 180]] as const) { const owner = type === 'pointerdown' ? header : captures.get(21) ?? header; owner.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', pointerId: 21, button: 0, clientX: x, clientY: y })); } });
    assert.notDeepEqual(rect(utility('monitoring')), beforeMouse, 'mouse header drag moves the utility card');
    const content = utility('monitoring').querySelector<HTMLElement>('.monitoring-heading h2')!;
    await act(() => { pointer(content, 'pointerdown', 200); }); assert.equal(captures.has(11), true);
    await act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Fit all cards"]')!.click(); }); assert.equal(captures.has(11), false, 'global Fit all cancels local monitoring gesture');
    const world = view.host.querySelector<HTMLElement>('.world')!, beforeCanvas = world.style.transform;
    await act(() => { key(view.host.querySelector('.canvas')!, 'ArrowLeft'); });
    assert.notEqual(world.style.transform, beforeCanvas, 'canvas keyboard retains navigation authority');
    assert.equal(requestPaths.some(path => /^\/api\/agents\/(monitoring|settings)\//.test(path)), false, 'utility IDs never use producer layout or interaction APIs');
    const received = requestPaths.filter(path => path === '/api/monitoring').length;
    elapsed += 1000; // Advance past deliberate post-drag ghost-click suppression without sleeping.
    await act(() => { utility('monitoring').querySelector<HTMLButtonElement>('[aria-label="Close monitoring"]')!.click(); });
    assert.equal(Boolean(utility('monitoring')), false, 'monitoring card closes'); assert.ok(utility('settings')); assert.equal(polls.size, 0, 'closing utility stops polling');
    await act(async () => { for (const callback of polls.values()) callback(); await settle(); });
    assert.equal(requestPaths.filter(path => path === '/api/monitoring').length, received);
  } finally { await view.close(); globalThis.setTimeout = setTimer; globalThis.clearTimeout = clearTimer; if (ownNow) Object.defineProperty(performance, 'now', ownNow); else Reflect.deleteProperty(performance, 'now'); }
});

test('live memoized descendants update and promote without interrupting selected parent touch', async()=>{
  const child:AgentView={...agent,id:'child',agentId:'child',name:'Synthetic child',parentId:agent.id,components:{}};
  const grandchild:AgentView={...agent,id:'grandchild',agentId:'grandchild',name:'Synthetic grandchild',parentId:child.id,
    components:{content:{id:'content',title:'Nested evidence',kind:'markdown',data:{text:'Original grandchild evidence'}}}};
  const initial=snapshot(); initial.agents=[agent,child,grandchild]; initial.stats={...initial.stats,active:3};
  const view=await mount(agent.layout,initial);
  try {
    const parent=view.host.querySelector<HTMLElement>('[data-card-id="agent"]')!;
    const geometry=()=>({left:parent.style.left,top:parent.style.top,width:parent.style.width,height:parent.style.height});
    const original=geometry(),world=view.host.querySelector<HTMLElement>('.world')!,camera=world.style.transform;
    assert.ok(parent.textContent?.includes('Original grandchild evidence'));
    await act(()=>{pointer(view.target,'pointerdown',200);pointer(view.target,'pointermove',180);});
    const owner=captures.get(11); assert.equal(Boolean(owner),true,'parent local content owns capture');
    const updated={id:'content',title:'Nested evidence',kind:'markdown',data:{text:'Updated grandchild evidence'}} as const;
    await act(()=>{Stream.current.patch({revision:2,changes:[{id:grandchild.id,components:[updated]}],removed:[],stats:initial.stats});});
    assert.equal(parent.textContent?.includes('Updated grandchild evidence'),true,'grandchild component patch propagates through memoized ancestors');
    assert.equal(parent.textContent?.includes('Original grandchild evidence'),false);
    assert.equal(captures.get(11)===owner,true,'nested content patch retains capture owner');
    const {components:_,...childMeta}=child;
    await act(()=>{Stream.current.patch({revision:3,changes:[{id:child.id,meta:{...childMeta,status:'completed',completedAt:10000,updatedAt:10000}}],removed:[],stats:{...initial.stats,active:2}});});
    const completed=[...parent.querySelectorAll<HTMLElement>('.child-card')].find(card=>card.querySelector('header strong')?.textContent===child.name)!;
    assert.equal(Boolean(completed),true);
    assert.equal(completed.classList.contains('status-completed'),true);
    const archive=completed.querySelector<HTMLButtonElement>('header button.archive-completed');
    assert.equal(archive?.textContent?.includes('Archive'),true,'completed child exposes prominent archive action');
    const time=completed.querySelector<HTMLTimeElement>('.child-times time[title^="Completed:"]');
    assert.equal(time?.dateTime,new Date(10000).toISOString(),'completed child footer receives completion timestamp');
    assert.equal(captures.get(11)===owner,true);
    const {components:__,...grandMeta}=grandchild;
    await act(()=>{Stream.current.patch({revision:4,changes:[{id:grandchild.id,meta:{...grandMeta,parentId:null,layout:{...grandchild.layout,x:520,y:0}}}],removed:[child.id],stats:{...initial.stats,active:2}});});
    const promoted=view.host.querySelector<HTMLElement>('[data-card-id="grandchild"]');
    assert.equal(Boolean(promoted),true,'grandchild becomes a root world card');
    assert.equal(promoted?.style.left,'520px'); assert.equal(promoted?.style.top,'0px');
    assert.equal(promoted?.textContent?.includes('Updated grandchild evidence'),true,'promotion retains latest component delta');
    assert.equal(parent.querySelector('.child-card'),null,'removed child and promoted descendant leave parent subtree');
    assert.equal(parent.textContent?.includes('Updated grandchild evidence'),false);
    assert.deepEqual(geometry(),original,'selected parent geometry survives subtree removal and new root layout');
    assert.equal(world.style.transform,camera,'live nested changes cannot navigate camera');
    assert.equal(captures.get(11)===owner,true,'promotion preserves original parent capture');
    const scroller=parent.querySelector<HTMLElement>('.card-content-scroll')!,before=scroller.scrollTop;
    await act(()=>{pointer(document.body,'pointermove',140);});
    assert.ok(scroller.scrollTop>before,'same captured contact continues scrolling after all tree changes');
    await act(()=>{pointer(document.body,'pointerup',140);}); assert.equal(captures.has(11),false);
  } finally {await view.close();}
});


test('archived cards auto-open as a draggable world card without stealing selection or camera', async () => {
  const view = await mount();
  try {
    const camera = view.host.querySelector<HTMLElement>('.world')!.style.transform;
    const next = snapshot(); next.stats.archived = 1;
    await act(async () => { Stream.current.snapshot(next); await new Promise<void>(resolve => setImmediate(resolve)); });
    const archives = view.host.querySelector<HTMLElement>('[data-card-id="archives"]')!;
    assert.ok(archives, 'existing archives create a visible world utility');
    assert.match(archives.querySelector('.card-header')!.textContent!, /Archived cards/);
    assert.equal(view.host.querySelector<HTMLElement>('[data-card-id="agent"]')!.classList.contains('is-active'), true);
    assert.equal(view.host.querySelector<HTMLElement>('.world')!.style.transform, camera);
    const header = archives.querySelector<HTMLElement>('.card-header')!, left = Number.parseFloat(archives.style.left);
    await act(() => { header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await act(() => { header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); });
    assert.ok(Number.parseFloat(archives.style.left) > left, 'archive utility participates in keyboard card dragging');
    assert.equal(requestPaths.some(path => path.startsWith('/api/agents/archives/')), false, 'utility movement never uses agent mutation APIs');
    await act(() => { archives.querySelector<HTMLButtonElement>('[aria-label="Close archived cards"]')!.click(); });
    assert.equal(view.host.querySelector('[data-card-id="archives"]'), null);
  } finally { await view.close(); }
});


test('table editors grow selected cards in both dimensions and defer geometry during a captured gesture',async()=>{
 const state=snapshot();state.agents[0].components.grid={id:'grid',title:'Table',kind:'data-grid',data:{editAction:'edit',columns:[{key:'name',label:'Name',editable:true}],rows:[{name:'example'}]}};
 const view=await mount(agent.layout,state);
 try{
  const card=view.target.closest<HTMLElement>('[data-card-id]')!,measured=card.querySelector<HTMLElement>('.agent-content-measure')!,table=card.querySelector<HTMLElement>('table')!,wrapper=card.querySelector<HTMLElement>('.control-grid')!;
  Object.defineProperty(measured,'offsetWidth',{configurable:true,get:()=>Number.parseFloat(card.style.width)-40});Object.defineProperty(measured,'scrollWidth',{configurable:true,get:()=>Number.parseFloat(card.style.width)-40});
  Object.defineProperty(measured,'offsetHeight',{configurable:true,get:()=>900});Object.defineProperty(measured,'scrollHeight',{configurable:true,get:()=>900});Object.defineProperty(wrapper,'clientWidth',{configurable:true,get:()=>Number.parseFloat(card.style.width)-68});Object.defineProperty(table,'scrollWidth',{configurable:true,get:()=>900});Object.defineProperty(table,'offsetWidth',{configurable:true,get:()=>900});
  await act(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));});
  const before={width:card.style.width,height:card.style.height};
  await act(()=>{[...card.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Edit')!.click();});
  await act(()=>{pointer(view.target,'pointerdown',200);pointer(view.target,'pointermove',180);});
  await act(()=>flushFrames());
  assert.deepEqual({width:card.style.width,height:card.style.height},before,'the editor request must wait until the gesture ends');
  await act(()=>pointer(view.target,'pointerup',180));await act(()=>flushFrames());
  assert.equal(card.style.width,'968px');assert.equal(card.style.height,'1055px');assert.ok(card.classList.contains('is-active'));assert.ok(card.querySelector('input[aria-label="Name for row 1"]'));assert.match(card.textContent!,/CONTENT/);
 }finally{await view.close();}
});

test('card shortcuts maximize the existing card, preserve local nodes and return to the original canvas geometry',async()=>{
 const state=snapshot();state.agents.push({...agent,id:'sibling',agentId:'sibling',layout:{...agent.layout,x:700}});state.settings.cardShortcuts=[{id:'app',label:'Example app',cardId:'agent',chord:'Alt+1',mode:'maximize'},{id:'other',label:'Other app',cardId:'sibling',chord:'Alt+2',mode:'maximize'}];const view=await mount(agent.layout,state);
 const stylesheet=document.createElement('style');stylesheet.textContent=readFileSync(new URL('../web/styles.css',import.meta.url),'utf8');document.head.append(stylesheet);
 try{
  const card=view.target.closest<HTMLElement>('[data-card-id]')!,surface=card.querySelector('[data-card-surface]'),sibling=view.host.querySelector<HTMLElement>('[data-card-id="sibling"]')!,geometry={left:card.style.left,top:card.style.top,width:card.style.width,height:card.style.height};
  await act(()=>{const event=new KeyboardEvent('keydown',{key:'1',altKey:true,bubbles:true,cancelable:true});Object.defineProperty(event,'getModifierState',{value:()=>false});window.dispatchEvent(event);});
  assert.ok(card.classList.contains('is-maximized'));assert.equal(card.style.width,'1168px');assert.equal(card.style.height,'680px');assert.equal(card.querySelector('[data-card-surface]'),surface);assert.ok(card.classList.contains('is-active'));
  assert.equal(getComputedStyle(sibling).visibility,'hidden','Retained sibling wrappers must not defeat maximize input/visibility isolation');
  await act(()=>{const event=new KeyboardEvent('keydown',{key:'2',altKey:true,bubbles:true,cancelable:true});Object.defineProperty(event,'getModifierState',{value:()=>false});window.dispatchEvent(event);});
  assert.ok(sibling.classList.contains('is-maximized'));
  assert.equal(view.host.querySelectorAll('.world-card.is-maximized').length,1,'Switching maximized cards must update retained inactive shells');
  assert.equal(getComputedStyle(card).visibility,'hidden');assert.equal(card.style.width,geometry.width);assert.equal(card.querySelector('[data-card-surface]'),surface);
  await act(()=>{const event=new KeyboardEvent('keydown',{key:'1',altKey:true,bubbles:true,cancelable:true});Object.defineProperty(event,'getModifierState',{value:()=>false});window.dispatchEvent(event);});
  assert.equal(view.host.querySelectorAll('.world-card.is-maximized').length,1);assert.equal(getComputedStyle(sibling).visibility,'hidden');
  await act(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  assert.ok(!card.classList.contains('is-maximized'));assert.deepEqual({left:card.style.left,top:card.style.top,width:card.style.width,height:card.style.height},geometry);assert.equal(card.querySelector('[data-card-surface]'),surface);
  assert.notEqual(getComputedStyle(sibling).visibility,'hidden');assert.equal(view.host.querySelector('[data-card-id="sibling"]'),sibling);
 }finally{stylesheet.remove();await view.close();}
});


test('far canvas zoom preserves native views and their local nodes without summary replacement',async()=>{
 const initial=snapshot();initial.agents.push({...agent,id:'far',agentId:'far',name:'Far native view',layout:{...agent.layout,x:24000,y:12000}});
 const view=await mount(agent.layout,initial);
 try{
  const card=view.host.querySelector<HTMLElement>('[data-card-id="agent"]')!,content=card.querySelector('[data-debug-component="content"]'),surface=card.querySelector('[data-card-surface]');
  await act(()=>document.querySelector<HTMLButtonElement>('[aria-label="Fit all cards"]')!.click());await act(()=>flushFrames());
  assert.equal(view.host.querySelectorAll('.card-overview').length,0);
  assert.equal(card.querySelector('[data-card-surface]'),surface);assert.equal(card.querySelector('[data-debug-component="content"]'),content);
  assert.ok(content?.textContent?.includes('Scrollable evidence'));assert.equal(card.getAttribute('data-card-detail'),'full');
  assert.equal(view.host.querySelectorAll('[data-debug-component="content"]').length,2,'Far visible cards keep their native contents');
  const world=view.host.querySelector<HTMLElement>('.world')!,zoom=()=>Number(world.style.transform.match(/scale\(([^)]+)\)/)![1]);
  await act(()=>document.querySelector<HTMLButtonElement>('[aria-label="Workspace settings"]')!.click());
  assert.equal(zoom(),.8,'Opening settings must update the imperative camera and rendered transform together');
  await act(()=>document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
  assert.ok(Math.abs(zoom()-.96)<1e-9,'Subsequent navigation must start from the settings camera');
 }finally{await view.close();}
});
