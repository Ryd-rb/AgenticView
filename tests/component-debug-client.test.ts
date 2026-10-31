import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {createDebugMeasurements,executeDebugCommand} from '../web/ComponentDebug.ts';

async function fixture(){
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','HTMLButtonElement','HTMLAnchorElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});
 Object.assign(globalThis,{innerWidth:1000,innerHeight:800,getComputedStyle:dom.getComputedStyle.bind(dom),requestAnimationFrame:(callback:FrameRequestCallback)=>setImmediate(()=>callback(performance.now())),cancelAnimationFrame:clearImmediate});
 Object.defineProperty(globalThis,'PerformanceObserver',{configurable:true,value:undefined});
 dom.HTMLElement.prototype.getBoundingClientRect=()=>new dom.DOMRect(10,10,200,100);
 document.body.innerHTML='<section data-debug-run="one" data-debug-component="chart" data-debug-kind="chart" data-origin="native" aria-label="Numeric chart"><button aria-label="Series A">Toggle</button><input aria-label="Draft"><input type="password" aria-label="Secret" value="never-export-me"></section><section data-debug-run="two" data-debug-component="chart" data-debug-kind="chart" data-origin="native"><button aria-label="Series A">Other</button></section>';
 const measurements=createDebugMeasurements();return {dom,measurements,run:(command:any)=>executeDebugCommand('one',command,()=>{},measurements),close:()=>{measurements.stop();return dom.happyDOM.close();}};
}
test('debug input stays within its card/component, acknowledges handler and frame timings, and exposes bounded inspection',async()=>{
 const f=await fixture();try{
  let clicked=0,other=0;document.querySelector('button')!.addEventListener('click',()=>clicked++);document.querySelectorAll('button')[1]!.addEventListener('click',()=>other++);
  const result=await f.run({operation:'click',componentId:'chart',target:{role:'button',name:'Series A'}}) as any;
  assert.equal(clicked,1);assert.equal(other,0);assert.equal(result.trusted,false);assert.equal(result.synthetic,true);assert.ok(result.dispatchToSecondFrameMs>=result.dispatchMs);
  await f.run({operation:'input',componentId:'chart',target:{role:'textbox',name:'Draft'},value:'local draft'});assert.equal((document.querySelector('[aria-label=Draft]') as HTMLInputElement).value,'local draft');
  const inspection=await f.run({operation:'inspect',includeText:true}) as any;assert.equal(inspection.components.length,1);assert.equal(inspection.components[0].id,'chart');assert.equal(JSON.stringify(inspection).includes('never-export-me'),false);
  await assert.rejects(f.run({operation:'input',componentId:'chart',target:{role:'textbox',name:'Secret'},value:'bad'}),/Sensitive/);
  await assert.rejects(f.run({operation:'click',componentId:'missing',target:{role:'button'}}),/not mounted/);
 }finally{await f.close();}
});
test('debugging excludes operational actions, submissions, custom frames, ambiguous and inactive controls',async()=>{
 const f=await fixture();try{
  const root=document.querySelector<HTMLElement>('[data-debug-run=one]')!;
  root.innerHTML='<form><input aria-label="Field"><button type="submit" aria-label="Send">Send</button></form>';
  root.dataset.debugKind='action-panel';let submits=0;root.addEventListener('submit',()=>submits++);
  await f.run({operation:'input',componentId:'chart',target:{role:'textbox',name:'Field'},value:'draft'});
  await assert.rejects(f.run({operation:'click',componentId:'chart',target:{role:'button',name:'Send'}}),/typed action/);assert.equal(submits,0);
  root.dataset.debugKind='chart';await assert.rejects(f.run({operation:'click',componentId:'chart',target:{role:'button',name:'Send'}}),/submissions/);
  root.innerHTML='<button>A</button><button>B</button>';await assert.rejects(f.run({operation:'click',componentId:'chart',target:{role:'button'}}),/ambiguous/);
  root.dataset.origin='custom';await assert.rejects(f.run({operation:'click',componentId:'chart',target:{role:'button',index:0}}),/native local/);
  root.dataset.origin='native';(root.querySelector('button') as HTMLButtonElement).disabled=true;await assert.rejects(f.run({operation:'click',componentId:'chart',target:{role:'button',index:0}}),/disabled/);
 }finally{await f.close();}
});


test('inspected references preserve identity and reject renamed, replaced and cross-card controls',async()=>{
 const f=await fixture();try{
  const inspect=async()=>(await f.run({operation:'inspect'} ) as any).components[0].targets;
  const entries=await inspect(),entry=entries.find((e:any)=>e.name==='Series A'),button=document.querySelector('button')!;
  assert.deepEqual(Object.keys(entry.target),['ref']);assert.ok(entry.actions.includes('click'));
  assert.deepEqual((await inspect()).find((e:any)=>e.name==='Series A').target,entry.target);
  assert.equal(entries.find((e:any)=>e.name==='Secret'),undefined);
  let clicks=0;button.addEventListener('click',()=>clicks++);await f.run({operation:'click',componentId:'chart',target:entry.target});assert.equal(clicks,1);
  button.setAttribute('aria-label','Renamed');await assert.rejects(f.run({operation:'click',componentId:'chart',target:entry.target}),/stale/);
  const fresh=(await inspect()).find((e:any)=>e.name==='Renamed');assert.notEqual(fresh.target.ref,entry.target.ref);
  const second=document.querySelector<HTMLElement>('[data-debug-run=two]')!;second.append(button);await assert.rejects(f.run({operation:'click',componentId:'chart',target:fresh.target}),/stale/);
  document.querySelector('[data-debug-run=one]')!.innerHTML='<button aria-label="Renamed">Replacement</button>';
  await assert.rejects(f.run({operation:'click',componentId:'chart',target:fresh.target}),/stale/);assert.equal(clicks,1);
 }finally{await f.close();}
});

test('native inspection exposes dropdown choices and safe bounded grid scrolling',async()=>{
 const f=await fixture();try{
  const root=document.querySelector<HTMLElement>('[data-debug-run=one]')!;root.dataset.debugKind='data-grid';
  root.innerHTML='<div class="control-grid" style="overflow-x:auto;overflow-y:auto"><table><tr><td>Observation</td></tr></table></div><button data-control="place">Place order</button>';
  const grid=root.querySelector<HTMLElement>('.control-grid')!;Object.defineProperties(grid,{scrollHeight:{value:900},clientHeight:{value:100}});let y=0;grid.scrollBy=options=>{y+=(options as ScrollToOptions).top??0;};
  const inspect=await f.run({operation:'inspect'}) as any,entries=inspect.components[0].targets;
  assert.ok(entries.find((e:any)=>e.target&&e.actions.includes('scroll')));assert.equal(entries.find((e:any)=>e.name==='Place order'),undefined);
  await f.run({operation:'scroll',componentId:'chart',target:entries.find((e:any)=>e.actions.includes('scroll')).target,x:0,y:200});assert.equal(y,200);
  root.dataset.debugKind='chart';root.innerHTML='<select aria-label="Interval"><option value="s">Seconds</option><option value="h" disabled>Hours</option></select>';
  const field=(await f.run({operation:'inspect'}) as any).components[0].targets[0];assert.ok(field.actions.includes('input'));assert.deepEqual(field.field.options,[{value:'s',label:'Seconds',disabled:false},{value:'h',label:'Hours',disabled:true}]);
 }finally{await f.close();}
});
test('viewport diagnostics retain ordered bounded frame gaps and report actual step count',async()=>{
 const f=await fixture();try{
  const calls:any[]=[];let zoom=.1;
  const result=await executeDebugCommand('one',{operation:'viewport',zoom:1,steps:3,intervalMs:8},(_id,_mode,view)=>{calls.push(view);if(view?.zoom)zoom=view.zoom;return {zoom,x:0,y:0};},f.measurements) as any;
  assert.equal(result.steps,3);assert.equal(result.stepFrameMs.length,3);assert.equal(result.firstStepMs,result.stepFrameMs[0]);assert.equal(result.lastStepMs,result.stepFrameMs.at(-1));assert.equal(result.stepFrameP99Ms,Math.max(...result.stepFrameMs));assert.equal(calls[0].phase,'begin');assert.equal(calls.at(-2).phase,'end');assert.equal(zoom,1);
 }finally{await f.close();}
});

test('camera profiling restart is opt-in and waits for the native started acknowledgement',async()=>{
 const f=await fixture();try{
  const listeners=new Set<(event:{data:any})=>void>();
  Object.defineProperty(window,'chrome',{configurable:true,value:{webview:{addEventListener:(_type:string,fn:any)=>listeners.add(fn),removeEventListener:(_type:string,fn:any)=>listeners.delete(fn),postMessage:(message:any)=>{setImmediate(()=>{for(const fn of [...listeners])fn({data:{type:'agenticview:debug-native-started',requestId:message.requestId}});for(const fn of [...listeners])fn({data:{type:'agenticview:debug-native-started',requestId:message.requestId}});for(const fn of [...listeners])fn({data:{type:'agenticview:debug-native-result',requestId:message.requestId,ok:true,result:{available:true}}});});}}}});
  for(const [requested,handled] of [[false,false],[true,false],[true,true]]){let profiles=0;const result=await executeDebugCommand('one',{operation:'viewport',zoom:1,steps:3,intervalMs:8,profileSeconds:1,...(requested?{profileRestartCamera:true}:{})},(_id,_mode,view)=>{if(view?.phase==='profile')profiles++;return {zoom:.5,x:0,y:0,...(handled?{profileRestarted:true}:{})};},f.measurements) as any;assert.equal(profiles,requested?1:0);assert.equal(result.profileRestartedCamera,requested&&handled);assert.equal(result.profileRestartRequested,requested);assert.equal(listeners.size,0);}
 }finally{await f.close();}
});

test('stopping a viewport during its timed wait cancels pending movement and releases the camera hold',async()=>{
 const f=await fixture(),controller=new AbortController(),calls:any[]=[];
 try{
  const pending=executeDebugCommand('one',{operation:'viewport',zoom:1,steps:120,intervalMs:100},(_id,_mode,view)=>{calls.push(view);return {zoom:.1,x:0,y:0};},f.measurements,controller.signal);
  setTimeout(()=>controller.abort(),10);await assert.rejects(pending,{name:'AbortError'});
  assert.deepEqual(calls.map(c=>c?.phase),['begin','end']);assert.equal(calls.some(c=>c?.zoom!==undefined),false);
 }finally{await f.close();}
});

test('metrics distinguish live provider receipts from paused/loading/fallback charts without exposing data',async()=>{
 const f=await fixture();try{
  const now=Date.now();for(const state of ['ready','paused','loading','error','fallback','unexpected']){const chart=document.createElement('div');chart.className='source-chart';chart.dataset.sourceState=state;chart.textContent='private series label';if(state==='ready'||state==='paused')chart.dataset.sourceReceivedAt=String(now-500);document.body.append(chart);}
  const result=f.measurements.snapshot().sourceCharts;assert.equal(result.total,6);assert.equal(result.received,2);assert.deepEqual(result.states,{ready:1,paused:1,loading:1,error:1,fallback:1,unknown:1});assert.ok(result.oldestReceiptAgeMs!>=500);assert.equal(JSON.stringify(result).includes('private series label'),false);
 }finally{await f.close();}
});

test('grid metrics count retained page rows separately from layout windows without exporting cell data',async()=>{
 const f=await fixture();try{
  for(const [retained,layout,ready] of [[100,15,true],[20,20,false],[-1,4,false]]){const table=document.createElement('table');table.dataset.tableWindowRetained=String(retained);table.dataset.tableWindowLayout=String(layout);table.dataset.tableWindowReady=String(ready);table.textContent='private cell value';document.body.append(table);}
  const m=f.measurements.snapshot().tableWindows;assert.equal(m.total,3);assert.equal(m.windowed,1);assert.equal(m.retainedRows,120);assert.equal(m.layoutRows,35);assert.equal(m.invalid,1);assert.equal(JSON.stringify(m).includes('private cell value'),false);
 }finally{await f.close();}
});

test('structure metrics group retained elements by known kind without exposing supplied DOM content',async()=>{
 const f=await fixture();try{
  const root=document.querySelector<HTMLElement>('[data-debug-run=one]')!;root.innerHTML='<svg><g><path/></g></svg><table><tbody><tr><td>private cell</td></tr></tbody></table><details><summary>Closed</summary><input value="private draft"></details>';
  const other=document.createElement('section');other.dataset.debugComponent='x';other.dataset.debugKind='private unknown label';other.textContent='private content';document.body.append(other);
  const m=f.measurements.snapshot().renderStructure;assert.equal(m.total,3);assert.equal(m.sampled,3);assert.equal(m.truncated,false);assert.equal(m.byKind.find(item=>item.kind==='chart')!.components,2);assert.equal(m.byKind.find(item=>item.kind==='chart')!.rows,1);assert.equal(m.byKind.find(item=>item.kind==='chart')!.svgElements,3);assert.equal(m.byKind.find(item=>item.kind==='other')!.components,1);assert.equal(JSON.stringify(m).includes('private'),false);
 }finally{await f.close();}
});

test('geometry details are card-scoped and exclude retained table values',async()=>{
 const f=await fixture();try{
  for(const root of document.querySelectorAll<HTMLElement>('[data-debug-run]')){root.innerHTML='<div class="control-grid"><table data-table-window-ready="true" data-table-window-retained="100" data-table-window-layout="10" data-table-window-columns="12" data-table-window-layout-columns="4"><colgroup><col style="width:80.25px"></colgroup><tbody><tr aria-rowindex="2"><td>private cell</td></tr><tr aria-rowindex="3" style="display:none"><td>private hidden cell</td></tr></tbody></table></div>';}
  const all=f.measurements.snapshot().tableWindows;assert.equal(all.details.length,0);assert.equal(all.retainedRows,200);
  const m=(await f.run({operation:'metrics'}) as any).tableWindows;assert.equal(m.details.length,1);assert.equal(m.details[0].componentId,'chart');assert.equal(m.details[0].retainedColumns,12);assert.equal(m.details[0].layoutColumns,4);assert.deepEqual(m.details[0].columnWidths,[80.25]);assert.equal(m.details[0].firstRow,'2');assert.equal(m.details[0].lastRow,'2');assert.equal(JSON.stringify(m).includes('private'),false);
 }finally{await f.close();}
});

test('inspection spends its target budget on safe visible controls after closed or denied content',async()=>{
 const f=await fixture();try{
  const root=document.querySelector<HTMLElement>('[data-debug-run=one]')!;root.innerHTML='';
  for(let i=0;i<120;i++){const button=document.createElement('button');button.textContent='Closed settings '+i;button.style.display='none';root.append(button);}
  const password=document.createElement('input');password.type='password';password.setAttribute('aria-label','Secret');root.append(password);
  const button=document.createElement('button');button.textContent='Reachable';root.append(button);
  const m=(await f.run({operation:'inspect'}) as any).components[0];assert.equal(m.targets.length,1);assert.equal(m.targets[0].name,'Reachable');assert.equal(m.targets[0].index,121);assert.ok(m.targets[0].actions.includes('click'));assert.equal(m.targets[0].visible,true);
  await f.run({operation:'click',componentId:'chart',target:m.targets[0].target});
 }finally{await f.close();}
});
