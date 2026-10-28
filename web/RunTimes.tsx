import type { AgentView } from '../shared/protocol.js';
import { memo } from 'react';
import { compactTime, exactTime } from '../shared/time-format.js';

export const RunTimes = memo(function RunTimes({ agent }: { agent: AgentView }) {
  const latest = agent.completedAt ?? agent.updatedAt, label = agent.completedAt !== undefined ? 'Completed' : 'Updated';
  return <span className="run-times"><time dateTime={new Date(agent.createdAt).toISOString()} title={`Arrived: ${exactTime(agent.createdAt)}`}>Arrived {compactTime(agent.createdAt)}</time>{latest !== undefined && <time dateTime={new Date(latest).toISOString()} title={`${label}: ${exactTime(latest)}`}>{label} {compactTime(latest)}</time>}{agent.status === 'completed' && agent.completedAt === undefined && <span title="This legacy run did not record its completion time">Completed · time unavailable</span>}</span>;
}, (before, after) => before.agent.createdAt === after.agent.createdAt && before.agent.updatedAt === after.agent.updatedAt && before.agent.completedAt === after.agent.completedAt && before.agent.status === after.agent.status);
