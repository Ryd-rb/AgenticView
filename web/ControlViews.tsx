import { useCallback, useContext, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { cellRules, coerceGridChanges, evaluatePrecedence, type GridData as ConfiguredGridData, type PrecedenceResult } from '../shared/grid-config.js';
import { presentationStyle } from './ComponentSettings.js';
import { CardInteraction } from './CardInteraction.js';

type Scalar = string | number | boolean | null;
type Field = { key: string; label: string; type: 'text' | 'multiline' | 'number' | 'select' | 'toggle' | 'json'; required?: boolean; options?: string[]; min?: number; max?: number };
type Action = { id: string; label: string; kind: string; description?: string; confirmation?: string; fields?: Field[] };
type Configuration = { version: string; application?: { name: string }; actions: Action[] };
type Invocation = { id: string; actionId: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'; createdAt: string | number; startedAt?: string | number; finishedAt?: string | number; result?: Record<string, unknown>; error?: string };
export type ControlComponent = {id?: string} & (
  | { kind: 'action-panel'; data: { actionIds: string[] } }
  | { kind: 'log-stream'; data: { actionId: string; pollMs?: number; maxRows?: number } }
  | { kind: 'data-grid'; data: ConfiguredGridData });
const MAX_TEXT = 16_000;
const bounded = (value: unknown, limit = MAX_TEXT) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  return text.length > limit ? `${text.slice(0, limit)}\n… output truncated` : text;
};
const message = (error: unknown) => bounded(error instanceof Error ? error.message : 'Control request failed.', 2000);
const terminal = (state: Invocation['state']) => state !== 'queued' && state !== 'running';
const baseUrl = (runId: string) => `/api/controls/${encodeURIComponent(runId)}`;
const aborted = () => new DOMException('Request stopped.', 'AbortError');
async function json<T>(url: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (response.status === 401) window.dispatchEvent(new Event('agenticview:unauthorized'));
  const text = await response.text();
  if (text.length > 524_288) throw new Error('Control response exceeds the display limit.');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(`Control request returned an invalid response (${response.status}).`); }
  if (!response.ok) throw new Error(`Control request failed (${response.status}): ${bounded((data as { error?: string })?.error ?? response.statusText, 1500)}`);
  return data as T;
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const stop = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
function useVisibility(ref: RefObject<HTMLDivElement | null>) {
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
type Review = { action: Action; input: Record<string, unknown>; resolve: (confirmed: boolean) => void };
function useControls(runId: string, enabled: boolean, visible: boolean) {
  const [config, setConfig] = useState<Configuration>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const [review, setReview] = useState<Review>(), [last, setLast] = useState<Invocation>();
  const controller = useRef<AbortController | undefined>(undefined), enabledRef = useRef(enabled), configRef = useRef(config);
  const visibleRef = useRef(visible), selectionRequired = useRef(true);
  enabledRef.current = enabled; visibleRef.current = visible; configRef.current = config;
  useEffect(() => {
    const request = new AbortController(); setConfig(undefined); setError('');
    void json<Configuration>(baseUrl(runId), request.signal).then(value => { if (!request.signal.aborted) setConfig(value); }).catch(failure => { if (!request.signal.aborted) setError(message(failure)); });
    return () => request.abort();
  }, [runId, configurationRevision]);
  useEffect(() => {
    if (!enabled && selectionRequired.current) controller.current?.abort();
  }, [enabled]);
  useEffect(() => {
    if (!visible) controller.current?.abort();
    return () => controller.current?.abort();
  }, [visible, runId]);
  const invoke = useCallback(async (actionId: string, input: Record<string, unknown>, expectedKind?: string, monitor = false): Promise<Invocation> => {
    // Only typed read views receive background authority. Manual submissions,
    // edits, history controls and every confirmation still require selection.
    const monitoring = monitor && (expectedKind === 'logs' || expectedKind === 'query');
    const allowed = () => visibleRef.current && (enabledRef.current || monitoring);
    if (!allowed()) throw aborted();
    if (controller.current && !controller.current.signal.aborted) throw new Error('Another action is still pending.');
    const current = configRef.current, action = current?.actions.find(item => item.id === actionId);
    if (!current || !action || expectedKind && action.kind !== expectedKind) {
      const failure = new Error(expectedKind ? `This view requires an action of kind ${expectedKind}. Check its configuration.` : 'Action is unavailable in the current application configuration.');
      setError(failure.message); throw failure;
    }
    const request = new AbortController(); controller.current = request; selectionRequired.current = !monitoring; setBusy(true); setError('');
    try {
      let confirmed = false;
      if (action.confirmation) {
        if (!enabledRef.current) throw new Error('Select this card to review and confirm this read action.');
        selectionRequired.current = true;
        confirmed = await new Promise<boolean>((resolve, reject) => {
          const stop = () => { setReview(undefined); reject(aborted()); };
          request.signal.addEventListener('abort', stop, { once: true });
          setReview({ action, input, resolve: accepted => { request.signal.removeEventListener('abort', stop); setReview(undefined); resolve(accepted); } });
        });
        if (!confirmed) throw aborted();
        selectionRequired.current = !monitoring;
      }
      if (!allowed() || request.signal.aborted) throw aborted();
      // A lost response is never retried with a new identity: execution might have begun.
      let result = await json<Invocation>(`${baseUrl(runId)}/invoke`, request.signal, { requestId: crypto.randomUUID(), definitionVersion: current.version, actionId, input, ...(confirmed ? { confirmed: true } : {}) });
      if (request.signal.aborted) throw aborted();
      setLast(result);
      const deadline = Date.now() + 125_000;
      while (!terminal(result.state)) {
        if (Date.now() >= deadline) throw new Error(`Invocation ${result.id} is still pending. Check recent history before retrying.`);
        await wait(750, request.signal);
        result = await json<Invocation>(`${baseUrl(runId)}/invocations/${encodeURIComponent(result.id)}`, request.signal);
        if (request.signal.aborted) throw aborted();
        setLast(result);
      }
      if (result.state !== 'succeeded') throw new Error(result.error || `Action ${result.state}. Check history before retrying.`);
      return result;
    } catch (failure) {
      if (!request.signal.aborted && !(failure instanceof DOMException && failure.name === 'AbortError')) setError(message(failure));
      throw failure;
    } finally {
      if (controller.current === request) { controller.current = undefined; setBusy(false); }
    }
  }, [runId]);
  const cancel = useCallback(() => controller.current?.abort(), []);
  const refreshActions = useCallback(() => { controller.current?.abort(); setConfigurationRevision(value => value + 1); }, []);
  return { config, error, setError, busy, review, last, invoke, cancel, refreshActions };
}
type Controls = ReturnType<typeof useControls>;
function ReviewAction({ controls, enabled }: { controls: Controls; enabled: boolean }) {
  const review = controls.review;
  if (!review) return null;
  return <section className="control-review" aria-label="Review action"><strong>Review {review.action.label}</strong><p>{bounded(review.action.confirmation, 2000)}</p><pre>{bounded(review.input, 4000)}</pre><div className="control-toolbar"><button type="button" disabled={!enabled} onClick={() => review.resolve(false)}>Cancel</button><button type="button" disabled={!enabled} className="control-primary" onClick={() => review.resolve(true)}>Confirm {review.action.label}</button></div></section>;
}
function InvocationResult({ invocation }: { invocation?: Invocation }) {
  return invocation ? <div className="control-result" role="status"><span className={`control-state state-${invocation.state}`}>{invocation.state}</span><span>{invocation.actionId}</span><time title={String(invocation.finishedAt ?? invocation.startedAt ?? invocation.createdAt)}>{new Date(invocation.finishedAt ?? invocation.startedAt ?? invocation.createdAt).toLocaleTimeString()}</time>{invocation.result && <pre>{bounded(invocation.result)}</pre>}{invocation.error && <p>{bounded(invocation.error, 2000)}</p>}</div> : null;
}
function FieldInput({ field, value, change, disabled }: { field: Field; value: unknown; change: (value: unknown) => void; disabled: boolean }) {
  const common = { required: field.required, disabled, 'aria-label': field.label };
  if (field.type === 'toggle') return <input {...common} type="checkbox" checked={value === true} onChange={event => change(event.target.checked)} />;
  if (field.type === 'select') return <select {...common} value={String(value ?? '')} onChange={event => change(event.target.value)}><option value="">Select…</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>;
  if (field.type === 'multiline' || field.type === 'json') return <textarea {...common} maxLength={MAX_TEXT} rows={3} value={String(value ?? '')} onChange={event => change(event.target.value)} spellCheck={field.type !== 'json'} />;
  return <input {...common} type={field.type === 'number' ? 'number' : 'text'} min={field.min} max={field.max} step="any" maxLength={MAX_TEXT} value={String(value ?? '')} onChange={event => change(event.target.value)} />;
}
function formInput(fields: Field[], values: Record<string, unknown>, preserveEmpty = false) {
  return Object.fromEntries(fields.flatMap(field => {
    const value = field.type === 'toggle' ? values[field.key] === true : values[field.key];
    if (value === undefined || value === '') {
      if (preserveEmpty && value === '' && field.type === 'text') return [[field.key, '']];
      if (field.required) throw new Error(`${field.label} is required.`); return [];
    }
    if (field.type === 'json') { try { return [[field.key, JSON.parse(String(value))]]; } catch { throw new Error(`${field.label} must contain valid JSON.`); } }
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number) || field.min !== undefined && number < field.min || field.max !== undefined && number > field.max) throw new Error(`${field.label} is outside its allowed range.`);
      return [[field.key, number]];
    }
    return [[field.key, field.type === 'toggle' ? value === true : value]];
  }));
}
function ActionForm({ action, controls, enabled }: { action: Action; controls: Controls; enabled: boolean }) {
  const [values, setValues] = useState<Record<string, unknown>>({}), [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!enabled || controls.busy) return;
    try { const input = formInput(action.fields ?? [], values); setError(''); void controls.invoke(action.id, input).catch(() => {}); } catch (failure) { setError(message(failure)); }
  };
  return <form className="control-action" onSubmit={submit}><strong>{action.label}</strong>{action.description && <p>{bounded(action.description, 2000)}</p>}{action.fields?.map(field => <label key={field.key} className={field.type === 'toggle' ? 'control-field control-toggle' : 'control-field'}><span>{field.label}{field.required ? ' *' : ''}</span><FieldInput field={field} value={values[field.key]} change={value => setValues(previous => ({ ...previous, [field.key]: value }))} disabled={!enabled || controls.busy} /></label>)}{error && <p role="alert">{error}</p>}<button type="submit" disabled={!enabled || controls.busy}>{action.confirmation ? `Review ${action.label}` : action.label}</button></form>;
}
function ActionPanel({ data, controls, enabled, runId }: { data: Extract<ControlComponent, { kind: 'action-panel' }>['data']; controls: Controls; enabled: boolean; runId: string }) {
  const [history, setHistory] = useState<Invocation[]>([]), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController();
    void json<Invocation[]>(`${baseUrl(runId)}/history?limit=20`, request.signal).then(rows => { if (!request.signal.aborted) { setHistory(rows.slice(0, 20)); setError(''); } }).catch(failure => { if (!request.signal.aborted) setError(message(failure)); });
    return () => request.abort();
  }, [runId, enabled, controls.last, refresh]);
  return <><div className="control-actions">{data.actionIds.map(id => { const action = controls.config?.actions.find(item => item.id === id); return action ? <ActionForm key={id} action={action} controls={controls} enabled={enabled} /> : <p key={id}>Action unavailable: {id}</p>; })}</div><InvocationResult invocation={controls.last} /><details className="control-history"><summary>Recent history ({history.length})</summary><button type="button" disabled={!enabled} onClick={() => setRefresh(value => value + 1)}>Refresh history</button>{error && <p role="alert">{error}</p>}{history.map(item => <InvocationResult key={item.id} invocation={item} />)}</details></>;
}
type LogEntry = { time?: string; level?: string; message: string };
function LogStream({ data, controls, enabled, visible }: { data: Extract<ControlComponent, { kind: 'log-stream' }>['data']; controls: Controls; enabled: boolean; visible: boolean }) {
  const [paused, setPaused] = useState(false), [filter, setFilter] = useState(''), [level, setLevel] = useState(''), [entries, setEntries] = useState<LogEntry[]>([]), [scroll, setScroll] = useState(0);
  const [meta, setMeta] = useState(''), cursor = useRef<string | undefined>(undefined), viewport = useRef<HTMLDivElement>(null);
  const limit = Math.max(1, Math.min(2000, data.maxRows ?? 500)), delay = Math.max(500, Math.min(60_000, data.pollMs ?? 1500));
  useEffect(() => { cursor.current = undefined; setEntries([]); setScroll(0); }, [data.actionId, filter, level]);
  useEffect(() => {
    if (!visible || paused || !controls.config) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const invocation = await controls.invoke(data.actionId, { ...(cursor.current ? { cursor: cursor.current } : {}), ...(filter ? { filter } : {}), ...(level ? { level } : {}) }, 'logs', true);
        if (disposed) return;
        const result = invocation.result ?? {}, tail = Array.isArray(result.entries) ? result.entries.slice(-limit).filter((entry): entry is LogEntry => !!entry && typeof entry === 'object' && typeof entry.message === 'string').map(entry => ({ time: typeof entry.time === 'string' ? entry.time.slice(0, 100) : undefined, level: typeof entry.level === 'string' ? entry.level.slice(0, 30) : undefined, message: bounded(entry.message, 4000) })) : [];
        const follow = !viewport.current || viewport.current.scrollTop + viewport.current.clientHeight >= viewport.current.scrollHeight - 40;
        setEntries(previous => [...previous, ...tail].slice(-limit));
        if (typeof result.cursor === 'string') cursor.current = result.cursor;
        setMeta(`${typeof result.bytesRead === 'number' ? `${result.bytesRead} bytes read · ` : ''}${result.truncated ? 'Source truncated · ' : ''}up to ${limit} retained rows`);
        if (follow && viewport.current) { const view = viewport.current; queueMicrotask(() => { if (!disposed) { view.scrollTop = view.scrollHeight; setScroll(view.scrollTop); } }); }
      } catch (failure) {
        if (!disposed && failure instanceof DOMException && failure.name === 'AbortError') { setPaused(true); return; }
        // The common runner displays errors; a later bounded poll can recover.
      }
      if (!disposed) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); controls.cancel(); };
  }, [visible, paused, controls.config, controls.invoke, controls.cancel, data.actionId, delay, filter, level, limit]);
  const rowHeight = 30, start = Math.max(0, Math.floor(scroll / rowHeight) - 3), end = Math.min(entries.length, start + 16);
  return <><div className="control-toolbar"><button type="button" disabled={!enabled} onClick={() => setPaused(value => !value)}>{paused ? 'Resume' : 'Pause'}</button><input aria-label="Filter logs" placeholder="Filter logs" value={filter} disabled={!enabled} maxLength={500} onChange={event => setFilter(event.target.value)} /><select aria-label="Log level" disabled={!enabled} value={level} onChange={event => setLevel(event.target.value)}><option value="">All levels</option>{['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map(value => <option key={value}>{value}</option>)}</select></div><p className="control-caption" role="status">{!visible ? 'Paused while hidden' : paused ? 'Paused' : 'Following'} · {entries.length} rows · {meta}</p><div className="control-log" ref={viewport} tabIndex={enabled ? 0 : -1} aria-label="Live log entries" onScroll={event => setScroll(event.currentTarget.scrollTop)}><div style={{ height: entries.length * rowHeight, position: 'relative' }}><div style={{ position: 'absolute', top: start * rowHeight, left: 0, right: 0 }}>{entries.slice(start, end).map((entry, index) => <div key={start + index} className={`control-log-row level-${['warn', 'error', 'fatal', 'debug', 'trace', 'info'].includes(entry.level ?? '') ? entry.level : 'info'}`}><time title={entry.time}>{entry.time ?? '—'}</time><span>{entry.level ?? 'info'}</span><span title={entry.message}>{entry.message}</span></div>)}</div></div></div></>;
}
type Row = Record<string, Scalar>;
type GridData = Extract<ControlComponent, { kind: 'data-grid' }>['data'];
type Sort = { key: string; direction: 'asc' | 'desc' };
type GridOperation = 'add' | 'update' | 'delete' | 'bulk';
function GridField({column,row,data,label,value,change,disabled}:{column:GridData['columns'][number];row:Row;data:GridData;label:string;value:unknown;change:(value:unknown)=>void;disabled:boolean}) {
 const {constraints:c}=cellRules(data,row,column.key);
 if(c.values) {if(c.storage==='string'&&typeof value==='string'){if(c.type==='boolean'&&(value==='true'||value==='false'))value=value==='true';else if(c.type==='number'||c.type==='integer')value=Number(value);}return <select aria-label={label} disabled={disabled} value={JSON.stringify(value)??''} onChange={event=>change(JSON.parse(event.target.value))}><option value="" disabled>Select…</option>{c.values.map((item,index)=><option key={index} value={JSON.stringify(item)}>{String(item??'null')}</option>)}</select>;}
 if(c.type==='boolean') return <select aria-label={label} disabled={disabled} value={String(value??'')} onChange={event=>change(event.target.value)}><option value="">Select…</option><option value="true">true</option><option value="false">false</option></select>;
 return <FieldInput field={{key:column.key,label,type:c.type==='number'||c.type==='integer'?'number':column.type??'text',required:c.required,min:c.min,max:c.max}} value={value} change={change} disabled={disabled}/>;
}
const isRow = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(cell => cell === null || typeof cell === 'string' || typeof cell === 'boolean' || typeof cell === 'number' && Number.isFinite(cell));
const rowWindow = (value: unknown, limit: number) => Array.isArray(value) ? value.slice(0, limit).filter(isRow) : [];
function rowIdentity(row: Row, data: GridData) {
  return { ...(data.keyColumn && Object.hasOwn(row, data.keyColumn) ? { rowId: row[data.keyColumn] } : {}), ...(data.keyColumns?.length ? { rowKey: Object.fromEntries(data.keyColumns.map(key=>[key,row[key]])) } : {}), ...(data.versionColumn && Object.hasOwn(row, data.versionColumn) ? { expectedVersion: row[data.versionColumn] } : {}) };
}
function GridRow({ row, index, data, controls, enabled, selected, select, acknowledged, visibleColumns, precedence }: { visibleColumns: GridData['columns']; precedence?: PrecedenceResult; row: Row; index: number; data: GridData; controls: Controls; enabled: boolean; selected: boolean; select: (selected: boolean) => void; acknowledged: (result: Invocation, operation: GridOperation, index?: number) => void }) {
  const [editing, setEditing] = useState(false), [changes, setChanges] = useState<Record<string, unknown>>({}), [history, setHistory] = useState<unknown>(), [error, setError] = useState('');
  const rowLabel = data.keyColumn ? String(row[data.keyColumn] ?? index + 1) : `row ${index + 1}`;
  const save = async () => {
    if (!enabled || controls.busy || !data.editAction) return;
    try {
      const permitted = Object.fromEntries(Object.entries(changes).filter(([key])=>data.columns.some(column=>column.key===key&&column.editable)));
      const updated = coerceGridChanges(data,row,permitted), input=Object.fromEntries(Object.keys(permitted).map(key=>[key,updated[key]]));
      const result = await controls.invoke(data.editAction, { operation: 'update', row: updated, rows: [updated], previousRow: row, ...rowIdentity(row, data), changes: input }, 'edit');
      setEditing(false); setChanges({}); setError(''); acknowledged(result, 'update', index);
    } catch (failure) { if (!(failure instanceof DOMException && failure.name === 'AbortError')) setError(message(failure)); }
  };
  const remove = async () => {
    if (!enabled || controls.busy || !data.deleteAction) return;
    try { const result = await controls.invoke(data.deleteAction, { operation: 'delete', row, rows: [row], ...rowIdentity(row, data) }, 'edit'); acknowledged(result, 'delete', index); }
    catch (failure) { if (!(failure instanceof DOMException && failure.name === 'AbortError')) setError(message(failure)); }
  };
  const hasActions = !!(data.editAction || data.deleteAction || data.historyAction), cells = visibleColumns.length + (precedence ? 1 : 0) + (data.bulkAction ? 1 : 0) + (hasActions ? 1 : 0);
  return <>
    <tr data-precedence={precedence?.state}>
      {precedence && <td className="grid-precedence" data-state={precedence.state} title={precedence.reason}><strong>{precedence.state}</strong><div>{precedence.reason}</div></td>}
      {data.bulkAction && <td className="control-select-cell"><input type="checkbox" aria-label={`Select ${rowLabel}`} checked={selected} disabled={!enabled || controls.busy} onChange={event => select(event.target.checked)} /></td>}
      {visibleColumns.map(column => { const resolved=cellRules(data,{...row,...changes} as Row,column.key); return <td key={column.key} style={{...presentationStyle(resolved.presentation),width:column.width}} title={resolved.tooltip}>{editing && column.editable ? <GridField column={column} row={{...row,...changes} as Row} data={data} label={`${column.label} for ${rowLabel}`} value={Object.hasOwn(changes,column.key)?changes[column.key]:row[column.key]} change={value=>setChanges(previous=>({...previous,[column.key]:value}))} disabled={!enabled||controls.busy}/> : bounded(row[column.key],2000)}</td>; })}

      {hasActions && <td className="control-row-actions">
        {data.editAction && (editing ? <><button type="button" disabled={!enabled || controls.busy || Object.keys(changes).length === 0} onClick={() => void save()}>Save</button><button type="button" disabled={!enabled || controls.busy} onClick={() => { setEditing(false); setChanges({}); setError(''); }}>Cancel edit</button></> : <button type="button" disabled={!enabled || controls.busy} onClick={() => setEditing(true)}>Edit</button>)}
        {data.deleteAction && <button type="button" disabled={!enabled || controls.busy} onClick={() => void remove()}>Delete</button>}
        {data.historyAction && <button type="button" disabled={!enabled || controls.busy} onClick={() => void controls.invoke(data.historyAction!, { ...(data.keyColumn && Object.hasOwn(row, data.keyColumn) ? { rowId: row[data.keyColumn] } : {}), ...(data.keyColumns?.length ? { rowKey: Object.fromEntries(data.keyColumns.map(key=>[key,row[key]])) } : {}), row }, 'history').then(result => setHistory(result.result)).catch(() => {})}>History</button>}
      </td>}
    </tr>
    {(error || history !== undefined) && <tr><td colSpan={cells}>{error && <p role="alert">{error}</p>}{history !== undefined && <details open><summary>History for {rowLabel}</summary><pre>{bounded(history, 6000)}</pre></details>}</td></tr>}
  </>;
}
function AddGridRow({ data, controls, enabled, close, acknowledged }: { data: GridData; controls: Controls; enabled: boolean; close: () => void; acknowledged: (result: Invocation, operation: GridOperation) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({}), [error, setError] = useState('');
  const fields: Field[] = data.columns.filter(column => column.editable !== false).map(column => ({ key: column.key, label: `New ${column.label}`, type: column.type ?? 'text' }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!enabled || controls.busy || !data.addAction) return;
    try { const row = coerceGridChanges(data,{},values); const result = await controls.invoke(data.addAction, { operation: 'add', row, rows: [row] }, 'edit'); acknowledged(result, 'add'); close(); }
    catch (failure) { if (!(failure instanceof DOMException && failure.name === 'AbortError')) setError(message(failure)); }
  };
  return <form className="control-action control-add-row" aria-label="Add row editor" onSubmit={event => void submit(event)}><strong>New row</strong>{fields.map(field => <label key={field.key} className="control-field"><span>{field.label}</span><GridField column={data.columns.find(column=>column.key===field.key)!} row={values as Row} data={data} label={field.label} value={values[field.key]} change={value => setValues(previous => ({ ...previous, [field.key]: value }))} disabled={!enabled || controls.busy} /></label>)}{error && <p role="alert">{error}</p>}<div className="control-toolbar"><button type="submit" disabled={!enabled || controls.busy}>Save new row</button><button type="button" disabled={!enabled || controls.busy} onClick={close}>Cancel new row</button></div></form>;
}
function DataGrid({ data: supplied, controls, enabled, visible }: { data: Extract<ControlComponent, { kind: 'data-grid' }>['data']; controls: Controls; enabled: boolean; visible: boolean }) {
  const data = {...supplied,...Object.fromEntries(['add','edit','delete','bulk','history','evaluate'].filter(feature=>supplied.features?.[feature as keyof NonNullable<GridData['features']>]===false).map(feature=>[feature+'Action',undefined]))};
  const [hidden,setHidden]=useState<Set<string>>(()=>new Set(data.columns.filter(column=>column.hidden).map(column=>column.key)));
  useEffect(()=>setHidden(new Set(data.columns.filter(column=>column.hidden).map(column=>column.key))),[supplied.columns]);
  const visibleColumns=data.columns.filter(column=>!hidden.has(column.key));
  const [rows, setRows] = useState<Row[]>(() => rowWindow(data.rows, 2000)), [filter, setFilter] = useState(''), [query, setQuery] = useState(''), [cursors, setCursors] = useState<(string | undefined)[]>([undefined]), [next, setNext] = useState<string>(), [total, setTotal] = useState<number>(), [refresh, setRefresh] = useState(0);
  const [saveResult, setSaveResult] = useState<Invocation>(), [adding, setAdding] = useState(false), [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [localPage, setLocalPage] = useState(0), [sort, setSort] = useState<Sort[]>([]), [rowRevision, setRowRevision] = useState(0);
  const [cursorOffset, setCursorOffset] = useState(0), sourceRows = useRef(data.rows);
  sourceRows.current = data.rows;
  const pageSize = Math.max(1, Math.min(200, data.pageSize ?? 50)), cursor = cursors[cursors.length - 1];
  useEffect(() => { setRows(rowWindow(data.rows, 2000)); setSelected(new Set()); setLocalPage(0); setRowRevision(value => value + 1); }, [data.rows]);
  useEffect(() => {
    if (!visible || !controls.config || !data.readAction) return;
    let disposed = false;
    void controls.invoke(data.readAction, { limit: pageSize, ...(cursor ? { cursor } : {}), ...(query ? { filter: query } : {}), ...(sort.length ? { sort } : {}) }, 'query', true).then(invocation => {
      if (disposed) return;
      const result = invocation.result ?? {};
      // totalRows is display metadata; it never sizes an array, a viewport or a DOM tree.
      setRows(rowWindow(result.rows, pageSize)); setRowRevision(value => value + 1); setSelected(new Set());
      setNext(typeof result.nextCursor === 'string' ? result.nextCursor : undefined); setTotal(typeof result.totalRows === 'number' && Number.isFinite(result.totalRows) && result.totalRows >= 0 ? result.totalRows : undefined);
    }).catch(() => {});
    return () => { disposed = true; controls.cancel(); };
  }, [visible, controls.config, controls.invoke, controls.cancel, data.readAction, pageSize, cursor, query, sort, refresh]);
  const acknowledged = (result: Invocation, operation: GridOperation, index?: number) => {
    setSaveResult(result); setSelected(new Set());
    if (data.readAction) { setRefresh(value => value + 1); return; }
    if (sourceRows.current !== data.rows) return; // Newer telemetry wins over an older callback's acknowledgement.
    const output = result.result ?? {};
    if (Array.isArray(output.rows)) setRows(rowWindow(output.rows, 2000));
    else if (operation === 'delete' && index !== undefined) setRows(previous => previous.filter((_, rowIndex) => rowIndex !== index));
    else if (isRow(output.row)) {
      const row = output.row;
      if (operation === 'add') setRows(previous => [...previous, row].slice(0, 2000));
      else if (operation === 'update' && index !== undefined) setRows(previous => previous.map((previousRow, rowIndex) => rowIndex === index ? row : previousRow));
    }
    setRowRevision(value => value + 1);
  };
  const priorities = data.features?.explain === false ? [] : evaluatePrecedence(data,rows);
  const indexed = rows.map((row, index) => ({ row, index }));
  const filtered = data.readAction ? indexed : indexed.filter(({ row }) => !query || Object.values(row).some(value => String(value ?? '').toLowerCase().includes(query.toLowerCase())));
  if (!data.readAction && sort.length) filtered.sort((a, b) => {
    for (const column of sort) {
      const left = a.row[column.key], right = b.row[column.key];
      const difference = left === right ? 0 : left == null ? -1 : right == null ? 1 : typeof left === 'number' && typeof right === 'number' ? left - right : String(left) < String(right) ? -1 : 1;
      if (difference) return column.direction === 'asc' ? difference : -difference;
    }
    return a.index - b.index;
  });
  const page = data.readAction ? cursorOffset + cursors.length - 1 : Math.min(localPage, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const displayed = data.readAction ? filtered : filtered.slice(page * pageSize, (page + 1) * pageSize);
  const rowCount = data.readAction ? total : filtered.length, hasActions = !!(data.editAction || data.deleteAction || data.historyAction);
  const resetPages = () => { setCursors([undefined]); setCursorOffset(0); setLocalPage(0); setSelected(new Set()); };
  const sortColumn = (key: string, additive: boolean) => {
    if (!enabled || controls.busy) return;
    const previous = sort.find(column => column.key === key);
    const direction: Sort['direction'] | undefined = previous?.direction === 'asc' ? 'desc' : previous?.direction === 'desc' ? undefined : 'asc';
    const columns = additive ? sort.filter(column => column.key !== key) : [];
    setSort(direction ? [...columns, { key, direction }].slice(-4) : columns); resetPages();
  };
  const bulk = async () => {
    if (!enabled || controls.busy || !data.bulkAction || selected.size === 0) return;
    try { const result = await controls.invoke(data.bulkAction, { operation: 'bulk', rows: displayed.filter(({ index }) => selected.has(index)).map(({ row }) => row) }, 'edit'); acknowledged(result, 'bulk'); } catch { /* Common runner displays failures and preserves rows. */ }
  };
  return <>
    {data.features?.hideColumns !== false && <details className="grid-column-settings"><summary>Visible columns</summary><div>{data.columns.map(column=><label key={column.key}><input type="checkbox" checked={!hidden.has(column.key)} disabled={!enabled||controls.busy||!hidden.has(column.key)&&visibleColumns.length<=1} onChange={event=>setHidden(previous=>{const next=new Set(previous);if(event.target.checked)next.delete(column.key);else next.add(column.key);return next;})}/>{column.label}</label>)}</div></details>}
    {data.precedence && <p className="grid-rule-caption">{data.precedence.label ?? 'Priority'}: {data.precedence.dimensions.join(' > ')}. {data.readAction ? 'Evaluation covers this page; use a provider action for a dataset-wide result.' : 'Evaluation covers supplied rows.'}</p>}
    <form className="control-toolbar" onSubmit={event => { event.preventDefault(); if (!enabled || controls.busy) return; setQuery(filter); resetPages(); setRefresh(value => value + 1); }}>
      {data.features?.filter !== false && <><input aria-label="Filter rows" placeholder="Filter rows" disabled={!enabled || controls.busy} maxLength={500} value={filter} onChange={event => setFilter(event.target.value)} />
      <button disabled={!enabled || controls.busy} type="submit">Apply filter</button></>}
      {data.readAction && <button type="button" disabled={!enabled || controls.busy} onClick={() => setRefresh(value => value + 1)}>Refresh</button>}
      {data.evaluateAction && <button type="button" disabled={!enabled||controls.busy} onClick={()=>void controls.invoke(data.evaluateAction!,{rows:displayed.map(item=>item.row),precedence:data.precedence},'custom').then(result=>{if(sourceRows.current!==data.rows)return;if(Array.isArray(result.result?.rows)){setRows(rowWindow(result.result.rows,data.readAction?pageSize:2000));setSelected(new Set());setRowRevision(value=>value+1);}}).catch(()=>{})}>Evaluate rules</button>}
      {data.addAction && <button type="button" disabled={!enabled || controls.busy || adding} onClick={() => setAdding(true)}>Add row</button>}
      {data.bulkAction && <><button type="button" disabled={!enabled || controls.busy || selected.size === 0} onClick={() => void bulk()}>Apply to selected</button><span>{selected.size} selected</span></>}
    </form>
    {adding && <AddGridRow data={data} controls={controls} enabled={enabled} close={() => setAdding(false)} acknowledged={acknowledged} />}
    <div className="control-grid"><table><thead><tr>
      {priorities.length>0 && <th scope="col">Priority evaluation</th>}
      {data.bulkAction && <th scope="col" className="control-select-cell"><input type="checkbox" aria-label="Select page" disabled={!enabled || controls.busy || displayed.length === 0} checked={displayed.length > 0 && displayed.every(({ index }) => selected.has(index))} onChange={event => setSelected(event.target.checked ? new Set(displayed.map(({ index }) => index)) : new Set())} /></th>}
      {visibleColumns.map(column => { const direction = sort.find(item => item.key === column.key)?.direction; return <th key={column.key} scope="col" aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}><button type="button" className="control-sort" aria-label={`Sort ${column.label}`} disabled={!enabled || controls.busy || data.features?.sort === false} title="Sort; Shift-click to add another column" onClick={event => sortColumn(column.key, event.shiftKey)}>{column.label}{direction === 'asc' ? ' ↑' : direction === 'desc' ? ' ↓' : ' ↕'}</button></th>; })}
      {hasActions && <th scope="col">Actions</th>}
    </tr></thead><tbody>{displayed.map(({ row, index }) => <GridRow key={`${index}:${rowRevision}`} row={row} index={index} data={data} visibleColumns={visibleColumns} precedence={priorities[index]} controls={controls} enabled={enabled} selected={selected.has(index)} select={value => setSelected(previous => { const next = new Set(previous); if (value) next.add(index); else next.delete(index); return next; })} acknowledged={acknowledged} />)}</tbody></table></div>
    {displayed.length === 0 && <p className="control-caption">{controls.busy ? 'Loading rows…' : 'No rows in this page.'}</p>}
    <div className="control-toolbar"><button type="button" disabled={!enabled || controls.busy || (data.readAction ? cursors.length <= 1 : page <= 0)} onClick={() => { if (data.readAction) setCursors(previous => previous.slice(0, -1)); else setLocalPage(page - 1); setSelected(new Set()); }}>Previous page</button><span>Page {page + 1} · {displayed.length} rows{rowCount === undefined ? '' : ` of ${rowCount.toLocaleString()}`}</span><button type="button" disabled={!enabled || controls.busy || (data.readAction ? !next : (page + 1) * pageSize >= filtered.length)} onClick={() => { if (data.readAction) { if (cursors.length >= 256) { setCursors(previous => [...previous.slice(-255), next]); setCursorOffset(value => value + 1); } else setCursors(previous => [...previous, next]); } else setLocalPage(page + 1); setSelected(new Set()); }}>Next page</button></div>
    <InvocationResult invocation={controls.last?.actionId === data.readAction ? saveResult : controls.last ?? saveResult} />
  </>;
}
export function ControlView({ component, runId }: { component: ControlComponent; runId: string }) {
  const active = useContext(CardInteraction), ref = useRef<HTMLDivElement>(null), visible = useVisibility(ref), enabled = active && visible;
  const originalControls = useControls(runId, enabled, visible);
  const componentId=component.kind==='data-grid'?component.id:undefined;
  const scopedInvoke=useCallback((actionId:string,input:Record<string,unknown>,expectedKind?:string,monitor=false)=>originalControls.invoke(actionId,{...input,...(componentId?{componentId}:{})},expectedKind,monitor),[originalControls.invoke,componentId]);
  const controls={...originalControls,invoke:scopedInvoke};
  const interactive = enabled && !!controls.config;
  return <div className="control-view" ref={ref}><div className="control-toolbar"><span className="control-caption">{controls.config?.application?.name ?? 'Application controls'}</span><button type="button" disabled={!enabled || controls.busy} onClick={controls.refreshActions}>Refresh actions</button></div>{controls.error && <p className="control-error" role="alert">{controls.error}</p>}<ReviewAction controls={controls} enabled={interactive} />{!controls.config && <p role="status">Loading configured actions…</p>}{component.kind === 'action-panel' ? <ActionPanel data={component.data} controls={controls} enabled={interactive} runId={runId} /> : component.kind === 'log-stream' ? <LogStream data={component.data} controls={controls} enabled={interactive} visible={visible} /> : <DataGrid data={component.data} controls={controls} enabled={interactive} visible={visible} />}</div>;
}
