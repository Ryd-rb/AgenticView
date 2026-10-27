import type { AgentView, Patch, Snapshot } from './protocol.js';

/** Apply the same deltas used by the live canvas, including previously unseen runs. */
export function applyLivePatch(old: Snapshot, patch: Patch): Snapshot {
  if (patch.revision < old.revision) return old;
  const agents = new Map(old.agents.map(agent => [agent.id, agent]));
  for (const id of patch.removed) agents.delete(id);
  for (const change of patch.changes) {
    const before = agents.get(change.id);
    if (!before && !change.meta) continue;
    const components = { ...(change.clear ? {} : before?.components ?? {}) };
    for (const id of change.removeComponents ?? []) delete components[id];
    for (const component of change.components ?? []) components[component.id] = component;
    agents.set(change.id, { ...before, ...change.meta, components } as AgentView);
  }
  return { revision: patch.revision, agents: [...agents.values()], settings: patch.settings ?? old.settings, stats: patch.stats };
}

export function rootAgents(agents: AgentView[]): AgentView[] {
  const ids = new Set(agents.map(agent => agent.id));
  return agents.filter(agent => !agent.parentId || !ids.has(agent.parentId));
}
