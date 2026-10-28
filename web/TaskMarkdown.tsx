import { Children, cloneElement, isValidElement, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink } from 'lucide-react';
import type { TaskTiming } from '../shared/protocol.js';
import { compactTime, exactTime } from '../shared/time-format.js';

export function TaskMarkdown({ text, tasks = [], updatedAt }: { text: string; tasks?: TaskTiming[]; updatedAt?: number }) {
  const clocks = [...tasks].sort((a, b) => (a.completedAt ?? a.startedAt ?? a.firstSeenAt) - (b.completedAt ?? b.startedAt ?? b.firstSeenAt));
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}<ExternalLink size={11} /></a>,
    li: ({ node, children, ...props }) => {
      const recorded = tasks.find(task => task.line === node?.position?.start.line);
      const timing = recorded ?? (updatedAt === undefined ? undefined : { key: 'receipt', line: node?.position?.start.line ?? 0, firstSeenAt: updatedAt, updatedAt });
      if (!timing || !props.className?.includes('task-list-item')) return <li {...props}>{children}</li>;
      const timestamp = timing.completedAt ?? timing.startedAt ?? timing.firstSeenAt, index = clocks.indexOf(timing), previous = clocks[index - 1];
      const spacing = previous ? Math.max(0, timestamp - (previous.completedAt ?? previous.startedAt ?? previous.firstSeenAt)) : timing.startedAt !== undefined ? Math.max(0, timestamp - timing.startedAt) : 0;
      const label = !recorded ? 'Task list update reported' : timing.completedAt !== undefined ? 'Completion reported' : 'First listed';
      const elapsed = timing.completedAt !== undefined && timing.startedAt !== undefined ? ` · Observed interval ${timing.completedAt - timing.startedAt} ms` : '';
      const stamp = <time key="task-time" className="task-time" dateTime={new Date(timestamp).toISOString()} title={`${label}: ${exactTime(timestamp)}${elapsed}`}>{compactTime(timestamp, spacing)}</time>;
      const content = Children.toArray(children), paragraph = content.findIndex(child => isValidElement(child) && child.type === 'p');
      if (paragraph >= 0) { const p = content[paragraph] as ReactElement<{ children?: React.ReactNode }>; content[paragraph] = cloneElement(p, {}, p.props.children, stamp); }
      else { const nested = content.findIndex(child => isValidElement(child) && (child.type === 'ul' || child.type === 'ol')); content.splice(nested < 0 ? content.length : nested, 0, stamp); }
      return <li {...props}>{content}</li>;
    }
  }}>{text}</ReactMarkdown></div>;
}
