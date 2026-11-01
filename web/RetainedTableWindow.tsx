import React,{useCallback,useLayoutEffect,useRef,useState,type CSSProperties} from 'react';
import {useRenderUpdates} from './RenderActivity.js';

type Options={rowCount:number;revision:string|number;enabled:boolean;overscanPixels?:number;horizontal?:boolean;columnOverscanPixels?:number};
type LocalBox={element:HTMLElement;width:number;height:number;left:number;top:number};
type Clip=LocalBox&{x:boolean;y:boolean};
type Geometry={revision:string|number;epoch:number;count:number;prefix:number[];columns:number[];columnPrefix:number[];tableWidth:number;scale:number;bodyTop:number;tableLeft:number;headerHeight:number;horizontal:boolean;clips:Clip[];viewportBox:LocalBox|null};
type Range={start:number;end:number};
const MAX_ROWS=2000,MAX_COLUMNS=64;
const px=(value:string)=>/^[0-9]+(?:\.[0-9]+)?px$/.test(value)?Number.parseFloat(value):NaN;
function localBox(element:HTMLElement):LocalBox|null{
  const style=element.ownerDocument.defaultView?.getComputedStyle(element);if(!style)return null;
  const css=style;
  const left=px(style.borderLeftWidth),top=px(style.borderTopWidth);
  function size(axis:'width'|'height'){let value=px(css[axis]);if(css.boxSizing!=='border-box')for(const side of axis==='width'?['left','right']:['top','bottom'])value+=px(css.getPropertyValue(`padding-${side}`))+px(css.getPropertyValue(`border-${side}-width`));return value;}
  const width=size('width'),height=size('height');return width>0&&height>0&&[width,height,left,top].every(Number.isFinite)?{element,width,height,left,top}:null;
}
function localClips(viewport:HTMLElement):Clip[]|null{
  const result:Clip[]=[];let ancestor=viewport.parentElement,depth=0;
  while(ancestor&&ancestor!==viewport.ownerDocument.body&&ancestor!==viewport.ownerDocument.documentElement){
    if(depth++>=16)return null;
    const style=ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor);if(!style)return null;
    const paint=style.contain?.split(/\s+/).some(value=>['paint','strict','content'].includes(value));
    const clips=(value:string)=>['hidden','clip','auto','scroll'].includes(value);
    const x=!!paint||clips(style.overflowX||style.overflow),y=!!paint||clips(style.overflowY||style.overflow);
    if(x||y){const box=localBox(ancestor);if(!box)return null;result.push({...box,x,y});}
    if(ancestor.classList.contains('card-surface'))break;
    ancestor=ancestor.parentElement;
  }
  return result;
}
function visibleBand(g:Geometry,viewport:HTMLElement){
  const width=viewport.clientWidth,height=viewport.clientHeight;
  if(!g.clips.length)return{left:0,top:0,right:width,bottom:height};
  const box=g.viewportBox;if(!box)return null;
  const rect=viewport.getBoundingClientRect(),scale=rect.width/box.width,scaleY=rect.height/box.height;
  if(!(scale>0)||!Number.isFinite(scale)||!(scaleY>0)||![rect.left,rect.top].every(Number.isFinite)||Math.abs(scale-scaleY)>Math.max(scale,scaleY)*.001)return null;
  const originX=rect.left+box.left*scale,originY=rect.top+box.top*scale;
  let left=originX,top=originY,right=left+width*scale,bottom=top+height*scale;
  for(const clip of g.clips){const r=clip.element.getBoundingClientRect(),s=r.width/clip.width,sy=r.height/clip.height;if(!(s>0)||!Number.isFinite(s)||!(sy>0)||![r.left,r.top].every(Number.isFinite)||clip.x&&clip.element.clientWidth<=0||clip.y&&clip.element.clientHeight<=0||Math.abs(s-sy)>Math.max(s,sy)*.001)return null;
    const x=r.left+clip.left*s,y=r.top+clip.top*s;
    if(clip.x){left=Math.max(left,x);right=Math.min(right,x+clip.element.clientWidth*s);}
    if(clip.y){top=Math.max(top,y);bottom=Math.min(bottom,y+clip.element.clientHeight*s);}
  }
  const clamp=(value:number,max:number)=>Math.max(0,Math.min(max,value));
  const l=clamp((left-originX)/scale,width),t=clamp((top-originY)/scale,height);
  return{left:l,top:t,right:Math.max(l,clamp((right-originX)/scale,width)),bottom:Math.max(t,clamp((bottom-originY)/scale,height))};
}

/** Explicit reveal only: nearest native scroller first, fenced by card-surface.
 * Validate the complete bounded local chain before any fallback writes. */
function revealLocalHosts(viewport:HTMLElement,row:HTMLElement|null,cell:HTMLElement|null,head:HTMLElement|null){
  const nodes:HTMLElement[]=[viewport];let ancestor=viewport.parentElement,fenced=false,depth=0;
  while(ancestor&&ancestor!==viewport.ownerDocument.body&&ancestor!==viewport.ownerDocument.documentElement){
    if(depth++>=16)return false;
    if(ancestor.classList.contains('card-surface')){fenced=true;break;}
    nodes.push(ancestor);ancestor=ancestor.parentElement;
  }
  if(!fenced)return false;
  const plan:{box:LocalBox;x:boolean;y:boolean}[]=[];
  const enabled=(node:HTMLElement,value:string)=>value==='auto'||value==='scroll'||value==='hidden'&&node.dataset.nativeScrollport==='true';
  for(const node of nodes){
    const style=node.ownerDocument.defaultView?.getComputedStyle(node);if(!style)return false;
    const x=!!cell&&enabled(node,style.overflowX||style.overflow),y=!!row&&enabled(node,style.overflowY||style.overflow);
    const clips=(value:string)=>['auto','scroll','hidden','clip'].includes(value);
    const paint=style.contain?.split(/\s+/).some(value=>['paint','strict','content'].includes(value));
    if(node!==viewport&&!x&&!y&&!paint&&!clips(style.overflowX||style.overflow)&&!clips(style.overflowY||style.overflow))continue;
    const box=localBox(node);if(!box)return false;
    const r=node.getBoundingClientRect(),sx=r.width/box.width,sy=r.height/box.height;
    if(!(sx>0)||!Number.isFinite(sx)||!(sy>0)||Math.abs(sx-sy)>Math.max(sx,sy)*.001||![r.left,r.top,r.right,r.bottom].every(Number.isFinite)||x&&style.direction==='rtl')return false;
    if(x&&![node.scrollLeft,node.scrollWidth,node.clientWidth].every(value=>Number.isFinite(value)&&value>=0)||y&&![node.scrollTop,node.scrollHeight,node.clientHeight].every(value=>Number.isFinite(value)&&value>=0))return false;
    plan.push({box,x,y});
  }
  const rowRect=row?.getBoundingClientRect(),cellRect=cell?.getBoundingClientRect(),headerPad=row&&head?head.getBoundingClientRect().height:0;
  if(!Number.isFinite(headerPad)||headerPad<0||rowRect&&![rowRect.top,rowRect.bottom].every(Number.isFinite)||cellRect&&![cellRect.left,cellRect.right].every(Number.isFinite))return false;
  const delta=(start:number,end:number,low:number,high:number)=>{
    if(start>=low&&end<=high||start<=low&&end>=high)return 0;
    if(end-start>high-low)return Math.abs(start-low)<Math.abs(end-high)?start-low:end-high;
    return start<low?start-low:end>high?end-high:0;
  };
  let changed=false;
  for(const item of plan){
    const node=item.box.element,r=node.getBoundingClientRect(),scale=r.width/item.box.width,scaleY=r.height/item.box.height;
    if(!(scale>0)||!Number.isFinite(scale)||!(scaleY>0)||Math.abs(scale-scaleY)>Math.max(scale,scaleY)*.001||![r.left,r.top,r.right,r.bottom].every(Number.isFinite))break;
    if(item.x&&cell){const target=cell.getBoundingClientRect(),low=r.left+item.box.left*scale,d=delta(target.left,target.right,low,low+node.clientWidth*scale),before=node.scrollLeft,max=Math.max(0,node.scrollWidth-node.clientWidth),next=Math.max(0,Math.min(max,before+d/scale));if(Math.abs(next-before)>.001){node.scrollLeft=next;changed=changed||node.scrollLeft!==before;}}
    if(item.y&&row){const target=row.getBoundingClientRect(),low=r.top+item.box.top*scale,d=delta(target.top-headerPad,target.bottom,low,low+node.clientHeight*scale),before=node.scrollTop,max=Math.max(0,node.scrollHeight-node.clientHeight),next=Math.max(0,Math.min(max,before+d/scale));if(Math.abs(next-before)>.001){node.scrollTop=next;changed=changed||node.scrollTop!==before;}}
  }
  return changed;
}

/** Opt-in for one ordinary readonly TR per row. Keep every keyed row mounted;
 * keep row shells for every index and render cells only in the measured bands. Render zero-border/padding
 * aria-hidden spacer TRs with data-table-window-spacer before/after those rows,
 * and a measured colgroup only while ready. Revision must include source,
 * columns and trusted typography/spacing changes. reveal(index,true) adjusts
 * the inner viewport, then explicitly scrollable local hosts, and focuses its retained row.
 * Layout bands intersect local clip ancestors up to card-surface/depth16, never
 * the global camera viewport. Reveal fallback never changes card-surface pan transforms. */
export function useRetainedTableWindow({rowCount,revision,enabled,overscanPixels=32,horizontal=false,columnOverscanPixels=32}:Options){
  const viewportRef=useRef<HTMLDivElement>(null),tableRef=useRef<HTMLTableElement>(null),bodyRef=useRef<HTMLTableSectionElement>(null);
  const updates=useRenderUpdates(),latest=useRef({updates,enabled});latest.current={updates,enabled};
  const [epoch,setEpoch]=useState(0),[geometry,setGeometry]=useState<Geometry|null>(null),[range,setRange]=useState<Range>({start:0,end:MAX_ROWS});
  const [columnRange,setColumnRange]=useState<Range>({start:0,end:MAX_COLUMNS});
  const [revealSequence,setRevealSequence]=useState(0),pendingReveal=useRef<{index:number;focus:boolean;column?:number}|null>(null),pendingColumn=useRef<number|null>(null);
  const reveal=useCallback((index:number,focus=false,column?:number)=>{if(!Number.isInteger(index)||index<0||index>=MAX_ROWS||column!==undefined&&(!Number.isInteger(column)||column<0||column>=MAX_COLUMNS))return;pendingReveal.current={index,focus,column};setRevealSequence(value=>value+1);},[]);
  const revealColumn=useCallback((index:number)=>{if(!Number.isInteger(index)||index<0||index>=MAX_COLUMNS)return;pendingColumn.current=index;setRevealSequence(value=>value+1);},[]);
  const current=useRef<Geometry|null>(null),dirty=useRef(false),frame=useRef<number|null>(null);
  const bounded=enabled&&Number.isInteger(rowCount)&&rowCount>0&&rowCount<=MAX_ROWS;
  const ready=bounded&&geometry!==null&&(!updates||(Object.is(geometry.revision,revision)&&geometry.epoch===epoch&&geometry.count===rowCount&&geometry.horizontal===horizontal));
  current.current=ready?geometry:null;
  const refresh=useCallback(()=>{dirty.current=true;if(latest.current.updates&&latest.current.enabled){dirty.current=false;setEpoch(value=>value+1);}},[]);
  const overscan=Number.isFinite(overscanPixels)?Math.min(2000,Math.max(0,overscanPixels)):32;
  const columnOverscan=Number.isFinite(columnOverscanPixels)?Math.min(2000,Math.max(0,columnOverscanPixels)):32;
  const updateWindow=useCallback(()=>{
    if(!latest.current.updates||!latest.current.enabled)return;
    const g=current.current,viewport=viewportRef.current,body=bodyRef.current;if(!g||!viewport||!body)return;
    const height=viewport.clientHeight,scroll=viewport.scrollTop;if(!(height>0)||!Number.isFinite(scroll))return;
    const band=visibleBand(g,viewport);if(!band){setGeometry(null);return;}
    const low=Math.max(0,scroll+band.top-g.bodyTop-overscan),high=scroll+band.bottom-g.bodyTop+overscan;
    let left=0,right=g.count;
    while(left<right){const mid=(left+right)>>>1;if(g.prefix[mid+1]!<=low)left=mid+1;else right=mid;}
    let start=Math.min(left,g.count-1);left=start;right=g.count;
    while(left<right){const mid=(left+right)>>>1;if(g.prefix[mid]!<high)left=mid+1;else right=mid;}
    let end=Math.max(start+1,left);
    const focused=body.ownerDocument.activeElement;
    if(focused&&body.contains(focused)){
      const rows=Array.from(body.children).filter(element=>element.tagName==='TR'&&!element.hasAttribute('data-table-window-spacer'));
      const index=rows.findIndex(row=>row.contains(focused));if(index>=0){start=Math.min(start,index);end=Math.max(end,index+1);}
    }
    if(pendingReveal.current&&pendingReveal.current.index<g.count){start=Math.min(start,pendingReveal.current.index);end=Math.max(end,pendingReveal.current.index+1);}
    setRange(previous=>previous.start===start&&previous.end===end?previous:{start,end});
    if(g.horizontal&&viewport.clientWidth>0&&Number.isFinite(viewport.scrollLeft)){
      const lowX=Math.max(0,viewport.scrollLeft+band.left-g.tableLeft-columnOverscan),highX=viewport.scrollLeft+band.right-g.tableLeft+columnOverscan,count=g.columns.length;
      let start=0;while(start<count-1&&g.columnPrefix[start+1]!<=lowX)start++;
      let end=start+1;while(end<count&&g.columnPrefix[end]!<highX)end++;
      const focus=body.ownerDocument.activeElement,cell=focus instanceof Element?focus.closest('[data-table-window-column]'):null;
      if(cell&&tableRef.current?.contains(cell)){const index=Number(cell.getAttribute('data-table-window-column'));if(Number.isInteger(index)&&index>=0&&index<count){start=Math.min(start,index);end=Math.max(end,index+1);}}
      const requested=pendingReveal.current?.column??pendingColumn.current;if(requested!==null&&requested!==undefined&&requested<count){start=Math.min(start,requested);end=Math.max(end,requested+1);}
      setColumnRange(previous=>previous.start===start&&previous.end===end?previous:{start,end});
    }
  },[overscan,columnOverscan]);
  const schedule=useCallback(()=>{
    if(!latest.current.updates||!latest.current.enabled)return;
    if(frame.current!==null)return;
    if(typeof requestAnimationFrame==='undefined'){if(dirty.current)refresh();else updateWindow();return;}
    frame.current=requestAnimationFrame(()=>{frame.current=null;if(dirty.current)refresh();else updateWindow();});
  },[refresh,updateWindow]);

  useLayoutEffect(()=>{
    if(!bounded||!updates)return;
    if(geometry&&geometry.epoch===epoch&&geometry.count===rowCount&&geometry.horizontal===horizontal&&Object.is(geometry.revision,revision))return;
    dirty.current=false;
    const viewport=viewportRef.current,table=tableRef.current,body=bodyRef.current;
    function fail(){setGeometry(previous=>previous===null?previous:null);}
    if(!viewport||!table||!body||!table.tHead||!(viewport.clientHeight>0)){fail();return;}
    const rows=Array.from(body.children).filter((element):element is HTMLTableRowElement=>element.tagName==='TR'&&!element.hasAttribute('data-table-window-spacer'));
    const headers=Array.from(table.tHead.children).filter(element=>element.tagName==='TR');
    if(rows.length!==rowCount||headers.length!==1){fail();return;}
    const directCells=(row:Element)=>Array.from(row.children).filter(element=>element.tagName==='TD'||element.tagName==='TH');
    const cells=directCells(headers[0]!);
    const spans=(cell:Element)=>Number(cell.getAttribute('colspan')??1)!==1||Number(cell.getAttribute('rowspan')??1)!==1;
    if(cells.length<1||cells.length>MAX_COLUMNS||cells.some(spans)||rows.some(row=>directCells(row).length!==cells.length||directCells(row).some(spans))){fail();return;}
    const view=table.ownerDocument.defaultView;if(!view){fail();return;}
    const style=view.getComputedStyle(table);
    const numeric=(value:string)=>/^[0-9]+(?:\.[0-9]+)?px$/.test(value)?Number.parseFloat(value):NaN;
    const localSize=(axis:'width'|'height')=>{
      let size=numeric(style[axis]);
      if(style.boxSizing!=='border-box')for(const side of axis==='width'?['Left','Right']:['Top','Bottom'])size+=numeric(style.getPropertyValue(`padding-${side.toLowerCase()}`))+numeric(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
      return size;
    };
    const rect=table.getBoundingClientRect(),width=localSize('width'),height=localSize('height');
    const scale=rect.width/width,scaleY=rect.height/height;
    if(!(scale>0)||!Number.isFinite(scale)||!(scaleY>0)||Math.abs(scale-scaleY)>Math.max(scale,scaleY)*.001){fail();return;}
    if(style.borderCollapse!=='collapse'&&style.borderSpacing.split(/\s+/).some(value=>Number.parseFloat(value)!==0)){fail();return;}
    const columns=cells.map(cell=>cell.getBoundingClientRect().width/scale);
    const heights=rows.map(row=>row.getBoundingClientRect().height/scale);
    if([...columns,...heights].some(size=>!Number.isFinite(size)||size<=0)){fail();return;}
    const bodyRect=body.getBoundingClientRect(),viewportRect=viewport.getBoundingClientRect();
    const total=bodyRect.height/scale,sum=heights.reduce((a,b)=>a+b,0);
    if(!Number.isFinite(total)||Math.abs(total-sum)>.5){fail();return;}
    const prefix=[0];for(const size of heights)prefix.push(prefix.at(-1)!+size);prefix[prefix.length-1]=total;
    const border=numeric(view.getComputedStyle(viewport).borderTopWidth);
    if(!Number.isFinite(border)){fail();return;}
    const bodyTop=(bodyRect.top-viewportRect.top)/scale+viewport.scrollTop-border;
    if(!Number.isFinite(bodyTop)){fail();return;}
    const headerHeight=table.tHead.getBoundingClientRect().height/scale;
    if(!Number.isFinite(headerHeight)||headerHeight<0){fail();return;}
    const columnPrefix=[0];for(const size of columns)columnPrefix.push(columnPrefix.at(-1)!+size);
    const viewportStyle=view.getComputedStyle(viewport),leftBorder=numeric(viewportStyle.borderLeftWidth),tableLeft=(rect.left-viewportRect.left)/scale+viewport.scrollLeft-(Number.isFinite(leftBorder)?leftBorder:0);
    if(horizontal&&(!(viewport.clientWidth>0)||!Number.isFinite(leftBorder)||!Number.isFinite(tableLeft)||viewportStyle.direction==='rtl'||style.direction==='rtl'||Math.abs(columnPrefix.at(-1)!-width)>.5)){fail();return;}
    const clips=localClips(viewport),viewportBox=clips?.length?localBox(viewport):null;
    if(!clips||clips.length&&!viewportBox){fail();return;}
    setGeometry({revision,epoch,count:rowCount,prefix,columns,columnPrefix,tableWidth:width,scale,bodyTop,tableLeft,headerHeight,horizontal,clips,viewportBox});
  },[bounded,updates,rowCount,revision,epoch,horizontal]);

  useLayoutEffect(()=>{if(updates){if(dirty.current)refresh();else updateWindow();}},[updates,geometry,refresh,updateWindow]);
  useLayoutEffect(()=>{
    if(!updates||!pendingReveal.current&&pendingColumn.current===null)return;
    const pending=pendingReveal.current,viewport=viewportRef.current,body=bodyRef.current;
    if(!viewport||!body)return;
    const rows=Array.from(body.children).filter((element):element is HTMLTableRowElement=>element.tagName==='TR'&&!element.hasAttribute('data-table-window-spacer'));
    const target=pending?rows[pending.index]:null;if(pending&&!target){pendingReveal.current=null;return;}
    const g=current.current;
    const band=g?visibleBand(g,viewport):null;
    const requestedColumn=pending?.column??pendingColumn.current;
    if(g?.horizontal&&requestedColumn!==null&&requestedColumn!==undefined&&requestedColumn<g.columns.length){
      const left=g.tableLeft+g.columnPrefix[requestedColumn]!,right=g.tableLeft+g.columnPrefix[requestedColumn+1]!,scroll=viewport.scrollLeft;
      const bandLeft=band?.left??0,bandRight=band?.right??viewport.clientWidth;
      const next=left<scroll+bandLeft?Math.max(0,left-bandLeft):right>scroll+bandRight?Math.max(0,right-bandRight):scroll;
      if(Math.abs(next-scroll)>.001)viewport.scrollLeft=next;
      updateWindow();
    }
    if(g&&pending&&target&&pending.index<g.count){
      const top=g.bodyTop+g.prefix[pending.index]!,bottom=g.bodyTop+g.prefix[pending.index+1]!,scroll=viewport.scrollTop,inset=Math.min(g.headerHeight,Math.max(0,viewport.clientHeight-1));
      const bandTop=band?.top??0,bandBottom=band?.bottom??viewport.clientHeight;
      const next=top<scroll+bandTop+inset?Math.max(0,top-bandTop-inset):bottom>scroll+bandBottom?Math.max(0,bottom-bandBottom):scroll;
      if(Math.abs(next-scroll)>.001)viewport.scrollTop=next;
      updateWindow();
      if(target.style.display==='none')return; // The next React layout commit reveals it.
    }
    const cell=requestedColumn===null||requestedColumn===undefined?null:(target??tableRef.current?.tHead?.children[0])?.querySelector<HTMLElement>(`[data-table-window-column="${requestedColumn}"]`);
    if(cell?.style.display==='none'||!cell&&g?.horizontal&&requestedColumn!==null&&requestedColumn!==undefined&&requestedColumn<g.columns.length)return; // Pruned hidden cells render on the requested-column layout commit.
    if(revealLocalHosts(viewport,target,cell??null,tableRef.current?.tHead??null))updateWindow();
    if(pending?.focus){
      const selector='button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([disabled]),[contenteditable="true"]';
      const focusable=cell?.querySelector<HTMLElement>(selector)??(cell?.matches(selector)?cell:target);
      focusable?.focus({preventScroll:true});
      if(target&&focusable&&body.ownerDocument.activeElement!==focusable)target.focus({preventScroll:true});
    }
    pendingReveal.current=null;pendingColumn.current=null;updateWindow();
  },[updates,geometry,range,columnRange,revealSequence,ready,updateWindow]);
  useLayoutEffect(()=>{
    if(!enabled||!updates)return;
    const viewport=viewportRef.current,table=tableRef.current;if(!viewport||!table)return;
    let alive=true;const seen=new Map<Element,{width:number;height:number}>();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(entries=>{
      if(!alive)return;
      for(const entry of entries){const next={width:entry.contentRect.width,height:entry.contentRect.height},previous=seen.get(entry.target);seen.set(entry.target,next);
        if(previous&&(Math.abs(previous.width-next.width)>.01||(entry.target!==viewport&&Math.abs(previous.height-next.height)>.01))){dirty.current=true;schedule();}
        else if(entry.target===viewport&&previous&&Math.abs(previous.height-next.height)>.01)schedule();
      }
      if(!current.current){dirty.current=true;schedule();}
    });
    observer?.observe(viewport);observer?.observe(table);
    const clips=geometry?.clips??[];for(const clip of clips){observer?.observe(clip.element);clip.element.addEventListener('scroll',schedule,{passive:true});}
    const focus=()=>schedule(),font=()=>{dirty.current=true;schedule();};
    viewport.addEventListener('scroll',schedule,{passive:true});viewport.addEventListener('focusin',focus);viewport.addEventListener('focusout',focus);
    const fonts=table.ownerDocument.fonts;fonts?.addEventListener('loadingdone',font);
    return()=>{alive=false;observer?.disconnect();for(const clip of clips)clip.element.removeEventListener('scroll',schedule);viewport.removeEventListener('scroll',schedule);viewport.removeEventListener('focusin',focus);viewport.removeEventListener('focusout',focus);fonts?.removeEventListener('loadingdone',font);if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null;}};
  },[enabled,updates,schedule,geometry?.clips]);
  const start=ready?Math.min(range.start,geometry.count-1):0,end=ready?Math.min(geometry.count,range.end):rowCount;
  const columnsReady=ready&&geometry.horizontal,columnCount=columnsReady?geometry.columns.length:0,columnStart=columnsReady?Math.min(columnRange.start,columnCount-1):0,columnEnd=columnsReady?Math.min(columnRange.end,columnCount):0;
  const tableStyle:CSSProperties|undefined=ready?{width:geometry.tableWidth,minWidth:geometry.tableWidth,tableLayout:'fixed'}:undefined;
  return{viewportRef,tableRef,bodyRef,ready,visible:(index:number)=>!ready||index>=geometry.count||index>=start&&index<end,topPixels:ready?geometry.prefix[start]!:0,bottomPixels:ready?geometry.prefix[geometry.count]!-geometry.prefix[end]!:0,columnWidths:ready?geometry.columns:[],refresh,reveal,tableStyle,headerHeight:ready?geometry.headerHeight:undefined,rowHeight:(index:number)=>ready&&index>=0&&index<geometry.count?geometry.prefix[index+1]!-geometry.prefix[index]!:undefined,columns:{ready:columnsReady,start:columnStart,end:columnEnd,count:columnCount,visible:(index:number)=>!columnsReady||index>=columnStart&&index<columnEnd,leftPixels:columnsReady?geometry.columnPrefix[columnStart]!:0,rightPixels:columnsReady?geometry.columnPrefix[columnCount]!-geometry.columnPrefix[columnEnd]!:0,reveal:revealColumn}};
}

/** Logical gap slots replace only layout participation, never retained cells. */
export function RetainedColumnGap({columns,side,header=false,height}:{columns:ReturnType<typeof useRetainedTableWindow>['columns'];side:'left'|'right';header?:boolean;height?:number}){
  const count=side==='left'?columns.start:columns.count-columns.end,width=side==='left'?columns.leftPixels:columns.rightPixels;
  if(!columns.ready||count<=0)return null;
  const Cell=header?'th':'td';
  return <Cell aria-hidden="true" data-table-window-column-spacer={side} colSpan={count} style={{width,minWidth:width,maxWidth:width,height,minHeight:0,padding:0,border:0,lineHeight:0,fontSize:0,position:'static'}}/>;
}
