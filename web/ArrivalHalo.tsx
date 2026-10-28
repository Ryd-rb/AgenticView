import { useEffect, useRef, useState } from 'react';
import type { ArrivalTracker } from '../shared/arrivals.js';

export function ArrivalHalo({ id, tracker }: { id: string; tracker?: ArrivalTracker }) {
  const marker = useRef<HTMLSpanElement>(null), [started, setStarted] = useState<number>(), [finished, setFinished] = useState(false);
  useEffect(() => {
    if (!tracker) { setFinished(true); return; }
    const existing = tracker.visibleAt(id);
    if (existing !== undefined) { setStarted(existing); return; }
    if (!tracker.isPending(id)) { setFinished(true); return; }
    const box = marker.current?.parentElement; if (!box) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0)) { setStarted(tracker.firstVisible(id, Date.now())); observer.disconnect(); } }, { threshold: .01 });
    observer.observe(box); return () => observer.disconnect();
  }, [id, tracker]);
  useEffect(() => { if (started === undefined) return; const timer = setTimeout(() => setFinished(true), Math.max(0, 6000 - (Date.now() - started))); return () => clearTimeout(timer); }, [started]);
  if (finished) return null;
  const age = started === undefined ? 0 : Math.max(0, Date.now() - started);
  return <span ref={marker} aria-hidden="true" className={`arrival-halo ${started === undefined ? '' : 'arrival-visible'}`} style={{ animationDelay: -age + 'ms' }} />;
}
