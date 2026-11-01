import {useCallback,useLayoutEffect,useRef,useState,type CSSProperties,type RefObject} from 'react';
import {useRenderUpdates} from './RenderActivity.js';

type Geometry={table:HTMLTableElement;head:HTMLTableSectionElement;top:number;maximum:number};
/** Normal table flow with a React-owned translated THEAD.
 * Unsupported geometry leaves marker/style absent, preserving CSS sticky. */
export function useNativeTableHeader(viewportRef:RefObject<HTMLElement|null>,tableRef:RefObject<HTMLTableElement|null>){
  const updates=useRenderUpdates(),active=useRef(updates);active.current=updates;
  const [head,setHead]=useState<HTMLTableSectionElement|null>(null),[state,setState]=useState({supported:false,offset:0});
  const applied=useRef(state),geometry=useRef<Geometry|null>(null),attempted=useRef<{table:HTMLTableElement;head:HTMLTableSectionElement}|null>(null),dirty=useRef(true),frame=useRef<number|null>(null);
  applied.current=state;
  const update=useCallback(()=>{
    if(!active.current)return;
    const viewport=viewportRef.current,table=tableRef.current,header=table?.tHead;
    const fail=()=>{geometry.current=null;setState(previous=>previous.supported||previous.offset!==0?{supported:false,offset:0}:previous);};
    if(!viewport||!table||!header){fail();return;}
    if(!dirty.current&&!geometry.current&&attempted.current?.table===table&&attempted.current?.head===header)return;
    if(dirty.current||geometry.current?.table!==table||geometry.current?.head!==header){
      dirty.current=false;
      attempted.current={table,head:header};
      const sections=Array.from(table.children).filter(element=>['THEAD','TBODY','TFOOT','CAPTION'].includes(element.tagName));
      const body=sections.find(element=>element.tagName==='TBODY');
      if(sections[0]!==header||sections.some(element=>element.tagName==='CAPTION')||sections.filter(element=>element.tagName==='THEAD').length!==1||(body?.children.length??0)>2000||header.querySelectorAll('th,td').length>64){fail();return;}
      const view=table.ownerDocument.defaultView;if(!view){fail();return;}
      const style=view.getComputedStyle(table),viewportStyle=view.getComputedStyle(viewport);
      const px=(text:string)=>/^[0-9]+(?:\.[0-9]+)?px$/.test(text)?Number.parseFloat(text):NaN;
      const local=(axis:'width'|'height')=>{let value=px(style[axis]);if(style.boxSizing!=='border-box')for(const side of axis==='width'?['left','right']:['top','bottom'])value+=px(style.getPropertyValue(`padding-${side}`))+px(style.getPropertyValue(`border-${side}-width`));return value;};
      const rect=table.getBoundingClientRect(),headerRect=header.getBoundingClientRect(),viewportRect=viewport.getBoundingClientRect(),width=local('width'),height=local('height'),scale=rect.width/width,scaleY=rect.height/height,border=px(viewportStyle.borderTopWidth);
      if(!(scale>0)||!Number.isFinite(scale)||!(scaleY>0)||Math.abs(scale-scaleY)>Math.max(scale,scaleY)*.001||!Number.isFinite(border)||!(viewport.clientHeight>0)||style.borderCollapse!=='collapse'&&style.borderSpacing.split(/\s+/).some(value=>Number.parseFloat(value)!==0)){fail();return;}
      const headerHeight=headerRect.height/scale,headerTop=(headerRect.top-rect.top)/scale-(applied.current.supported?applied.current.offset:0),top=(rect.top-viewportRect.top)/scale+viewport.scrollTop-border;
      if(!(headerHeight>0)||headerHeight>height||!Number.isFinite(top)||!Number.isFinite(headerTop)||Math.abs(headerTop)>.5){fail();return;}
      geometry.current={table,head:header,top,maximum:Math.max(0,height-headerHeight)};
    }
    const g=geometry.current;if(!g)return;
    if(!Number.isFinite(viewport.scrollTop)){fail();return;}
    const offset=Math.max(0,Math.min(g.maximum,viewport.scrollTop-g.top));
    setState(previous=>previous.supported&&Math.abs(previous.offset-offset)<.000001?previous:{supported:true,offset});
  },[viewportRef,tableRef]);
  const schedule=useCallback(()=>{if(!active.current||frame.current!==null)return;if(typeof requestAnimationFrame==='undefined'){update();return;}frame.current=requestAnimationFrame(()=>{frame.current=null;update();});},[update]);
  useLayoutEffect(()=>{if(!updates)return;const next=tableRef.current?.tHead??null;if(next!==head)setHead(next);});
  useLayoutEffect(()=>{
    if(!updates||!head)return;
    const viewport=viewportRef.current,table=tableRef.current;if(!viewport||!table)return;
    let alive=true;const sizes=new Map<Element,string>();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(entries=>{if(!alive)return;let changed=false;for(const entry of entries){const size=`${entry.contentRect.width}:${entry.contentRect.height}`;if(sizes.get(entry.target)!==size){sizes.set(entry.target,size);changed=true;}}if(changed){dirty.current=true;schedule();}});
    observer?.observe(viewport);observer?.observe(table);observer?.observe(head);
    const font=()=>{if(alive){dirty.current=true;schedule();}};
    viewport.addEventListener('scroll',schedule,{passive:true});table.ownerDocument.fonts?.addEventListener('loadingdone',font);
    dirty.current=true;update();
    return()=>{alive=false;observer?.disconnect();viewport.removeEventListener('scroll',schedule);table.ownerDocument.fonts?.removeEventListener('loadingdone',font);if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null;}};
  },[updates,head,viewportRef,tableRef,schedule,update]);
  const style:CSSProperties|undefined=state.supported&&state.offset>0?{position:'relative',transform:`translateY(${state.offset}px)`,zIndex:2,transition:'none'}:undefined;
  return{style,marker:state.supported?'translated' as const:undefined,supported:state.supported,offset:state.offset};
}
