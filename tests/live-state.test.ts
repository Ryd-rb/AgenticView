import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLivePatch, rootAgents } from '../shared/live-state.ts';
import type { AgentView, Snapshot, TaskTiming } from '../shared/protocol.ts';

const agent: AgentView = { id: 'new', agentId: 'synthetic', name: 'Synthetic', role: 'Agent', context: '', parentId: null, createdAt: 1, lastSeen: 1, status: 'active', sequence: 0, components: {}, layout: { x: 0, y: 0, width: 480, height: 420, z: 1, locked: false, automatic: true } };
const empty: Snapshot = { revision: 0, agents: [], settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: true, reducedMotion: false }, stats: { active: 0, stale: 0, archived: 0, updates: 0, updatesPerSecond: 0 } };

test('live arrivals, descendants and recovery form the same visible tree as a snapshot', () => {
  const parent = applyLivePatch(empty, { revision: 1, changes: [{ id: agent.id, meta: agent }], removed: [], stats: { ...empty.stats, active: 1 } });
  const child = { ...agent, id: 'child', parentId: agent.id };
  const nested = applyLivePatch(parent, { revision: 2, changes: [{ id: child.id, meta: child }], removed: [], stats: { ...empty.stats, active: 2 } });
  assert.deepEqual(rootAgents(nested.agents).map(a => a.id), ['new']);
  const orphan = applyLivePatch(nested, { revision: 3, changes: [], removed: ['new'], stats: { ...empty.stats, active: 1 } }); assert.deepEqual(rootAgents(orphan.agents).map(a => a.id), ['child']);
  const restored = applyLivePatch(orphan, { revision: 4, changes: [{ id: 'new', meta: agent, clear: true, components: [{ id: 'plan', title: 'Plan', kind: 'markdown', data: { text: 'Recovered' } }] }], removed: [], stats: { ...empty.stats, active: 2 } });
  assert.equal(restored.agents.find(a => a.id === 'new')?.components.plan.kind, 'markdown'); assert.deepEqual(rootAgents(restored.agents).map(a => a.id), ['new']);
  assert.equal(orphan.agents.length, 1); assert.equal(applyLivePatch(restored, { revision: 2, changes: [], removed: ['new'], stats: empty.stats }), restored);
});

test('stats-only patches and untouched runs retain array and nested identities',()=>{
  const old:Snapshot={...empty,agents:[agent]};
  const next=applyLivePatch(old,{revision:1,changes:[],removed:[],stats:{...old.stats,updates:1}});
  assert.equal(next.agents,old.agents); assert.equal(next.settings,old.settings); assert.equal(next.agents[0],agent);
  assert.equal(next.stats.updates,1); assert.equal(old.stats.updates,0);
  const redundant=applyLivePatch(next,{revision:2,changes:[{id:agent.id}],removed:['absent'],stats:next.stats});
  assert.equal(redundant.agents,next.agents);
});

test('heartbeat metadata reuses untouched components, geometry and timing rows',()=>{
  const first:TaskTiming={key:'first',line:1,firstSeenAt:1,startedAt:1,updatedAt:1};
  const second={key:'second',line:2,firstSeenAt:2,completedAt:3,updatedAt:3};
  const before:AgentView={...agent,taskTimes:{plan:[first,second]},componentTimes:{plan:3},components:{plan:{id:'plan',title:'Plan',kind:'markdown',data:{text:'- [ ] first\n- [x] second'}}}};
  const old={...empty,agents:[before]}; const serialized=JSON.stringify(old);
  const {components:_,...metadata}=before;
  const next=applyLivePatch(old,{revision:1,changes:[{id:before.id,meta:{...metadata,lastSeen:9,layout:{...before.layout},componentTimes:{...before.componentTimes},taskTimes:{plan:[{...first},{...second}]}}}],removed:[],stats:old.stats});
  const after=next.agents[0]; assert.notEqual(after,before); assert.equal(after.lastSeen,9);
  assert.equal(after.components,before.components); assert.equal(after.layout,before.layout); assert.equal(after.componentTimes,before.componentTimes);
  assert.equal(after.taskTimes,before.taskTimes); assert.equal(JSON.stringify(old),serialized);
  const updated=applyLivePatch(next,{revision:2,changes:[{id:before.id,meta:{...metadata,lastSeen:10,taskTimes:{plan:[{...first,completedAt:10,updatedAt:10},{...second}]}}}],removed:[],stats:old.stats}).agents[0];
  assert.notEqual(updated.taskTimes,after.taskTimes); assert.notEqual(updated.taskTimes!.plan[0],first); assert.equal(updated.taskTimes!.plan[1],second);
  assert.equal(updated.taskTimes!.plan[0].completedAt,10); assert.equal(first.completedAt,undefined);
});

test('component deltas change only touched data, then clear and recovery apply without mutation',()=>{
  const plan={id:'plan',title:'Plan',kind:'markdown',data:{text:'Old'}} as const;
  const metric={id:'value',title:'Value',kind:'metric',data:{value:1}} as const;
  const before={...agent,components:{plan,value:metric}}; const sibling={...agent,id:'sibling'};
  const old={...empty,agents:[before,sibling]}; const original=JSON.stringify(old);
  const changed={...plan,data:{text:'New'}};
  const next=applyLivePatch(old,{revision:1,changes:[{id:agent.id,components:[changed]}],removed:[],stats:old.stats});
  assert.notEqual(next.agents,old.agents); assert.notEqual(next.agents[0].components,before.components);
  assert.equal(next.agents[0].components.plan,changed); assert.equal(next.agents[0].components.value,metric);
  assert.equal(next.agents[0].layout,before.layout); assert.equal(next.agents[1],sibling);
  const removed=applyLivePatch(next,{revision:2,changes:[{id:agent.id,removeComponents:['plan']}],removed:[],stats:old.stats});
  assert.equal(removed.agents[0].components.plan,undefined); assert.equal(removed.agents[0].components.value,metric);
  const cleared=applyLivePatch(removed,{revision:3,changes:[{id:agent.id,clear:true,components:[changed]}],removed:[],stats:old.stats});
  assert.deepEqual(Object.keys(cleared.agents[0].components),['plan']); assert.equal(cleared.agents[0].components.plan,changed);
  const gone=applyLivePatch(cleared,{revision:4,changes:[],removed:[agent.id],stats:old.stats}); assert.deepEqual(gone.agents,[sibling]);
  const restored=applyLivePatch(gone,{revision:5,changes:[{id:agent.id,meta:agent,clear:true,components:[metric]},{id:'unknown',components:[changed]}],removed:[],stats:old.stats});
  assert.deepEqual(restored.agents.map(a=>a.id),['sibling',agent.id]); assert.deepEqual(restored.agents[1].components,{value:metric});
  assert.equal(restored.agents[0],sibling); assert.equal(JSON.stringify(old),original);
});

test('timing reorder and reopen preserve unchanged rows but remove obsolete completion fields',()=>{
  const done:TaskTiming={key:'done',line:1,firstSeenAt:1,startedAt:1,completedAt:4,updatedAt:4};
  const pending:TaskTiming={key:'pending',line:2,firstSeenAt:2,startedAt:2,updatedAt:2};
  const before:AgentView={...agent,taskTimes:{plan:[done,pending]}};
  const {components:_,...metadata}=before;
  const reordered=applyLivePatch({...empty,agents:[before]},{revision:1,changes:[{id:agent.id,meta:{...metadata,taskTimes:{plan:[{...pending},{...done}]}}}],removed:[],stats:empty.stats});
  assert.deepEqual(reordered.agents[0].taskTimes!.plan.map(t=>t.key),['pending','done']);
  assert.equal(reordered.agents[0].taskTimes!.plan[0],pending); assert.equal(reordered.agents[0].taskTimes!.plan[1],done);
  const reopened:TaskTiming={key:'done',line:1,firstSeenAt:1,startedAt:8,updatedAt:8};
  const next=applyLivePatch(reordered,{revision:2,changes:[{id:agent.id,meta:{...metadata,taskTimes:{plan:[{...pending},reopened]}}}],removed:[],stats:empty.stats});
  assert.equal(next.agents[0].taskTimes!.plan[1].completedAt,undefined); assert.equal(next.agents[0].taskTimes!.plan[1].startedAt,8);
  assert.equal(next.agents[0].taskTimes!.plan[0],pending); assert.equal(done.completedAt,4);
  const cleared=applyLivePatch(next,{revision:3,changes:[{id:agent.id,clear:true,meta:{...metadata,taskTimes:{}}}],removed:[],stats:empty.stats});
  assert.deepEqual(cleared.agents[0].taskTimes,{});
});
