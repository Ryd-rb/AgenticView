/** Arrival color starts on first intersection, rather than while a card is offscreen. */
export class ArrivalTracker {
  private initialized = false;
  private known = new Set<string>();
  private pending = new Set<string>();
  private seen = new Map<string, number>();
  sync(ids: readonly string[]) {
    const next = new Set(ids);
    if (this.initialized) for (const id of next) if (!this.known.has(id)) this.pending.add(id);
    this.initialized = true;
    for (const id of this.pending) if (!next.has(id)) this.pending.delete(id);
    for (const id of this.seen.keys()) if (!next.has(id)) this.seen.delete(id);
    this.known = next;
  }
  isPending(id: string) { return this.pending.has(id); }
  visibleAt(id: string) { return this.seen.get(id); }
  firstVisible(id: string, now: number) { if (this.pending.delete(id)) this.seen.set(id, now); return this.seen.get(id); }
}
