import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, rmdirSync, lstatSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

test('actual connector polls immediately after serial acknowledged work, backs off idle/errors, and preserves once', { timeout: 15000 }, async () => {
  const dir=mkdtempSync(join(tmpdir(),'agenticview-cadence-'));
  const log=join(dir,'input.log'), profile=join(dir,'connector.json');
  writeFileSync(log,'original entry\n');
  let polls=0, firstAttempts=0, lastAck=0, idleAt=0, errorAt=0, mode:'continuous'|'once'='continuous';
  const completions:Record<string, unknown>[]=[];
  const events:string[]=[];
  let finish!:()=>void, fail!:(e:unknown)=>void;
  const finished=new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;});
  // Install a rejection handler before any HTTP callback can fail.
  void finished.catch(()=>{});
  const job=(id:string)=>({id,claimToken:`claim-${id}`,handler:'tail',kind:'logs',input:{}});
  const server=createServer((request,response)=>{
    void (async()=>{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
      const send=(value:unknown,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
      if(request.url==='/api/connectors/register'){send({token:'synthetic-connector-token'});return;}
      assert.equal(request.headers.authorization,'Bearer synthetic-connector-token');
      if(request.url?.endsWith('/sessions/poll')){send([]);return;}
      if(request.url?.endsWith('/complete')){
        events.push(`complete:${body.invocationId}`);completions.push(body);
        assert.equal(body.state,'succeeded');
        if(mode==='continuous'&&body.invocationId==='one'&&++firstAttempts===1){
          // A lost acknowledgement must retry the same result, never reread the handler.
          writeFileSync(log,'changed after execution\n');send({error:'synthetic lost acknowledgement'},503);return;
        }
        if(mode==='continuous'&&body.invocationId==='two'){
          assert.equal(polls,1,'no repoll before all batch acknowledgements');
          await new Promise(resolve=>setTimeout(resolve,80));
          assert.equal(polls,1,'completion acknowledgement remains serial');lastAck=performance.now();
        }
        send({acknowledged:true});return;
      }
      assert.equal(request.url,'/api/connectors/cadence/poll');polls++;events.push(`poll:${polls}`);
      if(mode==='once'){assert.equal(polls,1);send([job('once')]);return;}
      if(polls===1){send([job('one'),job('two')]);return;}
      if(polls===2){
        assert.ok(performance.now()-lastAck<800,'acknowledged work must not incur the previous 1000ms idle delay');
        assert.deepEqual(events,['poll:1','complete:one','complete:one','complete:two','poll:2']);
        assert.deepEqual(completions[0],completions[1],'acknowledgement retry retains the original execution result');
        idleAt=performance.now();send([]);return;
      }
      if(polls===3){assert.ok(performance.now()-idleAt>=900,'empty poll retains one-second backoff');errorAt=performance.now();send({error:'synthetic HTTP failure'},503);return;}
      assert.equal(polls,4);assert.ok(performance.now()-errorAt>=900,'HTTP failure retains one-second backoff');send([]);finish();
    })().catch(error=>{fail(error);if(!response.headersSent)response.writeHead(500);response.end('{}');});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  writeFileSync(profile,JSON.stringify({id:'cadence',url:`http://127.0.0.1:${address.port}`,ingestionKey:'synthetic-ingestion-key-long-enough-for-test',handlers:{tail:{type:'log-file',path:log}}}));
  const start=(single:boolean)=>{
    const child=spawn('dotnet',[resolve(process.env.AV_TEST_SERVER||'src/AgenticView.Server/bin/Release/net10.0/AgenticView.Server.dll'),'--connector',profile,...(single?['--once']:[])],{windowsHide:true,stdio:'pipe'});
    let output='';child.stdout.on('data',chunk=>{output=(output+chunk).slice(-4000);});child.stderr.on('data',chunk=>{output=(output+chunk).slice(-4000);});
    child.on('error',fail);return {child,output:()=>output};
  };
  let running:ReturnType<typeof start>|undefined;
  try{
    running=start(false);
    const premature=once(running.child,'exit').then(()=>{throw Error(`Worker exited before completion: ${running?.output()}`);});
    await Promise.race([finished,premature,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Bounded connector fixture timeout')),11000);timer.unref();})]);
    const stopped=once(running.child,'exit');running.child.kill();await stopped;
    mode='once';polls=0;completions.length=0;
    running=start(true);const [code]=await once(running.child,'exit');assert.equal(code,0,running.output());
    assert.equal(polls,1);assert.equal(completions.length,1);assert.equal(completions[0]!.invocationId,'once');
  }finally{
    if(running&&running.child.exitCode===null&&running.child.signalCode===null){const exited=once(running.child,'exit');running.child.kill();await exited;}
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    // Remove only the two files created by this fixture, then its empty directory.
    // Unknown files or links retain the fixture instead of authorizing a sweep.
    assert.equal(lstatSync(dir).isSymbolicLink(),false);assert.equal(dirname(realpathSync(dir)),realpathSync(tmpdir()));
    for(const file of [log,profile]){assert.equal(dirname(file),dir);assert.equal(lstatSync(file).isSymbolicLink(),false);rmSync(file);}
    rmdirSync(dir);
  }
});
