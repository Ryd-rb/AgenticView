import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { applicationManifestSchema, type ApplicationManifest } from '../shared/application-manifest.js';
import { idSchema } from '../shared/protocol.js';

const MAX_BYTES = 262_144;
const PAGE_SIZE = 25;
type Summary = { runId: string; id: string; name: string; version: string; description?: string; components: number; actions: number };
type ImportBody = { manifest: ApplicationManifest; bindings: Record<string, string>; requestId: string; registrationKey: string };
const short = (value: unknown, limit = 1500) => String(value ?? '').slice(0, limit);
function parse(source: string): { manifest?: ApplicationManifest; error: string; bytes: number } {
  const bytes = new TextEncoder().encode(source).byteLength;
  if (!source.trim()) return { error: '', bytes };
  if (bytes > MAX_BYTES) return { error: 'Manifest exceeds the 256 KiB UTF-8 limit.', bytes };
  let value: unknown;
  try { value = JSON.parse(source); } catch { return { error: 'Manifest must contain valid JSON.', bytes }; }
  const result = applicationManifestSchema.safeParse(value);
  if (!result.success) return { error: short(result.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'Manifest'}: ${issue.message}`).join(' · ')), bytes };
  if (new TextEncoder().encode(JSON.stringify(result.data)).byteLength > MAX_BYTES) return { error: 'Normalized manifest exceeds the 256 KiB UTF-8 limit after applying component defaults.', bytes };
  return { manifest: result.data, error: '', bytes };
}
async function request<T>(path: string, signal: AbortSignal, body?: ImportBody): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (response.status === 401) window.dispatchEvent(new Event('agenticview:unauthorized'));
  const text = await response.text();
  if (text.length > 1_048_576) throw new Error('Application response exceeds the display limit.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Application request returned an invalid acknowledgement (${response.status}).`); }
  if (!response.ok) throw new Error(`Application request failed (${response.status}): ${short((value as { error?: string })?.error ?? response.statusText)}`);
  return value as T;
}
function isSummary(value: unknown): value is Summary {
  if (!value || typeof value !== 'object') return false;
  const row = value as Summary;
  return typeof row.runId === 'string' && row.runId.length <= 200 && typeof row.id === 'string' && typeof row.name === 'string' && typeof row.version === 'string' && Number.isInteger(row.components) && Number.isInteger(row.actions);
}
export function ApplicationLibrary({ report }: { report?: (message: string) => void }) {
  const [source, setSource] = useState(''), [bindings, setBindings] = useState<Record<string, string>>({});
  const [applications, setApplications] = useState<Summary[]>([]), [listLoading, setListLoading] = useState(true), [listError, setListError] = useState(''), [listPage, setListPage] = useState(0);
  const [busy, setBusy] = useState(false), [fileLoading, setFileLoading] = useState(false), [fileError, setFileError] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [imported, setImported] = useState(false);
  const alive = useRef(true), listRequest = useRef<AbortController | undefined>(undefined), importRequest = useRef<AbortController | undefined>(undefined), identity = useRef<{ payload: string; body: ImportBody } | undefined>(undefined), sourceRevision = useRef(0), reportRef = useRef(report);
  const fileTicket = useRef(0);
  reportRef.current = report;
  const preview = useMemo(() => parse(source), [source]), manifest = preview.manifest;
  const mapping = Object.fromEntries(manifest?.bindings.map(binding => [binding.id, (bindings[binding.id] ?? '').trim()]) ?? []);
  const validBindings = !!manifest && manifest.bindings.every(binding => idSchema.safeParse(mapping[binding.id]).success);
  const loadList = useCallback(async (offset = 0) => {
    listRequest.current?.abort(); const controller = new AbortController(); listRequest.current = controller;
    setListLoading(true); setListError('');
    try {
      const result = await request<unknown>(offset ? `/api/applications?offset=${offset}&limit=${PAGE_SIZE}` : '/api/applications', controller.signal);
      if (!Array.isArray(result)) throw new Error('Application list returned an invalid response.');
      if (alive.current && !controller.signal.aborted) { setApplications(result.slice(0, PAGE_SIZE).filter(isSummary)); setListPage(Math.floor(offset / PAGE_SIZE)); }
    } catch (failure) { if (alive.current && !controller.signal.aborted) setListError(short(failure instanceof Error ? failure.message : 'Application list unavailable.')); }
    finally { if (alive.current && !controller.signal.aborted) setListLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true; void loadList();
    return () => { alive.current = false; ++sourceRevision.current; ++fileTicket.current; listRequest.current?.abort(); importRequest.current?.abort(); };
  }, [loadList]);
  const editSource = (next: string) => {
    if (importRequest.current) return;
    ++sourceRevision.current; identity.current = undefined; setSource(next); setBindings({}); setImported(false); setError(''); setNotice(''); setFileError('');
  };
  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (!file || importRequest.current) return;
    const ticket = ++fileTicket.current;
    if (file.size > MAX_BYTES) { editSource(''); setFileLoading(false); setFileError('Manifest file exceeds the 256 KiB UTF-8 limit.'); return; }
    const revision = ++sourceRevision.current; setFileLoading(true); setFileError('');
    try { const text = await file.text(); if (alive.current && revision === sourceRevision.current) editSource(text); }
    catch { if (alive.current && revision === sourceRevision.current) setFileError('The manifest file could not be read.'); }
    finally { if (alive.current && ticket === fileTicket.current) setFileLoading(false); }
  };
  const importApplication = async (event: FormEvent) => {
    event.preventDefault(); if (!manifest || !validBindings || importRequest.current || fileLoading || fileError || imported) return;
    const payload = JSON.stringify({ manifest, bindings: mapping });
    if (!identity.current || identity.current.payload !== payload) identity.current = { payload, body: { manifest, bindings: mapping, requestId: crypto.randomUUID(), registrationKey: crypto.randomUUID() + crypto.randomUUID() } };
    const body = identity.current.body, controller = new AbortController(); importRequest.current = controller; setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ runId: string }>('/api/applications/import', controller.signal, body);
      if (typeof result?.runId !== 'string') throw new Error('Import acknowledgement was invalid. Retry keeps the same request.');
      if (!alive.current || controller.signal.aborted) return;
      const text = `Imported ${manifest.name}. Use Fit all to find its card.`; setNotice(text); setImported(true); reportRef.current?.(text);
      window.dispatchEvent(new Event('agenticview:applications-imported')); void loadList();
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) { const text = short(failure instanceof Error ? failure.message : 'Import acknowledgement unavailable.'); setError(`${text} Retry keeps this import request unchanged.`); }
    } finally { if (importRequest.current === controller) { importRequest.current = undefined; if (alive.current) setBusy(false); } }
  };
  const page = listPage;
  const embeds = manifest?.components.filter(component => component.kind === 'embed').length ?? 0;
  return <div className="application-library">
    <section aria-label="Import application">
      <h2>Portable applications</h2><p>Import an authored application definition from a repository or a shared JSON file. Map its logical bindings to connectors on this installation.</p>
      <label className="control-field"><span>Choose a manifest file</span><input aria-label="Application manifest file" type="file" accept=".agenticview.json,.json,application/json" disabled={busy || fileLoading} onChange={event => void chooseFile(event)} /></label>
      <form onSubmit={event => void importApplication(event)}>
        <label className="control-field"><span>Or paste its JSON</span><textarea aria-label="Application manifest JSON" rows={8} spellCheck={false} maxLength={MAX_BYTES} value={source} disabled={busy || fileLoading} onChange={event => editSource(event.target.value)} placeholder="Paste an .agenticview.json manifest" /></label>
        <p className="control-caption">{preview.bytes.toLocaleString()} / {MAX_BYTES.toLocaleString()} UTF-8 bytes</p>
        {(preview.error || fileError) && <p role="alert">{fileError || preview.error}</p>}{fileLoading && <p role="status">Reading manifest file…</p>}
        {manifest && <section className="application-preview" aria-label="Application preview">
          <strong>{manifest.name}</strong><span className="application-permanent">Permanent application</span><p>{manifest.id} · Version {manifest.version}</p>{manifest.description && <p>{manifest.description}</p>}
          <p>{manifest.components.length} components · {manifest.actions.length} actions · {manifest.bindings.length} bindings</p>
          {embeds > 0 && <p className="application-custom"><strong>Custom view</strong> · {embeds} embedded {embeds === 1 ? 'view' : 'views'}. Scripts can run when trusted embeds are enabled.</p>}
          {manifest.bindings.map(binding => <label className="control-field" key={binding.id}><span>{binding.label} <small>({binding.id})</small></span>{binding.description && <small>{binding.description}</small>}<input aria-label={`Local connector for ${binding.label}`} type="text" maxLength={100} autoComplete="off" value={bindings[binding.id] ?? ''} disabled={busy} placeholder="Local connector ID" onChange={event => { if (importRequest.current) return; identity.current = undefined; setBindings(previous => ({ ...previous, [binding.id]: event.target.value })); setImported(false); setError(''); setNotice(''); }} /></label>)}
          {manifest.bindings.length > 0 && <p className="control-caption">Binding values stay on this installation and are excluded from exported manifests.</p>}
        </section>}
        {error && <p role="alert">{error}</p>}{notice && <p className="application-success" role="status">{notice}</p>}
        <button type="submit" className="secondary" disabled={!manifest || !validBindings || busy || fileLoading || !!fileError || imported}>{busy ? 'Importing…' : imported ? 'Imported' : error && identity.current ? 'Retry import' : 'Import application'}</button>
      </form>
    </section>
    <section className="application-installed" aria-label="Installed applications">
      <div className="control-toolbar"><h3>Installed applications</h3><button type="button" className="secondary" disabled={listLoading} onClick={() => void loadList()}>Refresh applications</button></div>
      {listError && <p role="alert">{listError}</p>}{listLoading && <p role="status">Loading applications…</p>}
      {!listLoading && !applications.length && !listError && <p>{page ? 'No applications in this page.' : 'No portable applications installed.'}</p>}
      {applications.map(application => <div className="application-row" key={application.runId}><div><strong>{short(application.name, 160)}</strong><small>Version {short(application.version, 80)} · {application.components} components · {application.actions} actions</small>{application.description && <p>{short(application.description, 2000)}</p>}</div><a className="secondary" href={`/api/applications/${encodeURIComponent(application.runId)}/export`} download={`${application.id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.agenticview.json`}>Download JSON</a></div>)}
      {(page > 0 || applications.length === PAGE_SIZE) && <div className="control-toolbar"><button type="button" disabled={listLoading || page === 0} onClick={() => void loadList((page - 1) * PAGE_SIZE)}>Previous applications</button><span>Page {page + 1} · {applications.length} applications</span><button type="button" disabled={listLoading || applications.length < PAGE_SIZE} onClick={() => void loadList((page + 1) * PAGE_SIZE)}>Next applications</button></div>}
    </section>
  </div>;
}
