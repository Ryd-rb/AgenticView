import type { TaskTiming } from './protocol.js';
export type TimePrecision = 'millisecond' | 'second' | 'minute';
export function timePrecision(spacingMs = 0): TimePrecision { return spacingMs < 60_000 ? 'millisecond' : spacingMs < 600_000 ? 'second' : 'minute'; }
export function compactTime(timestamp: number, spacingMs?: number): string {
  const date = new Date(timestamp), pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const precision = spacingMs === undefined ? 'second' : timePrecision(Math.max(0, spacingMs));
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + (precision === 'minute' ? '' : ':' + pad(date.getSeconds()) + (precision === 'millisecond' ? '.' + pad(date.getMilliseconds(), 3) : ''));
}
export function exactTime(timestamp: number): string { return new Date(timestamp).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }); }

/** Match task clock precision without turning elapsed time into a wall-clock date. */
export function compactDuration(durationMs: number): string {
  const ms = Math.max(0, Math.floor(Number.isFinite(durationMs) ? durationMs : 0));
  if (timePrecision(ms) === 'millisecond') return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(3)}s`;
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60);
  if (timePrecision(ms) === 'second') return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  return days ? `${days}d ${hours % 24}h ${minutes % 60}m` : hours ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

export function taskClockSpacings(tasks: readonly TaskTiming[]): Map<string, number> {
  const ordered = [...tasks].sort((a, b) => (a.completedAt ?? a.startedAt ?? a.firstSeenAt) - (b.completedAt ?? b.startedAt ?? b.firstSeenAt));
  return new Map(ordered.map((task, index) => {
    const at = task.completedAt ?? task.startedAt ?? task.firstSeenAt, previous = ordered[index - 1];
    return [task.key, Math.max(0, at - (previous ? previous.completedAt ?? previous.startedAt ?? previous.firstSeenAt : task.startedAt ?? at))];
  }));
}
