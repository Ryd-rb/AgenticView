import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture,secrets } from './server-fixture.ts';

const proof='synthetic-private-debug-client-proof-0123456789';
async function json(response:Response,status=200){const text=await response.text();assert.equal(response.status,status,text);assert.ok(text.length,`Empty response from ${response.url}`);return JSON.parse(text);}
async function register(f:Awaited<ReturnType<typeof fixture>>,name:string){return json(await f.call('/api/agents/register',secrets.ingestToken,{requestId:name,registrationKey:'synthetic-private-debug-run-registration-proof',agentId:name,name}),201);}
async function mcp(f:Awaited<ReturnType<typeof fixture>>){const client=new Client({name:'synthetic-debug-tests',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',f.url),{requestInit:{headers:{Authorization:`Bearer ${secrets.ingestToken}`}}}));return client;}
async function tool(client:Client,name:string,args:Record<string,unknown>,error=false){const response=await client.callTool({name,arguments:args});assert.equal(!!response.isError,error,JSON.stringify(response));return response.structuredContent as any;}

test('debug API scopes clients/leases to owning runs and enforces typed commands, claims and exact retries',async()=>{
  const f=await fixture(),client=await mcp(f);
  try{
    const a=await register(f,'debug-a'),b=await register(f,'debug-b'),clientId=randomUUID();
    const body={clientId,clientToken:proof,cardIds:[a.runId],visible:true,platform:'desktop'};
    assert.equal((await f.call('/api/debug/poll','',body)).status,401);
    assert.equal((await f.call('/API/DEBUG/POLL/',secrets.ingestToken,body)).status,401);
    assert.equal((await f.call('/api/debug/poll',secrets.viewerToken,{...body,selector:'body'})).status,400);
    const initial=await json(await f.call('/api/debug/poll',secrets.viewerToken,body));assert.deepEqual(initial.jobs,[]);assert.equal(initial.pollMs,5000);
    assert.equal((await f.call('/api/debug/poll',secrets.viewerToken,{...body,clientToken:proof+'wrong'})).status,403);
    const catalog=await tool(client,'component_debug_catalog',{});assert.ok(catalog.operations.includes('profile'));assert.equal(catalog.limits.claimSeconds,90);assert.equal(catalog.limits.commandsPerSession,256);
    await tool(client,'component_debug_clients',{...a,runToken:'wrong'},true);
    assert.equal((await tool(client,'component_debug_clients',b)).clients.length,0,'An agent cannot discover clients advertising only another run');
    const listed=await tool(client,'component_debug_clients',a);assert.equal(listed.clients.length,1);assert.equal(listed.clients[0].clientId,clientId);assert.equal(listed.clients[0].cardIds,undefined);assert.equal(listed.clients[0].clientToken,undefined);
    await tool(client,'component_debug_open',{...b,clientId,requestId:'unadvertised'},true);
    const open={...a,clientId,requestId:'open',durationSeconds:30};
    const session=await tool(client,'component_debug_open',open),retry=await tool(client,'component_debug_open',open);assert.equal(session.id,retry.id);
    await tool(client,'component_debug_open',{...open,durationSeconds:31},true);
    await tool(client,'component_debug_command',{...b,sessionId:session.id,requestId:'wrong-scope',command:{operation:'metrics'}},true);
    const invalid=[{operation:'eval',script:'alert(1)'},{operation:'click',componentId:'grid',target:{selector:'button'}},{operation:'input',componentId:'grid',target:{role:'textbox'},value:'x'.repeat(2001)},{operation:'key',componentId:'grid',target:{},key:'F12'},{operation:'styles',componentId:'grid',properties:['background-image']},{operation:'profile',durationSeconds:31},{operation:'scroll',componentId:'grid',x:100001,y:0},{operation:'inspect',limit:101},{operation:'navigate',mode:'https://example.invalid'}];
    for(const [index,command] of invalid.entries())await tool(client,'component_debug_command',{...a,sessionId:session.id,requestId:'invalid-'+index,command},true);
    const request={...a,sessionId:session.id,requestId:'inspect-1',command:{operation:'inspect',componentId:'grid',includeText:true,limit:10}};
    const queued=await tool(client,'component_debug_command',request);assert.equal(queued.state,'queued');assert.equal(queued.claimToken,undefined);
    assert.equal((await tool(client,'component_debug_command',request)).id,queued.id);
    await tool(client,'component_debug_command',{...request,command:{operation:'metrics'}},true);
    const second=await tool(client,'component_debug_command',{...a,sessionId:session.id,requestId:'metrics-2',command:{operation:'metrics'}});
    const hidden=await json(await f.call('/api/debug/poll',secrets.viewerToken,{...body,visible:false}));assert.deepEqual(hidden.jobs,[]);assert.equal(hidden.pollMs,250);
    const claimed=await json(await f.call('/api/debug/poll',secrets.viewerToken,body));assert.equal(claimed.jobs.length,1);assert.equal(claimed.jobs[0].id,queued.id);assert.equal(claimed.jobs[0].runId,a.runId);assert.equal(claimed.jobs[0].command.operation,'inspect');assert.ok(claimed.jobs[0].deadline>Date.now());assert.equal(claimed.pollMs,250);
    assert.equal(JSON.stringify(claimed).includes(a.runToken),false);assert.equal(JSON.stringify(claimed).includes(proof),false);
    assert.deepEqual((await json(await f.call('/api/debug/poll',secrets.viewerToken,body))).jobs,[],'A client can claim only one command at a time');
    const completion={clientId,clientToken:proof,commandId:queued.id,claimToken:claimed.jobs[0].claimToken,state:'succeeded',result:{items:[{role:'table',name:'Synthetic grid'}],count:1}};
    assert.equal((await f.call('/api/debug/complete',secrets.viewerToken,{...completion,claimToken:'wrong-private-claim-token-0123456789'})).status,403);
    assert.equal((await f.call('/api/debug/complete',secrets.viewerToken,{...completion,result:{text:'x'.repeat(65536)}})).status,413);
    await json(await f.call('/api/debug/complete',secrets.viewerToken,completion));await json(await f.call('/api/debug/complete',secrets.viewerToken,completion));
    assert.equal((await f.call('/api/debug/complete',secrets.viewerToken,{...completion,result:{count:2}})).status,409);
    const result=await tool(client,'component_debug_result',{...a,sessionId:session.id,commandId:queued.id});assert.equal(result.state,'succeeded');assert.deepEqual(result.result,completion.result);assert.equal(result.claimToken,undefined);assert.equal(result.completionDigest,undefined);
    const next=await json(await f.call('/api/debug/poll',secrets.viewerToken,body));assert.equal(next.jobs[0].id,second.id);
    await json(await f.call('/api/debug/disconnect',secrets.viewerToken,{clientId,clientToken:proof}));
    assert.equal((await tool(client,'component_debug_result',{...a,sessionId:session.id,commandId:second.id})).state,'unknown');
    await tool(client,'component_debug_command',{...a,sessionId:session.id,requestId:'after-close',command:{operation:'metrics'}},true);
    assert.equal((await tool(client,'component_debug_command',request)).id,queued.id,'Exact retry identity remains retained after closing');
    for(const suffix of ['','-wal'])if(existsSync(join(f.dir,'controls.sqlite'+suffix)))assert.equal(readFileSync(join(f.dir,'controls.sqlite'+suffix)).includes(Buffer.from(proof)),false,'Client proof is hashed at rest');
  }finally{await client.close();await f.close();}
});

test('debug claimed commands become unknown across restart and lease expiry, never queued again',async()=>{
  let f=await fixture(),client=await mcp(f);const directory=f.dir;
  try{
    const a=await register(f,'restart-debug'),clientId=randomUUID(),body={clientId,clientToken:proof,cardIds:[a.runId],visible:true,platform:'browser'};
    await json(await f.call('/api/debug/poll',secrets.viewerToken,body));
    const session=await tool(client,'component_debug_open',{...a,clientId,requestId:'restart-lease',durationSeconds:30});
    const job=await tool(client,'component_debug_command',{...a,sessionId:session.id,requestId:'before-restart',command:{operation:'metrics'}});
    await json(await f.call('/api/debug/poll',secrets.viewerToken,body));
    await client.close();await f.close(false);f=await fixture(directory);client=await mcp(f);
    assert.equal((await tool(client,'component_debug_result',{...a,sessionId:session.id,commandId:job.id})).state,'unknown');
    assert.deepEqual((await json(await f.call('/api/debug/poll',secrets.viewerToken,body))).jobs,[]);
    const short=await tool(client,'component_debug_open',{...a,clientId,requestId:'short-lease',durationSeconds:1});
    const running=await tool(client,'component_debug_command',{...a,sessionId:short.id,requestId:'short-running',command:{operation:'focus',componentId:'grid',target:{role:'textbox',index:0}}});
    const claim=(await json(await f.call('/api/debug/poll',secrets.viewerToken,body))).jobs[0];assert.equal(claim.id,running.id);
    const pending=await tool(client,'component_debug_command',{...a,sessionId:short.id,requestId:'short-queued',command:{operation:'metrics'}});
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal((await tool(client,'component_debug_result',{...a,sessionId:short.id,commandId:running.id})).state,'unknown');
    assert.equal((await tool(client,'component_debug_result',{...a,sessionId:short.id,commandId:pending.id})).state,'cancelled');
    assert.equal((await f.call('/api/debug/complete',secrets.viewerToken,{clientId,clientToken:proof,commandId:running.id,claimToken:claim.claimToken,state:'succeeded',result:{}})).status,409);
    assert.deepEqual((await json(await f.call('/api/debug/poll',secrets.viewerToken,body))).jobs,[]);
    const closed=await tool(client,'component_debug_close',{...a,sessionId:session.id});assert.equal(closed.state,'closed');
  }finally{await client.close();await f.close(true);}
});

test('debug history cap rejects new command identities while preserving exact retries and scope',{timeout:30000},async()=>{
  const f=await fixture(),client=await mcp(f);
  try{
    const a=await register(f,'bounded-debug'),clientId=randomUUID(),body={clientId,clientToken:proof,cardIds:[a.runId],visible:true,platform:'browser'};
    await json(await f.call('/api/debug/poll',secrets.viewerToken,body));
    const session=await tool(client,'component_debug_open',{...a,clientId,requestId:'bounded-lease',durationSeconds:30});
    const request={...a,sessionId:session.id,command:{operation:'metrics'}};let first:any;
    for(let index=0;index<256;index++){
      const command=await tool(client,'component_debug_command',{...request,requestId:'bounded-'+index});if(index===0)first=command;
    }
    await tool(client,'component_debug_command',{...request,requestId:'over-cap'},true);
    assert.equal((await tool(client,'component_debug_command',{...request,requestId:'bounded-0'})).id,first.id,'Capacity never evicts an old identity and allows it to execute again');
    await tool(client,'component_debug_close',{...a,sessionId:session.id});
    assert.equal((await tool(client,'component_debug_result',{...a,sessionId:session.id,commandId:first.id})).state,'cancelled');
    assert.equal((await json(await f.call('/api/debug/poll',secrets.viewerToken,body))).pollMs,5000);
  }finally{await client.close();await f.close();}
});
