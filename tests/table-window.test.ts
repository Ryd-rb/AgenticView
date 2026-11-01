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
  let frameId=0,mounts=0,unmounts=0,multiplier=1,valid=true,worldScale=.25;const frames=new Map<number,FrameRequestCallback>(),observers=new Set<RO>();
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
    else if(element.tagName==='TH'){width=columnWidth(Number(element.dataset.tableWindowColumn));boxHeight=10.5;}
    else if(element.hasAttribute('data-row')){const index=Number(element.getAttribute('data-row'));boxHeight=element.style.display==='none'?0:height(index);top=10.5+offset(index)-ay-scroll;}
    return new dom.DOMRect(left*scale,top*scale,width*scale,(valid?boxHeight:0)*scale);
  };
  const originalComputed=dom.getComputedStyle.bind(dom);
  dom.getComputedStyle=((element:Element)=>{
    const style=originalComputed(element as any);
    if(element.tagName==='TABLE')return new Proxy(style,{get(target,key){if(key==='width')return `${tableWidth}px`;if(key==='height')return `${10.5+total()}px`;if(key==='boxSizing')return 'border-box';if(key==='borderCollapse')return 'collapse';return Reflect.get(target,key);}});
    if(element.hasAttribute('data-viewport')||element.hasAttribute('data-clipper'))return new Proxy(style,{get(target,key){if(key==='borderTopWidth'||key==='borderLeftWidth')return '0px';if(clipped){if(key==='boxSizing')return 'border-box';if(key==='width')return element.hasAttribute('data-clipper')?'180.25px':'600px';if(key==='height')return element.hasAttribute('data-clipper')?'90.5px':'349px';if(element.hasAttribute('data-clipper')&&['overflow','overflowX','overflowY'].includes(String(key)))return 'hidden';}return Reflect.get(target,key);}});
    return style;
  }) as unknown as typeof dom.getComputedStyle;
  Object.defineProperty(dom.HTMLElement.prototype,'clientHeight',{configurable:true,get(){return (this as unknown as HTMLElement).hasAttribute('data-clipper')?90.5:(this as unknown as HTMLElement).hasAttribute('data-viewport')?(clipped?349:50.5):0;}});
  Object.defineProperty(dom.HTMLElement.prototype,'clientWidth',{configurable:true,get(){return (this as unknown as HTMLElement).hasAttribute('data-clipper')?180.25:(this as unknown as HTMLElement).hasAttribute('data-viewport')?(clipped?600:200):0;}});
  Object.defineProperty(dom.HTMLElement.prototype,'scrollWidth',{configurable:true,get(){const element=this as unknown as HTMLElement;if(!element.hasAttribute('data-viewport'))return 0;return [...element.querySelectorAll<HTMLElement>('thead th')].reduce((sum,cell)=>sum+(cell.style.display==='none'?0:cell.hasAttribute('data-table-window-column-spacer')?Number.parseFloat(cell.style.width):columnWidth(Number(cell.dataset.tableWindowColumn))),0);}});
  Object.defineProperty(dom.HTMLElement.prototype,'scrollHeight',{configurable:true,get(){const el=this as unknown as HTMLElement;if(!el.hasAttribute('data-viewport'))return 0;return 10.5+[...el.querySelectorAll<HTMLTableRowElement>('tbody > tr')].reduce((sum,row)=>sum+(row.hasAttribute('data-table-window-spacer')?Number.parseFloat(row.style.height)||0:row.style.display==='none'?0:Number.parseFloat(row.style.height)||(horizontal&&row.querySelector<HTMLElement>(`[data-table-window-column="${columnCount-1}"]`)?.style.display==='none'?10:height(Number(row.dataset.row)))),0);}});
  const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  let latest:ReturnType<typeof useRetainedTableWindow>;
  function Row({index,view}:{index:number;view:ReturnType<typeof useRetainedTableWindow>}){const [value,setValue]=useState(`draft-${index}`);useEffect(()=>{mounts++;return()=>{unmounts++;};},[]);return createElement('td',{'data-table-window-column':0,'aria-colindex':1,tabIndex:-1,style:{display:view.columns.visible(0)?undefined:'none'}},createElement('input',{'aria-label':`row-${index}`,value,onInput:(event:any)=>setValue(event.target.value)}));}
  function Table({revision,enabled}:{revision:number;enabled:boolean}){
    const view=useRetainedTableWindow({rowCount:100,revision,enabled,horizontal,...(padding===null?{}:{overscanPixels:padding,columnOverscanPixels:padding})});latest=view;
    const spacer=(position:string,pixels:number)=>createElement('tr',{key:position,'data-table-window-spacer':position,'aria-hidden':true,style:{height:pixels}},createElement('td',{colSpan:columnCount,style:{padding:0,border:0,height:pixels}}));
    const tree=createElement('div',{ref:view.viewportRef,'data-viewport':true},createElement('table',{ref:view.tableRef,style:view.tableStyle},view.ready&&createElement('colgroup',null,...view.columnWidths.map((width,i)=>createElement('col',{key:i,style:{width}}))),createElement('thead',null,createElement('tr',{style:{height:view.headerHeight}},createElement(RetainedColumnGap,{columns:view.columns,side:'left',header:true,height:view.headerHeight}),...Array.from({length:columnCount},(_,index)=>createElement('th',{key:index,'data-table-window-column':index,'aria-colindex':index+1,style:{display:view.columns.visible(index)?undefined:'none'}},`Column ${index}`)),createElement(RetainedColumnGap,{columns:view.columns,side:'right',header:true,height:view.headerHeight}))),createElement('tbody',{ref:view.bodyRef},view.ready&&spacer('top',view.topPixels),...Array.from({length:100},(_,index)=>createElement('tr',{key:index,'data-row':index,style:{height:view.rowHeight(index),display:view.visible(index)?undefined:'none'}},createElement(RetainedColumnGap,{columns:view.columns,side:'left',height:view.rowHeight(index)}),createElement(Row,{index,view}),...Array.from({length:columnCount-1},(_,cell)=>createElement('td',{key:cell,'data-table-window-column':cell+1,'aria-colindex':cell+2,tabIndex:-1,style:{display:view.columns.visible(cell+1)?undefined:'none'}},cell===columnCount-2?'Tall multiline original content':index)),createElement(RetainedColumnGap,{columns:view.columns,side:'right',height:view.rowHeight(index)}))),view.ready&&spacer('bottom',view.bottomPixels))));
    return clipped?createElement('div',{'data-global-camera':true,style:{overflow:'hidden'}},createElement('div',{className:'card-surface'},createElement('div',{'data-clipper':true},tree))):tree;
  }
  const render=async(revision=0,updates=true,enabled=true)=>act(async()=>root.render(createElement(RenderBoundary,{visible:true,updates,children:()=>createElement(Table,{revision,enabled})})));
  const flush=async()=>act(async()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(0);});
  const ancestorScroll=async(y:number,x=0)=>{await act(async()=>{const element=host.querySelector<HTMLElement>('[data-clipper]')!;element.scrollTop=y;element.scrollLeft=x;element.dispatchEvent(new Event('scroll'));});await flush();};
  const scroll=async(value:number,x?:number)=>{await act(async()=>{const viewport=host.querySelector<HTMLElement>('[data-viewport]')!;viewport.scrollTop=value;if(x!==undefined)viewport.scrollLeft=x;viewport.dispatchEvent(new Event('scroll'));});await flush();};
  return{host,dom,render,flush,scroll,ancestorScroll,total,offset,height,tableWidth,columnWidth,setWorldScale(value:number){worldScale=value;},get latest(){return latest!;},get mounts(){return mounts;},get unmounts(){return unmounts;},setMultiplier(value:number){multiplier=value;},setValid(value:boolean){valid=value;},observers,frames,scrollListeners,close:async()=>{await act(async()=>root.unmount());assert.equal(observers.size,0);assert.equal(frames.size,0);assert.equal(scrollListeners.size,0);dom.HTMLElement.prototype.getBoundingClientRect=originalRect;Object.assign(globalThis,{requestAnimationFrame:prior.raf,cancelAnimationFrame:prior.caf,ResizeObserver:prior.ro});await dom.happyDOM.close();}};
}

test('fractional variable-height table windows preserve exact offsets, columns, DOM drafts and focused rows across reversals',async()=>{
  const f=await fixture();try{
    await f.render();assert.equal(f.latest.ready,true);assert.deepEqual(f.latest.columnWidths,[80.25,119.75]);assert.equal(f.mounts,100);
    const rows=[...f.host.querySelectorAll<HTMLElement>('[data-row]')],input=rows[0]!.querySelector<HTMLInputElement>('input')!;
    await act(async()=>{input.value='retained local draft';input.dispatchEvent(new Event('input',{bubbles:true}));});
    const extent=()=>f.host.querySelector<HTMLElement>('[data-viewport]')!.scrollHeight;
    assert.equal(extent(),10.5+f.total());
    await f.scroll(100);assert.equal(f.latest.topPixels,f.offset(3));assert.equal(f.latest.visible(3),true);assert.equal(f.latest.visible(2),false);assert.equal(extent(),10.5+f.total());
    await f.scroll(2400);assert.ok(f.latest.topPixels>2300);assert.equal(extent(),10.5+f.total());
    await f.scroll(20);assert.equal(f.latest.topPixels,0);assert.deepEqual([...f.host.querySelectorAll('[data-row]')],rows);assert.equal(input.value,'retained local draft');assert.equal(f.unmounts,0);
    await act(async()=>input.focus());await f.flush();await f.scroll(2400);assert.equal(document.activeElement,input);assert.equal(rows[0]!.style.display,'');assert.equal(input.value,'retained local draft');
    await act(async()=>input.blur());await f.flush();assert.equal(rows[0]!.style.display,'none');assert.equal(f.mounts,100);
  }finally{await f.close();}assert.equal(f.unmounts,100);
});

test('frozen updates hold row windows; revision typography remeasures naturally and invalid geometry fails open',async()=>{
  const f=await fixture();try{
    await f.render();await f.scroll(500);const held=f.latest.topPixels;
    await f.render(0,false);await f.scroll(1700);assert.equal(f.latest.topPixels,held,'Frozen reader context holds window changes');
    await f.render(0,true);assert.ok(f.latest.topPixels>held,'Resume consumes current native scroll offset');
    f.setMultiplier(1.25);await f.render(1,true);assert.equal(f.latest.ready,true);assert.equal(f.host.querySelector<HTMLElement>('[data-viewport]')!.scrollHeight,10.5+f.total());
    f.setValid(false);await f.render(2,true);assert.equal(f.latest.ready,false);assert.ok([...f.host.querySelectorAll<HTMLElement>('[data-row]')].every(row=>row.style.display===''));assert.equal(f.latest.topPixels,0);assert.deepEqual(f.latest.columnWidths,[]);
    f.setValid(true);await f.render(3,true);assert.equal(f.latest.ready,true);await f.render(3,true,false);assert.equal(f.latest.ready,false);assert.equal(f.mounts,100);assert.equal(f.unmounts,0);
  }finally{await f.close();}
});

test('reveal focuses retained offscreen rows only after layout and defers while updates are frozen',async()=>{
  const f=await fixture();try{
    await f.render();const rows=[...f.host.querySelectorAll<HTMLElement>('[data-row]')];rows.forEach(row=>row.tabIndex=-1);
    assert.equal(rows[99]!.style.display,'none');
    await act(async()=>f.latest.reveal(99,true));assert.equal(rows[99]!.style.display,'');assert.equal(document.activeElement,rows[99]);assert.ok(f.host.querySelector<HTMLElement>('[data-viewport]')!.scrollTop>2400);
    await act(async()=>f.latest.reveal(0,true));assert.equal(document.activeElement,rows[0]);assert.equal(f.host.querySelector<HTMLElement>('[data-viewport]')!.scrollTop,0);
    await f.render(0,false);await act(async()=>f.latest.reveal(90,true));assert.equal(document.activeElement,rows[0]);assert.equal(f.host.querySelector<HTMLElement>('[data-viewport]')!.scrollTop,0);
    await f.render(0,true);assert.equal(document.activeElement,rows[90]);assert.equal(f.mounts,100);assert.equal(f.unmounts,0);
  }finally{await f.close();}
});

test('two-axis retained cells preserve fractional extents, logical gap slots, tall row heights, drafts and focus',async()=>{
  const f=await fixture(true,12);try{
    await f.render();const viewport=f.host.querySelector<HTMLElement>('[data-viewport]')!,table=f.host.querySelector('table')!,rows=[...f.host.querySelectorAll<HTMLElement>('[data-row]')],cells=[...f.host.querySelectorAll<HTMLElement>('[data-table-window-column]')],input=rows[0]!.querySelector<HTMLInputElement>('input')!;
    assert.equal(f.latest.columns.ready,true);assert.equal(table.style.tableLayout,'fixed');assert.equal(table.style.width,'1200px');assert.equal(viewport.scrollWidth,1200);assert.equal(viewport.scrollHeight,10.5+f.total());
    assert.equal(f.latest.columns.end,2);assert.equal(f.latest.columns.rightPixels,1000);assert.equal(rows[1]!.style.height,'30.5px','Hidden tall cells retain measured multiline row height');
    const slots=()=>[...table.querySelectorAll<HTMLElement>('thead th')].filter(cell=>cell.style.display!=='none').reduce((sum,cell)=>sum+Number(cell.getAttribute('colspan')??1),0);
    assert.equal(slots(),12);assert.equal(table.querySelector('thead [data-table-window-column-spacer]')!.getAttribute('aria-hidden'),'true');
    await act(async()=>{input.value='offscreen cell draft';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await f.scroll(1600,800);assert.equal(f.latest.columns.start,8);assert.equal(f.latest.columns.leftPixels,800);assert.equal(slots(),12);assert.equal(viewport.scrollWidth,1200);assert.equal(viewport.scrollHeight,10.5+f.total());assert.equal(input.value,'offscreen cell draft');
    await act(async()=>f.latest.reveal(90,true,11));const focused=rows[90]!.querySelector<HTMLElement>('[data-table-window-column="11"]')!;assert.equal(document.activeElement,focused);assert.equal(focused.style.display,'');assert.equal(viewport.scrollLeft,1000);
    await f.scroll(0,0);assert.equal(focused.style.display,'','Focused column and row remain retained in layout');await act(async()=>focused.blur());await f.flush();assert.equal(f.latest.columns.start,0);assert.equal(f.latest.columns.end,2);
    await f.render(0,false);await f.scroll(900,800);assert.equal(f.latest.columns.start,0);await f.render(0,true);assert.equal(f.latest.columns.start,8);
    f.setMultiplier(1.125);await f.render(1,true);assert.equal(viewport.scrollHeight,10.5+f.total());assert.equal(rows[1]!.style.height,`${f.height(1)}px`);assert.deepEqual([...f.host.querySelectorAll('[data-table-window-column]')],cells);assert.equal(f.mounts,100);assert.equal(f.unmounts,0);
    f.setValid(false);await f.render(2,true);assert.equal(f.latest.ready,false);assert.equal(table.style.tableLayout,'');assert.equal(rows[1]!.style.height,'');assert.equal(table.querySelector('[data-table-window-column-spacer]'),null);assert.ok(cells.every(cell=>cell.style.display===''));assert.equal(input.value,'offscreen cell draft');
  }finally{await f.close();}
});

test('column reveal focuses a real descendant or the retained row rather than a nonfocusable table cell',async()=>{
  const f=await fixture(true,12);try{
    await f.render();const rows=[...f.host.querySelectorAll<HTMLElement>('[data-row]')];rows[90]!.tabIndex=-1;
    const ordinary=rows[90]!.querySelector<HTMLElement>('[data-table-window-column="11"]')!;ordinary.removeAttribute('tabindex');
    await act(async()=>f.latest.reveal(90,true,11));assert.equal(document.activeElement,rows[90]);assert.equal(ordinary.hasAttribute('tabindex'),false,'Reveal never adds permanent tab stops');
    await act(async()=>f.latest.reveal(2,true,0));assert.equal(document.activeElement,rows[2]!.querySelector('input'),'A supplied cell target focuses its actual field');assert.equal(rows[2]!.querySelector<HTMLInputElement>('input')!.value,'draft-2');
  }finally{await f.close();}
});

test('local ancestor clipping and scrolling bound both axes without camera clipping, extent loss or stale scale after freeze',async()=>{
  const f=await fixture(true,12,true,null);try{
    await f.render();assert.equal(f.latest.ready,true);const viewport=f.host.querySelector<HTMLElement>('[data-viewport]')!,clip=f.host.querySelector<HTMLElement>('[data-clipper]')!,rows=[...f.host.querySelectorAll<HTMLElement>('[data-row]')],cells=[...f.host.querySelectorAll<HTMLElement>('[data-table-window-column]')],input=rows[0]!.querySelector<HTMLInputElement>('input')!;
    const observed=[...f.observers].flatMap(observer=>[...observer.targets]);assert.ok(observed.includes(clip));assert.equal(observed.some(element=>element.hasAttribute('data-global-camera')),false,'Never observe global camera clipping beyond card-surface');
    assert.ok(f.scrollListeners.has(clip));assert.ok(f.scrollListeners.has(viewport));assert.equal([...f.scrollListeners.keys()].some(element=>element.hasAttribute('data-global-camera')),false);
    assert.equal(rows.filter(row=>row.style.display!=='none').length,5,'90.5CSSpx ancestor clip plus default32 overscan replaces349px inner band');assert.equal(f.latest.columns.end,3,'180.25CSSpx clip plus32 overscan, not600px inner width');
    const width=viewport.scrollWidth,height=viewport.scrollHeight;
    await f.ancestorScroll(150,250);assert.equal(f.latest.topPixels,f.offset(4));assert.equal(f.latest.columns.start,2);assert.equal(f.latest.columns.leftPixels,200);assert.equal(viewport.scrollTop,0);assert.equal(viewport.scrollLeft,0);assert.equal(viewport.scrollWidth,width);assert.equal(viewport.scrollHeight,height);
    await f.ancestorScroll(0,0);await act(async()=>{input.value='ancestor-clipped draft';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();});await f.flush();await f.ancestorScroll(150,250);assert.equal(document.activeElement,input);assert.equal(rows[0]!.style.display,'');assert.equal(rows[0]!.querySelector<HTMLElement>('[data-table-window-column="0"]')!.style.display,'');
    await act(async()=>input.blur());await f.flush();await f.render(0,false);assert.equal(f.observers.size,0);const held=f.latest.topPixels;f.setWorldScale(.125);await f.ancestorScroll(75,400);assert.equal(f.latest.topPixels,held);assert.equal(f.frames.size,0);
    await f.render(0,true);assert.equal(f.latest.topPixels,f.offset(1),'Resume calibrates current fractional world scale before intersecting ancestor band');assert.equal(f.latest.columns.start,3);assert.equal(viewport.scrollWidth,width);assert.equal(viewport.scrollHeight,height);assert.deepEqual([...f.host.querySelectorAll('[data-row]')],rows);assert.deepEqual([...f.host.querySelectorAll('[data-table-window-column]')],cells);assert.equal(input.value,'ancestor-clipped draft');assert.equal(f.mounts,100);assert.equal(f.unmounts,0);
    await f.ancestorScroll(0,0);assert.equal(f.latest.topPixels,0);assert.equal(f.latest.columns.start,0);
  }finally{await f.close();}
});
