import test from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement,useEffect,useRef} from 'react';
import {Window} from 'happy-dom';
import {useNativeTableHeader} from '../web/NativeTableHeader.tsx';
import {RenderBoundary} from '../web/RenderActivity.tsx';

async function fixture(){
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','HTMLInputElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 const prior={raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame,ro:globalThis.ResizeObserver};
 const frames=new Map<number,FrameRequestCallback>(),observers=new Set<RO>(),scrollListeners=new Set<unknown>(),fontListeners=new Set<()=>void>();let frame=0,mounts=0,unmounts=0,measurements=0,animationCalls=0,valid=true,tableHeight=500,tableTop=30.25,scale=.25;
 class RO{targets=new Set<Element>();constructor(readonly callback:ResizeObserverCallback){observers.add(this);}observe(element:Element){this.targets.add(element);}unobserve(element:Element){this.targets.delete(element);}disconnect(){this.targets.clear();observers.delete(this);}}
 Object.assign(globalThis,{ResizeObserver:RO,requestAnimationFrame:(callback:FrameRequestCallback)=>{frames.set(++frame,callback);return frame;},cancelAnimationFrame:(id:number)=>frames.delete(id)});
 Object.defineProperty(document,'fonts',{configurable:true,value:{addEventListener:(_type:string,callback:()=>void)=>fontListeners.add(callback),removeEventListener:(_type:string,callback:()=>void)=>fontListeners.delete(callback)}});
 const add=dom.HTMLElement.prototype.addEventListener,remove=dom.HTMLElement.prototype.removeEventListener;
 dom.HTMLElement.prototype.addEventListener=function(type:any,listener:any,options:any){if(this.id==='viewport'&&type==='scroll')scrollListeners.add(listener);return add.call(this,type,listener,options);};
 dom.HTMLElement.prototype.removeEventListener=function(type:any,listener:any){if(this.id==='viewport'&&type==='scroll')scrollListeners.delete(listener);return remove.call(this,type,listener);};
 dom.HTMLElement.prototype.animate=(()=>{animationCalls++;throw Error('No clock animation allowed');}) as any;
 Object.defineProperty(dom.HTMLElement.prototype,'clientHeight',{configurable:true,get(){return this.id==='viewport'?120:0;}});
 Object.defineProperty(dom.HTMLElement.prototype,'scrollHeight',{configurable:true,get(){return this.id==='viewport'?tableHeight+tableTop:0;}});
 dom.HTMLElement.prototype.getBoundingClientRect=function(){
  const element=this as unknown as HTMLElement,viewport=document.getElementById('viewport')!,scroll=viewport?.scrollTop??0;let top=20,width=800,height=120;
  if(element.tagName==='TABLE'){measurements++;top+=(tableTop-scroll)*scale;height=tableHeight;}
  else if(element.tagName==='THEAD'){const translated=Number.parseFloat(element.style.transform.replace('translateY(',''))||0;top+=(tableTop-scroll+translated)*scale;height=20.5;}
  return new dom.DOMRect(10,top,width*scale,height*scale);
 };
 const computed=dom.getComputedStyle.bind(dom);
 dom.getComputedStyle=((element:Element)=>{const style=computed(element as any);if(element.tagName==='TABLE')return new Proxy(style,{get(target,key){if(key==='width')return valid?'800px':'auto';if(key==='height')return `${tableHeight}px`;if(key==='boxSizing')return 'border-box';if(key==='borderCollapse')return 'separate';if(key==='borderSpacing')return '0px';return Reflect.get(target,key);}});if(element.id==='viewport')return new Proxy(style,{get(target,key){return key==='borderTopWidth'?'0px':Reflect.get(target,key);}});return style;}) as unknown as typeof dom.getComputedStyle;
 const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);let latest:ReturnType<typeof useNativeTableHeader>;
 function Cell({index}:{index:number}){useEffect(()=>{mounts++;return()=>{unmounts++;};},[]);return createElement('td',null,createElement('input',{defaultValue:`draft-${index}`}));}
 function Table(){const viewport=useRef<HTMLDivElement>(null),table=useRef<HTMLTableElement>(null),header=useNativeTableHeader(viewport,table);latest=header;return createElement('div',{ref:viewport,id:'viewport'},createElement('table',{ref:table,'data-native-table-header':header.marker},createElement('thead',{style:header.style},createElement('tr',null,createElement('th',null,'Label'))),createElement('tbody',null,...Array.from({length:10},(_,index)=>createElement('tr',{key:index},createElement(Cell,{index}))))));}
 const render=async(updates=true,visible=true)=>act(async()=>root.render(createElement(RenderBoundary,{visible,updates,children:()=>createElement(Table)})));
 const flush=async()=>act(async()=>{const queued=[...frames.values()];frames.clear();for(const callback of queued)callback(0);});
 const scroll=async(value:number,flushNow=true)=>{await act(async()=>{const viewport=host.querySelector<HTMLElement>('#viewport')!;viewport.scrollTop=value;viewport.dispatchEvent(new Event('scroll'));});if(flushNow)await flush();};
 const resize=async()=>{await act(async()=>{for(const observer of observers)observer.callback([...observer.targets].map(target=>({target,contentRect:{width:800,height:target.tagName==='THEAD'?20.5:target.id==='viewport'?120:tableHeight}})) as unknown as ResizeObserverEntry[],observer as unknown as ResizeObserver);});await flush();};
 await render();
 return{host,render,flush,scroll,resize,frames,observers,scrollListeners,fontListeners,get latest(){return latest!;},get mounts(){return mounts;},get unmounts(){return unmounts;},get measurements(){return measurements;},get animationCalls(){return animationCalls;},setValid(value:boolean){valid=value;},setHeight(value:number){tableHeight=value;},setScale(value:number){scale=value;},font:async()=>{await act(async()=>{for(const listener of fontListeners)listener();});await flush();},close:async()=>{await act(async()=>root.unmount());assert.equal(frames.size,0);assert.equal(observers.size,0);assert.equal(scrollListeners.size,0);assert.equal(fontListeners.size,0);Object.assign(globalThis,{requestAnimationFrame:prior.raf,cancelAnimationFrame:prior.caf,ResizeObserver:prior.ro});await dom.happyDOM.close();}};
}

test('translated header preserves normal geometry and keyed cells at fractional scale through top/mid/bottom/reversal',async()=>{
 const f=await fixture();try{
  const table=f.host.querySelector('table')!,head=f.host.querySelector('thead')!,viewport=f.host.querySelector<HTMLElement>('#viewport')!,cells=[...f.host.querySelectorAll('td')],input=f.host.querySelector<HTMLInputElement>('input')!;input.value='local draft';
  assert.equal(f.latest.supported,true);assert.equal(table.getAttribute('data-native-table-header'),'translated');assert.equal(head.style.transform,'');assert.equal(head.style.zIndex,'');assert.equal(head.style.position,'');assert.equal(viewport.scrollHeight,530.25);
  await f.scroll(20);assert.equal(f.latest.offset,0);
  const measures=f.measurements;await f.scroll(50,false);await f.scroll(70,false);await f.scroll(100,false);assert.equal(f.frames.size,1);await f.flush();
  assert.equal(f.latest.offset,69.75);assert.equal(head.style.transform,'translateY(69.75px)');assert.equal(head.style.zIndex,'2');assert.equal(f.measurements,measures,'Ordinary scrolling reuses calibrated geometry');assert.equal(head.getBoundingClientRect().top,viewport.getBoundingClientRect().top);
  await f.scroll(10000);assert.equal(f.latest.offset,479.5);assert.equal(head.getBoundingClientRect().bottom,table.getBoundingClientRect().bottom,'Header cannot overflow table bottom');
  await f.scroll(50);assert.equal(f.latest.offset,19.75);await f.scroll(0);assert.equal(head.style.transform,'');assert.equal(head.style.zIndex,'');assert.equal(viewport.scrollHeight,530.25);assert.deepEqual([...f.host.querySelectorAll('td')],cells);assert.equal(input.value,'local draft');assert.equal(f.mounts,10);assert.equal(f.unmounts,0);assert.equal(f.animationCalls,0);assert.equal(f.frames.size,0);
 }finally{await f.close();}assert.equal(f.unmounts,10);
});

test('frozen/offscreen headers detach activity, resume current scroll, coalesce resize/fonts and fail open to CSS sticky',async()=>{
 const f=await fixture();try{
  await f.scroll(100);const head=f.host.querySelector('thead')!,table=f.host.querySelector('table')!,input=f.host.querySelector('input');
  await f.render(false);assert.equal(f.observers.size,0);assert.equal(f.scrollListeners.size,0);assert.equal(f.fontListeners.size,0);await f.scroll(200);assert.equal(f.latest.offset,69.75);assert.equal(f.frames.size,0);
  await f.render(true);assert.equal(f.latest.offset,169.75);assert.equal(f.scrollListeners.size,1);
  await f.resize();const measures=f.measurements;await f.resize();assert.equal(f.measurements,measures,'Identical resize reports do not create a layout loop');assert.equal(f.frames.size,0);
  f.setHeight(800);await f.resize();await f.scroll(10000);assert.equal(f.latest.offset,779.5);f.setScale(.125);await f.font();assert.equal(f.latest.offset,779.5,'Recalibration subtracts its own existing translation');
  f.setValid(false);await f.font();assert.equal(f.latest.supported,false);assert.equal(table.getAttribute('data-native-table-header'),null);assert.equal(head.style.transform,'');assert.equal(head.style.zIndex,'');
  f.setValid(true);await f.font();assert.equal(f.latest.supported,true);await f.render(true,false);assert.equal(f.scrollListeners.size,0);await f.scroll(0);await f.render(true,true);assert.equal(f.latest.offset,0);assert.equal(f.host.querySelector('input'),input);assert.equal(f.mounts,10);
  await f.scroll(150,false);assert.equal(f.frames.size,1);
 }finally{await f.close();}
});
