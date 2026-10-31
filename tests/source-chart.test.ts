import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { act,createElement } from 'react';
import { Window } from 'happy-dom';
import { SourceChart } from '../web/SourceChart.tsx';
import { chartDataSchema,formatNativeNumber,type ChartData,type NumberFormat } from '../shared/native-extensions.ts';

test('native number formats reuse a bounded style/precision cache while values and affixes remain dynamic',()=>{
  const Original=Intl.NumberFormat;let created=0;
  Intl.NumberFormat=new Proxy(Original,{construct(target,args,newTarget){created++;return Reflect.construct(target,args,newTarget);}});
  try{
    for(const style of ['number','percent','compact'] as const)for(const decimals of [undefined,0,1,2,3,4,5,6,7,8]){
      const format:NumberFormat={style,...(decimals===undefined?{}:{decimals})};
      const expected=new Original('en',{style:style==='percent'?'percent':'decimal',notation:style==='compact'?'compact':'standard',maximumFractionDigits:decimals??2,minimumFractionDigits:decimals}).format(1234.125);
      assert.equal(formatNativeNumber(1234.125,{...format,prefix:'[',suffix:']'}),'['+expected+']');
    }
    const initial=created;assert.ok(initial<=30);
    for(let i=0;i<1000;i++)formatNativeNumber(i/7,{style:'number',decimals:2,prefix:String(i),suffix:' units'});
    assert.equal(created,initial,'Value and affix changes do not construct or cache more formatters');assert.equal(formatNativeNumber(.125,{style:'percent',decimals:1}),'12.5%');
  }finally{Intl.NumberFormat=Original;}
});

const sample=()=>chartDataSchema.parse({type:'line',series:[{name:'Fallback',points:[{x:0,y:1}]}],options:{legend:true,features:{dataTable:true}},source:{readAction:'range',from:0,to:1000,maxPoints:32,pollMs:250}});
test('chart source schema and C# validator agree on fixed/rolling windows and strict bounds',()=>{
  const base=sample(),sources:unknown[]=[{readAction:'range'},{readAction:'range',windowMs:1000,pollMs:250,maxPoints:32},{readAction:'range',from:0,to:8_640_000_000_000_000,maxPoints:2048,pollMs:60000},{readAction:'range',from:0},{readAction:'range',to:1},{readAction:'range',from:1,to:1},{readAction:'range',from:2,to:1},{readAction:'range',maxPoints:31},{readAction:'range',maxPoints:2049},{readAction:'range',pollMs:249},{readAction:'range',windowMs:999},{readAction:'range',from:.5,to:1},{readAction:'constructor'},{readAction:'range',url:'https://example.invalid/raw'}];
  const components=sources.map(source=>({id:'chart',title:'Chart',kind:'chart',data:{...base,source}}));
  const result=spawnSync('dotnet',['run','--project','tests/AgenticView.Contracts','-c','Release','--no-restore','--','--native-validation-probe'],{input:JSON.stringify(components),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr||result.error?.message);const line=result.stdout.split(/\r?\n/).find(line=>line.startsWith('[{"ok"'));assert.ok(line,result.stdout);const values=JSON.parse(line);
  for(const [i,source] of sources.entries()){const parsed=chartDataSchema.safeParse({...base,source});assert.equal(values[i].ok,parsed.success,'source '+i);if(parsed.success)assert.deepEqual(values[i].value.data,parsed.data);}
});

type Request={url:string;body?:any;signal:AbortSignal;resolve:(response:Response)=>void};
async function fixture(initial=sample(),hiddenInitially=false,confirmation?:string,kind='query'){
  const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  let hidden=hiddenInitially,timerId=100000;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
  const original={fetch:globalThis.fetch,set:globalThis.setTimeout,clear:globalThis.clearTimeout},requests:Request[]=[],timers=new Map<number,()=>void>();
  globalThis.setTimeout=((callback:()=>void,delay?:number,...args:unknown[])=>{if([250,750,1500,15000].includes(delay??0)){timers.set(++timerId,callback);return timerId;}return original.set(callback,delay,...args);}) as typeof setTimeout;
  globalThis.clearTimeout=((id:number)=>{if(!timers.delete(id))original.clear(id);}) as typeof clearTimeout;
  globalThis.fetch=async(url,init)=>new Promise<Response>((resolve,reject)=>{requests.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):undefined,signal:init!.signal as AbortSignal,resolve});init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
  const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host),settle=()=>new Promise<void>(resolve=>setImmediate(resolve));let data=initial;
  const render=async(next=data)=>act(async()=>{data=next;root.render(createElement(SourceChart,{data,runId:'synthetic',manual:true}));await settle();});
  const respond=async(index:number,value:unknown,status=200)=>act(async()=>{assert.ok(requests[index],String(index));requests[index]!.resolve(new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}}));await settle();});
  const configuration={version:'v1',actions:[{id:'range',label:'Read range',kind,...(confirmation?{confirmation}:{})},{id:'other',label:'Other range',kind:'query'}]};
  await render();
  return {host,requests,timers,render,respond,configuration,visibility:async(value:boolean)=>act(async()=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));await settle();}),tick:async()=>act(async()=>{const entry=[...timers.entries()].find(([_,fn])=>!!fn);assert.ok(entry);timers.delete(entry[0]);entry[1]();await settle();}),close:async()=>{await act(async()=>{root.unmount();await settle();});globalThis.fetch=original.fetch;globalThis.setTimeout=original.set;globalThis.clearTimeout=original.clear;await dom.happyDOM.close();}};
}
const completed=(result:unknown)=>({id:'read-1',actionId:'range',state:'succeeded',createdAt:1,result});

test('visible source queries are bounded, retain successful data on invalid response and abort on hide',async()=>{
  const f=await fixture();try{
    assert.equal(f.requests.length,1);await f.respond(0,f.configuration);assert.equal(f.requests.length,2);assert.equal(f.host.querySelector<HTMLElement>('.source-chart')!.dataset.sourceState,'loading');assert.deepEqual(f.requests[1]!.body.input,{from:0,to:1000,maxPoints:32});assert.equal(f.requests[1]!.body.actionId,'range');assert.equal(f.requests[1]!.body.definitionVersion,'v1');
    await f.respond(1,completed({series:[{name:'Provider',points:[{x:0,y:-10},{x:500,y:100}]}],rawPoints:1_000_000}));assert.match(f.host.textContent!,/1,000,000 raw points · 2 displayed/);assert.match(f.host.textContent!,/Provider/);assert.equal(f.host.querySelector<HTMLElement>('.source-chart')!.dataset.sourceState,'ready');assert.ok(Number(f.host.querySelector<HTMLElement>('.source-chart')!.dataset.sourceReceivedAt)>0);
    await f.tick();assert.equal(f.requests.length,3);assert.match(f.host.textContent!,/Provider/,'Last success remains available while next query is pending');
    await f.respond(2,completed({series:[{name:'Oversized',points:Array.from({length:33},(_,i)=>({x:i,y:i}))}],rawPoints:1000}));assert.match(f.host.querySelector('[role="alert"]')!.textContent!,/requested point limit/);assert.match(f.host.textContent!,/Provider/);assert.doesNotMatch(f.host.textContent!,/Oversized/);
    await f.tick();const pending=f.requests.at(-1)!;assert.equal(pending.signal.aborted,false);await f.visibility(true);assert.equal(pending.signal.aborted,true);assert.equal(f.timers.size,0);assert.match(f.host.textContent!,/Chart queries paused/);assert.equal(f.host.querySelector<HTMLElement>('.source-chart')!.dataset.sourceState,'paused');
  }finally{await f.close();}
});

test('hidden charts do not load configuration or query, and confirmation/write actions are never automatic',async()=>{
  const hidden=await fixture(sample(),true);try{assert.equal(hidden.requests.length,0);await hidden.visibility(false);assert.equal(hidden.requests.length,1);await hidden.respond(0,hidden.configuration);assert.equal(hidden.requests.length,2);}finally{await hidden.close();}
  for(const [confirmation,kind] of [['Review access','query'],[undefined,'command']] as const){const f=await fixture(sample(),false,confirmation,kind);try{await f.respond(0,f.configuration);assert.equal(f.requests.length,1);assert.match(f.host.querySelector('[role="alert"]')!.textContent!,/confirmation-free query/);assert.equal(f.timers.size,0);assert.match(f.host.textContent!,/Fallback/);}finally{await f.close();}}
});

test('source changes cancel pending reads and unmount clears owned polling timers',async()=>{
  const f=await fixture();try{await f.respond(0,f.configuration);const pending=f.requests[1]!;const next=sample();next.source={...next.source!,readAction:'other',from:100,to:200};await f.render(next);assert.equal(pending.signal.aborted,true);assert.equal(f.requests.at(-1)!.body.actionId,'other');assert.deepEqual(f.requests.at(-1)!.body.input,{from:100,to:200,maxPoints:32});}finally{await f.close();}assert.equal(f.timers.size,0);
});
