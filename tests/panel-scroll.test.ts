import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { CardSurface } from '../web/CardSurface.tsx';
import type { Camera } from '../shared/viewport.ts';

// Real CardSurface handlers with distinct, transformed, bounded DOM geometry.
// This is a synthetic event probe, not physical touchscreen or browser evidence.
const dom = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true, enableJavaScriptEvaluation: false } });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMRect', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent'] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
Object.assign(globalThis, { getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame:dom.requestAnimationFrame.bind(dom),cancelAnimationFrame:dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
const { createRoot } = await import('react-dom/client');
const proto = dom.HTMLElement.prototype, capture = new Map<number, Element>();
proto.setPointerCapture = function(id) { capture.set(id, this as unknown as Element); };
proto.hasPointerCapture = function(id) { return capture.get(id) === (this as unknown as Element); };
proto.releasePointerCapture = function(id) { if (capture.get(id) === (this as unknown as Element)) capture.delete(id); };
after(() => { dom.happyDOM.abort(); dom.happyDOM.close(); });
const isPanel = (node: Element) => node.classList.contains('panel');
for (const [key, normal, panel] of [['clientWidth',400,320],['offsetWidth',400,320],['clientHeight',300,250],['offsetHeight',300,250],['scrollWidth',400,900],['scrollHeight',1200,1400],['clientLeft',0,0],['clientTop',0,0]] as const)
  Object.defineProperty(proto, key, { configurable: true, get() { return isPanel(this) ? panel : normal; } });
const offsets = new WeakMap<object, { left: number; top: number }>();
for (const [key, axis, size, content] of [['scrollLeft','left','clientWidth','scrollWidth'],['scrollTop','top','clientHeight','scrollHeight']] as const)
  Object.defineProperty(proto, key, { configurable: true, get() { return offsets.get(this)?.[axis] ?? 0; }, set(value: number) { const state = offsets.get(this) ?? { left: 0, top: 0 }; state[axis] = Math.max(0, Math.min(this[content] - this[size], value)); offsets.set(this,state); } });

async function fixture(innerZoom: number, panelTop: number, outerZoom = .5, kind = 'table-scroll') {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const store = new Map<string, Camera>([['probe',{ x:0,y:0,zoom:innerZoom }]]);
  const world = { x:70,y:50,zoom:outerZoom };
  await act(() => root.render(createElement(CardSurface, { id:'probe',active:true,deactivate(){},canvasOwnsPointer:()=>false,forceCanvas:()=>false,store,
    children:createElement(kind==='code'?'pre':'div',{className:'panel '+kind,style:{overflowX:'auto',overflowY:'auto'}},'Scrollable panel') })));
  const viewport = host.querySelector<HTMLElement>('.card-content-scroll')!, panel = host.querySelector<HTMLElement>('.panel')!;
  viewport.getBoundingClientRect = () => new DOMRect(world.x,world.y,400*outerZoom,300*outerZoom);
  panel.getBoundingClientRect = () => { const z=store.get('probe')!.zoom; return new DOMRect(world.x+outerZoom*(20*z-viewport.scrollLeft),world.y+outerZoom*(panelTop*z-viewport.scrollTop),320*z*outerZoom,250*z*outerZoom); };
  const samples: {delta:number; child:number; parent:number}[]=[];
  const wheel = async (delta:number) => { await act(() => { const event=new MouseEvent('wheel',{bubbles:true,cancelable:true,clientX:100,clientY:170}); for(const [key,value] of Object.entries({deltaX:0,deltaY:delta,deltaMode:0})) Object.defineProperty(event,key,{value}); panel.dispatchEvent(event); }); samples.push({delta,child:panel.scrollTop,parent:viewport.scrollTop}); };
  let touchY=170;
  const previousHitTest=document.elementFromPoint;
  document.elementFromPoint=()=>panel;
  const touch = async (type:string,delta=0) => { touchY-=delta; await act(()=>{ const owner=type==='pointerdown'?panel:capture.get(7)??panel; owner.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:7,pointerType:'touch',button:0,clientX:100,clientY:touchY})); }); if(type==='pointermove') samples.push({delta,child:panel.scrollTop,parent:viewport.scrollTop}); };
  return {host,panel,viewport,samples,wheel,touch,async close(){await act(()=>root.unmount());host.remove();capture.clear();document.elementFromPoint=previousHitTest;}};
}

test('a visible scrollable panel consumes input before its clipped lower edge is revealed',async()=>{
  const f=await fixture(1,180);
  try { await f.wheel(20); console.log('partially-clipped',JSON.stringify(f.samples));
    assert.ok(f.panel.scrollTop>0,'valid child scrolling must progress on first input');
    assert.equal(f.viewport.scrollTop,0,'same-direction child input must not be diverted to parent reveal');
  }finally{await f.close();}
});

for(const kind of ['logs','code']) test(`oversized transformed ${kind} avoids parent-only oscillation during captured touch`,async()=>{
  const f=await fixture(2,0,.5,kind);
  try { f.panel.scrollTop=200;
    await f.touch('pointerdown');
    for(const delta of [20,-20,20,-20,20,-20,20,-20,20,-20,20,-20]) await f.touch('pointermove',delta);
    await f.touch('pointerup');
    console.log('oversized-captured-touch-'+kind,JSON.stringify(f.samples));
    assert.ok(f.samples.some(sample=>sample.child!==200),'scrollable child must progress instead of parent-only oscillation');
  }finally{await f.close();}
});
