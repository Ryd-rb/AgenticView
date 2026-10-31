import { memo, useContext, useEffect, useRef, useState } from 'react';
import { ChartView } from './ChartView.js';
import { AdditionalView } from './AdditionalViews.js';
import { diffLines } from 'diff';
import { Activity, BarChart3, Braces, CheckSquare, Code2, Database, FileText, Gauge, GitCompareArrows, LayoutGrid, Link2, ListTree, Pause, ShieldCheck, Table2, Terminal, Timer, Network, Globe, Layers, ListChecks, CalendarRange, ChartPie, ChevronDown, type LucideIcon } from 'lucide-react';
import type { Component, TaskTiming } from '../shared/protocol.js';
import { CardInteraction } from './CardInteraction.js';
import { TaskMarkdown } from './TaskMarkdown.js';
import { compactTime, exactTime } from '../shared/time-format.js';
import { isTaskList } from '../shared/component-order.js';
import { DataTable } from './DataTable.js';
import { NativeView } from './NativeViews.js';
import { ControlView } from './ControlViews.js';
import { configureCollection, resolveConfiguration } from '../shared/component-config.js';
import { ComponentSettings, presentationStyle } from './ComponentSettings.js';
import { SessionView } from './SessionViews.js';
import { control } from '../shared/control-presentation.js';
import { ComponentControls, ControlContainer, ControlContent, controlStyle } from './ControlPresentation.js';

const icons: Record<string, LucideIcon> = { metric: Activity, chart: BarChart3, table: Table2, code: Code2, diff: GitCompareArrows, logs: Terminal, timeline: Timer, tree: ListTree, json: Braces, checklist: CheckSquare, 'stat-grid': LayoutGrid, 'bar-list': BarChart3, histogram: BarChart3, heatmap: LayoutGrid, gauge: Gauge, query: Database, command: Terminal, trace: Activity, links: Link2, comparison: GitCompareArrows, 'service-map': Network, http: Globe, stacktrace: Layers, 'test-results': ListChecks, gantt: CalendarRange, breakdown: ChartPie, embed: Braces };
const boundedOutput = (text: string) => text.length > 32000 || text.split('\n', 302).length > 300;
const stringify = (v: unknown) => typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v ?? '—');
function Sparkline({ values }: { values: number[] }) {
  const min = Math.min(...values), span = Math.max(...values) - min || 1;
  return <svg className="sparkline" viewBox="0 0 200 44" role="img" aria-label={`${values.length} historical values`}><polyline points={values.map((v, i) => `${i / Math.max(values.length - 1, 1) * 200},${40 - (v - min) / span * 36}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
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
export const ComponentView = memo(function ComponentView({ component: original, embeds, runId, updatedAt, taskTimes }: { component: Component; embeds: boolean; runId: string; updatedAt?: number; taskTimes?: TaskTiming[] }) {
  const active = useContext(CardInteraction);
  const configuration = resolveConfiguration(original.configuration, original.data);
  const controls=configuration.controls;
  const [collapsed, setCollapsed] = useState<boolean | undefined>(undefined);
  useEffect(() => setCollapsed(undefined), [original.configuration?.collapsed]);
  const c = {...original, data: configureCollection(original.data, configuration)} as Component;
  if (configuration.visible === false) return null;
  let body: React.ReactNode;
  switch (c.kind) {
    case 'action-panel': case 'log-stream': case 'data-grid': body = <ControlView component={c} runId={runId} />; break;
    case 'session-launcher': case 'agent-session': body = <SessionView component={c} runId={runId} embeds={embeds} />; break;
    case 'metric': body = <div className={`metric tone-${c.data.tone ?? 'neutral'}`}><div><strong>{stringify(c.data.value)}</strong><span>{c.data.unit}</span></div>{c.data.change && <small>{c.data.change}</small>}{!!c.data.history?.length && <Sparkline values={c.data.history} />}</div>; break;
    case 'chart': body = <ChartView data={c.data} manual={active} />; break;
    case 'stepper': case 'bullet': case 'accordion': body=<AdditionalView component={c} manual={active}/>; break;
    case 'table': body = c.data.sourceAction ? <ControlView component={{kind:'data-grid',data:{readAction:c.data.sourceAction,columns:c.data.columns,pageSize:c.data.pageSize}}} runId={runId} /> : <DataTable data={c.data} />; break;
    case 'markdown': body = <TaskMarkdown text={c.data.text} tasks={taskTimes} updatedAt={updatedAt} />; break;
    case 'code': body = <><div className="code-language"><Code2 size={12} />{c.data.language || 'text'}</div><pre className={boundedOutput(c.data.code) ? 'bounded-output' : undefined}><code>{c.data.code}</code></pre></>; break;
    case 'diff': body = <pre className={`diff ${boundedOutput(c.data.before) || boundedOutput(c.data.after) ? 'bounded-output' : ''}`}>{diffLines(c.data.before, c.data.after).map((p, i) => <span className={p.added ? 'added' : p.removed ? 'removed' : ''} key={i}>{p.value}</span>)}</pre>; break;
    case 'logs': body = <Logs entries={c.data.entries} />; break;
    case 'timeline': body = <ol className="timeline">{c.data.events.slice(-100).map((e, i) => <li className={`tone-${e.tone ?? 'neutral'}`} key={i}><time>{e.time}</time><strong>{e.title}</strong>{e.detail && <p>{e.detail}</p>}</li>)}</ol>; break;
    case 'progress': body = <div className="progress"><div><span>{c.data.label ?? 'Progress'}</span><b>{Math.round(c.data.value / c.data.max * 100)}%</b></div><progress value={c.data.value} max={c.data.max} /></div>; break;
    case 'keyvalue': body = <dl className="keyvalue">{c.data.items.map((i, n) => <div key={n}><dt>{i.key}</dt><dd>{stringify(i.value)}</dd></div>)}</dl>; break;
    case 'json': { const text = JSON.stringify(c.data.value, null, 2) ?? ''; body = <pre className={boundedOutput(text) ? 'bounded-output' : undefined}>{text}</pre>; break; }
    case 'tree': body = <Tree nodes={c.data.nodes} />; break;
    case 'status': body = <div className={`status-display ${c.data.state}`}><Activity size={17} /><div><strong>{c.data.label}</strong>{c.data.detail && <p>{c.data.detail}</p>}</div></div>; break;
    case 'embed': body = <Embed key={c.data.html} data={c.data} enabled={embeds} runId={runId} componentId={c.id} />; break;
    default: body = <NativeView component={c} taskTimes={taskTimes} updatedAt={updatedAt} />;
  }
  const Icon = icons[c.kind] ?? FileText, custom = c.kind === 'embed';
  const plain = !custom && configuration.presentation.surface === 'plain';
  const header=control(controls,'header',{visible:!plain}), title=control(controls,'title'), times=control(controls,'times'), footer=control(controls,'footer');
  const configure=control(controls,'configure',{placement:'footer'}), collapse=control(controls,'collapse',{appearance:'text'}), expanded=!(collapsed??configuration.collapsed);
  const origin=plain&&header.visible===false?<span className="component-origin-mark" role="img" aria-label="Built-in component" title="Built-in component"><LayoutGrid size={9} aria-hidden="true"/></span>:<span className={`component-origin ${custom ? 'custom' : 'native'}`} title={custom ? 'Agent-authored HTML and scripts in an isolated document' : 'Built-in typed component rendered by AgenticView'}>{custom ? 'Custom view' : 'Built-in'}</span>;
  const configureAbove=configure.placement==='header'||configure.placement?.startsWith('top-'), configureAllowed=!!original.configuration?.manualFields?.length&&configure.visible!==false&&(configureAbove||footer.visible!==false);
  const settings=configureAllowed?<ControlContainer spec={configure}><ComponentSettings component={original} runId={runId}/></ControlContainer>:null;
  return <ComponentControls value={controls}><section className={`component component-${c.kind} ${custom ? 'is-custom' : isTaskList(c) ? 'is-plan' : ''}`} data-origin={custom ? 'custom' : 'native'} data-surface={plain?'plain':undefined} data-density={!custom?configuration.presentation.density:undefined} aria-label={title.label||configuration.label||c.title||c.kind} title={configuration.tooltip}>
    {header.visible!==false?<h3 data-control="header" title={header.tooltip}><Icon size={12}/>{title.visible!==false&&<span className="component-title" data-control="title" title={title.tooltip}>{title.label??configuration.label??(c.title||c.kind)}</span>}{origin}{times.visible!==false&&updatedAt!==undefined&&<time className="component-time" data-control="times" dateTime={new Date(updatedAt).toISOString()} title={times.tooltip??`Updated: ${exactTime(updatedAt)}`}>{compactTime(updatedAt)}</time>}</h3>:plain?origin:<div className="component-origin-line" data-header-hidden="true">{origin}</div>}
    {configureAbove&&settings}{configuration.description&&<p className="component-description">{configuration.description}</p>}
    {configuration.collapsed!==undefined&&collapse.visible!==false&&<button type="button" data-control="collapse" data-control-variant={collapse.variant} disabled={!active} aria-label={collapse.label??(expanded?'Collapse component':'Expand component')} title={collapse.tooltip} style={controlStyle(collapse)} aria-expanded={expanded} onClick={()=>setCollapsed(!expanded)}><ControlContent spec={collapse} label={expanded?'Collapse component':'Expand component'} icon={<ChevronDown size={14}/>}/></button>}
    {expanded&&<div className="component-configured" style={presentationStyle(configuration.presentation)}>{body}</div>}{!configureAbove&&settings}
  </section></ComponentControls>;
});
