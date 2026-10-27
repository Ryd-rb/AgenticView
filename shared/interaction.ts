export type GestureOwner = 'canvas' | 'card';

/** Explicit activation is the only route into a card; global controls always win. */
export function gestureOwner(activeCard: string | null, targetCard: string | null, forceCanvas = false, mainControl = false): GestureOwner {
  return !forceCanvas && !mainControl && targetCard !== null && activeCard === targetCard ? 'card' : 'canvas';
}

export function contentPoint(client: { x: number; y: number }, bounds: { left: number; top: number; width: number }, contentWidth: number) {
  const scale = bounds.width / contentWidth;
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid card bounds');
  return { x: (client.x - bounds.left) / scale, y: (client.y - bounds.top) / scale };
}

type Size = { width: number; height: number };
export function minimumContentZoom(view: Size, content: Size): number {
  if (![view.width, view.height, content.width, content.height].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Invalid content extent');
  return Math.min(1, Math.max(view.width / content.width, view.height / content.height));
}
export function clampContentCamera(camera: { x: number; y: number; zoom: number }, view: Size, content: Size) {
  if (![camera.x, camera.y, camera.zoom].every(Number.isFinite)) throw new RangeError('Invalid content transform');
  const zoom = Math.max(minimumContentZoom(view, content), Math.min(4, camera.zoom));
  return { zoom, x: Math.max(Math.min(0, view.width - content.width * zoom), Math.min(0, camera.x)), y: Math.max(Math.min(0, view.height - content.height * zoom), Math.min(0, camera.y)) };
}

/** Native scroll events acknowledge position; they must not schedule another zoom render. */
export class ContentNavigation {
  revision = 0;
  pending: { x: number; y: number; zoom: number } | null = null;
  constructor(public camera: { x: number; y: number; zoom: number }) {}
  request(next: { x: number; y: number; zoom: number }): boolean {
    const scaleChanged = next.zoom !== this.camera.zoom;
    if (scaleChanged) this.revision++;
    this.camera = next;
    if (scaleChanged || this.pending) this.pending = next;
    return scaleChanged;
  }
  scrolled(left: number, top: number): boolean {
    if (this.pending) return false;
    this.camera = { ...this.camera, x: -left, y: -top };
    return true;
  }
  committed(left: number, top: number) {
    this.camera = { ...this.camera, x: -left, y: -top };
    this.pending = null;
  }
}
