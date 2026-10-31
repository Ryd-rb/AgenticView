import test from 'node:test';
import assert from 'node:assert/strict';
import { act,createElement,useState } from 'react';
import { Window } from 'happy-dom';
import { createDebugMeasurements,executeDebugCommand } from '../web/ComponentDebug.ts';

async function fixture(){
  const dom=new Window();
  for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','HTMLButtonElement','HTMLAnchorElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,innerWidth:1000,innerHeight:800,getComputedStyle:dom.getComputedStyle.bind(dom),requestAnimationFrame:(callback:FrameRequestCallback)=>setImmediate(()=>callback(performance.now())),cancelAnimationFrame:clearImmediate});
  Object.defineProperty(globalThis,'PerformanceObserver',{configurable:true,value:undefined});
  dom.HTMLElement.prototype.getBoundingClientRect=()=>new dom.DOMRect(10,10,200,100);
  const previous=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw new Error('No operational requests are permitted in this safety fixture');};
  const measurements=createDebugMeasurements();
  return {dom,requests:()=>requests,run:(command:any)=>executeDebugCommand('own',command,()=>{},measurements),close:async()=>{measurements.stop();globalThis.fetch=previous;await dom.happyDOM.close();}};
}

test('configurable grid labels never authorize operational data-control buttons',async()=>{
  const f=await fixture();
  try{
    document.body.innerHTML='<section data-debug-run="own" data-debug-component="grid" data-debug-kind="data-grid" data-origin="native"></section>';
    const root=document.querySelector('section')!;let operational=0;
    // These are the same structural markers emitted by ControlViews.NativeButton.
    // Presentation labels can be changed independently by configuration.controls.
    for(const control of ['delete','edit','save','add','bulk','evaluate','history']){
      const button=document.createElement('button');button.type='button';button.dataset.control=control;button.setAttribute('aria-label',`Filter rows ${control}`);button.addEventListener('click',()=>operational++);root.append(button);
      await assert.rejects(f.run({operation:'click',componentId:'grid',target:{role:'button',name:`Filter rows ${control}`}}),/Operational|excluded|typed action/i);
    }
    assert.equal(operational,0,'A label matching the safe prefix cannot dispatch a configured operation');assert.equal(f.requests(),0);
  }finally{await f.close();}
});

test('debugging local React form drafts preserves controlled state without submitting or crossing component/card scope',async()=>{
  const f=await fixture(),{createRoot}=await import('react-dom/client');
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let submissions=0,nestedClicks=0,otherClicks=0;
  function Draft(){const [value,setValue]=useState('initial');return createElement('section',{'data-debug-run':'own','data-debug-component':'form','data-debug-kind':'action-panel','data-origin':'native'},
    createElement('form',{onSubmit:(event:any)=>{event.preventDefault();submissions++;}},createElement('input',{'aria-label':'Local draft',value,onChange:(event:any)=>setValue(event.target.value)}),createElement('output',null,value),createElement('button',{type:'submit','data-control':'submit','aria-label':'Filter rows submit'},'Submit')),
    createElement('section',{'data-debug-run':'own','data-debug-component':'nested','data-debug-kind':'chart','data-origin':'native'},createElement('button',{'aria-label':'Nested control',onClick:()=>nestedClicks++},'Nested')),
    createElement('section',{'data-debug-run':'other','data-debug-component':'other','data-debug-kind':'chart','data-origin':'native'},createElement('button',{'aria-label':'Other control',onClick:()=>otherClicks++},'Other')));
  }
  try{
    await act(async()=>{root.render(createElement(Draft));});
    await act(async()=>{await f.run({operation:'input',componentId:'form',target:{role:'textbox',name:'Local draft'},value:'retained synthetic draft'});});
    assert.equal(host.querySelector('output')!.textContent,'retained synthetic draft','Native setter plus synthetic input updates actual React controlled state');
    await assert.rejects(f.run({operation:'click',componentId:'form',target:{role:'button',name:'Filter rows submit'}}),/typed action|excluded|draft/i);
    await assert.rejects(f.run({operation:'key',componentId:'form',target:{role:'textbox',name:'Local draft'},key:'Enter'}),/typed action|excluded|draft/i);
    await assert.rejects(f.run({operation:'click',componentId:'form',target:{role:'button',name:'Nested control'}}),/unavailable/);
    await assert.rejects(f.run({operation:'click',componentId:'other',target:{role:'button',name:'Other control'}}),/not mounted/);
    assert.equal(submissions,0);assert.equal(nestedClicks,0);assert.equal(otherClicks,0);assert.equal(f.requests(),0);
  }finally{await act(async()=>root.unmount());await f.close();}
});
