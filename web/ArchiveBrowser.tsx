import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, ArrowDownToLine, ArrowLeft, RotateCcw } from 'lucide-react';
import type { AgentView, ArchiveSummary } from '../shared/protocol.js';

type Request = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
const PAGE_SIZE = 25;
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
const date = (n: number) => new Date(n).toLocaleString();

/** Shared by the settings archive tab and the draggable archive card. No periodic polling. */
export function ArchiveBrowser({ count, request, report, renderContent }: { count: number; request: Request; report: (message: string) => void; renderContent: (agent: AgentView) => ReactNode }) {
  const [page, setPage] = useState(0), [revision, refresh] = useState(0), [archives, setArchives] = useState<ArchiveSummary[]>([]), [inspect, setInspect] = useState<AgentView | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const details = useRef<AbortController | null>(null), restoring = useRef(false), alive = useRef(true);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(count / PAGE_SIZE) - 1));
  useEffect(() => { alive.current = true; const update = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', update); return () => { alive.current = false; details.current?.abort(); document.removeEventListener('visibilitychange', update); }; }, []);
  useEffect(() => { if (!visible) details.current?.abort(); }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    request<ArchiveSummary[]>(`/api/archives?offset=${currentPage * PAGE_SIZE}&limit=${PAGE_SIZE}`, 'GET', undefined, controller.signal)
      .then(rows => { if (!controller.signal.aborted) { if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new Error('Archive page exceeds the display limit.'); setArchives(rows); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Archives unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [currentPage, count, revision, visible, request]);
  async function review(id: string) {
    details.current?.abort(); const controller = new AbortController(); details.current = controller; setBusy(true); setError('');
    try { const agent = await request<AgentView>(`/api/archives/${encodeURIComponent(id)}`, 'GET', undefined, controller.signal); if (!controller.signal.aborted) setInspect(agent); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Archive unavailable.'); }
    finally { if (alive.current && details.current === controller) setBusy(false); }
  }
  async function restore(id: string) {
    if (restoring.current) return;
    restoring.current = true; setBusy(true); setError('');
    try {
      await request(`/api/archives/${encodeURIComponent(id)}/restore`, 'POST', {});
      if (alive.current) { setInspect(null); setArchives(rows => rows.filter(row => row.id !== id)); refresh(n => n + 1); }
      report('Card restored for review or continuation. Use Fit all to find it on the canvas.');
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'Restore acknowledgement unavailable. Review the canvas before trying again.'); }
    finally { restoring.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="archive-browser" aria-label="Saved archived cards">
    {error && <p className="form-error" role="alert">{error}</p>}
    {inspect ? <><button className="text-button" onClick={() => setInspect(null)}><ArrowLeft size={14} /> All archived cards</button><div className="archive-heading"><div><h2>{inspect.name}</h2><small>{inspect.role} · {inspect.status === 'completed' ? 'Finished' : inspect.status} · archived copy</small></div><button className="secondary" disabled={busy} onClick={() => void restore(inspect.id)}><RotateCcw size={14} />{busy ? 'Restoring…' : 'Restore card'}</button><a className="icon-button" title="Download compressed archive" href={`/api/archives/${encodeURIComponent(inspect.id)}/export`}><ArrowDownToLine size={16} /></a></div><p className="muted">Restore this card to review it on the canvas or continue its session.</p>{renderContent(inspect)}</> : <>
      <div className="archive-browser-heading"><div><strong>{count} archived {count === 1 ? 'card' : 'cards'}</strong><p className="muted">Finished work stays available here. Restore a card to review or continue.</p></div><button className="secondary" disabled={loading || busy} onClick={() => refresh(n => n + 1)}>Refresh</button></div>
      {!visible ? <p className="muted">Paused while hidden.</p> : loading ? <p className="muted" role="status">Loading archived cards…</p> : !archives.length ? <div className="empty-section"><Archive size={24} /><h3>No archived cards</h3><p>Saved cards stay on this installation.</p></div> : archives.map(a => <div className="archive-row" key={a.id}><button disabled={busy} aria-label={`Review ${a.name}`} onClick={() => void review(a.id)}><strong>{a.name}</strong><small>{a.role} · {a.status === 'completed' ? 'Finished' : a.status} · {date(a.archivedAt)}</small><span>{bytes(a.bytes)} gzip{a.completedAt !== undefined && <span className="muted"> · completed {date(a.completedAt)}</span>}</span></button><button className="secondary archive-restore" disabled={busy} aria-label={`Restore ${a.name}`} onClick={() => void restore(a.id)}><RotateCcw size={14} /> Restore</button><a className="icon-button" title={`Download ${a.name}`} href={`/api/archives/${encodeURIComponent(a.id)}/export`}><ArrowDownToLine size={15} /></a></div>)}
      <nav className="pagination" aria-label="Archive pages"><span>{count ? `${currentPage * PAGE_SIZE + 1}–${Math.min(count, (currentPage + 1) * PAGE_SIZE)} of ${count}` : '0 cards'}</span><button disabled={loading || busy || !currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><button disabled={loading || busy || (currentPage + 1) * PAGE_SIZE >= count} onClick={() => setPage(currentPage + 1)}>Next</button></nav>
    </>}
  </section>;
}
