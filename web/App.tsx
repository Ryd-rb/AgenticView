import { lazy, Suspense, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Archive, ArrowDownToLine, ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, Circle, Copy, Focus, LayoutGrid, Link2, Lock, Maximize2, Minus, Plus, Radio, RotateCcw, Settings as Cog, Unlock, X, Zap } from 'lucide-react';
import type { AgentView, ArchiveSummary, Layout, Patch, Settings, Snapshot } from '../shared/protocol.js';
import { findFreePosition, isVisible, moveWithoutOverlap, resizeWithoutOverlap, fitToViewport, formatZoom, type Rect } from '../shared/canvas.js';
import { ComponentView } from './Components.js';
import { TouchViewport, canvasKey, zoomAt, type Camera } from '../shared/viewport.js';
import { applyLivePatch } from '../shared/live-state.js';
import { buildAgentTree, type AgentBranch, type AgentTree } from '../shared/agent-tree.js';
import { gestureOwner, zoomTowardScale } from '../shared/interaction.js';
import { isTaskList } from '../shared/component-order.js';
import { CardSurface } from './CardSurface.js';
import { WindowControls, windowCommand } from './WindowControls.js';
import { installInputTrace } from './InputTrace.js';
import { ArrivalTracker } from '../shared/arrivals.js';
import { ArrivalHalo } from './ArrivalHalo.js';
import { RunTimes } from './RunTimes.js';
import { MonitoringView } from './MonitoringView.js';
const ApplicationLibrary = lazy(() => import('./ApplicationLibrary.js').then(module => ({ default: module.ApplicationLibrary })));

const isUtility = (id?: string | null) => id === 'settings' || id === 'monitoring';

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 401) dispatchEvent(new Event('agenticview:unauthorized'));
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `Request failed (${response.status})`); }
  return response.status === 204 ? undefined as T : response.json();
}
const defaultSettings: Settings = { staleSeconds: 45, autoArchiveMinutes: null, archiveAfterCompletion: false, trustedEmbeds: true, reducedMotion: false };
const empty: Snapshot = { revision: 0, agents: [], settings: defaultSettings, stats: { active: 0, stale: 0, archived: 0, updates: 0, updatesPerSecond: 0 } };
type TouchIntent = { pointer: number; kind: 'pan' | 'drag' | 'resize' | 'scroll' | 'tap'; origin: { x: number; y: number }; last: { x: number; y: number }; camera: Camera; id?: string; rect?: Rect; scroll?: HTMLElement; moved: boolean; };
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
const date = (n: number) => new Date(n).toLocaleString();

function MeasuredContent({ children, watch, onHeight }: { children: React.ReactNode; watch?: string; onHeight: (height: number) => void }) {
  const element = useRef<HTMLDivElement>(null), callback = useRef(onHeight);
  callback.current = onHeight;
  useEffect(() => {
    if (!element.current) return;
    let frame = 0;
    const measure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (element.current) callback.current(element.current.offsetHeight); }); };
    const observer = new ResizeObserver(measure); observer.observe(element.current); measure();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [watch]);
  return <div className="agent-content-measure" ref={element}>{children}</div>;
}

function Login({ complete }: { complete: () => void }) {
  const [token, setToken] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <div className="login-shell"><form className="login-card" onSubmit={async e => { e.preventDefault(); setBusy(true); try { await api('/api/login', 'POST', { token }); setToken(''); complete(); } catch (e) { setError(String((e as Error).message)); } finally { setBusy(false); } }}><div className="brand-mark"><Radio size={22} /></div><div className="eyebrow">YOUR AGENTS, IN VIEW</div><h1>AgenticView</h1><p>Connect to your private observability canvas.</p><label htmlFor="token">Installation access token</label><input id="token" type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} autoFocus required placeholder="Enter your viewer token" />{error && <div className="form-error" role="alert">{error}</div>}<button className="primary" disabled={busy}>{busy ? 'Connecting…' : 'Open canvas'}<ArrowUpRight size={16} /></button><small>Credentials stay in your installation.</small></form><div className="login-grid" /></div>;
}

type AgentContentProps = { agent: AgentView; agents: AgentView[]; settings: Settings; depth?: number; arrivals?: ArrivalTracker; branch?: AgentBranch };
export const AgentContent = memo(function AgentContentBody({ agent, agents, settings, depth = 0, arrivals, branch }: AgentContentProps) {
  const [error, setError] = useState('');
  const children = depth < 12 ? branch ? branch.children.map(child => child.agent) : agents.filter(a => a.parentId === agent.id && a.id !== agent.id) : [];
  const components = Object.values(agent.components), plans = components.filter(isTaskList), evidence = components.filter(c => !isTaskList(c));
  const render = (c: typeof components[number]) => <ComponentView key={c.id} component={c} embeds={settings.trustedEmbeds} runId={agent.id} updatedAt={agent.componentTimes?.[c.id]} taskTimes={agent.taskTimes?.[c.id]} />;
  return <>{plans.map(render)}{error && <div className="form-error" role="alert">{error}</div>}{agent.context && <p className="agent-context">{agent.context}</p>}{children.length > 0 && <div className="children"><div className="section-label">CHILD AGENTS <span>{children.length}</span></div>{children.map((child, index) => <article className={`child-card status-${child.status}`} key={child.id}><ArrivalHalo id={child.id} tracker={arrivals} /><header><span className={`status-dot ${child.status}`} /><strong>{child.name}</strong><span>{child.role}</span><button className={`icon-button ${child.status === 'completed' ? 'archive-completed' : ''}`} title={child.status === 'completed' ? 'Task completed — archive card' : 'Archive child agent'} onClick={() => api(`/api/agents/${encodeURIComponent(child.id)}/archive`, 'POST', {}).catch(e => setError(e.message))}><Archive size={13} />{child.status === 'completed' && <span>Archive</span>}</button></header><div className="child-body"><AgentContent agent={child} agents={agents} settings={settings} depth={depth + 1} arrivals={arrivals} branch={branch?.children[index]} /></div><footer className="child-times"><RunTimes agent={child} /></footer></article>)}</div>}{evidence.map(render)}{!components.length && !children.length && <div className="waiting"><Radio size={18} /><span>Waiting for agent updates</span><small>Components appear here as they arrive.</small></div>}</>;
}, (before, after) => before.settings === after.settings && before.depth === after.depth && before.arrivals === after.arrivals && before.agent.components === after.agent.components && before.agent.context === after.agent.context && before.agent.componentTimes === after.agent.componentTimes && before.agent.taskTimes === after.agent.taskTimes && (before.branch && after.branch ? before.branch.children === after.branch.children : before.agent === after.agent && before.agents === after.agents));

function SettingsBody({ settings, save, stats, report }: { settings: Settings; save: (s: Settings) => Promise<void>; stats: Snapshot['stats']; report: (s: string) => void }) {
  const [tab, setTab] = useState<'general' | 'archives' | 'connect' | 'applications'>('general');
  const [archives, setArchives] = useState<ArchiveSummary[]>([]), [inspect, setInspect] = useState<AgentView | null>(null), [connection, setConnection] = useState<{ mcpUrl: string; ingestUrl: string; credentialHelp: string } | null>(null), [loading, setLoading] = useState(false), [copied, setCopied] = useState('');
  const restore = (id: string) => api(`/api/archives/${encodeURIComponent(id)}/restore`, 'POST', {}).then(() => { setInspect(null); setArchives(current => current.filter(a => a.id !== id)); report('Card restored. Use Fit all to find it on the canvas.'); }).catch(e => report(e.message));
  useEffect(() => { if (tab === 'archives') { setLoading(true); api<ArchiveSummary[]>('/api/archives').then(setArchives).catch(e => report(e.message)).finally(() => setLoading(false)); } if (tab === 'connect') api<typeof connection>('/api/connection').then(setConnection).catch(e => report(e.message)); }, [tab, stats.archived]);
  const update = (part: Partial<Settings>) => save({ ...settings, ...part }).catch(e => report(e.message));
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied(''), 1500); }).catch(() => report('Clipboard unavailable. Select and copy the address.'));
  return <><nav className="settings-tabs" aria-label="Settings sections">{(['general', 'archives', 'applications', 'connect'] as const).map(t => <button className={tab === t ? 'selected' : ''} onClick={() => { setTab(t); setInspect(null); }} key={t}>{t === 'general' ? <Cog size={14} /> : t === 'archives' ? <Archive size={14} /> : <Link2 size={14} />}{t[0].toUpperCase() + t.slice(1)}{t === 'archives' && <span>{stats.archived}</span>}</button>)}</nav><div className="settings-content">{tab === 'general' && <><div className="section-label">INSTALLATION PREFERENCES</div><label className="setting-row"><div><strong>Trusted embedded views</strong><p>Run agent-generated views with scripts and network access, inside isolated documents.</p></div><input type="checkbox" role="switch" checked={settings.trustedEmbeds} onChange={e => update({ trustedEmbeds: e.target.checked })} /></label><label className="setting-row"><div><strong>Automatic archival</strong><p>Archive agents after a period without contact. Off keeps them on your canvas.</p></div><input type="checkbox" role="switch" checked={settings.autoArchiveMinutes !== null} onChange={e => update({ autoArchiveMinutes: e.target.checked ? 30 : null })} /></label>{settings.autoArchiveMinutes !== null && <label className="number-setting">Archive after <input aria-label="Automatic archival minutes" type="number" min="1" max="525600" value={settings.autoArchiveMinutes} onChange={e => { if (+e.target.value >= 1) update({ autoArchiveMinutes: +e.target.value }); }} /> minutes without contact</label>}<label className="setting-row"><div><strong>Archive completed agents</strong><p>Move explicitly completed runs into the archive.</p></div><input type="checkbox" role="switch" checked={settings.archiveAfterCompletion} onChange={e => update({ archiveAfterCompletion: e.target.checked })} /></label><label className="number-setting">Mark stale after <input type="number" min="15" max="86400" value={settings.staleSeconds} onChange={e => { if (+e.target.value >= 15) update({ staleSeconds: +e.target.value }); }} /> seconds</label><label className="setting-row"><div><strong>Reduce motion</strong><p>Keep interface transitions minimal.</p></div><input type="checkbox" role="switch" checked={settings.reducedMotion} onChange={e => update({ reducedMotion: e.target.checked })} /></label><div className="settings-note"><Zap size={16} /><div><strong>Explore with a synthetic workspace</strong><p>Add example agents and components. Demo data is explicitly labeled.</p><button className="secondary" onClick={() => api('/api/demo', 'POST', {}).then(() => report('Synthetic agents added to your canvas.')).catch(e => report(e.message))}>Add demo agents <ArrowUpRight size={13} /></button></div></div></>}
    {tab === 'archives' && (inspect ? <><button className="text-button" onClick={() => setInspect(null)}><ArrowLeft size={14} /> All archives</button><div className="archive-heading"><div><h2>{inspect.name}</h2><small>{inspect.role} · read only</small></div><button className="secondary" onClick={() => restore(inspect.id)}><RotateCcw size={14} /> Restore card</button><a className="icon-button" title="Download compressed archive" href={`/api/archives/${encodeURIComponent(inspect.id)}/export`}><ArrowDownToLine size={16} /></a></div><AgentContent agent={inspect} agents={[]} settings={{ ...settings, trustedEmbeds: false }} /></> : <><div className="archive-summary"><span><strong>{archives.length}</strong> saved runs</span><span><strong>{bytes(archives.reduce((n, a) => n + a.bytes, 0))}</strong> gzip storage</span></div><div className="section-label">LOCAL ARCHIVES</div>{loading ? <p className="muted">Loading archives…</p> : !archives.length ? <div className="empty-section"><Archive size={24} /><h3>No archived agents</h3><p>Retired runs stay here, on this installation.</p></div> : archives.map(a => <div className="archive-row" key={a.id}><button onClick={() => api<AgentView>(`/api/archives/${encodeURIComponent(a.id)}`).then(setInspect).catch(e => report(e.message))}><strong>{a.name}</strong><small>{a.role} · {date(a.archivedAt)}</small><span>{bytes(a.bytes)} gzip <span className="muted"> / {bytes(a.rawBytes)} raw</span></span></button><button className="icon-button" title={`Restore ${a.name}`} aria-label={`Restore ${a.name}`} onClick={() => restore(a.id)}><RotateCcw size={15} /></button><a className="icon-button" title={`Download ${a.name}`} href={`/api/archives/${encodeURIComponent(a.id)}/export`}><ArrowDownToLine size={15} /></a></div>)}</>)}
    {tab === 'applications' && <Suspense fallback={<p role="status">Loading application library…</p>}><ApplicationLibrary report={report} /></Suspense>}
    {tab === 'connect' && <><div className="section-label">CONNECT AN AGENT</div><h2>One canvas. Any workflow.</h2><p className="intro-text">Publish context, metrics, logs, and structured components from your agents and tools.</p>{connection ? <>{([['MCP endpoint', connection.mcpUrl], ['HTTP ingestion', connection.ingestUrl]] as const).map(([name, value]) => <div className="connection-field" key={name}><label>{name}</label><div><code>{value}</code><button className="icon-button" title={`Copy ${name}`} onClick={() => copy(value)}>{copied === value ? <Check size={15} /> : <Copy size={15} />}</button></div></div>)}<div className="connect-help"><Lock size={15} /><p>{connection.credentialHelp}</p></div></> : <p className="muted">Loading connection details…</p>}<div className="protocol-note"><span>Native components</span><span>Incremental updates</span><span>Persistent archives</span></div></>}
  </div></>;
}

export function App() { return <><WindowControls /><Monitor /></>; }
function Monitor() {
  const [auth, setAuth] = useState<boolean | null>(null), [snapshot, setSnapshot] = useState<Snapshot>(empty), [snapshotReady, setSnapshotReady] = useState(false), [online, setOnline] = useState(false), [notice, setNotice] = useState('');
  const [camera, setCamera] = useState<Camera>({ x: 72, y: 86, zoom: 1 }), [size, setSize] = useState({ width: innerWidth, height: innerHeight }), [settingsRect, setSettingsRect] = useState<Rect | null>(null), [layouts, setLayouts] = useState<Record<string, Layout>>({}), [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [packing, setPacking] = useState(false), arrivals = useRef(new ArrivalTracker());
  const [monitoringRect, setMonitoringRect] = useState<Rect | null>(null), monitoringRef = useRef<Rect | null>(null);
  const [activeCard, setActiveCard] = useState<string | null>(null), activeCardRef = useRef<string | null>(null), spaceHeld = useRef(false);
  const cardCameras = useRef(new Map<string, Camera>());
  const touchPoints = useRef(new Map<number, { x: number; y: number; card: string | null }>());
  function activateCard(id: string | null) {
    const previous = activeCardRef.current; activeCardRef.current = id; setActiveCard(id);
    if (previous && previous !== id) {
      leaseInteraction(previous, contentInteractions.current.has(previous));
      const height = pendingContentHeights.current.get(previous);
      if (height !== undefined) requestAnimationFrame(() => growContent(previous, height));
    }
    if (id) leaseInteraction(id, true);
    if (previous !== id) setInteractionRevision(revision => revision + 1);
  }
  const manualWrites = useRef(new Map<string, Promise<Layout>>());
  const canvasElement = useRef<HTMLDivElement>(null), touches = useRef(new TouchViewport()), touchIntent = useRef<TouchIntent | null>(null), suppressClickUntil = useRef(0), lastTap = useRef<{ id: string; at: number; x: number; y: number } | null>(null), mouseCleanup = useRef<(() => void) | null>(null);
  const activeDrag = useRef<string | null>(null), remoteLayouts = useRef<Record<string, string>>({});
  const contentInteractions = useRef(new Set<string>()), pendingContentHeights = useRef(new Map<string, number>());
  const interactionWrites = useRef(new Map<string, Promise<void>>());
  const [interactionLeaseId] = useState(() => crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-'));
  const [interactionRevision, setInteractionRevision] = useState(0);
  const cameraRef = useRef(camera), layoutRef = useRef(layouts), snapshotRef = useRef(snapshot), settingsRef = useRef(settingsRect);
  cameraRef.current = camera; layoutRef.current = layouts; snapshotRef.current = snapshot; settingsRef.current = settingsRect;
  monitoringRef.current = monitoringRect;
  function utilityRects(): [string, Rect][] { const entries: [string, Rect | null][] = [['settings', settingsRef.current], ['monitoring', monitoringRef.current]]; return entries.filter((entry): entry is [string, Rect] => entry[1] !== null); }
  function worldRect(id: string): Rect | undefined | null { return id === 'settings' ? settingsRef.current : id === 'monitoring' ? monitoringRef.current : layoutRef.current[id]; }
  function setUtilityRect(id: string, rect: Rect | null) { if (id === 'settings') { settingsRef.current = rect; setSettingsRect(rect); } else { monitoringRef.current = rect; setMonitoringRect(rect); } }
  const report = useCallback((message: string) => { setNotice(message); }, []);
  useEffect(() => installInputTrace(), []);
  useEffect(() => () => { const ids = new Set([...contentInteractions.current, ...(activeCardRef.current ? [activeCardRef.current] : [])]); activeCardRef.current = null; contentInteractions.current.clear(); for (const id of ids) leaseInteraction(id, false); }, []);
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(id); }, [notice]);
  useEffect(() => { const unauthorized = () => setAuth(false); addEventListener('agenticview:unauthorized', unauthorized); api<{ authenticated: boolean }>('/api/session').then(s => setAuth(s.authenticated)).catch(() => setAuth(false)); const resize = () => setSize({ width: innerWidth, height: innerHeight }); addEventListener('resize', resize); return () => { removeEventListener('resize', resize); removeEventListener('agenticview:unauthorized', unauthorized); }; }, []);
  useEffect(() => {
    if (!auth) return;
    let alive = true;
    const events = new EventSource('/api/events');
    events.onopen = () => setOnline(true);
    events.onerror = () => setOnline(false);
    events.addEventListener('snapshot', event => { const s = JSON.parse((event as MessageEvent).data) as Snapshot; if (alive) { setSnapshot(s); setSnapshotReady(true); } });
    events.addEventListener('patch', event => { if (!alive) return; const patch = JSON.parse((event as MessageEvent).data) as Patch; setSnapshot(old => applyLivePatch(old, patch)); });
    return () => { alive = false; events.close(); };
  }, [auth, report]);
  const priorTree = useRef<AgentTree | undefined>(undefined);
  const tree = useMemo(() => { const next = buildAgentTree(snapshot.agents, priorTree.current); priorTree.current = next; return next; }, [snapshot.agents]);
  const roots = tree.roots;
  const agentIds = useMemo(() => snapshot.agents.map(agent => agent.id).join('|'), [snapshot.agents]);
  useLayoutEffect(() => { if (snapshotReady) arrivals.current.sync(snapshot.agents.map(agent => agent.id)); }, [agentIds, snapshotReady]);
  useEffect(() => { const ids = new Set(snapshot.agents.map(agent => agent.id)); ids.add('settings'); ids.add('monitoring'); for (const id of cardCameras.current.keys()) if (!ids.has(id)) cardCameras.current.delete(id); for (const id of pendingContentHeights.current.keys()) if (!ids.has(id)) pendingContentHeights.current.delete(id); if (activeCardRef.current && !ids.has(activeCardRef.current)) activateCard(null); }, [snapshot.agents]);
  const movableCount = useMemo(() => roots.filter(agent => !agent.layout.locked).length, [roots]);
  const layoutSignature = useMemo(() => roots.map(a => `${a.id}:${JSON.stringify(a.layout)}`).join('|'), [roots]);
  useEffect(() => {
    const previous = layoutRef.current, next: Record<string, Layout> = {}, occupied: Rect[] = [];
    // The ephemeral settings card yields to agent geometry, including locked cards.
    const held = (id: string) => activeDrag.current === id || contentInteractions.current.has(id) || activeCardRef.current === id;
    occupied.push(...utilityRects().filter(([id]) => held(id)).map(([, rect]) => rect));
    for (const a of [...roots].sort((a, b) => Number(held(b.id)) - Number(held(a.id)) || Number(b.layout.locked) - Number(a.layout.locked))) {
      const existing = previous[a.id], remote = JSON.stringify(a.layout), changed = remoteLayouts.current[a.id] !== remote;
      const proposed = held(a.id) ? existing ?? a.layout : changed ? a.layout : existing ?? a.layout;
      if (!held(a.id)) remoteLayouts.current[a.id] = remote;
      const placed = proposed.locked || held(a.id) ? proposed : findFreePosition(proposed, occupied);
      next[a.id] = { ...proposed, ...placed }; occupied.push(placed);
      if (placed.x !== proposed.x || placed.y !== proposed.y) persist(a.id, next[a.id]!);
    }
    layoutRef.current = next; setLayouts(next);
    for (const [id, rect] of utilityRects()) {
      if (held(id)) continue;
      const placed = findFreePosition(rect, occupied); occupied.push(placed);
      if (placed.x !== rect.x || placed.y !== rect.y) setUtilityRect(id, placed);
    }
  }, [layoutSignature, size.width, size.height, interactionRevision]);
  function leaseInteraction(id: string, active: boolean) {
    if (isUtility(id)) return;
    const previous = interactionWrites.current.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if ((contentInteractions.current.has(id) || activeCardRef.current === id) !== active) return;
      if (!snapshotRef.current.agents.some(agent => agent.id === id)) return;
      await api(`/api/agents/${encodeURIComponent(id)}/layout/interaction`, 'POST', { active, leaseId: interactionLeaseId });
    }).catch(error => report(error.message)).finally(() => { if (interactionWrites.current.get(id) === next) interactionWrites.current.delete(id); });
    interactionWrites.current.set(id, next);
  }
  function contentInteraction(id: string, active: boolean) {
    if (active === contentInteractions.current.has(id)) return;
    if (active) {
      contentInteractions.current.add(id);
    } else {
      contentInteractions.current.delete(id);
      const height = pendingContentHeights.current.get(id); if (height !== undefined) requestAnimationFrame(() => growContent(id, height));
    }
    leaseInteraction(id, active || activeCardRef.current === id);
    setInteractionRevision(revision => revision + 1);
  }
  function obstacles(id?: string): Rect[] { return [...Object.entries(layoutRef.current).filter(([key]) => key !== id).map(([, value]) => value), ...utilityRects().filter(([key]) => key !== id).map(([, rect]) => rect)]; }
  function reserveManual(id: string) {
    if (isUtility(id) || manualWrites.current.has(id)) return;
    const request = api<Layout>(`/api/agents/${encodeURIComponent(id)}/layout/manual`, 'POST', {}); manualWrites.current.set(id, request);
    void request.catch(error => report(error.message));
  }
  function persist(id: string, layout: Layout) {
    const reservation = manualWrites.current.get(id);
    void Promise.resolve(reservation).then(() => api<Layout>(`/api/agents/${encodeURIComponent(id)}/layout`, 'PATCH', { ...layout, resolveOverlap: layout.automatic === false })).then(accepted => {
      layoutRef.current = { ...layoutRef.current, [id]: accepted }; setLayouts(layoutRef.current);
    }).catch(error => report(error.message)).finally(() => { if (manualWrites.current.get(id) === reservation) manualWrites.current.delete(id); });
  }
  function commitLayout(id: string, layout: Layout) { layoutRef.current = { ...layoutRef.current, [id]: layout }; setLayouts(layoutRef.current); persist(id, layout); }
  function growContent(id: string, contentHeight: number) {
    const current = layoutRef.current[id];
    if (!current || current.sizing !== 'content' || activeDrag.current === id) return;
    if (contentInteractions.current.has(id) || activeCardRef.current === id) { pendingContentHeights.current.set(id, contentHeight); return; }
    pendingContentHeights.current.delete(id);
    const height = Math.max(240, Math.min(1600, Math.ceil(contentHeight + 125)));
    if (Math.abs(height - current.height) < 2) return;
    const available = obstacles(id);
    const resized = current.locked || activeCardRef.current === id ? resizeWithoutOverlap(current, { width: current.width, height }, available) : findFreePosition({ ...current, height }, available);
    if (Math.abs(resized.height - current.height) < 1 && resized.x === current.x && resized.y === current.y) return;
    commitLayout(id, { ...current, ...resized });
  }
  function resizeCard(e: React.PointerEvent<HTMLElement>, id: string) {
    if (e.button !== 0 || e.pointerType === 'touch' || activeCardRef.current !== id || spaceHeld.current || e.altKey) return;
    e.stopPropagation(); e.preventDefault();
    const initial = layoutRef.current[id]; if (!initial) return;
    const element = e.currentTarget; element.setPointerCapture(e.pointerId); let moved = false;
    const pointer = { x: e.clientX, y: e.clientY }, zoom = cameraRef.current.zoom;
    let last: Layout = initial;
    const move = (event: PointerEvent) => {
      if (!moved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 4) return;
      if (!moved) { moved = true; reserveManual(id); activeDrag.current = id; }
      const width = Math.max(320, Math.min(1600, initial.width + (event.clientX - pointer.x) / zoom));
      const height = Math.max(240, Math.min(1600, initial.height + (event.clientY - pointer.y) / zoom));
      last = { ...initial, ...resizeWithoutOverlap(initial, { width, height }, obstacles(id)), sizing: 'fixed', automatic: false };
      layoutRef.current = { ...layoutRef.current, [id]: last }; setLayouts(layoutRef.current);
    };
    const up = () => { mouseCleanup.current = null; activeDrag.current = null; element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up); if (moved) persist(id, last); };
    mouseCleanup.current = up;
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', up); element.addEventListener('pointercancel', up);
  }
  function resizeKeyboard(e: React.KeyboardEvent, id: string) {
    if (activeCardRef.current !== id) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation(); const current = layoutRef.current[id]; if (!current) return;
    const step = e.shiftKey ? 80 : 20;
    const width = Math.max(320, Math.min(1600, current.width + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0)));
    const height = Math.max(240, Math.min(1600, current.height + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)));
    commitLayout(id, { ...current, ...resizeWithoutOverlap(current, { width, height }, obstacles(id)), sizing: 'fixed', automatic: false });
  }
  function dragCard(e: React.PointerEvent<HTMLElement>, id: string) {
    if (e.button !== 0 || e.pointerType === 'touch' || activeCardRef.current !== id || spaceHeld.current || e.altKey || (e.target as HTMLElement).closest('button,a,input')) return;
    const initial = worldRect(id);
    if (!initial || !isUtility(id) && (initial as Layout).locked) return;
    e.stopPropagation(); const element = e.currentTarget; element.setPointerCapture(e.pointerId); let moved = false;
    const pointer = { x: e.clientX, y: e.clientY }, zoom = cameraRef.current.zoom; let last = initial;
    const move = (event: PointerEvent) => { if (!moved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 4) return; if (!moved) { moved = true; reserveManual(id); activeDrag.current = id; } last = moveWithoutOverlap(initial, { x: initial.x + (event.clientX - pointer.x) / zoom, y: initial.y + (event.clientY - pointer.y) / zoom }, obstacles(id)); if (isUtility(id)) setUtilityRect(id, last); else setLayouts(previous => ({ ...previous, [id]: { ...previous[id]!, ...last, automatic: false } })); };
    const up = () => { mouseCleanup.current = null; activeDrag.current = null; element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up); if (moved && !isUtility(id)) persist(id, { ...layoutRef.current[id]!, ...last, automatic: false }); };
    mouseCleanup.current = up;
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', up); element.addEventListener('pointercancel', up);
  }
  function pan(e: React.PointerEvent<HTMLDivElement>, force = false) {
    if (e.pointerType === 'touch' || ![0, 1].includes(e.button) || !force && ((e.target as HTMLElement).closest('.chrome,button,a,input,select,textarea') || e.button === 0 && (e.target as HTMLElement).closest('.world-card'))) return;
    if (force) e.stopPropagation();
    e.preventDefault(); e.currentTarget.focus({ preventScroll: true });
    const element = e.currentTarget, origin = { x: e.clientX, y: e.clientY }, initial = cameraRef.current, overCard = !!(e.target as Element).closest('.world-card');
    if (!overCard) element.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => { if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 4) return; element.setPointerCapture(e.pointerId); suppressClickUntil.current = performance.now() + 400; applyCamera({ ...initial, x: initial.x + event.clientX - origin.x, y: initial.y + event.clientY - origin.y }); };
    const up = () => { mouseCleanup.current = null; element.removeEventListener('pointermove', move, true); element.removeEventListener('pointerup', up, true); element.removeEventListener('pointercancel', up, true); };
    mouseCleanup.current = up;
    element.addEventListener('pointermove', move, true); element.addEventListener('pointerup', up, true); element.addEventListener('pointercancel', up, true);
  }
  function canvasPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'touch') { touchStart(e); return; }
    const id = (e.target as Element).closest<HTMLElement>('[data-card-id]')?.dataset.cardId ?? null;
    if (e.button === 1 || spaceHeld.current || e.altKey || id && gestureOwner(activeCardRef.current, id) === 'canvas') pan(e, true);
    else if (!id) activateCard(null);
  }
  function canvasClick(e: React.MouseEvent<HTMLDivElement>) {
    if (performance.now() < suppressClickUntil.current) { e.preventDefault(); e.stopPropagation(); return; }
    const id = (e.target as Element).closest<HTMLElement>('[data-card-id]')?.dataset.cardId ?? null;
    if (id && activeCardRef.current !== id) { activateCard(id); e.preventDefault(); e.stopPropagation(); }
    else if (!id) activateCard(null);
  }
  function applyCamera(next: Camera, card?: string) { if (activeDrag.current) { const id = activeDrag.current; mouseCleanup.current?.(); if (!isUtility(id) && layoutRef.current[id]) persist(id, layoutRef.current[id]!); activeDrag.current = null; touchIntent.current = null; } dispatchEvent(new CustomEvent('agenticview:canvas-navigation', { detail: { card } })); cameraRef.current = next; setCamera(next); }
  function panCardEdge(id: string, x: number, y: number) { const c = cameraRef.current; applyCamera({ ...c, x: c.x - x, y: c.y - y }, id); }
  function zoomBeforeCard(id: string, factor: number, anchor: { x: number; y: number }) { const result = zoomTowardScale(cameraRef.current, 2, factor, anchor); if (result.remaining !== factor) applyCamera(result.camera, id); return result.remaining; }
  function zoomPastCard(id: string, factor: number, anchor: { x: number; y: number }) { applyCamera(zoomAt(cameraRef.current, factor, anchor), id); }
  function zoom(amount: number, at = { x: size.width / 2, y: size.height / 2 }) { applyCamera(zoomAt(cameraRef.current, amount, at)); }
  function resetZoom() { zoom(1 / cameraRef.current.zoom); }
  function fit() { applyCamera(fitToViewport([...Object.values(layoutRef.current), ...utilityRects().map(([, rect]) => rect)], size)); }
  function focusCard(id: string) { const rect = worldRect(id); if (rect) applyCamera(fitToViewport([rect], size, 80)); }
  async function arrangeAll() {
    setPacking(true);
    try {
      // Explicit global arrangement ends the local hold before asking the server to pack.
      applyCamera(cameraRef.current); activateCard(null);
      await Promise.all([...interactionWrites.current.values()]);
      const result = await api<{ arranged: number }>('/api/layout/pack', 'POST', { mode: 'all', aspectRatio: Math.max(.3, Math.min(4, (size.width - 120) / Math.max(100, size.height - 160))) });
      fit(); report(`Arranged ${result.arranged} cards. Locked positions preserved.`);
    } catch (error) { report((error as Error).message); } finally { setPacking(false); }
  }
  function openSettings() { if (settingsRect) { activateCard(null); setSettingsRect(null); return; } activateCard('settings'); const c = { ...cameraRef.current, zoom: Math.max(.8, cameraRef.current.zoom) }; const placed = findFreePosition({ x: (size.width / 2 - c.x) / c.zoom - 290, y: (size.height / 2 - c.y) / c.zoom - 290, width: 580, height: 610 }, obstacles()); setSettingsRect(placed); setCamera({ ...c, x: size.width / 2 - (placed.x + placed.width / 2) * c.zoom, y: size.height / 2 - (placed.y + placed.height / 2) * c.zoom }); }
  function openMonitoring() {
    if (monitoringRef.current) { activateCard(null); setUtilityRect('monitoring', null); return; }
    const c = { ...cameraRef.current, zoom: Math.max(1, cameraRef.current.zoom) }, width = Math.max(480, Math.min(820, (size.width - 100) / c.zoom)), height = Math.max(420, Math.min(760, (size.height - 140) / c.zoom));
    const placed = findFreePosition({ x: (size.width / 2 - c.x) / c.zoom - width / 2, y: (size.height / 2 - c.y) / c.zoom - height / 2, width, height }, obstacles());
    setUtilityRect('monitoring', placed); activateCard('monitoring'); applyCamera({ ...c, x: size.width / 2 - (placed.x + width / 2) * c.zoom, y: size.height / 2 - (placed.y + height / 2) * c.zoom });
  }
  function keyboard(e: React.KeyboardEvent, id: string) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' && activeCardRef.current !== id) { e.preventDefault(); e.stopPropagation(); activateCard(id); return; }
    if (activeCardRef.current !== id) return;
    if (e.key === 'Enter') { e.preventDefault(); focusCard(id); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const rect = worldRect(id); if (!rect || !isUtility(id) && (rect as Layout).locked) return;
    e.preventDefault(); e.stopPropagation(); const step = e.shiftKey ? 80 : 20;
    const moved = moveWithoutOverlap(rect, { x: rect.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0), y: rect.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0) }, obstacles(id));
    if (isUtility(id)) setUtilityRect(id, moved);
    else { const next = { ...layoutRef.current[id]!, ...moved, automatic: false }; layoutRef.current = { ...layoutRef.current, [id]: next }; setLayouts(layoutRef.current); persist(id, next); }
  }
  function canvasKeyboard(e: React.KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape' && activeCardRef.current) { e.preventDefault(); activateCard(null); return; }
    const protectedTarget = !!(e.target as Element).closest('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[role="textbox"],.resize-handle');
    const action = canvasKey(e.key, protectedTarget, e.altKey || e.ctrlKey || e.metaKey); if (!action) return;
    e.preventDefault(); const c = cameraRef.current, step = e.shiftKey ? 180 : 60;
    if (action === 'fit') fit(); else if (action === 'reset') resetZoom(); else if (action === 'in') zoom(1.2); else if (action === 'out') zoom(1 / 1.2); else if (action === 'escape') { setUtilityRect('settings', null); setUtilityRect('monitoring', null); }
    else applyCamera({ ...c, x: c.x + (action === 'left' ? step : action === 'right' ? -step : 0), y: c.y + (action === 'up' ? step : action === 'down' ? -step : 0) });
  }
  function touchStart(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== 'touch') return;
    const target = e.target as Element, id = target.closest<HTMLElement>('[data-card-id]')?.dataset.cardId;
    const point = { x: e.clientX, y: e.clientY };
    const local = !!target.closest('[data-card-surface]') && gestureOwner(activeCardRef.current, id ?? null, spaceHeld.current || e.altKey) === 'card';
    touchPoints.current.set(e.pointerId, { ...point, card: local ? id! : null });
    if (local && touches.current.count === 0 && [...touchPoints.current.values()].every(touch => touch.card === id)) return;
    if (touches.current.count === 0 && touchPoints.current.size > 1) { dispatchEvent(new Event('agenticview:canvas-navigation')); for (const [pointerId, p] of touchPoints.current) touches.current.start(pointerId, p, cameraRef.current); }
    else touches.current.start(e.pointerId, point, cameraRef.current);
    if (touches.current.count >= 2) {
      mouseCleanup.current?.();
      if (activeDrag.current && !isUtility(activeDrag.current) && layoutRef.current[activeDrag.current]) persist(activeDrag.current, layoutRef.current[activeDrag.current]!);
      activeDrag.current = null; touchIntent.current = null; lastTap.current = null; suppressClickUntil.current = performance.now() + 700; e.preventDefault(); return;
    }
    const inactive = !!id && activeCardRef.current !== id;
    const controls = !inactive && !!target.closest('button,a,input,textarea,select,[contenteditable]:not([contenteditable="false"])');
    const rect = id ? worldRect(id) : undefined;
    let scroll: HTMLElement | undefined;
    if (!controls) {
      let cursor = target instanceof HTMLElement ? target : target.parentElement;
      while (cursor && cursor !== e.currentTarget) {
        const style = getComputedStyle(cursor);
        if (/(auto|scroll)/.test(style.overflowY + style.overflowX) && (cursor.scrollHeight > cursor.clientHeight || cursor.scrollWidth > cursor.clientWidth)) { scroll = cursor; break; }
        cursor = cursor.parentElement;
      }
      scroll ??= target.closest<HTMLElement>('.card-body,.settings-content,.child-body') ?? undefined;
    }
    const canDrag = !inactive && !!rect && !!target.closest('.card-header') && (isUtility(id) || !(rect as Layout).locked);
    const kind: TouchIntent['kind'] = inactive || spaceHeld.current || e.altKey ? 'pan' : controls ? target.closest('.resize-handle') ? 'resize' : 'tap' : canDrag ? 'drag' : scroll ? 'scroll' : !id ? 'pan' : 'tap';
    touchIntent.current = { pointer: e.pointerId, kind, origin: point, last: point, camera: { ...cameraRef.current }, id: controls && kind !== 'resize' ? undefined : id, rect: rect ?? undefined, scroll, moved: false };
  }
  function touchMove(e: React.PointerEvent<HTMLDivElement>) {
    const tracked = touchPoints.current.get(e.pointerId); if (tracked) touchPoints.current.set(e.pointerId, { ...tracked, x: e.clientX, y: e.clientY });
    if (e.pointerType !== 'touch' || !touches.current.pointers.has(e.pointerId)) return;
    const point = { x: e.clientX, y: e.clientY }, pinched = touches.current.move(e.pointerId, point);
    if (pinched) { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); suppressClickUntil.current = performance.now() + 700; applyCamera(pinched); return; }
    const intent = touchIntent.current; if (!intent || intent.pointer !== e.pointerId) return;
    const dx = point.x - intent.origin.x, dy = point.y - intent.origin.y;
    if (!intent.moved && Math.hypot(dx, dy) < 7) return;
    intent.moved = true; lastTap.current = null;
    if (intent.kind === 'tap') return;
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); suppressClickUntil.current = performance.now() + 500;
    if (intent.kind === 'pan') applyCamera({ ...intent.camera, x: intent.camera.x + dx, y: intent.camera.y + dy });
    if (intent.kind === 'scroll' && intent.scroll) { intent.scroll.scrollTop -= (point.y - intent.last.y) / cameraRef.current.zoom; intent.scroll.scrollLeft -= (point.x - intent.last.x) / cameraRef.current.zoom; }
    if (intent.id && intent.rect && (intent.kind === 'drag' || intent.kind === 'resize')) {
      if (activeDrag.current !== intent.id) reserveManual(intent.id); activeDrag.current = intent.id;
      const next = intent.kind === 'drag' ? moveWithoutOverlap(intent.rect, { x: intent.rect.x + dx / intent.camera.zoom, y: intent.rect.y + dy / intent.camera.zoom }, obstacles(intent.id)) : resizeWithoutOverlap(intent.rect, { width: Math.max(320, Math.min(1600, intent.rect.width + dx / intent.camera.zoom)), height: Math.max(240, Math.min(1600, intent.rect.height + dy / intent.camera.zoom)) }, obstacles(intent.id));
      if (isUtility(intent.id)) { setUtilityRect(intent.id!, next); }
      else { layoutRef.current = { ...layoutRef.current, [intent.id]: { ...layoutRef.current[intent.id]!, ...next, automatic: false, ...(intent.kind === 'resize' ? { sizing: 'fixed' as const } : {}) } }; setLayouts(layoutRef.current); }
    }
    intent.last = point;
  }
  function touchEnd(e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) {
    touchPoints.current.delete(e.pointerId);
    if (e.pointerType !== 'touch' || !touches.current.pointers.has(e.pointerId)) return;
    const intent = touchIntent.current;
    if (intent?.pointer === e.pointerId) {
      if (intent.moved) { suppressClickUntil.current = performance.now() + 400; if (intent.id && ['drag', 'resize'].includes(intent.kind) && !isUtility(intent.id)) persist(intent.id, layoutRef.current[intent.id]!); }
      else if (!cancelled && intent.id) {
        if (activeCardRef.current !== intent.id) { activateCard(intent.id); suppressClickUntil.current = performance.now() + 400; }
        else {
        const previous = lastTap.current, now = performance.now();
        if (previous?.id === intent.id && now - previous.at < 350 && Math.hypot(e.clientX - previous.x, e.clientY - previous.y) < 25) { focusCard(intent.id); lastTap.current = null; suppressClickUntil.current = now + 400; }
        else lastTap.current = { id: intent.id, at: now, x: e.clientX, y: e.clientY };
        }
      }
    }
    if (cancelled) touches.current.cancel(e.pointerId, cameraRef.current); else touches.current.end(e.pointerId, cameraRef.current);
    activeDrag.current = null; touchIntent.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const remaining = [...touches.current.pointers.entries()];
    if (remaining.length === 1) touchIntent.current = { pointer: remaining[0]![0], kind: 'pan', origin: remaining[0]![1], last: remaining[0]![1], camera: { ...cameraRef.current }, moved: false };
  }
  useEffect(() => {
    const element = canvasElement.current; if (!element) return;
    const wheel = (e: WheelEvent) => {
      const id = (e.target as Element).closest<HTMLElement>('[data-card-surface]')?.dataset.cardSurface ?? null;
      if (gestureOwner(activeCardRef.current, id, spaceHeld.current || e.altKey) === 'card') return;
      e.preventDefault(); e.stopPropagation(); const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.height : 1);
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) { const c = cameraRef.current; applyCamera({ ...c, x: c.x - delta - e.deltaX }); }
      else zoom(Math.exp(Math.max(-4, Math.min(4, -delta * .0015))), { x: e.clientX, y: e.clientY });
    };
    const clear = () => { const id = activeDrag.current; if (id && !isUtility(id) && layoutRef.current[id]) persist(id, layoutRef.current[id]!); touches.current.clear(); touchPoints.current.clear(); touchIntent.current = null; activeDrag.current = null; spaceHeld.current = false; mouseCleanup.current?.(); };
    const key = (event: KeyboardEvent) => { if (event.code === 'Space' && (event.type === 'keyup' || !(event.target instanceof Element) || !event.target.closest('input,textarea,select,button,[contenteditable=true]'))) { spaceHeld.current = event.type === 'keydown'; if (spaceHeld.current) { event.preventDefault(); dispatchEvent(new Event('agenticview:canvas-navigation')); } } };
    const leaseTimer = setInterval(() => { for (const id of new Set([...contentInteractions.current, ...(activeCardRef.current ? [activeCardRef.current] : [])])) leaseInteraction(id, true); const id = activeDrag.current; if (id && !isUtility(id)) void api('/api/agents/' + encodeURIComponent(id) + '/layout/manual', 'POST', {}).catch(error => report(error.message)); }, 10_000); element.addEventListener('wheel', wheel, { passive: false, capture: true }); window.addEventListener('blur', clear); window.addEventListener('keydown', key); window.addEventListener('keyup', key);
    return () => { clearInterval(leaseTimer); element.removeEventListener('wheel', wheel, true); window.removeEventListener('blur', clear); window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); clear(); };
  }, [auth, size.width, size.height]);
  if (auth === null) return <div className="boot"><Radio size={22} /><span>Connecting to AgenticView</span></div>;
  if (!auth) return <Login complete={() => setAuth(true)} />;
  const viewport: Rect = { x: -camera.x / camera.zoom - 150, y: -camera.y / camera.zoom - 150, width: size.width / camera.zoom + 300, height: size.height / camera.zoom + 300 };
  function monitoringCard(rect: Rect) {
    return <article className={`world-card monitoring-card ${activeCard === 'monitoring' ? 'is-active' : ''}`} data-card-id="monitoring" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 100001 }} onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button,a,input,select,textarea')) focusCard('monitoring'); }}>
      <header className="card-header" onPointerDown={e => dragCard(e, 'monitoring')} tabIndex={0} onKeyDown={e => keyboard(e, 'monitoring')} aria-label="Hub monitoring"><div className="settings-icon"><Activity size={18} /></div><div className="agent-title"><strong>Hub monitoring</strong><span>Live telemetry · current installation</span></div><button className="icon-button" title="Close monitoring" aria-label="Close monitoring" onClick={() => { activateCard(null); setUtilityRect('monitoring', null); }}><X size={17} /></button></header>
      <CardSurface id="monitoring" onInteractionChange={active => contentInteraction('monitoring', active)} store={cardCameras.current} active={activeCard === 'monitoring'} deactivate={() => activateCard(null)} canvasOwnsPointer={id => touches.current.pointers.has(id)} forceCanvas={() => spaceHeld.current} panPastEdge={(x, y) => panCardEdge('monitoring', x, y)} canvasCamera={camera} getCanvasCamera={() => cameraRef.current} getCanvasBounds={() => canvasElement.current!.getBoundingClientRect()} zoomBeforeCard={(factor, anchor) => zoomBeforeCard('monitoring', factor, anchor)} zoomPastCard={(factor, anchor) => zoomPastCard('monitoring', factor, anchor)}><MonitoringView /></CardSurface>
    </article>;
  }
  return <main className={`app ${snapshot.settings.reducedMotion ? 'reduced-motion' : ''}`}><div ref={canvasElement} className="canvas" tabIndex={0} onKeyDown={canvasKeyboard} onPointerDownCapture={canvasPointerDown} onPointerMoveCapture={touchMove} onPointerUpCapture={e => touchEnd(e, false)} onPointerCancelCapture={e => touchEnd(e, true)} onClickCapture={canvasClick} onPointerDown={pan} style={{ backgroundPosition: `${camera.x}px ${camera.y}px`, backgroundSize: `${Math.max(12, 24 * camera.zoom)}px ${Math.max(12, 24 * camera.zoom)}px`, backgroundImage: camera.zoom < .1 ? 'none' : undefined }} aria-label="Agent canvas. Drag the background to pan. Use zoom controls to navigate.">
    <div className="world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>{roots.map(agent => { const layout = layouts[agent.id]; if (!layout || !isVisible(layout, viewport) && !contentInteractions.current.has(agent.id) && activeDrag.current !== agent.id) return null; const isCollapsed = collapsed.has(agent.id); return <article className={`world-card agent-card status-${agent.status} ${layout.locked ? 'locked' : ''} ${activeCard === agent.id ? 'is-active' : ''}`} key={agent.id} data-card-id={agent.id} title={`${agent.name} · double-click or double-tap to focus`} onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button,a,input,select,textarea')) focusCard(agent.id); }} style={{ left: layout.x, top: layout.y, width: layout.width, height: isCollapsed ? 68 : layout.height, zIndex: layout.z }}><ArrivalHalo id={agent.id} tracker={arrivals.current} /><header className="card-header" onPointerDown={e => dragCard(e, agent.id)} onKeyDown={e => keyboard(e, agent.id)} tabIndex={0} aria-label={`${agent.name}, ${activeCard === agent.id ? layout.locked ? 'locked' : 'use arrow keys to move' : 'press Enter to activate'}`}><span className={`status-dot ${agent.status}`} /><div className="agent-title"><strong>{agent.name}</strong><span>{agent.role}</span></div><div className="card-actions"><button className="icon-button" title={layout.sizing === 'content' ? 'Use fixed size' : 'Grow with content'} aria-label="Grow with content" aria-pressed={layout.sizing === 'content'} onClick={() => commitLayout(agent.id, { ...layout, sizing: layout.sizing === 'content' ? 'fixed' : 'content' })}><Maximize2 size={14} /></button><button className="icon-button" title={layout.locked ? 'Unlock position' : 'Lock position'} aria-pressed={layout.locked} onClick={() => { const next = { ...layout, locked: !layout.locked }; setLayouts(p => ({ ...p, [agent.id]: next })); persist(agent.id, next); }}>{layout.locked ? <Lock size={14} /> : <Unlock size={14} />}</button><button className="icon-button" title={isCollapsed ? 'Expand agent' : 'Collapse agent'} aria-expanded={!isCollapsed} onClick={() => setCollapsed(p => { const next = new Set(p); next.has(agent.id) ? next.delete(agent.id) : next.add(agent.id); return next; })}>{isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</button><button className={`icon-button ${agent.status === 'completed' ? 'archive-completed' : ''}`} title={agent.status === 'completed' ? 'Task completed — archive card' : 'Archive agent'} onClick={() => api(`/api/agents/${encodeURIComponent(agent.id)}/archive`, 'POST', {}).catch(e => report(e.message))}><Archive size={14} />{agent.status === 'completed' && <span>Archive</span>}</button></div></header>{!isCollapsed && <CardSurface id={agent.id} onInteractionChange={active => contentInteraction(agent.id, active)} store={cardCameras.current} active={activeCard === agent.id} deactivate={() => activateCard(null)} canvasOwnsPointer={id => touches.current.pointers.has(id)} forceCanvas={() => spaceHeld.current} panPastEdge={(x, y) => panCardEdge(agent.id, x, y)} canvasCamera={camera} getCanvasCamera={() => cameraRef.current} getCanvasBounds={() => canvasElement.current!.getBoundingClientRect()} zoomBeforeCard={(factor, anchor) => zoomBeforeCard(agent.id, factor, anchor)} zoomPastCard={(factor, anchor) => zoomPastCard(agent.id, factor, anchor)}><MeasuredContent watch={layout.sizing} onHeight={height => growContent(agent.id, height)}><AgentContent agent={agent} agents={snapshot.agents} settings={snapshot.settings} arrivals={arrivals.current} branch={tree.nodes.get(agent.id)} /></MeasuredContent></CardSurface>}<footer className="card-footer"><span>{agent.status === 'active' ? 'LIVE' : agent.status.toUpperCase()}</span><code title={agent.id}>{agent.agentId}</code><RunTimes agent={agent} /><span className="sizing-label">{layout.sizing === 'content' ? 'CONTENT' : 'FIXED'}</span>{layout.locked && <Lock size={10} />}</footer>{!isCollapsed && <button className="resize-handle" title="Drag to resize - arrow keys adjust dimensions" aria-label={`Resize ${agent.name}. Use arrow keys to adjust width and height.`} onPointerDown={e => resizeCard(e, agent.id)} onKeyDown={e => resizeKeyboard(e, agent.id)}><span /></button>}</article>; })}
    {monitoringRect && (isVisible(monitoringRect, viewport) || contentInteractions.current.has('monitoring') || activeDrag.current === 'monitoring') && monitoringCard(monitoringRect)}
    {settingsRect && (isVisible(settingsRect, viewport) || contentInteractions.current.has('settings') || activeDrag.current === 'settings') && <article className={`world-card settings-card ${activeCard === 'settings' ? 'is-active' : ''}`} data-card-id="settings" onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button,a,input,select,textarea')) focusCard('settings'); }} style={{ left: settingsRect.x, top: settingsRect.y, width: settingsRect.width, height: settingsRect.height, zIndex: 100000 }}><header className="card-header" onPointerDown={e => dragCard(e, 'settings')} onKeyDown={e => keyboard(e, 'settings')} tabIndex={0} aria-label="Workspace settings"><div className="settings-icon"><Cog size={17} /></div><div className="agent-title"><strong>Workspace settings</strong><span>Your installation, your rules</span></div><button className="icon-button" title="Close settings" onClick={() => setSettingsRect(null)}><X size={17} /></button></header><CardSurface id="settings" onInteractionChange={active => contentInteraction('settings', active)} store={cardCameras.current} active={activeCard === 'settings'} deactivate={() => activateCard(null)} canvasOwnsPointer={id => touches.current.pointers.has(id)} forceCanvas={() => spaceHeld.current} panPastEdge={(x, y) => panCardEdge('settings', x, y)} canvasCamera={camera} getCanvasCamera={() => cameraRef.current} getCanvasBounds={() => canvasElement.current!.getBoundingClientRect()} zoomBeforeCard={(factor, anchor) => zoomBeforeCard('settings', factor, anchor)} zoomPastCard={(factor, anchor) => zoomPastCard('settings', factor, anchor)}><SettingsBody settings={snapshot.settings} stats={snapshot.stats} save={async settings => { await api('/api/settings', 'PUT', settings); setSnapshot(s => ({ ...s, settings })); }} report={report} /></CardSurface></article>}
    </div></div>{createPortal(<div className="viewport-hud"><header className="topbar chrome" onPointerDown={e => { if (e.button === 0 && !(e.target as Element).closest('button,a,input')) windowCommand('drag'); }} onDoubleClick={e => { if (!(e.target as Element).closest('button,a,input')) windowCommand('maximize'); }}><a className="brand" href="/" aria-label="AgenticView"><Radio size={19} /><span>Agentic<span>View</span></span><small>MONITOR</small></a><div className="connection-status"><i className={online ? 'connected' : ''} />{online ? 'Live' : 'Reconnecting'}<span className="topbar-divider" />{snapshot.stats.active} active{snapshot.stats.updatesPerSecond > 0 && <span className="update-rate">{snapshot.stats.updatesPerSecond.toFixed(1)} updates/s</span>}</div></header>
    <div className="bottom-left chrome"><button className={`settings-toggle ${settingsRect ? 'active' : ''}`} title="Workspace settings" aria-label="Workspace settings" aria-pressed={!!settingsRect} onClick={openSettings}><Cog size={20} /><span className="settings-label">Settings</span></button><button className={`settings-toggle monitoring-toggle ${monitoringRect ? 'active' : ''}`} title="Hub monitoring" aria-label="Hub monitoring" aria-pressed={!!monitoringRect} onClick={openMonitoring}><Activity size={20} /></button><span className="canvas-help">Canvas navigation <span>·</span> Click a card to interact <span>·</span> Space to pan <span>·</span> F to fit</span></div><div className="viewport-controls chrome"><button title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}><Minus size={15} /></button><button className="zoom-value" title="Reset zoom" onClick={resetZoom}>{formatZoom(camera.zoom)}</button><button title="Zoom in" aria-label="Zoom in" onClick={() => zoom(1.2)}><Plus size={15} /></button><span /><button className="fit-all" title="Fit all cards (F or Home)" aria-label="Fit all cards" onClick={fit}><Focus size={16} /><span>Fit all</span></button><button className="fit-all arrange-all" title={`Pack all ${movableCount} unlocked cards; keep older positions where possible`} aria-label="Arrange all cards" disabled={packing} onClick={arrangeAll}><LayoutGrid size={16} /><span>{packing ? 'Arranging…' : 'Arrange all'}</span></button></div>{notice && <div className="toast chrome" role="status">{notice}<button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice('')}><X size={14} /></button></div>}
  </div>, document.body)}</main>;
}
