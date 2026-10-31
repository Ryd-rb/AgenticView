import { control, type ControlMap } from '../shared/control-presentation.js';
import { ControlContent, controlStyle } from './ControlPresentation.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Minus, Plus, RotateCcw } from 'lucide-react';
import { ContentNavigation, clampContentCamera, contentPoint, minimumContentZoom, projectContentBounds } from '../shared/interaction.js';
import { TouchViewport, zoomAt, type Camera } from '../shared/viewport.js';
import { CardInteraction } from './CardInteraction.js';
import {useRenderActivity} from './RenderActivity.js';
import { scrollAncestors, scrollThrough } from './scrollChain.js';
import { ScrollJourney, revealScrollDelta, type ScrollStage } from '../shared/scroll-journey.js';
import { inputRegion, traceInput } from './InputTrace.js';

const initial: Camera = { x: 0, y: 0, zoom: 1 };
let nextTraceSurface = 0;
export function CardSurface({ chrome, id, active, deactivate, canvasOwnsPointer, forceCanvas, panPastEdge, zoomBeforeCard, zoomPastCard, canvasCamera, getCanvasCamera, getCanvasBounds, onInteractionChange, store, children }: {
  chrome?: ControlMap; id: string; active: boolean; deactivate: () => void; canvasOwnsPointer: (id: number) => boolean; forceCanvas: () => boolean;
  panPastEdge?: (x: number, y: number) => void; zoomBeforeCard?: (factor: number, anchor: { x: number; y: number }) => number; zoomPastCard?: (factor: number, anchor: { x: number; y: number }) => void;
  canvasCamera?: Camera; getCanvasCamera?: () => Camera;
  getCanvasBounds?: () => { left: number; top: number; width: number; height: number };
  onInteractionChange?: (active: boolean) => void;
  store?: Map<string, Camera>; children: React.ReactNode;
}) {
  const renderActive=useRenderActivity();
  const [camera, setCamera] = useState<Camera>(() => store?.get(id) ?? initial), [extent, setExtent] = useState({ width: 0, height: 0 });
  const [commitRevision, setCommitRevision] = useState(0);
  const element = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null), plane = useRef<HTMLDivElement>(null), current = useRef(camera), enabled = useRef(active);
  const navigation = useRef(new ContentNavigation(camera));
  const traceSurface = useRef(0); if (!traceSurface.current) traceSurface.current = ++nextTraceSurface;
  type Drag = { pointer: number; x: number; y: number; position: { x: number; y: number }; origin: { x: number; y: number }; regions: HTMLElement[]; journey: ScrollJourney; moved: boolean; editable: boolean; worldDebt: {x:number;y:number}; canvasAxes: {x:boolean;y:boolean} };
  const touch = useRef(new TouchViewport(1e-9, 1e9)), drag = useRef<Drag | null>(null), contacts = useRef(new Map<number, Drag>());
  const captured = useRef(new Set<number>()), suppressClickUntil = useRef(0);
  const callbacks = useRef({ panPastEdge, zoomBeforeCard, zoomPastCard, getCanvasCamera, getCanvasBounds, onInteractionChange }); callbacks.current = { panPastEdge, zoomBeforeCard, zoomPastCard, getCanvasCamera, getCanvasBounds, onInteractionChange };
  const interacting = useRef(false);
  const renderedCanvas = useRef(canvasCamera ?? initial), renderedZoom = useRef(camera.zoom), anchorCommit = useRef(false);
  const scrollJourney = useRef<{ regions: HTMLElement[]; journey: ScrollJourney } | null>(null);
  enabled.current = active;
  useLayoutEffect(() => { renderedCanvas.current = canvasCamera ?? initial; renderedZoom.current = camera.zoom; });
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
  function frame() { const body = scroller.current!, bounds = body.getBoundingClientRect(), currentCanvas = callbacks.current.getCanvasCamera?.(); return currentCanvas ? projectContentBounds(bounds, renderedCanvas.current, currentCanvas) : bounds; }
  function point(x: number, y: number) { const body = scroller.current!; return contentPoint({ x, y }, frame(), body.offsetWidth); }
  function visibleFrame(node: HTMLElement) {
    const viewport = scroller.current!, outer = frame(), outerScale = outer.width / viewport.offsetWidth;
    if (node === viewport) return { left: outer.left + viewport.clientLeft * outerScale, top: outer.top + viewport.clientTop * outerScale, width: viewport.clientWidth * outerScale, height: viewport.clientHeight * outerScale };
    const body = viewport.getBoundingClientRect(), rect = node.getBoundingClientRect(), renderedScale = body.width / viewport.offsetWidth;
    const localScale = current.current.zoom / renderedZoom.current, nodeScale = rect.width / node.offsetWidth * outerScale / renderedScale * localScale;
    return { left: outer.left + outerScale * (current.current.x + ((rect.left - body.left) / renderedScale + viewport.scrollLeft) * localScale) + node.clientLeft * nodeScale,
      top: outer.top + outerScale * (current.current.y + ((rect.top - body.top) / renderedScale + viewport.scrollTop) * localScale) + node.clientTop * nodeScale,
      width: node.clientWidth * nodeScale, height: node.clientHeight * nodeScale };
  }
  function panWorld(x:number,y:number) {
    const owner=drag.current;
    if(owner&&touch.current.count<2){owner.worldDebt.x+=x;owner.worldDebt.y+=y;}
    callbacks.current.panPastEdge?.(x,y);
  }
  function makeJourney(regions: HTMLElement[]) {
    const stages: ScrollStage[] = [...regions.map(region => (x: number, y: number) => {
      if (!region.isConnected) return { x, y };
      const zoom = current.current.zoom, remaining = scrollThrough([region], x / zoom, y / zoom);
      return { x: remaining.x * zoom, y: remaining.y * zoom };
    }), (x, y) => {
      const before = current.current; apply({ ...before, x: before.x - x, y: before.y - y });
      return { x: x - (before.x - current.current.x), y: y - (before.y - current.current.y) };
    }, (x, y) => {
      if (!callbacks.current.panPastEdge) return { x, y };
      const scale = frame().width / scroller.current!.offsetWidth;
      panWorld(x * scale, y * scale); return { x: 0, y: 0 };
    }];
    const reveal: (ScrollStage | undefined)[] = stages.map((_, i) => i === 0 ? undefined : (x, y) => {
      const viewport = scroller.current!, child = regions[i - 1] ?? viewport, parent = regions[i] ?? viewport;
      if (!child.isConnected || child.offsetWidth <= 0 || parent.offsetWidth <= 0) return { x: 0, y: 0 };
      const clip = i === stages.length - 1 ? callbacks.current.getCanvasBounds?.() : visibleFrame(parent);
      // The shell supplies the canvas viewport; standalone surfaces retain debt-based recovery.
      if (!clip) return { x: 0, y: 0 };
      return revealScrollDelta(visibleFrame(child), clip, x, y, frame().width / viewport.offsetWidth);
    });
    if (!callbacks.current.getCanvasBounds) reveal[stages.length - 1] = undefined;
    return new ScrollJourney(stages, reveal);
  }
  function journeyFor(regions: HTMLElement[]) {
    const previous = scrollJourney.current;
    if (previous && previous.regions.length === regions.length && regions.every((region, i) => previous.regions[i] === region)) return previous.journey;
    const journey = makeJourney(regions); scrollJourney.current = { regions, journey }; return journey;
  }
  function panThrough(regions: HTMLElement[], dx: number, dy: number, journey = makeJourney(regions)) {
    return journey.move(dx, dy);
  }
  function capture(pointer: number) {
    if (!element.current!.hasPointerCapture(pointer)) element.current!.setPointerCapture(pointer);
    captured.current.add(pointer);
  }
  function interactionChanged() {
    const next = contacts.current.size > 0 || drag.current !== null;
    if (next !== interacting.current) { interacting.current = next; callbacks.current.onInteractionChange?.(next); }
  }
  function clear() {
    if (contacts.current.size || drag.current) traceInput('clear', [contacts.current.size, drag.current?.pointer ?? -1]);
    const pointers = [...captured.current];
    captured.current.clear(); touch.current.clear(); contacts.current.clear(); drag.current = null; scrollJourney.current = null;
    interactionChanged();
    for (const pointer of pointers) if (element.current?.hasPointerCapture(pointer)) element.current.releasePointerCapture(pointer);
  }
  function zoom(factor: number, client?: { x: number; y: number }): boolean {
    if (!scroller.current || !plane.current) return false;
    scrollJourney.current = null; if (drag.current) {drag.current.journey = makeJourney(drag.current.regions);drag.current.worldDebt={x:0,y:0};drag.current.canvasAxes={x:false,y:false};}
    const bounds = geometry(), rect = frame();
    const screen = client ?? { x: rect.left + rect.width / 2, y: rect.top + bounds.view.height * rect.width / scroller.current.offsetWidth / 2 };
    // An outer zoom at this same screen point leaves its local coordinate invariant.
    const anchor = point(screen.x, screen.y);
    const remaining = callbacks.current.zoomBeforeCard?.(factor, screen) ?? factor, outer = remaining !== factor;
    const before = current.current.zoom;
    const ideal = zoomAt(current.current, remaining, anchor, minimumContentZoom(bounds.view, bounds.content), 4);
    apply(ideal);
    anchorCommit.current ||= navigation.current.pending !== null;
    // Scroll bounds may prevent the inner translation; the world consumes the difference.
    const scale = frame().width / scroller.current.offsetWidth;
    const dx = (current.current.x - ideal.x) * scale, dy = (current.current.y - ideal.y) * scale;
    if (dx || dy) callbacks.current.panPastEdge?.(dx, dy);
    const residual = remaining / (current.current.zoom / before);
    if (residual < 1 - 1e-10) { callbacks.current.zoomPastCard?.(residual, screen); return true; }
    return outer;
  }
  useLayoutEffect(() => {
    if(!renderActive)return;
    const viewport = scroller.current!, content = plane.current!;
    const measure = () => { const width = viewport.clientWidth + 'px'; if (content.style.width !== width) content.style.width = width; const bounds = geometry(); traceInput('geometry', [traceSurface.current, Number(enabled.current), bounds.view.width, bounds.view.height, bounds.content.width, bounds.content.height, current.current.zoom, viewport.scrollLeft, viewport.scrollTop]); setExtent(old => old.width === bounds.content.width && old.height === bounds.content.height ? old : bounds.content); apply(current.current); };
    const observer = new ResizeObserver(measure); observer.observe(viewport); observer.observe(content); measure();
    return () => observer.disconnect();
  }, [renderActive]);
  useLayoutEffect(() => { const viewport = scroller.current; if (viewport) { const target = navigation.current.pending ?? current.current; viewport.scrollLeft = -target.x; viewport.scrollTop = -target.y; navigation.current.committed(viewport.scrollLeft, viewport.scrollTop); current.current = navigation.current.camera; store?.set(id, current.current); const anchored = anchorCommit.current; anchorCommit.current = false; if (anchored) { const scale = frame().width / viewport.offsetWidth, dx = (current.current.x - target.x) * scale, dy = (current.current.y - target.y) * scale; if (dx || dy) callbacks.current.panPastEdge?.(dx, dy); } } }, [commitRevision, extent]);
  useEffect(() => {
    const body = element.current; if (!body) return;
    const wheel = (event: WheelEvent) => {
      if (!enabled.current || forceCanvas() || event.altKey) return;
      event.preventDefault(); event.stopPropagation();
      const viewport = scroller.current!, scale = frame().width / viewport.offsetWidth;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      const delta = event.deltaY * unit, horizontal = event.deltaX * unit;
      if (event.ctrlKey || event.metaKey) zoom(Math.exp(Math.max(-4, Math.min(4, -delta * .0015))), { x: event.clientX, y: event.clientY });
      else { const regions = scrollAncestors(event.target, viewport); panThrough(regions, (horizontal + (event.shiftKey ? delta : 0)) / scale, (event.shiftKey ? 0 : delta) / scale, journeyFor(regions)); }
    };
    const canvasNavigation = (event: Event) => { const own = (event as CustomEvent<{ card?: string }>).detail?.card === id; if (contacts.current.size || drag.current) traceInput('navigation', [Number(own), contacts.current.size]); if (!own) clear(); };
    const blurred = () => { if (contacts.current.size || drag.current) traceInput('blur', [contacts.current.size]); clear(); };
    body.addEventListener('wheel', wheel, { passive: false, capture: true }); window.addEventListener('agenticview:canvas-navigation', canvasNavigation); window.addEventListener('blur', blurred);
    return () => { if (contacts.current.size || drag.current) traceInput('unmount', [contacts.current.size]); body.removeEventListener('wheel', wheel, true); window.removeEventListener('agenticview:canvas-navigation', canvasNavigation); window.removeEventListener('blur', blurred); clear(); };
  }, []);
  useEffect(() => { if (!active) { if (contacts.current.size || drag.current) traceInput('inactive', [contacts.current.size]); clear(); } }, [active]);
  function down(event: React.PointerEvent<HTMLDivElement>) {
    traceInput('down', [event.pointerId, Number(active), Number(forceCanvas()), Number(canvasOwnsPointer(event.pointerId)), inputRegion(event.target)]);
    if (!active || forceCanvas() || event.altKey || canvasOwnsPointer(event.pointerId)) return;
    const viewport = scroller.current!, bounds = frame(), scale = bounds.width / viewport.offsetWidth;
    const localControl = !!(event.target as Element).closest('.card-local-controls');
    if (!localControl && (event.clientX >= bounds.left + viewport.clientWidth * scale || event.clientY >= bounds.top + viewport.clientHeight * scale)) return;
    const target = event.target as Element, editable = localControl || !!target.closest('textarea,select,[contenteditable]:not([contenteditable="false"]),input:not(:disabled):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset])');
    const client = { x: event.clientX, y: event.clientY };
    const regions = scrollAncestors(event.target, viewport);
    const intent: Drag = { pointer: event.pointerId, ...client, position: client, origin: client, regions, journey: journeyFor(regions), moved: false, editable, worldDebt:{x:0,y:0}, canvasAxes:{x:false,y:false} };
    if (event.pointerType === 'touch') {
      if (!touch.current.count) touch.current = new TouchViewport(1e-9, 1e9);
      else for (const [pointer, contact] of contacts.current) touch.current.start(pointer, contact.position, current.current);
      contacts.current.set(event.pointerId, intent); touch.current.start(event.pointerId, client, current.current);
      if (touch.current.count >= 2) { event.preventDefault(); event.stopPropagation(); suppressClickUntil.current = performance.now() + 700; for (const pointer of contacts.current.keys()) capture(pointer); }
    } else if (event.button !== 0 || event.shiftKey || editable) return;
    drag.current ??= intent;
    interactionChanged();
    if (!target.closest('button,a,input,textarea,select,[contenteditable]:not([contenteditable="false"])')) { event.stopPropagation(); if (event.pointerType === 'touch') event.preventDefault(); capture(event.pointerId); }
  }
  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (!active || canvasOwnsPointer(event.pointerId) || forceCanvas() || event.altKey) return;
    const contact = contacts.current.get(event.pointerId); if (contact) contact.position = { x: event.clientX, y: event.clientY };
    if (event.pointerType === 'touch' && touch.current.pointers.has(event.pointerId)) {
      const points = [...touch.current.pointers.values()].slice(0, 2), center = { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
      const pinched = touch.current.move(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinched) {
        event.preventDefault(); event.stopPropagation(); suppressClickUntil.current = performance.now() + 700;
        const outer = zoom(pinched.zoom / current.current.zoom, center), next = [...touch.current.pointers.values()].slice(0, 2);
        const dx = (next[0]!.x + next[1]!.x) / 2 - center.x, dy = (next[0]!.y + next[1]!.y) / 2 - center.y;
        if (outer) { if (dx || dy) callbacks.current.panPastEdge?.(-dx, -dy); }
        else { const viewport = scroller.current!, scale = frame().width / viewport.offsetWidth; panThrough([], -dx / scale, -dy / scale); }
        touch.current.commit(current.current); return;
      }
    }
    const start = drag.current; if (!start || start.pointer !== event.pointerId) return;
    if (start.editable) return;
    if (!start.moved && Math.hypot(event.clientX - start.origin.x, event.clientY - start.origin.y) < 4) return;
    const viewport = scroller.current!, scale = frame().width / viewport.offsetWidth;
    const dx = (event.clientX - start.x) / scale, dy = (event.clientY - start.y) / scale; start.moved = true; start.x = event.clientX; start.y = event.clientY;
    event.preventDefault(); event.stopPropagation();
    // Pointer capture pins event.target to this surface. Hit-test the physical contact instead.
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const physical = viewport.getBoundingClientRect();
    const inside = hit ? scroller.current!.contains(hit) : event.clientX >= physical.left && event.clientX < physical.right && event.clientY >= physical.top && event.clientY < physical.bottom;
    const regions = inside ? hit ? scrollAncestors(hit, scroller.current!) : start.regions : [];
    if (regions.length !== start.regions.length || regions.some((region, i) => region !== start.regions[i])) { if(regions.length){start.canvasAxes.x ||= Math.abs(start.worldDebt.x)>1e-7;start.canvasAxes.y ||= Math.abs(start.worldDebt.y)>1e-7;} traceInput('route', [event.pointerId, start.regions.length, regions.length, inputRegion(hit)]); start.regions = regions; start.journey = journeyFor(regions); }
    // Capture keeps delivery on this surface; an outside physical contact belongs to the canvas.
    if (!inside && callbacks.current.panPastEdge) { panWorld(-dx * scale, -dy * scale); return; }
    capture(event.pointerId); suppressClickUntil.current = performance.now() + 500;
    const beforeX = current.current.x, beforeY = current.current.y;
    const input={x:-dx*scale,y:-dy*scale}, handed={x:0,y:0};
    for(const axis of ['x','y'] as const) if(start.canvasAxes[axis]) {
      const debt=start.worldDebt[axis];
      if(Math.abs(debt)<1e-7){start.canvasAxes[axis]=false;continue;}
      handed[axis]=input[axis]*debt<0?Math.sign(input[axis])*Math.min(Math.abs(input[axis]),Math.abs(debt)):input[axis];
      input[axis]-=handed[axis];
    }
    if(handed.x||handed.y)panWorld(handed.x,handed.y);
    const remaining = panThrough(start.regions, input.x/scale, input.y/scale, start.journey);
    traceInput('move', [event.pointerId, dx, dy, remaining.x, remaining.y, beforeX, beforeY, current.current.x, current.current.y, start.regions.length, ...start.regions.flatMap(region => [inputRegion(region), region.scrollLeft, region.scrollTop])]);
  }
  function up(event: React.PointerEvent<HTMLDivElement>) {
    const pinching = touch.current.count >= 2;
    if (touch.current.pointers.has(event.pointerId)) touch.current.end(event.pointerId, current.current);
    contacts.current.delete(event.pointerId); if (drag.current?.pointer === event.pointerId) drag.current = null;
    const remaining = [...touch.current.pointers.entries()]; if (pinching && remaining.length === 1) { const [pointer] = remaining[0]!; const contact = contacts.current.get(pointer)!; drag.current = { ...contact, ...contact.position, origin: contact.position, journey: journeyFor(contact.regions), moved: true, editable: false }; contacts.current.set(pointer, drag.current); }
    captured.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    interactionChanged();
  }
  function lostCapture(event: React.PointerEvent<HTMLDivElement>) {
    if (!active || forceCanvas() || canvasOwnsPointer(event.pointerId) || !captured.current.has(event.pointerId) || !contacts.current.has(event.pointerId) && drag.current?.pointer !== event.pointerId) return;
    try { capture(event.pointerId); } catch { up(event); }
  }
  const nav=control(chrome,'navigation'), placement=nav.placement??'top-right', bottom=placement==='footer'||placement.startsWith('bottom'), left=placement.endsWith('left');
  const navigationButtons=[
    {id:'zoomOut' as const,label:'Zoom card out',icon:<Minus size={12}/>,run:()=>zoom(1/1.2)},
    {id:'zoomIn' as const,label:'Zoom card in',icon:<Plus size={12}/>,run:()=>zoom(1.2)},
    {id:'resetView' as const,label:'Reset card view',icon:<RotateCcw size={12}/>,run:()=>apply(initial)},
    {id:'deactivate' as const,label:'Deactivate card',icon:<Check size={13}/>,run:deactivate}
  ];
  return <CardInteraction value={active}><div ref={element} className={['card-body card-surface',active?'card-active':''].join(' ')} data-card-surface={id} style={{paddingTop:nav.visible===false||bottom?16:46,paddingBottom:nav.visible!==false&&bottom?46:16}} onPointerDownCapture={down} onPointerMoveCapture={move} onPointerUpCapture={up} onPointerCancelCapture={up} onLostPointerCapture={lostCapture} onClickCapture={event=>{if(performance.now()<suppressClickUntil.current){event.preventDefault();event.stopPropagation();}}}>
    {nav.visible!==false&&<div className="card-local-controls" data-control="navigation" data-control-placement={placement} role="toolbar" aria-label={nav.label||'Active card navigation'} title={nav.tooltip} style={{top:bottom?'auto':7,bottom:bottom?7:'auto',left:left?8:'auto',right:left?'auto':8,...controlStyle(nav)}}>{control(chrome,'caption').visible!==false&&<span>{chrome?.caption?.label||'Card'}</span>}{control(chrome,'scale').visible!==false&&<span title={chrome?.scale?.tooltip}>{chrome?.scale?.label||`${Math.round(camera.zoom*100)}%`}</span>}{navigationButtons.map(button=>{const spec=control(chrome,button.id,{appearance:'icon'});return spec.visible===false?null:<button key={button.id} data-control={button.id} disabled={!active} title={spec.tooltip??button.label} aria-label={spec.label||button.label} style={controlStyle(spec)} onClick={button.run}><ControlContent spec={spec} label={button.label} icon={button.icon}/></button>;})}</div>}

    <div ref={scroller} className="card-content-scroll" inert={!active} tabIndex={active ? 0 : -1} onScroll={() => { if (!enabled.current || !scroller.current) return; if (navigation.current.scrolled(scroller.current.scrollLeft, scroller.current.scrollTop)) { current.current = navigation.current.camera; store?.set(id, current.current); } }}>
      <div className="card-scroll-extent" style={{ width: extent.width * camera.zoom || undefined, height: extent.height * camera.zoom || undefined }}>
        <div ref={plane} className="card-content-plane" inert={!active} style={{ transform: 'scale(' + camera.zoom + ')', transformOrigin: '0 0' }}>{children}</div>
      </div>
    </div>
  </div></CardInteraction>;
}
