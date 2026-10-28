import { randomUUID, randomBytes } from 'node:crypto';
import type { Component, Operation, RegisterInput } from '../shared/protocol.ts';
import type { ApplicationManifest } from '../shared/application-manifest.ts';

export class AgenticViewClient {
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pending?: { sequence: number; operations: Operation[] };
  private constructor(readonly url: string, readonly runId: string, private readonly runToken: string, sequence = 0) { this.sequence = sequence; }
  static async connect(url: string, ingestionKey: string, input: Omit<RegisterInput, 'requestId' | 'registrationKey'> & { requestId?: string; registrationKey?: string }) {
    const result = await request<{ runId: string; runToken: string; sequence: number }>(url, '/api/agents/register', ingestionKey, { ...input, requestId: input.requestId || randomUUID(), registrationKey: input.registrationKey || randomBytes(32).toString('base64url') });
    return new AgenticViewClient(url, result.runId, result.runToken, result.sequence);
  }
  /** Resume with credentials held privately by the calling application. */
  static resume(url: string, runId: string, runToken: string, sequence: number) { return new AgenticViewClient(url, runId, runToken, sequence); }
  static async importApplication(url:string,ingestionKey:string,manifest:ApplicationManifest,bindings:Record<string,string>,identity:{requestId:string;registrationKey:string}) { const result=await request<{runId:string;runToken:string;sequence:number}>(url,'/api/applications/import',ingestionKey,{manifest,bindings,...identity}); return new AgenticViewClient(url,result.runId,result.runToken,result.sequence); }
  defineApplication(manifest:ApplicationManifest) { return request<ApplicationManifest>(this.url,`/api/agents/${this.runId}/application`,this.runToken,manifest,'PUT'); }
  exportApplication() { return request<ApplicationManifest>(this.url,`/api/agents/${this.runId}/application`,this.runToken,undefined,'GET'); }
  childDeclaration() { return { parentId: this.runId, parentToken: this.runToken }; }
  publish(operations: Operation[]) {
    const copy = structuredClone(operations);
    const task = this.queue.then(async () => {
      await this.reconcile();
      this.pending = { sequence: this.sequence + 1, operations: copy };
      return this.reconcile();
    });
    this.queue = task.catch(() => undefined); return task;
  }
  async reconcile() {
    if (!this.pending) return { sequence: this.sequence, trimmed: 0 };
    try { const result = await request<{ sequence: number; trimmed: number }>(this.url, `/api/agents/${this.runId}/publish`, this.runToken, this.pending); this.sequence = result.sequence; this.pending = undefined; return result; }
    catch (error) { if ((error as { permanent?: boolean }).permanent) this.pending = undefined; throw error; }
  }
  display(...components: Component[]) { return this.publish(components.map(component => ({ op: 'upsert', component }))); }
  clear() { return this.publish([{ op: 'clear' }]); }
  /** Configure interactive actions; application cards survive agent disconnection. Keep profiles and secrets local. */
  configure(actions: ActionDefinition[], application?: { name: string; description?: string }) { return request(this.url, `/api/agents/${this.runId}/controls`, this.runToken, { actions, ...(application ? { application } : {}) }, 'PUT'); }
  /** Claims one action. Execute once, then retry only its acknowledgement if delivery is uncertain. */
  pollActions() { return request<ActionJob[]>(this.url, `/api/agents/${this.runId}/actions/poll`, this.runToken, {}); }
  completeAction(job: ActionJob, state: 'succeeded' | 'failed' | 'unknown', result?: Record<string, unknown>, error?: string) { return request(this.url, `/api/agents/${this.runId}/actions/complete`, this.runToken, { invocationId: job.id, claimToken: job.claimToken, state, ...(result ? { result } : {}), ...(error ? { error } : {}) }); }
  heartbeat() { return request(this.url, `/api/agents/${this.runId}/heartbeat`, this.runToken, {}); }
  startHeartbeat(onError: (error: unknown) => void = () => {}) { this.stopHeartbeat(); this.heartbeatTimer = setInterval(() => { void this.heartbeat().catch(onError); }, 15_000); this.heartbeatTimer.unref(); return this; }
  stopHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  async archive() { this.stopHeartbeat(); await this.queue; await this.reconcile(); return request(this.url, `/api/agents/${this.runId}/archive`, this.runToken, {}); }
}
export type ActionDefinition = { id: string; label: string; kind: 'command' | 'prompt' | 'query' | 'edit' | 'history' | 'logs' | 'custom' | 'session'; target: string; handler?: string; connection?: {machineId:string;remoteProfileId?:string}; description?: string; confirmation?: string; fields?: { key: string; label: string; type: 'text' | 'multiline' | 'number' | 'select' | 'toggle' | 'json'; required?: boolean; options?: string[]; min?: number; max?: number }[] };
export type ActionJob = { id: string; runId: string; actionId: string; handler: string; kind: ActionDefinition['kind']; input: Record<string, unknown>; claimToken: string; state: 'running' };
async function request<T>(url: string, path: string, token: string, data: unknown, method = 'POST'): Promise<T> {
  const body = JSON.stringify(data);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(new URL(path, url), { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
      const value = await response.json() as { error?: string };
      if (!response.ok) { const error = new Error(value.error || `HTTP ${response.status}`); if (response.status < 500 && response.status !== 429) throw Object.assign(error, { permanent: true }); throw error; }
      return value as T;
    } catch (error) { if ((error as { permanent?: boolean }).permanent || attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); }
  }
  throw new Error('Request did not complete.');
}
