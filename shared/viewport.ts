export type Camera = { x: number; y: number; zoom: number };
export type Point = { x: number; y: number };
export function zoomAt(camera: Camera, factor: number, point: Point, minZoom = 1e-9, maxZoom = 2): Camera {
  if (![camera.x, camera.y, camera.zoom, factor, point.x, point.y].every(Number.isFinite) || camera.zoom <= 0 || factor <= 0) throw new RangeError('Invalid viewport transform');
  const zoom = Math.max(Math.min(minZoom, camera.zoom), Math.min(maxZoom, camera.zoom * factor));
  const scale = zoom / camera.zoom;
  return { zoom, x: point.x - (point.x - camera.x) * scale, y: point.y - (point.y - camera.y) * scale };
}
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** Pointer identities survive cancellation/lift; every membership change rebases the pinch. */
export class TouchViewport {
  constructor(private readonly minZoom = 1e-9, private readonly maxZoom = 2) {}
  readonly pointers = new Map<number, Point>();
  private baseline?: { ids: [number, number]; center: Point; distance: number; camera: Camera };
  get count() { return this.pointers.size; }
  private rebase(camera: Camera) {
    const entries = [...this.pointers.entries()];
    this.baseline = entries.length < 2 ? undefined : { ids: [entries[0]![0], entries[1]![0]], center: midpoint(entries[0]![1], entries[1]![1]), distance: Math.max(1, Math.hypot(entries[0]![1].x - entries[1]![1].x, entries[0]![1].y - entries[1]![1].y)), camera: { ...camera } };
  }
  start(id: number, point: Point, camera: Camera) { this.pointers.set(id, point); this.rebase(camera); }
  move(id: number, point: Point): Camera | null {
    if (!this.pointers.has(id)) return null;
    this.pointers.set(id, point); const base = this.baseline; if (!base) return null;
    const a = this.pointers.get(base.ids[0])!, b = this.pointers.get(base.ids[1])!;
    const center = midpoint(a, b), distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const zoomed = zoomAt(base.camera, distance / base.distance, base.center, this.minZoom, this.maxZoom);
    return { ...zoomed, x: zoomed.x + center.x - base.center.x, y: zoomed.y + center.y - base.center.y };
  }
  end(id: number, camera: Camera) { this.pointers.delete(id); this.rebase(camera); }
  cancel(id: number, camera: Camera) { this.end(id, camera); }
  clear() { this.pointers.clear(); this.baseline = undefined; }
}
export type CanvasAction = 'left' | 'right' | 'up' | 'down' | 'in' | 'out' | 'fit' | 'reset' | 'escape';
export function canvasKey(key: string, protectedTarget: boolean, modifier = false): CanvasAction | null {
  if (protectedTarget || modifier) return null;
  return ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '+': 'in', '=': 'in', '-': 'out', _: 'out', f: 'fit', F: 'fit', Home: 'fit', '0': 'reset', Escape: 'escape' } as Record<string, CanvasAction>)[key] ?? null;
}
