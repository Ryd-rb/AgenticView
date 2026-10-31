import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { canPopOut, desktopCardId, popOutCard, canSetWindowIcon, setWindowIcon } from '../web/WindowControls.tsx';
import { act,createElement } from 'react';
import { StandaloneCard } from '../web/StandaloneCard.tsx';

test('native popout uses typed messages, matches acknowledgements and does not retry uncertain launches',async()=>{
 const dom=new Window();Object.defineProperty(globalThis,'window',{configurable:true,value:dom});
 const messages:any[]=[],listeners=new Set<(event:{data:unknown})=>void>();
 Object.assign(dom,{agenticViewDesktop:{version:1,popOut:true,cardId:'one'},chrome:{webview:{postMessage:(message:unknown)=>messages.push(message),addEventListener:(_event:string,callback:(event:{data:unknown})=>void)=>listeners.add(callback),removeEventListener:(_event:string,callback:(event:{data:unknown})=>void)=>listeners.delete(callback)}}});
 try{
  assert.equal(canPopOut(),true);assert.equal(desktopCardId(),'one');
  const launch=popOutCard('one','FX · Paper');assert.equal(messages.length,1);
  assert.deepEqual(Object.keys(messages[0]).sort(),['cardId','requestId','title','type']);
  for(const listener of listeners)listener({data:{type:'agenticview:popout-result',requestId:'other',ok:true}});
  assert.equal(listeners.size,1);
  for(const listener of [...listeners])listener({data:{type:'agenticview:popout-result',requestId:messages[0].requestId,ok:true}});
  await launch;assert.equal(listeners.size,0);assert.equal(messages.length,1);
  const failure=popOutCard('two','FX · Terminal');for(const listener of [...listeners])listener({data:{type:'agenticview:popout-result',requestId:messages[1].requestId,ok:false,message:'Launch retained'}});
  await assert.rejects(failure,/Launch retained/);assert.equal(messages.length,2,'failures never retry automatically');
 }finally{await dom.happyDOM.close();}
});

test('native window icon messages remain scoped and retain explicit failure acknowledgements',async()=>{
 const dom=new Window();Object.defineProperty(globalThis,'window',{configurable:true,value:dom});
 const messages:any[]=[],listeners=new Set<(event:{data:unknown})=>void>();
 Object.assign(dom,{agenticViewDesktop:{version:1,windowIcons:true,cardId:'one'},chrome:{webview:{postMessage:(message:unknown)=>messages.push(message),addEventListener:(_event:string,callback:(event:{data:unknown})=>void)=>listeners.add(callback),removeEventListener:(_event:string,callback:(event:{data:unknown})=>void)=>listeners.delete(callback)}}});
 try{
  assert.equal(canSetWindowIcon(),true);await assert.rejects(setWindowIcon('two',null),/own standalone/);assert.equal(messages.length,0);
  const request=setWindowIcon('one',{icon:'chart',color:'#123456'});const sent=messages[0];assert.deepEqual({...sent,requestId:'request'},{type:'agenticview:window-icon',requestId:'request',cardId:'one',windowIcon:{icon:'chart',color:'#123456'}});
  const result={type:'agenticview:window-icon-result',requestId:sent.requestId,windowId:crypto.randomUUID(),processId:123,version:'a'.repeat(64),ok:true};
  for(const listener of [...listeners])listener({data:{...result,requestId:'other'}});assert.equal(listeners.size,1);
  for(const listener of [...listeners])listener({data:{...result,processId:-1}});assert.equal(listeners.size,1);
  for(const listener of [...listeners])listener({data:result});assert.equal((await request).state,'applied');assert.equal(listeners.size,0);
  const reset=setWindowIcon('one',null);assert.equal(messages[1].windowIcon,null);
  for(const listener of [...listeners])listener({data:{...result,requestId:messages[1].requestId,ok:false,version:'default'}});assert.equal((await reset).state,'failed');assert.equal(messages.length,2,'native failures do not silently retry');
 }finally{await dom.happyDOM.close();}
});

test('standalone view renders only its card, immediately allows local native interaction, and follows its updates',async()=>{
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const previous={fetch:globalThis.fetch,events:globalThis.EventSource};
 const events=new Map<string,(event:unknown)=>void>();let closed=false;
 const sent:any[]=[],reports:any[]=[],listeners=new Set<(event:{data:unknown})=>void>();
 Object.assign(dom,{agenticViewDesktop:{version:1,windowIcons:true,cardId:'one'},chrome:{webview:{postMessage:(message:any)=>{sent.push(message);queueMicrotask(()=>{for(const listener of [...listeners])listener({data:{type:'agenticview:window-icon-result',requestId:message.requestId,ok:true,windowId:'00000000-0000-0000-0000-000000000001',processId:123,version:'a'.repeat(64)}});});},addEventListener:(_event:string,callback:(event:{data:unknown})=>void)=>listeners.add(callback),removeEventListener:(_event:string,callback:(event:{data:unknown})=>void)=>listeners.delete(callback)}}});
 class Source{onopen:unknown;onerror:unknown;addEventListener(name:string,listener:(event:unknown)=>void){events.set(name,listener);}close(){closed=true;}}
 Object.assign(globalThis,{EventSource:Source});globalThis.fetch=async(input,init)=>{if(String(input).endsWith('/window-icon/report'))reports.push({url:input,body:JSON.parse(String(init?.body)),credentials:init?.credentials});return new Response('{"authenticated":true}',{headers:{'Content-Type':'application/json'}});};
 const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
 const make=(id:string,name:string)=>({id,agentId:id,name,role:'Application',context:'',parentId:null,createdAt:1,lastSeen:1,status:'active',sequence:1,windowIcon:{icon:'chart',color:'#123456'},windowIconRevision:4,layout:{x:0,y:0,width:800,height:600,z:1,locked:false},components:{text:{id:'text',kind:'markdown',title:'Details',data:{text:name+' body'}}}});
 try{
  await act(async()=>{root.render(createElement(StandaloneCard,{cardId:'one'}));await settle();});
  await act(async()=>{events.get('snapshot')!({data:JSON.stringify({revision:1,agents:[make('one','Paper workspace'),make('two','Other workspace')],settings:{staleSeconds:45,autoArchiveMinutes:null,archiveAfterCompletion:false,trustedEmbeds:false,reducedMotion:true},stats:{active:2,stale:0,archived:0,updates:0,updatesPerSecond:0}})});await settle();});
  assert.match(host.textContent!,/Paper workspace body/);assert.doesNotMatch(host.textContent!,/Other workspace/);assert.equal(host.querySelector('.canvas'),null);
  assert.equal(sent.length,1);assert.equal(reports.length,1);assert.equal(reports[0].url,'/api/agents/one/window-icon/report');assert.equal(reports[0].credentials,'same-origin');assert.deepEqual(reports[0].body.expected,{icon:'chart',color:'#123456'});assert.equal(reports[0].body.revision,4);assert.equal(reports[0].body.state,'applied');
  await act(async()=>{const {components,...meta}=make('one','Paper workspace');events.get('patch')!({data:JSON.stringify({revision:2,changes:[{id:'one',meta:{...meta,windowIconReports:[reports[0].body]}}],removed:[],stats:{active:2}})});await settle();});
  assert.equal(sent.length,1,'receipt-only updates preserve descriptor identity and do not loop');
  await act(async()=>{events.get('patch')!({data:JSON.stringify({revision:2,changes:[],removed:['one'],stats:{active:1,stale:0,archived:0,updates:0,updatesPerSecond:0}})});await settle();});
  assert.match(host.textContent!,/archived or unavailable/);assert.doesNotMatch(host.textContent!,/Other workspace/);
 }finally{await act(async()=>root.unmount());assert.equal(closed,true);globalThis.fetch=previous.fetch;Object.assign(globalThis,{EventSource:previous.events});await dom.happyDOM.close();}
});
