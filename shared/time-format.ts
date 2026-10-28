export type TimePrecision = 'millisecond' | 'second' | 'minute';
export function timePrecision(spacingMs = 0): TimePrecision { return spacingMs < 60_000 ? 'millisecond' : spacingMs < 600_000 ? 'second' : 'minute'; }
export function compactTime(timestamp: number, spacingMs?: number): string {
  const date = new Date(timestamp), pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const precision = spacingMs === undefined ? 'second' : timePrecision(Math.max(0, spacingMs));
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + (precision === 'minute' ? '' : ':' + pad(date.getSeconds()) + (precision === 'millisecond' ? '.' + pad(date.getMilliseconds(), 3) : ''));
}
export function exactTime(timestamp: number): string { return new Date(timestamp).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }); }
