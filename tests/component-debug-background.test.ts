import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, secrets } from './server-fixture.ts';

test('operator background leases require desktop capability and same-session native readiness; stop and failures never replay', {timeout:40000}, async()=>{
 const f=await fixture(),mcp=new Client({name:'synthetic-background',version:'1'});let running=true,viewer:Promise<void>|undefined;
 const claims:any[]=[];let activate=true, fail=false, hold=false;
 async function json(r:Response){const text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text);}
 async function tool(name:string,args:Record<string,unknown>){const r=await mcp.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent as any;}
 try{
  await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp',f.url),{requestInit:{headers:{Authorization:`Bearer ${secrets.ingestToken}`}}}));
  const register=await f.call('/api/agents/register',secrets.ingestToken,{requestId:'background-run',registrationKey:'synthetic-background-registration-proof-0123456789',agentId:'background-run',name:'Background synthetic'});
  assert.equal(register.status,201);const {runId,runToken}=await register.json() as any;
  const base={operatorToken:secrets.viewerToken,cardId:runId};
  assert.equal((await tool('ui_test_open',{...base,operatorToken:runToken})).status,403);
  assert.equal((await tool('ui_test_open',{...base,width:319})).status,400);
  assert.equal((await tool('ui_test_open',{...base,height:4097})).status,400);
  assert.equal((await tool('ui_test_open',{...base,durationSeconds:7201})).status,400);
  const body:any={clientId:randomUUID(),clientToken:'synthetic-background-proof-0123456789',cardIds:[runId],visible:false,platform:'browser',backgroundTesting:true,background:{state:'inactive'}};
  await json(await f.call('/api/debug/poll',secrets.viewerToken,body));
  assert.equal((await tool('ui_test_open',base)).status,409,'browser capability claim cannot acquire native lease');
  body.platform='desktop';body.backgroundTesting=false;await json(await f.call('/api/debug/poll',secrets.viewerToken,body));
  assert.equal((await tool('ui_test_open',base)).status,409);
  body.backgroundTesting=true;await json(await f.call('/api/debug/poll',secrets.viewerToken,body));
  assert.equal((await tool('ui_open',{runId,runToken})).status,409,'ordinary hidden open still denied');
  assert.equal((await f.call('/api/debug/poll','',body)).status,401);
  assert.equal((await f.call('/api/debug/poll',secrets.viewerToken,{...body,clientToken:'wrong-proof-01234567890123456789012345'})).status,403);
  viewer=(async()=>{while(running){
   let poll=await json(await f.call('/api/debug/poll',secrets.viewerToken,body));
   if(poll.sessions.length){
    const session=poll.sessions.find((s:any)=>s.background);
    if(session){assert.deepEqual(session.background,{width:1920,height:1080});
     if(body.background.state==='inactive'){assert.equal(poll.jobs.length,0,'no claim before exact native active ack');if(activate)body.background={state:'active',sessionId:session.id};}
     if(fail){body.background={state:'failed',sessionId:session.id,error:'Synthetic native activation failure'};fail=false;}
    }
   }else if(body.background.state!=='inactive'&&!hold){body.background={state:'inactive',sessionId:body.background.sessionId};}
   for(const job of poll.jobs){claims.push(job);if(hold)continue;
    const result=job.command.operation==='inspect'?{components:[{id:'chart',targets:[{ref:'eSyntheticTarget',role:'button',name:'Safe series',actions:['click'],visible:true}]}]}:{synthetic:true};
    await json(await f.call('/api/debug/complete',secrets.viewerToken,{clientId:body.clientId,clientToken:body.clientToken,commandId:job.id,claimToken:job.claimToken,state:'succeeded',result}));
   }
   await new Promise(r=>setTimeout(r,15));
  }})();
  const opened=await tool('ui_test_open',base);assert.equal(opened.state,'succeeded',JSON.stringify(opened));assert.equal(opened.targets[0].ref,'eSyntheticTarget');
  const debugId=opened.debugId,sessionId=debugId.split('.')[0];
  let status=await tool('ui_test_status',{debugId});assert.equal(status.state,'running');assert.equal(status.physicalVisible,false);assert.equal(status.lastNativeAck.sessionId,sessionId);
  assert.ok(!JSON.stringify(opened).includes(runToken));assert.ok(!JSON.stringify(opened).includes(body.clientToken));
  assert.equal((await tool('ui_test_open',{...base,width:2000})).status,409);
  const retry=await tool('ui_test_open',base);assert.equal(retry.debugId,debugId,'reuse does not create another lease');
  const clicked=await tool('ui_action',{debugId,requestId:opened.nextActionId,action:'click',targetRef:'eSyntheticTarget'});assert.equal(clicked.state,'succeeded');
  const before=claims.length;assert.equal((await tool('ui_action',{debugId,requestId:opened.nextActionId,action:'click',targetRef:'eSyntheticTarget'})).commandId,clicked.commandId);assert.equal(claims.length,before);
  assert.equal((await f.call('/api/debug/poll',secrets.viewerToken,{...body,background:{state:'active',sessionId:randomUUID()}})).status,403);
  hold=true;const queued=await tool('component_debug_command',{runId,runToken,sessionId,requestId:'held-job',command:{operation:'metrics'}});
  for(let i=0;i<100&&!claims.some(j=>j.id===queued.id);i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(claims.some(j=>j.id===queued.id));
  const closed=await tool('ui_close',{debugId});assert.equal(closed.state,'stopping');assert.equal(closed.nextCall.tool,'ui_test_status');
  assert.equal((await tool('component_debug_result',{runId,runToken,sessionId,commandId:queued.id})).state,'unknown');
  assert.equal((await tool('ui_test_open',base)).status,409,'stop acknowledgment required before reuse');
  hold=false;for(let i=0;i<100;i++){status=await tool('ui_test_status',{debugId});if(status.state==='stopped')break;await new Promise(r=>setTimeout(r,15));}assert.equal(status.state,'stopped');
  fail=true;activate=true;const failed=await tool('ui_test_open',base);assert.ok(['cancelled','unknown'].includes(failed.state),JSON.stringify(failed));
  const failure=await tool('ui_test_status',{debugId:failed.debugId});assert.ok(['failed','stopped'].includes(failure.state));
  running=false;await viewer;viewer=undefined;
  const terminal=await json(await f.call('/api/debug/poll',secrets.viewerToken,{...body,cardIds:[],backgroundTesting:false,background:{state:'inactive',sessionId:failed.debugId.split('.')[0]}}));
  assert.deepEqual(terminal.jobs,[]);assert.deepEqual(terminal.sessions,[],'terminal native poll withdraws capabilities before disconnect');
  await json(await f.call('/api/debug/disconnect',secrets.viewerToken,{clientId:body.clientId,clientToken:body.clientToken}));
  const stoppedFailure=await tool('ui_test_status',{debugId:failed.debugId});assert.equal(stoppedFailure.stopAcknowledged,true);assert.equal(stoppedFailure.state,'failed');assert.ok(stoppedFailure.nativeFailure,'disconnect preserves the original native failure');
  const replacement={...body,clientId:randomUUID(),clientToken:'replacement-native-client-proof-0123456789'};
  assert.equal((await f.call('/api/debug/poll',secrets.viewerToken,{...replacement,background:{state:'inactive',sessionId:failed.debugId.split('.')[0]}})).status,403,'replacement identity must not inherit an old session acknowledgment');
  assert.equal((await f.call('/api/debug/poll',secrets.viewerToken,{...replacement,background:{state:'inactive'}})).status,200);
 }finally{running=false;await viewer;await mcp.close();await f.close();}
});


test('background expiry cancels pending work and restart requires a fresh native acknowledgment', {timeout:30000}, async()=>{
 let f=await fixture(),client=new Client({name:'background-restart',version:'1'});
 const dir=f.dir;
 async function connect(){await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',f.url),{requestInit:{headers:{Authorization:`Bearer ${secrets.ingestToken}`}}}));}
 async function tool(name:string,args:Record<string,unknown>){const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent as any;}
 async function poll(body:unknown){const r=await f.call('/api/debug/poll',secrets.viewerToken,body);assert.equal(r.status,200,await r.clone().text());return await r.json() as any;}
 try{
  await connect();const r=await f.call('/api/agents/register',secrets.ingestToken,{requestId:'bg-restart',registrationKey:'synthetic-background-restart-proof-0123456789',agentId:'bg-restart',name:'Background restart'});assert.equal(r.status,201);const {runId,runToken}=await r.json() as any;
  const body:any={clientId:randomUUID(),clientToken:'synthetic-background-restart-proof-0123456789',cardIds:[runId],visible:false,platform:'desktop',backgroundTesting:true,background:{state:'inactive'}};
  await poll(body);
  const pending=tool('ui_test_open',{operatorToken:secrets.viewerToken,cardId:runId,durationSeconds:30});
  let opened:any;
  void pending.then(value=>{opened=value;});
  for(let i=0;i<200&&!opened;i++){
   const p=await poll(body);if(p.sessions[0])body.background={state:'active',sessionId:p.sessions[0].id};
   for(const job of p.jobs){const done=await f.call('/api/debug/complete',secrets.viewerToken,{clientId:body.clientId,clientToken:body.clientToken,commandId:job.id,claimToken:job.claimToken,state:'succeeded',result:job.command.operation==='inspect'?{components:[]}: {}});assert.equal(done.status,200);}
   await new Promise(r=>setTimeout(r,15));
  }
  opened=await pending;assert.equal(opened.state,'succeeded');const debugId=opened.debugId,sessionId=debugId.split('.')[0];
  const claimed=await tool('component_debug_command',{runId,runToken,sessionId,requestId:'restart-claim',command:{operation:'metrics'}});assert.equal((await poll(body)).jobs[0].id,claimed.id);
  await client.close();await f.close(false);f=await fixture(dir);client=new Client({name:'background-restarted',version:'1'});await connect();
  assert.equal((await tool('component_debug_result',{runId,runToken,sessionId,commandId:claimed.id})).state,'unknown');
  const queued=await tool('component_debug_command',{runId,runToken,sessionId,requestId:'after-restart',command:{operation:'metrics'}});
  assert.deepEqual((await poll({...body,background:{state:'inactive',sessionId}})).jobs,[],'old active acknowledgment does not survive restart');
  assert.equal((await poll(body)).jobs[0].id,queued.id,'fresh exact native ack releases new work');
  await tool('ui_close',{debugId});await poll({...body,background:{state:'inactive',sessionId}});
  const expired=await tool('ui_test_open',{operatorToken:secrets.viewerToken,cardId:runId,durationSeconds:1});
  assert.equal(expired.state,'cancelled');assert.equal(expired.backgroundStatus.state,'stopping');
  assert.deepEqual((await poll({...body,background:{state:'inactive'}})).jobs,[]);
  assert.equal((await tool('ui_test_status',{debugId:expired.debugId})).state,'stopped');
 }finally{await client.close();await f.close(true);}
});
