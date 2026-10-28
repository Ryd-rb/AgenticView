import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fixture, secrets} from './server-fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const proof='synthetic-recovery-registration-key-private';
const originalBinary=process.env.AV_TEST_SERVER;
let directory:string, binary:string, adapter:string;
before(()=>{
  directory=mkdtempSync(join(tmpdir(),'agenticview-session-regressions-'));
  const source=resolve(originalBinary||'src/AgenticView.Server/bin/Release/net10.0/AgenticView.Server.dll');
  cpSync(dirname(source),join(directory,'server'),{recursive:true});binary=join(directory,'server',basename(source));process.env.AV_TEST_SERVER=binary;
  const project=join(directory,'SyntheticAuthenticatedSsh.csproj');mkdirSync(join(directory,'empty-nuget'));
  writeFileSync(project,'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><NuGetAudit>false</NuGetAudit></PropertyGroup></Project>');
  // An authenticated remote command may independently fail with SSH's conventional 255 code.
  writeFileSync(join(directory,'Program.cs'),'Console.ReadLine();Console.WriteLine("{\\\"agenticviewSshAuthenticated\\\":true}");Console.Out.Flush();Console.Error.WriteLine("Permission denied opening synthetic file");return 255;');
  for(const args of [['restore',project,'--source',join(directory,'empty-nuget'),'--ignore-failed-sources','--nologo'],['build',project,'-c','Release','--no-restore','--nologo']]){
    const result=spawnSync('dotnet',args,{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1000000});assert.equal(result.status,0,result.stdout+result.stderr);
  }
  adapter=join(directory,'bin','Release','net10.0',process.platform==='win32'?'SyntheticAuthenticatedSsh.exe':'SyntheticAuthenticatedSsh');
});
after(()=>{
  if(originalBinary===undefined)delete process.env.AV_TEST_SERVER;else process.env.AV_TEST_SERVER=originalBinary;
  if(!directory)return;
  if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('agenticview-session-regressions-')||lstatSync(directory).isSymbolicLink())throw new Error('Unsafe regression cleanup target');
  rmSync(directory,{recursive:true});
});
async function json(response:Response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function launcher(f:Fixture,connection?:object){
  const a=await json(await f.call('/api/agents/register',secrets.ingestToken,{requestId:'launcher',registrationKey:proof,agentId:'launcher',name:'Synthetic recovery launcher'}),201);
  await json(await f.call(`/api/agents/${a.runId}/controls`,a.runToken,{application:{name:'Synthetic recovery launcher'},actions:[{id:'launch',label:'Synthetic session',kind:'session',target:'test-worker',handler:'synthetic',fields:[],...(connection?{connection}:{})}]},'PUT'));return a;
}
async function draft(f:Fixture,runId:string,index:number){const request={requestId:'draft-'+index,launcherRunId:runId,actionId:'launch'};return {request,s:await json(await f.call('/api/sessions/draft',secrets.viewerToken,request))};}
const control=(f:Fixture,id:string,request:object)=>jsonResponse(f.call(`/api/sessions/${id}/control`,secrets.viewerToken,request));
async function jsonResponse(response:Promise<Response>){return json(await response);}
async function connector(f:Fixture){return json(await f.call('/api/connectors/register',secrets.ingestToken,{id:'test-worker',name:'Synthetic worker',registrationKey:proof}),201);}
async function poll(f:Fixture,token:string){return json(await f.call('/api/connectors/test-worker/sessions/poll',token,{owner:'synthetic-owner'}));}
async function report(f:Fixture,token:string,job:any,requestId:string,outcome='completed'){
  return json(await f.call(`/api/connectors/test-worker/sessions/${job.id}/report`,token,{owner:'synthetic-owner',claimToken:job.claimToken,generation:job.generation,reportId:requestId,entries:[],outcome}));
}
async function waitFor(check:()=>Promise<boolean>|boolean,label:string,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Deadline: '+label);}
async function stop(child:ChildProcess|undefined){if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}}
function worker(f:Fixture,profile:object,url=f.url){const path=join(f.dir,'connector.json');writeFileSync(path,JSON.stringify({id:'test-worker',name:'Synthetic worker',url,ingestionKey:secrets.ingestToken,registrationKey:proof,handlers:{synthetic:profile}}));return spawn('dotnet',[binary,'--connector',path],{windowsHide:true,stdio:['ignore','pipe','pipe']});}

test('eight paused or stopped claims release on stale-generation terminal ACK and do not starve a ninth session',async()=>{
  const f=await fixture();try{
    const a=await launcher(f),c=await connector(f);
    for(let i=0;i<8;i++){const {s}=await draft(f,a.runId,i);await control(f,s.id,{requestId:'start-'+i,operation:'start',prompt:'Synthetic task'});}
    const jobs=await poll(f,c.token);assert.equal(jobs.length,8);
    for(const [i,job]of jobs.entries())await control(f,job.id,{requestId:'stop-'+i,operation:i%2?'pause':'stop'});
    const {s:ninth}=await draft(f,a.runId,9);await control(f,ninth.id,{requestId:'start-nine',operation:'start',prompt:'Ninth task'});
    for(const [i,job]of jobs.entries())await report(f,c.token,job,'terminal-'+i,i%2?'paused':'stopped');
    const next=await poll(f,c.token);assert.deepEqual(next.map((j:any)=>j.id),[ninth.id]);
    for(const [i,job]of jobs.entries())await report(f,c.token,job,'terminal-'+i,i%2?'paused':'stopped');
  }finally{await f.close();}
});

test('retrying an acknowledged control after completion returns the same turn without scheduling execution',async()=>{
  const f=await fixture();try{
    const a=await launcher(f),{s}=await draft(f,a.runId,0),c=await connector(f);
    const start={requestId:'start-once',operation:'start',prompt:'Do this once'};await control(f,s.id,start);
    let [job]=await poll(f,c.token);await report(f,c.token,job,'first-completed');
    assert.equal((await control(f,s.id,start)).state,'completed');assert.deepEqual(await poll(f,c.token),[]);
    const followup={requestId:'follow-up-once',operation:'prompt',prompt:'Follow up once'};await control(f,s.id,followup);
    [job]=await poll(f,c.token);await report(f,c.token,job,'followup-completed');
    const repeated=await control(f,s.id,followup);assert.equal(repeated.state,'completed');assert.equal(repeated.attempt,2);assert.deepEqual(await poll(f,c.token),[]);
    assert.equal((await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{...followup,prompt:'changed'})).status,409);
  }finally{await f.close();}
});

test('draft retry repairs missing card projection while retaining existing authored content',async()=>{
  const f=await fixture();try{
    const a=await launcher(f),{s,request}=await draft(f,a.runId,0);
    // Simulate the independently persisted projection being absent after an interrupted publish.
    const db=new DatabaseSync(join(f.dir,'controls.sqlite'),{readOnly:true});let token:string;
    try{token=JSON.parse((db.prepare('SELECT payload FROM sessions WHERE id=?').get(s.id) as {payload:string}).payload).runToken;}finally{db.close();}
    const snapshot=await json(await f.call('/api/snapshot',secrets.viewerToken)),card=snapshot.agents.find((v:any)=>v.id===s.runId);
    await json(await f.call(`/api/agents/${s.runId}/publish`,token!,{sequence:card.sequence+1,operations:[{op:'remove',componentId:'session-plan'},{op:'remove',componentId:'session-console'},{op:'upsert',component:{id:'retained',title:'Retained work',kind:'markdown',data:{text:'Synthetic authored progress'}}}]}));
    const retried=await json(await f.call('/api/sessions/draft',secrets.viewerToken,request));assert.equal(retried.id,s.id);assert.equal(retried.state,'draft');
    const repaired=(await json(await f.call('/api/snapshot',secrets.viewerToken))).agents.find((v:any)=>v.id===s.runId);
    assert.equal(repaired.components['session-console'].data.sessionId,s.id);assert.ok(repaired.components['session-plan']);assert.equal(repaired.components.retained.data.text,'Synthetic authored progress');
  }finally{await f.close();}
});

test('healthy polling never replays a finished provider while completion delivery is uncertain', {timeout:25000},async()=>{
  const f=await fixture();let child:ChildProcess|undefined;let rejected=0,pollsAfterFailure=0,block=true;const reportIds=new Set<string>();
  const proxy=createServer(async(req,res)=>{try{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks);
    const input=body.length?JSON.parse(body.toString()):{};
    if(req.url?.endsWith('/report')&&input.outcome){reportIds.add(input.reportId);if(block){rejected++;res.writeHead(503);res.end('{}');return;}}
    if(req.url?.endsWith('/sessions/poll')&&rejected)pollsAfterFailure++;
    const response=await fetch(f.url+req.url,{method:req.method,headers:{Authorization:req.headers.authorization||'','Content-Type':'application/json'},body:body.length?body:undefined});res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());
  }catch{res.writeHead(500);res.end('{}');}});
  try{
    proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const address=proxy.address();assert.ok(address&&typeof address!=='string');
    const a=await launcher(f),{s}=await draft(f,a.runId,0),count=join(f.dir,'starts.txt'),script=join(f.dir,'once.cjs');
    writeFileSync(script,`const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(count)},'start\\n');console.log('Synthetic task complete');});`);
    child=worker(f,{type:'agent-session',provider:'custom',executable:process.execPath,arguments:[script],maxTurnSeconds:10},`http://127.0.0.1:${address.port}`);let logs='';child.stderr!.on('data',x=>logs=(logs+x).slice(-4000));child.stdout!.on('data',()=>{});
    await control(f,s.id,{requestId:'uncertain-start',operation:'start',prompt:'Synthetic once-only side effect'});
    await waitFor(()=>pollsAfterFailure>=3,'three healthy polls after rejected completion',16000);
    assert.ok(rejected>=3);assert.equal(readFileSync(count,'utf8'),'start\n',logs);assert.equal(reportIds.size,1,'completion retries retain the report identity');
    block=false;await waitFor(async()=> (await json(await f.call(`/api/sessions/${s.id}`,secrets.viewerToken))).state==='completed','completion eventually acknowledged');
    assert.equal(readFileSync(count,'utf8'),'start\n');assert.equal(reportIds.size,1);
  }finally{block=false;await stop(child);await new Promise<void>(done=>proxy.close(()=>done()));await f.close();}
});

test('authenticated remote provider exit 255 and permission-denied stderr preserve the saved SSH credential', {timeout:15000},async()=>{
  const f=await fixture();let child:ChildProcess|undefined;try{
    const saved=await json(await f.call('/api/ssh/machines',secrets.viewerToken,{id:'synthetic-machine',label:'Synthetic machine',host:'synthetic-host',connectorId:'test-worker',username:'synthetic-user',password:'synthetic-password-preserved',credentialLabel:'Reusable synthetic account'},'PUT'));
    const a=await launcher(f,{machineId:saved.id}),{s}=await draft(f,a.runId,0);
    child=worker(f,{type:'agent-session',transport:'ssh',provider:'custom',sshExecutable:adapter,sshHost:'synthetic-host',machineId:saved.id,remoteCommand:['fixed-synthetic-bridge'],maxTurnSeconds:10});child.stdout!.on('data',()=>{});child.stderr!.on('data',()=>{});
    await control(f,s.id,{requestId:'auth-boundary-start',operation:'start',prompt:'Synthetic remote failure'});
    await waitFor(async()=>{const record=await json(await f.call(`/api/sessions/${s.id}`,secrets.viewerToken));return record.state==='error'&&record.recoveryCount>=2;},'bounded synthetic failure');
    const listing=await json(await f.call('/api/ssh/machines',secrets.viewerToken));const machine=listing.machines.find((m:any)=>m.id===saved.id);assert.equal(machine.valid,true);assert.equal(machine.credentialVersion,saved.credentialVersion);
    assert.equal(JSON.stringify(listing).includes('synthetic-password-preserved'),false);
  }finally{await stop(child);await f.close();}
});
