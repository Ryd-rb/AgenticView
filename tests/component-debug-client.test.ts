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

