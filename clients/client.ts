import { randomUUID, randomBytes } from 'node:crypto';
import type { Component, Operation, RegisterInput } from '../shared/protocol.ts';

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
  heartbeat() { return request(this.url, `/api/agents/${this.runId}/heartbeat`, this.runToken, {}); }
  startHeartbeat(onError: (error: unknown) => void = () => {}) { this.stopHeartbeat(); this.heartbeatTimer = setInterval(() => { void this.heartbeat().catch(onError); }, 15_000); this.heartbeatTimer.unref(); return this; }
  stopHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  async archive() { this.stopHeartbeat(); await this.queue; await this.reconcile(); return request(this.url, `/api/agents/${this.runId}/archive`, this.runToken, {}); }
}
async function request<T>(url: string, path: string, token: string, data: unknown): Promise<T> {
  const body = JSON.stringify(data);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(new URL(path, url), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
      const value = await response.json() as { error?: string };
      if (!response.ok) { const error = new Error(value.error || `HTTP ${response.status}`); if (response.status < 500 && response.status !== 429) throw Object.assign(error, { permanent: true }); throw error; }
      return value as T;
    } catch (error) { if ((error as { permanent?: boolean }).permanent || attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); }
  }
  throw new Error('Request did not complete.');
}
