import type {Camera} from '../shared/viewport.js';

type Axis={element:HTMLElement;animation?:Animation;driver?:HTMLElement;span:number;base:number;axis:'x'|'y'|'scale';offset?:number};
const range=1048576;
/** Input-driven compositor timelines. No elapsed-time animation advances the pose. */
export class CanvasCamera {
 private axes:Axis[];private requested:Camera|null=null;
 constructor(x:HTMLElement,y:HTMLElement,scale:HTMLElement){this.axes=[{element:x,span:65536,base:0,axis:'x'},{element:y,span:65536,base:0,axis:'y'},{element:scale,span:2,base:0,axis:'scale'}];}
 uses(x:HTMLElement,y:HTMLElement,scale:HTMLElement){return this.axes[0].element===x&&this.axes[1].element===y&&this.axes[2].element===scale;}
 draw(camera:Camera){this.requested={...camera};for(const item of this.axes){const value=item.axis==='scale'?camera.zoom:camera[item.axis],scale=item.axis==='scale';
  if(typeof item.element.animate!=='function'){item.element.style.transform=scale?`scale(${value})`:`translate${item.axis.toUpperCase()}(${value}px)`;continue;}
  if(scale?(value>item.span*.875||value<item.span/65536):Math.abs(value-item.base)>item.span*.75){item.animation?.cancel();item.animation=undefined;if(scale)item.span=2**Math.ceil(Math.log2(value*2));else item.base=value;}
  if(!item.animation){item.element.style.transform=scale?`scale(${value})`:`translate${item.axis.toUpperCase()}(${value}px)`;const transform=(v:number)=>scale?`scale(${v})`:`translate${item.axis.toUpperCase()}(${v}px)`,frames=[{transform:transform(scale?0:item.base-item.span)},{transform:transform(scale?item.span:item.base+item.span)}];
   const Timeline=(globalThis as unknown as {ScrollTimeline?:new(options:{source:HTMLElement;axis:string})=>AnimationTimeline}).ScrollTimeline;
   if(Timeline&&typeof document!=='undefined'){
    if(!item.driver){const driver=document.createElement('div');driver.className='canvas-camera-source';driver.dataset.cameraAxis=item.axis;driver.setAttribute('aria-hidden','true');driver.tabIndex=-1;driver.style.cssText='position:fixed;left:0;bottom:0;width:4px;height:4px;overflow:scroll;scrollbar-width:none;pointer-events:none;touch-action:auto;direction:ltr;writing-mode:horizontal-tb;scroll-behavior:auto;scroll-snap-type:none;overflow-anchor:none;overscroll-behavior:none;will-change:scroll-position,transform;background:transparent;border:0;padding:0;contain:strict';const spacer=document.createElement('div');spacer.style.height=(range+4)+'px';spacer.style.width='1px';spacer.style.visibility='hidden';driver.append(spacer);document.body.append(driver);item.driver=driver;}
    item.animation=item.element.animate(frames,{timeline:new Timeline({source:item.driver,axis:'y'}),fill:'both',easing:'linear'});
   }else{item.animation=item.element.animate(frames,{duration:1000,fill:'both',easing:'linear'});item.animation.playbackRate=0;}
   item.animation.finished?.catch(()=>{});item.animation.ready?.catch(()=>{});item.animation.id='canvas-camera-'+item.axis;
  }
  const progress=scale?value/item.span:((value-item.base)/item.span+1)*.5;
  if(item.driver){const offset=progress*range;if(item.offset!==offset){item.driver.scrollTop=offset;item.offset=offset;}}
  else{const time=progress*1000;if(item.animation.currentTime!==time)item.animation.currentTime=time;}
 }}
 read():Camera|null{
  if(!this.requested||typeof getComputedStyle!=='function'||typeof DOMMatrixReadOnly==='undefined')return this.requested;
  try{const matrices=this.axes.map(axis=>new DOMMatrixReadOnly(getComputedStyle(axis.element).transform));const value={x:matrices[0].e,y:matrices[1].f,zoom:matrices[2].a};return Number.isFinite(value.x)&&Number.isFinite(value.y)&&Number.isFinite(value.zoom)&&value.zoom>0?value:this.requested;}catch{return this.requested;}
 }
 dispose(){for(const item of this.axes){if(this.requested){const value=item.axis==='scale'?this.requested.zoom:this.requested[item.axis];item.element.style.transform=item.axis==='scale'?`scale(${value})`:`translate${item.axis.toUpperCase()}(${value}px)`;}item.animation?.cancel();item.driver?.remove();item.animation=undefined;item.driver=undefined;item.offset=undefined;}}

}
