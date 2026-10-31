import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act,createElement } from 'react';
import { Window } from 'happy-dom';
import { componentSchema,type Component } from '../shared/protocol.ts';
import { LinkedWorkbench } from '../web/LinkedWorkbench.tsx';
import { ExecutionWorkbench } from '../web/ExecutionWorkbench.tsx';
import { forexExecutionExample,forexExecutionManifest,forexLinkedExample } from '../scripts/forex-example.ts';
import { fixture as serverFixture,secrets } from './server-fixture.ts';

type Workbench=Extract<Component,{kind:'linked-workbench'}>;
type LegacyWorkbench=Extract<Component,{kind:'execution-workbench'}>;
function sample():Workbench{return componentSchema.parse({id:'evidence',title:'Generic build evidence',kind:'linked-workbench',configuration:{manualFields:['data.style']},data:{
  title:'Production evidence',entityLabel:'Evidence hierarchy',searchLabel:'Find evidence',searchPlaceholder:'Any supplied field',chartLabel:'Load and drift',associationLabel:'Production links',emptyLabel:'No evidence found',
  entities:[{id:'project',label:'Project',plural:'Projects'},{id:'job',label:'Job',plural:'Jobs'},{id:'artifact',label:'Artifact',plural:'Artifacts'},{id:'note',label:'Note',plural:'Notes'}],
  columns:[{key:'status',label:'Custom phase',fields:['status']},{key:'bytes',label:'Size kB',format:'number',scale:1000,decimals:1},{key:'copyBytes',label:'Copied kB',format:'number',scale:1000,decimals:1},{key:'sourceBytes',label:'Parent copy',format:'number'},{key:'comment',label:'Annotation text'}],
  rows:[{id:'p',kind:'project',label:'Alpha project',status:'orchestrating',time:1000,values:{owner:'Synthetic'}},{id:'j',parentId:'p',kind:'job',label:'Compile job',status:'queued-custom',time:1100,values:{bytes:-1500}},{id:'a',parentId:'j',kind:'artifact',label:'Bundle artifact',status:'verified',time:1200,values:{bytes:2500}},{id:'n',parentId:'a',kind:'note',label:'Review note',status:'review-draft',time:1300,values:{comment:'needle annotation'}},{id:'p2',kind:'project',label:'Beta project',status:'idle-custom',time:2000,values:{}}],
  series:[{rowId:'p',tracks:[{id:'load',label:'Signed load',decimals:1,points:[{time:1000,value:-3},{time:1300,value:-2}]},{id:'drift',label:'Drift',decimals:2,points:[{time:1000,value:2},{time:1300,value:-.5}]}]},{rowId:'p2',tracks:[{id:'other',label:'Other root',points:[{time:2000,value:-10}]}]}],
  associations:Array.from({length:10},(_,i)=>({id:'relation-'+i,from:'j',to:i%2?'n':'a',label:'Evidence relation '+i})),
  selectedId:'p',pageSize:12,style:{theme:'graphite'},simulations:[{id:'annotate',label:'Attach local note',parentKind:'artifact',kind:'note',status:'new-note',parentStatus:'annotated',allowedStatuses:['verified'],values:{comment:'generated annotation'},copyFields:{copyBytes:'bytes'},parentValues:{reviewed:true},parentCopyFields:{sourceBytes:'bytes'},timeOffsetMs:10,message:'Local annotation created'}],
}}) as Workbench;}

async function fixture(component:Workbench|LegacyWorkbench=sample(),copies=1){
  const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','HTMLInputElement','HTMLSelectElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:(fn:()=>void)=>setImmediate(fn)});
  const calls:{url:string;body:any}[]=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body))});return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});};
  const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);let current=component;
  const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
  const render=async(next=current,manual=true)=>act(async()=>{current=next;root.render(createElement('div',null,...Array.from({length:copies},(_,index)=>current.kind==='execution-workbench'?createElement(ExecutionWorkbench,{key:index,component:current,runId:'synthetic-'+index,manual}):createElement(LinkedWorkbench,{key:index,component:current,runId:'synthetic-'+index,manual}))));await settle();});
  await render();
  const click=async(label:string,scope:Element=host)=>act(async()=>{const button=[...scope.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')===label||button.textContent===label);assert.ok(button,label);button.click();await settle();});
  const change=async(label:string,value:string)=>act(async()=>{const input=host.querySelector<HTMLInputElement|HTMLSelectElement>(`[aria-label="${label}"]`);assert.ok(input,label);Object.getOwnPropertyDescriptor(input.tagName==='SELECT'?dom.HTMLSelectElement.prototype:dom.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));await settle();});
  const row=(id:string,scope:Element=host)=>scope.querySelector<HTMLElement>(`tbody tr[id$="-row-${id}"]`);
  return {dom,host,calls,render,click,change,row,close:async()=>{await act(async()=>{root.unmount();await settle();});globalThis.fetch=originalFetch;await dom.happyDOM.close();}};
}

test('generic four-level hierarchy renders supplied labels, arbitrary phases, signed tracks and distinct paged associations',async()=>{
  const source=sample(),before=JSON.stringify(source),f=await fixture(source);try{
    assert.ok(f.host.querySelector('[role="treegrid"][aria-label="Evidence hierarchy"]'));assert.match(f.host.textContent!,/Production evidence/);assert.match(f.host.textContent!,/Size kB/);assert.match(f.host.textContent!,/orchestrating/);
    assert.equal(f.host.querySelectorAll('[data-track-id]').length,2);assert.match(f.host.textContent!,/Signed load -2.0/);assert.match(f.host.textContent!,/Drift -0.50/);
    const firstLanes=[...f.host.querySelectorAll('[data-association-lane]')].map(node=>node.getAttribute('data-association-lane'));assert.equal(firstLanes.length,8);assert.equal(new Set(firstLanes).size,8);
    await f.click('Next lanes');assert.equal(f.host.querySelectorAll('[data-association-lane]').length,2);await f.click('Previous lanes');
    await f.click('Select Project p');assert.ok(f.row('j'));await f.click('Select Job j');assert.ok(f.row('a'));assert.match(f.row('j')!.textContent!,/-1.5/);
    await f.click('Select Artifact a');assert.ok(f.row('n'));assert.equal(f.row('n')!.getAttribute('aria-level'),'4');await f.click('Select Note n');
    const chart=f.host.querySelector('[data-root-id]')!;assert.equal(chart.getAttribute('data-root-id'),'p');assert.equal(chart.getAttribute('data-selected-id'),'n');assert.ok(chart.querySelector('[data-event-id="n"]'));
    await f.click('Collapse all');await f.change('Find evidence','needle');
    assert.deepEqual([...f.host.querySelectorAll('tbody tr')].map(row=>row.getAttribute('aria-level')),['1','2','3','4']);
    assert.equal(f.row('p')!.getAttribute('aria-expanded'),'true');assert.equal(f.row('p')!.querySelector('[aria-expanded]')!.getAttribute('aria-expanded'),'true');
    await f.change('Find evidence','');await f.click('Select Project p2');assert.equal(f.host.querySelector('[data-root-id]')!.getAttribute('data-root-id'),'p2');assert.equal(f.host.querySelectorAll('[data-track-id="other"]').length,1);
    assert.equal(f.calls.length,0);assert.equal(JSON.stringify(source),before);
  }finally{await f.close();}
});

test('duplicate cards scope keyboard focus; declarative local copies preserve source and survive style-only updates',async()=>{
  const source=sample(),before=JSON.stringify(source),f=await fixture(source,2);try{
    const ids=[...f.host.querySelectorAll('[id]')].map(node=>node.id);assert.equal(new Set(ids).size,ids.length);
    const second=f.host.children[0]!.children[1]!,first=f.row('p',second)!;
    await act(async()=>{first.focus();first.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await new Promise<void>(resolve=>setImmediate(resolve));});assert.ok(second.contains(document.activeElement));assert.equal(document.activeElement,f.row('p2',second));
    await f.click('Select Project p',second);await f.click('Select Job j',second);await f.click('Select Artifact a',second);await f.click('Attach local note',second);
    const simulated=second.querySelector('[data-selected-id^="demo-note-"]');assert.ok(simulated);const childId=simulated.getAttribute('data-selected-id')!;
    const child=f.row(childId,second);assert.ok(child);assert.match(child.textContent!,/new note/);assert.match(child.textContent!,/generated annotation/);assert.equal(child.querySelectorAll('td')[3]!.textContent,'2.5','configured child copy uses its source value field');
    assert.match(f.row('a',second)!.textContent!,/annotated/);assert.equal(f.row('a',second)!.querySelectorAll('td')[4]!.textContent,'2500','configured parent copy updates a parent value');
    assert.match(second.textContent!,/Local annotation created/);assert.equal(f.calls.length,0);assert.equal(JSON.stringify(source),before);
    const styled=structuredClone(source);styled.data.style={theme:'paper'};await f.render(styled);assert.equal(second.querySelector('[data-selected-id]')!.getAttribute('data-selected-id'),childId);
    const updated=structuredClone(styled);updated.data.rows[0]!.values.owner='New observation';await f.render(updated);assert.equal(second.querySelector('[data-selected-id^="demo-note-"]'),null);assert.doesNotMatch(second.textContent!,/Local annotation created/);
  }finally{await f.close();}
});

test('inactive controls cannot simulate or save; active style save uses the exact generic source component',async()=>{
  const source=sample(),f=await fixture(source);try{
    await f.render(source,false);await f.click('Select Project p');assert.equal(f.row('j'),null);assert.equal(f.host.querySelector<HTMLInputElement>('[aria-label="Find evidence"]')!.disabled,true);
    const first=f.row('p')!;await act(async()=>{first.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));});assert.equal(f.row('j'),null);await f.click('Attach local note');assert.equal(f.host.querySelector('[data-selected-id^="demo-"]'),null);assert.equal(f.calls.length,0);
    await f.render(source,true);await f.change('Workbench theme','paper');await f.change('Workbench font size','14');await f.click('Save style to this card');
    assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.url,'/api/agents/synthetic-0/components/evidence/configure');assert.deepEqual(f.calls[0]!.body.expected,source);assert.deepEqual(f.calls[0]!.body.changes,{'data.style':{theme:'paper',fontSize:14}});
    await f.render(source,false);await f.click('Save style to this card');assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

test('prototype-named fields and maps use own values; missing copy sources stay null',async()=>{
  for(const present of [false,true]){
    const source=sample();source.data.entities[0]!.id='toString';
    for(const row of source.data.rows)if(row.kind==='project')row.kind='toString';
    source.data.rows[0]!.status='toString';source.data.rows[0]!.values=present?{toString:'explicit own value'}:{};
    source.data.columns=[{key:'lookup',label:'Prototype-named field',fields:['toString'],decimalsField:'toString'},{key:'copyOut',label:'Copied value'}];
    source.data.simulations=[{id:'own-copy',label:'Copy own field',parentKind:'toString',kind:'note',copyFields:{copyOut:'toString'}}];
    source.data.style={theme:'graphite',kinds:{},statuses:{},tracks:{}};source.data.series[0]!.tracks[0]!.id='toString';
    const f=await fixture(componentSchema.parse(source) as Workbench);try{
      const expected=present?'explicit own value':'—';assert.equal(f.row('p')!.querySelectorAll('td')[1]!.textContent,expected);
      assert.doesNotMatch(f.host.innerHTML,/\[native code\]/,'Absent own fields and empty style maps must not resolve Object.prototype members');
      await f.click('Copy own field');const selected=f.host.querySelector('[data-selected-id^="demo-note-"]');assert.ok(selected,'A missing own source should create a null-valued copy rather than fail scalar validation');
      const row=f.row(selected.getAttribute('data-selected-id')!);assert.ok(row);assert.equal(row.querySelectorAll('td')[2]!.textContent,expected);
      assert.doesNotMatch(f.host.innerHTML,/\[native code\]/);assert.equal(f.calls.length,0);
    }finally{await f.close();}
  }
});

test('legacy styling exposes only persistable entity controls while generic kinds remain editable',async()=>{
  const template=forexExecutionManifest(),legacy=componentSchema.parse({...template.components[0],kind:'execution-workbench',data:forexExecutionExample(2)}) as LegacyWorkbench;
  const old=await fixture(legacy);try{
    assert.ok(old.host.querySelector('[aria-label="Entity color strategy"]'));
    assert.equal(old.host.querySelector('[aria-label="Entity color order"]'),null);assert.equal(old.host.querySelector('[aria-label="Entity color trade"]'),null);
  }finally{await old.close();}
  const generic=await fixture();try{for(const kind of ['project','job','artifact','note'])assert.ok(generic.host.querySelector(`[aria-label="Entity color ${kind}"]`));}finally{await generic.close();}
});

test('full generic forex observations publish within the HTTP envelope and exact style edits stay separate from authored templates',async()=>{
  const manifest=forexExecutionManifest(),component=componentSchema.parse({...manifest.components[0],data:forexLinkedExample(300)}) as Workbench;
  const publish={sequence:2,operations:[{op:'upsert',component}]};assert.ok(Buffer.byteLength(JSON.stringify(publish))<1_048_576);assert.equal(component.data.rows.filter(row=>row.parentId===undefined).length,300);assert.equal(component.data.rows.length,1890);
  const f=await serverFixture();try{
    const buildTemplate=JSON.parse(readFileSync('examples/applications/build-evidence.agenticview.json','utf8'));
    const build=await f.call('/api/applications/import',secrets.ingestToken,{manifest:buildTemplate,bindings:{},requestId:'generic-build-evidence',registrationKey:'synthetic-generic-build-evidence-private-proof'});assert.equal(build.status,200,await build.clone().text());
    const imported=await f.call('/api/applications/import',secrets.ingestToken,{manifest,bindings:{},requestId:'generic-forex-observations',registrationKey:'synthetic-generic-forex-observations-private-proof'});assert.equal(imported.status,200,await imported.clone().text());const credentials=await imported.json();
    const response=await f.call(`/api/agents/${credentials.runId}/publish`,credentials.runToken,publish);assert.equal(response.status,200,await response.clone().text());
    const path=`/api/agents/${credentials.runId}/components/${component.id}/configure`,request={expected:component,changes:{'data.style':{theme:'paper'}}};
    assert.ok(Buffer.byteLength(JSON.stringify(request))<1_048_576);const styled=await f.call(path,secrets.viewerToken,request);assert.equal(styled.status,200,await styled.clone().text());
    assert.equal((await f.call(path,secrets.viewerToken,request)).status,409,'A stale full-component comparison cannot overwrite a newer style');
    const snapshot=await(await f.call('/api/snapshot',secrets.viewerToken)).json(),live=snapshot.agents.find((agent:{id:string})=>agent.id===credentials.runId);assert.equal(live.components[component.id].data.rows.length,1890);assert.equal(live.components[component.id].data.style.theme,'paper');assert.equal(live.sequence,2);
    const exported=await(await f.call(`/api/agents/${credentials.runId}/application`,credentials.runToken)).json();assert.equal(exported.version,'1.2.0');assert.deepEqual(exported.components,manifest.components);assert.equal(exported.components[0].data.rows.filter((row:{parentId?:string})=>row.parentId===undefined).length,12);
  }finally{await f.close();}
});
