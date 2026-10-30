import type { ReactNode } from 'react';
import { control, type ControlId, type ControlMap } from '../shared/control-presentation.js';
import type { AgentView } from '../shared/protocol.js';
import { ControlContent, controlStyle } from './ControlPresentation.js';
import { CardIcon } from './CardIcon.js';
import { RunTimes } from './RunTimes.js';

export type CardAction = { id: ControlId; label: string; displayLabel?: string; defaultAppearance?: 'icon'|'both'|'text'; icon: ReactNode; run: () => void; pressed?: boolean; expanded?: boolean; className?: string };
export function CardActions({ controls, actions, slot }: { controls?: ControlMap; actions: CardAction[]; slot: 'header'|'footer' }) {
  return <div className="card-actions">{actions.map(action => {
    const spec=control(controls,action.id,{appearance:action.defaultAppearance??'icon'}), target=spec.placement === 'footer'||spec.placement?.startsWith('bottom')?'footer':'header';
    return spec.visible===false || target!==slot ? null : <button key={action.id} type="button" className={`icon-button ${action.className??''}`} data-control={action.id} title={spec.tooltip??action.label} aria-label={spec.label||action.label} aria-pressed={action.pressed} aria-expanded={action.expanded} style={controlStyle(spec)} onClick={action.run}><ControlContent spec={spec} label={action.displayLabel??action.label} icon={action.icon}/></button>;
  })}</div>;
}
export function CardHeading({ agent, title, origin }: { agent: AgentView; title?: string; origin?: string }) {
  const chrome=agent.chrome;
  return <><CardIcon name={agent.icon} status={agent.status}/><div className="agent-title">{control(chrome,'title').visible!==false&&<strong title={chrome?.title?.tooltip}>{chrome?.title?.label||title||agent.name}</strong>}{origin?<span>{origin}</span>:control(chrome,'role').visible!==false&&<span title={chrome?.role?.tooltip}>{chrome?.role?.label||agent.role}</span>}</div></>;
}
export function CardDetails({ agent, origin, sizing, children }: { agent: AgentView; origin?: string; sizing?: string; children?: ReactNode }) {
  const chrome=agent.chrome;
  return <>{origin?<span>{origin}</span>:<>{control(chrome,'status').visible!==false&&<span title={chrome?.status?.tooltip}>{chrome?.status?.label||(agent.status==='active'?'LIVE':agent.status.toUpperCase())}</span>}{control(chrome,'agentId').visible!==false&&<code title={chrome?.agentId?.tooltip??agent.id}>{chrome?.agentId?.label||agent.agentId}</code>}{control(chrome,'times').visible!==false&&<RunTimes agent={agent}/>}</>}{sizing&&<span className="sizing-label">{sizing.toUpperCase()}</span>}{children}</>;
}
