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
