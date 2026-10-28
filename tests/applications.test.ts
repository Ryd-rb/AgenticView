import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, secrets } from './server-fixture.ts';
import { AgenticViewClient } from '../clients/client.ts';
import { applicationManifestSchema } from '../shared/application-manifest.ts';

const authored = () => JSON.parse(readFileSync('examples/applications/service-console.agenticview.json','utf8'));
const proof='synthetic-private-application-import-proof';
const payload=(requestId='manual',connector='worker-a')=>({manifest:authored(),bindings:{service:connector},requestId,registrationKey:proof});
test('manual application import binds local workers and exact retries preserve the live card',async()=>{
  const f=await fixture();try{
    const body=payload();const response=await f.call('/api/applications/import',secrets.viewerToken,body);assert.equal(response.status,200);const imported=await response.json();assert.ok(imported.runId);assert.equal(imported.runToken,undefined);
    const snapshot=await(await f.call('/api/snapshot',secrets.viewerToken)).json();const app=snapshot.agents.find((a:{id:string})=>a.id===imported.runId);assert.equal(app.application.id,'service-console');assert.equal(app.components.actions.kind,'action-panel');assert.equal(app.layout.width,640);
    const config=await(await f.call(`/api/controls/${app.id}`,secrets.viewerToken)).json();assert.equal(config.actions[0].target,'worker-a');assert.equal(config.actions[1].confirmation,'Restart the configured service?');
    assert.deepEqual(await(await f.call(`/api/controls/${app.id}/history`,secrets.viewerToken)).json(),[],'Import must not dispatch commands');
    const retry=await(await f.call('/api/applications/import',secrets.viewerToken,body)).json();assert.equal(retry.runId,app.id);assert.equal((await(await f.call('/api/snapshot',secrets.viewerToken)).json()).agents.length,1);
    assert.equal((await f.call('/api/applications/import',secrets.viewerToken,{...body,bindings:{service:'changed'}})).status,409);
    const exported=await f.call(`/api/applications/${app.id}/export`,secrets.viewerToken);assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition')??'',/attachment/);const definition=await exported.json();assert.ok(applicationManifestSchema.safeParse(definition).success);assert.equal(definition.actions[0].target,'service');assert.ok(!JSON.stringify(definition).includes('worker-a'));assert.ok(!JSON.stringify(definition).includes(proof));
  }finally{await f.close();}
});
test('agent import/export and authored definitions exclude live telemetry and survive restart',async()=>{
  let f=await fixture();const dir=f.dir;try{
    const body=payload('agent');const response=await f.call('/api/applications/import',secrets.ingestToken,body);const imported=await response.json();assert.ok(imported.runToken);
    const publish=await f.call(`/api/agents/${imported.runId}/publish`,imported.runToken,{sequence:2,operations:[{op:'upsert',component:{id:'private-live',title:'Local evidence',kind:'logs',data:{entries:[{message:'PRIVATE_SYNTHETIC_TELEMETRY'}]}}}]});assert.equal(publish.status,200);
    const exported=await(await f.call(`/api/agents/${imported.runId}/application`,imported.runToken)).json();assert.ok(!JSON.stringify(exported).includes('PRIVATE_SYNTHETIC'));assert.equal(exported.components.length,3);
    const next={...authored(),version:'1.1.0'};assert.equal((await f.call(`/api/agents/${imported.runId}/application`,'wrong',next,'PUT')).status,403);assert.equal((await f.call(`/api/agents/${imported.runId}/application`,imported.runToken,next,'PUT')).status,200);
    await f.close(false);f=await fixture(dir);const after=await(await f.call(`/api/applications/${imported.runId}/export`,secrets.viewerToken)).json();assert.equal(after.version,'1.1.0');
    const retry=await(await f.call('/api/applications/import',secrets.ingestToken,body)).json();assert.equal(retry.sequence,2);assert.equal((await(await f.call(`/api/applications/${imported.runId}/export`,secrets.viewerToken)).json()).version,'1.1.0','Late import retry must not overwrite a newer template');
    assert.equal((await f.call('/api/applications',secrets.ingestToken)).status,401);assert.equal((await f.call(`/API/APPLICATIONS/${imported.runId}/EXPORT/`)).status,401);
  }finally{await f.close(true);}
});
test('the same repository definition imports into separate installations with different bindings',async()=>{
  const a=await fixture(),b=await fixture();try{
    const first=await(await a.call('/api/applications/import',secrets.viewerToken,payload('first','first-worker'))).json();const manifest=await(await a.call(`/api/applications/${first.runId}/export`,secrets.viewerToken)).json();
    const second=await(await b.call('/api/applications/import',secrets.viewerToken,{...payload('second','second-worker'),manifest})).json();assert.notEqual(first.runId,second.runId);const config=await(await b.call(`/api/controls/${second.runId}`,secrets.viewerToken)).json();assert.equal(config.actions[0].target,'second-worker');const definition=await(await b.call(`/api/applications/${second.runId}/export`,secrets.viewerToken)).json();assert.deepEqual(definition,manifest);
  }finally{await a.close();await b.close();}
});
test('invalid manifests and unresolved bindings fail before creating a card',async()=>{
  const f=await fixture();try{
    assert.equal((await f.call('/api/applications/import','',payload())).status,401);
    const invalid=[{...payload(),bindings:{}},{...payload(),bindings:{service:'agent'}},{...payload(),manifest:{...authored(),runToken:'must-not-enter-templates'}},{...payload(),manifest:{...authored(),schemaVersion:2}},{...payload(),manifest:{...authored(),actions:[{...authored().actions[0],target:'undeclared'}]}},{...payload(),manifest:{...authored(),components:[{id:'bad',kind:'log-stream',title:'Bad',data:{actionId:'restart'}}]}}];
    for(const body of invalid){assert.equal((await f.call('/api/applications/import',secrets.viewerToken,body)).status,400);}
    const expansion=payload();expansion.manifest.components=Array.from({length:8},(_,i)=>({id:'logs-'+i,title:'Template',kind:'logs',data:{entries:Array.from({length:2000},()=>({message:''}))}}));assert.ok(Buffer.byteLength(JSON.stringify(expansion.manifest))<262144);assert.equal((await f.call('/api/applications/import',secrets.viewerToken,expansion)).status,413,'Normalized exports must remain importable');
    assert.equal((await(await f.call('/api/snapshot',secrets.viewerToken)).json()).agents.length,0);
  }finally{await f.close();}
});
test('official MCP and TypeScript clients import and export repository applications',async()=>{
  const f=await fixture(),mcp=new Client({name:'synthetic-application-agent',version:'1'});try{
    await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp',f.url),{requestInit:{headers:{Authorization:`Bearer ${secrets.ingestToken}`}}}));const imported=await mcp.callTool({name:'application_import',arguments:payload('mcp')});assert.ok(!imported.isError,JSON.stringify(imported));const credentials=imported.structuredContent as{runId:string;runToken:string};const exported=await mcp.callTool({name:'application_export',arguments:credentials});assert.ok(!exported.isError);assert.equal((exported.structuredContent as{id:string}).id,'service-console');
    const defined=await mcp.callTool({name:'application_define',arguments:{...credentials,manifest:{...authored(),version:'2.0.0'}}});assert.ok(!defined.isError);assert.equal((defined.structuredContent as{version:string}).version,'2.0.0');
    const client=await AgenticViewClient.importApplication(f.url,secrets.ingestToken,applicationManifestSchema.parse(authored()),{service:'sdk-worker'},{requestId:'sdk',registrationKey:proof});await client.display({id:'metric',title:'Rows',kind:'metric',data:{value:1}});assert.equal((await client.exportApplication()).id,'service-console');
  }finally{await mcp.close();await f.close();}
});
test('application lists return bounded remote pages even with maximum-length descriptions',async()=>{
  const f=await fixture();try{
    for(let i=0;i<30;i++){const body=payload('page-'+i);body.manifest.description='界'.repeat(2000);const response=await f.call('/api/applications/import',secrets.viewerToken,body);assert.equal(response.status,200);}
    const first=await f.call('/api/applications?limit=2000',secrets.viewerToken);const text=await first.text();assert.ok(Buffer.byteLength(text)<1048576);const page=JSON.parse(text);assert.equal(page.length,25);const next=await(await f.call('/api/applications?offset=25&limit=25',secrets.viewerToken)).json();assert.equal(next.length,5);assert.ok(!next.some((b:{runId:string})=>page.some((a:{runId:string})=>a.runId===b.runId)));
  }finally{await f.close();}
});
