import type { AgentView } from './protocol.js';

export type AgentBranch = { agent: AgentView; children: AgentBranch[] };
export type AgentTree = { nodes: Map<string, AgentBranch>; roots: AgentView[] };
const same = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((value, i) => value === b[i]);

/** Index once per telemetry change and retain unrelated branches for React bailouts. */
export function buildAgentTree(agents: AgentView[], previous?: AgentTree): AgentTree {
  const byId = new Map(agents.map(agent => [agent.id, agent])), children = new Map<string, AgentView[]>(), nodes = new Map<string, AgentBranch>(), visiting = new Set<string>();
  for (const agent of agents) if (agent.parentId && agent.parentId !== agent.id && byId.has(agent.parentId)) { const group = children.get(agent.parentId) ?? []; group.push(agent); children.set(agent.parentId, group); }
  function visit(agent: AgentView, depth = 0): AgentBranch {
    const known = nodes.get(agent.id); if (known) return known;
    visiting.add(agent.id);
    const next = depth < 32 ? (children.get(agent.id) ?? []).filter(child => !visiting.has(child.id)).map(child => visit(child, depth + 1)) : [];
    visiting.delete(agent.id);
    const before = previous?.nodes.get(agent.id), nested = before && same(before.children, next) ? before.children : next;
    const branch = before?.agent === agent && nested === before.children ? before : { agent, children: nested };
    nodes.set(agent.id, branch); return branch;
  }
  for (const agent of agents) visit(agent);
  const roots = agents.filter(agent => !agent.parentId || !byId.has(agent.parentId));
  return { nodes, roots: previous && same(previous.roots, roots) ? previous.roots : roots };
}
