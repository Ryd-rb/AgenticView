import test from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement,useEffect,useState} from 'react';
import {Window} from 'happy-dom';
import {RetainedColumnGap,useRetainedTableWindow} from '../web/RetainedTableWindow.tsx';
import {RenderBoundary} from '../web/RenderActivity.tsx';

async function fixture(horizontal=false,columnCount=2,clipped=false,padding:number|null=0){
  const dom=new Window();for(const key of ['window','document','HTMLElement','Element','Node','Event','HTMLInputElement'] as const)Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom:dom[key]});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  const prior={raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame,ro:globalThis.ResizeObserver};
  let ancestorMode='hidden',nativeMarked=true,invalidScale=false;let frameId=0,mounts=0,unmounts=0,multiplier=1,valid=true,worldScale=.25;const frames=new Map<number,FrameRequestCallback>(),observers=new Set<RO>();
  class RO{targets=new Set<Element>();constructor(readonly callback:ResizeObserverCallback){observers.add(this);}observe(target:Element){this.targets.add(target);}disconnect(){this.targets.clear();observers.delete(this);}unobserve(target:Element){this.targets.delete(target);}}
  Object.assign(globalThis,{ResizeObserver:RO,requestAnimationFrame:(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;},cancelAnimationFrame:(id:number)=>frames.delete(id)});
  const scrollListeners=new Map<Element,Set<unknown>>(),add=dom.HTMLElement.prototype.addEventListener,remove=dom.HTMLElement.prototype.removeEventListener;
  dom.HTMLElement.prototype.addEventListener=function(type:any,listener:any,options:any){if(type==='scroll'&&(this.hasAttribute('data-viewport')||this.hasAttribute('data-clipper')||this.hasAttribute('data-global-camera'))){const target=this as unknown as Element;const set=scrollListeners.get(target)??new Set();set.add(listener);scrollListeners.set(target,set);}return add.call(this,type,listener,options);};
  dom.HTMLElement.prototype.removeEventListener=function(type:any,listener:any){if(type==='scroll'){const target=this as unknown as Element,set=scrollListeners.get(target);set?.delete(listener);if(!set?.size)scrollListeners.delete(target);}return remove.call(this,type,listener);};
  const columnWidth=(index:number)=>index%2?119.75:80.25;
  const tableWidth=Array.from({length:columnCount},(_,i)=>columnWidth(i)).reduce((a,b)=>a+b,0);
  const height=(index:number)=>(index%2?30.5:20.25)*multiplier;
  const total=()=>Array.from({length:100},(_,i)=>height(i)).reduce((a,b)=>a+b,0);
  const offset=(index:number)=>Array.from({length:index},(_,i)=>height(i)).reduce((a,b)=>a+b,0);
  const originalRect=dom.HTMLElement.prototype.getBoundingClientRect;
  dom.HTMLElement.prototype.getBoundingClientRect=function(){
    const element=this as unknown as HTMLElement,viewport=document.querySelector<HTMLElement>('[data-viewport]'),clip=document.querySelector<HTMLElement>('[data-clipper]'),scroll=viewport?.scrollTop??0,scale=worldScale,ax=clipped?clip?.scrollLeft??0:0,ay=clipped?clip?.scrollTop??0:0;
    let top=-ay,width=clipped?600:200,left=-ax,boxHeight=clipped?349:50.5;
    if(element.hasAttribute('data-clipper')){left=0;top=0;width=180.25;boxHeight=90.5;}
    else if(element.hasAttribute('data-global-camera')){left=0;top=0;width=10;boxHeight=10;}
    else if(element.tagName==='TABLE'){width=tableWidth;left=-ax-(viewport?.scrollLeft??0);boxHeight=10.5+total();top=-ay-scroll;}
    else if(element.tagName==='TBODY'){boxHeight=total();top=10.5-ay-scroll;}
    else if(element.tagName==='THEAD'){boxHeight=10.5;top=-ay-scroll;}
    else if(element.tagName==='TD'&&element.hasAttribute('data-table-window-column')){const c=Number(element.dataset.tableWindowColumn);left=-ax-(viewport?.scrollLeft??0)+Array.from({length:c},(_,i)=>columnWidth(i)).reduce((a,b)=>a+b,0);width=columnWidth(c);boxHeight=height(Number(element.parentElement?.dataset.row));}
    else if(element.tagName==='TH'){width=columnWidth(Number(element.dataset.tableWindowColumn));boxHeight=10.5;}
    else if(element.hasAttribute('data-row')){const index=Number(element.getAttribute('data-row'));boxHeight=element.style.display==='none'?0:height(index);top=10.5+offset(index)-ay-scroll;}
    return new dom.DOMRect(left*scale,top*scale,width*scale,(valid?boxHeight:0)*scale*(invalidScale&&element.hasAttribute('data-clipper')?2:1));
  };
  const originalComputed=dom.getComputedStyle.bind(dom);
  dom.getComputedStyle=((element:Element)=>{
    const style=originalComputed(element as any);
    if(element.tagName==='TABLE')return new Proxy(style,{get(target,key){if(key==='width')return `${tableWidth}px`;if(key==='height')return `${10.5+total()}px`;if(key==='boxSizing')return 'border-box';if(key==='borderCollapse')return 'collapse';return Reflect.get(target,key);}});
    if(element.hasAttribute('data-viewport')||element.hasAttribute('data-clipper'))return new Proxy(style,{get(target,key){if(key==='borderTopWidth'||key==='borderLeftWidth')return '0px';if(clipped){if(key==='boxSizing')return 'border-box';if(key==='width')return element.hasAttribute('data-clipper')?'180.25px':'600px';if(key==='height')return element.hasAttribute('data-clipper')?'90.5px':'349px';if(element.hasAttribute('data-clipper')&&['overflow','overflowX','overflowY'].includes(String(key)))return ancestorMode;}return Reflect.get(target,key);}});
    return style;
  }) as unknown as typeof dom.getComputedStyle;
  Object.defineProperty(dom.HTMLElement.prototype,'clientHeight',{configurable:true,get(){return (this as unknown as HTMLElement).hasAttribute('data-clipper')?90.5:(this as unknown as HTMLElement).hasAttribute('data-viewport')?(clipped?349:50.5):0;}});
  Object.defineProperty(dom.HTMLElement.prototype,'clientWidth',{configurable:true,get(){return (this as unknown as HTMLElement).hasAttribute('data-clipper')?180.25:(this as unknown as HTMLElement).hasAttribute('data-viewport')?(clipped?600:200):0;}});
  Object.defineProperty(dom.HTMLElement.prototype,'scrollWidth',{configurable:true,get(){const element=this as unknown as HTMLElement;if(element.hasAttribute('data-clipper'))return 600;if(!element.hasAttribute('data-viewport'))return 0;return [...element.querySelectorAll<HTMLElement>('thead th')].reduce((sum,cell)=>sum+(cell.style.display==='none'?0:cell.hasAttribute('data-table-window-column-spacer')?Number.parseFloat(cell.style.width):columnWidth(Number(cell.dataset.tableWindowColumn))),0);}});
  Object.defineProperty(dom.HTMLElement.prototype,'scrollHeight',{configurable:true,get(){const el=this as unknown as HTMLElement;if(el.hasAttribute('data-clipper'))return 349;if(!el.hasAttribute('data-viewport'))return 0;return 10.5+[...el.querySelectorAll<HTMLTableRowElement>('tbody > tr')].reduce((sum,row)=>sum+(row.hasAttribute('data-table-window-spacer')?Number.parseFloat(row.style.height)||0:row.style.display==='none'?0:Number.parseFloat(row.style.height)||(horizontal&&row.querySelector<HTMLElement>(`[data-table-window-column="${columnCount-1}"]`)?.style.display==='none'?10:height(Number(row.dataset.row)))),0);}});
  for(const axis of ['Top','Left'] as const){const values=new WeakMap<object,number>();Object.defineProperty(dom.HTMLElement.prototype,`scroll${axis}`,{configurable:true,get(){return values.get(this)??0;},set(value:number){const el=this as unknown as HTMLElement,max=Math.max(0,axis==='Top'?el.scrollHeight-el.clientHeight:el.scrollWidth-el.clientWidth);values.set(this,Math.min(max,Math.max(0,value)));}});}
  const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  let latest:ReturnType<typeof useRetainedTableWindow>;
  function Row({index,view}:{index:number;view:ReturnType<typeof useRetainedTableWindow>}){const [value,setValue]=useState(`draft-${index}`);useEffect(()=>{mounts++;return()=>{unmounts++;};},[]);return createElement('td',{'data-table-window-column':0,'aria-colindex':1,tabIndex:-1,style:{display:view.columns.visible(0)?undefined:'none'}},createElement('input',{'aria-label':`row-${index}`,value,onInput:(event:any)=>setValue(event.target.value)}));}
  function Table({revision,enabled}:{revision:number;enabled:boolean}){
    const view=useRetainedTableWindow({rowCount:100,revision,enabled,horizontal,...(padding===null?{}:{overscanPixels:padding,columnOverscanPixels:padding})});latest=view;
    const spacer=(position:string,pixels:number)=>createElement('tr',{key:position,'data-table-window-spacer':position,'aria-hidden':true,style:{height:pixels}},createElement('td',{colSpan:columnCount,style:{padding:0,border:0,height:pixels}}));
    const tree=createElement('div',{ref:view.viewportRef,'data-viewport':true},createElement('table',{ref:view.tableRef,style:view.tableStyle},view.ready&&createElement('colgroup',null,...view.columnWidths.map((width,i)=>createElement('col',{key:i,style:{width}}))),createElement('thead',null,createElement('tr',{style:{height:view.headerHeight}},createElement(RetainedColumnGap,{columns:view.columns,side:'left',header:true,height:view.headerHeight}),...Array.from({length:columnCount},(_,index)=>createElement('th',{key:index,'data-table-window-column':index,'aria-colindex':index+1,style:{display:view.columns.visible(index)?undefined:'none'}},`Column ${index}`)),createElement(RetainedColumnGap,{columns:view.columns,side:'right',header:true,height:view.headerHeight}))),createElement('tbody',{ref:view.bodyRef},view.ready&&spacer('top',view.topPixels),...Array.from({length:100},(_,index)=>createElement('tr',{key:index,'data-row':index,style:{height:view.rowHeight(index),display:view.visible(index)?undefined:'none'}},createElement(RetainedColumnGap,{columns:view.columns,side:'left',height:view.rowHeight(index)}),createElement(Row,{index,view}),...Array.from({length:columnCount-1},(_,cell)=>createElement('td',{key:cell,'data-table-window-column':cell+1,'aria-colindex':cell+2,tabIndex:-1,style:{display:view.columns.visible(cell+1)?undefined:'none'}},cell===columnCount-2?'Tall multiline original content':index)),createElement(RetainedColumnGap,{columns:view.columns,side:'right',height:view.rowHeight(index)}))),view.ready&&spacer('bottom',view.bottomPixels))));
    return clipped?createElement('div',{'data-global-camera':true,style:{overflow:'hidden'}},createElement('div',{className:'card-surface'},createElement('div',{'data-clipper':true,'data-native-scrollport':nativeMarked?'true':undefined},tree))):tree;
  }
  const render=async(revision=0,updates=true,enabled=true)=>act(async()=>root.render(createElement(RenderBoundary,{visible:true,updates,children:()=>createElement(Table,{revision,enabled})})));
  const flush=async()=>act(async()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(0);});
  const ancestorScroll=async(y:number,x=0)=>{await act(async()=>{const element=host.querySelector<HTMLElement>('[data-clipper]')!;element.scrollTop=y;element.scrollLeft=x;element.dispatchEvent(new Event('scroll'));});await flush();};
  const scroll=async(value:number,x?:number)=>{await act(async()=>{const viewport=host.querySelector<HTMLElement>('[data-viewport]')!;viewport.scrollTop=value;if(x!==undefined)viewport.scrollLeft=x;viewport.dispatchEvent(new Event('scroll'));});await flush();};
  return{setMode(value:string,marked=true){ancestorMode=value;nativeMarked=marked;},setInvalidScale(value:boolean){invalidScale=value;},host,dom,render,flush,scroll,ancestorScroll,total,offset,height,tableWidth,columnWidth,setWorldScale(value:number){worldScale=value;},get latest(){return latest!;},get mounts(){return mounts;},get unmounts(){return unmounts;},setMultiplier(value:number){multiplier=value;},setValid(value:boolean){valid=value;},observers,frames,scrollListeners,close:async()=>{await act(async()=>root.unmount());assert.equal(observers.size,0);assert.equal(frames.size,0);assert.equal(scrollListeners.size,0);dom.HTMLElement.prototype.getBoundingClientRect=originalRect;Object.assign(globalThis,{requestAnimationFrame:prior.raf,cancelAnimationFrame:prior.caf,ResizeObserver:prior.ro});await dom.happyDOM.close();}};
}


test('explicit reveal chains only native local ancestors after inner bounds, preserves fractional geometry and retained draft',async()=>{
 const f=await fixture(true,12,true,0);try{
  await f.render();assert.equal(f.latest.ready,true);const v=f.host.querySelector<HTMLElement>('[data-viewport]')!,a=f.host.querySelector<HTMLElement>('[data-clipper]')!,rows=[...f.host.querySelectorAll<HTMLElement>('[data-row]')],cells=[...f.host.querySelectorAll('[data-table-window-column]')],input=rows[0]!.querySelector<HTMLInputElement>('input')!;
  await act(async()=>{input.value='preserved';input.dispatchEvent(new Event('input',{bubbles:true}));});const extent=[v.scrollWidth,v.scrollHeight];
  await act(async()=>f.latest.reveal(99,true,11));assert.equal(v.scrollLeft,600);assert.equal(v.scrollTop,f.total()+10.5-349);assert.equal(a.scrollLeft,419.75);assert.equal(a.scrollTop,258.5);assert.equal(document.activeElement,rows[99]!.querySelector('[data-table-window-column="11"]'));assert.deepEqual([v.scrollWidth,v.scrollHeight],extent);
  await act(async()=>f.latest.reveal(0,true,0));assert.equal(v.scrollLeft,0);assert.equal(v.scrollTop,0);assert.equal(a.scrollLeft,0);assert.equal(a.scrollTop,0);assert.equal(document.activeElement,input);assert.equal(input.value,'preserved');
  assert.deepEqual([...f.host.querySelectorAll('[data-row]')],rows);assert.deepEqual([...f.host.querySelectorAll('[data-table-window-column]')],cells);assert.equal(f.mounts,100);assert.equal(f.unmounts,0);
  for(const node of [f.host.querySelector<HTMLElement>('.card-surface')!,f.host.querySelector<HTMLElement>('[data-global-camera]')!])assert.deepEqual([node.scrollTop,node.scrollLeft,node.style.transform],[0,0,'']);
 }finally{await f.close();}
});
test('frozen reveal defers local scrolling and focus until resume; reversal uses current fractional scale',async()=>{
 const f=await fixture(true,12,true,0);try{await f.render();const v=f.host.querySelector<HTMLElement>('[data-viewport]')!,a=f.host.querySelector<HTMLElement>('[data-clipper]')!;await f.render(0,false);await act(async()=>f.latest.reveal(99,true,11));assert.deepEqual([v.scrollTop,v.scrollLeft,a.scrollTop,a.scrollLeft],[0,0,0,0]);f.setWorldScale(.125);await f.render(0,true);assert.equal(a.scrollTop,258.5);assert.equal(a.scrollLeft,419.75);await act(async()=>f.latest.reveal(0,true,0));assert.deepEqual([v.scrollTop,v.scrollLeft,a.scrollTop,a.scrollLeft],[0,0,0,0]);}finally{await f.close();}
});
test('clip and unmarked hidden ancestors are never scrolled, unknown nonuniform scale fails safe',async()=>{
 for(const mode of ['clip','hidden','auto']){const f=await fixture(true,12,true,0);try{f.setMode(mode,false);if(mode==='auto')f.setInvalidScale(true);await f.render();const a=f.host.querySelector<HTMLElement>('[data-clipper]')!;await act(async()=>f.latest.reveal(99,true,11));assert.deepEqual([a.scrollTop,a.scrollLeft],[0,0],mode);}finally{await f.close();}}
});
