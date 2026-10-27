import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowDownToLine, ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, Circle, Copy, Focus, LayoutGrid, Link2, Lock, Maximize2, Minus, Plus, Radio, RotateCcw, Settings as Cog, Unlock, X, Zap } from 'lucide-react';
import type { AgentView, ArchiveSummary, Layout, Patch, Settings, Snapshot } from '../shared/protocol.js';
import { findFreePosition, isVisible, moveWithoutOverlap, resizeWithoutOverlap, fitToViewport, formatZoom, type Rect } from '../shared/canvas.js';
import { ComponentView } from './Components.js';
import { TouchViewport, canvasKey, zoomAt, type Camera } from '../shared/viewport.js';
import { applyLivePatch, rootAgents } from '../shared/live-state.js';

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

export function AgentContent({ agent, agents, settings, depth = 0 }: { agent: AgentView; agents: AgentView[]; settings: Settings; depth?: number }) {
  const [error, setError] = useState('');
  const children = depth < 12 ? agents.filter(a => a.parentId === agent.id && a.id !== agent.id) : [];
  return <>{error && <div className="form-error" role="alert">{error}</div>}{agent.context && <p className="agent-context">{agent.context}</p>}{children.length > 0 && <div className="children"><div className="section-label">CHILD AGENTS <span>{children.length}</span></div>{children.map(child => <article className="child-card" key={child.id}><header><span className={`status-dot ${child.status}`} /><strong>{child.name}</strong><span>{child.role}</span><button className="icon-button" title="Archive child agent" onClick={() => api(`/api/agents/${encodeURIComponent(child.id)}/archive`, 'POST', {}).catch(e => setError(e.message))}><Archive size={13} /></button></header><div className="child-body"><AgentContent agent={child} agents={agents} settings={settings} depth={depth + 1} /></div></article>)}</div>}{Object.values(agent.components).map(c => <ComponentView key={c.id} component={c} embeds={settings.trustedEmbeds} runId={agent.id} />)}{!Object.keys(agent.components).length && !children.length && <div className="waiting"><Radio size={18} /><span>Waiting for agent updates</span><small>Components appear here as they arrive.</small></div>}</>;
}

function SettingsBody({ settings, save, stats, report }: { settings: Settings; save: (s: Settings) => Promise<void>; stats: Snapshot['stats']; report: (s: string) => void }) {
  const [tab, setTab] = useState<'general' | 'archives' | 'connect'>('general');
  const [archives, setArchives] = useState<ArchiveSummary[]>([]), [inspect, setInspect] = useState<AgentView | null>(null), [connection, setConnection] = useState<{ mcpUrl: string; ingestUrl: string; credentialHelp: string } | null>(null), [loading, setLoading] = useState(false), [copied, setCopied] = useState('');
  const restore = (id: string) => api(`/api/archives/${encodeURIComponent(id)}/restore`, 'POST', {}).then(() => { setInspect(null); setArchives(current => current.filter(a => a.id !== id)); report('Card restored. Use Fit all to find it on the canvas.'); }).catch(e => report(e.message));
  useEffect(() => { if (tab === 'archives') { setLoading(true); api<ArchiveSummary[]>('/api/archives').then(setArchives).catch(e => report(e.message)).finally(() => setLoading(false)); } if (tab === 'connect') api<typeof connection>('/api/connection').then(setConnection).catch(e => report(e.message)); }, [tab, stats.archived]);
  const update = (part: Partial<Settings>) => save({ ...settings, ...part }).catch(e => report(e.message));
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied(''), 1500); }).catch(() => report('Clipboard unavailable. Select and copy the address.'));
  return <><nav className="settings-tabs" aria-label="Settings sections">{(['general', 'archives', 'connect'] as const).map(t => <button className={tab === t ? 'selected' : ''} onClick={() => { setTab(t); setInspect(null); }} key={t}>{t === 'general' ? <Cog size={14} /> : t === 'archives' ? <Archive size={14} /> : <Link2 size={14} />}{t[0].toUpperCase() + t.slice(1)}{t === 'archives' && <span>{stats.archived}</span>}</button>)}</nav><div className="settings-content">{tab === 'general' && <><div className="section-label">INSTALLATION PREFERENCES</div><label className="setting-row"><div><strong>Trusted embedded views</strong><p>Run agent-generated views with scripts and network access, inside isolated documents.</p></div><input type="checkbox" role="switch" checked={settings.trustedEmbeds} onChange={e => update({ trustedEmbeds: e.target.checked })} /></label><label className="setting-row"><div><strong>Automatic archival</strong><p>Archive agents after a period without contact. Off keeps them on your canvas.</p></div><input type="checkbox" role="switch" checked={settings.autoArchiveMinutes !== null} onChange={e => update({ autoArchiveMinutes: e.target.checked ? 30 : null })} /></label>{settings.autoArchiveMinutes !== null && <label className="number-setting">Archive after <input aria-label="Automatic archival minutes" type="number" min="1" max="525600" value={settings.autoArchiveMinutes} onChange={e => { if (+e.target.value >= 1) update({ autoArchiveMinutes: +e.target.value }); }} /> minutes without contact</label>}<label className="setting-row"><div><strong>Archive completed agents</strong><p>Move explicitly completed runs into the archive.</p></div><input type="checkbox" role="switch" checked={settings.archiveAfterCompletion} onChange={e => update({ archiveAfterCompletion: e.target.checked })} /></label><label className="number-setting">Mark stale after <input type="number" min="15" max="86400" value={settings.staleSeconds} onChange={e => { if (+e.target.value >= 15) update({ staleSeconds: +e.target.value }); }} /> seconds</label><label className="setting-row"><div><strong>Reduce motion</strong><p>Keep interface transitions minimal.</p></div><input type="checkbox" role="switch" checked={settings.reducedMotion} onChange={e => update({ reducedMotion: e.target.checked })} /></label><div className="settings-note"><Zap size={16} /><div><strong>Explore with a synthetic workspace</strong><p>Add example agents and components. Demo data is explicitly labeled.</p><button className="secondary" onClick={() => api('/api/demo', 'POST', {}).then(() => report('Synthetic agents added to your canvas.')).catch(e => report(e.message))}>Add demo agents <ArrowUpRight size={13} /></button></div></div></>}
    {tab === 'archives' && (inspect ? <><button className="text-button" onClick={() => setInspect(null)}><ArrowLeft size={14} /> All archives</button><div className="archive-heading"><div><h2>{inspect.name}</h2><small>{inspect.role} · read only</small></div><button className="secondary" onClick={() => restore(inspect.id)}><RotateCcw size={14} /> Restore card</button><a className="icon-button" title="Download compressed archive" href={`/api/archives/${encodeURIComponent(inspect.id)}/export`}><ArrowDownToLine size={16} /></a></div><AgentContent agent={inspect} agents={[]} settings={{ ...settings, trustedEmbeds: false }} /></> : <><div className="archive-summary"><span><strong>{archives.length}</strong> saved runs</span><span><strong>{bytes(archives.reduce((n, a) => n + a.bytes, 0))}</strong> gzip storage</span></div><div className="section-label">LOCAL ARCHIVES</div>{loading ? <p className="muted">Loading archives…</p> : !archives.length ? <div className="empty-section"><Archive size={24} /><h3>No archived agents</h3><p>Retired runs stay here, on this installation.</p></div> : archives.map(a => <div className="archive-row" key={a.id}><button onClick={() => api<AgentView>(`/api/archives/${encodeURIComponent(a.id)}`).then(setInspect).catch(e => report(e.message))}><strong>{a.name}</strong><small>{a.role} · {date(a.archivedAt)}</small><span>{bytes(a.bytes)} gzip <span className="muted"> / {bytes(a.rawBytes)} raw</span></span></button><button className="icon-button" title={`Restore ${a.name}`} aria-label={`Restore ${a.name}`} onClick={() => restore(a.id)}><RotateCcw size={15} /></button><a className="icon-button" title={`Download ${a.name}`} href={`/api/archives/${encodeURIComponent(a.id)}/export`}><ArrowDownToLine size={15} /></a></div>)}</>)}
    {tab === 'connect' && <><div className="section-label">CONNECT AN AGENT</div><h2>One canvas. Any workflow.</h2><p className="intro-text">Publish context, metrics, logs, and structured components from your agents and tools.</p>{connection ? <>{([['MCP endpoint', connection.mcpUrl], ['HTTP ingestion', connection.ingestUrl]] as const).map(([name, value]) => <div className="connection-field" key={name}><label>{name}</label><div><code>{value}</code><button className="icon-button" title={`Copy ${name}`} onClick={() => copy(value)}>{copied === value ? <Check size={15} /> : <Copy size={15} />}</button></div></div>)}<div className="connect-help"><Lock size={15} /><p>{connection.credentialHelp}</p></div></> : <p className="muted">Loading connection details…</p>}<div className="protocol-note"><span>Native components</span><span>Incremental updates</span><span>Persistent archives</span></div></>}
  </div></>;
}

export function App() {
  const [auth, setAuth] = useState<boolean | null>(null), [snapshot, setSnapshot] = useState<Snapshot>(empty), [online, setOnline] = useState(false), [notice, setNotice] = useState('');
  const [camera, setCamera] = useState<Camera>({ x: 72, y: 86, zoom: 1 }), [size, setSize] = useState({ width: innerWidth, height: innerHeight }), [settingsRect, setSettingsRect] = useState<Rect | null>(null), [layouts, setLayouts] = useState<Record<string, Layout>>({}), [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [arrival, setArrival] = useState<{ id: string; name: string } | null>(null), [packing, setPacking] = useState(false);
  const followAll = useRef(true), knownRoots = useRef(new Set<string>());
  const manualWrites = useRef(new Map<string, Promise<Layout>>());
  const canvasElement = useRef<HTMLDivElement>(null), touches = useRef(new TouchViewport()), touchIntent = useRef<TouchIntent | null>(null), suppressClickUntil = useRef(0), lastTap = useRef<{ id: string; at: number; x: number; y: number } | null>(null), mouseCleanup = useRef<(() => void) | null>(null);
  const activeDrag = useRef<string | null>(null), remoteLayouts = useRef<Record<string, string>>({});
  const cameraRef = useRef(camera), layoutRef = useRef(layouts), snapshotRef = useRef(snapshot), settingsRef = useRef(settingsRect);
  cameraRef.current = camera; layoutRef.current = layouts; snapshotRef.current = snapshot; settingsRef.current = settingsRect;
  const report = useCallback((message: string) => { setNotice(message); }, []);
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(id); }, [notice]);
  useEffect(() => { const unauthorized = () => setAuth(false); addEventListener('agenticview:unauthorized', unauthorized); api<{ authenticated: boolean }>('/api/session').then(s => setAuth(s.authenticated)).catch(() => setAuth(false)); const resize = () => setSize({ width: innerWidth, height: innerHeight }); addEventListener('resize', resize); return () => { removeEventListener('resize', resize); removeEventListener('agenticview:unauthorized', unauthorized); }; }, []);
  useEffect(() => {
    if (!auth) return;
    let alive = true;
    const events = new EventSource('/api/events');
    events.onopen = () => setOnline(true);
    events.onerror = () => setOnline(false);
    events.addEventListener('snapshot', event => { const s = JSON.parse((event as MessageEvent).data) as Snapshot; if (alive) setSnapshot(s); });
    events.addEventListener('patch', event => { if (!alive) return; const patch = JSON.parse((event as MessageEvent).data) as Patch; setSnapshot(old => applyLivePatch(old, patch)); });
    return () => { alive = false; events.close(); };
  }, [auth, report]);
  const roots = rootAgents(snapshot.agents);
  const layoutSignature = roots.map(a => `${a.id}:${JSON.stringify(a.layout)}`).join('|');
  useEffect(() => {
    const previous = layoutRef.current, next: Record<string, Layout> = {}, occupied: Rect[] = [];
    // The ephemeral settings card yields to agent geometry, including locked cards.
    for (const a of [...roots].sort((a, b) => Number(b.layout.locked) - Number(a.layout.locked))) {
      const existing = previous[a.id], remote = JSON.stringify(a.layout), changed = remoteLayouts.current[a.id] !== remote;
      const proposed = activeDrag.current === a.id ? existing ?? a.layout : changed ? a.layout : existing ?? a.layout;
      remoteLayouts.current[a.id] = remote;
      const placed = proposed.locked ? proposed : findFreePosition(proposed, occupied);
      next[a.id] = { ...proposed, ...placed }; occupied.push(placed);
      if (placed.x !== proposed.x || placed.y !== proposed.y) persist(a.id, next[a.id]!);
    }
    layoutRef.current = next; setLayouts(next);
    const added = roots.filter(agent => !knownRoots.current.has(agent.id));
    knownRoots.current = new Set(roots.map(agent => agent.id));
    if (settingsRef.current) {
      const settings = findFreePosition(settingsRef.current, occupied);
      if (settings.x !== settingsRef.current.x || settings.y !== settingsRef.current.y) { settingsRef.current = settings; setSettingsRect(settings); }
    }
    if (followAll.current && roots.length) { applyCamera(fitToViewport([...Object.values(next), ...(settingsRef.current ? [settingsRef.current] : [])], size), true); setArrival(null); }
    else {
      const camera = cameraRef.current, visible = { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: size.width / camera.zoom, height: size.height / camera.zoom };
      const outside = added.filter(agent => !isVisible(next[agent.id]!, visible));
      if (outside.length) { const agent = outside[outside.length - 1]!; setArrival({ id: agent.id, name: agent.name }); }
      else setArrival(current => current && next[current.id] ? current : null);
    }
  }, [layoutSignature, size.width, size.height]);
  function obstacles(id?: string): Rect[] { return [...Object.entries(layoutRef.current).filter(([key]) => key !== id).map(([, value]) => value), ...(settingsRef.current && id !== 'settings' ? [settingsRef.current] : [])]; }
  function reserveManual(id: string) {
    followAll.current = false;
    if (id === 'settings' || manualWrites.current.has(id)) return;
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
    const height = Math.max(240, Math.min(1600, Math.ceil(contentHeight + 125)));
    if (Math.abs(height - current.height) < 2) return;
    const available = obstacles(id);
    const resized = current.locked ? resizeWithoutOverlap(current, { width: current.width, height }, available) : findFreePosition({ ...current, height }, available);
    if (Math.abs(resized.height - current.height) < 1 && resized.x === current.x && resized.y === current.y) return;
    commitLayout(id, { ...current, ...resized });
  }
  function resizeCard(e: React.PointerEvent<HTMLElement>, id: string) {
    if (e.button !== 0 || e.pointerType === 'touch') return;
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
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation(); const current = layoutRef.current[id]; if (!current) return;
    const step = e.shiftKey ? 80 : 20;
    const width = Math.max(320, Math.min(1600, current.width + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0)));
    const height = Math.max(240, Math.min(1600, current.height + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)));
    followAll.current = false; commitLayout(id, { ...current, ...resizeWithoutOverlap(current, { width, height }, obstacles(id)), sizing: 'fixed', automatic: false });
  }
  function dragCard(e: React.PointerEvent<HTMLElement>, id: string) {
    if (e.button !== 0 || e.pointerType === 'touch' || (e.target as HTMLElement).closest('button,a,input')) return;
    const initial = id === 'settings' ? settingsRef.current : layoutRef.current[id];
    if (!initial || id !== 'settings' && (initial as Layout).locked) return;
    e.stopPropagation(); const element = e.currentTarget; element.setPointerCapture(e.pointerId); let moved = false;
    const pointer = { x: e.clientX, y: e.clientY }, zoom = cameraRef.current.zoom; let last = initial;
    const move = (event: PointerEvent) => { if (!moved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 4) return; if (!moved) { moved = true; reserveManual(id); activeDrag.current = id; } last = moveWithoutOverlap(initial, { x: initial.x + (event.clientX - pointer.x) / zoom, y: initial.y + (event.clientY - pointer.y) / zoom }, obstacles(id)); if (id === 'settings') setSettingsRect(last); else setLayouts(previous => ({ ...previous, [id]: { ...previous[id]!, ...last, automatic: false } })); };
    const up = () => { mouseCleanup.current = null; activeDrag.current = null; element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up); if (moved && id !== 'settings') persist(id, { ...layoutRef.current[id]!, ...last, automatic: false }); };
    mouseCleanup.current = up;
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', up); element.addEventListener('pointercancel', up);
  }
  function pan(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'touch' || ![0, 1].includes(e.button) || (e.target as HTMLElement).closest('.chrome,button,a,input,select,textarea') || e.button === 0 && (e.target as HTMLElement).closest('.world-card')) return;
    e.preventDefault(); e.currentTarget.focus({ preventScroll: true });
    const element = e.currentTarget, origin = { x: e.clientX, y: e.clientY }, initial = cameraRef.current, overCard = !!(e.target as Element).closest('.world-card');
    if (!overCard) element.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => { if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 4) return; element.setPointerCapture(e.pointerId); suppressClickUntil.current = performance.now() + 400; applyCamera({ ...initial, x: initial.x + event.clientX - origin.x, y: initial.y + event.clientY - origin.y }); };
    const up = () => { mouseCleanup.current = null; element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up); };
    mouseCleanup.current = up;
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', up); element.addEventListener('pointercancel', up);
  }
  function applyCamera(next: Camera, following = false) { followAll.current = following; cameraRef.current = next; setCamera(next); }
  function zoom(amount: number, at = { x: size.width / 2, y: size.height / 2 }) { applyCamera(zoomAt(cameraRef.current, amount, at)); }
  function resetZoom() { zoom(1 / cameraRef.current.zoom); }
  function fit() { setArrival(null); applyCamera(fitToViewport([...Object.values(layoutRef.current), ...(settingsRef.current ? [settingsRef.current] : [])], size), true); }
  function focusCard(id: string) { const rect = id === 'settings' ? settingsRef.current : layoutRef.current[id]; if (rect) { setArrival(null); applyCamera(fitToViewport([rect], size, 80)); } }
  async function arrangeAll() { setPacking(true); try { const result = await api<{ arranged: number }>('/api/layout/pack', 'POST', { mode: 'all', aspectRatio: Math.max(.3, Math.min(4, (size.width - 120) / Math.max(100, size.height - 160))) }); fit(); report(`Arranged ${result.arranged} cards. Locked positions preserved.`); } catch (error) { report((error as Error).message); } finally { setPacking(false); } }
  function openSettings() { if (settingsRect) { setSettingsRect(null); return; } const c = { ...cameraRef.current, zoom: Math.max(.8, cameraRef.current.zoom) }; const placed = findFreePosition({ x: (size.width / 2 - c.x) / c.zoom - 290, y: (size.height / 2 - c.y) / c.zoom - 290, width: 580, height: 610 }, obstacles()); setSettingsRect(placed); setCamera({ ...c, x: size.width / 2 - (placed.x + placed.width / 2) * c.zoom, y: size.height / 2 - (placed.y + placed.height / 2) * c.zoom }); }
  function keyboard(e: React.KeyboardEvent, id: string) { if (e.target !== e.currentTarget) return; if (e.key === 'Enter') { e.preventDefault(); focusCard(id); return; } if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return; const r = layoutRef.current[id]; if (!r || r.locked) return; e.preventDefault(); e.stopPropagation(); const d = e.shiftKey ? 80 : 20; const moved = moveWithoutOverlap(r, { x: r.x + (e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0), y: r.y + (e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0) }, obstacles(id)); followAll.current = false; const next = { ...r, ...moved, automatic: false }; setLayouts(p => ({ ...p, [id]: next })); persist(id, next); }
  function canvasKeyboard(e: React.KeyboardEvent) {
    if (e.defaultPrevented) return;
    const protectedTarget = !!(e.target as Element).closest('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[role="textbox"],.resize-handle');
    const action = canvasKey(e.key, protectedTarget, e.altKey || e.ctrlKey || e.metaKey); if (!action) return;
    e.preventDefault(); const c = cameraRef.current, step = e.shiftKey ? 180 : 60;
    if (action === 'fit') fit(); else if (action === 'reset') resetZoom(); else if (action === 'in') zoom(1.2); else if (action === 'out') zoom(1 / 1.2); else if (action === 'escape') setSettingsRect(null);
    else applyCamera({ ...c, x: c.x + (action === 'left' ? step : action === 'right' ? -step : 0), y: c.y + (action === 'up' ? step : action === 'down' ? -step : 0) });
  }
  function touchStart(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== 'touch') return;
    const point = { x: e.clientX, y: e.clientY }; touches.current.start(e.pointerId, point, cameraRef.current);
    if (touches.current.count >= 2) {
      mouseCleanup.current?.();
      if (activeDrag.current && activeDrag.current !== 'settings' && layoutRef.current[activeDrag.current]) persist(activeDrag.current, layoutRef.current[activeDrag.current]!);
      activeDrag.current = null; touchIntent.current = null; lastTap.current = null; suppressClickUntil.current = performance.now() + 700; e.preventDefault(); return;
    }
    const target = e.target as Element, controls = !!target.closest('button,a,input,textarea,select,[contenteditable]:not([contenteditable="false"])');
    const id = target.closest<HTMLElement>('[data-card-id]')?.dataset.cardId;
    const rect = id === 'settings' ? settingsRef.current : id ? layoutRef.current[id] : undefined;
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
    const canDrag = !!rect && !!target.closest('.card-header') && (id === 'settings' || !(rect as Layout).locked);
    const kind: TouchIntent['kind'] = controls ? target.closest('.resize-handle') ? 'resize' : 'tap' : canDrag ? 'drag' : scroll ? 'scroll' : !id ? 'pan' : 'tap';
    touchIntent.current = { pointer: e.pointerId, kind, origin: point, last: point, camera: { ...cameraRef.current }, id: controls && kind !== 'resize' ? undefined : id, rect: rect ?? undefined, scroll, moved: false };
  }
  function touchMove(e: React.PointerEvent<HTMLDivElement>) {
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
      if (intent.id === 'settings') { settingsRef.current = next; setSettingsRect(next); }
      else { layoutRef.current = { ...layoutRef.current, [intent.id]: { ...layoutRef.current[intent.id]!, ...next, automatic: false, ...(intent.kind === 'resize' ? { sizing: 'fixed' as const } : {}) } }; setLayouts(layoutRef.current); }
    }
    intent.last = point;
  }
  function touchEnd(e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) {
    if (e.pointerType !== 'touch' || !touches.current.pointers.has(e.pointerId)) return;
    const intent = touchIntent.current;
    if (intent?.pointer === e.pointerId) {
      if (intent.moved) { suppressClickUntil.current = performance.now() + 400; if (intent.id && ['drag', 'resize'].includes(intent.kind) && intent.id !== 'settings') persist(intent.id, layoutRef.current[intent.id]!); }
      else if (!cancelled && intent.id) {
        const previous = lastTap.current, now = performance.now();
        if (previous?.id === intent.id && now - previous.at < 350 && Math.hypot(e.clientX - previous.x, e.clientY - previous.y) < 25) { focusCard(intent.id); lastTap.current = null; suppressClickUntil.current = now + 400; }
        else lastTap.current = { id: intent.id, at: now, x: e.clientX, y: e.clientY };
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
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && (e.target as Element).closest('.card-body,.settings-content,pre,.table-scroll,.logs')) return;
      e.preventDefault(); const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.height : 1);
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) { const c = cameraRef.current; applyCamera({ ...c, x: c.x - delta - e.deltaX }); }
      else zoom(Math.exp(Math.max(-4, Math.min(4, -delta * .0015))), { x: e.clientX, y: e.clientY });
    };
    const clear = () => { const id = activeDrag.current; if (id && id !== 'settings' && layoutRef.current[id]) persist(id, layoutRef.current[id]!); touches.current.clear(); touchIntent.current = null; activeDrag.current = null; mouseCleanup.current?.(); };
    element.addEventListener('wheel', wheel, { passive: false }); window.addEventListener('blur', clear);
    return () => { element.removeEventListener('wheel', wheel); window.removeEventListener('blur', clear); clear(); };
  }, [auth, size.width, size.height]);
  if (auth === null) return <div className="boot"><Radio size={22} /><span>Connecting to AgenticView</span></div>;
  if (!auth) return <Login complete={() => setAuth(true)} />;
  const viewport: Rect = { x: -camera.x / camera.zoom - 150, y: -camera.y / camera.zoom - 150, width: size.width / camera.zoom + 300, height: size.height / camera.zoom + 300 };
  return <main className={`app ${snapshot.settings.reducedMotion ? 'reduced-motion' : ''}`}><div ref={canvasElement} className="canvas" tabIndex={0} onKeyDown={canvasKeyboard} onPointerDownCapture={touchStart} onPointerMoveCapture={touchMove} onPointerUpCapture={e => touchEnd(e, false)} onPointerCancelCapture={e => touchEnd(e, true)} onClickCapture={e => { if (performance.now() < suppressClickUntil.current) { e.preventDefault(); e.stopPropagation(); } }} onPointerDown={pan} style={{ backgroundPosition: `${camera.x}px ${camera.y}px`, backgroundSize: `${Math.max(12, 24 * camera.zoom)}px ${Math.max(12, 24 * camera.zoom)}px`, backgroundImage: camera.zoom < .1 ? 'none' : undefined }} aria-label="Agent canvas. Drag the background to pan. Use zoom controls to navigate.">
    <div className="world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>{roots.map(agent => { const layout = layouts[agent.id]; if (!layout || !isVisible(layout, viewport)) return null; const isCollapsed = collapsed.has(agent.id); return <article className={`world-card agent-card ${layout.locked ? 'locked' : ''}`} key={agent.id} data-card-id={agent.id} title={`${agent.name} · double-click or double-tap to focus`} onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button,a,input,select,textarea')) focusCard(agent.id); }} style={{ left: layout.x, top: layout.y, width: layout.width, height: isCollapsed ? 68 : layout.height, zIndex: layout.z }}><header className="card-header" onPointerDown={e => dragCard(e, agent.id)} onKeyDown={e => keyboard(e, agent.id)} tabIndex={0} aria-label={`${agent.name}, ${layout.locked ? 'locked' : 'use arrow keys to move'}`}><span className={`status-dot ${agent.status}`} /><div className="agent-title"><strong>{agent.name}</strong><span>{agent.role}</span></div><div className="card-actions"><button className="icon-button" title={layout.sizing === 'content' ? 'Use fixed size' : 'Grow with content'} aria-label="Grow with content" aria-pressed={layout.sizing === 'content'} onClick={() => commitLayout(agent.id, { ...layout, sizing: layout.sizing === 'content' ? 'fixed' : 'content' })}><Maximize2 size={14} /></button><button className="icon-button" title={layout.locked ? 'Unlock position' : 'Lock position'} aria-pressed={layout.locked} onClick={() => { const next = { ...layout, locked: !layout.locked }; setLayouts(p => ({ ...p, [agent.id]: next })); persist(agent.id, next); }}>{layout.locked ? <Lock size={14} /> : <Unlock size={14} />}</button><button className="icon-button" title={isCollapsed ? 'Expand agent' : 'Collapse agent'} aria-expanded={!isCollapsed} onClick={() => setCollapsed(p => { const next = new Set(p); next.has(agent.id) ? next.delete(agent.id) : next.add(agent.id); return next; })}>{isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</button><button className="icon-button" title="Archive agent" onClick={() => api(`/api/agents/${encodeURIComponent(agent.id)}/archive`, 'POST', {}).catch(e => report(e.message))}><Archive size={14} /></button></div></header>{!isCollapsed && <div className="card-body"><MeasuredContent watch={layout.sizing} onHeight={height => growContent(agent.id, height)}><AgentContent agent={agent} agents={snapshot.agents} settings={snapshot.settings} /></MeasuredContent></div>}<footer className="card-footer"><span>{agent.status === 'active' ? 'LIVE' : agent.status.toUpperCase()}</span><code title={agent.id}>{agent.agentId}</code><span className="sizing-label">{layout.sizing === 'content' ? 'CONTENT' : 'FIXED'}</span>{layout.locked && <Lock size={10} />}</footer>{!isCollapsed && <button className="resize-handle" title="Drag to resize - arrow keys adjust dimensions" aria-label={`Resize ${agent.name}. Use arrow keys to adjust width and height.`} onPointerDown={e => resizeCard(e, agent.id)} onKeyDown={e => resizeKeyboard(e, agent.id)}><span /></button>}</article>; })}
    {settingsRect && isVisible(settingsRect, viewport) && <article className="world-card settings-card" data-card-id="settings" onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button,a,input,select,textarea')) focusCard('settings'); }} style={{ left: settingsRect.x, top: settingsRect.y, width: settingsRect.width, height: settingsRect.height, zIndex: 100000 }}><header className="card-header" onPointerDown={e => dragCard(e, 'settings')}><div className="settings-icon"><Cog size={17} /></div><div className="agent-title"><strong>Workspace settings</strong><span>Your installation, your rules</span></div><button className="icon-button" title="Close settings" onClick={() => setSettingsRect(null)}><X size={17} /></button></header><SettingsBody settings={snapshot.settings} stats={snapshot.stats} save={async settings => { await api('/api/settings', 'PUT', settings); setSnapshot(s => ({ ...s, settings })); }} report={report} /></article>}
    </div></div><header className="topbar chrome"><a className="brand" href="/" aria-label="AgenticView"><Radio size={19} /><span>Agentic<span>View</span></span><small>LOCAL</small></a><div className="connection-status"><i className={online ? 'connected' : ''} />{online ? 'Connected' : 'Reconnecting'}<span className="topbar-divider" />{snapshot.stats.active} active{snapshot.stats.updatesPerSecond > 0 && <span className="update-rate">{snapshot.stats.updatesPerSecond.toFixed(1)} updates/s</span>}</div></header>
    <div className="bottom-left chrome"><button className={`settings-toggle ${settingsRect ? 'active' : ''}`} title="Workspace settings" aria-label="Workspace settings" aria-pressed={!!settingsRect} onClick={openSettings}><Cog size={20} /></button><span className="canvas-help">Drag to pan <span>·</span> Pinch or scroll to zoom <span>·</span> F to fit</span></div><div className="viewport-controls chrome"><button title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}><Minus size={15} /></button><button className="zoom-value" title="Reset zoom" onClick={resetZoom}>{formatZoom(camera.zoom)}</button><button title="Zoom in" aria-label="Zoom in" onClick={() => zoom(1.2)}><Plus size={15} /></button><span /><button className="fit-all" title="Fit all cards (F or Home)" aria-label="Fit all cards" onClick={fit}><Focus size={16} /><span>Fit all</span></button><button className="fit-all arrange-all" title="Arrange all unlocked cards; resume automatic packing" aria-label="Arrange all cards" disabled={packing} onClick={arrangeAll}><LayoutGrid size={16} /><span>{packing ? 'Arranging…' : 'Arrange all'}</span></button></div>{arrival && <div className="arrival-notice chrome" role="status"><Radio size={14} /><span>New agent: {arrival.name}</span><button onClick={() => focusCard(arrival.id)}>Show card <Focus size={13} /></button></div>}{notice && <div className="toast chrome" role="status">{notice}<button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice('')}><X size={14} /></button></div>}
  </main>;
}
