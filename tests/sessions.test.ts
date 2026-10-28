import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fixture,secrets} from './server-fixture.ts';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

const proof='synthetic-session-registration-key-private';
async function setup(f:Awaited<ReturnType<typeof fixture>>, confirmation='') {
  const registration=await f.call('/api/agents/register',secrets.ingestToken,{requestId:'launcher',registrationKey:proof,agentId:'launcher',name:'Synthetic launcher'}); assert.equal(registration.status,201,await registration.clone().text());const a=await registration.json();
  const configured=await f.call(`/api/agents/${a.runId}/controls`,a.runToken,{application:{name:'Synthetic launcher'},actions:[{id:'launch',label:'Synthetic agent',kind:'session',target:'test-worker',handler:'synthetic',confirmation,fields:[]}]},'PUT'); assert.equal(configured.status,200,await configured.clone().text());const config=await configured.json();
  const request={requestId:'draft-one',launcherRunId:a.runId,actionId:'launch'};
  const response=await f.call('/api/sessions/draft',secrets.viewerToken,request); assert.equal(response.status,200,await response.clone().text());
  return {a,config,request,s:await response.json()};
}
test('session draft is nonexecuting, persistent, authenticated and deduplicated; controls bind confirmation',async()=>{
  const f=await fixture(); try {
    const {a,config,request,s}=await setup(f,'Start a synthetic CLI?'); assert.equal(s.state,'draft'); assert.equal(s.runToken,undefined); assert.equal(s.claimToken,undefined);
    assert.equal((await f.call('/api/sessions/draft','',request)).status,401);
    assert.equal((await (await f.call('/api/sessions/draft',secrets.viewerToken,request)).json()).id,s.id);
    assert.equal((await f.call('/api/sessions/draft',secrets.viewerToken,{...request,actionId:'other'})).status,409);
    assert.equal((await f.call(`/api/sessions/${s.id}`,a.runToken)).status,401);
    const start={requestId:'start-one',operation:'start',prompt:'Synthetic task'};
    assert.equal((await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,start)).status,409);
    const accepted={...start,confirmed:true,configurationVersion:config.version};
    const running=await (await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,accepted)).json(); assert.equal(running.state,'queued');
    assert.equal((await (await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,accepted)).json()).state,'queued');
    assert.equal((await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{...accepted,prompt:'different'})).status,409);
    const snapshot=await (await f.call('/api/snapshot',secrets.viewerToken)).json(); const card=snapshot.agents.find((v:any)=>v.id===s.runId); assert.ok(card.application); assert.equal(card.components['session-console'].kind,'agent-session');
    assert.equal((await f.call(`/api/sessions/${s.id}/publish`,secrets.ingestToken,{requestId:'wrong',operations:[]})).status,403);
    const exported=await (await f.call(`/api/sessions/${s.id}/export`,secrets.viewerToken)).text(); assert.ok(!exported.includes(a.runToken)); assert.ok(exported.includes('Synthetic task'));
  } finally {await f.close();}
});

test('session reports are atomic, bounded, retryable after lease release and rotate scoped producer tokens',async()=>{
 const f=await fixture();try{
  const {s}=await setup(f);await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{requestId:'bounded-start',operation:'start',prompt:'Synthetic bounded output'});
  const connector=await(await f.call('/api/connectors/register',secrets.ingestToken,{id:'test-worker',name:'Synthetic worker',registrationKey:proof})).json();
  let [job]=await(await f.call('/api/connectors/test-worker/sessions/poll',connector.token,{owner:'owner-one'})).json();assert.ok(job.reportingToken);assert.equal(job.runToken,undefined);
  const publish={requestId:'test-report',operations:[{op:'upsert',component:{id:'progress',title:'Progress',kind:'markdown',data:{text:'- [ ] Inspect synthetic state'}}}]};
  assert.equal((await f.call(`/api/sessions/${s.id}/publish`,job.reportingToken,publish)).status,200);assert.equal((await f.call(`/api/sessions/${s.id}/publish`,job.reportingToken,publish)).status,200);
  const report=(id:string,entries:any[],more:any={})=>({owner:'owner-one',claimToken:job.claimToken,generation:job.generation,reportId:id,entries,...more});
  const entry={stream:'stdout',format:'html',text:'<h1>Synthetic output</h1><script>window.test=1</script>',level:'info'};
  const bad=await f.call(`/api/connectors/test-worker/sessions/${s.id}/report`,connector.token,report('invalid',[entry,{...entry,format:'unsupported'}]));assert.equal(bad.status,400);assert.equal((await(await f.call(`/api/sessions/${s.id}/output`,secrets.viewerToken)).json()).entries.length,0);
  const valid=report('first',[entry],{nativeSessionId:'synthetic-native'});assert.equal((await f.call(`/api/connectors/test-worker/sessions/${s.id}/report`,connector.token,valid)).status,200);assert.equal((await f.call(`/api/connectors/test-worker/sessions/${s.id}/report`,connector.token,valid)).status,200);assert.equal((await f.call(`/api/connectors/test-worker/sessions/${s.id}/report`,connector.token,{...valid,entries:[]})).status,409);
  assert.equal((await f.call(`/api/sessions/${s.id}/output/1/html`)).status,401);const html=await f.call(`/api/sessions/${s.id}/output/1/html`,secrets.viewerToken);assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy')!,/sandbox allow-scripts/);assert.doesNotMatch(html.headers.get('content-security-policy')!,/allow-same-origin/);assert.equal(html.headers.get('cache-control'),'no-store');
  const batch=Array.from({length:100},()=>({...entry,text:'x'.repeat(16000),format:'text'}));
  for(let i=0;i<20;i++){const response=await f.call(`/api/connectors/test-worker/sessions/${s.id}/report`,connector.token,report('window-'+i,batch.slice(0,20)));assert.equal(response.status,200,await response.clone().text());}
  const page=await f.call(`/api/sessions/${s.id}/output`,secrets.viewerToken);const pageText=await page.text();const output=JSON.parse(pageText);assert.ok(output.entries.length<=200);assert.ok(output.next<=401);assert.ok(output.earliest>1);assert.equal(output.truncated,true);assert.ok(Buffer.byteLength(pageText)<270000,'output pages must be byte-bounded independently of row count');
  const completed=report('complete',[],{outcome:'completed'});assert.equal((await f.call(`/api/connectors/test-worker/sessions/${s.id}/report`,connector.token,completed)).status,200);assert.equal((await f.call(`/api/connectors/test-worker/sessions/${s.id}/report`,connector.token,completed)).status,200,'lost completion ACK must be retryable after claim release');
  const oldToken=job.reportingToken;await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{requestId:'next-turn',operation:'prompt',prompt:'A follow-up task'});[job]=await(await f.call('/api/connectors/test-worker/sessions/poll',connector.token,{owner:'owner-one'})).json();assert.notEqual(job.reportingToken,oldToken);assert.equal((await f.call(`/api/sessions/${s.id}/publish`,oldToken,{...publish,requestId:'late-old'})).status,403);
 }finally{await f.close();}
});

test('hub restart restores permanent session cards, queued intent and native identity for follow-up turns',async()=>{
 let f=await fixture();const dir=f.dir;try{
  const {s,request}=await setup(f);await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{requestId:'persist-start',operation:'start',prompt:'Keep synthetic task across restart'});
  const worker=await(await f.call('/api/connectors/register',secrets.ingestToken,{id:'test-worker',name:'Synthetic worker',registrationKey:proof})).json();const [job]=await(await f.call('/api/connectors/test-worker/sessions/poll',worker.token,{owner:'before-restart'})).json();
  await f.call(`/api/connectors/test-worker/sessions/${s.id}/report`,worker.token,{owner:'before-restart',claimToken:job.claimToken,generation:job.generation,reportId:'persist-complete',nativeSessionId:'durable-native-id',entries:[{stream:'stdout',format:'markdown',text:'## Durable output',level:'info'}],outcome:'completed'});
  await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{requestId:'persist-followup',operation:'prompt',prompt:'Continue the synthetic task after restart'});
  await f.close(false);f=await fixture(dir);
  const record=await(await f.call(`/api/sessions/${s.id}`,secrets.viewerToken)).json();assert.equal(record.runId,s.runId);assert.equal(record.nativeSessionId,'durable-native-id');assert.equal(record.desiredState,'running');assert.equal(record.state,'queued');
  assert.equal((await(await f.call('/api/sessions/draft',secrets.viewerToken,request)).json()).id,s.id);
  const [resumed]=await(await f.call('/api/connectors/test-worker/sessions/poll',worker.token,{owner:'after-restart'})).json();assert.equal(resumed.nativeSessionId,'durable-native-id');assert.equal(resumed.recoveryMode,'native');assert.match(resumed.prompt,/after restart/);
  assert.match(await(await f.call(`/api/sessions/${s.id}/output`,secrets.viewerToken)).text(),/Durable output/);
 }finally{await f.close(true);}
});

test('MCP agents preconfigure reusable SSH accounts and launch recipes without exposing passwords',async()=>{
 const f=await fixture(),client=new Client({name:'synthetic-session-configurator',version:'1'});try{
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',f.url),{requestInit:{headers:{Authorization:`Bearer ${secrets.ingestToken}`}}}));
  const call=async(name:string,args:any)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent as any;};
  const a=await call('agent_register',{requestId:'mcp-launcher',registrationKey:proof,agentId:'mcp-launcher',name:'Synthetic launcher'});
  await call('card_style',{runId:a.runId,runToken:a.runToken,icon:'terminal'});const styled=await(await f.call('/api/snapshot',secrets.viewerToken)).json();assert.equal(styled.agents.find((x:any)=>x.id===a.runId).icon,'terminal');
  const catalog=await call('component_catalog',{});assert.ok(catalog.cardStyle.icons.includes('terminal'));assert.ok(catalog.cardStyle.icons.includes('gamepad'));
  const first=await call('ssh_machine_configure',{configuration:{id:'machine-a',label:'Synthetic staging A',host:'stage-a.example.invalid',connectorId:'test-worker',username:'synthetic-account',password:'synthetic-reusable-password',credentialLabel:'Synthetic staging account'}});assert.ok(first.credentialId);assert.ok(!JSON.stringify(first).includes('synthetic-reusable-password'));
  const second=await call('ssh_machine_configure',{configuration:{id:'machine-b',label:'Synthetic staging B',host:'stage-b.example.invalid',connectorId:'test-worker',credentialId:first.credentialId}});assert.equal(second.username,'synthetic-account');assert.equal(second.credentialId,first.credentialId);
  const config=await call('session_launcher_configure',{runId:a.runId,runToken:a.runToken,actionId:'ssh-codex',label:'Synthetic SSH Codex',connectorId:'test-worker',handler:'ssh-agent',machineId:'machine-b',remoteProfileId:'codex'});assert.equal(config.actions[0].connection.machineId,'machine-b');
  const saved=await call('ssh_connections',{});assert.equal(saved.machines.length,2);assert.ok(!JSON.stringify(saved).includes('synthetic-reusable-password'));
  const draft=await(await f.call('/api/sessions/draft',secrets.viewerToken,{requestId:'mcp-created-draft',launcherRunId:a.runId,actionId:'ssh-codex'})).json();assert.equal(draft.state,'draft');assert.equal(draft.connection.remoteProfileId,'codex');
 }finally{await client.close();await f.close();}
});

async function waitSession(f:Awaited<ReturnType<typeof fixture>>,id:string,check:(s:any)=>boolean,ms=20000) {
  const end=Date.now()+ms;let s:any;while(Date.now()<end){s=await(await f.call(`/api/sessions/${id}`,secrets.viewerToken)).json();if(check(s))return s;await new Promise(r=>setTimeout(r,100));}throw new Error('Session deadline: '+JSON.stringify(s));
}
for(const scenario of ['interrupt','stall','pause'] as const) test(`connector ${scenario} preserves card, output and provider recovery semantics`,async()=>{
  const f=await fixture();let worker:ReturnType<typeof spawn>|undefined;
  try {
    const {s}=await setup(f);const script=join(f.dir,'fake-agent.cjs'); const countFile=join(f.dir,'starts.txt');const inputFile=join(f.dir,'last-input.txt');
    writeFileSync(script,`const fs=require('fs');let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',async()=>{const n=fs.existsSync(process.env.COUNT_FILE)?Number(fs.readFileSync(process.env.COUNT_FILE,'utf8'))+1:1;fs.writeFileSync(process.env.COUNT_FILE,''+n);fs.writeFileSync(process.env.INPUT_FILE,input);const resume=process.argv[2]==='resume';console.log(JSON.stringify({type:'session',id:resume?process.argv[3]:'synthetic-native-'+n}));const body={requestId:'plan-'+n,operations:[{op:'upsert',component:{id:'session-plan',title:'Current task list',kind:'markdown',data:{text:'- [x] Inspect synthetic state\\n- [ ] Complete synthetic task'}}}]};await fetch(process.env.AV_URL+'/api/sessions/'+process.env.AV_SESSION_ID+'/publish',{method:'POST',headers:{Authorization:'Bearer '+process.env.AV_SESSION_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body)});if(n===1){if(process.env.SCENARIO==='interrupt'){console.log(JSON.stringify({type:'output',format:'markdown',text:'**Checkpoint retained**'}));process.exitCode=1;}else setInterval(()=>{},10000);}else{console.log(JSON.stringify({type:'output',format:'markdown',text:'## Recovered successfully'}));}});`);
    const profile=join(f.dir,'connector.json');writeFileSync(profile,JSON.stringify({id:'test-worker',name:'Synthetic worker',url:f.url,ingestionKey:secrets.ingestToken,registrationKey:proof,handlers:{synthetic:{type:'agent-session',provider:'custom',executable:process.execPath,workingDirectory:f.dir,arguments:[script,'start'],resumeArguments:[script,'resume','{sessionId}'],silenceTimeoutSeconds:scenario==='stall'?2:0,maxTurnSeconds:30,environment:{SCENARIO:scenario,COUNT_FILE:countFile,INPUT_FILE:inputFile}}}}));
    worker=spawn('dotnet',[resolve(process.env.AV_TEST_SERVER||'src/AgenticView.Server/bin/Release/net10.0/AgenticView.Server.dll'),'--connector',profile],{windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';worker.stderr!.on('data',x=>logs+=x);worker.stdout!.on('data',()=>{});
    const start=await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{requestId:'start-test',operation:'start',prompt:'Inspect synthetic task and publish progress'});assert.equal(start.status,200);
    if(scenario==='pause') {await waitSession(f,s.id,x=>!!x.nativeSessionId);await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{requestId:'pause-test',operation:'pause'});await new Promise(r=>setTimeout(r,1300));await f.call(`/api/sessions/${s.id}/control`,secrets.viewerToken,{requestId:'resume-test',operation:'resume'});}
    const done=await waitSession(f,s.id,x=>x.state==='completed',25000).catch(e=>{throw new Error(String(e)+' '+logs)});assert.equal(done.runId,s.runId);assert.equal(done.nativeSessionId,scenario==='stall'?'synthetic-native-2':'synthetic-native-1');
    assert.equal(Number(readFileSync(countFile,'utf8')),2);
    const output=await(await f.call(`/api/sessions/${s.id}/output`,secrets.viewerToken)).json();assert.ok(output.entries.some((x:any)=>x.text.includes('Recovered successfully')));assert.ok(!JSON.stringify(output).includes(secrets.ingestToken));
    if(scenario==='stall') {assert.equal(done.recoveryMode,'handoff');assert.ok(readFileSync(inputFile,'utf8').includes('Prior monitoring export'));assert.ok(readFileSync(inputFile,'utf8').includes('Inspect synthetic state'));}
    else assert.equal(done.recoveryMode,'native');
    const card=(await(await f.call('/api/snapshot',secrets.viewerToken)).json()).agents.find((x:any)=>x.id===s.runId);assert.ok(card.components['session-plan']);
  } finally {if(worker&&worker.exitCode===null){const ended=once(worker,'exit');worker.kill();await ended;}await f.close();}
});
