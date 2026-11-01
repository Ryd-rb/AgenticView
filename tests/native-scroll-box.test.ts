import test from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement,createRef,useEffect,useState} from 'react';
import {Window} from 'happy-dom';
import {NativeScrollBox} from '../web/NativeScrollBox.tsx';
import {CardInteraction} from '../web/CardInteraction.ts';
import {RenderBoundary} from '../web/RenderActivity.tsx';

async function fixture(){
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','KeyboardEvent','PointerEvent','HTMLInputElement','DOMException'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 const previous={raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame,ro:globalThis.ResizeObserver};let frame=0,mounts=0,unmounts=0,width=500,height=400,reads=0,animations=0,parentInputs=0;
 const frames=new Map<number,FrameRequestCallback>(),observers=new Set<RO>(),fonts=new Set<()=>void>(),captures=new Map<Element,number>();
 class RO{targets=new Set<Element>();constructor(readonly callback:ResizeObserverCallback){observers.add(this);}observe(element:Element){this.targets.add(element);}unobserve(element:Element){this.targets.delete(element);}disconnect(){this.targets.clear();observers.delete(this);}}
 Object.assign(globalThis,{ResizeObserver:RO,requestAnimationFrame:(callback:FrameRequestCallback)=>{frames.set(++frame,callback);return frame;},cancelAnimationFrame:(id:number)=>frames.delete(id)});
 Object.defineProperty(document,'fonts',{configurable:true,value:{addEventListener:(_type:string,fn:()=>void)=>fonts.add(fn),removeEventListener:(_type:string,fn:()=>void)=>fonts.delete(fn)}});
 for(const key of ['scrollWidth','scrollHeight','clientWidth','clientHeight'] as const)Object.defineProperty(dom.HTMLElement.prototype,key,{configurable:true,get(){if(this.id!=='viewport')return 0;if(key==='scrollWidth')reads++;return key==='scrollWidth'?width:key==='scrollHeight'?height:key==='clientWidth'?100:80;}});
 for(const [key,value] of Object.entries({offsetLeft:9,offsetTop:5,offsetWidth:114,offsetHeight:92}))Object.defineProperty(dom.HTMLElement.prototype,key,{configurable:true,get(){return this.id==='viewport'?value:0;}});
 dom.HTMLElement.prototype.getBoundingClientRect=function(){return this.getAttribute('data-native-scrollbar')==='x'?new dom.DOMRect(10,20,25,3):new dom.DOMRect(10,20,3,20);};
 dom.HTMLElement.prototype.setPointerCapture=function(pointer:number){captures.set(this as unknown as Element,pointer);};dom.HTMLElement.prototype.hasPointerCapture=function(pointer:number){return captures.get(this as unknown as Element)===pointer;};dom.HTMLElement.prototype.releasePointerCapture=function(pointer:number){if(captures.get(this as unknown as Element)===pointer)captures.delete(this as unknown as Element);};
 dom.HTMLElement.prototype.animate=(()=>{animations++;throw Error('No elapsed animation');}) as any;
 const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host),ref=createRef<HTMLDivElement>();
 function Content({index}:{index:number}){const [value,setValue]=useState(`draft-${index}`);useEffect(()=>{mounts++;return()=>{unmounts++;};},[]);return createElement('section',null,createElement('input',{'aria-label':`field-${index}`,value,onInput:(event:any)=>setValue(event.target.value)}));}
 const render=async(manual=true,updates=true,visible=true)=>act(async()=>root.render(createElement(CardInteraction.Provider,{value:manual},createElement(RenderBoundary,{visible,updates,children:()=>createElement('div',{onPointerDown:()=>{parentInputs++;},onKeyDown:()=>{parentInputs++;}},createElement(NativeScrollBox,{ref,id:'viewport',className:'ordinary-scroll-view',title:'Authored title',style:{width:100,height:80,marginTop:3,maxHeight:90},'data-authored':'kept'},...Array.from({length:40},(_,index)=>createElement(Content,{key:index,index}))))}))));
 const flush=async()=>act(async()=>{const batch=[...frames.values()];frames.clear();for(const fn of batch)fn(0);});
 const rail=(axis:'x'|'y')=>host.querySelector<HTMLButtonElement>(`[data-native-scrollbar="${axis}"]`)!;
 const key=async(axis:'x'|'y',value:string,shift=false,flushNow=true)=>{await act(async()=>rail(axis).dispatchEvent(new KeyboardEvent('keydown',{key:value,shiftKey:shift,bubbles:true,cancelable:true})));if(flushNow)await flush();};
 const pointer=async(target:Element,type:string,x:number,y:number,pointerId=1)=>act(async()=>{target.dispatchEvent(new PointerEvent(type,{pointerId,button:0,clientX:x,clientY:y,bubbles:true,cancelable:true}));});
 const resize=async()=>{await act(async()=>{for(const observer of observers)observer.callback([] as ResizeObserverEntry[],observer as unknown as ResizeObserver);});await flush();};
 await render();
 return{host,dom,ref,render,flush,rail,key,pointer,resize,frames,observers,fonts,captures,get reads(){return reads;},get mounts(){return mounts;},get unmounts(){return unmounts;},get animations(){return animations;},get parentInputs(){return parentInputs;},dimensions(w:number,h:number){width=w;height=h;},close:async()=>{await act(async()=>root.unmount());assert.equal(ref.current,null);assert.equal(frames.size,0);assert.equal(observers.size,0);assert.equal(fonts.size,0);assert.equal(captures.size,0);Object.assign(globalThis,{requestAnimationFrame:previous.raf,cancelAnimationFrame:previous.caf,ResizeObserver:previous.ro});await dom.happyDOM.close();}};
}

test('real inner ref and authored body stay intact; sibling rails cannot expand source extents and keyboard clamps both axes',async()=>{
 const f=await fixture();try{
  const viewport=f.ref.current!,sections=[...viewport.children],input=viewport.querySelector<HTMLInputElement>('input')!;
  assert.equal(viewport.id,'viewport');assert.equal(viewport.getAttribute('role'),'region');assert.equal(viewport.getAttribute('aria-label'),'Scrollable content');assert.equal(viewport.className,'ordinary-scroll-view');assert.equal(viewport.title,'Authored title');assert.equal(viewport.style.marginTop,'3px');assert.equal(viewport.style.overflowY,'hidden');assert.equal(viewport.getAttribute('data-native-scrollport'),'true');assert.equal(viewport.querySelector('[role="scrollbar"]'),null);assert.equal(f.host.querySelectorAll('[role="scrollbar"]').length,2);assert.equal(viewport.scrollWidth,500);assert.equal(viewport.scrollHeight,400);assert.equal(f.rail('x').getAttribute('aria-controls'),'viewport');assert.equal(f.rail('x').style.left,'9px');assert.equal(f.rail('x').style.top,'85px');assert.equal(f.rail('x').style.width,'102px');assert.equal(f.rail('y').style.left,'111px');assert.equal(f.rail('y').style.top,'5px');assert.equal(f.rail('y').style.height,'80px');
  assert.equal([...f.observers][0]!.targets.size,34,'Viewport and frame plus at most32direct children observed');
  await act(async()=>{input.value='retained draft';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await f.key('y','ArrowDown',false,false);await f.key('y','ArrowDown',false,false);await f.key('y','ArrowDown',false,false);assert.equal(viewport.scrollTop,120,'Coalesced keys consume current native offset');assert.equal(f.frames.size,1);await f.flush();
  await f.key('y','End');assert.equal(viewport.scrollTop,320);await f.key('y','ArrowDown');assert.equal(viewport.scrollTop,320);await f.key('y','Home');await f.key('y',' ');assert.equal(viewport.scrollTop,72);await f.key('y',' ',true);assert.equal(viewport.scrollTop,0);
  await f.key('x','End');assert.equal(viewport.scrollLeft,400);await f.key('x','ArrowLeft');assert.equal(viewport.scrollLeft,360);await f.key('x','Home');assert.equal(viewport.scrollLeft,0);assert.equal(f.parentInputs,0);
  await f.render(false);const rail=f.rail('y');assert.equal(rail.tabIndex,-1);assert.equal(rail.disabled,false);assert.equal(rail.getAttribute('aria-disabled'),'true');await f.key('y','End');assert.equal(viewport.scrollTop,0);await f.render(true);assert.equal(f.ref.current,viewport);assert.deepEqual([...viewport.children],sections);assert.equal(input.value,'retained draft');assert.equal(f.mounts,40);assert.equal(f.unmounts,0);assert.equal(f.animations,0);
 }finally{await f.close();}assert.equal(f.unmounts,40);
});

test('fractional world-scale pointer mapping, pause/resume, overflow changes and lifecycle remain finite',async()=>{
 const f=await fixture();try{
  const viewport=f.ref.current!,body=viewport.firstElementChild;
  await f.pointer(f.rail('x'),'pointerdown',22.5,21);await f.flush();assert.equal(viewport.scrollLeft,200);assert.equal(f.captures.size,1);await f.pointer(f.rail('x'),'pointermove',100,21);await f.flush();assert.equal(viewport.scrollLeft,400);await f.pointer(f.rail('x'),'pointerup',100,21);assert.equal(f.captures.size,0);
  await f.key('y','End');const thumb=f.rail('y').querySelector('span')!;await f.pointer(thumb,'pointerdown',11,37.5);await f.flush();assert.equal(viewport.scrollTop,320,'Grabbing thumb preserves its original logical position');await f.pointer(f.rail('y'),'pointermove',11,30);await f.flush();assert.equal(viewport.scrollTop,160);assert.equal(f.parentInputs,0);
  await f.render(true,false);assert.equal(f.observers.size,0);assert.equal(f.fonts.size,0);assert.equal(f.captures.size,0);const reads=f.reads;
  await act(async()=>{viewport.scrollTop=240;viewport.dispatchEvent(new Event('scroll'));});assert.equal(f.frames.size,0);assert.equal(f.reads,reads);assert.equal(f.rail('y').getAttribute('aria-valuenow'),'160');await f.render(true,true);assert.equal(f.rail('y').getAttribute('aria-valuenow'),'240');
  await f.render(true,true,false);await act(async()=>{viewport.scrollLeft=40;viewport.dispatchEvent(new Event('scroll'));});assert.equal(f.frames.size,0);await f.render(true,true,true);assert.equal(f.rail('x').getAttribute('aria-valuenow'),'40');
  f.dimensions(100,80);await f.resize();assert.equal(f.host.querySelector('[role="scrollbar"]'),null);assert.equal(f.ref.current,viewport);assert.equal(viewport.firstElementChild,body);f.dimensions(500,400);await f.resize();assert.equal(f.host.querySelectorAll('[role="scrollbar"]').length,2);assert.equal(f.frames.size,0);
  await f.pointer(f.rail('y'),'pointerdown',11,30);await f.render(false);assert.equal(f.captures.size,0);await act(async()=>viewport.dispatchEvent(new Event('scroll')));assert.equal(f.frames.size,1);
 }finally{await f.close();}
});
