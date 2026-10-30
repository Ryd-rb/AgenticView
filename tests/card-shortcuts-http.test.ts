import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, secrets } from './server-fixture.ts';

test('operator MCP configures persisted shortcuts without resetting other settings or granting scoped keys authority',async()=>{
 let f=await fixture();const directory=f.dir, client=new Client({name:'synthetic-shortcuts',version:'1'});
 try{
  const defaults=await(await f.call('/api/settings',secrets.viewerToken,{staleSeconds:120,autoArchiveMinutes:null,archiveAfterCompletion:false,trustedEmbeds:false,reducedMotion:true},'PUT')).json();
  const shortcut={id:'workbench',label:' Workbench ',cardId:'synthetic-card',chord:'shift + control + k',mode:'maximize'};
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',f.url),{requestInit:{headers:{Authorization:`Bearer ${secrets.ingestToken}`}}}));
  const bad=await client.callTool({name:'view_configure',arguments:{operatorToken:secrets.ingestToken,operation:'shortcuts',input:{shortcuts:[shortcut]}}});assert.equal(bad.isError,true);
  const configured=await client.callTool({name:'view_configure',arguments:{operatorToken:secrets.viewerToken,operation:'shortcuts',input:{shortcuts:[shortcut]}}});assert.ok(!configured.isError,JSON.stringify(configured));
  const settings=configured.structuredContent as any;assert.equal(settings.staleSeconds,120);assert.equal(settings.autoArchiveMinutes,null);assert.equal(settings.reducedMotion,true);assert.deepEqual(settings.cardShortcuts,[{...shortcut,label:'Workbench',chord:'Ctrl+Shift+K'}]);
  const duplicate=await f.call('/api/settings',secrets.viewerToken,{...defaults,cardShortcuts:[shortcut,{...shortcut,id:'duplicate',chord:'Ctrl+Shift+K'}]},'PUT');assert.equal(duplicate.status,400);
  for(const cardShortcuts of [[{...shortcut,chord:'a'}],[{...shortcut,mode:'execute'}],Array.from({length:33},(_,i)=>({...shortcut,id:`id-${i}`,chord:`Ctrl+${i}`}))])assert.equal((await f.call('/api/settings',secrets.viewerToken,{...defaults,cardShortcuts},'PUT')).status,400);
  await client.close();await f.close(false);f=await fixture(directory);
  const snapshot=await(await f.call('/api/snapshot',secrets.viewerToken)).json();assert.deepEqual(snapshot.settings.cardShortcuts,settings.cardShortcuts);assert.equal(snapshot.settings.staleSeconds,120);
 }finally{await client.close().catch(()=>{});await f.close();}
});
