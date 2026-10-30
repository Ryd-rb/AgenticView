import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture,secrets } from './server-fixture.ts';
import { cardDisplaySchema } from '../shared/card-display.ts';

test('scoped and operator MCP display configuration preserves sequence, layout, permissions and restart state',async()=>{
 let f=await fixture();const directory=f.dir,mcp=new Client({name:'synthetic-display',version:'1'});
 try{
  const register=(requestId:string)=>f.call('/api/agents/register',secrets.ingestToken,{requestId,registrationKey:'synthetic-card-display-private-proof',agentId:requestId,name:'Synthetic display'});
  const a=await(await register('display-a')).json(),b=await(await register('display-b')).json(),path=`/api/agents/${a.runId}/display`;
  const display={chrome:{configure:{visible:false},archive:{label:'Retain',appearance:'text',placement:'footer'},navigation:{placement:'bottom-left'},times:{visible:false}},componentLayout:{mode:'columns',columns:3,gap:8}};
  for(const token of ['',secrets.viewerToken,b.runToken])assert.ok([401,403].includes((await f.call(path,token,display,'PUT')).status));
  await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp',f.url),{requestInit:{headers:{Authorization:`Bearer ${secrets.ingestToken}`}}}));
  const ack=await mcp.callTool({name:'card_display',arguments:{...a,display}});assert.ok(!ack.isError,JSON.stringify(ack));assert.deepEqual(ack.structuredContent,display);
  const before=await(await f.call('/api/snapshot',secrets.viewerToken)).json(),current=before.agents.find((x:any)=>x.id===a.runId);
  assert.deepEqual(current.chrome,display.chrome);assert.equal(current.sequence,0);assert.deepEqual(current.components,{});
  const override={mode:'vertical',minWidth:240};
  const bad=await mcp.callTool({name:'view_configure',arguments:{operatorToken:secrets.ingestToken,operation:'display',input:{cardId:a.runId,display:{componentLayout:override}}}});assert.equal(bad.isError,true);
  const operator=await mcp.callTool({name:'view_configure',arguments:{operatorToken:secrets.viewerToken,operation:'display',input:{cardId:a.runId,display:{componentLayout:override}}}});assert.ok(!operator.isError,JSON.stringify(operator));
  assert.deepEqual((operator.structuredContent as any).chrome,display.chrome);
  for(const invalid of [{chrome:{unknown:{visible:false}}},{chrome:{fit:{onclick:'bad'}}},{chrome:{fit:{visible:null}}},{componentLayout:{columns:0}},{componentLayout:{mode:'bad'}},{componentLayout:{minWidth:199}},{componentLayout:{gap:33}},JSON.parse('{"chrome":{"__proto__":{}}}')]){
   assert.equal(cardDisplaySchema.safeParse(invalid).success,false);assert.equal((await f.call(path,a.runToken,invalid,'PUT')).status,400,JSON.stringify(invalid));
  }
  await mcp.close();await f.close(false);f=await fixture(directory);
  const after=(await(await f.call('/api/snapshot',secrets.viewerToken)).json()).agents.find((x:any)=>x.id===a.runId);
  assert.deepEqual(after.chrome,display.chrome);assert.deepEqual(after.componentLayout,override);assert.deepEqual(after.layout,current.layout);assert.equal(after.sequence,0);
  assert.equal((await f.call(path,a.runToken,{chrome:{}},'PUT')).status,200);
  await f.call(`/api/agents/${a.runId}/archive`,a.runToken,{});
  assert.equal((await f.call(path,a.runToken,{componentLayout:{columns:9}},'PUT')).status,400);
  assert.equal((await(await f.call('/api/snapshot',secrets.viewerToken)).json()).agents.some((x:any)=>x.id===a.runId),false,'Invalid configuration must not restore archived cards');
 }finally{await mcp.close().catch(()=>{});await f.close();}
});

test('portable authored card and component control settings import and export without live state',async()=>{
 const f=await fixture();try{
  const manifest=JSON.parse(readFileSync('examples/applications/configurable-workbench.agenticview.json','utf8'));
  manifest.chrome={lock:{visible:false},navigation:{placement:'bottom-right'}};manifest.componentLayout={mode:'columns',columns:2};
  manifest.components[0].configuration={...manifest.components[0].configuration,controls:{configure:{label:'Edit options',appearance:'both',placement:'header'}}};
  const response=await f.call('/api/applications/import',secrets.ingestToken,{manifest,bindings:{},requestId:'display-portable',registrationKey:'synthetic-private-portable-display-proof'});assert.equal(response.status,200,await response.clone().text());
  const {runId}=await response.json(),live=(await(await f.call('/api/snapshot',secrets.viewerToken)).json()).agents.find((x:any)=>x.id===runId);
  assert.deepEqual(live.chrome,manifest.chrome);assert.deepEqual(live.componentLayout,manifest.componentLayout);
  const authored=await(await f.call(`/api/applications/${runId}/export`,secrets.viewerToken)).json();assert.deepEqual(authored.chrome,manifest.chrome);assert.deepEqual(authored.components[0].configuration.controls,manifest.components[0].configuration.controls);assert.equal(authored.runToken,undefined);
 }finally{await f.close();}
});
