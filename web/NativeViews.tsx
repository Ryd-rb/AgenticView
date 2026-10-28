import { useState } from 'react';
import { Check, Circle, Clock3, ExternalLink, AlertCircle } from 'lucide-react';
import type { Component, TaskTiming } from '../shared/protocol.js';
import { compactDuration, compactTime, exactTime, taskClockSpacings } from '../shared/time-format.js';
import { TaskDuration } from './TaskDuration.js';
import { DataTable } from './DataTable.js';

export type ExtendedComponent = Extract<Component, { kind: 'stat-grid' | 'checklist' | 'bar-list' | 'histogram' | 'heatmap' | 'gauge' | 'query' | 'command' | 'trace' | 'alert' | 'links' | 'comparison' | 'service-map' | 'http' | 'stacktrace' | 'test-results' | 'gantt' | 'breakdown' }>;
const value = (v: unknown) => typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—');
const duration = (ms?: number) => ms === undefined ? null : <span className="native-duration" title={`${ms} ms`}>{compactDuration(ms)}</span>;
function usePage(length: number, size = 50) {
  const [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(length / size)), current = Math.min(page, pages - 1);
  return { current, pages, offset: current * size, size, setPage };
}
function Pager({ page, count, label }: { page: ReturnType<typeof usePage>; count: number; label: string }) {
  return count > page.size ? <div className="pagination"><span>{count} {label}</span><button disabled={!page.current} onClick={() => page.setPage(page.current - 1)}>Previous</button><span>{page.current + 1} / {page.pages}</span><button disabled={page.current + 1 === page.pages} onClick={() => page.setPage(page.current + 1)}>Next</button></div> : null;
}
function ServiceMap({ data }: { data: Extract<Component, { kind: 'service-map' }>['data'] }) {
  const page = usePage(data.nodes.length, 20), nodes = new Map(data.nodes.map(node => [node.id, node]));
  return <><div className="native-meta"><span>{data.nodes.length} services</span><span>{data.edges.length} connections</span></div><ul className="native-service-map" aria-label="Service topology">{data.nodes.slice(page.offset, page.offset + page.size).map(node => {
    const outgoing = data.edges.filter(edge => edge.from === node.id);
    return <li key={node.id} className={`service-state-${node.state ?? 'idle'}`}><div className="service-heading"><strong>{node.label}</strong><span>{node.state ?? 'idle'}</span></div>{node.detail && <p>{node.detail}</p>}{outgoing.length > 0 ? <ul className="service-connections" aria-label={`Connections from ${node.label}`}>{outgoing.map((edge, i) => <li key={i}><span aria-hidden="true">→</span><span>{nodes.get(edge.to)!.label}</span>{edge.label && <small>{edge.label}</small>}</li>)}</ul> : <small className="native-note">No outgoing connections</small>}</li>;
  })}</ul><Pager page={page} count={data.nodes.length} label="services" /></>;
}
function Stacktrace({ data }: { data: Extract<Component, { kind: 'stacktrace' }>['data'] }) {
  const page = usePage(data.frames.length);
  return <div className="native-stacktrace">{data.exception && <strong className="stack-exception">{data.exception}</strong>}{data.message && <p>{data.message}</p>}<ol start={page.offset + 1} aria-label="Stack frames">{data.frames.slice(page.offset, page.offset + page.size).map((frame, i) => <li key={page.offset + i}><code>{frame.method}</code>{frame.module && <span className="stack-module">{frame.module}</span>}{(frame.file || frame.line !== undefined) && <div className="stack-location">{frame.file}{frame.line !== undefined && <span> · line {frame.line}</span>}</div>}</li>)}</ol><Pager page={page} count={data.frames.length} label="frames" /></div>;
}
function TestResults({ data }: { data: Extract<Component, { kind: 'test-results' }>['data'] }) {
  const page = usePage(data.items.length), states = ['passed', 'failed', 'skipped', 'running', 'pending'] as const;
  return <><dl className="native-test-summary">{states.map(state => <div key={state} className={`test-state-${state}`}><dt>{state}</dt><dd>{data.items.filter(item => item.state === state).length}</dd></div>)}</dl><ul className="native-test-results" aria-label="Test results">{data.items.slice(page.offset, page.offset + page.size).map(item => <li key={item.id} className={`test-state-${item.state}`}><div className="test-result-heading"><span className="test-result-state">{item.state}</span><strong>{item.label}</strong>{duration(item.durationMs)}</div>{item.detail && <details><summary>Details</summary><pre>{item.detail}</pre></details>}</li>)}</ul><Pager page={page} count={data.items.length} label="tests" /></>;
}
function Gantt({ data }: { data: Extract<Component, { kind: 'gantt' }>['data'] }) {
  const page = usePage(data.items.length), start = Math.min(...data.items.map(item => item.start)), end = Math.max(...data.items.map(item => item.end ?? item.start)), span = Math.max(1, end - start);
  if (!data.items.length) return <p className="native-note">No intervals reported</p>;
  return <><div className="gantt-range"><time dateTime={new Date(start).toISOString()}>{new Date(start).toLocaleString()}</time><time dateTime={new Date(end).toISOString()}>{new Date(end).toLocaleString()}</time></div><ol className="native-gantt" aria-label="Reported timeline">{data.items.slice(page.offset, page.offset + page.size).map(item => <li key={item.id} className={`tone-${item.tone ?? 'neutral'}`}><div className="gantt-heading"><strong>{item.label}</strong>{item.group && <span>{item.group}</span>}{item.end === undefined && <small>In progress</small>}</div><div className="gantt-track" aria-label={`${item.label}, starts ${new Date(item.start).toISOString()}, ${item.end === undefined ? 'end not reported' : 'ends ' + new Date(item.end).toISOString()}`}><span style={{ left: (item.start - start) / span * 100 + '%', width: Math.max(.5, ((item.end ?? item.start) - item.start) / span * 100) + '%' }} /></div></li>)}</ol><Pager page={page} count={data.items.length} label="intervals" /></>;
}
function Breakdown({ data }: { data: Extract<Component, { kind: 'breakdown' }>['data'] }) {
  const max = Math.max(1, ...data.items.map(item => item.value)), scaledTotal = data.items.reduce((sum, item) => sum + item.value / max, 0);
  const share = (n: number) => scaledTotal ? n / max / scaledTotal * 100 : 0;
  return <><div className="native-breakdown-strip" aria-hidden="true">{data.items.map((item, i) => <span key={i} className={`tone-${item.tone ?? 'neutral'}`} style={{ flexGrow: share(item.value) }} />)}</div><ul className="native-breakdown" aria-label="Reported value shares">{data.items.map((item, i) => <li key={i} className={`tone-${item.tone ?? 'neutral'}`}><span>{item.label}</span><strong>{value(item.value)} <small>{data.unit}</small></strong><span className="breakdown-percent">{share(item.value).toFixed(1)}%</span></li>)}</ul>{scaledTotal === 0 && <p className="native-note">No positive values reported</p>}</>;
}

function Checklist({ data, times, updatedAt }: { data: Extract<Component, { kind: 'checklist' }>['data']; times?: TaskTiming[]; updatedAt?: number }) {
  const done = data.items.filter(item => item.status === 'completed').length, spacings = taskClockSpacings(times ?? []);
  return <><div className="checklist-summary"><span>{done} of {data.items.length} complete</span><progress value={done} max={Math.max(1, data.items.length)} aria-label="Completed tasks" /></div><ul className="native-checklist">{data.items.map((item, index) => {
    const timing = times?.find(t => t.line === index + 1), at = timing?.completedAt ?? timing?.startedAt ?? timing?.firstSeenAt ?? updatedAt;
    const Icon = item.status === 'completed' ? Check : item.status === 'active' ? Clock3 : item.status === 'blocked' ? AlertCircle : Circle;
    return <li key={item.id} className={`task-${item.status}`}><Icon size={14} aria-label={item.status} /><div><span>{item.label}</span>{at !== undefined && <span className="task-meta"><time className="task-time" dateTime={new Date(at).toISOString()} title={`Reported: ${exactTime(at)}`}>{compactTime(at, timing ? spacings.get(timing.key) ?? 0 : 0)}</time><span className="task-time-separator" aria-hidden="true">·</span><TaskDuration timing={timing} /></span>}{item.detail && <p>{item.detail}</p>}</div></li>;
  })}</ul></>;
}

function Heatmap({ data }: { data: Extract<Component, { kind: 'heatmap' }>['data'] }) {
  const [page, setPage] = useState(0), current = Math.min(page, Math.max(0, Math.ceil(data.rows.length / 16) - 1));
  const values = new Map(data.cells.map(c => [`${c.row}:${c.column}`, c.value])), scale = Math.max(1, ...data.cells.map(c => Math.abs(c.value))), all = data.cells.map(c => c.value / scale), low = Math.min(0, ...all), high = Math.max(1 / scale, ...all), span = high - low || 1;
  return <><div className="table-scroll heatmap-scroll"><table className="native-heatmap"><thead><tr><th scope="col" />{data.columns.map((label, i) => <th key={i} scope="col">{label}</th>)}</tr></thead><tbody>{data.rows.slice(current * 16, (current + 1) * 16).map((label, i) => { const row = current * 16 + i; return <tr key={row}><th scope="row">{label}</th>{data.columns.map((column, col) => { const v = values.get(`${row}:${col}`); return <td key={col} title={`${label} / ${column}: ${v === undefined ? 'No value' : value(v)} ${data.unit ?? ''}`} style={v === undefined ? undefined : { backgroundColor: `rgb(157 148 207 / ${.08 + (v / scale - low) / span * .5})` }}>{v === undefined ? '—' : value(v)}</td>; })}</tr>; })}</tbody></table></div>{data.rows.length > 16 && <div className="pagination"><span>{data.rows.length} rows</span><button disabled={!current} onClick={() => setPage(current - 1)}>Previous</button><span>{current + 1} / {Math.ceil(data.rows.length / 16)}</span><button disabled={(current + 1) * 16 >= data.rows.length} onClick={() => setPage(current + 1)}>Next</button></div>}</>;
}

function Trace({ data }: { data: Extract<Component, { kind: 'trace' }>['data'] }) {
  const [page, setPage] = useState(0), current = Math.min(page, Math.max(0, Math.ceil(data.spans.length / 50) - 1));
  const spans = new Map(data.spans.map(span => [span.id, span])), scale = Math.max(1, ...data.spans.flatMap(span => [span.startMs, span.durationMs])), end = Math.max(1 / scale, ...data.spans.map(span => span.startMs / scale + span.durationMs / scale));
  const depth = (id?: string) => { let n = 0; const seen = new Set<string>(); while (id && spans.has(id) && !seen.has(id) && n < 12) { seen.add(id); n++; id = spans.get(id)?.parentId; } return n; };
  return <><ol className="native-trace" aria-label="Execution spans">{data.spans.slice(current * 50, (current + 1) * 50).map(span => <li key={span.id} className={`span-${span.status}`}><div className="trace-label" style={{ paddingInlineStart: depth(span.parentId) * 10 }}><span title={span.name}>{span.name}</span>{duration(span.durationMs)}</div><div className="trace-track" aria-label={`${span.name}, starts ${span.startMs} milliseconds, duration ${span.durationMs} milliseconds`}><span style={{ left: span.startMs / scale / end * 100 + '%', width: Math.max(.35, span.durationMs / scale / end * 100) + '%' }} /></div></li>)}</ol>{data.spans.length > 50 && <div className="pagination"><span>{data.spans.length} spans</span><button disabled={!current} onClick={() => setPage(current - 1)}>Previous</button><span>{current + 1} / {Math.ceil(data.spans.length / 50)}</span><button disabled={(current + 1) * 50 >= data.spans.length} onClick={() => setPage(current + 1)}>Next</button></div>}</>;
}

export function NativeView({ component: c, taskTimes, updatedAt }: { component: ExtendedComponent; taskTimes?: TaskTiming[]; updatedAt?: number }) {
  switch (c.kind) {
    case 'stat-grid': return <dl className="native-stats">{c.data.items.map((item, i) => <div key={i} className={`tone-${item.tone ?? 'neutral'}`}><dt>{item.label}</dt><dd>{value(item.value)}<small>{item.unit}</small></dd>{item.change && <span>{item.change}</span>}</div>)}</dl>;
    case 'checklist': return <Checklist data={c.data} times={taskTimes} updatedAt={updatedAt} />;
    case 'bar-list': { const max = Math.max(1, ...c.data.items.map(item => item.value)); return <ol className="native-bars">{c.data.items.map((item, i) => <li key={i} className={`tone-${item.tone ?? 'neutral'}`}><div><span>{item.label}</span><strong>{value(item.value)} <small>{c.data.unit}</small></strong></div><span className="bar-track"><span style={{ width: item.value / max * 100 + '%' }} /></span></li>)}</ol>; }
    case 'histogram': { const max = Math.max(1, ...c.data.buckets.map(bucket => bucket.count)); return <div className="native-histogram" role="list" aria-label="Distribution buckets">{c.data.buckets.map((bucket, i) => <div key={i} role="listitem" title={`${bucket.label}: ${bucket.count} ${c.data.unit ?? ''}`}><span>{bucket.count}</span><div className="histogram-track"><span style={{ height: bucket.count / max * 100 + '%' }} /></div><small>{bucket.label}</small></div>)}</div>; }
    case 'heatmap': return <Heatmap data={c.data} />;
    case 'gauge': return <div className="native-gauge"><div><strong>{value(c.data.value)}</strong><span>{c.data.unit}</span></div><meter value={c.data.value} min={c.data.min} max={c.data.max} aria-label={c.data.label || c.title || 'Gauge'} /><div className="gauge-range"><span>{value(c.data.min)}</span><span>{c.data.label}</span><span>{value(c.data.max)}</span></div></div>;
    case 'query': return <div className="native-query"><div className="native-meta"><span className={`native-state state-${c.data.state}`}>{c.data.state}</span>{c.data.source && <span>{c.data.source}</span>}{duration(c.data.durationMs)}</div><pre><code>{c.data.query}</code></pre>{c.data.error && <p className="native-error" role="status">{c.data.error}</p>}{c.data.columns.length > 0 ? <DataTable data={c.data} /> : <p className="native-note">{c.data.state === 'running' ? 'Waiting for results' : 'No rows reported'}</p>}</div>;
    case 'command': return <div className="native-command"><div className="native-meta"><span>{c.data.shell || 'Command'}</span>{c.data.exitCode !== undefined && <span className={`native-state ${c.data.exitCode === 0 ? 'state-success' : 'state-error'}`}>exit {c.data.exitCode}</span>}{duration(c.data.durationMs)}</div>{c.data.directory && <p className="command-directory">{c.data.directory}</p>}<pre><code>{c.data.command}</code></pre>{c.data.output !== undefined && <pre className="command-output" aria-label="Command output">{c.data.output}</pre>}</div>;
    case 'trace': return <Trace data={c.data} />;
    case 'alert': return <div className={`native-alert tone-${c.data.tone}`} role="status"><AlertCircle size={16} /><div><p>{c.data.message}</p>{c.data.detail && <details><summary>Details</summary><pre>{c.data.detail}</pre></details>}</div></div>;
    case 'links': return <ul className="native-links">{c.data.items.map((item, i) => <li key={i}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.label}<ExternalLink size={12} /></a>{item.description && <p>{item.description}</p>}</li>)}</ul>;
    case 'comparison': return <div className="table-scroll"><table className="native-comparison"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>{c.data.items.map((item, i) => <tr key={i} className={JSON.stringify(item.before) === JSON.stringify(item.after) ? '' : 'has-change'}><th scope="row">{item.label}</th><td>{value(item.before)}</td><td>{value(item.after)}</td></tr>)}</tbody></table></div>;
    case 'service-map': return <ServiceMap data={c.data} />;
    case 'http': return <div className="native-http"><div className="native-meta"><strong className="http-method">{c.data.method}</strong>{c.data.statusCode !== undefined && <span className={`native-state ${c.data.statusCode >= 400 ? 'state-error' : c.data.statusCode >= 200 && c.data.statusCode < 300 ? 'state-success' : ''}`}>HTTP {c.data.statusCode}</span>}{duration(c.data.durationMs)}</div><code className="http-url">{c.data.url}</code>{c.data.requestBody !== undefined && <details><summary>Request body</summary><pre>{c.data.requestBody}</pre></details>}{c.data.responseBody !== undefined && <details open><summary>Response body</summary><pre>{c.data.responseBody}</pre></details>}</div>;
    case 'stacktrace': return <Stacktrace data={c.data} />;
    case 'test-results': return <TestResults data={c.data} />;
    case 'gantt': return <Gantt data={c.data} />;
    case 'breakdown': return <Breakdown data={c.data} />;
  }
}
