import type { AgentStatus } from './protocol.js';

/** Viewer-authenticated GET /api/monitoring; rates and counters are server-authoritative. */
export type MonitoringSample = { time: number; active: number; stale: number; updatesPerSecond: number; batchesPerSecond: number; bytesPerSecond: number; cpuPercent: number };
export type MonitoringKind = { kind: string; components: number; operations: number; updatesPerSecond: number };
export type MonitoringAgent = { id: string; name: string; status: AgentStatus; lastSeen: number; components: number; operations: number; updatesPerSecond: number };
export type MonitoringStage = { name: string; totalMilliseconds: number; meanMilliseconds: number; share: number };
export type MonitoringSnapshot = {
  sampledAt: number; uptimeSeconds: number;
  active: number; stale: number; completed: number; errors: number; liveAgents: number; archived: number; components: number; viewerStreams: number; liveBytes: number;
  acceptedBatches: number; acceptedOperations: number; acceptedPayloadBytes: number; duplicateBatches: number; rejectedPublishes: number;
  updatesPerSecond: number; batchesPerSecond: number; bytesPerSecond: number; publishP95Ms: number;
  cpuPercent: number; workingSetBytes: number; managedHeapBytes: number;
  history: MonitoringSample[]; kinds: MonitoringKind[]; agents: MonitoringAgent[]; stages: MonitoringStage[];
};
