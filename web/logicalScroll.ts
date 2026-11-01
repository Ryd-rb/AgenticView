export type ScrollAxis='x'|'y';
export type LogicalViewport={y:number;height:number;clientHeight:number};
export type LogicalScrollModel={read:()=>LogicalViewport|null;seek:(y:number)=>boolean};
export type AxisState={value:number;max:number;size:number;total:number;mode:'native'|'logical';valid:boolean};
const models=new WeakMap<HTMLElement,LogicalScrollModel>();
export function registerLogicalScroll(element:HTMLElement,model:LogicalScrollModel){models.set(element,model);return()=>{if(models.get(element)===model)models.delete(element);};}
function valid(...values:number[]){return values.every(value=>Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER);}
export function readScrollAxis(element:HTMLElement,axis:ScrollAxis):AxisState{
 const model=axis==='y'?models.get(element):undefined;
 const unavailable:AxisState={value:0,max:0,size:0,total:0,mode:model?'logical':'native',valid:false};
 try{
  if(model){const state=model.read();if(!state||!valid(state.y,state.height,state.clientHeight))return unavailable;const max=Math.max(0,state.height-state.clientHeight);if(state.y>max+.001)return unavailable;return{value:Math.min(max,state.y),max,size:state.clientHeight,total:state.height,mode:'logical',valid:true};}
  const value=axis==='x'?element.scrollLeft:element.scrollTop,total=axis==='x'?element.scrollWidth:element.scrollHeight,size=axis==='x'?element.clientWidth:element.clientHeight;
  if(!valid(value,total,size))return unavailable;const max=Math.max(0,total-size);return{value:Math.min(max,value),max,size,total,mode:'native',valid:true};
 }catch{return unavailable;}
}
/** Returns actual consumed movement. Invalid/refused seeks do not consume delta. */
export function seekScrollAxis(element:HTMLElement,axis:ScrollAxis,value:number):number{
 if(!Number.isFinite(value))return 0;const before=readScrollAxis(element,axis);if(!before.valid)return 0;const next=Math.max(0,Math.min(before.max,value));
 try{const model=axis==='y'?models.get(element):undefined;if(model){if(!model.seek(next))return 0;}else if(axis==='x')element.scrollLeft=next;else element.scrollTop=next;}catch{return 0;}
 const after=readScrollAxis(element,axis);return after.valid?after.value-before.value:0;
}
export function scrollViewportBy(element:HTMLElement,dx:number,dy:number){
 const x=readScrollAxis(element,'x'),y=readScrollAxis(element,'y');
 return{x:Number.isFinite(dx)?dx-(x.valid?seekScrollAxis(element,'x',x.value+dx):0):dx,y:Number.isFinite(dy)?dy-(y.valid?seekScrollAxis(element,'y',y.value+dy):0):dy};
}
/** Pure range math: a fixed-height paint body, no source-height DOM spacer. */
export function fixedRowWindow(count:number,rowHeight:number,y:number,viewportHeight:number,overscan=3,bottomInset=0){
 if(!Number.isInteger(count)||count<0||!Number.isFinite(rowHeight)||rowHeight<=0||!Number.isFinite(y)||y<0||!Number.isFinite(viewportHeight)||viewportHeight<0)return null;
 const height=count*rowHeight;if(!Number.isSafeInteger(count)||!Number.isFinite(height)||height>Number.MAX_SAFE_INTEGER)return null;
 const inset=Number.isFinite(bottomInset)?Math.max(0,Math.min(64,bottomInset)):0;
 const offset=Math.max(0,Math.min(Math.max(0,height+inset-viewportHeight),y)),extra=Number.isFinite(overscan)?Math.max(0,Math.min(32,Math.floor(overscan))):3;
 const start=Math.max(0,Math.floor(offset/rowHeight)-extra),end=Math.min(count,Math.ceil((offset+viewportHeight)/rowHeight)+extra);
 return{start,end,top:start*rowHeight-offset,height,paintHeight:viewportHeight,y:offset};
}
