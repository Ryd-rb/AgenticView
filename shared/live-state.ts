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
