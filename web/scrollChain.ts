import { consumeScrollDelta } from '../shared/interaction.js';

/** Closest scroll region first; the enclosing card consumes whatever remains. */
export function scrollAncestors(target: EventTarget | null, boundary: HTMLElement): HTMLElement[] {
  const regions: HTMLElement[] = [];
  let node = target instanceof Element ? target : null;
  while (node && node !== boundary) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowX + style.overflowY) && (node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight)) regions.push(node);
    }
    node = node.parentElement;
  }
  return node === boundary ? regions : [];
}

export function scrollThrough(regions: HTMLElement[], dx: number, dy: number) {
  for (const region of regions) {
    const style = getComputedStyle(region);
    const horizontal = /(auto|scroll)/.test(style.overflowX), vertical = /(auto|scroll)/.test(style.overflowY);
    const next = consumeScrollDelta({ left: region.scrollLeft, top: region.scrollTop,
      maxLeft: Math.max(0, region.scrollWidth - region.clientWidth), maxTop: Math.max(0, region.scrollHeight - region.clientHeight) }, horizontal ? dx : 0, vertical ? dy : 0);
    region.scrollLeft = next.left; region.scrollTop = next.top;
    // Use the actual native offsets, including rounding, to conserve the movement.
    if (horizontal) dx = next.remainingX + next.left - region.scrollLeft;
    if (vertical) dy = next.remainingY + next.top - region.scrollTop;
  }
  return { x: dx, y: dy };
}
