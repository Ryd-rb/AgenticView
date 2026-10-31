import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { act, createElement } from 'react';
import { Window } from 'happy-dom';
import { componentSchema, type Component } from '../shared/protocol.ts';
import { ExecutionWorkbench } from '../web/ExecutionWorkbench.tsx';
import { forexExecutionExample } from '../scripts/forex-example.ts';
import { fixture as serverFixture, secrets } from './server-fixture.ts';

const manifest=JSON.parse(readFileSync('examples/applications/forex-execution.agenticview.json','utf8'));
const sample=componentSchema.parse({...manifest.components[0],kind:'execution-workbench',data:forexExecutionExample()}) as Extract<Component,{kind:'execution-workbench'}>;
async function fixture(c=sample,copies=1){
 const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','HTMLInputElement','HTMLSelectElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:(fn:()=>void)=>setImmediate(fn)});
 const calls:{url:string;body:any}[]=[],originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body))});return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});};
 const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);let component=c;
 const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
 const render=async(next=component,manual=true)=>act(async()=>{component=next;root.render(createElement('div',null,...Array.from({length:copies},(_,index)=>createElement(ExecutionWorkbench,{key:index,component,runId:`synthetic-${index}`,manual}))));await settle();});
 await render();
 const click=async(label:string,scope:Element=host)=>act(async()=>{const button=[...scope.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')===label||button.textContent===label);assert.ok(button,label);button.click();await settle();});
 const change=async(label:string,value:string)=>act(async()=>{const input=host.querySelector<HTMLInputElement|HTMLSelectElement>(`[aria-label="${label}"]`)!;assert.ok(input);Object.getOwnPropertyDescriptor(input.tagName==='SELECT'?dom.HTMLSelectElement.prototype:dom.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));await settle();});
 return{host,calls,render,click,change,close:async()=>{await act(async()=>{root.unmount();await settle();});globalThis.fetch=originalFetch;await dom.happyDOM.close();}};
}

test('treegrid expands strategy/orders into trades and row selection loads the right scoped chart with bounded DOM',async()=>{
 const f=await fixture();try{
  const strategies=sample.data.rows.filter(row=>row.kind==='strategy'),root=strategies[1]!,order=sample.data.rows.find(row=>row.parentId===root.id)!,trade=sample.data.rows.find(row=>row.parentId===order.id)!;
  assert.ok(f.host.querySelectorAll('tbody tr').length<=180);assert.match(f.host.textContent!,/300 strategies/);
  await f.click(`Select strategy ${root.id}`);
  assert.equal(f.host.querySelector('.linked-prices')!.getAttribute('data-root-id'),root.id);
  assert.ok(f.host.querySelector(`tr[id$="-${order.id}"]`));
  await f.click(`Select order ${order.id}`);
  assert.ok(f.host.querySelector(`tr[id$="-${trade.id}"]`));
  await f.click(`Select trade ${trade.id}`);
  assert.equal(f.host.querySelector('.linked-prices')!.getAttribute('data-selected-id'),trade.id);
  const lanes=[...f.host.querySelectorAll('[data-association-lane]')].map(element=>element.getAttribute('data-association-lane'));
  assert.equal(new Set(lanes).size,lanes.length);assert.ok(f.host.querySelector(`[data-event-id="${trade.id}"]`));
  assert.equal(f.calls.length,0,'inspection never sends broker or other action requests');
  await f.change('Find strategies, orders or trades',trade.id);
  const row=f.host.querySelector(`tr[id$="-${root.id}"]`)!;
  assert.equal(row.getAttribute('aria-expanded'),'true');
  assert.equal(row.querySelector('[aria-expanded]')!.getAttribute('aria-expanded'),'true');
 }finally{await f.close();}
});

test('duplicate styled cards keep focus independent and local simulation preserves source and clears on new telemetry',async()=>{
 const before=JSON.stringify(sample),f=await fixture(sample,2);try{
  const ids=[...f.host.querySelectorAll('[id]')].map(node=>node.id);assert.equal(new Set(ids).size,ids.length);
  const second=f.host.children[0]!.children[1]!;
  const firstRow=second.querySelector<HTMLElement>('tbody tr')!;
  await act(async()=>{firstRow.focus();firstRow.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await new Promise<void>(resolve=>setImmediate(resolve));});
  assert.ok(second.contains(document.activeElement),'keyboard navigation stays in second card');
  await f.click('Place demo order',second);await f.click('Simulate fill',second);
  assert.match(second.textContent!,/Demo fill recorded locally/);assert.equal(f.calls.length,0);assert.equal(JSON.stringify(sample),before);
  const styled=structuredClone(sample);styled.data.style={theme:'paper'};await f.render(styled);assert.ok(second.querySelector('[data-selected-id^="demo-trade-"]'),'style-only updates preserve inspection simulation');
  const update=structuredClone(styled);update.data.rows[0]!.quantity+=1;await f.render(update);
  assert.equal(second.querySelector('[data-selected-id^="demo-trade-"]'),null);assert.doesNotMatch(second.textContent!,/Demo fill recorded locally/);
 }finally{await f.close();}
});

test('styles use typed controls and save exact allowed style path without modifying source rows',async()=>{
 const f=await fixture();try{
  await f.change('Workbench theme','paper');await f.change('Workbench color accent','#123456');
  await f.click('Save style to this card');assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0]!.body.changes,{'data.style':{theme:'paper',accent:'#123456'}});
  assert.deepEqual(f.calls[0]!.body.expected,sample);
  await f.render(sample,false);await f.click('Place demo order');assert.equal(f.calls.length,1,'inactive controls have no authority');
 }finally{await f.close();}
});

test('server/client validate hierarchy, styles and portable full-size example consistently',async()=>{
 const c=structuredClone(sample);c.data.rows=c.data.rows.slice(0,1);c.data.series=c.data.series.slice(0,1);c.data.selectedId=c.data.rows[0]!.id;
 const cases=[sample,c,{...c,data:{...c.data,style:{theme:'bad'}}},{...c,data:{...c.data,style:{statuses:JSON.parse('{"__proto__":"#123456"}')}}},{...c,data:{...c.data,rows:[{...c.data.rows[0],kind:'order',parentId:'missing'}]}}];
 const probe=spawnSync('dotnet',['tests/AgenticView.Contracts/bin/Release/net10.0/AgenticView.Contracts.dll','--native-validation-probe'],{input:JSON.stringify(cases),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:4*1024*1024});assert.equal(probe.status,0,probe.stderr||probe.error?.message);
 const results=JSON.parse(probe.stdout);for(const [index,value]of cases.entries()){const parsed=componentSchema.safeParse(value);assert.equal(results[index].ok,parsed.success,`case${index}`);if(parsed.success)assert.deepEqual(results[index].value,parsed.data);}
 const server=await serverFixture();try{const response=await server.call('/api/applications/import',secrets.ingestToken,{manifest,bindings:{},requestId:'forex-example',registrationKey:'synthetic-private-proof-forex-example'});assert.equal(response.status,200,await response.clone().text());const imported=await response.json();const published=await server.call(`/api/agents/${imported.runId}/publish`,imported.runToken,{sequence:2,operations:[{op:'upsert',component:sample}]});assert.equal(published.status,200,await published.clone().text());const styled=await server.call(`/api/agents/${imported.runId}/components/${sample.id}/configure`,secrets.viewerToken,{expected:sample,changes:{'data.style':{theme:'paper'}}});assert.equal(styled.status,200,await styled.clone().text());const exported=await(await server.call(`/api/agents/${imported.runId}/application`,imported.runToken)).json();assert.deepEqual(exported.components,manifest.components);}finally{await server.close();}
});
