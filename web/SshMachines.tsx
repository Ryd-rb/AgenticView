import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { idSchema } from '../shared/protocol.js';

type Credential = { id: string; label: string; username: string; version: string; updatedAt: number };
type Machine = { id: string; label: string; host: string; port: number; connectorId: string; authentication: 'password' | 'agent'; credentialId: string; credentialLabel: string; credentialVersion: string; username: string; valid: boolean; message?: string; updatedAt: number };
type Catalog = { machines: Machine[]; credentials: Credential[] };
type Form = { id: string; label: string; host: string; port: string; connectorId: string; mode: 'reuse' | 'new' | 'agent'; credentialId: string; credentialLabel: string; username: string; password: string };
const blank = (credentialId = ''): Form => ({ id: `machine-${crypto.randomUUID()}`, label: '', host: '', port: '22', connectorId: '', mode: credentialId ? 'reuse' : 'new', credentialId, credentialLabel: '', username: '', password: '' });
const short = (value: unknown, limit = 2000) => String(value ?? '').slice(0, limit);
class RequestFailure extends Error { constructor(status: number) { super(status === 401 ? 'Sign in to manage SSH machines.' : `SSH settings request failed (${status}).`); } }
async function request(path: string, signal: AbortSignal, method = 'GET', body?: object): Promise<unknown> {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (response.status === 401) window.dispatchEvent(new Event('agenticview:unauthorized'));
  // Error bodies can echo private request data. Never display, report or persist them.
  if (!response.ok) { await response.body?.cancel(); throw new RequestFailure(response.status); }
  if (method !== 'GET') { try { await response.body?.cancel(); } catch { /* Known 2xx is authoritative even if its unused body disconnects. */ } return; }
  const text = await response.text(); if (text.length > 4_194_304) throw new Error('Response bound exceeded.');
  return JSON.parse(text);
}
function catalog(value: unknown): Catalog {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Catalog).machines) || !Array.isArray((value as Catalog).credentials)) throw new Error('Invalid catalog.');
  const source = value as Catalog;
  // Keep only public metadata even if a malformed response includes additional properties.
  const credentials = source.credentials.slice(0, 256).filter(row => row && typeof row.id === 'string' && typeof row.username === 'string' && typeof row.label === 'string').map(row => ({ id: short(row.id, 100), label: short(row.label, 160), username: short(row.username, 256), version: short(row.version, 100), updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0 }));
  const machines: Machine[] = source.machines.slice(0, 256).filter(row => row && typeof row.id === 'string' && typeof row.host === 'string' && typeof row.label === 'string').map(row => ({ id: short(row.id, 100), label: short(row.label, 160), host: short(row.host, 253), port: row.port, connectorId: short(row.connectorId, 100), authentication: row.authentication === 'agent' ? 'agent' : 'password', credentialId: short(row.credentialId, 100), credentialLabel: short(row.credentialLabel, 160), credentialVersion: short(row.credentialVersion, 100), username: short(row.username, 256), valid: row.valid === true, message: row.message ? short(row.message) : undefined, updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0 }));
  return { machines, credentials };
}
function fromMachine(machine: Machine, credentials: Credential[]): Form {
  const reusable = machine.valid && credentials.some(credential => credential.id === machine.credentialId);
  return { id: machine.id, label: machine.label, host: machine.host, port: String(machine.port), connectorId: machine.connectorId, mode: machine.authentication === 'agent' ? 'agent' : reusable ? 'reuse' : 'new', credentialId: machine.credentialId, credentialLabel: machine.credentialLabel, username: machine.username, password: '' };
}
function validate(form: Form) {
  if (!idSchema.safeParse(form.id).success || !idSchema.safeParse(form.connectorId).success) return 'Enter valid machine and connector IDs using letters, digits, periods, colons, underscores or dashes.';
  if (!form.label.trim()) return 'Enter a machine label.';
  if (!/^[A-Za-z0-9_.:\[\]-]+$/.test(form.host) || form.host.startsWith('-')) return 'Enter a host, address or private SSH alias without a username, options or shell syntax.';
  const port = Number(form.port); if (!Number.isInteger(port) || port < 1 || port > 65535) return 'SSH port must be between 1 and 65535.';
  if (form.mode === 'reuse') return form.credentialId ? '' : 'Choose a saved account.';
  if ((form.mode !== 'agent' || form.username) && (!form.username || form.username.startsWith('-') || /[\x00-\x1f\x7f-\x9f]/.test(form.username))) return 'Enter a valid SSH username without control characters or a leading dash.';
  if (form.mode === 'agent') return '';
  if (!form.password || form.password.length > 8192 || /[\r\n\0]/.test(form.password)) return 'Enter a password of at most 8,192 characters without line breaks.';
  return '';
}
export function SshMachines({ report }: { report: (message: string) => void }) {
  const [data, setData] = useState<Catalog>({ machines: [], credentials: [] }), [form, setForm] = useState<Form>(() => blank()), [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [forget, setForget] = useState<Credential>();
  const alive = useRef(true), dirty = useRef(false), formRef = useRef(form), selectedRef = useRef(selected), previousCredential = useRef(''), pending = useRef<AbortController | undefined>(undefined), listing = useRef<AbortController | undefined>(undefined), reportRef = useRef(report);
  formRef.current = form; selectedRef.current = selected; reportRef.current = report;
  const load = useCallback(async () => {
    listing.current?.abort(); const controller = new AbortController(); listing.current = controller; setLoading(true);
    try {
      const next = catalog(await request('/api/ssh/machines', controller.signal));
      if (!alive.current || controller.signal.aborted) return;
      setData(next);
      if (!dirty.current) {
        const existing = next.machines.find(machine => machine.id === selectedRef.current);
        if (existing) setForm(fromMachine(existing, next.credentials));
        else if (!selectedRef.current) {
          if (formRef.current.mode === 'agent') { setForm(current => ({ ...current, password: '' })); return; }
          const recent = next.credentials.find(credential => credential.id === previousCredential.current) ?? [...next.credentials].sort((a, b) => b.updatedAt - a.updatedAt)[0];
          if (recent) { previousCredential.current = recent.id; setForm(current => ({ ...current, mode: 'reuse', credentialId: recent.id, password: '' })); }
          else setForm(current => ({ ...current, mode: 'new', credentialId: '', password: '' }));
        }
      }
    } catch (failure) { if (alive.current && !controller.signal.aborted) setError(failure instanceof RequestFailure ? failure.message : 'SSH machine settings are unavailable. Refresh to try again.'); }
    finally { if (alive.current && !controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; listing.current?.abort(); pending.current?.abort(); }; }, [load]);
  const edit = (part: Partial<Form>) => { if (pending.current) return; dirty.current = true; setForm(current => ({ ...current, ...part })); setError(''); setNotice(''); };
  const choose = (id: string) => {
    if (pending.current) return;
    dirty.current = false; setSelected(id); selectedRef.current = id; setError(''); setNotice(''); setForget(undefined);
    const machine = data.machines.find(value => value.id === id);
    if (machine) { previousCredential.current = machine.credentialId; setForm(fromMachine(machine, data.credentials)); }
    else { const account = data.credentials.find(value => value.id === (formRef.current.credentialId || previousCredential.current)) ?? [...data.credentials].sort((a, b) => b.updatedAt - a.updatedAt)[0]; setForm(formRef.current.mode === 'agent' ? { ...blank(), mode: 'agent', username: formRef.current.username } : blank(account?.id)); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (pending.current) return;
    const issue = validate(form); if (issue) { setError(issue); return; }
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError(''); setNotice('');
    const base = { id: form.id, label: form.label.trim(), host: form.host, port: Number(form.port), connectorId: form.connectorId };
    const body = form.mode === 'agent' ? { ...base, authentication: 'agent', ...(form.username ? { username: form.username } : {}) } : form.mode === 'reuse' ? { ...base, credentialId: form.credentialId } : { ...base, username: form.username, password: form.password, credentialLabel: form.credentialLabel.trim() };
    try {
      await request('/api/ssh/machines', controller.signal, 'PUT', body);
      if (!alive.current || controller.signal.aborted) return;
      dirty.current = false; setForm(current => ({ ...current, password: '' })); setSelected(form.id); selectedRef.current = form.id;
      const text = `Saved ${base.label}.`; setNotice(text); reportRef.current(text); void load();
    } catch (failure) { if (alive.current && !controller.signal.aborted) setError(failure instanceof RequestFailure ? failure.message : 'Save acknowledgement unavailable. Refresh machines before trying again.'); }
    finally { if (pending.current === controller) { pending.current = undefined; if (alive.current) setBusy(false); } }
  };
  const remove = async () => {
    if (!forget || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try {
      await request(`/api/ssh/credentials/${encodeURIComponent(forget.id)}`, controller.signal, 'DELETE');
      if (!alive.current || controller.signal.aborted) return;
      dirty.current = false; setForm(current => ({ ...current, password: '', mode: 'new', credentialId: current.credentialId === forget.id ? '' : current.credentialId })); setForget(undefined);
      setNotice('Saved account forgotten. Bound machines require replacement credentials.'); reportRef.current('Saved SSH account forgotten.'); void load();
    } catch (failure) { if (alive.current && !controller.signal.aborted) setError(failure instanceof RequestFailure ? failure.message : 'Account removal could not be confirmed. Refresh before trying again.'); }
    finally { if (pending.current === controller) { pending.current = undefined; if (alive.current) setBusy(false); } }
  };
  const machine = data.machines.find(value => value.id === selected), account = data.credentials.find(value => value.id === form.credentialId);
  return <div className="control-view ssh-machines">
    <div className="control-toolbar"><h2>SSH machines</h2><button type="button" disabled={loading || busy} onClick={() => { setError(''); void load(); }}>Refresh machines</button><button type="button" disabled={busy} onClick={() => choose('')}>New machine</button></div>
    <p>Reuse a saved account across machines, or enter a new password. Saved accounts have no scheduled expiry. An authentication rejection prompts for replacement; transport failures keep the saved credentials.</p>
    {loading && <p role="status">Loading SSH machine settings…</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <label className="control-field"><span>Saved machine</span><select aria-label="Saved machine" value={selected} disabled={busy} onChange={event => choose(event.target.value)}><option value="">New machine</option>{data.machines.map(value => <option value={value.id} key={value.id}>{value.label} · {value.host}{value.valid ? '' : ' · credentials required'}</option>)}</select></label>
    {machine && !machine.valid && <section className="control-review" aria-label="Machine credentials required"><strong>Credentials required for {machine.label}</strong><p>{machine.message ?? 'Choose a saved account or enter replacement credentials.'}</p><button type="button" disabled={busy} onClick={() => edit({ mode: 'new', password: '', username: machine.username, credentialLabel: machine.credentialLabel })}>Enter replacement credentials</button></section>}
    <form onSubmit={event => void save(event)} aria-label="SSH machine editor"><div className="control-actions">
      <label className="control-field"><span>Machine ID</span><input aria-label="Machine ID" maxLength={100} value={form.id} disabled={busy || !!selected} required onChange={event => edit({ id: event.target.value })} /></label>
      <label className="control-field"><span>Machine label</span><input aria-label="Machine label" maxLength={160} value={form.label} disabled={busy} required onChange={event => edit({ label: event.target.value })} /></label>
      <label className="control-field"><span>Host or private SSH alias</span><input aria-label="SSH host" maxLength={253} value={form.host} disabled={busy} required autoComplete="off" onChange={event => edit({ host: event.target.value })} /></label>
      <label className="control-field"><span>SSH port</span><input aria-label="SSH port" type="number" min={1} max={65535} value={form.port} disabled={busy} required onChange={event => edit({ port: event.target.value })} /></label>
      <label className="control-field"><span>Local connector ID</span><input aria-label="SSH connector ID" maxLength={100} value={form.connectorId} disabled={busy} required onChange={event => edit({ connectorId: event.target.value })} /></label>
    </div>
      <label className="control-field"><span>Account source</span><select aria-label="SSH account source" value={form.mode} disabled={busy} onChange={event => { const mode = event.target.value as Form['mode']; edit({ mode, password: '', credentialId: form.credentialId || data.credentials[0]?.id || '' }); }}><option value="reuse" disabled={data.credentials.length === 0}>Reuse saved account</option><option value="new">Enter new password</option><option value="agent">Use existing SSH agent/config</option></select></label>
      {form.mode === 'reuse' ? <><label className="control-field"><span>Saved account</span><select aria-label="Saved SSH account" value={form.credentialId} disabled={busy} required onChange={event => { previousCredential.current = event.target.value; edit({ credentialId: event.target.value, password: '' }); }}><option value="">Choose an account…</option>{data.credentials.map(value => <option value={value.id} key={value.id}>{value.label} · {value.username}</option>)}</select></label>{account && <p className="control-caption">Username: {account.username} · saved account version {account.version}</p>}</> : form.mode === 'agent' ? <><label className="control-field"><span>Username (optional)</span><input aria-label="SSH username" maxLength={256} autoComplete="off" value={form.username} disabled={busy} onChange={event => edit({ username: event.target.value })} /></label><p className="control-caption">Uses the SSH agent and private SSH configuration on the connector. No password is saved for this machine.</p></> : <>
        <label className="control-field"><span>Account label</span><input aria-label="SSH account label" maxLength={160} value={form.credentialLabel} disabled={busy} onChange={event => edit({ credentialLabel: event.target.value })} /></label>
        <label className="control-field"><span>Username</span><input aria-label="SSH username" maxLength={256} autoComplete="off" value={form.username} disabled={busy} required onChange={event => edit({ username: event.target.value })} /></label>
        <label className="control-field"><span>Password</span><input aria-label="SSH password" type="password" maxLength={8192} autoComplete="off" value={form.password} disabled={busy} required onChange={event => edit({ password: event.target.value })} /></label><p className="control-caption">The password is encrypted on this installation. It is never included in machine/account listings.</p>
      </>}
      <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save machine'}</button>
    </form>
    <section aria-label="Saved SSH accounts"><h3>Saved accounts</h3>{data.credentials.length === 0 && <p>No saved accounts.</p>}{data.credentials.map(value => <div className="control-toolbar" key={value.id}><span>{value.label} · {value.username}</span><button type="button" disabled={busy} aria-label={`Forget account ${value.label}`} onClick={() => setForget(value)}>Forget</button></div>)}</section>
    {forget && <section className="control-review" aria-label="Confirm forget SSH account"><strong>Forget {forget.label}?</strong><p>{data.machines.filter(value => value.credentialId === forget.id).length} bound machines will require replacement credentials.</p><div className="control-toolbar"><button type="button" disabled={busy} onClick={() => setForget(undefined)}>Cancel</button><button type="button" disabled={busy} onClick={() => void remove()}>Confirm forget account</button></div></section>}
  </div>;
}
