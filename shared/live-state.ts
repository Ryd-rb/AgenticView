import type { AgentView, Patch, Snapshot } from './protocol.js';

function sameRecord(a: object | undefined, b: object): boolean {
  if (!a) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(right);
  return Object.keys(left).length === keys.length && keys.every(key => Object.hasOwn(left, key) && left[key] === right[key]);
}
function retainTaskTimes(before: AgentView['taskTimes'], incoming: NonNullable<AgentView['taskTimes']>) {
  const next: NonNullable<AgentView['taskTimes']> = {};
  for (const [id, rows] of Object.entries(incoming)) {
    const old = before?.[id], byKey = new Map(old?.map(row => [row.key, row]));
    const retained = rows.map(row => { const previous = byKey.get(row.key); return previous && sameRecord(previous, row) ? previous : row; });
    next[id] = old && old.length === retained.length && retained.every((row, i) => row === old[i]) ? old : retained;
  }
  return sameRecord(before, next) ? before! : next;
}

/** Apply the same deltas used by the live canvas, including previously unseen runs. */
export function applyLivePatch(old: Snapshot, patch: Patch): Snapshot {
  if (patch.revision < old.revision) return old;
  const stats = sameRecord(old.stats, patch.stats) ? old.stats : patch.stats;
  const settings = patch.settings && !sameRecord(old.settings, patch.settings) ? patch.settings : old.settings;
  if (!patch.changes.length && !patch.removed.length) return old.revision === patch.revision && stats === old.stats && settings === old.settings ? old : { ...old, revision: patch.revision, stats, settings };
  const agents = new Map(old.agents.map(agent => [agent.id, agent]));
  let changed = false;
  for (const id of patch.removed) changed = agents.delete(id) || changed;
  for (const change of patch.changes) {
    const before = agents.get(change.id);
    if (!before && !change.meta) continue;
    let components = before?.components ?? {}, copied = !before;
    if (change.clear && Object.keys(components).length) { components = {}; copied = true; }
    for (const id of change.removeComponents ?? []) if (Object.hasOwn(components, id)) { if (!copied) { components = { ...components }; copied = true; } delete components[id]; }
    for (const component of change.components ?? []) if (components[component.id] !== component) { if (!copied) { components = { ...components }; copied = true; } components[component.id] = component; }
    const meta = { ...change.meta };
    if (before && meta.layout && sameRecord(before.layout, meta.layout)) meta.layout = before.layout;
    if (before && meta.windowIcon && sameRecord(before.windowIcon??undefined, meta.windowIcon)) meta.windowIcon=before.windowIcon;
    if (before && meta.componentLayout && sameRecord(before.componentLayout, meta.componentLayout)) meta.componentLayout = before.componentLayout;
    if (before && meta.chrome) {
      const retained = Object.fromEntries(Object.entries(meta.chrome).map(([id,spec]) => [id,sameRecord(before.chrome?.[id as keyof NonNullable<AgentView['chrome']>],spec!) ? before.chrome?.[id as keyof NonNullable<AgentView['chrome']>] : spec]));
      meta.chrome = sameRecord(before.chrome,retained) ? before.chrome : retained;
    }
    if (before && meta.componentTimes && sameRecord(before.componentTimes, meta.componentTimes)) meta.componentTimes = before.componentTimes;
    if (meta.taskTimes) meta.taskTimes = retainTaskTimes(before?.taskTimes, meta.taskTimes);
    const next = { ...before, ...meta, components } as AgentView;
    if (!before || !sameRecord(before, next)) { agents.set(change.id, next); changed = true; }
  }
  return { revision: patch.revision, agents: changed ? [...agents.values()] : old.agents, settings, stats };
}

export function rootAgents(agents: AgentView[]): AgentView[] {
  const ids = new Set(agents.map(agent => agent.id));
  return agents.filter(agent => !agent.parentId || !ids.has(agent.parentId));
}


const MAX_VALUES=4_000_000,MAX_DEPTH=64;
type Budget={left:number};
type RecordValue=Record<string,unknown>;
const record=(value:unknown):value is RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
function take(budget:Budget){if(budget.left<=0)return false;budget.left--;return true;}
/** Conservative JSON equality: own keys and their order, ordered arrays, Object.is
 * scalars (-0 differs). Unsupported/deep/over-budget values never compare equal. */
function equal(before:unknown,incoming:unknown,budget:Budget,depth:number):boolean{
 if(depth>MAX_DEPTH||!take(budget))return false;
 if(Object.is(before,incoming))return true;
 if(Array.isArray(incoming)){
  if(!Array.isArray(before)||before.length!==incoming.length)return false;
  if(incoming.length>budget.left){budget.left=0;return false;}
  for(let i=0;i<incoming.length;i++)if(!Object.hasOwn(before,i)||!Object.hasOwn(incoming,i)||!equal(before[i],incoming[i],budget,depth+1))return false;
  return true;
 }
 if(!record(before)||!record(incoming))return false;
 const keys=Object.keys(incoming),oldKeys=Object.keys(before);
 if(keys.length!==oldKeys.length)return false;
 if(keys.length>budget.left){budget.left=0;return false;}
 for(let i=0;i<keys.length;i++){const key=keys[i]!;if(key!==oldKeys[i]||!Object.hasOwn(before,key)||!equal(before[key],incoming[key],budget,depth+1))return false;}
 return true;
}
function reuseRecord<T extends object>(before:T,incoming:T,budget:Budget,depth:number,special?:(key:string,old:unknown,next:unknown)=>unknown):T{
 if(depth>MAX_DEPTH||!take(budget)||!record(before)||!record(incoming))return incoming;
 const keys=Object.keys(incoming),oldKeys=Object.keys(before);
 if(keys.length>budget.left){budget.left=0;return incoming;}
 let same=keys.length===oldKeys.length,copy:RecordValue|undefined;
 for(let i=0;i<keys.length;i++){
  if(!take(budget))return (copy??incoming) as T; // Proven slots stay shared; unvisited slots remain incoming.
  const key=keys[i]!,next=incoming[key],hasOld=Object.hasOwn(before,key);
  const retained=hasOld?(special?special(key,before[key],next):equal(before[key],next,budget,depth+1)?before[key]:next):next;
  if(!hasOld||key!==oldKeys[i]||!Object.is(retained,before[key]))same=false;
  if(!Object.is(retained,next)){copy??={...incoming};Object.defineProperty(copy,key,{value:retained,writable:true,enumerable:true,configurable:true});}
 }
 return same?before:(copy??incoming) as T;
}
function reuseAgent(before:AgentView,incoming:AgentView,budget:Budget):AgentView{
 return reuseRecord(before,incoming,budget,2,(key,old,next)=>key==='components'&&record(old)&&record(next)?reuseRecord(old,next,budget,3):equal(old,next,budget,3)?old:next);
}
function reuseAgents(before:AgentView[],incoming:AgentView[],budget:Budget):AgentView[]{
 if(!take(budget)||!Array.isArray(before)||!Array.isArray(incoming))return incoming;
 if(before.length+incoming.length>budget.left){budget.left=0;return incoming;}
 const byId=new Map<string,AgentView|null>();
 for(const agent of before){take(budget);if(!record(agent)||!Object.hasOwn(agent,'id')||typeof agent.id!=='string')continue;byId.set(agent.id,byId.has(agent.id)?null:agent);}
 let same=before.length===incoming.length,copy:AgentView[]|undefined;
 for(let i=0;i<incoming.length;i++){
  if(!take(budget))return copy??incoming;
  const agent=incoming[i]!,old=record(agent)&&Object.hasOwn(agent,'id')?byId.get(agent.id):undefined;
  const retained=old?reuseAgent(old,agent,budget):agent;
  if(!Object.is(retained,before[i]))same=false;
  if(retained!==agent){copy??=incoming.slice();copy[i]=retained;}
 }
 return same?before:copy??incoming;
}
/** Authoritative full snapshot, including lower revisions after server restart.
 * The optional comparison limit is internal test/budget plumbing, capped at4M.
 * No input mutation, persistent caches, stringification or deep incoming copies. */
export function applyLiveSnapshot(before:Snapshot,incoming:Snapshot,maxValues=MAX_VALUES):Snapshot{
 const budget={left:Number.isFinite(maxValues)?Math.min(MAX_VALUES,Math.max(0,Math.floor(maxValues))):MAX_VALUES};
 return reuseRecord(before,incoming,budget,0,(key,old,next)=>key==='agents'&&Array.isArray(old)&&Array.isArray(next)?reuseAgents(old,next,budget):equal(old,next,budget,1)?old:next);
}
