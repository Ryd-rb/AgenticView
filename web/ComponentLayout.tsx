import type { CSSProperties, ReactNode } from 'react';
import type { ComponentLayout as Layout } from '../shared/card-display.js';

export function componentLayoutStyle(layout: Layout = {}): CSSProperties {
  if (layout.mode === 'inline') return { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: layout.gap ?? 6, minWidth: 0 };
  const minimum = layout.minWidth ?? 200;
  return { display: 'grid', alignItems: 'start', gap: layout.gap ?? 12, minWidth: 0,
    gridTemplateColumns: layout.mode === 'vertical' ? 'minmax(0,1fr)' : layout.mode === 'columns' ? `repeat(${layout.columns ?? 2},minmax(0,1fr))` : `repeat(auto-fit,minmax(min(100%,${minimum}px),1fr))` };
}
export function ComponentLayout({ layout, children, label }: { layout?: Layout; children: ReactNode; label?: string }) {
  return <div className="component-layout" data-layout={layout?.mode ?? 'auto'} aria-label={label} style={componentLayoutStyle(layout)}>{children}</div>;
}
