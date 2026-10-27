type Delta = { x: number; y: number };
export type ScrollStage = (x: number, y: number) => Delta;
type Rect = { left: number; top: number; width: number; height: number };

/** Reveal an obscured child in the requested direction before handing input inward. */
export function revealScrollDelta(child: Rect, parent: Rect, x: number, y: number, screenScale: number): Delta {
  const horizontal = x > 0 ? Math.max(0, child.left + child.width - parent.left - parent.width) : Math.min(0, child.left - parent.left);
  const vertical = y > 0 ? Math.max(0, child.top + child.height - parent.top - parent.height) : Math.min(0, child.top - parent.top);
  return { x: Math.sign(x) * Math.min(Math.abs(x), Math.abs(horizontal) / screenScale), y: Math.sign(y) * Math.min(Math.abs(y), Math.abs(vertical) / screenScale) };
}

/** Reverse outward movement before scrolling a previously obscured inner region. */
export class ScrollJourney {
  private readonly debt: Delta[];
  constructor(private readonly stages: readonly ScrollStage[], private readonly reveal: readonly (ScrollStage | undefined)[] = []) { this.debt = stages.map(() => ({ x: 0, y: 0 })); }
  move(x: number, y: number): Delta {
    for (let i = this.stages.length - 1; i > 0; i--) {
      const debt = this.debt[i]!;
      const visible = this.reveal[i]?.(x, y);
      const reverseX = visible?.x ?? (x * debt.x < 0 ? Math.sign(x) * Math.min(Math.abs(x), Math.abs(debt.x)) : 0);
      const reverseY = visible?.y ?? (y * debt.y < 0 ? Math.sign(y) * Math.min(Math.abs(y), Math.abs(debt.y)) : 0);
      if (!reverseX && !reverseY) continue;
      const remaining = this.stages[i]!(reverseX, reverseY), usedX = reverseX - remaining.x, usedY = reverseY - remaining.y;
      debt.x += usedX; debt.y += usedY; x -= usedX; y -= usedY;
      // A changed extent may remove the old return path; do not retain stale debt.
      if (Math.abs(remaining.x) > 1e-7) debt.x = 0;
      if (Math.abs(remaining.y) > 1e-7) debt.y = 0;
    }
    for (let i = 0; i < this.stages.length && (x || y); i++) {
      const remaining = this.stages[i]!(x, y);
      if (i > 0) { this.debt[i]!.x += x - remaining.x; this.debt[i]!.y += y - remaining.y; }
      x = remaining.x; y = remaining.y;
    }
    return { x, y };
  }
}
