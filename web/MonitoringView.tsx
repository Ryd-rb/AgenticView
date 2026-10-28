import { useEffect, useState } from 'react';
import type { Component } from '../shared/protocol.js';
import type { MonitoringSnapshot } from '../shared/monitoring.js';
import { ComponentView } from './Components.js';

const number = (value: number, digits = 1) => new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
const bytes = (value: number) => value >= 1024 ** 3 ? `${number(value / 1024 ** 3)} GiB` : value >= 1024 ** 2 ? `${number(value / 1024 ** 2)} MiB` : value >= 1024 ? `${number(value / 1024)} KiB` : `${number(value, 0)} B`;
const clock = (value: number) => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function MonitoringView() {
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot>(), [error, setError] = useState(''), [paused, setPaused] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const [windowSeconds, setWindowSeconds] = useState(300);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, pending: AbortController | undefined;
    const hidden = () => document.visibilityState === 'hidden';
    const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const poll = async () => {
      if (disposed || hidden() || pending) return;
      clearTimer(); const controller = new AbortController(); pending = controller;
      try {
        const response = await fetch('/api/monitoring', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (response.status === 401) window.dispatchEvent(new Event('agenticview:unauthorized'));
        if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to view monitoring.' : `Monitoring unavailable (${response.status}). Retrying…`);
        const next = await response.json() as MonitoringSnapshot;
        if (!disposed && !controller.signal.aborted) { setSnapshot(next); setError(''); }
      } catch (failure) { if (!disposed && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Monitoring unavailable. Retrying…'); }
      finally { if (pending === controller) pending = undefined; if (!disposed && !hidden()) timer = setTimeout(poll, 1000); }
    };
    const visibility = () => { setPaused(hidden()); clearTimer(); if (hidden()) pending?.abort(); else void poll(); };
    document.addEventListener('visibilitychange', visibility); void poll();
    return () => { disposed = true; clearTimer(); pending?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const native = (component: Component) => <ComponentView key={component.id} component={component} embeds={false} runId="monitoring" />;
  const history = snapshot?.history.filter(sample => sample.time > snapshot.sampledAt - windowSeconds * 1000).slice(-300) ?? [];
  const chart = (id: string, title: string, series: { name: string; field: 'updatesPerSecond' | 'batchesPerSecond' | 'bytesPerSecond' | 'active' | 'stale' | 'cpuPercent'; divisor?: number }[]) => native({ id, title, kind: 'chart', data: { type: 'line', xLabel: 'Server time', series: series.map(item => ({ name: item.name, points: history.map(sample => ({ x: clock(sample.time), y: sample[item.field] / (item.divisor ?? 1) })) })) } });
  return <div className="monitoring-view">
    <div className="monitoring-heading"><div><span className="monitoring-eyebrow">INSTALLATION HEALTH</span><h2>Monitoring</h2></div><div className="monitoring-connection"><span className={paused ? 'is-paused' : error ? 'is-retrying' : 'is-live'}>{paused ? 'Paused while hidden' : error ? 'Retrying' : snapshot ? 'Live · 1s refresh' : 'Connecting'}</span>{snapshot && <time dateTime={new Date(snapshot.sampledAt).toISOString()}>Updated {clock(snapshot.sampledAt)}</time>}</div></div>
    {error && <p className="monitoring-error" role="alert">{error}</p>}
    {!snapshot ? <p className="monitoring-loading" role="status">Waiting for the first server sample…</p> : <>
      <p className="monitoring-caption">Rates and history since server startup · {number(snapshot.uptimeSeconds / 60)} minutes uptime</p>
      <div className="monitoring-summary">{native({ id: 'population', title: 'Run states', kind: 'stat-grid', data: { items: [
        { label: 'Active', value: snapshot.active, tone: 'success' }, { label: 'Stale', value: snapshot.stale, tone: 'warning' }, { label: 'Live agents', value: snapshot.liveAgents }, { label: 'Components', value: snapshot.components }, { label: 'Completed / error', value: `${snapshot.completed} / ${snapshot.errors}` }, { label: 'Archived', value: snapshot.archived }
      ] } })}{native({ id: 'rates', title: 'Accepted traffic', kind: 'stat-grid', data: { items: [
        { label: 'Updates', value: number(snapshot.updatesPerSecond), unit: '/s' }, { label: 'Batches', value: number(snapshot.batchesPerSecond), unit: '/s' }, { label: 'Payload', value: bytes(snapshot.bytesPerSecond), unit: '/s' }, { label: 'Viewer streams', value: snapshot.viewerStreams }
      ] } })}</div>
      <div className="monitoring-section-heading"><h3>Recent activity</h3><div className="monitoring-window" role="group" aria-label="History window">{[60, 300].map(seconds => <button key={seconds} aria-pressed={windowSeconds === seconds} onClick={() => setWindowSeconds(seconds)}>{seconds === 60 ? '1m' : '5m'}</button>)}</div></div>
      <p className="monitoring-caption">Up to 300 one-second server samples. Time labels use your local clock.</p>
      <div className="monitoring-curves">{chart('throughput', 'Updates and batches / second', [{ name: 'Updates /s', field: 'updatesPerSecond' }, { name: 'Batches /s', field: 'batchesPerSecond' }])}{chart('payload', 'Accepted payload · KiB / second', [{ name: 'KiB /s', field: 'bytesPerSecond', divisor: 1024 }])}{chart('population-history', 'Heartbeat run states', [{ name: 'Active', field: 'active' }, { name: 'Stale', field: 'stale' }])}{chart('cpu-history', 'Process CPU · normalized %', [{ name: 'CPU %', field: 'cpuPercent' }])}</div>
      <div className="monitoring-section-heading"><h3>Component activity</h3></div>
      {native({ id: 'kind-rates', title: 'Leading kinds · updates / second', kind: 'bar-list', data: { unit: '/s', items: [...snapshot.kinds].sort((a, b) => b.updatesPerSecond - a.updatesPerSecond).slice(0, 10).map(kind => ({ label: kind.kind === 'control' ? 'Control operations' : kind.kind, value: kind.updatesPerSecond })) } })}
      {native({ id: 'kind-inventory', title: 'Kind inventory', kind: 'table', data: { columns: [{ key: 'kind', label: 'Kind' }, { key: 'components', label: 'Live components' }, { key: 'rate', label: 'Updates /s' }, { key: 'operations', label: 'Accepted operations' }], rows: snapshot.kinds.map(kind => ({ kind: kind.kind, components: kind.components, rate: number(kind.updatesPerSecond), operations: kind.operations })) } })}
      <div className="monitoring-section-heading"><h3>Agent activity</h3><span>Top {Math.min(100, snapshot.agents.length)} of {snapshot.liveAgents} live agents</span></div>
      {native({ id: 'agent-rates', title: 'Agents by update rate', kind: 'table', data: { columns: [{ key: 'agent', label: 'Agent' }, { key: 'status', label: 'State' }, { key: 'rate', label: 'Updates /s' }, { key: 'components', label: 'Components' }, { key: 'lastSeen', label: 'Last contact' }, { key: 'operations', label: 'Accepted operations' }], rows: snapshot.agents.slice(0, 100).map(agent => ({ agent: agent.name, status: agent.status, rate: number(agent.updatesPerSecond), components: agent.components, lastSeen: clock(agent.lastSeen), operations: agent.operations })) } })}
      <div className="monitoring-section-heading"><h3>Runtime and delivery</h3></div>
      {native({ id: 'runtime', title: 'Server counters', kind: 'stat-grid', data: { items: [
        { label: 'Process CPU', value: number(snapshot.cpuPercent), unit: '%' }, { label: 'Working set', value: bytes(snapshot.workingSetBytes) }, { label: 'Managed heap', value: bytes(snapshot.managedHeapBytes) }, { label: 'Retained live views', value: bytes(snapshot.liveBytes) }, { label: 'Publish p95 · bucketed', value: number(snapshot.publishP95Ms), unit: 'ms' }, { label: 'Duplicate batches', value: snapshot.duplicateBatches }, { label: 'Rejected publishes', value: snapshot.rejectedPublishes }, { label: 'Accepted batches', value: snapshot.acceptedBatches }, { label: 'Accepted operations', value: snapshot.acceptedOperations }, { label: 'Accepted payload', value: bytes(snapshot.acceptedPayloadBytes) }
      ] } })}
      <details className="monitoring-pipeline"><summary>Publish pipeline · production stage counters</summary><p className="monitoring-caption">Mean elapsed stage time per accepted batch since startup. These counters include waits and are not CPU samples.</p>{native({ id: 'pipeline', title: 'Mean stage time', kind: 'bar-list', data: { unit: 'ms / batch', items: snapshot.stages.map(stage => ({ label: stage.name, value: stage.meanMilliseconds })) } })}{native({ id: 'pipeline-table', title: 'Accumulated pipeline stages', kind: 'table', data: { columns: [{ key: 'stage', label: 'Stage' }, { key: 'mean', label: 'Mean ms / batch' }, { key: 'total', label: 'Total ms' }, { key: 'share', label: 'Share %' }], rows: snapshot.stages.map(stage => ({ stage: stage.name, mean: number(stage.meanMilliseconds, 3), total: number(stage.totalMilliseconds), share: number(stage.share) })) } })}</details>
      <p className="monitoring-footnote">Active and stale are heartbeat-based run states; live agents also include retained completed and error runs. Payload bytes measure canonical accepted JSON, excluding transport headers and the MCP envelope. Rates, latency buckets, duplicates and rejections cover this server process since startup.</p>
    </>}
  </div>;
}
