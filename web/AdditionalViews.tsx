import { useId, useState } from 'react';
import { domainFraction, formatNativeNumber, type AdditionalComponent } from '../shared/native-extensions.js';
import { ChevronDown } from 'lucide-react';
import { useControl, ControlContent, controlStyle } from './ControlPresentation.js';

type StepperData = Extract<AdditionalComponent, { kind: 'stepper' }>['data'];
function Stepper({ data, manual }: { data: StepperData; manual: boolean }) {
  const selectSpec=useControl('stepSelect',{appearance:'both'}),captionSpec=useControl('caption');
  const [selected, setSelected] = useState<string | undefined>(), selectable = data.features?.select === true&&selectSpec.visible!==false;
  const current = selectable && data.items.some(item => item.id === selected) ? selected : data.items.some(item => item.id === data.selectedId) ? data.selectedId : data.items.find(item => item.state === 'active')?.id ?? data.items[0]?.id;
  const detail = data.items.find(item => item.id === current), completed = data.items.filter(item => item.state === 'completed').length;
  const detailId = `step-${useId()}`;
  return <div className={`native-stepper stepper-${data.orientation ?? 'vertical'}`}>{captionSpec.visible!==false&&<p className="native-meta" title={captionSpec.tooltip}>{captionSpec.label?captionSpec.label+' · ':''}{completed} of {data.items.length} steps completed</p>}
    <ol aria-label="Process steps">{data.items.map((item, index) => <li key={item.id} className={`step-state-${item.state}`} aria-current={item.state === 'active' ? 'step' : undefined}>
      {selectable ? <button data-control="stepSelect" disabled={!manual} type="button" aria-label={selectSpec.label?`${selectSpec.label}: ${item.label}`:item.label} title={selectSpec.tooltip} style={controlStyle(selectSpec)} aria-pressed={current === item.id} aria-controls={detailId} onClick={() => setSelected(item.id)}><ControlContent spec={selectSpec.label?{...selectSpec,label:`${selectSpec.label}: ${item.label}`}:selectSpec} label={item.label} icon={<span className="step-number" aria-hidden="true">{index+1}</span>}/><small>{item.state}</small></button> : <div><span className="step-number" aria-hidden="true">{index + 1}</span><span>{item.label}<small>{item.state}</small></span></div>}
      {!selectable && item.detail && <p className="step-detail">{item.detail}</p>}
    </li>)}</ol>{selectable && detail && <div id={detailId} className="step-detail" role="region" aria-label={`${detail.label} details`}><strong>{detail.label}</strong>{detail.detail && <p>{detail.detail}</p>}</div>}
    {!data.items.length && <p className="native-note">No process steps reported</p>}
  </div>;
}

function Bullet({ component }: { component: Extract<AdditionalComponent, { kind: 'bullet' }> }) {
  const legendSpec=useControl('legend');
  const { data } = component, format = (n: number) => formatNativeNumber(n, data.format), position = (n: number) => domainFraction(n, data.min, data.max) * 100;
  const ranges = data.ranges ?? [], state = ranges.find(range => data.value <= range.end), target = data.target;
  let start = data.min;
  return <div className="native-bullet"><div className="bullet-value"><strong>{format(data.value)} {data.unit}</strong><span>{data.label ?? component.title}</span></div>
    <div className="bullet-track" role="meter" aria-label={(data.label ?? component.title) || 'Target comparison'} aria-valuemin={data.min} aria-valuemax={data.max} aria-valuenow={Math.max(data.min, Math.min(data.max, data.value))} aria-valuetext={`${format(data.value)} ${data.unit ?? ''}${target === undefined ? '' : `; target ${format(target)}`}${state ? '; ' + state.label : ''}`}>
      {ranges.map(range => { const left = position(start), width = position(range.end) - left; start = range.end; return <span key={range.id} className={`bullet-range tone-${range.tone ?? 'neutral'}`} style={{ left: left + '%', width: width + '%' }} title={range.label} />; })}
      <span className="bullet-measure" style={{ width: position(data.value) + '%' }} />{target !== undefined && <span className="bullet-target" style={{ left: position(target) + '%' }} title={`Target ${format(target)}`} />}
    </div>
    <div className="bullet-scale"><span>{format(data.min)}</span>{target !== undefined && <span>Target: {format(target)}</span>}<span>{format(data.max)}</span></div>
    {(data.value < data.min || data.value > data.max) && <p className="native-note">Reported value is outside the displayed range.</p>}
    {target !== undefined && (target < data.min || target > data.max) && <p className="native-note">Target is outside the displayed range.</p>}
    {ranges.length > 0 && legendSpec.visible!==false && <ul className="bullet-legend" aria-label={legendSpec.label||'Comparison ranges'} title={legendSpec.tooltip}>{ranges.map(range => <li key={range.id} className={`tone-${range.tone ?? 'neutral'}`}>{range.label}: up to {format(range.end)}</li>)}</ul>}
  </div>;
}

function Accordion({ data, manual }: { data: Extract<AdditionalComponent, { kind: 'accordion' }>['data']; manual: boolean }) {
  const expandSpec=useControl('expand',{appearance:'both'});
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map()), prefix = `section-${useId()}`, expandable = data.features?.expand !== false&&expandSpec.visible!==false&&expandSpec.mode!=='panel';
  const singleId = data.multiple === false ? data.sections.find(section => overrides.get(section.id) === true)?.id ?? data.sections.find(section => section.open && overrides.get(section.id) !== false)?.id ?? (expandSpec.initiallyOpen?data.sections.find(section=>overrides.get(section.id)!==false)?.id:undefined) : undefined;
  const open = (section: typeof data.sections[number]) => !expandable ? section.open ?? false : data.multiple === false ? section.id === singleId : overrides.get(section.id) ?? section.open ?? expandSpec.initiallyOpen ?? false;
  const toggle = (id: string, wasOpen: boolean) => setOverrides(previous => {
    const currentIds = new Set(data.sections.map(section => section.id)), next = new Map([...previous].filter(([key]) => currentIds.has(key)));
    if (data.multiple === false) for (const section of data.sections) next.set(section.id, false);
    next.set(id, !wasOpen); return next;
  });
  return <div className="native-accordion">{data.sections.map(section => {
    const expanded = open(section), id = `${prefix}-${section.id}`;
    return <section key={section.id} className={`accordion-section tone-${section.tone ?? 'neutral'}`}>
      <h4>{expandable ? <button data-control="expand" disabled={!manual} type="button" id={`${id}-label`} aria-label={expandSpec.label?`${expandSpec.label}: ${section.title}`:section.title} title={expandSpec.tooltip} style={controlStyle(expandSpec)} aria-expanded={expanded} aria-controls={id} onClick={() => toggle(section.id, expanded)}><ControlContent spec={expandSpec.label?{...expandSpec,label:`${expandSpec.label}: ${section.title}`}:expandSpec} label={section.title} icon={<ChevronDown size={13}/>}/></button> : <span id={`${id}-label`}>{section.title}</span>}</h4>
      {(expanded || !expandable) && <div id={id} role="region" aria-labelledby={`${id}-label`} className="accordion-text">{section.text}</div>}
    </section>;
  })}{!data.sections.length && <p className="native-note">No sections reported</p>}</div>;
}

export function AdditionalView({ component, manual = true }: { component: AdditionalComponent; manual?: boolean }) {
  switch (component.kind) { case 'stepper': return <Stepper data={component.data} manual={manual} />; case 'bullet': return <Bullet component={component} />; case 'accordion': return <Accordion data={component.data} manual={manual} />; }
}
