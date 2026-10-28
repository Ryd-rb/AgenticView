type TracePhase = 'pointer' | 'down' | 'move' | 'route' | 'clear' | 'navigation' | 'blur' | 'inactive' | 'unmount';
type TraceWindow = Window & { agenticViewInputTraceUntil?: number; chrome?: { webview?: { postMessage: (value: unknown) => void } } };
let sent = 0;

/** Temporary, bounded native diagnostics: numbers and fixed labels, never panel contents. */
export function traceInput(phase: TracePhase, values: number[]) {
  if (typeof window === 'undefined') return;
  const host = window as TraceWindow;
  if (!host.agenticViewInputTraceUntil || Date.now() > host.agenticViewInputTraceUntil || sent >= 4096) return;
  sent++;
  host.chrome?.webview?.postMessage({ type: 'agenticview:input-trace', phase, values: values.slice(0, 32).map(value => Number.isFinite(value) ? value : 0) });
}

export function inputRegion(target: EventTarget | null): number {
  if (!(target instanceof Element)) return 0;
  const region = target.closest('.logs,.table-scroll,pre,.child-body,.settings-content');
  return region?.matches('.logs') ? 1 : region?.matches('.table-scroll') ? 2 : region?.matches('pre') ? 3 : region?.matches('.child-body') ? 4 : region?.matches('.settings-content') ? 5 : 0;
}

export function installInputTrace() {
  const host = window as TraceWindow; if (!host.agenticViewInputTraceUntil) return;
  const kinds = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'];
  const receive = (event: Event) => { const p = event as PointerEvent; if (event.type === 'pointermove' && p.pointerType !== 'touch' && p.buttons === 0) return; const region = inputRegion(p.target); queueMicrotask(() => traceInput('pointer', [kinds.indexOf(event.type), p.pointerId, p.clientX, p.clientY, p.buttons, p.pointerType === 'touch' ? 1 : 0, Number(p.defaultPrevented), region])); };
  for (const kind of kinds) window.addEventListener(kind, receive, true);
  return () => { for (const kind of kinds) window.removeEventListener(kind, receive, true); };
}
