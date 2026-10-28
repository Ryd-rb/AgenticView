import { useCallback, useContext, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CardInteraction } from './CardInteraction.js';

// Vite bundles this asset for the browser; direct Node semantic imports have no CSS loader.
if (import.meta.env?.MODE) void import('./session-views.css');

export type SessionComponent = { kind: 'session-launcher'; data: { actionId: string; label?: string } } | { kind: 'agent-session'; data: { sessionId: string } };
type SessionRecord = { id: string; runId: string; name: string; agentType: string; transport?: 'local' | 'ssh'; state: 'draft' | 'queued' | 'starting' | 'running' | 'paused' | 'completed' | 'error' | 'recovering' | 'offline'; desiredState: 'running' | 'paused' | 'completed'; nativeSessionId?: string; attempt: number; recoveryCount: number; recoveryMode?: 'native' | 'handoff'; message?: string; lastError?: string; createdAt: number; updatedAt: number; outputRevision: number; autoRecover: boolean; replacementAvailable: boolean; confirmation?: string; configurationVersion?: string; components?: { id: string; title: string; kind: string }[] };
type Entry = { sequence: number; time: number; stream: 'stdout' | 'stderr' | 'system'; format: 'text' | 'markdown' | 'html' | 'json' | 'code'; text: string; level: 'info' | 'warn' | 'error' | 'debug'; label?: string };
type Output = { entries: Entry[]; next: number; earliest: number; truncated: boolean };
type Operation = 'start' | 'prompt' | 'pause' | 'resume' | 'stop';
type Body = { requestId: string; [key: string]: unknown };
const POLL_MS = 1500, ROWS = 50, MAX_ENTRIES = 2000, MAX_CHARS = 1_000_000;
const short = (value: unknown, limit = 2000) => String(value ?? '').slice(0, limit);
const endpoint = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;
async function json<T>(path: string, signal: AbortSignal, body?: Body): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (response.status === 401) window.dispatchEvent(new Event('agenticview:unauthorized'));
  const text = await response.text();
  if (text.length > 2_097_152) throw new Error('Session response exceeds the display limit.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Session response was invalid (${response.status}).`); }
  if (!response.ok) throw new Error(`Session request failed (${response.status}): ${short((value as { error?: string })?.error ?? response.statusText)}`);
  return value as T;
}
function useVisible(ref: RefObject<HTMLDivElement | null>) {
  const [visible, setVisible] = useState(() => typeof document !== 'undefined' && document.visibilityState !== 'hidden');
  useEffect(() => {
    let intersects = true;
    const update = () => setVisible(intersects && document.visibilityState !== 'hidden');
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => { intersects = entries[0]?.isIntersecting ?? true; update(); });
    if (ref.current) observer?.observe(ref.current);
    document.addEventListener('visibilitychange', update); update();
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, [ref]);
  return visible;
}
function useExplicitPost(enabled: boolean) {
  const enabledRef = useRef(enabled), alive = useRef(true), pending = useRef<AbortController | undefined>(undefined);
  const intent = useRef<{ path: string; signature: string; body: Body } | undefined>(undefined);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(false);
  enabledRef.current = enabled;
  useEffect(() => { if (!enabled) pending.current?.abort(); }, [enabled]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort(); }; }, []);
  const reset = useCallback(() => { if (!pending.current) { intent.current = undefined; setError(''); setRetry(false); } }, []);
  const send = useCallback(async (path: string, input: Record<string, unknown>): Promise<SessionRecord | undefined> => {
    if (!enabledRef.current || pending.current) return;
    const signature = JSON.stringify(input);
    if (!intent.current || intent.current.path !== path || intent.current.signature !== signature) intent.current = { path, signature, body: { requestId: crypto.randomUUID(), ...input } };
    const body = intent.current.body, controller = new AbortController(); pending.current = controller; setBusy(true); setError(''); setRetry(false);
    try {
      const record = await json<SessionRecord>(path, controller.signal, body);
      if (!record || typeof record.id !== 'string') throw new Error('Session acknowledgement was invalid.');
      if (!alive.current || controller.signal.aborted) return;
      intent.current = undefined; return record;
    } catch (failure) {
      if (alive.current) { setError(`${short(failure instanceof Error ? failure.message : 'Session acknowledgement unavailable.')} Check the current status before retrying; retry keeps the same request.`); setRetry(true); }
    } finally { if (pending.current === controller) { pending.current = undefined; if (alive.current) setBusy(false); } }
  }, []);
  const retryLast = useCallback(() => { const value = intent.current; return value ? send(value.path, JSON.parse(value.signature) as Record<string, unknown>) : Promise.resolve(undefined); }, [send]);
  return { busy, error, retry, send, retryLast, reset, retryOperation: intent.current?.body.operation };
}
function Launcher({ actionId, label, runId, enabled }: { actionId: string; label?: string; runId: string; enabled: boolean }) {
  const post = useExplicitPost(enabled), [created, setCreated] = useState(false);
  const create = async () => { const record = await post.send('/api/sessions/draft', { launcherRunId: runId, actionId }); if (record) setCreated(true); };
  return <div className="session-launcher"><p>Create a prompt card, then enter a prompt and choose Start.</p><button type="button" className="secondary" disabled={!enabled || post.busy} onClick={() => void create()}>{post.busy ? 'Creating prompt card…' : post.retry ? 'Retry creating prompt card' : label ?? 'New prompt card'}</button>{!enabled && <p className="session-caption">Select this card to create a prompt card.</p>}{created && <p role="status">Draft created. Enter a prompt in the new card to start the agent.</p>}{post.error && <p role="alert">{post.error}</p>}</div>;
}
function useSession(id: string, visible: boolean) {
  const [record, setRecord] = useState<SessionRecord>(), [error, setError] = useState(''), epoch = useRef(0);
  const accept = useCallback((next: SessionRecord) => { ++epoch.current; setRecord(next); setError(''); }, []);
  useEffect(() => { setRecord(undefined); setError(''); ++epoch.current; }, [id]);
  useEffect(() => {
    if (!visible) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, pending: AbortController | undefined;
    const poll = async () => {
      if (disposed || pending) return;
      const controller = new AbortController(), version = epoch.current; pending = controller;
      try {
        const next = await json<SessionRecord>(endpoint(id), controller.signal);
        if (!next || next.id !== id) throw new Error('Session status returned an invalid response.');
        if (!disposed && !controller.signal.aborted && version === epoch.current) { setRecord(previous => !previous || next.updatedAt >= previous.updatedAt ? next : previous); setError(''); }
      } catch (failure) { if (!disposed && !controller.signal.aborted) setError(short(failure instanceof Error ? failure.message : 'Session status unavailable.')); }
      finally { pending = undefined; if (!disposed) timer = setTimeout(poll, POLL_MS); }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); pending?.abort(); };
  }, [id, visible]);
  return { record, error, accept };
}
type Review = { operation: Operation; label: string; input: Record<string, unknown>; confirmation: string };
function SessionControls({ record, enabled, accept }: { record: SessionRecord; enabled: boolean; accept: (record: SessionRecord) => void }) {
  const [prompt, setPrompt] = useState(''), [review, setReview] = useState<Review>(), post = useExplicitPost(enabled);
  useEffect(() => { if (!enabled) setReview(undefined); }, [enabled]);
  const perform = async (input: Record<string, unknown>) => { const next = await post.send(`${endpoint(record.id)}/control`, input); if (next) { accept(next); if (input.operation === 'start' || input.operation === 'prompt') setPrompt(''); } };
  const operation = (value: Operation, label: string) => {
    if (!enabled || post.busy || review) return;
    const input = { operation: value, ...(value === 'start' || value === 'prompt' ? { prompt } : {}), ...(record.configurationVersion ? { configurationVersion: record.configurationVersion } : {}) };
    if (record.confirmation && ['start', 'prompt', 'resume'].includes(value)) { setReview({ operation: value, label, input, confirmation: record.confirmation }); return; }
    void perform(input);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (prompt.trim() && prompt.length <= 65536) operation(record.state === 'draft' ? 'start' : 'prompt', record.state === 'draft' ? 'Start' : 'Send prompt'); };
  const start = record.state === 'draft', canSend = start || record.state === 'completed' || record.state === 'paused';
  const canPause = ['queued', 'starting', 'running', 'recovering'].includes(record.state), canResume = record.replacementAvailable || ['paused', 'offline', 'error'].includes(record.state);
  return <div className="session-controls">
    <form onSubmit={submit}><label><span>{start ? 'Starting prompt' : 'Prompt'}</span><textarea aria-label="Session prompt" maxLength={65536} rows={4} value={prompt} disabled={!enabled || post.busy || !!review} placeholder={start ? 'Describe what the agent should do…' : 'Send another prompt…'} onChange={event => { post.reset(); setPrompt(event.target.value); }} /></label><div className="session-toolbar"><button type="submit" disabled={!enabled || post.busy || !!review || !canSend || !prompt.trim()}>{start ? 'Start' : 'Send prompt'}</button><small>{prompt.length.toLocaleString()} / 65,536 characters</small></div></form>
    <div className="session-toolbar"><button type="button" disabled={!enabled || post.busy || !!review || !canPause} onClick={() => operation('pause', 'Pause')}>Pause</button><button type="button" disabled={!enabled || post.busy || !!review || !canResume} onClick={() => operation('resume', record.replacementAvailable ? 'Start recovery session' : 'Resume')}>{record.replacementAvailable ? 'Start recovery session' : 'Resume'}</button><button type="button" disabled={!enabled || post.busy || !!review || start || record.state === 'completed'} onClick={() => operation('stop', 'Stop')}>Stop</button><a href={`${endpoint(record.id)}/export`} download={`session-${record.id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`}>Export private handoff</a></div>
    {review && <section className="session-review" aria-label="Review session action"><strong>Review {review.label}</strong><p>{review.confirmation}</p>{typeof review.input.prompt === 'string' && <pre>{short(review.input.prompt, 4000)}</pre>}<div className="session-toolbar"><button type="button" disabled={!enabled} onClick={() => setReview(undefined)}>Cancel</button><button type="button" disabled={!enabled || post.busy} onClick={() => { const input = { ...review.input, confirmed: true }; setReview(undefined); void perform(input); }}>Confirm {review.label}</button></div></section>}
    {post.busy && <p role="status">Waiting for the session acknowledgement…</p>}{post.error && <p role="alert">{post.error}</p>}{post.retry && <button type="button" disabled={!enabled || post.busy} onClick={() => { const operation = post.retryOperation; void post.retryLast().then(next => { if (next) { accept(next); if (operation === 'start' || operation === 'prompt') setPrompt(''); } }); }}>Retry session request</button>}
  </div>;
}
function validEntries(value: unknown): Entry[] {
  return Array.isArray(value) ? value.slice(-200).filter((entry): entry is Entry => !!entry && typeof entry === 'object' && Number.isSafeInteger(entry.sequence) && typeof entry.text === 'string').map(entry => ({ sequence: entry.sequence, time: Number.isFinite(entry.time) && Math.abs(entry.time) <= 8_640_000_000_000_000 ? entry.time : 0, stream: ['stdout', 'stderr', 'system'].includes(entry.stream) ? entry.stream : 'system', format: ['text', 'markdown', 'html', 'json', 'code'].includes(entry.format) ? entry.format : 'text', text: short(entry.text, 65536), level: ['info', 'warn', 'error', 'debug'].includes(entry.level) ? entry.level : 'info', label: entry.label ? short(entry.label, 120) : undefined })) : [];
}
function appendEntries(previous: Entry[], incoming: Entry[]) {
  const combined = [...new Map([...previous, ...incoming].map(entry => [entry.sequence, entry])).values()].sort((a, b) => a.sequence - b.sequence).slice(-MAX_ENTRIES);
  let characters = combined.reduce((sum, entry) => sum + entry.text.length, 0), start = 0;
  while (characters > MAX_CHARS && start < combined.length) characters -= combined[start++]!.text.length;
  return combined.slice(start);
}
function HtmlOutput({ sessionId, sequence, enabled, embeds }: { sessionId: string; sequence: number; enabled: boolean; embeds: boolean }) {
  const [interacting, setInteracting] = useState(false), input = enabled && interacting;
  useEffect(() => { setInteracting(false); }, [enabled, sessionId, sequence, embeds]);
  useEffect(() => { const reset = () => setInteracting(false); window.addEventListener('agenticview:canvas-navigation', reset); return () => window.removeEventListener('agenticview:canvas-navigation', reset); }, []);
  return <section className="session-custom"><div className="session-toolbar"><strong>Custom view</strong><span>isolated HTML document</span>{embeds && <button type="button" disabled={!enabled} aria-pressed={input} onClick={() => setInteracting(!input)}>{input ? 'Return to card navigation' : 'Interact with HTML'}</button>}</div>{!embeds ? <p>HTML output is paused in trusted embed settings.</p> : <div className="session-html-frame"><iframe title="Session HTML output" sandbox="allow-scripts allow-forms allow-popups allow-downloads" referrerPolicy="no-referrer" src={`${endpoint(sessionId)}/output/${sequence}/html`} inert={!input} tabIndex={input ? 0 : -1} style={{ pointerEvents: input ? 'auto' : 'none' }} />{!input && <div className="session-html-shield" aria-hidden="true" />}</div>}</section>;
}
function RichOutput({ sessionId, entry, mode, enabled, embeds }: { sessionId: string; entry: Entry; mode: string; enabled: boolean; embeds: boolean }) {
  const format = mode === 'Auto' ? entry.format : mode.toLowerCase(), text = short(entry.text, 32768);
  if (format === 'html') return <HtmlOutput sessionId={sessionId} sequence={entry.sequence} enabled={enabled} embeds={embeds} />;
  if (format === 'markdown') return <div className="session-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: props => <a {...props} target="_blank" rel="noopener noreferrer" />, img: ({ alt }) => <span>{alt ?? 'Embedded media'}</span> }}>{text}</ReactMarkdown></div>;
  if (format === 'json') { let formatted = text; try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Invalid/partial JSON remains readable literal text. */ } return <pre className="session-json">{short(formatted, 32768)}</pre>; }
  return <pre className={format === 'code' ? 'session-code' : 'session-plain'}>{text}{entry.text.length > text.length ? '\n… detail truncated; export the private handoff for retained output.' : ''}</pre>;
}
function SessionOutput({ id, enabled, visible, embeds }: { id: string; enabled: boolean; visible: boolean; embeds: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]), [paused, setPaused] = useState(false), [filter, setFilter] = useState(''), [query, setQuery] = useState(''), [error, setError] = useState(''), [truncated, setTruncated] = useState(false);
  const [follow, setFollow] = useState(true), [anchor, setAnchor] = useState(0), [selected, setSelected] = useState<number>(), [mode, setMode] = useState('Auto');
  const cursor = useRef(0), viewport = useRef<HTMLDivElement>(null);
  useEffect(() => { cursor.current = 0; setEntries([]); setError(''); setTruncated(false); setFollow(true); setAnchor(0); setSelected(undefined); }, [id, query]);
  useEffect(() => {
    if (!visible || paused) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, pending: AbortController | undefined;
    const poll = async () => {
      if (disposed || pending) return;
      const controller = new AbortController(); pending = controller;
      try {
        const output = await json<Output>(`${endpoint(id)}/output?after=${cursor.current}&limit=200${query ? `&filter=${encodeURIComponent(query)}` : ''}`, controller.signal);
        if (!disposed && !controller.signal.aborted) {
          const incoming = validEntries(output.entries); setEntries(previous => appendEntries(previous, incoming));
          if (Number.isSafeInteger(output.next) && output.next >= 0) cursor.current = output.next;
          if (output.truncated) setTruncated(true); setError('');
        }
      } catch (failure) { if (!disposed && !controller.signal.aborted) setError(short(failure instanceof Error ? failure.message : 'Session output unavailable.')); }
      finally { pending = undefined; if (!disposed) timer = setTimeout(poll, POLL_MS); }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); pending?.abort(); };
  }, [id, query, visible, paused]);
  useEffect(() => { if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [entries, follow]);
  const first = follow ? Math.max(0, entries.length - ROWS) : Math.max(0, entries.findIndex(entry => entry.sequence >= anchor));
  const displayed = entries.slice(first, first + ROWS), detail = follow ? entries.at(-1) : entries.find(entry => entry.sequence === selected) ?? displayed[0];
  const retainedChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  const navigate = (start: number) => { setFollow(false); const entry = entries[Math.max(0, Math.min(entries.length - 1, start))]; setAnchor(entry?.sequence ?? 0); setSelected(entry?.sequence); if (viewport.current) viewport.current.scrollTop = 0; };
  return <section className="session-output" aria-label="Session output">
    <form className="session-toolbar" onSubmit={event => { event.preventDefault(); if (enabled) setQuery(filter); }}><input aria-label="Search session output" maxLength={1000} value={filter} disabled={!enabled} placeholder="Search output" onChange={event => setFilter(event.target.value)} /><button type="submit" disabled={!enabled}>Search</button><button type="button" disabled={!enabled} onClick={() => setPaused(value => !value)}>{paused ? 'Resume output' : 'Pause output'}</button></form>
    <div className="session-toolbar"><span role="status">{!visible ? 'Output paused while hidden' : paused ? 'Output paused' : follow ? 'Following output' : 'Reading scrollback'} · {entries.length} retained entries · {retainedChars.toLocaleString()} characters</span><button type="button" disabled={!enabled || follow} onClick={() => setFollow(true)}>Follow latest</button></div>
    {(truncated || entries.length === MAX_ENTRIES || retainedChars >= MAX_CHARS - 65536) && <p className="session-caption">Older output may be outside this retained window. Export the private handoff for retained session evidence.</p>}{error && <p role="alert">{error}</p>}
    <div className="session-output-list" ref={viewport} tabIndex={enabled ? 0 : -1} onScroll={event => { const view = event.currentTarget; if (follow && view.scrollTop + view.clientHeight < view.scrollHeight - 24) { setFollow(false); setAnchor(displayed[0]?.sequence ?? 0); setSelected(detail?.sequence); } }}>
      {displayed.map(entry => <button type="button" className={`session-output-row level-${entry.level}${detail?.sequence === entry.sequence ? ' selected' : ''}`} key={entry.sequence} disabled={!enabled} aria-pressed={detail?.sequence === entry.sequence} onClick={() => { setFollow(false); setAnchor(displayed[0]?.sequence ?? 0); setSelected(entry.sequence); }}><time title={new Date(entry.time).toISOString()}>{new Date(entry.time).toLocaleTimeString()}</time><strong>{entry.label ?? entry.stream}</strong><span className="session-entry-level">{entry.level}</span><span>{short(entry.text, 300)}</span></button>)}
    </div>
    <div className="session-toolbar"><button type="button" disabled={!enabled || first <= 0} onClick={() => navigate(first - ROWS)}>Previous output</button><span>{entries.length ? `${first + 1}–${Math.min(entries.length, first + ROWS)} of ${entries.length} retained` : 'Waiting for output…'}</span><button type="button" disabled={!enabled || first + ROWS >= entries.length} onClick={() => navigate(first + ROWS)}>Next output</button><label>Render <select aria-label="Output render mode" value={mode} disabled={!enabled} onChange={event => setMode(event.target.value)}>{['Auto', 'Plain', 'Markdown', 'HTML', 'JSON'].map(value => <option key={value}>{value}</option>)}</select></label></div>
    {detail && <section className="session-output-detail" aria-label="Selected output"><div className="session-caption">#{detail.sequence} · {detail.label ?? detail.stream} · {detail.level} · {mode === 'Auto' ? detail.format : mode}</div><RichOutput key={detail.sequence} sessionId={id} entry={detail} mode={mode} enabled={enabled} embeds={embeds} /></section>}
  </section>;
}
function AgentSession({ id, enabled, visible, embeds }: { id: string; enabled: boolean; visible: boolean; embeds: boolean }) {
  const { record, error, accept } = useSession(id, visible);
  return <div className="agent-session">{error && <p role="alert">{error}</p>}{!record ? <p role="status">Loading session status…</p> : <><header className="session-heading"><strong>{short(record.name, 160)}</strong><span className={`session-state state-${record.state}`}>{record.state}</span><span>{short(record.agentType, 80)} · {record.transport === 'ssh' ? 'SSH' : 'local'} · attempt {record.attempt} · {record.recoveryCount} recoveries</span></header>{record.recoveryMode === 'handoff' && <p className="session-recovery-badge">Handoff recovery · replacement agent, same card and workflow</p>}{record.recoveryMode === 'native' && record.recoveryCount > 0 && <p className="session-recovery-badge">Native session recovery · same card and workflow</p>}{record.message && <p className="session-caption">{short(record.message)}</p>}{record.lastError && <p className="session-warning">{short(record.lastError)}</p>}{['error', 'offline', 'recovering'].includes(record.state) && <p className="session-caption">{record.autoRecover ? 'Automatic recovery is enabled.' : 'Automatic recovery is off.'} {record.replacementAvailable ? 'A recovery session can continue in this card.' : 'Current session evidence remains available below.'}</p>}{record.nativeSessionId && <p className="session-caption">Native session: <code>{short(record.nativeSessionId, 160)}</code></p>}<SessionControls record={record} enabled={enabled} accept={accept} /></>}
    <SessionOutput id={id} enabled={enabled} visible={visible} embeds={embeds} />
  </div>;
}
export function SessionView({ component, runId, embeds }: { component: SessionComponent; runId: string; embeds: boolean }) {
  const active = useContext(CardInteraction), ref = useRef<HTMLDivElement>(null), visible = useVisible(ref), enabled = active && visible;
  return <div className="session-view" ref={ref}>{component.kind === 'session-launcher' ? <Launcher key={`${runId}:${component.data.actionId}`} actionId={component.data.actionId} label={component.data.label} runId={runId} enabled={enabled} /> : <AgentSession key={component.data.sessionId} id={component.data.sessionId} enabled={enabled} visible={visible} embeds={embeds} />}</div>;
}
