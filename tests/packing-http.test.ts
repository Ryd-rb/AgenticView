import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,secrets } from './server-fixture.ts';

test('Arrange all defaults to a square after a wide override, includes manual unlocked cards and persists locked geometry',async()=>{
 let f=await fixture();const directory=f.dir;
 try{
  const ids:string[]=[];let lockedId='';
  for(let i=0;i<10;i++){
   const response=await f.call('/api/agents/register',secrets.ingestToken,{requestId:`square-${i}`,registrationKey:'synthetic-square-packing-registration-proof',agentId:`square-${i}`,name:'Synthetic square'});
   assert.equal(response.status,201);const {runId}=await response.json();if(i===9)lockedId=runId;else ids.push(runId);
   const placed=await f.call(`/api/agents/${runId}/layout`,secrets.viewerToken,{x:i===9?9_000_000:10000+i*1000,y:i===9?8_000_000:20000,width:480,height:480,z:i+1,sizing:i%2?'fixed':'content',automatic:false,locked:i===9},'PATCH');
   assert.equal(placed.status,200,await placed.clone().text());
  }
  const snapshot=async()=>await(await f.call('/api/snapshot',secrets.viewerToken)).json();
  const before=await snapshot(),locked=before.agents.find((a:any)=>a.id===lockedId).layout;
  assert.equal((await f.call('/api/layout/pack',secrets.viewerToken,{mode:'all',aspectRatio:4})).status,200);
  const arranged=await f.call('/api/layout/pack',secrets.viewerToken,{mode:'all'});assert.equal(arranged.status,200);const ack=await arranged.json();assert.equal(ack.arranged,9);
  assert.deepEqual(ack.bounds,{x:0,y:0,width:9_000_480,height:8_000_480});
  const after=await snapshot(),cards=after.agents.filter((a:any)=>ids.includes(a.id)),layouts=cards.map((a:any)=>a.layout);
  assert.deepEqual(after.agents.find((a:any)=>a.id===lockedId).layout,locked);
  const width=Math.max(...layouts.map((r:any)=>r.x+r.width))-Math.min(...layouts.map((r:any)=>r.x));
  const height=Math.max(...layouts.map((r:any)=>r.y+r.height))-Math.min(...layouts.map((r:any)=>r.y));
  assert.equal(width,1472);assert.equal(height,1472);
  for(const card of cards){const prior=before.agents.find((a:any)=>a.id===card.id).layout;assert.equal(card.layout.width,prior.width);assert.equal(card.layout.height,prior.height);assert.equal(card.layout.sizing,prior.sizing);assert.equal(card.layout.automatic,true);}
  for(let i=0;i<layouts.length;i++)for(let j=i+1;j<layouts.length;j++){const a=layouts[i],b=layouts[j];assert.ok(a.x+a.width+16<=b.x||b.x+b.width+16<=a.x||a.y+a.height+16<=b.y||b.y+b.height+16<=a.y);}
  await f.close(false);f=await fixture(directory);const restored=await snapshot();
  for(const card of after.agents)assert.deepEqual(restored.agents.find((a:any)=>a.id===card.id).layout,card.layout);
 }finally{await f.close();}
});
