import { useEffect, useRef, useState } from 'react';
import { Check, Minus, Plus, RotateCcw } from 'lucide-react';
import { contentPoint } from '../shared/interaction.js';
import { TouchViewport, zoomAt, type Camera } from '../shared/viewport.js';

const initial: Camera = { x: 0, y: 0, zoom: 1 };
export function CardSurface({ id, active, deactivate, canvasOwnsPointer, forceCanvas, store, children }: {
  id: string; active: boolean; deactivate: () => void; canvasOwnsPointer: (id: number) => boolean; forceCanvas: () => boolean; store?: Map<string, Camera>; children: React.ReactNode;
}) {
  const [camera, setCamera] = useState<Camera>(() => store?.get(id) ?? initial), element = useRef<HTMLDivElement>(null), current = useRef(camera), enabled = useRef(active);
  const touch = useRef(new TouchViewport(.25, 4)), drag = useRef<{ pointer: number; x: number; y: number; camera: Camera } | null>(null);
  current.current = camera; enabled.current = active;
  function apply(next: Camera) { current.current = next; store?.set(id, next); setCamera(next); }
  function point(x: number, y: number) { const body = element.current!; return contentPoint({ x, y }, body.getBoundingClientRect(), body.offsetWidth); }
  function zoom(factor: number) { const body = element.current; if (body) apply(zoomAt(current.current, factor, { x: body.clientWidth / 2, y: body.clientHeight / 2 }, .25, 4)); }
  useEffect(() => {
    const body = element.current; if (!body) return;
    const clear = () => { touch.current.clear(); drag.current = null; };
    const wheel = (event: WheelEvent) => {
      if (!enabled.current || forceCanvas() || event.altKey) return;
      event.preventDefault(); event.stopPropagation();
      const scale = body.getBoundingClientRect().width / body.offsetWidth;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? body.clientHeight : 1);
      if (event.ctrlKey || event.metaKey) apply(zoomAt(current.current, Math.exp(Math.max(-4, Math.min(4, -delta * .0015))), point(event.clientX, event.clientY), .25, 4));
      else apply({ ...current.current, x: current.current.x - (event.shiftKey ? delta + event.deltaX : event.deltaX) / scale, y: current.current.y - (event.shiftKey ? 0 : delta) / scale });
    };
    body.addEventListener('wheel', wheel, { passive: false }); window.addEventListener('agenticview:canvas-navigation', clear); window.addEventListener('blur', clear);
    return () => { body.removeEventListener('wheel', wheel); window.removeEventListener('agenticview:canvas-navigation', clear); window.removeEventListener('blur', clear); clear(); };
  }, []);
  useEffect(() => { if (!active) { touch.current.clear(); drag.current = null; } }, [active]);
  function down(event: React.PointerEvent<HTMLDivElement>) {
    if (!active || forceCanvas() || event.altKey || canvasOwnsPointer(event.pointerId) || (event.target as Element).closest('.card-local-controls,button,a,input,textarea,select,[contenteditable=true]')) return;
    const p = point(event.clientX, event.clientY);
    if (event.pointerType === 'touch') touch.current.start(event.pointerId, p, current.current);
    else if (event.button !== 0 || event.shiftKey) return;
    event.stopPropagation();
    if (event.pointerType === 'touch') event.preventDefault();
    drag.current = { pointer: event.pointerId, ...p, camera: { ...current.current } };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (!active || canvasOwnsPointer(event.pointerId)) return;
    const p = point(event.clientX, event.clientY);
    if (event.pointerType === 'touch' && touch.current.pointers.has(event.pointerId)) {
      const pinched = touch.current.move(event.pointerId, p); if (pinched) { event.preventDefault(); event.stopPropagation(); apply({ ...pinched, zoom: Math.max(.25, Math.min(4, pinched.zoom)) }); return; }
    }
    const start = drag.current; if (!start || start.pointer !== event.pointerId) return;
    const dx = p.x - start.x, dy = p.y - start.y;
    if (Math.hypot(dx, dy) < 4) return;
    event.preventDefault(); event.stopPropagation(); apply({ ...start.camera, x: start.camera.x + dx, y: start.camera.y + dy });
  }
  function up(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch') touch.current.end(event.pointerId, current.current);
    drag.current = null;
    const remaining = [...touch.current.pointers.entries()];
    if (remaining.length === 1) drag.current = { pointer: remaining[0]![0], ...remaining[0]![1], camera: { ...current.current } };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <div ref={element} className={`card-body card-surface ${active ? 'card-active' : ''}`} data-card-surface={id} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    {active ? <div className="card-local-controls" role="toolbar" aria-label="Active card navigation"><span>Card</span><button title="Zoom card out" aria-label="Zoom card out" onClick={() => zoom(1 / 1.2)}><Minus size={12} /></button><span>{Math.round(camera.zoom * 100)}%</span><button title="Zoom card in" aria-label="Zoom card in" onClick={() => zoom(1.2)}><Plus size={12} /></button><button title="Reset card view" aria-label="Reset card view" onClick={() => apply(initial)}><RotateCcw size={12} /></button><button title="Return to canvas navigation (Escape)" aria-label="Deactivate card" onClick={deactivate}><Check size={13} /></button></div> : <span className="card-activation-hint">Click or tap to interact</span>}
    <div className="card-content-plane" inert={!active} style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`, transformOrigin: '0 0' }}>{children}</div>
  </div>;
}
