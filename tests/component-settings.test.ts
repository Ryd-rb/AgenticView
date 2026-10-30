import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { ComponentSettings } from '../web/ComponentSettings.tsx';
import { CardInteraction } from '../web/CardInteraction.ts';
import { componentSchema } from '../shared/protocol.ts';

test('manual settings use typed controls, selection gating, exact field changes and stale-source error feedback',async()=>{
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const originalFetch=globalThis.fetch, requests:{url:string;init:RequestInit;resolve:(response:Response)=>void}[]=[];
 globalThis.fetch=async(url,init)=>new Promise<Response>(resolve=>requests.push({url:String(url),init:init!,resolve}));
 const {createRoot}=await import('react-dom/client');const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const component=componentSchema.parse({id:'latency',title:'Latency',kind:'metric',data:{value:42,unit:'ms'},configuration:{manualFields:['configuration.presentation','data.unit'],presentation:{color:'#abcdef'}}});
 const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
 const render=async(active:boolean)=>act(async()=>{root.render(createElement(CardInteraction.Provider,{value:active},createElement(ComponentSettings,{component,runId:'synthetic/run'})));await settle();});
 const save=()=>host.querySelector<HTMLButtonElement>('button')!;
 const input=async(label:string,value:string)=>act(async()=>{const target=host.querySelector<HTMLInputElement|HTMLSelectElement>(`[aria-label="${label}"]`)!;const prototype=target.tagName==='SELECT'?dom.HTMLSelectElement.prototype:dom.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(target,value);target.dispatchEvent(new Event(target.tagName==='SELECT'?'change':'input',{bubbles:true}));await settle();});
 try {
  await render(false);assert.equal(save().disabled,true);assert.equal(host.querySelector<HTMLInputElement>('[aria-label="Appearance color"]')!.disabled,false,'Disabled fieldset supplies inherited input gating');assert.equal(host.querySelector('fieldset')!.disabled,true);
  await render(true);await input('Configure data.unit','seconds');await input('Appearance density','compact');
  await act(async()=>{save().click();await settle();});assert.equal(requests.length,1);assert.equal(requests[0]!.init.credentials,'same-origin');assert.match(requests[0]!.url,/synthetic%2Frun/);
  const request=JSON.parse(String(requests[0]!.init.body));assert.equal(request.changes['data.unit'],'seconds');assert.deepEqual(request.changes['configuration.presentation'],{color:'#abcdef',density:'compact'});assert.deepEqual(request.expected,component);
  await act(async()=>{requests[0]!.resolve(new Response(JSON.stringify({error:'Component changed. Reopen settings before saving.'}),{status:409,headers:{'Content-Type':'application/json'}}));await settle();});
  assert.match(host.querySelector('[role="alert"]')!.textContent!,/Component changed/);assert.equal(host.querySelector<HTMLInputElement>('[aria-label="Configure data.unit"]')!.value,'seconds');assert.equal(requests.length,1,'A stale settings write is never replayed automatically');
 } finally {await act(async()=>{root.unmount();await settle();});globalThis.fetch=originalFetch;await dom.happyDOM.close();}
});
