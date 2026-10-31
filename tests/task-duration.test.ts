import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement,Profiler } from 'react';
import {RenderBoundary} from '../web/RenderActivity.tsx';
import { TaskDuration } from '../web/TaskDuration.tsx';
import {exactTime} from '../shared/time-format.ts';

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

test('physically hidden task clocks follow finite logical background activity and pause for frozen or offscreen views',async()=>{
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','CustomEvent'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 let now=500000,id=0;const timers=new Map<number,()=>void>(),original={now:Date.now,set:globalThis.setInterval,clear:globalThis.clearInterval};Date.now=()=>now;
 globalThis.setInterval=((callback:()=>void)=>{timers.set(++id,callback);return id;}) as unknown as typeof setInterval;globalThis.clearInterval=((timer:number)=>{timers.delete(timer);}) as unknown as typeof clearInterval;
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
 const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host),timing={key:'hidden',line:1,firstSeenAt:498766,startedAt:498766,updatedAt:498766},session='11111111-1111-4111-8111-111111111111';
 const render=async(visible=true,updates=true,completedAt?:number)=>act(()=>root.render(createElement(RenderBoundary,{visible,updates,children:()=>createElement('div',null,createElement(TaskDuration,{timing:{...timing,...(completedAt===undefined?{}:{completedAt})}}),createElement(TaskDuration,{timing:{...timing,key:'shared',...(completedAt===undefined?{}:{completedAt})}}))})));
 const native=async(active:boolean)=>act(()=>window.dispatchEvent(new CustomEvent('agenticview:native-visibility',{detail:{visible:false,background:{active,sessionId:session,expiresAt:now+60000}}})));
 try{
  await render();assert.equal(timers.size,0,'Ordinary physical hidden windows remain idle');await native(true);assert.equal(document.visibilityState,'hidden');assert.equal(timers.size,1,'Logical background lease enables the one shared interval');const elements=[...host.querySelectorAll('time')];
  now+=1000;await act(()=>{for(const callback of timers.values())callback();});assert.match(host.textContent!,/2.234s/);
  await render(true,false);assert.equal(timers.size,0);const retained=host.textContent;now+=10000;assert.equal(host.textContent,retained);await render(true,true);assert.equal(timers.size,1);assert.match(host.textContent!,/12.234s/);
  await render(false,true);assert.equal(timers.size,0);now+=1000;await render(true,true);assert.equal(timers.size,1);assert.deepEqual([...host.querySelectorAll('time')],elements);
  await native(false);assert.equal(timers.size,0,'Closing the override restores ordinary hidden-idle behavior');await native(true);assert.equal(timers.size,1);await render(true,true,500000);assert.equal(timers.size,0);assert.match(host.textContent!,/1.234s/);assert.ok(host.querySelector('time')!.title.includes(`Completed ${exactTime(500000)}`));
 }finally{await act(()=>root.unmount());assert.equal(timers.size,0);Date.now=original.now;globalThis.setInterval=original.set;globalThis.clearInterval=original.clear;await dom.happyDOM.close();}
});

test('minute labels keep a stable snapshot and DOM until their boundary while short tasks still tick',async()=>{
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 let now=2000000,id=0,commits=0;const timers=new Map<number,()=>void>(),original={now:Date.now,set:globalThis.setInterval,clear:globalThis.clearInterval};Date.now=()=>now;
 globalThis.setInterval=((callback:()=>void)=>{timers.set(++id,callback);return id;}) as unknown as typeof setInterval;globalThis.clearInterval=((timer:number)=>{timers.delete(timer);}) as unknown as typeof clearInterval;
 const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host),long={key:'long',line:1,firstSeenAt:1350000,startedAt:1350000,updatedAt:1350000},short={...long,key:'short',startedAt:now-1000};
 try{
  await act(()=>root.render(createElement('div',null,createElement(Profiler,{id:'long-clock',onRender:()=>{commits++;}},createElement(TaskDuration,{timing:long})),createElement(TaskDuration,{timing:short}))));assert.equal(timers.size,1);const element=host.querySelector('time')!,title=element.title,dateTime=element.dateTime,baseline=commits;assert.equal(element.textContent,'10m');assert.ok(title.includes(`Started ${exactTime(long.startedAt)}`));
  for(let i=0;i<9;i++){now+=1000;await act(()=>{for(const callback of timers.values())callback();});}
  assert.equal(commits,baseline,'Unchanged whole-minute label produces no React commits, even while shared clock/short sibling tick');assert.equal(element.title,title);assert.equal(element.dateTime,dateTime);assert.match(host.textContent!,/10.000s/);
  now+=1000;await act(()=>{for(const callback of timers.values())callback();});assert.equal(commits,baseline+1);assert.equal(element.textContent,'11m');assert.notEqual(element.dateTime,dateTime);
  const completedAt=long.startedAt+654321;await act(()=>root.render(createElement(TaskDuration,{timing:{...long,completedAt}})));assert.equal(timers.size,0);assert.equal(host.querySelector('time')!.dateTime,'PT654.321S');assert.ok(host.querySelector('time')!.title.includes('654321 ms'));assert.ok(host.querySelector('time')!.title.includes(`Started ${exactTime(long.startedAt)}`));assert.ok(host.querySelector('time')!.title.includes(`Completed ${exactTime(completedAt)}`));
  await act(()=>root.render(createElement(TaskDuration,{timing:{...long,startedAt:now-1000}})));assert.equal(host.querySelector('time')!.textContent,'1.000s','A new observed start resets the per-start cache');assert.equal(timers.size,1);
  await act(()=>root.render(createElement(TaskDuration)));assert.equal(timers.size,0);assert.equal(host.textContent,'—');
 }finally{await act(()=>root.unmount());assert.equal(timers.size,0);Date.now=original.now;globalThis.setInterval=original.set;globalThis.clearInterval=original.clear;await dom.happyDOM.close();}
});
