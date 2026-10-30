import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { componentSchema } from '../shared/protocol.ts';
import { coerceGridChanges, gridDataSchema, validateGridRow } from '../shared/grid-config.ts';
import { ComponentView } from '../web/Components.tsx';
import { fixture, secrets } from './server-fixture.ts';
import { readFileSync } from 'node:fs';
import { applicationManifestSchema } from '../shared/application-manifest.ts';
import { spawnSync } from 'node:child_process';

test('server and client agree on shared configuration and grid rule validation boundaries',()=>{
 const base={id:'configuration',kind:'metric',title:'Metric',data:{value:1}};
 const grid={id:'grid',kind:'data-grid',title:'Grid',data:{columns:[{key:'Key',label:'Key'},{key:'Value',label:'Value'}]}};
 const cases=[
  {...base,configuration:{manualFields:['configuration.presentation','data.unit'],presentation:{fontSize:12},rules:[{when:{none:[{field:'data.value',op:'in',values:[0]}]},effect:{tooltip:'A literal tooltip'}}]}},
  {...base,configuration:{manualFields:['configuration.manualFields']}},
  {...base,configuration:{presentation:{background:'url(https://example.com)'}}},
  {...base,configuration:{rules:[{when:{all:[{field:'data.value',op:'eq'}]},effect:{visible:false}}]}},
  {...base,configuration:{collection:{field:'rows',limit:2}}},
  {...grid,data:{...grid.data,keyColumns:['Key','Value'],rules:[{id:'type',column:'Value',when:{all:[{field:'Key',op:'eq',value:'Count'}]},constraints:{type:'integer',storage:'string',min:0,max:10}}]}},
  {...grid,data:{...grid.data,keyColumns:['Key','Key']}},
  {...grid,data:{...grid.data,rules:[{id:'unknown',column:'missing',when:{},tooltip:'Invalid column'}]}},
 ];
 const run=spawnSync('dotnet',['tests/AgenticView.Contracts/bin/Release/net10.0/AgenticView.Contracts.dll','--native-validation-probe'],{input:JSON.stringify(cases),encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(run.status,0,run.stderr);
 const results=JSON.parse(run.stdout);for(const [index,input] of cases.entries()){const parsed=componentSchema.safeParse(input);assert.equal(results[index].ok,parsed.success,`case ${index}`);if(parsed.success)assert.deepEqual(results[index].value,parsed.data);}
});

test('exported catalog references resolve and the synthetic workbench imports every authored native configuration',async()=>{
 for(const file of ['shared/components.schema.json','shared/application-manifest.schema.json']) {
  const schema=JSON.parse(readFileSync(file,'utf8'));
  const visit=(value:any)=>{if(!value||typeof value!=='object')return;if(typeof value.$ref==='string'&&value.$ref.startsWith('#/')){let target=schema;for(const part of value.$ref.slice(2).split('/'))target=target?.[part.replaceAll('~1','/').replaceAll('~0','~')];assert.ok(target,`Unresolved ${value.$ref}`);}for(const child of Object.values(value))visit(child);};visit(schema);
 }
 const manifest=applicationManifestSchema.parse(JSON.parse(readFileSync('examples/applications/configurable-workbench.agenticview.json','utf8')));
 const f=await fixture();try{
  const response=await f.call('/api/applications/import',secrets.ingestToken,{manifest,bindings:{},requestId:'synthetic-workbench',registrationKey:'synthetic-private-proof-for-configurable-workbench'});
  assert.equal(response.status,200,await response.clone().text());
  const {runId}=await response.json(),snapshot=await(await f.call('/api/snapshot',secrets.viewerToken)).json();const agent=snapshot.agents.find((item:any)=>item.id===runId);
  assert.equal(Object.keys(agent.components).length,manifest.components.length);assert.equal(agent.components.budget.data.max,100);assert.equal(agent.components.settings.data.rules[0].constraints.storage,'string');
 }finally{await f.close();}
});

test('configuration transforms list views, labels and styles without changing source or rendering executable text',()=>{
 const component=componentSchema.parse({id:'list',title:'Items',kind:'keyvalue',data:{items:[{key:'A',value:2},{key:'B',value:1}]},configuration:{manualFields:['configuration.presentation','configuration.collection'],collection:{field:'items',filter:{all:[{field:'value',op:'gte',value:2}]},sortBy:'value',limit:1},rules:[{when:{all:[{field:'data.items.0.value',op:'eq',value:2}]},effect:{label:'<script>Rule label</script>',tooltip:'Literal tooltip',presentation:{color:'#abcdef',fontSize:16}}}]}});
 const before=JSON.stringify(component), html=renderToStaticMarkup(createElement(ComponentView,{component,runId:'synthetic',embeds:false}));
 assert.match(html,/&lt;script&gt;Rule label/);assert.doesNotMatch(html,/<script>/);assert.match(html,/Literal tooltip/);assert.match(html,/>A</);assert.doesNotMatch(html,/>B</);assert.match(html,/Configure component/);assert.equal(JSON.stringify(component),before);
 const hidden=structuredClone(component);hidden.configuration!.visible=false;assert.equal(renderToStaticMarkup(createElement(ComponentView,{component:hidden,runId:'synthetic',embeds:false})), '');
});

test('row-specific types support ten-column keys and string backing without loose boolean coercion',()=>{
 const columns=Array.from({length:10},(_,i)=>({key:`k${i}`,label:`Key ${i}`,editable:true}));columns.push({key:'Value',label:'Value',editable:true});
 const data=gridDataSchema.parse({columns,keyColumns:columns.slice(0,10).map(c=>c.key),rules:[{id:'boolean-setting',when:{all:[{field:'k9',op:'eq',value:'Global.EnablePricing'}]},column:'Value',constraints:{type:'boolean',storage:'string',required:true}},{id:'numeric-setting',when:{all:[{field:'k9',op:'eq',value:'Size'}]},column:'Value',constraints:{type:'integer',storage:'string',min:0,max:100,required:true}}]});
 const row=Object.fromEntries(columns.map(c=>[c.key,c.key==='k9'?'Global.EnablePricing':c.key==='Value'?'false':'scope']));
 assert.deepEqual(validateGridRow(data,row),[]);assert.equal(coerceGridChanges(data,row,{Value:'true'}).Value,'true');assert.throws(()=>coerceGridChanges(data,row,{Value:'yes'}),/boolean/);
 assert.equal(coerceGridChanges(data,row,{k9:'Size',Value:'25'}).Value,'25');assert.throws(()=>coerceGridChanges(data,row,{k9:'Size',Value:'1.5'}),/integer/);
 assert.throws(()=>coerceGridChanges(data,row,{k9:'Size',Value:'0x2'}),/integer/);
});

test('manual settings require viewer access, exact allowed paths and current source; persist independently of producer sequences',async()=>{
 const f=await fixture();
 try {
  const registration=await(await f.call('/api/agents/register',secrets.ingestToken,{requestId:'configuration',registrationKey:'synthetic-private-proof-for-component-config',agentId:'config',name:'Synthetic configuration'})).json();
  const component={id:'metric',title:'Metric',kind:'metric',data:{value:42,unit:'ms'},configuration:{manualFields:['data.unit','configuration.presentation'],presentation:{color:'#abcdef'}}};
  assert.equal((await f.call(`/api/agents/${registration.runId}/publish`,registration.runToken,{sequence:1,operations:[{op:'upsert',component}]})).status,200);
  const path=`/api/agents/${registration.runId}/components/metric/configure`, request={expected:component,changes:{'data.unit':'seconds'}};
  for(const token of ['',registration.runToken,secrets.ingestToken])assert.equal((await f.call(path,token,request)).status,401);
  assert.equal((await f.call(path,secrets.viewerToken,{...request,changes:{'configuration.manualFields':['data.value']}})).status,403);
  assert.equal((await f.call(path,secrets.viewerToken,{...request,changes:{'data.unit':{script:'x'}}})).status,400);
  assert.equal((await f.call(path,secrets.viewerToken,request)).status,200);
  assert.equal((await f.call(path,secrets.viewerToken,request)).status,409);
  const snapshot=await(await f.call('/api/snapshot',secrets.viewerToken)).json(), agent=snapshot.agents.find((a:any)=>a.id===registration.runId);
  assert.equal(agent.sequence,1);assert.equal(agent.components.metric.data.unit,'seconds');
  assert.equal((await f.call(`/api/agents/${registration.runId}/publish`,registration.runToken,{sequence:2,operations:[{op:'context',text:'Agent continues normally'}]})).status,200);
  await f.call(`/api/agents/${registration.runId}/archive`,registration.runToken,{});
  const archive=await(await f.call(`/api/archives/${registration.runId}`,secrets.viewerToken)).json();assert.equal(archive.components.metric.data.unit,'seconds');
 }finally{await f.close();}
});

test('grid action rules reject invalid direct requests before queueing and preserve full compound row identity',async()=>{
 const f=await fixture();
 try {
  const r=await(await f.call('/api/agents/register',secrets.ingestToken,{requestId:'grid-constraints',registrationKey:'synthetic-private-proof-for-grid-constraints',agentId:'grid',name:'Synthetic grid'})).json();
  const config=await(await f.call(`/api/agents/${r.runId}/controls`,r.runToken,{actions:[{id:'edit',label:'Edit',kind:'edit',target:'agent'}]},'PUT')).json();
  const data={columns:[{key:'Instance',label:'Instance'},{key:'Key',label:'Key'},{key:'Value',label:'Value',editable:true}],keyColumns:['Instance','Key'],editAction:'edit',rows:[{Instance:'example',Key:'Global.EnablePricing',Value:'false'}],rules:[{id:'enable',column:'Value',when:{all:[{field:'Key',op:'eq',value:'Global.EnablePricing'}]},constraints:{type:'boolean',storage:'string',required:true}}]};
  await f.call(`/api/agents/${r.runId}/publish`,r.runToken,{sequence:1,operations:[{op:'upsert',component:{id:'settings',title:'Settings',kind:'data-grid',data}}]});
  const invoke=(id:string,value:string)=>f.call(`/api/controls/${r.runId}/invoke`,secrets.viewerToken,{requestId:id,actionId:'edit',definitionVersion:config.version,input:{operation:'update',componentId:'settings',row:{Instance:'example',Key:'Global.EnablePricing',Value:value},rows:[{Instance:'example',Key:'Global.EnablePricing',Value:value}],rowKey:{Instance:'example',Key:'Global.EnablePricing'}}});
  assert.equal((await invoke('bad','yes')).status,400);assert.equal((await invoke('good','true')).status,200);
  const jobs=await(await f.call(`/api/agents/${r.runId}/actions/poll`,r.runToken,{})).json();assert.equal(jobs.length,1);assert.equal(jobs[0].input.row.Value,'true');assert.deepEqual(jobs[0].input.rowKey,{Instance:'example',Key:'Global.EnablePricing'});
 }finally{await f.close();}
});
