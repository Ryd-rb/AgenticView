import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentTree } from '../shared/agent-tree.ts';
import type { AgentView } from '../shared/protocol.ts';

function run(id:string,parentId:string|null=null):AgentView {
  return {id,agentId:id,name:id,role:'Agent',context:'Synthetic tree',parentId,createdAt:1,lastSeen:1,status:'active',sequence:0,components:{},layout:{x:0,y:0,width:480,height:420,z:1,locked:false}};
}

test('unchanged tree branches, children and root lists retain identities',()=>{
  const a=run('a'),b=run('b','a'),c=run('c','b'),d=run('d');
  const input=[a,b,c,d]; Object.freeze(input);
  const first=buildAgentTree(input); const next=buildAgentTree([a,b,c,d],first);
  assert.deepEqual(input.map(agent=>agent.id),['a','b','c','d']);
  assert.equal(next.roots,first.roots);
  for(const agent of [a,b,c,d]) {
    assert.equal(next.nodes.get(agent.id),first.nodes.get(agent.id));
    assert.equal(next.nodes.get(agent.id)!.children,first.nodes.get(agent.id)!.children);
    assert.equal(next.nodes.get(agent.id)!.agent,agent);
  }
  assert.deepEqual(next.nodes.get('a')!.children.map(n=>n.agent.id),['b']);
});

test('changed descendant invalidates ancestors only, preserving unaffected sibling branches',()=>{
  const a=run('a'),b=run('b','a'),c=run('c','b'),s=run('s','a'),d=run('d');
  const first=buildAgentTree([a,b,c,s,d]); const changed={...c,lastSeen:2};
  const next=buildAgentTree([a,b,changed,s,d],first);
  for(const id of ['a','b','c']) assert.notEqual(next.nodes.get(id),first.nodes.get(id));
  for(const id of ['s','d']) assert.equal(next.nodes.get(id),first.nodes.get(id));
  assert.equal(next.roots,first.roots,'root AgentView membership unchanged by descendant update');
  assert.equal(next.nodes.get('c')!.children,first.nodes.get('c')!.children,'unchanged empty children reused');
  assert.equal(first.nodes.get('c')!.agent,c);
  assert.equal(next.nodes.get('b')!.children[0].agent,changed);
});

test('orphan arrival, reparent, removal and restoration preserve exact tree membership',()=>{
  const orphan=run('child','missing'),other=run('other');
  const first=buildAgentTree([orphan,other]); assert.deepEqual(first.roots.map(a=>a.id),['child','other']);
  const parent=run('missing'); const second=buildAgentTree([orphan,other,parent],first);
  assert.deepEqual(second.roots.map(a=>a.id),['other','missing']);
  assert.equal(second.nodes.get('missing')!.children[0].agent,orphan);
  const moved={...orphan,parentId:'other'}; const third=buildAgentTree([moved,other,parent],second);
  assert.equal(third.nodes.get('missing')!.children.length,0); assert.equal(third.nodes.get('other')!.children[0].agent,moved);
  assert.equal(second.nodes.get('missing')!.children[0].agent,orphan,'previous tree remains unchanged');
  const fourth=buildAgentTree([moved,parent],third);
  assert.deepEqual(fourth.roots.map(a=>a.id),['child','missing']); assert.equal(fourth.nodes.has('other'),false);
  const fifth=buildAgentTree([moved,parent,other],fourth);
  assert.deepEqual(fifth.roots.map(a=>a.id),['missing','other']); assert.equal(fifth.nodes.get('other')!.children[0].agent,moved);
  assert.equal(buildAgentTree([],fifth).nodes.size,0);
});

test('ordered child/root lists change when input order changes',()=>{
  const a=run('a'),b=run('b','a'),c=run('c','a'),d=run('d');
  const first=buildAgentTree([a,b,c,d]); const next=buildAgentTree([d,a,c,b],first);
  assert.deepEqual(next.roots.map(a=>a.id),['d','a']);
  assert.deepEqual(next.nodes.get('a')!.children.map(n=>n.agent.id),['c','b']);
  assert.equal(next.nodes.get('b'),first.nodes.get('b')); assert.equal(next.nodes.get('d'),first.nodes.get('d'));
});

test('root AgentView replacement refreshes roots while stable child branches survive',()=>{
  const root=run('root'),child=run('child','root'); const first=buildAgentTree([root,child]);
  const changed={...root,status:'stale' as const}; const next=buildAgentTree([changed,child],first);
  assert.notEqual(next.roots,first.roots); assert.equal(next.roots[0],changed);
  assert.notEqual(next.nodes.get('root'),first.nodes.get('root'));
  assert.equal(next.nodes.get('root')!.children,first.nodes.get('root')!.children);
  assert.equal(next.nodes.get('child'),first.nodes.get('child'));
});
