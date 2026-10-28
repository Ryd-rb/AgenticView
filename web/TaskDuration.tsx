import { useSyncExternalStore } from 'react';
import type { TaskTiming } from '../shared/protocol.js';
import { compactDuration, exactTime } from '../shared/time-format.js';

// One low-frequency clock for visible running labels. Markdown itself never ticks.
const listeners = new Set<() => void>();
let now = Date.now(), timer: ReturnType<typeof setInterval> | undefined;
const snapshot = () => now, idle = () => 0, noSubscription = () => () => {};
function tick() { now = Date.now(); for (const listener of listeners) listener(); }
function visibility() {
  if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  if (document.visibilityState !== 'hidden') { tick(); timer = setInterval(tick, 1000); }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) { document.addEventListener('visibilitychange', visibility); visibility(); }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { if (timer !== undefined) clearInterval(timer); timer = undefined; document.removeEventListener('visibilitychange', visibility); }
  };
}

export function TaskDuration({ timing }: { timing?: TaskTiming }) {
  const running = timing?.startedAt !== undefined && timing.completedAt === undefined;
  const clock = useSyncExternalStore(running ? subscribe : noSubscription, running ? snapshot : idle, idle);
  if (timing?.startedAt === undefined) return <span className="task-duration is-unknown" title="Duration unavailable: no start was observed" aria-label="Task duration unavailable">—</span>;
  const elapsed = Math.max(0, (timing.completedAt ?? clock) - timing.startedAt), label = compactDuration(elapsed);
  const title = `${running ? 'Elapsed since first reported unchecked' : 'Observed task duration'}: ${elapsed} ms · Started ${exactTime(timing.startedAt)}${timing.completedAt === undefined ? '' : ` · Completed ${exactTime(timing.completedAt)}`}`;
  return <time className={`task-duration${running ? ' is-running' : ''}`} dateTime={`PT${elapsed / 1000}S`} title={title} aria-label={`${running ? 'Elapsed' : 'Duration'} ${label}`}>{label}</time>;
}
