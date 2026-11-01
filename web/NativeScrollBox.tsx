import {registerLogicalScroll,readScrollAxis,seekScrollAxis,type LogicalViewport} from './logicalScroll.js';
import React,{useCallback,useContext,useId,useImperativeHandle,useLayoutEffect,useRef,useState,type CSSProperties,type HTMLAttributes,type KeyboardEvent,type PointerEvent,type Ref} from 'react';
import {CardInteraction} from './CardInteraction.js';
import {useRenderUpdates} from './RenderActivity.js';

type Metrics={width:number;height:number;clientWidth:number;clientHeight:number;x:number;y:number;left:number;top:number;boxWidth:number;boxHeight:number};
type Axis='x'|'y';
type Props=HTMLAttributes<HTMLDivElement>&{[key:`data-${string}`]:string|number|boolean|undefined}&{ref?:Ref<HTMLDivElement>;frameStyle?:CSSProperties;virtualHeight?:number;onViewportChange?:(viewport:LogicalViewport)=>void};
const empty:Metrics={width:0,height:0,clientWidth:0,clientHeight:0,x:0,y:0,left:0,top:0,boxWidth:0,boxHeight:0};
/** Opt-in LTR viewport. The ref and all ordinary DIV props belong to
 * the real inner scroller; rails are external siblings, never scroll children. */
export function NativeScrollBox({ref:forwarded,children,style,frameStyle,id,virtualHeight,onViewportChange,...props}:Props){
 const viewport=useRef<HTMLDivElement>(null),container=useRef<HTMLDivElement>(null),observer=useRef<ResizeObserver|null>(null),observed=useRef(new Set<Element>()),frame=useRef<number|null>(null),drag=useRef<{axis:Axis;pointer:number;grab:number;button:HTMLButtonElement}|null>(null);
 const manual=useContext(CardInteraction),updates=useRenderUpdates(),authority=useRef({manual,updates});authority.current={manual,updates};
 const virtual=virtualHeight!==undefined&&Number.isFinite(virtualHeight)&&virtualHeight>=0&&virtualHeight<=Number.MAX_SAFE_INTEGER;
 const virtualConfig=useRef({enabled:virtual,height:virtualHeight??0,onViewportChange});virtualConfig.current={enabled:virtual,height:virtualHeight??0,onViewportChange};
 const logicalY=useRef(0),notified=useRef<LogicalViewport|null>(null);
 const logicalState=useCallback(()=>{const element=viewport.current,config=virtualConfig.current;if(!element||!config.enabled)return null;const height=config.height+(element.scrollWidth>element.clientWidth+.5?12:0),clientHeight=element.clientHeight;if(!Number.isFinite(height)||height<0||height>Number.MAX_SAFE_INTEGER||!Number.isFinite(clientHeight)||clientHeight<0)return null;return{y:Math.max(0,Math.min(Math.max(0,height-clientHeight),logicalY.current)),height,clientHeight};},[]);
 const notify=useCallback(()=>{const state=logicalState();if(!state||!authority.current.updates)return;logicalY.current=state.y;const before=notified.current;if(!before||before.y!==state.y||before.height!==state.height||before.clientHeight!==state.clientHeight){notified.current=state;virtualConfig.current.onViewportChange?.(state);}},[logicalState]);
 const generated=useId().replaceAll(':',''),viewportId=id??`native-scroll-${generated}`;
 const [metrics,setMetrics]=useState<Metrics>(empty),current=useRef(metrics);current.current=metrics;
 useImperativeHandle(forwarded,()=>viewport.current!,[]);
 const measure=useCallback(()=>{
  if(!authority.current.updates)return;const element=viewport.current;if(!element)return;
  const logical=virtualConfig.current.enabled?logicalState():null;if(virtualConfig.current.enabled&&!logical)return;
  const next={width:element.scrollWidth,height:logical?logical.height:element.scrollHeight,clientWidth:element.clientWidth,clientHeight:element.clientHeight,x:element.scrollLeft,y:logical?logical.y:element.scrollTop,left:element.offsetLeft,top:element.offsetTop,boxWidth:element.offsetWidth,boxHeight:element.offsetHeight};
  if(Object.values(next).some(value=>!Number.isFinite(value))||[next.width,next.height,next.clientWidth,next.clientHeight,next.x,next.y,next.boxWidth,next.boxHeight].some(value=>value<0))return;
  notify();
  setMetrics(previous=>Object.keys(next).every(key=>next[key as keyof Metrics]===previous[key as keyof Metrics])?previous:next);
 },[logicalState,notify]);
 const schedule=useCallback(()=>{if(!authority.current.updates||frame.current!==null)return;if(typeof requestAnimationFrame==='undefined'){measure();return;}frame.current=requestAnimationFrame(()=>{frame.current=null;measure();});},[measure]);
 const observeChildren=useCallback(()=>{
  const element=viewport.current,ro=observer.current;if(!element||!ro)return;
  const next=new Set(Array.from(element.children).slice(0,32));for(const child of observed.current)if(!next.has(child))ro.unobserve(child);for(const child of next)if(!observed.current.has(child))ro.observe(child);observed.current=next;
 },[]);
 const release=useCallback(()=>{const held=drag.current;drag.current=null;if(held){try{if(held.button.hasPointerCapture?.(held.pointer))held.button.releasePointerCapture(held.pointer);}catch(error){if(!(error instanceof DOMException))throw error;}}},[]);
 useLayoutEffect(()=>{
  if(!virtual)return;const element=viewport.current;if(!element)return;
  if(element.scrollTop!==0)element.scrollTop=0; // Physical Y never represents the virtual offset.
  return registerLogicalScroll(element,{read:()=>authority.current.updates?logicalState():notified.current,seek:value=>{if(!authority.current.manual||!authority.current.updates||!virtualConfig.current.enabled||!Number.isFinite(value))return false;const state=logicalState();if(!state)return false;logicalY.current=Math.max(0,Math.min(Math.max(0,state.height-state.clientHeight),value));notify();schedule();return true;}});
 },[virtual,logicalState,notify,schedule]);
 useLayoutEffect(()=>{if(updates&&virtual){notify();schedule();}},[updates,virtual,virtualHeight,notify,schedule]);
 useLayoutEffect(()=>{
  if(!updates)return;const element=viewport.current;if(!element)return;
  let alive=true;const resize=()=>{if(alive)schedule();};
  observer.current=typeof ResizeObserver==='undefined'?null:new ResizeObserver(resize);observer.current?.observe(element);if(container.current)observer.current?.observe(container.current);observeChildren();
  element.addEventListener('scroll',schedule,{passive:true});element.ownerDocument.fonts?.addEventListener('loadingdone',resize);measure();
  return()=>{alive=false;observer.current?.disconnect();observer.current=null;observed.current.clear();element.removeEventListener('scroll',schedule);element.ownerDocument.fonts?.removeEventListener('loadingdone',resize);if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null;}release();};
 },[updates,measure,schedule,observeChildren,release]);
 const previousChildren=useRef(children);
 useLayoutEffect(()=>{if(updates){observeChildren();if(previousChildren.current!==children){previousChildren.current=children;schedule();}}},[children,updates,observeChildren,schedule]);
 useLayoutEffect(()=>{if(updates)schedule();},[style,props.className,frameStyle,updates,schedule]);
 useLayoutEffect(()=>{if(!manual)release();},[manual,release]);
 function axisMetrics(axis:Axis){const m=current.current,size=axis==='x'?m.clientWidth:m.clientHeight,total=axis==='x'?m.width:m.height,max=Math.max(0,total-size),value=Math.max(0,Math.min(max,axis==='x'?m.x:m.y)),ratio=max>0?Math.min(.98,Math.max(size/Math.max(1,total),Math.min(.9,20/Math.max(1,size)))):1;return{size,total,max,value,ratio};}
 function write(axis:Axis,value:number){if(!authority.current.manual||!authority.current.updates)return;const element=viewport.current;if(!element)return;const {max}=axisMetrics(axis),next=Math.max(0,Math.min(max,value));seekScrollAxis(element,axis,next);schedule();}
 function seek(event:PointerEvent<HTMLButtonElement>,axis:Axis,grab:number){const rect=event.currentTarget.getBoundingClientRect(),length=axis==='x'?rect.width:rect.height,start=axis==='x'?rect.left:rect.top,coordinate=axis==='x'?event.clientX:event.clientY,{max,ratio}=axisMetrics(axis);if(!(length>0)||!Number.isFinite(length)||!Number.isFinite(coordinate)||ratio>=1)return;write(axis,((coordinate-start)/length-grab)/(1-ratio)*max);}
 function pointerDown(event:PointerEvent<HTMLButtonElement>,axis:Axis){if(!authority.current.manual||!authority.current.updates||event.button!==0)return;event.preventDefault();event.stopPropagation();event.currentTarget.focus({preventScroll:true});const rect=event.currentTarget.getBoundingClientRect(),length=axis==='x'?rect.width:rect.height,start=axis==='x'?rect.left:rect.top,coordinate=axis==='x'?event.clientX:event.clientY,{value,max,ratio}=axisMetrics(axis);if(!(length>0)||max<=0)return;
  const thumb=(event.target as Element).closest('[data-native-scroll-thumb]'),grab=thumb?(coordinate-start)/length-value/max*(1-ratio):ratio/2;
  drag.current={axis,pointer:event.pointerId,grab,button:event.currentTarget};event.currentTarget.setPointerCapture?.(event.pointerId);seek(event,axis,grab);
 }
 function pointerMove(event:PointerEvent<HTMLButtonElement>){const held=drag.current;if(!held||held.pointer!==event.pointerId||!authority.current.manual||!authority.current.updates)return;event.preventDefault();event.stopPropagation();seek(event,held.axis,held.grab);}
 function pointerUp(event:PointerEvent<HTMLButtonElement>){if(drag.current?.pointer===event.pointerId){event.preventDefault();event.stopPropagation();release();}}
 function key(event:KeyboardEvent<HTMLElement>,axis:Axis){if(!authority.current.manual||!authority.current.updates||event.altKey||event.ctrlKey||event.metaKey)return;const {max,size}=axisMetrics(axis),value=viewport.current?readScrollAxis(viewport.current,axis).value:0;let next:number;
  if(event.key==='Home')next=0;else if(event.key==='End')next=max;else if(event.key==='ArrowDown'||event.key==='ArrowRight')next=value+40;else if(event.key==='ArrowUp'||event.key==='ArrowLeft')next=value-40;else if(event.key==='PageDown'||event.key===' ')next=value+size*.9*(event.shiftKey?-1:1);else if(event.key==='PageUp')next=value-size*.9;else return;
  event.preventDefault();event.stopPropagation();write(axis,next);
 }
 const x=axisMetrics('x'),y=axisMetrics('y');
 const rail=(axis:Axis)=>{const a=axis==='x'?x:y;if(a.max<=.5||a.size<=0)return null;const position=a.max?a.value/a.max*(1-a.ratio):0;
  const track:CSSProperties={position:'absolute',margin:0,padding:0,border:0,borderRadius:0,minWidth:0,minHeight:0,opacity:1,background:'var(--native-scroll-track,transparent)',color:'inherit',fontSize:0,lineHeight:0,boxShadow:'none',touchAction:'none',transition:'none',cursor:'default',...(axis==='x'?{left:metrics.left,top:metrics.top+metrics.boxHeight-12,width:Math.max(0,metrics.boxWidth-(y.max>.5?12:0)),height:12}:{left:metrics.left+metrics.boxWidth-12,top:metrics.top,height:Math.max(0,metrics.boxHeight-(x.max>.5?12:0)),width:12})};
  const thumb:CSSProperties={position:'absolute',display:'block',borderRadius:4,background:'var(--native-scroll-thumb,currentColor)',opacity:1,...(axis==='x'?{left:`${position*100}%`,width:`${a.ratio*100}%`,top:3,height:6}:{top:`${position*100}%`,height:`${a.ratio*100}%`,left:3,width:6})};
  return <button type="button" role="scrollbar" data-native-scrollbar={axis} aria-label={axis==='x'?'Horizontal scroll':'Vertical scroll'} aria-controls={viewportId} aria-orientation={axis==='x'?'horizontal':'vertical'} aria-valuemin={0} aria-valuemax={a.max} aria-valuenow={a.value} aria-disabled={!manual||!updates} tabIndex={manual&&updates?0:-1} style={track} onPointerDown={event=>pointerDown(event,axis)} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={event=>{if(drag.current?.pointer===event.pointerId&&drag.current.button===event.currentTarget)drag.current=null;}} onKeyDown={event=>key(event,axis)} onClick={event=>{event.preventDefault();event.stopPropagation();}}><span data-native-scroll-thumb={axis} aria-hidden="true" style={thumb}/></button>;
 };
 return <div ref={container} data-native-scroll-frame="true" style={{minWidth:0,minHeight:0,...frameStyle,position:!frameStyle?.position||frameStyle.position==='static'?'relative':frameStyle.position}}><div {...props} role={props.role??'region'} aria-label={props['aria-label']??(props['aria-labelledby']?undefined:'Scrollable content')} id={viewportId} ref={viewport} onKeyDown={event=>{props.onKeyDown?.(event);if(!event.defaultPrevented&&virtual&&event.target===event.currentTarget)key(event,event.key==='ArrowLeft'||event.key==='ArrowRight'?'x':'y');}} data-native-scrollport="true" data-logical-scroll={virtual?'y':undefined} style={{...style,overflow:'hidden',overflowX:'hidden',overflowY:'hidden',scrollbarGutter:'stable'}}>{children}<div data-native-scroll-tail="true" aria-hidden="true" style={{height:x.max>.5?12:0,width:1,minHeight:0,pointerEvents:'none'}}/></div>{rail('x')}{rail('y')}</div>;
}
