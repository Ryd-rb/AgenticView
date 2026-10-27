export type Rect = { x: number; y: number; width: number; height: number };
function valid(r: Rect): void {
  if (![r.x, r.y, r.width, r.height, r.x + r.width, r.y + r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) throw new RangeError('A finite, positive rectangle is required');
}
export function overlaps(a: Rect, b: Rect, gap = 16): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
/** Deterministic nearest edge placement, with a bounded search and clear right-edge fallback. */
export function findFreePosition(rect: Rect, obstacles: readonly Rect[], gap = 16): Rect {
  valid(rect); obstacles.forEach(valid);
  if (!Number.isFinite(gap) || gap < 0) throw new RangeError('Invalid gap');
  const free = (r: Rect) => !obstacles.some(o => overlaps(r, o, gap));
  if (free(rect)) return { ...rect };
  const nearby = [...obstacles].sort((a, b) => Math.hypot(a.x - rect.x, a.y - rect.y) - Math.hypot(b.x - rect.x, b.y - rect.y)).slice(0, 48);
  const xs = [rect.x, ...nearby.flatMap(o => [o.x - rect.width - gap, o.x + o.width + gap])];
  const ys = [rect.y, ...nearby.flatMap(o => [o.y - rect.height - gap, o.y + o.height + gap])];
  let best: Rect | undefined; let distance = Infinity;
  for (const x of xs) for (const y of ys) {
    const d = (x - rect.x) ** 2 + (y - rect.y) ** 2;
    if (d >= distance) continue;
    const candidate = { ...rect, x, y };
    if (free(candidate)) { best = candidate; distance = d; }
  }
  if (best) return best;
  const fallback = { ...rect, x: obstacles.reduce((right, o) => Math.max(right, o.x + o.width), rect.x) + gap };
  valid(fallback);
  return fallback;
}
export function moveWithoutOverlap(rect: Rect, target: { x: number; y: number }, obstacles: readonly Rect[], gap = 16): Rect {
  return findFreePosition({ ...rect, ...target }, obstacles, gap);
}
export function isVisible(rect: Rect, viewport: Rect): boolean { return overlaps(rect, viewport, 0); }
/** Resize from a fixed origin, stopping at the first colliding dimensions. */
export function resizeWithoutOverlap(rect: Rect, size: { width: number; height: number }, obstacles: readonly Rect[], gap = 16): Rect {
  valid(rect); const target = { ...rect, ...size }; valid(target); obstacles.forEach(valid);
  const free = (r: Rect) => !obstacles.some(o => overlaps(r, o, gap));
  if (free(target)) return target;
  if (!free(rect)) return { ...rect };
  let low = 0, high = 1;
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2;
    const candidate = { ...rect, width: rect.width + (target.width - rect.width) * middle, height: rect.height + (target.height - rect.height) * middle };
    if (free(candidate)) low = middle; else high = middle;
  }
  return { ...rect, width: rect.width + (target.width - rect.width) * low, height: rect.height + (target.height - rect.height) * low };
}
