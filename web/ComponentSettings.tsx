import { createContext,useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { CardInteraction } from './CardInteraction.js';
import { fieldValue, type Presentation, type Spacing } from '../shared/component-config.js';
import { componentSchema, type Component } from '../shared/protocol.js';
import { Check, Settings2 } from 'lucide-react';
import { control } from '../shared/control-presentation.js';
import { ComponentControls, ControlContent, controlStyle } from './ControlPresentation.js';

export const NativePresentation=createContext<Presentation|undefined>(undefined);
/** Virtual text rows use the same explicit typography as their offset math. */
export function useNativeRowMetrics(fallback:number,defaultFont=12,verticalInset=8){
  const value=useContext(NativePresentation),typography=value?.fontSize!==undefined||value?.lineHeight!==undefined;
  const line=(value?.fontSize??defaultFont)*(value?.lineHeight??1.3);
  return {height:Math.max(value?.rowHeight??fallback,typography?Math.ceil(line)+verticalInset:0),style:typography?{fontSize:value?.fontSize,lineHeight:line+'px'} as CSSProperties:{}};
}

export function presentationStyle(value?: Presentation): CSSProperties {
  if(!value)return {};
  const fonts={system:"'DM Sans',Inter,system-ui,sans-serif",mono:"'Cascadia Code',Consolas,ui-monospace,monospace",serif:"Georgia,'Times New Roman',serif"};
  const style:Record<string,unknown>={color:value.color,backgroundColor:value.background,borderColor:value.borderColor,borderStyle:value.borderColor!==undefined||value.borderWidth!==undefined?'solid':undefined,borderWidth:value.borderWidth??(value.borderColor?1:undefined),borderRadius:value.borderRadius,fontWeight:value.fontWeight??(value.emphasis==='bold'?700:undefined),opacity:value.emphasis==='muted'?.72:undefined,textAlign:value.align,fontSize:value.fontSize,lineHeight:value.lineHeight,fontFamily:value.fontFamily?fonts[value.fontFamily]:undefined,letterSpacing:value.letterSpacing,gap:value.gap,rowGap:value.rowGap,columnGap:value.columnGap,minWidth:value.minWidth,maxWidth:value.maxWidth,minHeight:value.minHeight,maxHeight:value.maxHeight,...(value.maxHeight!==undefined?{overflowY:'auto'}:{}),...(value.maxWidth!==undefined?{overflowX:'auto'}:{}),'--component-spacing':value.density==='compact'?'4px':value.density==='spacious'?'16px':value.density==='comfortable'?'8px':undefined,'--component-motion-duration':value.animation==='subtle'?`${value.animationDurationMs??120}ms`:'0ms'};
  const space=(key:string,spacing:Spacing|undefined,direct=false)=>{if(spacing===undefined)return;if(typeof spacing==='number'){style[`--component-${key}`]=`${spacing}px`;if(direct)style[key]=spacing;}else for(const edge of ['top','right','bottom','left'] as const)if(spacing[edge]!==undefined){style[`--component-${key}-${edge}`]=`${spacing[edge]}px`;if(direct)style[key+edge[0]!.toUpperCase()+edge.slice(1)]=spacing[edge];}};
  space('padding',value.padding,true);space('margin',value.margin,true);space('control-padding',value.controlPadding);space('cell-padding',value.cellPadding);
  for(const [field,css] of [['gap','gap'],['rowGap','row-gap'],['columnGap','column-gap'],['controlHeight','control-height'],['rowHeight','row-height'],['borderWidth','border-width'],['borderRadius','border-radius'],['fontSize','font-size'],['letterSpacing','letter-spacing']] as const)if(value[field]!==undefined)style[`--component-${css}`]=`${value[field]}px`;
  if(value.lineHeight!==undefined)style['--component-line-height']=String(value.lineHeight);if(style.fontWeight!==undefined)style['--component-font-weight']=String(style.fontWeight);if(style.fontFamily!==undefined)style['--component-font-family']=style.fontFamily;
  return style as CSSProperties;
}
const numericPresentation=[['gap','Gap',0,64,.5],['rowGap','Row gap',0,64,.5],['columnGap','Column gap',0,64,.5],['controlHeight','Control height',28,96,1],['rowHeight','Row height',28,120,1],['borderWidth','Border width',0,8,.5],['borderRadius','Border radius',0,48,.5],['fontSize','Text size',10,32,1],['lineHeight','Line height',1,2.5,.1],['fontWeight','Font weight',100,900,1],['letterSpacing','Letter spacing',0,4,.1],['minWidth','Minimum width',0,2400,1],['maxWidth','Maximum width',0,2400,1],['minHeight','Minimum height',0,2400,1],['maxHeight','Maximum height',0,2400,1],['animationDurationMs','Animation duration',0,1000,1]] as const;
function PresentationInput({value,disabled,change}:{value:unknown;disabled:boolean;change:(json:string)=>void}){
  const current=(value&&typeof value==='object'?value:{}) as Presentation;
  const update=(key:string,value:unknown)=>{const next={...current} as Record<string,unknown>;if(value===undefined)delete next[key];else next[key]=value;change(JSON.stringify(next));};
  const number=(raw:string,min:number,max:number,step:number,update:(value:number|undefined)=>void)=>{if(raw===''){update(undefined);return;}const value=Number(raw);if(Number.isFinite(value)&&value>=min&&value<=max&&(step!==1||Number.isInteger(value)))update(value);};
  return <fieldset className="presentation-editor" disabled={disabled}><legend>Appearance</legend>{(['surface','density','emphasis','align','fontFamily','animation'] as const).map(key=>{const choices={surface:['default','plain'],density:['compact','comfortable','spacious'],emphasis:['normal','bold','muted'],align:['left','center','right'],fontFamily:['system','mono','serif'],animation:['none','subtle']}[key];return <label key={key}>{key}<select aria-label={`Appearance ${key}`} value={current[key]??''} onChange={event=>update(key,event.target.value||undefined)}><option value="">Inherit</option>{choices.map(option=><option key={option}>{option}</option>)}</select></label>;})}{(['color','background','borderColor'] as const).map(key=><label key={key}>{key}<input aria-label={`Appearance ${key}`} type="color" value={current[key]??'#c8d1e5'} onChange={event=>update(key,event.target.value)}/></label>)}
    {(['padding','margin','controlPadding','cellPadding'] as const).map(key=><div className="presentation-spacing" key={key}><label>{key}<input aria-label={`Appearance ${key}`} type="number" min={0} max={96} step="0.5" placeholder="Inherit" value={typeof current[key]==='number'?current[key]:''} onChange={event=>number(event.target.value,0,96,.5,value=>update(key,value))}/></label><details><summary>{key} edges</summary>{(['top','right','bottom','left'] as const).map(edge=>{const edges=typeof current[key]==='object'?current[key]:{};return <label key={edge}>{edge}<input aria-label={`Appearance ${key} ${edge}`} type="number" min={0} max={96} step="0.5" placeholder="Inherit" value={edges?.[edge]??''} onChange={event=>number(event.target.value,0,96,.5,value=>{const next={...edges};if(value===undefined)delete next[edge];else next[edge]=value;update(key,Object.keys(next).length?next:undefined);})}/></label>;})}</details></div>)}
    {numericPresentation.map(([key,label,min,max,step])=><label key={key}>{label}<input aria-label={`Appearance ${label.toLowerCase()}`} type="number" min={min} max={max} step={step} placeholder="Inherit" value={current[key]??''} onChange={event=>number(event.target.value,min,max,step,value=>update(key,value))}/></label>)}
  </fieldset>;
}
function SettingInput({field,value,disabled,change}:{field:string;value:unknown;disabled:boolean;change:(json:string)=>void}) {
  if(field==='configuration.presentation') {
    return <PresentationInput value={value} disabled={disabled} change={change}/>;
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
