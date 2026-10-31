import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act,createElement } from 'react';
import { Window } from 'happy-dom';
import { ComponentView } from '../web/Components.tsx';
import { componentSchema } from '../shared/protocol.ts';
import type { Presentation } from '../shared/component-config.ts';

const entries=Array.from({length:100},(_,index)=>({level:'info',message:`row-${index}`}));
async function fixture(kind:'logs'|'log-stream'){
  const dom=new Window();
  for(const key of ['window','document','HTMLElement','Element','Node','Event'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  const previous={fetch:globalThis.fetch,io:globalThis.IntersectionObserver};
  Object.assign(globalThis,{IntersectionObserver:undefined});
  globalThis.fetch=async(_url,init)=>new Response(JSON.stringify(init?.method==='POST'?{id:'read-1',actionId:'tail',state:'succeeded',createdAt:1,result:{entries}}:{version:'v1',actions:[{id:'tail',label:'Tail',kind:'logs'}]}),{headers:{'Content-Type':'application/json'}});
  for(const path of ['web/control-views.css','web/component-config.css','web/component-presentation.css']){
    const style=document.createElement('style');style.textContent=readFileSync(path,'utf8');document.head.append(style);
  }
  const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
  return {host,render:async(presentation:Presentation)=>act(async()=>{
    const component=componentSchema.parse({id:'logs',title:'Synthetic logs',kind,data:kind==='logs'?{entries}:{actionId:'tail',pollMs:60000,maxRows:100},configuration:{presentation}});
    root.render(createElement(ComponentView,{component,embeds:false,runId:'synthetic'}));
    await settle();await settle();
  }),scroll:async(view:HTMLElement,top:number)=>act(async()=>{view.scrollTop=top;view.dispatchEvent(new Event('scroll',{bubbles:true}));await settle();}),close:async()=>{
    await act(async()=>{root.unmount();await settle();});globalThis.fetch=previous.fetch;Object.assign(globalThis,{IntersectionObserver:previous.io});await dom.happyDOM.close();
  }};
}

for(const kind of ['logs','log-stream'] as const)test(`${kind} typography keeps actual line boxes and virtual offsets in one row metric`,async()=>{
  const f=await fixture(kind),live=kind==='log-stream',defaultFont=live?12:9,inset=live?8:2;
  const cases:{presentation:Presentation;height:number;line?:number}[]=[
    {presentation:{},height:30},
    {presentation:{rowHeight:48},height:48},
    {presentation:{lineHeight:2.5},height:Math.max(30,Math.ceil(defaultFont*2.5)+inset),line:defaultFont*2.5},
    {presentation:{fontSize:32},height:Math.ceil(32*1.3)+inset,line:32*1.3},
    {presentation:{fontSize:32,lineHeight:2.5,rowHeight:28},height:80+inset,line:80},
  ];
  try{for(const {presentation,height,line} of cases){
    await f.render(presentation);
    const view=f.host.querySelector<HTMLElement>(live?'.control-log':'.logs')!;assert.ok(view);
    await f.scroll(view,0);
    const row=view.querySelector<HTMLElement>(live?'.control-log-row':'.log-row')!;assert.ok(row,'Actual renderer consumed supplied entries');
    assert.equal(row.style.height,`${height}px`);
    assert.equal(row.style.lineHeight,line===undefined?'':`${line}px`);
    if(presentation.fontSize!==undefined)assert.equal(row.style.fontSize,'32px');
    if(line!==undefined){
      assert.equal(window.getComputedStyle(row).lineHeight,`${line}px`);
      const child=row.querySelector('span')!;
      assert.equal(child.style.lineHeight,`${line}px`,'Text explicitly consumes its virtual row line box');
      assert.equal(window.getComputedStyle(child).lineHeight,`${line}px`,'Child text shares the row line box instead of fixed shorthand metrics');
      assert.ok(height>=Math.ceil(line)+inset,'Row includes the full line box and vertical inset');
    }
    const spacer=view.firstElementChild as HTMLElement,positioner=spacer.firstElementChild as HTMLElement;
    assert.equal(spacer.style.height,`${entries.length*height}px`);
    assert.equal(view.querySelectorAll(live?'.control-log-row':'.log-row').length,16,'Virtualized rows remain bounded');
    await f.scroll(view,height*10);
    assert.equal(positioner.style.top,`${height*7}px`,'Virtual start and offset use the same derived row height');
    assert.match(positioner.firstElementChild!.textContent!,/row-7$/);
  }}finally{await f.close();}
});
