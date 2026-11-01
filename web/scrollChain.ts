import {readScrollAxis,scrollViewportBy} from './logicalScroll.js';
const enabled=(node:HTMLElement,value:string)=>/(auto|scroll)/.test(value)||value==='hidden'&&node.dataset.nativeScrollport==='true';

/** Closest scroll region first; the enclosing card consumes whatever remains. */
export function scrollAncestors(target: EventTarget | null, boundary: HTMLElement): HTMLElement[] {
  const regions: HTMLElement[] = [];
  let node = target instanceof Element ? target : null;
  // Rails are siblings of their viewport so their geometry never expands its
  // scroll extent. Wheel input over a rail still belongs to that local viewport.
  const rail = node?.closest('[data-native-scrollbar]');
  const frame = rail?.parentElement;
  if (frame?.dataset.nativeScrollFrame === 'true') {
    const viewport = Array.from(frame.children).find(child => child instanceof HTMLElement && child.dataset.nativeScrollport === 'true');
    if (viewport instanceof HTMLElement && viewport.id && rail?.getAttribute('aria-controls') === viewport.id) node = viewport;
  }
  while (node && node !== boundary) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      if ((enabled(node,style.overflowX)||enabled(node,style.overflowY)) && (readScrollAxis(node,'x').max>0||readScrollAxis(node,'y').max>0)) regions.push(node);
    }
    node = node.parentElement;
  }
  return node === boundary ? regions : [];
}

export function scrollThrough(regions: HTMLElement[], dx: number, dy: number) {
  for (const region of regions) {
    const style = getComputedStyle(region);
    const horizontal = enabled(region,style.overflowX), vertical = enabled(region,style.overflowY);
    const next=scrollViewportBy(region,horizontal?dx:0,vertical?dy:0);
    if(horizontal)dx=next.x;if(vertical)dy=next.y;
  }
  return { x: dx, y: dy };
}
