import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { fixture,secrets } from './server-fixture.ts';
import { applicationManifestSchema } from '../shared/application-manifest.ts';
import { chartDataSchema } from '../shared/native-extensions.ts';

test('authored high-rate template uses a configured Python provider through typed C# query claims and completion', {timeout:45000},async()=>{
  const f=await fixture();
  try{
    const authored=JSON.parse(readFileSync('examples/applications/high-rate-data.agenticview.json','utf8'));
    assert.ok(applicationManifestSchema.safeParse(authored).success);
    for(const missing of [true,false]){
      const invalid=structuredClone(authored);
      if(missing)invalid.components.find((component:any)=>component.id==='history').data.source.readAction='unavailable';
      else invalid.actions.find((action:any)=>action.id==='range').kind='command';
      assert.equal(applicationManifestSchema.safeParse(invalid).success,false,'Source charts reference a declared query action');
      assert.equal((await f.call('/api/applications/import',secrets.ingestToken,{manifest:invalid,bindings:{data:'invalid-provider'},requestId:'invalid-source-'+missing,registrationKey:'synthetic-invalid-source-registration-proof'})).status,400);
    }
    const database=join(f.dir,'synthetic-series.sqlite'),script=resolve('examples/connector/time-series-service.py');
    const profile=JSON.parse(readFileSync('examples/connector/high-rate-profile.example.json','utf8'));
    const connectorId='integration-series',proof='synthetic-integration-series-registration-proof';
    Object.assign(profile,{id:connectorId,url:f.url,ingestionKey:secrets.ingestToken,registrationKey:proof});
    for(const [name,operation] of [['series-range','read_range'],['series-rows','read_rows'],['series-append','append']] as const){
      profile.handlers[name].arguments=['-B',script,'--database',database,'--operation',operation,...(operation==='read_range'?['--stream','synthetic']:[])];
      assert.equal(profile.handlers[name].input,'json-stdin');assert.equal(profile.handlers[name].output,'json');
    }
    const profilePath=join(f.dir,'provider-profile.json');writeFileSync(profilePath,JSON.stringify(profile));
    const python=(handler:string,input:unknown)=>{
      assert.ok(Object.hasOwn(profile.handlers,handler),'Handler must exist in the configured local allowlist');
      const spec=profile.handlers[handler];
      const child=spawnSync(spec.executable,spec.arguments,{input:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:262144});
      assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);
      return JSON.parse(child.stdout);
    };
    const points=Array.from({length:1000},(_,sequence)=>({stream:'synthetic',sequence,timestamp:sequence,value:sequence===137?1000:sequence===851?-1000:sequence%17}));
    assert.equal(python('series-append',{batchId:'seed-1000',points}).accepted,1000);
    const json=async(response:Response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
    const connector=await json(await f.call('/api/connectors/register',secrets.ingestToken,{id:connectorId,name:profile.name,registrationKey:proof}),201);
    const imported=await json(await f.call('/api/applications/import',secrets.ingestToken,{manifest:authored,bindings:{data:connectorId},requestId:'high-rate-integration',registrationKey:proof}));
    const exportedBefore=await json(await f.call(`/api/applications/${imported.runId}/export`,secrets.viewerToken));
    const normalizedAuthored={...authored,actions:authored.actions.map((action:any)=>({...action,fields:action.fields??[]}))};
    assert.deepEqual(exportedBefore,normalizedAuthored,'Authored export only normalizes omitted action fields to [] and preserves logical definitions');
    assert.equal(exportedBefore.components.find((component:any)=>component.id==='history').configuration.presentation.animation,'none');
    assert.equal(exportedBefore.components.find((component:any)=>component.id==='rows').configuration.presentation.animation,'none');
    const configuration=await json(await f.call(`/api/controls/${imported.runId}`,secrets.viewerToken));
    const range=configuration.actions.find((action:any)=>action.id==='range');
    assert.equal(range.kind,'query');assert.equal(range.target,connectorId);assert.equal(range.handler,'series-range');assert.equal(range.confirmation,undefined);
    assert.deepEqual(range.fields.map((field:any)=>[field.key,field.type,field.required]),[['from','number',true],['to','number',true],['maxPoints','number',true]]);
    const input={from:0,to:999,maxPoints:32};
    const invoke=(actionId:string,input:unknown,requestId:string)=>f.call(`/api/controls/${imported.runId}/invoke`,secrets.viewerToken,{requestId,definitionVersion:configuration.version,actionId,input});
    assert.equal((await invoke('range',{...input,maxPoints:31},'invalid-cap')).status,400,'Declared numeric bounds apply before queueing');
    const invocation=await json(await invoke('range',input,'read-range'));
    assert.equal(invocation.state,'queued');
    assert.equal((await f.call(`/api/connectors/${connectorId}/poll`,secrets.viewerToken,{})).status,403);
    const jobs=await json(await f.call(`/api/connectors/${connectorId}/poll`,connector.token,{}));assert.equal(jobs.length,1);
    const job=jobs[0];assert.equal(job.id,invocation.id);assert.equal(job.handler,'series-range');assert.deepEqual(job.input,input);
    assert.deepEqual(await json(await f.call(`/api/connectors/${connectorId}/poll`,connector.token,{})),[],'An active claim is never automatically redelivered');
    const result=python(job.handler,job.input);
    await json(await f.call(`/api/connectors/${connectorId}/complete`,connector.token,{invocationId:job.id,claimToken:job.claimToken,state:'succeeded',result}));
    const completed=await json(await f.call(`/api/controls/${imported.runId}/invocations/${invocation.id}`,secrets.viewerToken));
    assert.equal(completed.state,'succeeded');assert.equal(completed.claimToken,undefined);assert.equal(completed.result.rawPoints,1000);
    const chart=chartDataSchema.parse({series:completed.result.series});
    assert.equal(chart.series.length,1);const sampled=chart.series[0]!.points;
    assert.ok(sampled.length<=input.maxPoints);assert.deepEqual(sampled[0],{x:0,y:0});assert.deepEqual(sampled.at(-1),{x:999,y:999%17});
    assert.ok(sampled.some(point=>point.x===137&&point.y===1000));assert.ok(sampled.some(point=>point.x===851&&point.y===-1000));
    // The grid additionally traverses the actual C# local-profile runner,
    // including its fixed-argv process allowlist and automatic claim/complete.
    const grid=await json(await invoke('rows',{limit:200,sort:[{key:'timestamp',direction:'asc'}]},'read-rows'));
    const worker=spawnSync('dotnet',[resolve(process.env.AV_TEST_SERVER||'src/AgenticView.Server/bin/Release/net10.0/AgenticView.Server.dll'),'--connector',profilePath,'--once'],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:262144});
    assert.equal(worker.error,undefined);assert.equal(worker.status,0,worker.stdout+worker.stderr);
    const page=await json(await f.call(`/api/controls/${imported.runId}/invocations/${grid.id}`,secrets.viewerToken));
    assert.equal(page.state,'succeeded',JSON.stringify(page));assert.equal(page.result.rows.length,200);assert.equal(page.result.rows[0].sequence,0);assert.equal(page.result.rows.at(-1).sequence,199);assert.ok(page.result.nextCursor);
    const exportedAfter=await json(await f.call(`/api/applications/${imported.runId}/export`,secrets.viewerToken));
    assert.deepEqual(exportedAfter,exportedBefore,'Query observations never enter the authored portable template');
    const serialized=JSON.stringify(exportedAfter);for(const privateValue of [database,script,profilePath,proof,secrets.ingestToken,connector.token])assert.equal(serialized.includes(privateValue),false);
  }finally{await f.close();}
});
