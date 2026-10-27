import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fixture, secrets } from '../tests/server-fixture.ts';

const root = resolve(process.env.AV_BENCH_DIR || `.task/csharp-bench-${Date.now()}`); mkdirSync(root, { recursive: true });
const f = await fixture(root);
const count = Number(process.env.AV_BENCH_AGENTS || 1_000), rounds = Number(process.env.AV_BENCH_ROUNDS || 5), batchSize = Number(process.env.AV_BENCH_BATCH || 10);
if (![count, rounds, batchSize].every(Number.isInteger) || count < 1 || count > 1_000 || rounds < 1 || rounds > 20 || batchSize < 1 || batchSize > 64) throw new Error('Benchmark bounds exceeded.');
const deadline = AbortSignal.timeout(90_000), runs: { runId: string; runToken: string }[] = [];
let receivedBytes = 0; const streamController = new AbortController(); let drain: Promise<void> | undefined;
async function post(path: string, token: string, value: unknown) { const response = await fetch(f.url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: deadline }); if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`); return response.json(); }
async function pass(sequence: number) {
  let cursor = 0; const latencies: number[] = [];
  await Promise.all(Array.from({ length: Math.min(32, count) }, async () => { while (cursor < count) { const run = runs[cursor++]; const start = performance.now(); await post(`/api/agents/${run.runId}/publish`, run.runToken, { sequence, operations: Array.from({ length: batchSize }, (_, j) => ({ op: 'upsert', component: { id: `metric-${j}`, title: `Synthetic metric ${j}`, kind: 'metric', data: { value: sequence * 100 + j } } })) }); latencies.push(performance.now() - start); } })); return latencies;
}
try {
  const setup = performance.now();
  for (let i = 0; i < count; i++) runs.push(await post('/api/agents/register', secrets.ingestToken, { requestId: `bench-${i}`, registrationKey: randomBytes(32).toString('hex'), agentId: `synthetic-${i}`, name: `Synthetic ${i}` }));
  const setupMs = performance.now() - setup;
  const stream = await fetch(f.url + '/api/events', { headers: { Authorization: `Bearer ${secrets.viewerToken}` }, signal: streamController.signal });
  drain = (async () => { try { for await (const chunk of stream.body!) receivedBytes += chunk.byteLength; } catch { /* bounded shutdown */ } })();
  await pass(1); const start = performance.now(); let latencies: number[] = [];
  for (let i = 2; i <= rounds + 1; i++) latencies.push(...await pass(i));
  const elapsedMs = performance.now() - start; latencies.sort((a, b) => a - b);
  const result = { synthetic: true, server: 'C# / .NET 10 / ASP.NET Core', platform: process.platform, agents: count, batchSize, measuredRounds: rounds, requests: count * rounds, operations: count * rounds * batchSize, elapsedMs: Math.round(elapsedMs), operationsPerSecond: Math.round(count * rounds * batchSize / elapsedMs * 1000), requestP50Ms: Number(latencies[Math.floor(latencies.length * .5)].toFixed(2)), requestP95Ms: Number(latencies[Math.floor(latencies.length * .95)].toFixed(2)), setupMs: Math.round(setupMs), viewerStreams: 1, receivedBytes, warmupExcluded: true, limitations: 'Loopback HTTP, separate C# server and Node load generator; batched scalar metrics, one SSE drain; no browser rendering or concurrent archive compression; SQLite WAL NORMAL, not power-loss-safe FULL.' };
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { streamController.abort(); await drain; await f.close(false); }
