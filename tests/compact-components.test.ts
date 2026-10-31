import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { componentSchema } from '../shared/protocol.ts';
import { applicationManifestSchema } from '../shared/application-manifest.ts';
import { ComponentView } from '../web/Components.tsx';
import { componentLayoutStyle } from '../web/ComponentLayout.tsx';
import { fixture, secrets } from './server-fixture.ts';

const plain = {presentation:{surface:'plain',density:'compact'}};
const action = {id:'actions',title:'Workspace controls',kind:'action-panel',data:{actionIds:['lock'],layout:'inline',buttons:[{actionId:'lock',icon:'lock',appearance:'icon',variant:'bare'}]},configuration:plain};

test('compact configuration agrees across native server and client validation, including hostile and bounded input',()=>{
  const cases=[action,
    {...action,configuration:{presentation:{surface:'script'}}},
    {...action,data:{...action.data,buttons:[{actionId:'missing',icon:'lock'}]}},
    {...action,data:{...action.data,buttons:[{actionId:'lock',icon:'bad'}]}},
    {...action,data:{...action.data,buttons:[{actionId:'lock'},{actionId:'lock'}]}},
    {...action,data:{...action.data,buttons:Array.from({length:65},()=>({actionId:'lock'}))}},
    {...action,data:{...action.data,buttons:JSON.parse('{"__proto__":{}}')}},
    {...action,data:{...action.data,buttons:[JSON.parse('{"actionId":"lock","__proto__":{}}')]}},
    {...action,data:{...action.data,buttons:[{actionId:'lock',onclick:'execute()'}]}},
    {...action,configuration:{controls:{submit:{icon:'unlock',appearance:'both',variant:'bare'}}}},
  ];
  const probe=spawnSync('dotnet',['tests/AgenticView.Contracts/bin/Release/net10.0/AgenticView.Contracts.dll','--native-validation-probe'],{input:JSON.stringify(cases),encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(probe.status,0,probe.stderr);
  const results=JSON.parse(probe.stdout);
  for(const [index,value] of cases.entries()){
    const parsed=componentSchema.safeParse(value);
    assert.equal(parsed.success,index===0||index===9,`acceptance ${index}`);
    assert.equal(results[index].ok,parsed.success,`parity ${index}`);
    if(parsed.success)assert.deepEqual(results[index].value,parsed.data);
  }
});

test('shared plain presentation preserves native semantics and custom origin across component families',()=>{
  for(const component of [
    {id:'text',title:'Text',kind:'markdown',data:{text:'Readable text'}},
    {id:'metric',title:'Metric',kind:'metric',data:{value:42}},
    {id:'grid',title:'Rows',kind:'table',data:{columns:[{key:'name',label:'Name'}],rows:[{name:'Synthetic row'}]}},
    {id:'tasks',title:'Plan',kind:'checklist',data:{items:[{id:'task',label:'Keep task behavior',status:'active'}]}},
  ]){
    const parsed=componentSchema.parse({...component,configuration:plain});
    const html=renderToStaticMarkup(createElement(ComponentView,{component:parsed,runId:'synthetic',embeds:false}));
    assert.match(html,/data-surface="plain"/);assert.match(html,/data-density="compact"/);
    assert.match(html,/aria-label="Built-in component"/);assert.doesNotMatch(html,/<h3/);
    const defaultHtml=renderToStaticMarkup(createElement(ComponentView,{component:componentSchema.parse(component),runId:'synthetic',embeds:false}));
    assert.match(defaultHtml,/<h3/);assert.match(defaultHtml,/Built-in/);assert.doesNotMatch(defaultHtml,/data-surface=/);
  }
  const custom=componentSchema.parse({id:'custom',title:'Custom',kind:'embed',data:{html:'<p>Custom</p>',height:120},configuration:{...plain,controls:{header:{visible:false}}}});
  const html=renderToStaticMarkup(createElement(ComponentView,{component:custom,runId:'synthetic',embeds:false}));
  assert.match(html,/Custom view/);assert.doesNotMatch(html,/data-surface="plain"/);
  const conditional=componentSchema.parse({id:'rule',title:'Conditional',kind:'metric',data:{value:1},configuration:{rules:[{when:{all:[{field:'data.value',op:'eq',value:1}]},effect:{presentation:{surface:'plain',density:'compact'}}}]}});
  assert.match(renderToStaticMarkup(createElement(ComponentView,{component:conditional,runId:'synthetic',embeds:false})),/data-surface="plain"/);
  assert.equal(componentLayoutStyle({mode:'inline'}).display,'flex');
  assert.equal(componentLayoutStyle({mode:'inline'}).gridTemplateColumns,undefined);
});

test('portable compact controls roundtrip and manual surface changes retain scoped permission and producer state',async()=>{
  const manifest=applicationManifestSchema.parse(JSON.parse(readFileSync('examples/applications/compact-controls.agenticview.json','utf8')));
  const f=await fixture();
  try{
    const imported=await f.call('/api/applications/import',secrets.ingestToken,{manifest,bindings:{},requestId:'compact-import',registrationKey:'synthetic-private-proof-for-compact-controls'});
    assert.equal(imported.status,200,await imported.clone().text());
    const r=await imported.json();
    const exported=await(await f.call(`/api/agents/${r.runId}/application`,r.runToken,undefined,'GET')).json();
    assert.deepEqual(exported,manifest);
    let snapshot=await(await f.call('/api/snapshot',secrets.viewerToken)).json();
    let agent=snapshot.agents.find((item:any)=>item.id===r.runId);
    assert.equal(agent.componentLayout.mode,'inline');
    const component=agent.components.settings,path=`/api/agents/${r.runId}/components/settings/configure`;
    const change={expected:component,changes:{'configuration.presentation':{surface:'default',density:'comfortable'}}};
    assert.equal((await f.call(path,r.runToken,change)).status,401);
    assert.equal((await f.call(path,secrets.viewerToken,change)).status,200);
    assert.equal((await f.call(path,secrets.viewerToken,change)).status,409);
    snapshot=await(await f.call('/api/snapshot',secrets.viewerToken)).json();agent=snapshot.agents.find((item:any)=>item.id===r.runId);
    assert.equal(agent.sequence,r.sequence);assert.equal(agent.components.settings.configuration.presentation.surface,'default');
    assert.equal(agent.components.lock.configuration.presentation.surface,'plain');
    assert.deepEqual(await(await f.call(`/api/agents/${r.runId}/application`,r.runToken)).json(),manifest,'manual settings do not rewrite authored template');
  }finally{await f.close();}
});
