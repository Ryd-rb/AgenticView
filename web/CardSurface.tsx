import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Minus, Plus, RotateCcw } from 'lucide-react';
import { ContentNavigation, clampContentCamera, contentPoint, minimumContentZoom } from '../shared/interaction.js';
import { TouchViewport, zoomAt, type Camera } from '../shared/viewport.js';

const initial: Camera = { x: 0, y: 0, zoom: 1 };
export function CardSurface({ id, active, deactivate, canvasOwnsPointer, forceCanvas, store, children }: {
  id: string; active: boolean; deactivate: () => void; canvasOwnsPointer: (id: number) => boolean; forceCanvas: () => boolean; store?: Map<string, Camera>; children: React.ReactNode;
}) {
  const [camera, setCamera] = useState<Camera>(() => store?.get(id) ?? initial), [extent, setExtent] = useState({ width: 0, height: 0 });
  const [commitRevision, setCommitRevision] = useState(0);
  const element = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null), plane = useRef<HTMLDivElement>(null), current = useRef(camera), enabled = useRef(active);
  const navigation = useRef(new ContentNavigation(camera));
  const touch = useRef(new TouchViewport(1, 4)), drag = useRef<{ pointer: number; x: number; y: number; camera: Camera } | null>(null);
  enabled.current = active;
  function geometry() {
    const viewport = scroller.current!, content = plane.current!;
    return { view: { width: Math.max(1, viewport.clientWidth), height: Math.max(1, viewport.clientHeight) }, content: { width: Math.max(1, content.scrollWidth), height: Math.max(1, content.scrollHeight) } };
  }
  function apply(next: Camera) {
    if (scroller.current && plane.current) { const bounds = geometry(); next = clampContentCamera(next, bounds.view, bounds.content); }
    if (next.x === current.current.x && next.y === current.current.y && next.zoom === current.current.zoom) return;
    const renderScale = navigation.current.request(next); current.current = next; store?.set(id, next);
    if (renderScale) { setCamera(next); setCommitRevision(navigation.current.revision); }
    else if (!navigation.current.pending && scroller.current) { scroller.current.scrollLeft = -next.x; scroller.current.scrollTop = -next.y; navigation.current.scrolled(scroller.current.scrollLeft, scroller.current.scrollTop); current.current = navigation.current.camera; store?.set(id, current.current); }
  }
  function point(x: number, y: number) { const body = scroller.current!; return contentPoint({ x, y }, body.getBoundingClientRect(), body.offsetWidth); }
  function zoom(factor: number, anchor?: { x: number; y: number }) {
    if (!scroller.current || !plane.current) return;
    const bounds = geometry(); apply(zoomAt(current.current, factor, anchor ?? { x: bounds.view.width / 2, y: bounds.view.height / 2 }, minimumContentZoom(bounds.view, bounds.content), 4));
  }
  useLayoutEffect(() => {
    const viewport = scroller.current!, content = plane.current!;
    const measure = () => { const width = viewport.clientWidth + 'px'; if (content.style.width !== width) content.style.width = width; const bounds = geometry(); setExtent(old => old.width === bounds.content.width && old.height === bounds.content.height ? old : bounds.content); apply(current.current); };
    const observer = new ResizeObserver(measure); observer.observe(viewport); observer.observe(content); measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { const viewport = scroller.current; if (viewport) { const target = navigation.current.pending ?? current.current; viewport.scrollLeft = -target.x; viewport.scrollTop = -target.y; navigation.current.committed(viewport.scrollLeft, viewport.scrollTop); current.current = navigation.current.camera; store?.set(id, current.current); } }, [commitRevision, extent]);
  useEffect(() => {
    const body = element.current; if (!body) return;
    const clear = () => { touch.current.clear(); drag.current = null; };
    const wheel = (event: WheelEvent) => {
      if (!enabled.current || forceCanvas() || event.altKey) return;
      event.preventDefault(); event.stopPropagation();
      const viewport = scroller.current!, scale = viewport.getBoundingClientRect().width / viewport.offsetWidth;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      if (event.ctrlKey || event.metaKey) zoom(Math.exp(Math.max(-4, Math.min(4, -delta * .0015))), point(event.clientX, event.clientY));
      else apply({ ...current.current, x: current.current.x - (event.shiftKey ? delta + event.deltaX : event.deltaX) / scale, y: current.current.y - (event.shiftKey ? 0 : delta) / scale });
    };
    body.addEventListener('wheel', wheel, { passive: false }); window.addEventListener('agenticview:canvas-navigation', clear); window.addEventListener('blur', clear);
    return () => { body.removeEventListener('wheel', wheel); window.removeEventListener('agenticview:canvas-navigation', clear); window.removeEventListener('blur', clear); clear(); };
  }, []);
  useEffect(() => { if (!active) { touch.current.clear(); drag.current = null; } }, [active]);
  function down(event: React.PointerEvent<HTMLDivElement>) {
    if (!active || forceCanvas() || event.altKey || canvasOwnsPointer(event.pointerId) || (event.target as Element).closest('.card-local-controls,button,a,input,textarea,select,[contenteditable=true]')) return;
    const viewport = scroller.current!, bounds = viewport.getBoundingClientRect(), scale = bounds.width / viewport.offsetWidth;
    if (event.clientX >= bounds.left + viewport.clientWidth * scale || event.clientY >= bounds.top + viewport.clientHeight * scale) return;
    const p = point(event.clientX, event.clientY);
    if (event.pointerType === 'touch') { if (!touch.current.count) { const bounds = geometry(); touch.current = new TouchViewport(minimumContentZoom(bounds.view, bounds.content), 4); } touch.current.start(event.pointerId, p, current.current); }
    else if (event.button !== 0 || event.shiftKey) return;
    event.stopPropagation(); if (event.pointerType === 'touch') event.preventDefault();
    drag.current = { pointer: event.pointerId, ...p, camera: { ...current.current } }; event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (!active || canvasOwnsPointer(event.pointerId)) return;
    const p = point(event.clientX, event.clientY);
    if (event.pointerType === 'touch' && touch.current.pointers.has(event.pointerId)) { const pinched = touch.current.move(event.pointerId, p); if (pinched) { event.preventDefault(); event.stopPropagation(); apply(pinched); return; } }
    const start = drag.current; if (!start || start.pointer !== event.pointerId) return;
    const dx = p.x - start.x, dy = p.y - start.y; if (Math.hypot(dx, dy) < 4) return;
    event.preventDefault(); event.stopPropagation(); apply({ ...start.camera, x: start.camera.x + dx, y: start.camera.y + dy });
  }
  function up(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch') touch.current.end(event.pointerId, current.current); drag.current = null;
    const remaining = [...touch.current.pointers.entries()]; if (remaining.length === 1) drag.current = { pointer: remaining[0]![0], ...remaining[0]![1], camera: { ...current.current } };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <div ref={element} className={['card-body card-surface', active ? 'card-active' : ''].join(' ')} data-card-surface={id} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    {active ? <div className="card-local-controls" role="toolbar" aria-label="Active card navigation"><span>Card</span><button title="Zoom card out" aria-label="Zoom card out" onClick={() => zoom(1 / 1.2)}><Minus size={12} /></button><span>{Math.round(camera.zoom * 100)}%</span><button title="Zoom card in" aria-label="Zoom card in" onClick={() => zoom(1.2)}><Plus size={12} /></button><button title="Reset card view" aria-label="Reset card view" onClick={() => apply(initial)}><RotateCcw size={12} /></button><button title="Return to canvas navigation (Escape)" aria-label="Deactivate card" onClick={deactivate}><Check size={13} /></button></div> : <span className="card-activation-hint">Click or tap to interact</span>}
    <div ref={scroller} className="card-content-scroll" inert={!active} tabIndex={active ? 0 : -1} onScroll={() => { if (!enabled.current || !scroller.current) return; if (navigation.current.scrolled(scroller.current.scrollLeft, scroller.current.scrollTop)) { current.current = navigation.current.camera; store?.set(id, current.current); } }}>
      <div className="card-scroll-extent" style={{ width: extent.width * camera.zoom || undefined, height: extent.height * camera.zoom || undefined }}>
        <div ref={plane} className="card-content-plane" inert={!active} style={{ transform: 'scale(' + camera.zoom + ')', transformOrigin: '0 0' }}>{children}</div>
      </div>
    </div>
  </div>;
}
