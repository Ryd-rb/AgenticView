import { useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { CardInteraction } from './CardInteraction.js';
import { fieldValue, type Presentation } from '../shared/component-config.js';
import { componentSchema, type Component } from '../shared/protocol.js';
import { Check, Settings2 } from 'lucide-react';
import { control } from '../shared/control-presentation.js';
import { ComponentControls, ControlContent, controlStyle } from './ControlPresentation.js';

export function presentationStyle(value?: Presentation): CSSProperties {
  return value ? { color:value.color, backgroundColor:value.background, borderColor:value.borderColor, borderStyle:value.borderColor ? 'solid' : undefined, borderWidth:value.borderColor ? 1 : undefined, fontWeight:value.emphasis === 'bold' ? 700 : undefined, opacity:value.emphasis === 'muted' ? .72 : undefined, textAlign:value.align, fontSize:value.fontSize, '--component-spacing':value.density === 'compact' ? '4px' : value.density === 'spacious' ? '16px' : value.density === 'comfortable' ? '8px' : undefined } as CSSProperties : {};
}
function SettingInput({field,value,disabled,change}:{field:string;value:unknown;disabled:boolean;change:(json:string)=>void}) {
  if(field==='configuration.presentation') {
    const current=(value&&typeof value==='object'?value:{}) as Presentation;
    const update=(key:string,value:unknown)=>change(JSON.stringify({...current,[key]:value}));
    return <fieldset disabled={disabled}><legend>Appearance</legend><label>Surface<select aria-label="Appearance surface" value={current.surface??'default'} onChange={event=>update('surface',event.target.value)}>{['default','plain'].map(value=><option key={value}>{value}</option>)}</select></label>{(['color','background','borderColor'] as const).map(key=><label key={key}><span>{key}</span><input aria-label={`Appearance ${key}`} type="color" value={current[key]??'#c8d1e5'} onChange={event=>update(key,event.target.value)}/></label>)}<label>Density<select aria-label="Appearance density" value={current.density??'comfortable'} onChange={event=>update('density',event.target.value)}>{['compact','comfortable','spacious'].map(value=><option key={value}>{value}</option>)}</select></label><label>Emphasis<select aria-label="Appearance emphasis" value={current.emphasis??'normal'} onChange={event=>update('emphasis',event.target.value)}>{['normal','bold','muted'].map(value=><option key={value}>{value}</option>)}</select></label><label>Alignment<select aria-label="Appearance alignment" value={current.align??'left'} onChange={event=>update('align',event.target.value)}>{['left','center','right'].map(value=><option key={value}>{value}</option>)}</select></label><label>Text size<input aria-label="Appearance text size" type="number" min={12} max={24} value={current.fontSize??14} onChange={event=>update('fontSize',Number(event.target.value))}/></label></fieldset>;
  }
  if(typeof value==='boolean') return <input aria-label={`Configure ${field}`} type="checkbox" disabled={disabled} checked={value} onChange={event=>change(JSON.stringify(event.target.checked))}/>;
  if(typeof value==='number') return <input aria-label={`Configure ${field}`} type="number" step="any" disabled={disabled} value={value} onChange={event=>change(JSON.stringify(Number(event.target.value)))}/>;
  if(typeof value==='string') return <input aria-label={`Configure ${field}`} type="text" maxLength={16384} disabled={disabled} value={value} onChange={event=>change(JSON.stringify(event.target.value))}/>;
  return null;
}
export function ComponentSettings({ component, runId }: {component:Component;runId:string}) {
  const active=useContext(CardInteraction), inherited=useContext(ComponentControls), fields=component.configuration?.manualFields ?? [];
  const controls=component.configuration?.controls ?? inherited;
  const spec=control(controls,'configure',{label:'Configure component',appearance:'text',variant:'quiet',mode:'disclosure',placement:'footer'});
  const saveSpec=control(controls,'save',{label:'Save component settings',appearance:'text',variant:'quiet'});
  const [open,setOpen]=useState(spec.initiallyOpen??false);
  const [values,setValues]=useState<Record<string,string>>({}), [error,setError]=useState(''), [busy,setBusy]=useState(false), [saved,setSaved]=useState(false);
  const controller=useRef<AbortController|undefined>(undefined);
  useEffect(()=>()=>controller.current?.abort(),[]);
  useEffect(()=>setOpen(spec.initiallyOpen??false),[spec.initiallyOpen]);
  if (!fields.length || spec.visible===false) return null;
  const save=async()=>{
    if (!active || busy) return;
    try {
      const changes=Object.fromEntries(fields.filter(field=>Object.hasOwn(values,field)).map(field=>[field,JSON.parse(values[field]!)]));
      if (!Object.keys(changes).length) return;
      const candidate=structuredClone(component) as unknown as Record<string,unknown>;
      for (const [path,value] of Object.entries(changes)) { const parts=path.split('.'); let target=candidate; for(const part of parts.slice(0,-1)) { if (!target[part]) target[part]={}; target=target[part] as Record<string,unknown>; } target[parts.at(-1)!]=value; }
      componentSchema.parse(candidate);
      setBusy(true);setError('');setSaved(false);
      const request=new AbortController();controller.current=request;
      const response=await fetch(`/api/agents/${encodeURIComponent(runId)}/components/${encodeURIComponent(component.id)}/configure`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected:component,changes}),signal:request.signal});
      if(response.status===401) window.dispatchEvent(new Event('agenticview:unauthorized'));
      const result=await response.json();if(!response.ok) throw new Error(result.error ?? 'Settings could not be saved');
      setValues({});setSaved(true);
    }catch(failure){if(!(failure instanceof DOMException && failure.name==='AbortError'))setError(failure instanceof Error?failure.message:'Invalid settings');}finally{setBusy(false);}
  };
  const label=spec.label||'Configure component', heading=<ControlContent spec={spec} label="Configure component" icon={<Settings2 size={14}/>}/>;
  const editor=<><p>Changes are saved to this card. Only fields enabled by its publisher are editable. Conditions use data and context field paths.</p>{fields.map(field=>{
    let value=fieldValue(component,field);try{if(Object.hasOwn(values,field))value=JSON.parse(values[field]!);}catch{/* Keep invalid JSON visible until corrected. */}
    const change=(json:string)=>{setValues(previous=>({...previous,[field]:json}));setSaved(false);};
    const structured=field==='configuration.presentation'||['string','number','boolean'].includes(typeof value);
    return <div className="component-setting" key={field}><strong>{field}</strong>{structured&&<SettingInput field={field} value={value} disabled={!active||busy} change={change}/>}<details open={!structured}><summary>Advanced JSON</summary><textarea aria-label={`JSON ${field}`} disabled={!active||busy} maxLength={131072} rows={4} value={values[field]??JSON.stringify(value??null,null,2)} onChange={event=>change(event.target.value)} spellCheck={false}/></details></div>;
  })}{error&&<p role="alert">{error}</p>}{saved&&<p role="status">Settings saved</p>}{saveSpec.visible!==false&&<button type="button" data-control="save" data-control-variant={saveSpec.variant} aria-label={saveSpec.label||'Save component settings'} title={saveSpec.tooltip} style={controlStyle(saveSpec)} disabled={!active||busy||!Object.keys(values).length} onClick={()=>void save()}><ControlContent spec={saveSpec} label="Save component settings" icon={<Check size={14}/>}/></button>}</>;
  return spec.mode==='panel' ? <section className="component-settings component-settings-panel" data-control="configure" data-control-placement={spec.placement} aria-label={label} title={spec.tooltip}><h4 data-control-variant={spec.variant} style={controlStyle(spec)}>{heading}</h4>{editor}</section> : <details className="component-settings" data-control="configure" data-control-placement={spec.placement} open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary aria-label={label} title={spec.tooltip} data-control-variant={spec.variant} style={controlStyle(spec)}>{heading}</summary>{editor}</details>;
}
