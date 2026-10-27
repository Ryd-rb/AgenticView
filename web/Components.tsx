import { memo, useContext, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { diffLines } from 'diff';
import { Activity, Code2, ExternalLink, FileText, Pause, ShieldCheck } from 'lucide-react';
import type { Component } from '../shared/protocol.js';
import { CardInteraction } from './CardInteraction.js';

const colors = ['#b4a2ff', '#70d6c3', '#e8be79', '#8bbbf5', '#e891b1'];
const stringify = (v: unknown) => typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v ?? '—');
function Sparkline({ values }: { values: number[] }) {
  const min = Math.min(...values), span = Math.max(...values) - min || 1;
  return <svg className="sparkline" viewBox="0 0 200 44" role="img" aria-label={`${values.length} historical values`}><polyline points={values.map((v, i) => `${i / Math.max(values.length - 1, 1) * 200},${40 - (v - min) / span * 36}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}
function Chart({ data }: { data: Extract<Component, { kind: 'chart' }>['data'] }) {
  const all = data.series.flatMap(s => s.points); const ys = all.map(p => p.y);
  const low = Math.min(0, ...ys), high = Math.max(1, ...ys), span = high - low || 1;
  const numeric = all.length > 0 && all.every(p => typeof p.x === 'number');
  const categories = [...new Set(all.map(p => String(p.x)))];
  const xLow = numeric ? Math.min(...all.map(p => Number(p.x))) : 0, xHigh = numeric ? Math.max(...all.map(p => Number(p.x))) : categories.length - 1;
  const x = (value: string | number) => 36 + ((numeric ? Number(value) : categories.indexOf(String(value))) - xLow) / (xHigh - xLow || 1) * 340;
  const y = (v: number) => 155 - (v - low) / span * 135;
  return <><svg className="chart" viewBox="0 0 400 185" role="img" aria-label={`${data.type} chart, ${data.series.map(s => s.name).join(', ')}`}>
    {[0, 1, 2, 3].map(i => <g key={i}><line x1="36" x2="384" y1={20 + i * 45} y2={20 + i * 45} stroke="#ffffff0c" /><text x="30" y={24 + i * 45} textAnchor="end">{Number((high - i / 3 * span).toPrecision(3))}</text></g>)}
    {data.series.map((s, si) => { const points = s.points.map((p, i) => `${x(p.x)},${y(p.y)}`).join(' '); return <g key={s.name} fill={colors[si % colors.length]} stroke={colors[si % colors.length]}>
      {data.type === 'bar' ? s.points.map((p, i) => <rect key={i} x={x(p.x) - 3} y={Math.min(y(0), y(p.y))} width={Math.max(2, 250 / s.points.length / data.series.length)} height={Math.max(1, Math.abs(y(p.y) - y(0)))} stroke="none" />) : data.type === 'scatter' ? s.points.map((p, i) => <circle key={i} cx={x(p.x)} cy={y(p.y)} r="2.5" />) : <>{data.type === 'area' && s.points.length > 0 && <polygon points={`${x(s.points[0]!.x)},${y(0)} ${points} ${x(s.points[s.points.length - 1]!.x)},${y(0)}`} opacity=".1" stroke="none" />}<polyline points={points} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" /></>}
    </g>; })}<text x="36" y="168">{all[0]?.x}</text><text x="376" y="168" textAnchor="end">{all[all.length - 1]?.x}</text><text x="210" y="180" textAnchor="middle">{data.xLabel}</text></svg><div className="legend">{data.series.map((s, i) => <span key={s.name}><i style={{ background: colors[i % colors.length] }} />{s.name}</span>)}</div></>;
}
function Table({ data }: { data: Extract<Component, { kind: 'table' }>['data'] }) {
  const [page, setPage] = useState(0), count = 25, pages = Math.max(1, Math.ceil(data.rows.length / count)), current = Math.min(page, pages - 1);
  return <><div className="table-scroll"><table><thead><tr>{data.columns.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{data.rows.slice(current * count, (current + 1) * count).map((r, i) => <tr key={i}>{data.columns.map(c => <td key={c.key}>{stringify(r[c.key])}</td>)}</tr>)}</tbody></table></div><div className="pagination"><span>{data.totalRows ?? data.rows.length} rows</span><button disabled={!current} onClick={() => setPage(current - 1)}>Previous</button><span>{current + 1} / {pages}</span><button disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>Next</button></div></>;
}
function Logs({ entries }: { entries: Extract<Component, { kind: 'logs' }>['data']['entries'] }) {
  const [scroll, setScroll] = useState(0); const row = 30, height = 210, start = Math.max(0, Math.floor(scroll / row) - 3), end = Math.min(entries.length, start + 16);
  return <div className="logs" style={{ height }} onScroll={e => setScroll(e.currentTarget.scrollTop)} tabIndex={0} aria-label={`${entries.length} log entries`}><div style={{ height: entries.length * row, position: 'relative' }}><div style={{ position: 'absolute', top: start * row, left: 0, right: 0 }}>{entries.slice(start, end).map((e, i) => <div className={`log-row ${e.level}`} style={{ height: row }} key={start + i} title={e.message}><time>{e.time || '·'}</time><b>{e.level}</b><span>{e.message}</span></div>)}</div></div></div>;
}
function Embed({ data, enabled, runId, componentId }: { data: Extract<Component, { kind: 'embed' }>['data']; enabled: boolean; runId: string; componentId: string }) {
  const frame = useRef<HTMLIFrameElement>(null), port = useRef<MessagePort | null>(null), loads = useRef(0);
  const [navigated, setNavigated] = useState(false), [interacting, setInteracting] = useState(false);
  const active = useContext(CardInteraction), input = active && interacting;
  const src = `/api/embeds/${encodeURIComponent(runId)}/${encodeURIComponent(componentId)}`;
  useEffect(() => { port.current?.postMessage(data.state ?? null); }, [data.state]);
  useEffect(() => { loads.current = 0; setNavigated(false); return () => { port.current?.close(); port.current = null; }; }, [src, enabled]);
  useEffect(() => { if (!active) setInteracting(false); }, [active]);
  useEffect(() => { const reset = () => setInteracting(false); window.addEventListener('agenticview:canvas-navigation', reset); return () => window.removeEventListener('agenticview:canvas-navigation', reset); }, []);
  useEffect(() => { setInteracting(false); }, [src, enabled]);
  if (!enabled || navigated) return <div className="embed-paused"><Pause size={18} /><span>{navigated ? 'View navigated. Reload the component to reconnect.' : 'Embedded views are paused in settings.'}</span></div>;
  return <><div className="embed-label"><ShieldCheck size={12} /> Trusted view <span>isolated document · network enabled</span><button className="embed-interact" disabled={!active} aria-pressed={input} onClick={() => setInteracting(!input)}>{input ? 'Return to card navigation' : 'Interact with view'}</button></div><div className={`embed-frame ${input ? 'embed-interacting' : ''}`}><iframe ref={frame} title="Agent generated view" inert={!input} tabIndex={input ? 0 : -1} sandbox="allow-scripts allow-forms allow-popups allow-downloads" referrerPolicy="no-referrer" src={src} style={{ height: data.height, pointerEvents: input ? 'auto' : 'none' }} onLoad={() => {
    loads.current++;
    port.current?.close(); port.current = null;
    if (loads.current > 1) { setInteracting(false); setNavigated(true); return; }
    const channel = new MessageChannel(); port.current = channel.port1;
    frame.current?.contentWindow?.postMessage({ type: 'agenticview:init' }, '*', [channel.port2]);
    channel.port1.postMessage(data.state ?? null);
  }} />{!input && <div className="embed-navigation-shield" aria-hidden="true" />}</div></>;
}
function Tree({ nodes }: { nodes: Extract<Component, { kind: 'tree' }>['data']['nodes'] }) {
  const ids = new Set(nodes.map(n => n.id));
  const branch = (parent: string | undefined, seen: Set<string>, depth: number): React.ReactNode => depth > 12 ? <small>Further levels omitted</small> : <ul className="data-tree">{nodes.filter(n => n.parentId === parent || parent === undefined && n.parentId && !ids.has(n.parentId)).map(n => <li key={n.id}><span>{n.label}</span>{n.detail && <small>{n.detail}</small>}{!seen.has(n.id) && branch(n.id, new Set([...seen, n.id]), depth + 1)}</li>)}</ul>;
  return branch(undefined, new Set(), 0);
}
export const ComponentView = memo(function ComponentView({ component: c, embeds, runId }: { component: Component; embeds: boolean; runId: string }) {
  let body: React.ReactNode;
  switch (c.kind) {
    case 'metric': body = <div className={`metric tone-${c.data.tone ?? 'neutral'}`}><div><strong>{stringify(c.data.value)}</strong><span>{c.data.unit}</span></div>{c.data.change && <small>{c.data.change}</small>}{!!c.data.history?.length && <Sparkline values={c.data.history} />}</div>; break;
    case 'chart': body = <Chart data={c.data} />; break;
    case 'table': body = <Table data={c.data} />; break;
    case 'markdown': body = <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}<ExternalLink size={11} /></a> }}>{c.data.text}</ReactMarkdown></div>; break;
    case 'code': body = <><div className="code-language"><Code2 size={12} />{c.data.language || 'text'}</div><pre><code>{c.data.code}</code></pre></>; break;
    case 'diff': body = <pre className="diff">{diffLines(c.data.before, c.data.after).map((p, i) => <span className={p.added ? 'added' : p.removed ? 'removed' : ''} key={i}>{p.value}</span>)}</pre>; break;
    case 'logs': body = <Logs entries={c.data.entries} />; break;
    case 'timeline': body = <ol className="timeline">{c.data.events.slice(-100).map((e, i) => <li className={`tone-${e.tone ?? 'neutral'}`} key={i}><time>{e.time}</time><strong>{e.title}</strong>{e.detail && <p>{e.detail}</p>}</li>)}</ol>; break;
    case 'progress': body = <div className="progress"><div><span>{c.data.label ?? 'Progress'}</span><b>{Math.round(c.data.value / c.data.max * 100)}%</b></div><progress value={c.data.value} max={c.data.max} /></div>; break;
    case 'keyvalue': body = <dl className="keyvalue">{c.data.items.map((i, n) => <div key={n}><dt>{i.key}</dt><dd>{stringify(i.value)}</dd></div>)}</dl>; break;
    case 'json': body = <pre>{JSON.stringify(c.data.value, null, 2)}</pre>; break;
    case 'tree': body = <Tree nodes={c.data.nodes} />; break;
    case 'status': body = <div className={`status-display ${c.data.state}`}><Activity size={17} /><div><strong>{c.data.label}</strong>{c.data.detail && <p>{c.data.detail}</p>}</div></div>; break;
    case 'embed': body = <Embed key={c.data.html} data={c.data} enabled={embeds} runId={runId} componentId={c.id} />; break;
  }
  return <section className={`component component-${c.kind}`}><h3><FileText size={12} />{c.title || c.kind}</h3>{body}</section>;
});
