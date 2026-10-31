import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { control, type ControlId, type ControlMap, type ControlPresentation } from '../shared/control-presentation.js';
import { NativeIcon } from './CardIcon.js';

export const ComponentControls = createContext<ControlMap | undefined>(undefined);
export function useControl(id: ControlId, defaults: ControlPresentation = {}): ControlPresentation { return control(useContext(ComponentControls), id, defaults); }
export function ControlContent({ spec, label, icon }: { spec: ControlPresentation; label: string; icon: ReactNode }) {
  const appearance = spec.appearance ?? 'text', text = spec.label || label;
  return <>{appearance !== 'text' && <span className="control-presentation-icon" aria-hidden="true" style={{ display: 'inline-flex', verticalAlign: 'middle' }}>{spec.icon ? <NativeIcon name={spec.icon}/> : icon}</span>}{appearance !== 'icon' && <span className="control-presentation-label">{text}</span>}</>;
}
export function controlStyle(spec: ControlPresentation): CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap:'var(--component-gap,6px)', ...(spec.variant === 'primary' ? { background: 'var(--accent,#b5a2fa)', color: '#171421', borderRadius:'var(--component-border-radius,5px)', paddingTop:'var(--component-control-padding-top,var(--component-control-padding,5px))',paddingBottom:'var(--component-control-padding-bottom,var(--component-control-padding,5px))',paddingLeft:'var(--component-control-padding-left,var(--component-control-padding,8px))',paddingRight:'var(--component-control-padding-right,var(--component-control-padding,8px))' } : spec.variant === 'bare' ? { background: 'transparent', borderColor: 'transparent' } : {}) };
}
export function controlPlacementStyle(spec: ControlPresentation): CSSProperties {
  const right = spec.placement?.endsWith('right');
  return { display: 'flex', justifyContent: right ? 'flex-end' : 'flex-start', marginBlock: 6, minWidth: 0 };
}
export function ControlContainer({ spec, children }: { spec: ControlPresentation; children: ReactNode }) {
  return <div className="control-presentation-slot" data-control-placement={spec.placement ?? 'footer'} style={controlPlacementStyle(spec)}><div style={{ minWidth: 0, maxWidth: '100%' }}>{children}</div></div>;
}
