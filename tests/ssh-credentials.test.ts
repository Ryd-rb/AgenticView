import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,secrets} from './server-fixture.ts';

test('SSH vault persists encrypted reusable credentials with machine-specific rejection and connector-only retrieval',async()=>{
 const f=await fixture();try{
  const connection={id:'stage-a',label:'Synthetic stage A',host:'stage-a.example.invalid',port:22,connectorId:'worker-a',username:'synthetic-account',password:'synthetic-password-do-not-echo',credentialLabel:'Shared staging login'};
  assert.equal((await f.call('/api/ssh/machines',secrets.ingestToken,connection,'PUT')).status,401);
  const first=await(await f.call('/api/ssh/machines',secrets.viewerToken,connection,'PUT')).json();assert.ok(first.credentialId);assert.equal(first.password,undefined);assert.equal(first.expiresAt,undefined);
  const second=await(await f.call('/api/ssh/machines',secrets.viewerToken,{id:'stage-b',label:'Synthetic stage B',host:'stage-b.example.invalid',connectorId:'worker-a',credentialId:first.credentialId},'PUT')).json();assert.equal(second.username,first.username);
  const listing=await(await f.call('/api/ssh/machines',secrets.viewerToken)).text();assert.ok(!listing.includes(connection.password));assert.ok(listing.includes('Shared staging login'));
  for(const name of ['controls.sqlite','controls.sqlite-wal'])if(existsSync(join(f.dir,name)))assert.equal(readFileSync(join(f.dir,name)).includes(Buffer.from(connection.password)),false,'password must not be present in SQLite/WAL plaintext');
  const worker=await(await f.call('/api/connectors/register',secrets.ingestToken,{id:'worker-a',name:'Synthetic worker',registrationKey:'synthetic-worker-registration-key-private'})).json();
  const acquire=(machine:string,body:any={},token=worker.token)=>f.call(`/api/connectors/worker-a/ssh/${machine}/acquire`,token,body);
  assert.equal((await acquire('stage-a',{},secrets.viewerToken)).status,403);assert.equal((await acquire('stage-a',{host:'different.example.invalid'})).status,409);
  const acquired=await acquire('stage-a',{host:connection.host,port:22});assert.equal(acquired.headers.get('cache-control'),'no-store');assert.equal((await acquired.json()).password,connection.password);
  assert.equal((await f.call('/api/connectors/worker-a/ssh/stage-a/reject',worker.token,{credentialVersion:'stale-version'})).status,200);assert.equal((await acquire('stage-a')).status,200);
  await f.call('/api/connectors/worker-a/ssh/stage-a/reject',worker.token,{credentialVersion:first.credentialVersion});assert.equal((await acquire('stage-a')).status,409);assert.equal((await acquire('stage-b')).status,200);
  const replacement=await(await f.call('/api/ssh/machines',secrets.viewerToken,{...connection,password:'synthetic-new-password'},'PUT')).json();assert.notEqual(replacement.credentialVersion,first.credentialVersion);await f.call('/api/connectors/worker-a/ssh/stage-a/reject',worker.token,{credentialVersion:first.credentialVersion});assert.equal((await acquire('stage-a')).status,200,'late failure must not invalidate replacement credentials');
  await f.call(`/api/ssh/credentials/${first.credentialId}`,secrets.viewerToken,undefined,'DELETE');assert.equal((await acquire('stage-b')).status,409);assert.equal((await acquire('stage-a')).status,200);
 }finally{await f.close();}
});
