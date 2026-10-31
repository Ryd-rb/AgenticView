import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { act,createElement } from 'react';
import { Window } from 'happy-dom';
import { presentationSchema,type Presentation } from '../shared/component-config.ts';
import { componentSchema,type Component } from '../shared/protocol.ts';
import { ComponentSettings,presentationStyle } from '../web/ComponentSettings.tsx';
import { CardInteraction } from '../web/CardInteraction.ts';
import { ComponentView } from '../web/Components.tsx';
import { fixture as serverFixture,secrets } from './server-fixture.ts';

const metric=(presentation:unknown)=>({id:'metric',kind:'metric',title:'Synthetic metric',data:{value:42},configuration:{presentation,manualFields:['configuration.presentation']}});
const zero={padding:0,margin:{top:0,right:0,bottom:0,left:0},gap:0,rowGap:0,columnGap:0,controlPadding:0,cellPadding:0,borderWidth:0,borderRadius:0,fontSize:10,lineHeight:1,fontWeight:100,letterSpacing:0,minWidth:0,maxWidth:0,minHeight:0,maxHeight:0,animation:'none',animationDurationMs:0};
const upper={padding:{top:96,right:96,bottom:96,left:96},margin:96,controlPadding:96,cellPadding:96,gap:64,rowGap:64,columnGap:64,controlHeight:96,rowHeight:120,borderWidth:8,borderRadius:48,fontSize:32,lineHeight:2.5,fontWeight:900,fontFamily:'mono',letterSpacing:4,minWidth:2400,maxWidth:2400,minHeight:2400,maxHeight:2400,animation:'subtle',animationDurationMs:1000};
const valid:unknown[]=[{},zero,upper,{padding:{left:.5},margin:{bottom:2.25},controlPadding:{left:0,right:4},cellPadding:{top:0,bottom:.5},fontFamily:'serif',controlHeight:28,rowHeight:28},{surface:'plain',density:'compact',fontSize:14,emphasis:'bold',align:'right',color:'#abcdef'}];
const invalid:unknown[]=[{padding:-1},{padding:97},{padding:'0px'},{padding:{left:-1}},{padding:{horizontal:2}},{padding:null},{margin:-1},{gap:65},{rowGap:-1},{columnGap:'4px'},{controlHeight:27},{controlHeight:96.5},{rowHeight:121},{cellPadding:{top:97}},{borderWidth:9},{borderRadius:49},{fontSize:9},{fontSize:33},{lineHeight:.9},{lineHeight:2.6},{fontWeight:99},{fontWeight:100.5},{fontFamily:'https://example.invalid/font.woff'},{letterSpacing:4.1},{minWidth:2401},{minWidth:2,maxWidth:1},{minHeight:2,maxHeight:1},{maxHeight:-1},{animation:'spin'},{animationDurationMs:1001},{animationDurationMs:1.5},{color:'#123456\n'},{transform:'scale(2)'},{css:'padding:0'},JSON.parse('{"padding":{"__proto__":1}}')];

test('typed presentation accepts precise zero and edge spacing and rejects unsafe/unbounded styles',()=>{
  for(const value of valid){assert.ok(presentationSchema.safeParse(value).success,JSON.stringify(value));assert.deepEqual(presentationSchema.parse(value),value);}
  for(const value of invalid)assert.equal(presentationSchema.safeParse(value).success,false,JSON.stringify(value));
  assert.deepEqual(presentationStyle(undefined),{});
  const style=presentationStyle(presentationSchema.parse(zero)) as Record<string,unknown>;
  assert.equal(style.padding,0);assert.equal(style.marginLeft,0);assert.equal(style['--component-control-padding'],'0px');assert.equal(style['--component-cell-padding'],'0px');assert.equal(style['--component-font-size'],'10px');assert.equal(style['--component-motion-duration'],'0ms');
  const edges=presentationStyle({padding:{left:0},controlPadding:{top:0},animation:'subtle'}) as Record<string,unknown>;assert.equal(edges.paddingLeft,0);assert.equal(edges.padding,undefined);assert.equal(edges.paddingRight,undefined);assert.equal(edges['--component-control-padding-top'],'0px');assert.equal(edges['--component-motion-duration'],'120ms');
  assert.equal((presentationStyle({animation:'none',animationDurationMs:999}) as Record<string,unknown>)['--component-motion-duration'],'0ms');
});

test('C# and TypeScript agree on flexible presentation and conditional effect contracts',()=>{
  const cases=[...valid,...invalid].map(presentation=>metric(presentation));cases.push({...metric({}),configuration:{presentation:{},manualFields:['configuration.presentation'],rules:[{when:{all:[{field:'data.value',op:'eq',value:42}]},effect:{presentation:upper}}]}} as any);
  const process=spawnSync('dotnet',['run','--project','tests/AgenticView.Contracts','-c','Release','--no-restore','--','--native-validation-probe'],{input:JSON.stringify(cases),encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});assert.equal(process.status,0,process.stderr||process.error?.message);
  const line=process.stdout.split(/\r?\n/).find(line=>line.startsWith('[{"ok"'));assert.ok(line,process.stdout);const results=JSON.parse(line);
  for(const [i,value] of cases.entries()){const parsed=componentSchema.safeParse(value);assert.equal(results[i].ok,parsed.success,'presentation case '+i);if(parsed.success)assert.deepEqual(results[i].value,parsed.data);}
});

async function ui(component:Component,view=false){
  const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','HTMLInputElement','HTMLSelectElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:(fn:()=>void)=>setImmediate(fn)});
  const calls:any[]=[],original=globalThis.fetch;globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body))});return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});};
  for(const path of ['web/control-views.css','web/linked-workbench.css','web/component-config.css','web/component-presentation.css']){try{const style=document.createElement('style');style.textContent=readFileSync(path,'utf8');document.head.append(style);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host),settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
  await act(async()=>{root.render(createElement(CardInteraction.Provider,{value:true},view?createElement(ComponentView,{component,runId:'synthetic',embeds:false}):createElement(ComponentSettings,{component,runId:'synthetic'})));await settle();});
  const change=async(label:string,value:string)=>act(async()=>{const input=host.querySelector<HTMLInputElement|HTMLSelectElement>(`[aria-label="${label}"]`);assert.ok(input,label);Object.getOwnPropertyDescriptor(input.tagName==='SELECT'?dom.HTMLSelectElement.prototype:dom.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));await settle();});
  const click=async(label:string)=>act(async()=>{const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')===label||button.textContent===label);assert.ok(button,label);button.click();await settle();});
  return {host,calls,dom,change,click,close:async()=>{await act(async()=>{root.unmount();await settle();});globalThis.fetch=original;await dom.happyDOM.close();}};
}

test('manual presentation editor preserves zero, uses typed edge fields and omits cleared overrides',async()=>{
  const component=componentSchema.parse(metric({})),f=await ui(component);try{
    await f.change('Appearance padding','0');await f.change('Appearance margin left','2.5');await f.change('Appearance gap','0');await f.change('Appearance controlPadding','0');await f.change('Appearance cellPadding top','0');await f.change('Appearance text size','32');await f.change('Appearance line height','1.2');await f.change('Appearance animation','subtle');await f.change('Appearance animation duration','0');await f.change('Appearance maximum width','500');await f.change('Appearance maximum width','');
    await f.click('Save component settings');assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body.expected,component);assert.deepEqual(f.calls[0].body.changes,{'configuration.presentation':{padding:0,margin:{left:2.5},gap:0,controlPadding:0,cellPadding:{top:0},fontSize:32,lineHeight:1.2,animation:'subtle',animationDurationMs:0}});
  }finally{await f.close();}
});

test('explicit native presentation metrics reach linked controls and table cells without changing data',async()=>{
  const component=componentSchema.parse({id:'linked',kind:'linked-workbench',title:'Native controls',configuration:{presentation:{fontSize:30,controlPadding:0,controlHeight:40,cellPadding:{left:0,right:2},rowHeight:48,gap:0}},data:{entities:[{id:'node',label:'Node'}],columns:[{key:'value',label:'Value'}],rows:[{id:'root',kind:'node',values:{value:1}}],series:[],associations:[]}}),before=JSON.stringify(component),f=await ui(component,true);try{
    const configured=f.host.querySelector<HTMLElement>('.component-configured')!,input=f.host.querySelector<HTMLInputElement>('[aria-label="Find linked rows"]')!,cell=f.host.querySelector<HTMLElement>('tbody td')!;
    assert.equal(configured.style.getPropertyValue('--component-control-padding'),'0px');assert.equal(window.getComputedStyle(input).fontSize,'30px');assert.equal(window.getComputedStyle(input).paddingLeft,'0px');assert.equal(window.getComputedStyle(input).minHeight,'40px');assert.equal(window.getComputedStyle(cell).paddingLeft,'0px');assert.equal(window.getComputedStyle(cell).height,'48px');assert.equal(JSON.stringify(component),before);
  }finally{await f.close();}
});

test('manual HTTP presentation edits enforce exact source, type bounds and authority',async()=>{
  const f=await serverFixture();try{
    const registered=await(await f.call('/api/agents/register',secrets.ingestToken,{requestId:'flexible-presentation',registrationKey:'synthetic-flexible-presentation-private-proof',agentId:'flexible',name:'Synthetic flexible component'})).json(),component=metric({});
    assert.equal((await f.call(`/api/agents/${registered.runId}/publish`,registered.runToken,{sequence:1,operations:[{op:'upsert',component}]})).status,200);
    const path=`/api/agents/${registered.runId}/components/metric/configure`,request={expected:component,changes:{'configuration.presentation':zero}};
    for(const token of ['',secrets.ingestToken,registered.runToken])assert.equal((await f.call(path,token,request)).status,401);
    const saved=await f.call(path,secrets.viewerToken,request);assert.equal(saved.status,200,await saved.clone().text());assert.equal((await f.call(path,secrets.viewerToken,request)).status,409);
    const current={...component,configuration:{...component.configuration,presentation:zero}};assert.equal((await f.call(path,secrets.viewerToken,{expected:current,changes:{'configuration.presentation':{margin:-1}}})).status,400);
    const snapshot=await(await f.call('/api/snapshot',secrets.viewerToken)).json(),run=snapshot.agents.find((agent:{id:string})=>agent.id===registered.runId);assert.deepEqual(run.components.metric.configuration.presentation,zero);assert.equal(run.sequence,1);
  }finally{await f.close();}
});
