/** Bounded in-memory React/DOM profiling, never browser automation or painting. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { Window } from 'happy-dom';
import { act, createElement, Profiler } from 'react';
import { App } from '../web/App.tsx';
import type { AgentView, Patch, Snapshot } from '../shared/protocol.ts';

const output = resolve(process.env.AV_UI_BENCH_DIR || `.task/ui-bench-${Date.now()}`), frames = Number(process.env.AV_UI_BENCH_FRAMES || 80);
if (!Number.isInteger(frames) || frames < 10 || frames > 300) throw new Error('Frame bound exceeded');
mkdirSync(output, { recursive: true });
const dom = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true, enableJavaScriptEvaluation: false } });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMRect', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'MessageEvent'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : dom[key] });
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'getComputedStyle'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom[key].bind(dom) });
const animationFrames = new Map<number, FrameRequestCallback>(); let frameId = 0;
Object.assign(globalThis, { innerWidth: 1200, innerHeight: 800, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => { animationFrames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: (id: number) => animationFrames.delete(id),
  fetch: async (_path: string, init?: RequestInit) => new Response(JSON.stringify(init?.body ? JSON.parse(String(init.body)) : { authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
const prototype = dom.HTMLElement.prototype;
for (const [key, value] of Object.entries({ clientWidth: 400, clientHeight: 300, offsetWidth: 400, offsetHeight: 300, scrollWidth: 800, scrollHeight: 1000 })) Object.defineProperty(prototype, key, { configurable: true, get: () => value });
prototype.getBoundingClientRect = () => new dom.DOMRect(0, 0, 400, 300);
class Stream extends dom.EventTarget {
  static current: Stream; onopen = null; onerror = null;
  constructor(_url: string) { super(); Stream.current = this; }
  close() {}
  send(type: string, value: unknown) { this.dispatchEvent(new dom.MessageEvent(type, { data: JSON.stringify(value) })); }
}
Object.assign(globalThis, { EventSource: Stream });
const agents: AgentView[] = Array.from({ length: 1000 }, (_, i) => ({ id: `agent-${i}`, agentId: `synthetic-${i}`, name: `Synthetic worker ${i}`, role: i % 5 === 0 ? 'Orchestrator' : 'Worker', context: 'Synthetic bounded UI workload', parentId: i % 5 === 0 ? null : `agent-${i - i % 5}`,
  createdAt: i + 1, lastSeen: 1, status: 'active', sequence: 1, layout: { x: Math.floor(i / 5) % 20 * 512, y: Math.floor(i / 100) * 452, width: 480, height: 420, z: 1, locked: false },
  components: Object.fromEntries(Array.from({ length: 6 }, (_, j) => [`metric-${j}`, { id: `metric-${j}`, title: `Synthetic metric ${j}`, kind: 'metric', data: { value: i + j, unit: 'items' } }])) }));
const state: Snapshot = { revision: 1, agents, settings: { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: false, reducedMotion: true }, stats: { active: 1000, stale: 0, archived: 0, updates: 0, updatesPerSecond: 0 } };
const { createRoot } = await import('react-dom/client'), host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
let durations: number[] = [];
const draw = async (action: () => void) => { await act(action); await act(() => { const pending = [...animationFrames.values()]; animationFrames.clear(); for (const callback of pending) callback(performance.now()); }); };
const session = new Session(); session.connect();
const post = (method: string) => new Promise<any>((resolve, reject) => session.post(method, (error, result) => error ? reject(error) : resolve(result)));
const results: Record<string, unknown> = {};
try {
  await act(async () => { root.render(createElement(Profiler, { id: 'monitor', onRender: (_id, _phase, actual) => durations.push(actual) }, createElement(App))); await Promise.resolve(); });
  await draw(() => Stream.current.send('snapshot', state));
  const canvas = host.querySelector('.canvas')!;
  const key = (index: number) => canvas.dispatchEvent(new KeyboardEvent('keydown', { key: index % 2 ? 'ArrowRight' : 'ArrowLeft', bubbles: true, cancelable: true }));
  for (let i = 0; i < 12; i++) await draw(() => key(i));
  await post('Profiler.enable'); await post('Profiler.start');
  let revision = 2;
  for (const workload of ['navigation', 'stats-only', 'offscreen-update'] as const) {
    durations = []; const start = performance.now();
    for (let i = 0; i < frames; i++) await draw(() => {
      if (workload === 'navigation') key(i);
      else { const patch: Patch = { revision: revision++, changes: workload === 'stats-only' ? [] : [{ id: 'agent-999', components: [{ id: 'metric-0', title: 'Synthetic metric 0', kind: 'metric', data: { value: i, unit: 'items' } }] }], removed: [], stats: { ...state.stats, updates: i, updatesPerSecond: i % 10 } }; Stream.current.send('patch', patch); }
    });
    const elapsedMs = performance.now() - start, sorted = [...durations].sort((a, b) => a - b);
    results[workload] = { events: frames, elapsedMs: Math.round(elapsedMs), commits: durations.length, totalReactRenderMs: Math.round(durations.reduce((a, b) => a + b, 0)), commitP95Ms: Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? 0).toFixed(2)) };
  }
  const { profile } = await post('Profiler.stop'); writeFileSync(join(output, 'runtime.cpuprofile'), JSON.stringify(profile));
  const weights = new Map<number, number>(); profile.samples.forEach((id: number, i: number) => weights.set(id, (weights.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const top = profile.nodes.map((node: any) => ({ function: node.callFrame.functionName || '(anonymous)', module: node.callFrame.url.split(/[\\/]/).slice(-2).join('/'), selfMs: Math.round((weights.get(node.id) ?? 0) / 1000) })).sort((a: any, b: any) => b.selfMs - a.selfMs).slice(0, 25);
  writeFileSync(join(output, 'cpu-top.json'), JSON.stringify(top, null, 2));
  const report = { runtime: process.version, synthetic: true, agents: 1000, rootAgents: 200, metricsPerAgent: 6, results, limitations: 'React development build and Happy DOM in Node; source-bound JavaScript/DOM costs, not browser layout, painting, frame rate, physical input or end-to-end latency.' };
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { session.disconnect(); await act(() => root.unmount()); await dom.happyDOM.close(); }
