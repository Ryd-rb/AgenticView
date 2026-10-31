import test from 'node:test';
import assert from 'node:assert/strict';
import { act,createElement,useEffect } from 'react';
import { Window } from 'happy-dom';
import { CardSurface } from '../web/CardSurface.tsx';
import { traceInput } from '../web/InputTrace.ts';

async function fixture(){
  const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','HTMLInputElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  const previous={raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame,ro:globalThis.ResizeObserver};
  const frames=new Map<number,FrameRequestCallback>();let serial=0,height=300;
  Object.assign(globalThis,{requestAnimationFrame:(callback:FrameRequestCallback)=>{frames.set(++serial,callback);return serial;},cancelAnimationFrame:(id:number)=>frames.delete(id)});
  const observers=new Set<Observer>();
  class Observer{targets=new Set<Element>();constructor(readonly callback:ResizeObserverCallback){observers.add(this);}observe(target:Element){this.targets.add(target);}unobserve(target:Element){this.targets.delete(target);}disconnect(){this.targets.clear();observers.delete(this);}}
  Object.assign(globalThis,{ResizeObserver:Observer});
  const geometry:string[]=[],scroll={reads:0,writes:0};const offsets=new WeakMap<object,{left:number;top:number}>();
  const offset=(element:object)=>{let value=offsets.get(element);if(!value){value={left:0,top:0};offsets.set(element,value);}return value;};
  for(const field of ['scrollLeft','scrollTop'] as const)Object.defineProperty(dom.HTMLElement.prototype,field,{configurable:true,get(){if(this.classList.contains('card-content-scroll'))scroll.reads++;return offset(this)[field==='scrollLeft'?'left':'top'];},set(value:number){if(this.classList.contains('card-content-scroll'))scroll.writes++;offset(this)[field==='scrollLeft'?'left':'top']=value;}});
  for(const field of ['clientWidth','clientHeight','offsetWidth','offsetHeight','scrollWidth','scrollHeight'] as const)Object.defineProperty(dom.HTMLElement.prototype,field,{configurable:true,get(){
    if(this.classList.contains('card-content-plane')&&(field==='scrollWidth'||field==='scrollHeight'))geometry.push(`read:${this.closest('[data-card-surface]')?.getAttribute('data-card-surface')}:${field}`);
    return field.includes('Width')?this.classList.contains('card-content-plane')?640:320:this.classList.contains('card-content-plane')?height:180;
  }});
  const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const flush=()=>act(async()=>{const current=[...frames.values()];frames.clear();for(const callback of current)callback(performance.now());});
  const resize=()=>act(async()=>{for(const observer of observers)observer.callback([],observer as unknown as ResizeObserver);});
  return {host,root,geometry,scroll,frames,observers,flush,resize,setHeight:(value:number)=>{height=value;},nativeOffset:(element:HTMLElement,left:number,top:number)=>offsets.set(element,{left,top}),close:async()=>{await act(async()=>root.unmount());assert.equal(observers.size,0);assert.equal(frames.size,0);Object.assign(globalThis,{requestAnimationFrame:previous.raf,cancelAnimationFrame:previous.caf,ResizeObserver:previous.ro});await dom.happyDOM.close();}};
}

test('origin card surfaces batch content geometry and retain content without redundant native scroll commits',async()=>{
  const f=await fixture(),store=new Map<string,{x:number;y:number;zoom:number}>();let mounts=0,unmounts=0;
  function Content({id}:{id:string}){useEffect(()=>{mounts++;return()=>{unmounts++;};},[]);return createElement('input',{'aria-label':id,defaultValue:'private-draft'});}
  const render=(zoom:number)=>act(async()=>{f.root.render(createElement('div',null,...['a','b','c'].map(id=>createElement(CardSurface,{key:id,id,active:true,deactivate:()=>{},canvasOwnsPointer:()=>false,forceCanvas:()=>false,store,canvasCamera:{x:0,y:0,zoom},children:createElement(Content,{id})}))));});
  try{
    await render(1);assert.equal(mounts,3);const inputs=[...f.host.querySelectorAll('input')];inputs[0]!.value='unsaved draft';
    await f.flush();for(const plane of f.host.querySelectorAll<HTMLElement>('.card-content-plane'))assert.equal(plane.style.width,'320px','All mounted surfaces write initial content widths in the same frame');
    assert.equal(f.geometry.some(item=>item.startsWith('read:')),false,'Content extent reads wait for the next frame after the width-write batch');
    await f.flush();await f.flush();
    assert.ok(f.geometry.some(item=>item.endsWith('scrollHeight')),'Actual content geometry was measured');
    for(const extent of f.host.querySelectorAll<HTMLElement>('.card-scroll-extent')){assert.equal(extent.style.width,'640px');assert.equal(extent.style.height,'300px');}
    assert.deepEqual(f.scroll,{reads:0,writes:0},'Known origin with no anchor avoids native scroll property reads and writes');
    f.setHeight(480);await f.resize();await f.flush();await f.flush();await f.flush();await render(.04);
    for(const extent of f.host.querySelectorAll<HTMLElement>('.card-scroll-extent'))assert.equal(extent.style.height,'480px');
    assert.deepEqual(f.scroll,{reads:0,writes:0},'Extent and outer zoom updates at the origin do not recommit native scroll');
    assert.deepEqual([...f.host.querySelectorAll('input')],inputs);assert.equal(inputs[0]!.value,'unsaved draft');assert.equal(mounts,3);assert.equal(unmounts,0);
    const viewport=f.host.querySelector<HTMLElement>('.card-content-scroll')!;
    f.nativeOffset(viewport,32,18);await act(async()=>viewport.dispatchEvent(new Event('scroll',{bubbles:true})));
    assert.ok(f.scroll.reads>=2,'A real native scroll observation still consumes actual offsets');assert.equal(store.get('a')!.x,-32);assert.equal(store.get('a')!.y,-18);
  }finally{await f.close();}
  assert.equal(unmounts,3);
});

test('lazy numeric input tracing evaluates only while enabled and exports bounded geometry without content',async()=>{
  const dom=new Window();Object.defineProperty(globalThis,'window',{configurable:true,value:dom});const messages:unknown[]=[];Object.assign(dom,{chrome:{webview:{postMessage:(value:unknown)=>messages.push(value)}}});
  let evaluations=0;const values=()=>{evaluations++;return [12,NaN,Infinity,...Array.from({length:40},(_,index)=>index)];};
  try{
    traceInput('geometry',values);assert.equal(evaluations,0);
    Object.assign(dom,{agenticViewInputTraceUntil:Date.now()-1});traceInput('geometry',values);assert.equal(evaluations,0);
    Object.assign(dom,{agenticViewInputTraceUntil:Date.now()+10000});traceInput('geometry',values);assert.equal(evaluations,1);assert.equal(messages.length,1);
    const message=messages[0] as {type:string;phase:string;values:number[]};assert.equal(message.type,'agenticview:input-trace');assert.equal(message.phase,'geometry');assert.equal(message.values.length,32);assert.ok(message.values.every(Number.isFinite));assert.deepEqual(message.values.slice(0,3),[12,0,0]);assert.equal(JSON.stringify(message).includes('private-draft'),false);
    Object.assign(dom,{agenticViewInputTraceUntil:0});traceInput('geometry',values);assert.equal(evaluations,1);
  }finally{await dom.happyDOM.close();}
});
