import test from 'node:test';
import assert from 'node:assert/strict';
import { act,createElement,useContext,useEffect,useState,type ReactNode } from 'react';
import { Window } from 'happy-dom';
import { RenderBoundary,useRenderActivity } from '../web/RenderActivity.tsx';
import { CardInteraction } from '../web/CardInteraction.ts';
import { SourceChart } from '../web/SourceChart.tsx';
import { chartDataSchema } from '../shared/native-extensions.ts';
import { WindowControls } from '../web/WindowControls.tsx';

type Request={url:string;body?:any;signal:AbortSignal;resolve:(response:Response)=>void};
async function fixture(){
  const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','CustomEvent','HTMLInputElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  let hidden=false,timer=90000;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
  const previous={fetch:globalThis.fetch,set:globalThis.setTimeout,clear:globalThis.clearTimeout,io:globalThis.IntersectionObserver,ro:globalThis.ResizeObserver};
  const observers=new Set<ControlledIO>(),resizers=new Set<ControlledRO>(),timers=new Map<number,()=>void>(),requests:Request[]=[],messages=new Set<(event:{data:unknown})=>void>();
  const documentListeners=new Set<unknown>(),nativeListeners=new Set<unknown>();
  const documentAdd=document.addEventListener.bind(document),documentRemove=document.removeEventListener.bind(document),windowAdd=window.addEventListener.bind(window),windowRemove=window.removeEventListener.bind(window);
  document.addEventListener=((type:string,listener:any,options?:any)=>{if(type==='visibilitychange')documentListeners.add(listener);documentAdd(type,listener,options);}) as typeof document.addEventListener;
  document.removeEventListener=((type:string,listener:any,options?:any)=>{if(type==='visibilitychange')documentListeners.delete(listener);documentRemove(type,listener,options);}) as typeof document.removeEventListener;
  window.addEventListener=((type:string,listener:any,options?:any)=>{if(type==='agenticview:native-visibility')nativeListeners.add(listener);windowAdd(type,listener,options);}) as typeof window.addEventListener;
  window.removeEventListener=((type:string,listener:any,options?:any)=>{if(type==='agenticview:native-visibility')nativeListeners.delete(listener);windowRemove(type,listener,options);}) as typeof window.removeEventListener;
  class ControlledIO{targets=new Set<Element>();disconnected=false;constructor(readonly callback:IntersectionObserverCallback){observers.add(this);}observe(target:Element){this.targets.add(target);}unobserve(target:Element){this.targets.delete(target);}disconnect(){this.targets.clear();this.disconnected=true;}}
  class ControlledRO{disconnected=false;constructor(_callback:ResizeObserverCallback){resizers.add(this);}observe(){}unobserve(){}disconnect(){this.disconnected=true;}}
  Object.assign(globalThis,{IntersectionObserver:ControlledIO,ResizeObserver:ControlledRO});
  Object.assign(dom,{agenticViewDesktop:{version:1},chrome:{webview:{postMessage:()=>{},addEventListener:(_type:string,callback:(event:{data:unknown})=>void)=>messages.add(callback),removeEventListener:(_type:string,callback:(event:{data:unknown})=>void)=>messages.delete(callback)}}});
  globalThis.setTimeout=((callback:()=>void,delay?:number,...args:unknown[])=>{if([250,750,1500,15000].includes(delay??0)){timers.set(++timer,callback);return timer;}return previous.set(callback,delay,...args);}) as typeof setTimeout;
  globalThis.clearTimeout=((id:number)=>{if(!timers.delete(id))previous.clear(id);}) as typeof clearTimeout;
  globalThis.fetch=async(url,init)=>new Promise<Response>((resolve,reject)=>{const signal=init!.signal as AbortSignal;requests.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):undefined,signal,resolve});signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
  const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host),settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
  const render=async(body:()=>ReactNode,manual=false,visible?:boolean)=>act(async()=>{root.render(createElement(CardInteraction.Provider,{value:manual},createElement(WindowControls),createElement(RenderBoundary,{id:'subject',children:body,...(visible===undefined?{}:{visible})})));await settle();});
  const intersect=async(ratio:number,isIntersecting=ratio>0)=>act(async()=>{const target=host.querySelector('[data-render-id="subject"]')!;for(const observer of observers)if(observer.targets.has(target))observer.callback([{target,isIntersecting,intersectionRatio:ratio} as IntersectionObserverEntry],observer as unknown as IntersectionObserver);await settle();});
  const respond=async(index:number,body:unknown)=>act(async()=>{assert.ok(requests[index]);requests[index]!.resolve(new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}}));await settle();});
  const native=async(state:string)=>act(async()=>{for(const callback of messages)callback({data:{type:'agenticview:window-state',state}});await settle();});
  const visibility=async(value:boolean)=>act(async()=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));await settle();});
  return {host,dom,requests,timers,observers,resizers,messages,documentListeners,nativeListeners,render,intersect,respond,native,visibility,close:async()=>{await act(async()=>{root.unmount();await settle();});assert.equal(documentListeners.size,0);assert.equal(nativeListeners.size,0);assert.equal(messages.size,0);assert.ok([...observers].every(observer=>observer.disconnected));assert.ok([...resizers].every(observer=>observer.disconnected));assert.equal(timers.size,0);globalThis.fetch=previous.fetch;globalThis.setTimeout=previous.set;globalThis.clearTimeout=previous.clear;Object.assign(globalThis,{IntersectionObserver:previous.io,ResizeObserver:previous.ro});await dom.happyDOM.close();}};
}

test('hidden boundaries defer heavy bodies, retain draft/DOM identity and consume only the latest source on reentry',async()=>{
  const f=await fixture(),commits:string[]=[];let heavyCalls=0;
  function Activity(){return createElement('output',{'data-active':String(useRenderActivity())});}
  function Heavy({source}:{source:string}){heavyCalls++;const [draft,setDraft]=useState('initial draft'),manual=useContext(CardInteraction);useEffect(()=>{commits.push(source);},[source]);return createElement('section',null,createElement('strong',{'data-source':source},source),createElement('input',{'aria-label':'Retained draft',value:draft,onChange:(event:any)=>setDraft(event.target.value)}),createElement('button',{disabled:!manual},'Manual action'),createElement(Activity));}
  const body=(source:string)=>()=>createElement(Heavy,{source});
  try{
    await f.render(body('first'));assert.equal(heavyCalls,0);assert.equal(f.host.querySelector('input'),null);await f.render(body('latest before entry'));assert.equal(heavyCalls,0);
    await f.intersect(0,true);assert.equal(heavyCalls,0,'A zero-ratio intersection is not visible');await f.intersect(1);assert.equal(heavyCalls,1);assert.deepEqual(commits,['latest before entry']);assert.equal(f.host.querySelector<HTMLButtonElement>('section button')!.disabled,true,'Visibility does not grant manual input authority');
    const input=f.host.querySelector<HTMLInputElement>('[aria-label="Retained draft"]')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(f.dom.HTMLInputElement.prototype,'value')!.set!.call(input,'unsaved draft');input.dispatchEvent(new Event('input',{bubbles:true}));});
    const before=heavyCalls;await f.intersect(0);assert.equal(f.host.querySelector('output')!.getAttribute('data-active'),'false');await f.render(body('hidden intermediate'));await f.render(body('newest hidden'));assert.equal(heavyCalls,before);assert.deepEqual(commits,['latest before entry']);assert.equal(f.host.querySelector('input'),input);assert.equal(input.value,'unsaved draft');
    await f.intersect(1);assert.equal(f.host.querySelector('input'),input);assert.equal(input.value,'unsaved draft');assert.deepEqual(commits,['latest before entry','newest hidden']);
    await f.render(body('manual source'),true);assert.equal(f.host.querySelector<HTMLButtonElement>('section button')!.disabled,false);
  }finally{await f.close();}
});

test('explicit card visibility bypasses IO without unmounting local state',async()=>{
  const f=await fixture();let mounted=0;
  function Body(){useEffect(()=>{mounted++;},[]);return createElement('input',{'aria-label':'Card state',defaultValue:'retained'});}
  try{await f.render(()=>createElement(Body),false,false);assert.equal(mounted,0);await f.render(()=>createElement(Body),false,true);assert.equal(mounted,1);const input=f.host.querySelector('input');await f.render(()=>createElement(Body),false,false);assert.equal(f.host.querySelector('input'),input);await f.render(()=>createElement(Body),false,true);assert.equal(mounted,1);assert.equal(f.host.querySelector('input'),input);}finally{await f.close();}
});

test('document/native visibility cancels reader requests and polling, then safely resumes latest data',async()=>{
  const f=await fixture(),data=chartDataSchema.parse({series:[],source:{readAction:'range',from:0,to:1000,maxPoints:32,pollMs:250}}),body=()=>createElement(SourceChart,{data,runId:'synthetic',manual:false}),config={version:'v1',actions:[{id:'range',label:'Range',kind:'query'}]};
  try{
    await f.render(body);assert.equal(f.requests.length,0);await f.intersect(1);assert.equal(f.requests.length,1);await f.respond(0,config);assert.equal(f.requests.length,2);
    const pending=f.requests[1]!;await f.visibility(true);assert.equal(pending.signal.aborted,true);assert.equal(f.timers.size,0);const count=f.requests.length;await f.render(body);assert.equal(f.requests.length,count);
    await f.visibility(false);assert.equal(f.requests.length,count+1);const afterDocument=f.requests.at(-1)!;assert.equal(afterDocument.body.actionId,'range');
    await f.native('minimized');assert.equal(afterDocument.signal.aborted,true);assert.equal(f.timers.size,0);const minimizedCount=f.requests.length;await f.render(body);assert.equal(f.requests.length,minimizedCount);
    await f.native('normal');assert.equal(f.requests.length,minimizedCount+1);const next=f.requests.length-1;await f.respond(next,{id:'range-1',actionId:'range',state:'succeeded',createdAt:1,result:{series:[{name:'Current',points:[{x:0,y:1}]}],rawPoints:1000}});assert.match(f.host.textContent!,/1,000 raw points · 1 displayed/);assert.equal(f.timers.size,1);
    await f.intersect(0);assert.equal(f.timers.size,0);
  }finally{await f.close();}
});
